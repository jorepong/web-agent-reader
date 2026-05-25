# Researcher v2 — 통합 재귀 에이전트 설계와 현재 구현

이 문서는 v2 작업의 **의도, 구현 결과, 남은 검토 지점**을 정리한 설계 기록이다. 초안에서 출발했지만, 현재는 `src/search/v2/` 구현에 맞춰 갱신한다.

---

## 1. 작업 의도

현재 v1은 **두 종류의 에이전트(오케스트레이터 + 탐색 에이전트)** 로 구성되어 있다. 동작은 검증되었지만, 다음 한계가 있다:

- **비대칭 능력**: 오케스트레이터만 search/paginate가 가능하다. 깊은 탐색 에이전트가 "다른 키워드로 검색하면 좋겠다"고 판단해도 시스템에 그 신호를 보낼 방법이 없어, missingInfo로 traceback하는 우회로만 존재.
- **출력 형태 불일치**: 오케스트레이터는 자연어 답변을, 탐색 에이전트는 구조화된 `ExplorationReport`를 반환한다. 외부 도구 사용 관점에서 인터페이스가 통일되지 않음.
- **합성이 별도 단계**: 오케스트레이터의 루프가 끝난 후 별도 LLM 호출로 합성한다. 재귀 구조와는 어울리지 않는 별도 단계.
- **외부 도구화 부적합**: 외부 LLM(Claude/GPT)이 MCP나 function call로 이 도구를 호출하기에는, 내부 인터페이스가 자연어가 아닌 부분이 많다.

**v2의 의도**: 자연어 입력/출력의 자기유사 재귀 구조로 통합한다. 외부 도구로서의 인터페이스와 내부 에이전트 간 재귀 인터페이스를 *같게* 만든다.

---

## 2. 기대 결과

### CLI / 도구 사용자 관점

```typescript
research(goal: string): Promise<string>
```

- 입력: 자연어 한 줄 (질문 / 검증 요청 / 정보 수집 요청 등)
- 출력: 템플릿 형식의 자연어 (`ANSWER`, `SOURCES`, `COVERAGE`, `GAPS`, `NEXT_CANDIDATES` 섹션 포함)
- CLI 사용자는 `llm-search --query "..."` 또는 `llm-search-v2 --query "..."`만 호출하면 됨. 내부에 여러 실행 상태가 있는지 알 필요 없음.
- 코드 레벨의 `research()`는 현재 `OpenAIClient`와 `V2Logger`를 명시적으로 주입받는다.

### 내부 동작

- 단일 `Researcher` 함수가 자기 자신을 재귀적으로 호출
- 상태별 스키마가 허용하는 액션 집합 사용: search / paginate / read_sections / delegate / delegate_parallel / done
- 루트 호출 / 재귀 호출 / 외부 도구 호출이 모두 같은 인터페이스
- 트리 전체가 공유하는 `SharedBudget`이 비용과 중복 방문을 관리

### 행동·동작 변화 가능성

자기유사 재귀로 인해 다음과 같은 행동이 자연스럽게 가능해진다:

- 깊은 레벨의 리서처가 "이 페이지로는 답이 안 됨" 판단 후 *자기 자리에서* 새로 search
- 탐색 트리 어디에서나 delegate_parallel 가능 (이전 v1에서는 오케스트레이터 레벨의 explore_parallel만 가능)
- 부모 리서처가 자식 응답을 자연어로 읽고 후속 행동 결정 → 구조화된 필드 의존도 감소
- 일반 경로에서는 루트 리서처의 `done.answer`가 곧 최종 답변이며, 라운드 한도에 닿으면 done-only 스키마로 강제 합성을 한 번 더 시도

---

## 3. v1과의 비교

| 항목 | v1 | v2 (Researcher) |
|---|---|---|
| 에이전트 종류 | 오케스트레이터 + 탐색 에이전트 | 단일 (Researcher) |
| 출력 (재귀) | `ExplorationReport` 구조화 객체 | 자연어 문자열 (템플릿 포함) |
| 출력 (외부) | 자연어 답변 (합성 단계 별도) | 자연어 문자열 (`done.answer` 또는 강제 합성 결과) |
| 합성 단계 | 루프 끝난 후 별도 LLM 호출 | 일반 경로는 루트 `done.answer`, 한도 도달 시 `synthesizeFinalAnswer` |
| search/paginate 권한 | 오케스트레이터만 | URL 없는 서브 리서처와 일부 비루트 상태. 루트와 시작 페이지 첫 라운드는 제외 |
| explore 권한 | 두 에이전트 모두 | 동일 |
| MAX_DEPTH | 2 (탐색 에이전트 기준) | 통합 깊이. 코드 기본값은 3, 저장소 config 기준 실행값은 5 |
| URL 중복 방지 | 트리 내만 (트리 간 미공유) | 트리 전체 공유 (`SharedBudget`) |
| 비용 한도 | 오케스트레이터/에이전트 각각 | `SharedBudget` 일원화 |
| 거부 경로 로깅 | `orchestrator_plan(action:rejected)` | 동일 패턴 유지 |
| 입력 (외부) | `SearchOptions` (`query`, `model`, ...) | `ResearchOptions` (`goal`, ...) |

v1은 그대로 보존한다. v2는 별도 디렉토리로 만든다.

---

## 4. 재사용 vs 신규 작성

### 재사용 (v1에서 그대로 import)

- `src/index.ts`의 `convertPage`
- `src/search/search-engines.ts` — `buildSerpUrl`, 엔진 enum
- `src/search/logger.ts` — `DebugLogger`
- `src/search/openai-client.ts` — `OpenAIClient`
- `src/search/json-utils.ts` — `parseJsonResponse`

이들은 정책이 아니라 인프라이므로 v2에서도 그대로 쓴다.

### 신규 작성 (v2 전용)

- `src/search/v2/types.ts` — `ResearchOptions`, `ResearcherBrief`, `SharedBudget`
- `src/search/v2/prompts.ts` — Researcher용 프롬프트와 스키마 (v1 프롬프트 자료를 *복사하여 적응*; v1 파일은 import하지 않음 — v2가 독립적으로 진화 가능하도록)
- `src/search/v2/researcher.ts` — `research()` 함수 본체 (재귀 호출)
- `src/search/v2/cli.ts` — CLI 진입점

### 프롬프트 재사용 원칙

v1의 검증된 가드는 그대로 가져온다:
- 그라운딩 룰 (사전 지식 인용 금지, verbatim excerpts)
- list/history 검증 게이트
- partial 후속 게이트 (D)
- done.reason 그라운딩 룰
- 병렬/직렬 판단 가이드 (도메인 무관 패턴)

다만 다음은 새로 작성:
- "당신은 리서처입니다 + 자기 자신을 재귀 호출할 수 있다"는 자기유사 설명
- 루트 vs 비루트 안내 (또는 두 경우의 시스템 프롬프트 통합)
- 자연어 보고 템플릿 (`ANSWER` / `SOURCES` / `COVERAGE` / `GAPS` / `NEXT_CANDIDATES`)

---

## 5. 코드 인터페이스 명세

```typescript
async function research(
  goal: string,
  options: ResearchOptions,
  client: OpenAIClient,
  logger: V2Logger,
): Promise<string>;

interface ResearchOptions {
  model?: string;              // 기본: 환경 변수 / "gpt-5.4-mini"
  debug?: boolean;             // 기본: false
  logDir?: string;             // debug=true일 때만 사용
  budget?: Partial<BudgetLimits>;  // 한도 커스터마이즈 (대부분 기본값 사용)
}

interface BudgetLimits {
  maxRounds: number;       // 트리 전체 LLM 라운드 한도 (제안: 20)
  maxSearches: number;     // 트리 전체 search+paginate 한도 (제안: 8)
  maxExplores: number;     // 트리 전체 explorer 디스패치 한도 (제안: 10)
  maxParallel: number;     // 한 delegate_parallel 배치 동시 디스패치 한도 (제안: 3)
  maxDepth: number;        // 재귀 최대 깊이 (제안: 3)
  maxChildCallsPerAgent: number;  // 한 리서처가 자식 호출 가능 횟수 (제안: 3)
}
```

### 출력 형식 (자연어 + 템플릿)

```
ANSWER:
<자연어 답변 본문. 인용은 인라인으로 "(source: <url>)" 형태.>

SOURCES:
- <url 1>
- <url 2>

COVERAGE: <complete | partial | none>
GAPS:
- <메우지 못한 정보 항목 1>
- <메우지 못한 정보 항목 2>

NEXT_CANDIDATES:
- <부모가 이어서 확인하면 좋은 후보 URL 또는 (none)>
```

루트 호출의 출력도 비루트(부모에 보고)의 출력도 같은 형식. 외부 호출자도, 부모 리서처의 LLM도 동일하게 파싱·이해 가능.

---

## 6. 내부 구조

### 디렉토리 레이아웃

```
src/search/v2/
  types.ts          — ResearchOptions / ResearcherBrief / SharedBudget / BudgetLimits
  prompts.ts        — buildResearcherInitialPrompt / 액션 결과 메시지 / 스키마들
  researcher.ts     — research() 함수 (재귀 핵심)
  cli.ts            — CLI 진입점
```

### 핵심 함수

```typescript
async function runResearcher(
  brief: ResearcherBrief,
  client: OpenAIClient,
  logger: V2Logger,
  budget: SharedBudget,
  candidateRegistry?: CandidateRegistry,
): Promise<string>;

interface ResearcherBrief {
  agentId: string;
  parentAgentId: string | null;
  goal: string;                 // 자연어 목표
  parentGoal: string;           // 원래 사용자 질문 (재귀 깊이와 무관하게 보존)
  startUrl?: string;            // 있으면 그 URL에서 시작, 없으면 URL 없는 리서처
  depth: number;
}

class SharedBudget {
  limits: BudgetLimits;
  visitedUrls: Set<string>;
  searchHistory: Array<{engine, query, page}>;
  // mutable counters
  roundsUsed: number;
  searchesUsed: number;
  exploresUsed: number;
  
  // 체크/예약 API (각 행동 직전에 호출)
  roundsRemaining(): number;
  consumeRound(): void;
  canRecurseDeeper(currentDepth: number): boolean;
  reserveSearch(engine, query, page): { ok: true } | { ok: false; reason: string };
  reserveDelegate(url?): { ok: true } | { ok: false; reason: string };
}
```

### 라운드 루프 (의사 코드)

```
runResearcher(brief):
  logger.startAgent(brief.agentId, brief.parentAgentId)
  
  if brief.startUrl:
    page = convertPage(brief.startUrl)
    if page is long:
      sectionSelection = client.complete(..., schema=researcher_page_section_selection)
      page = selected sections
    currentSurface = page
    messages = buildChildInitialMessages(brief, page)
  else:
    currentSurface = null
    if brief.parentAgentId == null:
      messages = buildRootCoordinatorMessages(brief)
    else:
      messages = buildSubResearcherInitialMessages(brief)
  
  perAgentMaxRounds = budget.limits.maxChildCallsPerAgent + 3
  for round in 1..perAgentMaxRounds:
    if budget.roundsRemaining() <= 0:
      return synthesizeFinalAnswer(brief, messages, reason="트리 전체 라운드 예산 소진")
    budget.consumeRound()
    
    schema = pickSchema(brief, budget, currentSurface, round, childCallCount)  # 동적 스키마
    # root 첫 라운드: delegate/delegate_parallel만
    # URL 시작 자식 첫 라운드: read_sections/delegate/delegate_parallel/done만
    # URL 없는 서브 리서처 첫 라운드: search만
    text = client.complete(messages, schema)
    
    action = parseJsonResponse(text).decision
    if action invalid:
      messages.append(assistant: text)
      reject(...) → continue
    messages.append(assistant: normalized action JSON)
    
    switch action:
      case "done":
        log → return action.answer
      case "read_sections":
        selected = selectSectionMarkdown(...)
        currentSurface.visibleCandidateIds += visible IDs from selected markdown
        messages.append(user: section_read_result)
      case "search" | "paginate":
        ... (v1 오케스트레이터의 로직 거의 그대로)
        budget.reserveSearch(...) 통과 시에만 실행
        currentSurface = SERP
      case "delegate":
        if !budget.reserveDelegate(url): reject; continue
        childCallCount++
        childAnswer: string = await runResearcher(childBrief)  # 재귀!
        messages.append(user: child_result_message(childAnswer))
      case "delegate_parallel":
        filter invalid/duplicate branches first
        reserve remaining branches
        childAnswers = await Promise.all(runResearcher(childBrief))
        messages.append(user: parallel_child_result_message(childAnswers))
  
  # 에이전트별 라운드 한도 소진 → 누적 messages로 강제 합성
  return synthesizeFinalAnswer(brief, messages, reason="에이전트별 라운드 예산 소진")
```

### research 래퍼

```typescript
export async function research(
  goal: string,
  options: ResearchOptions,
  client: OpenAIClient,
  logger: V2Logger
): Promise<string> {
  const budget = new SharedBudget(options.budget);
  const rootBrief = { agentId: "researcher-root", parentAgentId: null, goal, parentGoal: goal, depth: 0 };
  return runResearcher(rootBrief, client, logger, budget);
}
```

CLI에서는 `cli-runner.ts`가 env/config를 읽고 `V2Logger`, `OpenAIClient`, `ResearchOptions`를 만든 뒤 이 래퍼를 호출한다.

---

## 7. 구현 순서

### Step 1 — 디렉토리와 타입 스켈레톤
- `src/search/v2/types.ts` 작성
- `SharedBudget` 클래스 구현 (체크/예약 API 포함)

### Step 2 — 프롬프트와 스키마
- `src/search/v2/prompts.ts` 작성
  - 시스템 프롬프트 (루트/비루트 통합 또는 분기)
  - SERP 결과 메시지 / explore 결과 메시지 / 에러 메시지
  - 자연어 답변 템플릿 안내
  - Structured Outputs 스키마들 (`decision` 래핑)

### Step 3 — 리서처 본체
- `src/search/v2/researcher.ts`의 `runResearcher` 작성
- v1의 거부 헬퍼 패턴과 액션 분기 로직을 가져와 적응
- 재귀 호출 부분이 핵심: `runResearcher(childBrief)` 직접 호출

### Step 4 — 외부 래퍼와 CLI
- `research()` 함수 export
- `src/search/v2/cli.ts` 작성
- `package.json`에 `llm-search-v2` 바이너리 추가

### Step 5 — 빌드 검증
- `npm run build` 통과
- v2 모듈이 깨끗하게 컴파일되는지 확인

### Step 6 — 단위 테스트
- v1 테스트와 별개 파일 (`test/researcher-v2.test.ts`)
- 시나리오: root 위임 / 시작 페이지 첫 라운드 제한 / 긴 페이지 섹션 읽기 / delegate_parallel 거부 경로 / 후보 ID 제한 / 한도 도달

### Step 7 — 통합 점검
- 실제 CLI로 돌려서 v2 monitor 출력과 `researcher-*.jsonl` 로그 확인
- 디버그 로그가 v2 페이로드(`startUrl`, `answer`, `forced` 등)를 읽기 좋게 표시하는지 확인

현재 구현은 Step 1~7까지 진행된 상태다. 테스트 파일은 `test/researcher-v2.test.ts`에 있으며, 이후 작업은 시나리오 확장과 평가 하네스 도입이다.

---

## 8. 검증 방법

### 자동 검증
- `npm run build` 통과
- `npm test` 통과
- v2 테스트 파일: `test/researcher-v2.test.ts`

### 수동 검증
- v1과 같은 쿼리로 v2 CLI 실행 후 결과 비교
  - 페이커 케이스 / 토스 채용 시나리오 등
- 동일 쿼리에서 토큰 사용량 비교 (자기유사 재귀가 의도된 효율 개선을 가져오는지)
- URL 없는 서브 리서처가 SERP를 만들고, 시작 URL을 받은 리서처가 첫 라운드에서 페이지 분석을 우선하는지 확인

---

## 9. 열린 질문 / 후속 결정

본 단위에서는 다음을 *결정하고 진행*:

- **루트와 비루트의 시스템 프롬프트를 통합할지 분기할지**: 시스템 프롬프트는 통합하고, 루트/서브/시작 페이지 보유 여부는 초기 메시지와 상태별 스키마로 구분한다.
- **자연어 보고 템플릿의 정확한 형식**: `ANSWER / SOURCES / COVERAGE / GAPS / NEXT_CANDIDATES` 섹션. 부모 LLM이 이를 읽고 후속 행동 판단 가능하도록 프롬프트 가이드 제공.
- **maxDepth 기본값**: 코드 기본값은 3, 현재 저장소 config 기준 v2 실행값은 5.

본 단위에서 *미루는* 결정:
- v2가 안정화되면 v1 deprecation 여부 — 별도 결정.
- MCP 서버 노출 — 별도 작업.
- 평가 하네스 (`TODO.md`) — v1/v2 양쪽 모두에서 평가할 수 있도록 별도 작업.
- v1과 v2 사이 인터페이스 호환성 (예: v2가 v1 ExplorationReport를 받아 처리할 수 있어야 하는가) — 불필요. 둘은 독립적.

---

## 10. 본 구현 작업이 끝나는 시점

다음이 모두 갖춰지면 본 단위 종료:

- [x] `src/search/v2/` 디렉토리 생성 및 5개 파일 작성 (types/budget/prompts/researcher/cli)
- [x] `package.json`에 `llm-search-v2` 바이너리 등록
- [x] `npm run build` 통과
- [x] 기존 v1 테스트 9개가 그대로 통과 (regression 없음)
- [x] CLI help 출력 동작 확인

이 시점에서 사용자가 `node dist/search/v2/cli.js --query "..."` 로 실행해볼 수 있는 상태가 된다. 자동 테스트는 별도 후속 작업.

## 11. 구현 결과 (본 단위 종료 시점)

### 파일 구성

```
src/search/v2/
  types.ts       — ResearchOptions / BudgetLimits / ResearcherBrief / CurrentSurface / CandidateLink
  budget.ts      — SharedBudget 클래스 (reserveSearch/reserveDelegate/canRecurseDeeper 등)
  sections.ts    — 긴 마크다운 페이지 섹션 인덱싱과 선택 읽기
  prompts.ts     — 상태별 액션 스키마(decision 래핑) + 시스템 프롬프트 + 결과 메시지 빌더
  researcher.ts  — runResearcher 재귀 본체 + research() 외부 래퍼
  logger.ts      — V2Logger
  cli.ts         — node dist/search/v2/cli.js 진입점
```

### 동작 확인 사항

- `npm run build` 통과 (TypeScript 컴파일 클린)
- `npm test` v1 테스트 9개 모두 통과 (v1 코드는 건드리지 않음)
- `llm-search-v2 --help` 도움말 출력 확인

### 알려진 단순화 / 결정 사항

1. **paginate는 search 컨텍스트에서만 동작** — 자식 리서처가 페이지에서 시작한 경우 paginate는 거부됨 (의미상 SERP가 아닌 일반 페이지를 paginate할 수 없음).
2. **SERP와 페이지를 CurrentSurface로 통합 관리** — delegate/delegate_parallel이 SERP 후보와 페이지 링크 후보를 동일한 메커니즘으로 다룬다.
3. **자식 답변은 자연어 그대로 부모 messages에 append** — 별도 구조화 파싱 없음. 부모 LLM이 ANSWER/SOURCES/COVERAGE/GAPS/NEXT_CANDIDATES 템플릿을 읽고 후속 행동 판단.
4. **per-agent 라운드 상한 = maxChildCallsPerAgent + 3** — 자식 호출 + 초기 + 마지막 done + 여유 1.
5. **트리 전체 라운드 한도 + 개별 에이전트 라운드 한도 이중 제한**.
6. **현재 날짜/시각은 런타임 user 메시지로 주입** — system prompt는 정적으로 유지해 prompt/KV cache prefix를 깨지 않으며, `research()`가 한 번 만든 시각 값을 전체 하위 리서처에 전달한다.

### 다음 단계 (별도 작업)

- v2용 시나리오 테스트 확장 (`test/researcher-v2.test.ts`)
- 동일 쿼리에서 v1 vs v2 비용·품질 비교
- 평가 하네스 도입 (`TODO.md`)
- v2 안정화 시 v1 deprecation 여부 결정

---

## 12. 실행 평가와 1차 수정 사이클

본 단위 종료 후 동일 쿼리("페이커와 같은 팀으로 함께한 역대 탑라이너들")로 두 차례 수동 실행하여 동작을 점검했다. 발견된 문제와 조치:

### 1차 실행 — 발견된 5개 문제

1. **V2 페이로드를 v1 로거가 못 읽어 stderr가 `undefined` 도배** — `mission_brief`/`exploration_report`/`done`의 필드명이 v1과 달라 출력이 깨짐.
2. **폴백 메시지가 잘못된 원인 보고** — 트리 라운드 한도 도달인데 "Per-agent" 표시.
3. **루트가 done 도달 못 함** — 트리 라운드 한도 도달 후 stub 폴백 답변만 반환.
4. **깊은 리서처가 시작 페이지를 무시하고 search 반복** — Canna/Roach 자식이 받은 페이지를 분석 안 하고 4~5회 search 루프.
5. **폴백 시 누적된 자식 답변이 버려짐** — `buildFallbackAnswer`가 brief.goal만으로 stub 답변 생성, messages의 자식 보고는 미사용.

### 적용한 조치

- **V2Logger 신규 작성** (`src/search/v2/logger.ts`) — v2 페이로드 필드(`startUrl`, `answer`, `forced` 등)에 맞춘 stderr 출력. `DebugLogger`를 `super(false, ...)`로 무력화시켜 상속하면서 `OpenAIClient`의 `DebugLogger` 타입 요구와 호환.
- **한도 도달 시 `synthesizeFinalAnswer` 호출** — 트리/에이전트 라운드 한도 도달 시 LLM을 한 번 더 호출(`buildDoneOnlySchema`)해 누적 messages로 답변 합성. 빈손으로 끝나지 않음.
- **`buildEmergencyFallback`** — LLM 합성 호출 자체가 실패한 경우의 최후 폴백.
- **시작 페이지 첫 라운드 스키마 제한** — `buildStartPageFirstSchema`로 시작 페이지를 받은 리서처의 첫 행동에서 search/paginate를 제거.

### 2차 실행 — 잔존 / 새 패턴

1. **(해결) 로그 답변 미리보기** — `previewAnswerLine`이 `ANSWER:` 헤더 다음 첫 내용 줄을 표시하도록 수정됨.
2. **(신규) 죽은/빈 시작 페이지(227자, 사실상 404)에서 search 무한 루프** — Profit 페이지에서 위임된 손자 리서처가 6회 search 후 강제 합성. 시작 페이지 분석 우선 규칙이 *유효한 페이지가 주어졌을 때*만 발휘되고, *죽은 페이지가 주어진 경우*에 대한 가드 없음.
3. **(해결) 첫 행동 분석 규칙 우회** — 시작 페이지 첫 라운드에서 search가 스키마로 차단됨.
4. **(부산물) 루트가 자식 보고 후 자기 결정 기회를 못 받음** — 자식 트리가 트리 라운드 한도 대부분을 소비. 강제 합성 답변은 정상 생성됨(자식 보고로 만든 답변이 합리적).

현재 핵심 잔존 이슈는 dead/empty page에서 불필요한 후속 search가 길어질 수 있다는 점이다. search saturation 가드는 추가 평가 후 도입한다.

---

## 13. 논의로 도출된 아키텍처 원칙

평가 사이클을 통해 *구조적 원칙*이 분명해졌다. 이 원칙들은 향후 결정에 기준점이 된다.

### 13-1. 얕은 읽기 vs 깊은 읽기

리서처가 수행하는 "읽기"는 두 종류로 구분된다:

- **얕은 읽기 (shallow read)**: SERP / 링크 인덱스 페이지. 1~8KB. 후보 URL 목록 + 짧은 스니펫을 훑어보는 용도.
- **깊은 읽기 (deep read)**: 콘텐츠 페이지. 30~100KB. 정보 추출이 목적.

루트는 "페이지를 안 읽는" 것이 아니라 **"깊은 읽기를 안 한다"**. 현재 구현에서 루트의 첫 행동은 발견 작업을 하위 리서처에게 위임하는 것이다. URL 없는 서브 리서처가 SERP를 *얕게* 읽고, 그 신호로 후보 페이지를 선택해 다시 하위 리서처에게 위임한다. **SERP가 도구의 입력 어댑터 역할**을 하지만, 그 얕은 읽기는 루트가 아니라 URL 없는 서브 리서처에서 일어난다.

이 구분이 없으면 "루트는 페이지 안 읽음" / "에이전트는 위임만 함" 같은 표현이 잘못된 직관을 만든다.

### 13-2. 한 에이전트당 깊은 읽기 한 번

각 리서처는 *깊은 읽기*를 한 번만 한다 (자기 `startUrl`). 추가 페이지 깊이 읽기는 모두 자식에게 위임.

- 같은 에이전트에서 페이지 두 개를 직접 로드하면 컨텍스트 30+30=60KB 누적 → 무한히 자라남.
- `delegate` 액션이 *위임*이지 *직접 로드*가 아니므로, 이 원칙은 v2의 구조에서 이미 자동으로 지켜진다.
- 검색(SERP 읽기)은 얕은 읽기라 여러 번 해도 누적 비용이 작다. 다만 *불필요한* search 반복은 라운드 낭비.

### 13-3. 루트의 "초기 조건" ≠ 비대칭

루트와 자식은 *같은 함수*다. 차이는 입력의 초기 조건:
- 루트: `startUrl: undefined`, `parentAgentId: null` → 첫 행동은 delegate/delegate_parallel 강제 (스키마로 제한)
- 자식: `startUrl: <url>` → 페이지 로드 후 분석 우선

이건 함수가 다른 것이 아니라 *입력이 다른* 것. 재귀 본질을 깨지 않는다.

> "루트는 페이지 탐색 안 하는 특별한 에이전트"라는 표현 대신 "루트는 시작 페이지가 없는 초기 상태의 리서처"로 표현해야 정확하다.

### 13-4. 자식 책임 경계

각 자식은 **하나의 investigation context** (자기 시작 페이지)에 책임을 진다. 그 페이지로 답이 안 나오면:
- *권장*: done with COVERAGE: none/partial → 부모가 다른 후보를 시도하도록 위임
- *비권장*: 자기가 search를 계속하며 답을 찾을 때까지 추적

자기가 끝까지 추적하면 트리 라운드를 잡아먹고 부모의 결정 기회를 빼앗는다. 2차 실행의 Profit-l195 케이스가 정확히 이 위반.

### 13-5. 무한 위임은 구조적으로 차단됨

`maxDepth`가 잎 노드 깊이를 막는다. 잎(depth=maxDepth) 리서처는 schema에서 delegate/delegate_parallel 옵션이 제거되어 현재 표면에서 가능한 읽기와 done만 수행한다. 따라서 "모든 에이전트가 위임만 한다" 시나리오는 구조적으로 차단된다.

위에서 추상적으로 사고하는 에이전트와 아래에서 실제 페이지를 분석하는 에이전트가 자연스럽게 분업된다.

---

## 14. 다음 작업 우선순위

남은 품질 이슈를 해결하기 위해 다음 가드들을 검토:

### A. Dead-page 가드 (★★★ 핵심 잔존 이슈)

자식의 시작 페이지가 명백히 비정상(예: 본문 300자 미만, 명백한 404 신호)이면:
- 코드 차원에서 감지 → 자식 초기 메시지에 "이 페이지는 비정상으로 보임. 즉시 done with COVERAGE: none을 권장" 안내 주입.
- 모델이 이 안내를 보면 search 루프 대신 빠른 종료 선택 가능.

### B. Search saturation 가드 (★★)

같은 리서처가 N회(예: 2회) 연속 search 후에도 delegate나 done으로 전환하지 않으면, 다음 라운드의 schema에서 search/paginate 제외 → delegate 또는 done만 가능.

행동 패턴 자체를 schema로 강제. 프롬프트는 비결정적이라 우회됐던 사례들(2차 실행 #3) 보완.

### C. 자식 책임 경계 프롬프트 강화 (★★)

자식 초기 프롬프트에 다음 메시지 추가:

> You are responsible for ONE investigation context (your starting page). If this page does not yield, return done with COVERAGE: none/partial and let your parent decide whether to try a different angle. Do NOT chase the answer across many searches yourself — that's your parent's role.

부모-자식 책임 분담을 명시. 자식이 자기 영역을 넘어 추적하지 않도록.

### 적용 순서 권장

1. **A (Dead-page 가드)** — dead/empty page 루프 직접 차단
2. **C (자식 책임 경계 프롬프트)** — 자식이 자기 영역 지키도록 유도
3. **B (Search saturation schema)** — 위 둘로 부족할 때의 hard guarantee

A+C는 보완 관계. A는 *시작 페이지가 명백히 죽었을 때*만 발동하지만, C는 *일반적인 경우*에도 자식의 search 욕망을 누름. 둘 다 도입이 자연스럽다.
