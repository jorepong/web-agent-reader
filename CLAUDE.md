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

### 2. llm-search (검색 도구)

llm-page-reader 위에 구축된 계층적 에이전트 기반 웹 검색 도구.

```
src/search/
  types.ts          — 공유 타입 (SearchOptions, MissionBrief, ExplorationReport 등)
  logger.ts         — 디버그 로거 (시간순 들여쓰기 JSONL, finalize()로 일괄 저장)
  openai-client.ts  — OpenAI SDK 래퍼 (자동 로깅 + JSON 응답 강제 옵션)
  prompts.ts        — 모든 LLM 프롬프트 템플릿 + 하드 리밋 상수
  search-engines.ts — google/bing/naver SERP URL 빌더 (페이지네이션 포함)
  explorer.ts       — 탐색 에이전트 (runExplorationAgent)
  orchestrator.ts   — 오케스트레이터 (runSearch) — 에이전틱 행동 루프
  json-utils.ts     — LLM 응답에서 JSON을 관대하게 파싱 (parseJsonResponse)
  cli.ts            — llm-search CLI 진입점
```

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

## 검색 도구 동작 방식

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
- LLM 응답 JSON 파싱은 `parseJsonResponse`(`json-utils.ts`) 사용 — 코드펜스/주변 prose를 허용. JSON을 기대하는 호출은 `client.complete(..., { jsonResponse: true })`로 `response_format: json_object`를 강제.
- 싱글톤/전역 상태 금지 — logger, client 인스턴스는 명시적으로 주입
- 프롬프트 변경은 모두 `prompts.ts`에서만

---

## 로드맵 요약

상세 내용은 `TODO.md` 참고.

| Phase | 상태 | 내용 |
|-------|------|------|
| 1 | 완료 | 단일 깊이 직렬 탐색 CLI |
| 2 | 완료 | 탐색 에이전트 아젠틱 루프 |
| 3 | 완료 | 오케스트레이터 레벨 병렬 에이전트 호출 (`explore_parallel`) |
| 4 | 완료 | 오케스트레이터 자율 행동 루프 — 종료 판단도 LLM 자율 (원안의 "지능적 종료 강화" 흡수) |
| 5 | 미구현 | CLI 옵션 고도화 |
