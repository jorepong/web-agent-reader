# AGENTS.md — AI 개발 컨텍스트

이 프로젝트에서 작업할 때 알아야 할 현재 구조와 규칙을 정리한 문서입니다.

---

## 프로젝트 구성

두 개의 도구가 하나의 npm 패키지에 들어 있습니다.

### 1. llm-page-reader

웹 페이지를 LLM이 읽기 좋은 마크다운과 별도 레지스트리로 변환하는 핵심 라이브러리입니다.

```
src/
  index.ts            — 공개 API (convertPage, convertHtml, resolveLink, openLink)
  dom-normalizer.ts   — HTML → 마크다운/AST 변환 핵심 로직
  link-registry.ts    — 링크 ID 발급, URL 정규화, 중복 제거
  element-registry.ts — 폼 요소 ID 발급 (버튼/입력창/셀렉트/텍스트에어리어)
  io.ts               — page.md/page.json/links.json/elements.json 저장·읽기
  types.ts            — 변환기 타입 정의
  cli.ts              — llm-page CLI 진입점
  cli-utils.ts        — CLI 파싱 헬퍼
```

### 2. llm-search

`llm-page-reader` 위에 구축된 에이전트 기반 웹 검색 도구입니다. v1과 v2가 공존하며, 프로젝트 루트의 `llm-search.config.json` 기본값은 `v2`입니다.

v1은 `orchestrator + explorer` 구조입니다.

```
src/search/
  types.ts          — v1 공유 타입 (SearchOptions, MissionBrief, ExplorationReport 등)
  logger.ts         — v1 디버그 로거 (시간순 들여쓰기 JSONL)
  openai-client.ts  — OpenAI SDK 래퍼 (로깅 + Structured Outputs)
  prompts.ts        — v1 프롬프트와 액션 스키마
  search-engines.ts — google/bing/naver SERP URL 빌더
  explorer.ts       — 탐색 에이전트 (runExplorationAgent)
  orchestrator.ts   — 오케스트레이터 (runSearch)
  json-utils.ts     — LLM 응답 JSON 파싱 방어 레이어
  cli.ts            — 통합 llm-search CLI 진입점
  cli-runner.ts     — v1/v2 선택, config/env 로딩, 실행 공통부
```

v2는 단일 재귀 `Researcher` 구조입니다.

```
src/search/v2/
  types.ts       — ResearchOptions / BudgetLimits / ResearcherBrief / CurrentSurface
  budget.ts      — SharedBudget (트리 전체 라운드·검색·위임·URL 중복 관리)
  sections.ts    — 긴 페이지를 heading 기반 섹션으로 나누고 필요한 섹션만 읽는 유틸
  prompts.ts     — v2 액션 스키마와 프롬프트
  researcher.ts  — runResearcher 재귀 본체 + research() 래퍼
  logger.ts      — V2Logger (researcher-*.jsonl + v2 stderr)
  cli.ts         — llm-search-v2 호환 진입점
```

---

## 기술 스택

- TypeScript strict 모드, ES2022, NodeNext 모듈 시스템(ESM)
- Playwright — Chromium 렌더링, 스크롤 안정화, stealth 모드
- linkedom — 경량 DOM 파싱
- OpenAI SDK — 기본 모델 `gpt-5.4-mini`
- Vitest — 테스트 프레임워크

빌드: `npm run build`, 테스트: `npm test`

NodeNext 규칙 때문에 로컬 TS import 경로에는 `.js` 확장자가 필요합니다.

---

## 변환기 동작 방식

`convertPage(url)` 흐름:

1. Playwright로 페이지를 열고 `domcontentloaded`와 짧은 `networkidle` 대기를 수행합니다.
2. 기본값으로 자동 스크롤을 수행해 동적 콘텐츠를 안정화합니다.
3. `page.content()` HTML을 `linkedom`으로 파싱합니다.
4. `cleanupDocument`가 script/style/광고/숨김 요소 등을 제거합니다.
5. `buildRegions`가 navigation/main/aside/footer/footnotes 영역을 만들고, 링크와 폼 요소를 레지스트리에 등록합니다.
6. `page.md`, `PageAst`, `LinkRegistry`, `ElementRegistry`를 반환합니다.

마크다운에서 링크는 `텍스트 [L1]` 형식이고, 폼 요소는 `[button#B1: 텍스트]` 형식입니다. `renderPage`는 헤더에 `Page ID`, `Host`, `Links`, `Elements`를 출력합니다.

누락 디버깅 순서:

1. 렌더링된 `document.body.innerText`에 해당 텍스트가 있는지 확인합니다.
2. `cleanupDocument`가 해당 영역을 제거했는지 확인합니다.
3. `buildRegions`가 영역을 navigation/main/aside/footer/footnotes 어디에도 넣지 못했는지 확인합니다.

---

## 검색 도구 기본값

`llm-search`는 설정 파일과 CLI 플래그로 v1/v2를 선택합니다.

- `llm-search.config.json`의 현재 기본 버전: `v2`
- `--v1`, `--v2`, `--version v1|v2`가 설정 파일보다 우선합니다.
- `llm-search-v1`, `llm-search-v2` 바이너리 이름도 강제 버전으로 동작합니다.
- 설정 파일이 없을 때 코드 기본값은 v2 `20/8/10/3/3/3`이지만, 이 저장소의 설정 파일은 v2 `30/20/20/3/5/3`을 사용합니다.

---

## v1 동작 방식

`runSearch(options)`는 오케스트레이터 행동 루프입니다.

1. `buildOrchestratorInitialPrompt(query, limits)`로 messages를 초기화합니다.
2. 매 라운드 LLM이 Structured Outputs로 행동 1개를 고릅니다.
3. 시스템이 행동을 실행하고 결과를 messages 끝에 append합니다.
4. `done`이 나오거나 라운드 한도에 닿으면 수집 보고를 합성합니다.

v1 오케스트레이터 액션:

- `search(engine, query)` — google/naver/bing SERP를 가져옵니다.
- `paginate(page)` — 현재 SERP의 같은 engine/query에서 다른 페이지를 가져옵니다.
- `explore(linkId, task)` — 현재 SERP의 링크 하나를 `runExplorationAgent`에 위임합니다.
- `explore_parallel(branches[])` — 독립 링크들을 병렬 위임합니다.
- `done(reason)` — 탐색을 끝내고 합성으로 넘어갑니다.

v1 explorer는 시작 URL 하나를 깊게 읽고, 페이지 안의 `[L*]` 링크를 따라 자식 explorer를 직렬 호출할 수 있습니다. explorer 트리 안에서는 `visitedUrls`가 공유되지만, 서로 다른 오케스트레이터 explore 트리 사이에는 공유되지 않습니다.

탐색 보고가 없거나 모든 보고가 `found=false`이면 마지막 SERP 스니펫으로 합성합니다. 이 경우 실제 페이지를 방문하지 않았으므로 합성 프롬프트가 URL 인용을 금지합니다.

---

## v2 동작 방식

`research(goal, options, client, logger)`는 자연어 목표를 받아 자연어 답변을 반환합니다. CLI에서는 `cli-runner.ts`가 `OpenAIClient`, `V2Logger`, `SharedBudget`을 구성해 주입합니다.

v2의 핵심은 하나의 `runResearcher`가 자기 자신을 재귀 호출한다는 점입니다. 루트, URL 없는 서브 리서처, 시작 페이지가 있는 리서처는 다른 에이전트가 아니라 서로 다른 실행 상태입니다.

v2 액션:

- `search` — URL 없는 서브 리서처가 SERP를 가져옵니다. 루트는 직접 search하지 않고 먼저 위임합니다.
- `paginate` — 현재 표면이 SERP일 때 같은 query의 다른 페이지를 가져옵니다.
- `read_sections` — 긴 시작 페이지에서 아직 읽지 않은 섹션을 추가로 읽습니다.
- `delegate` — 자연어 task와 선택적 `targetId`/`startUrl`로 하위 리서처를 호출합니다.
- `delegate_parallel` — 독립 하위 리서처를 병렬 호출합니다.
- `done` — `ANSWER / SOURCES / COVERAGE / GAPS / NEXT_CANDIDATES` 템플릿의 자연어 답변을 반환합니다.

v2는 `CandidateRegistry`로 원래 `[L*]` 링크를 전역 후보 ID `[C*]`로 다시 매핑합니다. LLM에는 현재 표면에 보이는 후보 ID만 스키마 enum으로 허용되며, `linkId`는 이전 호환용 폐기 예정 필드입니다.

긴 페이지는 `sections.ts`에서 heading 기반 섹션 목록으로 나뉩니다. 40,000자를 넘는 페이지는 먼저 섹션 선택 LLM 호출을 거쳐 일부 섹션만 읽고, 이후 필요하면 `read_sections`로 추가 섹션을 읽습니다.

`SharedBudget`은 한 research 트리 전체에서 라운드, search/paginate, delegate/delegate_parallel, 방문 URL 중복을 관리합니다. 설정 파일 기준 현재 v2 한도는 `maxRounds=30`, `maxSearches=20`, `maxExplores=20`, `maxParallel=3`, `maxDepth=5`, `maxChildCallsPerAgent=3`입니다.

---

## 디버그 로그

v1 `--debug`는 `search-<timestamp>.jsonl`을 만듭니다. v2 `--debug`는 `researcher-<timestamp>.jsonl`을 만듭니다.

두 로그 모두 각 줄이 유효한 JSON 객체이며, 에이전트 depth만큼 좌측 공백을 넣어 시간순으로 저장합니다. `logger.finalize()`는 성공/실패 경로 모두에서 호출되어야 하며, CLI 러너가 이를 처리합니다.

주요 이벤트:

- `llm_request` / `llm_response`
- `page_markdown`
- `page_sections` / `page_section_selection` (v2)
- `mission_brief`
- `exploration_report`
- `orchestrator_plan`
- `recursion_decision` (v1 explorer)
- `final_answer` (v1)

현재 로거는 `llm_request`의 messages를 얕게 복사합니다. 메시지 객체 자체는 복사되지만 거대한 payload를 깊은 스냅샷으로 보관하는 구조는 아닙니다.

---

## 코딩 컨벤션

- 기존 패턴과 모듈 경계를 우선합니다.
- 프롬프트 변경은 v1은 `src/search/prompts.ts`, v2는 `src/search/v2/prompts.ts`에서만 합니다.
- LLM 액션 응답은 `OpenAIClient.complete(..., { responseSchema })`로 OpenAI Structured Outputs를 사용합니다.
- `parseJsonResponse`는 mock, 예외 경로, 방어 레이어로 유지합니다.
- logger, client, budget 같은 상태는 명시적으로 주입합니다. 새 싱글톤/전역 상태를 만들지 않습니다.
- 탐색/리서처 실패는 가능한 한 크래시 대신 구조화된 폴백 보고나 답변으로 바꿉니다.

---

## 로드맵

현재 로드맵과 개선 후보는 `TODO.md` 하나에서 관리합니다.
