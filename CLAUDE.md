# CLAUDE.md — AI 개발 컨텍스트

이 프로젝트에서 작업할 때 알아야 할 내용을 정리한 문서입니다.

---

## 프로젝트 구성

두 개의 독립적인 도구가 하나의 패키지에 있습니다.

### 1. llm-page-reader (변환기)

웹 페이지를 LLM이 읽기 좋은 마크다운 + 레지스트리로 변환하는 핵심 라이브러리.

```
src/
  index.ts            — 공개 API (convertPage, convertHtml, resolveLink, openLink)
  dom-normalizer.ts   — HTML → 마크다운/AST 변환 핵심 로직
  link-registry.ts    — 링크 ID 발급, URL 정규화, 중복 제거
  element-registry.ts — 폼 요소 ID 발급 (버튼/입력창/셀렉트/텍스트에어리어)
  io.ts               — 파일 저장/읽기 (writeResult, readLinkRegistry 등)
  types.ts            — 모든 타입 정의 (PageAst, ConvertResult, LinkRegistry 등)
  cli.ts              — llm-page CLI 진입점
  cli-utils.ts        — CLI 파싱 헬퍼 (option, intOption, required) — 양쪽 CLI 공유
```

### 2. llm-search (검색 도구) — v1 / v2 병행

llm-page-reader 위에 구축된 에이전트 기반 웹 검색 도구. 현재 두 가지 구조가 공존한다.

**v1 — 오케스트레이터 + 탐색 에이전트 (검증된 구조)**

```
src/search/
  types.ts          — 공유 타입 (SearchOptions, MissionBrief, ExplorationReport 등)
  logger.ts         — 디버그 로거 (시간순 들여쓰기 JSONL, finalize()로 일괄 저장)
  openai-client.ts  — OpenAI SDK 래퍼 (자동 로깅 + structured outputs 지원)
  prompts.ts        — 모든 LLM 프롬프트 템플릿 + 하드 리밋 상수
  search-engines.ts — google/bing/naver SERP URL 빌더 (페이지네이션 포함)
  explorer.ts       — 탐색 에이전트 (runExplorationAgent)
  orchestrator.ts   — 오케스트레이터 (runSearch) — 에이전틱 행동 루프
  json-utils.ts     — LLM 응답에서 JSON을 관대하게 파싱 (parseJsonResponse)
  cli.ts            — llm-search CLI 진입점
```

**v2 — 단일 재귀 Researcher (자기유사 구조, 활발한 개발 중)**

자연어 입출력 + 트리 전체 공유 budget + 단일 에이전트 재귀. 외부 도구로서의 인터페이스와 내부 재귀 인터페이스를 동일하게 통일.

```
src/search/v2/
  types.ts       — ResearchOptions / BudgetLimits / ResearcherBrief / LLMMessage / CurrentSerp
  budget.ts      — SharedBudget (트리 전체 비용·중복 관리, reserveSearch/reserveExplore 등)
  prompts.ts     — 5종 액션 스키마(decision 래핑) + 시스템 프롬프트 + 결과 메시지 빌더
  researcher.ts  — runResearcher 재귀 본체 + research() 외부 래퍼
  logger.ts      — V2Logger (v2 페이로드에 맞춘 stderr + JSONL)
  cli.ts         — llm-search-v2 CLI 진입점
```

v2의 설계·평가·아키텍처 원칙은 `RESEARCHER_V2.md` 참고. v1은 유지·운영, v2는 발전.

---

## 기술 스택

- **TypeScript** strict 모드, ES2022, NodeNext 모듈 시스템 (ESM)
- **Playwright** — Chromium 렌더링, 스크롤 안정화, stealth 모드
- **linkedom** — 경량 DOM 파싱 (JSDOM 대체)
- **OpenAI SDK** — gpt-5.4-mini 사용 (검색 도구)
- **Vitest** — 테스트 프레임워크

빌드: `npm run build` (tsc), 테스트: `npm test`

import 경로에 `.js` 확장자 필수 (NodeNext 규칙).

---

## 핵심 타입

```typescript
// 변환 결과
ConvertResult = { page: PageAst, markdown: string, links: LinkRegistry, elements: ElementRegistry }

// 에이전트 간 통신
MissionBrief    — 상위 → 하위 에이전트 지시 (agentId, parentAgentId, goal, url, parentGoal, depth)
ExplorationReport — 하위 → 상위 에이전트 보고
  (url, found, completeness, summary, relevantExcerpts, missingInfo, tokenUsage)
  completeness: "complete" | "partial" | "none" — 부분 정보임을 명시적으로 표현
  missingInfo:  string[] — 답을 위해 더 필요했던 정보의 항목들
```

---

## 변환기 동작 방식

`convertPage(url)` 흐름:
1. Playwright로 페이지 렌더링 + 스크롤 안정화
2. `page.content()` HTML을 linkedom으로 파싱
3. `dom-normalizer.ts`가 navigation/main/aside/footer 영역 탐지
4. 불필요한 요소 제거 (script, style, 광고, 숨김 요소 등)
5. Markdown 문자열 + PageAst + LinkRegistry + ElementRegistry 반환

마크다운에서 링크는 `[텍스트] [L1]` 형식, 요소는 `[button#B1: 텍스트]` 형식.

**누락 디버깅 체크리스트**:
1. 렌더링된 `document.body.innerText`에 해당 텍스트가 있는가
2. `cleanupDocument`가 해당 영역을 제거했는가
3. `buildRegions`가 영역을 navigation/main/aside/footer 어디에도 넣지 못했는가

---

## 검색 도구 동작 방식 (v1)

`runSearch(options)` 흐름 — **오케스트레이터 자체가 에이전틱 루프**다 (Phase 4):

1. `buildOrchestratorInitialPrompt(query)`로 messages 초기화 (system + 첫 user 메시지)
2. 루프 (최대 `ORCHESTRATOR_MAX_ROUNDS=12`):
   - [LLM] JSON 한 줄로 행동(action) 결정 — 5종:
     - `search(engine, query)` — 새 SERP 획득. 엔진: `google` / `naver` / `bing`
     - `paginate(page)` — 현재 SERP의 다른 페이지로 이동 (engine/query는 유지)
     - `explore(linkId, task)` — 단일 탐색 에이전트 디스패치
     - `explore_parallel(branches[])` — 최대 `MAX_PARALLEL=3` 병렬 디스패치
     - `done(reason)` — 종료
   - 행동 실행 결과(SERP 스니펫 / 탐색 보고 / 에러 안내)를 messages 끝에 append-only
   - 무효한 입력은 에러 메시지 주입 후 다음 라운드에서 LLM이 재선택 (크래시 없음)
3. 종료 후 수집된 보고로 최종 답변 합성. 보고 없으면 마지막 SERP 폴백, SERP도 없으면 "no data".

**하드 리밋** (`prompts.ts`):
- `ORCHESTRATOR_MAX_ROUNDS=12` — 전체 LLM 판단 횟수
- `ORCHESTRATOR_MAX_SEARCHES=5` — search + paginate 합계
- `ORCHESTRATOR_MAX_EXPLORES=5` — explorer 누적 디스패치 (병렬 1배치도 각각 카운트)
- `MAX_PARALLEL=3` — 한 explore_parallel 배치 내 동시 디스패치 수

**검색 엔진** (`search-engines.ts`):
- `buildSerpUrl(engine, query, page)` — google/bing/naver의 페이지네이션 파라미터 차이를 흡수
- 같은 `(engine, query, page)` 삼중쌍 재검색은 자동 차단

**탐색 에이전트 아젠틱 루프** (`runExplorationAgent` 내부):
- 페이지 변환 후 초기 messages 구성. 페이지는 "출발점"으로 프레이밍되어, 자식 탐색이 일상적 선택지임을 명시.
- 루프 (최대 MAX_CHILD_CALLS_PER_AGENT=3회):
  - [LLM] 판단: `explore(linkId)` or `done(summary)`
  - explore → 자식 에이전트 실행, 보고 수신, messages에 append (재구성 금지)
  - done → ExplorationReport 반환 (자식 결과를 선별 통합한 summary 포함)
- depth >= MAX_DEPTH(2) 시 explore 판단 무시, "탐색 불가" 메시지 주입 후 done 유도

**done 결정 게이트** (이번 라운드에서 done을 고르려면 BOTH 만족):
1. 현재 페이지의 잔여 링크 중 "더 권위/검증 가치가 있을 만한" 것이 없을 때
2. 목표가 명시적으로 요구하는 검증 가능한 정보를 모두 모았을 때

프롬프트는 done의 비가역성도 경고한다 — done 반환 시 해당 페이지와 그로부터 도달 가능한 모든 페이지가 잠긴다(재방문 불가). list/history 형태 질문에서는 `completeness="complete"`를 보수적으로 사용하도록 명시.

**SERP 기반 합성 특이 동작**: 탐색이 없거나 모든 탐색이 `found=false`이면 **마지막** SERP 스니펫으로 합성.
이 경우 `useSerpSynthesis=true`로 합성 프롬프트에 전달 → URL 인용 금지 (실제 방문 안 함).
search조차 한 번도 안 했으면 "no data" 보고로 합성 → 모르겠다는 응답이 생성됨.

`extractSerpSnippets()`:
- 오케스트레이터 판단 루프용: `keepLinkIds=true` — LLM이 linkId로 탐색 대상 선택
- 합성용: `keepLinkIds=false` — 방문하지 않은 URL 인용 방지

**주의**: `[LN]` 링크 ID는 탐색 에이전트 페이지 마크다운에서 제거하면 안 됨.
에이전트가 `explore` 결정 시 `suggestedLinkId`를 링크 레지스트리에서 조회하기 때문.

---

## 검색 도구 동작 방식 (v2 — Researcher)

`research(goal, options)` — **자기유사 재귀 단일 에이전트**.

외부 인터페이스는 자연어 한 줄 입력 + 자연어 답변 출력. 내부에서는 같은 함수가 자기 자신을 재귀 호출. 외부 도구로 노출되었을 때(MCP 등) 내부 재귀와 동일한 인터페이스로 동작하도록 의도된 설계.

```
research(goal: string, options?) → ANSWER/SOURCES/COVERAGE/GAPS 템플릿 자연어
```

**루프 (runResearcher)**:
1. 시작 페이지 유무로 분기 (root: 없음 / 자식: 있음)
2. 라운드별 동적 스키마 선택 (search/paginate/explore/explore_parallel/done 중 budget 상태에 따라 부분 집합)
3. 행동 실행 → 결과 messages append → 다음 라운드
4. done → 자연어 답변 반환 (부모/외부 호출자에게 동일)

**하드 리밋** (`SharedBudget`, 트리 전체 공유):
- `maxRounds=20` — 트리 전체 LLM 라운드
- `maxSearches=8` — 트리 전체 search + paginate 합계
- `maxExplores=10` — 트리 전체 explorer 디스패치
- `maxParallel=3` — 한 explore_parallel 배치 동시 디스패치
- `maxDepth=3` — 재귀 최대 깊이
- `maxChildCallsPerAgent=3` — 한 리서처가 호출 가능한 자식 수

**아키텍처 원칙** (`RESEARCHER_V2.md` §13 참고):
- 한 리서처는 *깊은 읽기*(콘텐츠 페이지)를 한 번만 한다. 추가 페이지는 모두 위임.
- *얕은 읽기*(SERP, 링크 인덱스)는 비교적 자유. SERP가 도구의 입력 어댑터 역할.
- 루트는 "페이지를 안 읽는 특별한 에이전트"가 아니라 "시작 페이지가 없는 초기 상태의 리서처". 같은 함수, 다른 입력.
- 자식 책임 경계: 자기 시작 페이지가 답을 못 주면 done with COVERAGE: none, 부모가 결정. 자기가 끝까지 추적하지 않음.
- 무한 위임은 `MAX_DEPTH`가 구조적으로 차단 — 잎 노드는 schema에서 explore 제거.

**한도 도달 시 동작**: `synthesizeFinalAnswer` — `buildDoneOnlySchema`로 LLM 한 번 더 호출해 누적 messages로 답변 합성. 빈손 폴백 회피.

**상태**: 2회 수동 실행 + 1차 수정 사이클 완료. 잔존 이슈는 RESEARCHER_V2.md §12-14의 dead-page 가드 / search saturation 가드 / 자식 책임 경계 강화로 다룰 예정.

---

## 디버그 로그 구조

`--debug` 활성화 시 `search-<timestamp>.jsonl` 파일을 생성. 각 줄이 유효한 JSON 한 개이며, 에이전트 깊이만큼 좌측 공백(depth × 2)으로 들여써서 계층을 시각화한다.

```
{"timestamp":"...","agentId":"orchestrator","depth":0,"kind":"llm_request","payload":{...}}
{"timestamp":"...","agentId":"orchestrator","depth":0,"kind":"orchestrator_plan","payload":{"round":1,"action":"explore","url":"..."}}
  {"timestamp":"...","agentId":"explorer-1","depth":1,"kind":"mission_brief","payload":{...}}
  {"timestamp":"...","agentId":"explorer-1","depth":1,"kind":"page_markdown","payload":{...}}
    {"timestamp":"...","agentId":"explorer-1-l3","depth":2,"kind":"mission_brief","payload":{...}}
  {"timestamp":"...","agentId":"explorer-1","depth":1,"kind":"exploration_report","payload":{...}}
{"timestamp":"...","agentId":"orchestrator","depth":0,"kind":"final_answer","payload":{...}}
```

ISO 8601 타임스탬프 문자열 정렬 = 시간순 정렬을 활용해 finalize 시점에 한 번만 정렬·저장한다.

기록 이벤트 종류:
- `llm_request` / `llm_response` — LLM 호출 입출력 + 토큰 사용량
- `page_markdown` — convertPage로 변환된 페이지 전문
- `mission_brief` — 상위 → 하위 에이전트 지시
- `exploration_report` — 하위 → 상위 에이전트 보고
- `orchestrator_plan` — 오케스트레이터의 매 라운드 판단 (explore/done)
- `recursion_decision` — 탐색 에이전트 루프의 매 라운드 판단 (explore/done/skipped)
- `final_answer` — 최종 답변

`logger.finalize()`는 프로세스 종료 전(성공/실패 모두) 반드시 호출해야 함. `cli.ts`의 try/catch 양쪽에서 호출.

---

## 코딩 컨벤션

- 새 파일은 기존 패턴 그대로 따름
- 에러 처리: 탐색 에이전트는 크래시 없이 폴백 리포트 반환 (found: false, completeness: "none")
- LLM 액션 응답은 OpenAI Structured Outputs로 강제. `prompts.ts`의 `orchestratorActionSchema` / `explorerActionSchemaCanExplore` / `explorerActionSchemaTerminal`을 `client.complete(..., { responseSchema })`로 전달. 응답은 스키마에 부합하는 단일 JSON 객체로 보장됨.
- 응답 텍스트 파싱은 여전히 `parseJsonResponse`(`json-utils.ts`)로 방어적으로 처리 — 스키마가 보장해도 mock 응답이나 예외 경로 대응. `jsonResponse: true` 옵션은 스키마 없이 자유 JSON을 받을 때만 사용.
- 싱글톤/전역 상태 금지 — logger, client 인스턴스는 명시적으로 주입
- 프롬프트 변경은 모두 `prompts.ts`에서만

---

## 로드맵 요약

상세 내용은 `TODO.md` 참고. v2 진척은 `RESEARCHER_V2.md` 참고.

### v1 로드맵

| Phase | 상태 | 내용 |
|-------|------|------|
| 1 | 완료 | 단일 깊이 직렬 탐색 CLI |
| 2 | 완료 | 탐색 에이전트 아젠틱 루프 |
| 3 | 완료 | 오케스트레이터 레벨 병렬 에이전트 호출 (`explore_parallel`) |
| 4 | 완료 | 오케스트레이터 자율 행동 루프 — 종료 판단도 LLM 자율 (원안의 "지능적 종료 강화" 흡수) |
| 5 | 미구현 | CLI 옵션 고도화 |

### v2 (Researcher) 진행

| 단계 | 상태 | 내용 |
|-------|------|------|
| 설계 문서화 | 완료 | `RESEARCHER_V2.md` 작성 |
| 핵심 구조 구현 | 완료 | types/budget/prompts/researcher/cli + V2Logger |
| 1차 실행 평가 | 완료 | 5개 문제 발견 (로그 깨짐 / 폴백 누수 / 자식 페이지 무시 등) → 모두 수정 |
| 2차 실행 평가 | 완료 | 잔존 이슈 4건 식별 (로그 미리보기 / dead-page / 책임 경계 / search 우회) |
| 2차 수정 사이클 | 대기 | dead-page 가드 / search saturation 가드 / 자식 책임 경계 강화 / 로그 미리보기 수정 |
| 자동 테스트 | 대기 | `test/researcher.test.ts` |
| v1 deprecation 결정 | 대기 | v2 안정화 후 |
