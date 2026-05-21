# 에이전트 아키텍처 — 동작·역할·기능 명세

이 문서는 llm-search의 두 에이전트(**오케스트레이터**, **탐색 에이전트**)가 현재 어떤 책임을 지고 어떤 흐름으로 움직이는지를 코드 기준으로 정리한다. CLAUDE.md / AGENTS.md가 빠른 가이드를 제공한다면, 이 문서는 동작 명세에 가깝다.

상위 흐름은 `runSearch(options)` → 오케스트레이터 라운드 루프 → 필요 시 `runExplorationAgent(brief)` 호출 → 보고 수집 → 최종 답변 합성.

---

## 1. 두 에이전트의 관계

```
사용자 질문
   │
   ▼
┌────────────────────────────────────────────┐
│  Orchestrator  (1 인스턴스, runSearch)      │
│   - 검색 엔진/쿼리/페이지 결정              │
│   - 어떤 SERP 후보를 탐색할지 결정          │
│   - 보고 수집 후 답변 합성                  │
└──────────────┬─────────────────────────────┘
               │ MissionBrief (URL + goal + depth=0)
               ▼
┌────────────────────────────────────────────┐
│  Explorer  (라운드마다 0~N 인스턴스)         │
│   - 주어진 URL 하나를 분석                  │
│   - 깊이가 남으면 자식 Explorer 호출 가능   │
│   - ExplorationReport 반환                  │
└──────────────┬─────────────────────────────┘
               │ MissionBrief (depth+1)
               ▼
        Explorer (자식, ... depth=MAX_DEPTH까지)
```

핵심 원칙:
- **컨텍스트 격리** — 자식의 raw 페이지 본문이 부모 컨텍스트에 들어가지 않는다. 부모는 자식의 요약(summary, excerpts, missingInfo)만 본다.
- **append-only 메시지** — 각 에이전트의 messages 배열은 라운드 사이에 재구성되지 않고 끝에 추가만 된다. OpenAI prefix cache 히트율 유지가 목적.
- **자율 판단** — 행동 선택, 종료 시점, 자식 호출 여부 모두 LLM이 결정. 시스템은 안전망(하드 리밋, 거부 경로)만 제공.

---

## 2. 오케스트레이터 (`orchestrator.ts`)

### 2.1 역할

사용자 질문 1개에 대해 최종 답변 1개를 생성한다. 그 과정에서 검색 엔진을 골라 SERP를 가져오고, 어떤 후보 페이지를 어떤 방식으로 탐색할지 결정하며, 보고들을 모아 합성한다.

### 2.2 입력 / 출력

- 입력: `SearchOptions` (`query`, `model`, `debug`, `logDir`)
- 출력: 사용자 답변 문자열 (자연어, 인용 포함)

### 2.3 상태

루프 진입 전에 초기화되어 라운드 동안 유지되는 상태:

| 필드 | 의미 |
|---|---|
| `messages: LLMMessage[]` | LLM에 보낼 누적 컨텍스트 (append-only) |
| `reports: ExplorationReport[]` | 디스패치한 explorer들의 보고 |
| `exploredUrls: string[]` | 오케스트레이터가 디스패치한 URL 목록 (중복 방지) |
| `searchHistory: {engine, query, page}[]` | 시도한 검색 조합 (중복 방지) |
| `currentSerp: CurrentSerp \| null` | 가장 최근의 SERP 결과 (explore/paginate가 참조) |
| `searchCount: number` | 누적 search + paginate 횟수 |
| `exploreCount: number` | 누적 explorer 디스패치 수 (병렬 1배치 = 각 branch가 1씩) |

### 2.4 행동 5종

LLM이 매 라운드 정확히 한 행동을 선택. JSON 스키마(`orchestratorActionSchema`)로 강제됨.

| 액션 | 필드 | 시스템 동작 |
|---|---|---|
| `search` | `engine` ∈ {google,naver,bing}, `query`, `rationale` | `buildSerpUrl` → `convertPage` → `extractSerpSnippets` → `currentSerp` 갱신, 결과를 user 메시지로 append |
| `paginate` | `page: int ≥ 1`, `rationale` | `currentSerp`의 (engine, query)에 page만 바꿔 같은 흐름 |
| `explore` | `linkId`, `task`, `rationale` | `currentSerp.result.links[linkId]` URL로 `runExplorationAgent` 디스패치, 보고를 user 메시지로 append |
| `explore_parallel` | `branches: [{linkId, task, rationale}]` (2~MAX_PARALLEL), `rationale` | 유효한 branch만 모아 `Promise.all`로 병렬 디스패치, 보고를 user 메시지로 append |
| `done` | `reason` | 루프 종료, 합성으로 진행 |

### 2.5 라운드 루프 흐름

```
for round in 1..ORCHESTRATOR_MAX_ROUNDS:
  text = client.complete(messages, schema=orchestratorActionSchema)
  messages.append({role:"assistant", content:text})           ← raw 응답을 그대로 append
  action = parseJsonResponse(text).decision

  if action invalid:
    reject(...) → orchestrator_plan(action:"rejected") + 에러 user 메시지 주입 → continue
  if action == done:
    orchestrator_plan(action:"done") → break
  if action in {search, paginate}:
    validate → buildSerpUrl → convertPage → snippets append → continue
  if action == explore:
    validate → runExplorationAgent → 보고 append → continue
  if action == explore_parallel:
    validate branches → Promise.all(runExplorationAgent) → 보고들 append → continue
```

### 2.6 거부 경로 (`reject` 헬퍼)

다음 모든 경우는 `orchestrator_plan { action: "rejected", requestedAction, reason, ...context }` 이벤트를 emit하고, user 메시지로 에러 안내를 주입한 뒤 다음 라운드로 넘어간다 — **크래시 없음**.

- LLM 응답 JSON 파싱 실패 (`requestedAction: "unknown"`, `rawResponsePreview` 200자)
- `search` 한도(`ORCHESTRATOR_MAX_SEARCHES`) 도달
- `search.engine`이 지원되지 않음
- `search.query`가 빈 문자열
- `paginate`인데 `currentSerp` 없음 / `page`가 양의 정수 아님
- 같은 `(engine, query, page)` 재시도
- SERP 변환 실패 (`convertPage` throw)
- `explore`/`explore_parallel`인데 `currentSerp` 없음
- explorer 한도(`ORCHESTRATOR_MAX_EXPLORES`) 도달
- `explore.linkId`가 누락이거나 SERP에 없음
- `explore.linkId`의 URL이 이미 방문됨
- `explore_parallel.branches`가 모두 무효
- 위 어느 분기에도 해당하지 않는 알 수 없는 action

### 2.7 종료 게이트 (프롬프트로 강제)

LLM이 `done`을 고르려면 다음 조건을 만족해야 한다고 프롬프트에 명시:

- **List/history 검증 게이트** — `역대/전체/모든` 류 질문은 SERP 스니펫만으로 답하지 말고 최소 1회 explore 필수.
- **Partial-report 후속 게이트** — 이전 explore 보고가 `completeness: "partial"` + 비어 있지 않은 `missingInfo`였다면, done 전에 그 갭을 메우는 행동을 한 번 더 시도해야 함.
- **done.reason 그라운딩 룰** — `reason` 필드는 이전 라운드의 action 결과에 실제로 등장한 정보만 참조. 사전 지식 인용 금지.

이 게이트는 코드가 강제하지 않고 프롬프트로만 강제한다(LLM의 자율 판단). 시스템은 그 결과로 done이 잘못 나와도 그대로 종료한다.

### 2.8 최종 합성

루프 종료 후 `reports.filter(r => r.found)`로 useful 보고만 추림.

- useful 보고 1개 이상 → `buildSynthesisPrompt(query, usefulReports, serpOnly=false)` — URL 인용 가능
- useful 보고 0개 + `currentSerp` 있음 → 최근 SERP 스니펫 1개로 폴백, `serpOnly=true` — URL 인용 금지
- useful 보고 0개 + `currentSerp` 없음 → "no search performed" 빈 보고로 합성

합성 LLM 호출은 **스키마 없는 자연어 응답**. stdout으로 직접 출력.

### 2.9 하드 리밋

| 상수 | 기본값 | 의미 | 위치 |
|---|---|---|---|
| `ORCHESTRATOR_MAX_ROUNDS` | 12 | 전체 LLM 판단 라운드 수 | `prompts.ts` |
| `ORCHESTRATOR_MAX_SEARCHES` | 5 | search + paginate 합계 | `prompts.ts` |
| `ORCHESTRATOR_MAX_EXPLORES` | 5 | explorer 누적 디스패치 (병렬 1배치 = 각 branch 1씩) | `prompts.ts` |
| `MAX_PARALLEL` | 3 | 한 explore_parallel 배치 내 동시 디스패치 수 | `prompts.ts` |

---

## 3. 탐색 에이전트 (`explorer.ts`)

### 3.1 역할

오케스트레이터(또는 부모 explorer)로부터 받은 미션 1개를 수행. 주어진 URL을 출발점으로 페이지를 변환하고, 필요하면 그 페이지의 링크를 따라 자식 explorer를 호출해가며 정보를 모은다. 최종적으로 `ExplorationReport` 1개를 반환한다.

### 3.2 입력 (`MissionBrief`)

| 필드 | 의미 |
|---|---|
| `agentId` | 고유 식별자 (logger의 트리 구성용). 자식의 agentId는 `${parent}-${linkId.lower()}` 형식 |
| `parentAgentId` | 부모 식별자 (오케스트레이터 디스패치 시 `"orchestrator"`) |
| `goal` | 이 에이전트의 구체 목적 (오케스트레이터/부모가 결정한 task) |
| `url` | 분석 시작점 URL |
| `parentGoal` | 원래 사용자 질문 — 자식이 맥락을 잃지 않게 전달 |
| `depth` | 재귀 깊이. 오케스트레이터의 직접 자식 = 0, 그 자식 = 1, ... |

### 3.3 출력 (`ExplorationReport`)

| 필드 | 타입 | 의미 |
|---|---|---|
| `agentId` | string | 어느 에이전트가 만든 보고인지 |
| `url` | string | 분석한 출발 URL |
| `found` | boolean | 관련 정보 발견 여부 |
| `completeness` | `"complete" \| "partial" \| "none"` | 답의 완전성 정도 |
| `summary` | string | 자식 결과까지 통합한 2-5문장 요약 |
| `relevantExcerpts` | string[] | 방문 페이지에서 그대로 인용한 짧은 발췌 (최대 3개) |
| `missingInfo` | string[] | 답에 필요했지만 못 채운 항목들. 부모/오케스트레이터의 후속 행동 입력. |
| `tokenUsage` | TokenUsage | 이 에이전트와 자식 트리 전체의 누적 토큰 |

### 3.4 행동 2종

LLM이 매 라운드 정확히 한 행동을 선택. 라운드별 가능 행동에 따라 스키마가 달라진다:

- `canExploreNow = !isLastRound && depth < MAX_DEPTH && childCallCount < MAX_CHILD_CALLS_PER_AGENT`
- `canExploreNow == true` → `explorerActionSchemaCanExplore` (explore + done 둘 다)
- `canExploreNow == false` → `explorerActionSchemaTerminal` (done만)

| 액션 | 필드 | 시스템 동작 |
|---|---|---|
| `explore` | `linkId`, `task`, `rationale` | 페이지의 `[L*]` 링크로 자식 explorer 디스패치 (`runExplorationAgent` 재귀), 자식 보고를 messages에 append, 다음 라운드 진행 |
| `done` | `found`, `completeness`, `summary`, `relevantExcerpts`, `missingInfo` | 루프 종료, `ExplorationReport` 반환 |

### 3.5 상태 (호출 단위)

| 필드 | 의미 |
|---|---|
| `messages: LLMMessage[]` | append-only 컨텍스트 (초기 = system + 페이지 본문 포함 user 메시지) |
| `totalTokenUsage` | 자기 + 자식 트리의 누적 토큰 |
| `childCallCount` | 이 에이전트가 호출한 자식 수 |
| `visitedUrls: Set<string>` | **재귀 트리 전체에서 공유되는 중복 방지 set**. 인자로 전달되어 부모/자식/형제가 같은 인스턴스를 공유. 단, 오케스트레이터의 `exploredUrls`와는 분리 — 트리 간 공유는 없음. |

### 3.6 라운드 루프 흐름

```
visitedUrls.add(brief.url)
result = convertPage(brief.url)
messages = buildExplorerInitialPrompt(brief, result.markdown)

for round in 0..MAX_ROUNDS:    # MAX_ROUNDS = MAX_CHILD_CALLS_PER_AGENT + 2 = 5
  canExploreNow = !isLastRound && depth < MAX_DEPTH && childCallCount < MAX_CHILD_CALLS_PER_AGENT
  schema = canExploreNow ? canExplore : terminal
  text = client.complete(messages, schema=schema)
  parsed = parseJsonResponse(text).decision

  if parsed.action == done:
    build ExplorationReport → log → return

  # parsed.action == explore (canExploreNow == true이어야만 도달)
  entry = result.links[parsed.linkId]
  if entry exists and !visitedUrls.has(entry.url):
    visitedUrls.add(entry.url); childCallCount++
    childBrief = {agentId, parentAgentId, goal=task, url, parentGoal, depth+1}
    childReport = runExplorationAgent(childBrief, visitedUrls)    # 재귀
    messages.append(assistant:text, user:buildExplorerContinueMessage(childReport, canExploreMore))
  else:
    # entry 없거나 이미 방문된 URL인 경우
    messages.append(assistant:text, user:"[탐색 불가: 사유. 최종 보고 부탁]")
```

루프가 끝까지 done을 받지 못한 경우(이론상 거의 없음, "탐색 불가" 메시지가 done을 강하게 유도) 폴백 `ExplorationReport` 반환.

`convertPage` 실패는 try/catch로 잡혀 `found: false, completeness: "none"` 보고로 변환됨 — **크래시 없음**.

### 3.7 자식 보고 → 부모 요약 통합

부모는 자식의 `ExplorationReport`를 받아 다음 라운드의 LLM 컨텍스트에 *요약된 형태*로 append (`buildExplorerContinueMessage`):

```
Child exploration result from <url>:
found: ...
completeness: ...
summary: ...
Key excerpts: ...
missingInfo: ...
```

부모 LLM은 이 정보를 보고 다음 행동을 결정한다. 자식의 raw 페이지는 부모 컨텍스트에 없음 — **컨텍스트 격리**.

부모가 done할 때 자기 `summary`에 자식 보고의 관련 내용을 *선별적으로* 통합한다. 자식 보고 전체가 상위로 그대로 올라가지 않음.

### 3.8 종료 게이트 (프롬프트로 강제)

- **done 양조건 게이트** (canExplore일 때): "(a) 잔여 링크 중 추가 정보를 줄 만한 것이 없고, (b) 목표가 요구하는 검증 가능한 정보를 모두 모았다" 둘 다 만족할 때만 done.
- **done의 비가역성** — done 반환 시 이 페이지와 도달 가능한 모든 페이지가 잠긴다(재방문 불가).
- **list/history 보수성** — 광범위 질문에서는 `completeness="complete"`를 함부로 쓰지 말고 `partial`을 선호.
- **그라운딩 룰** — summary와 relevantExcerpts는 방문한 페이지에서만 추출. 사전 지식 금지. excerpts는 verbatim quote.

### 3.9 하드 리밋

| 상수 | 기본값 | 의미 |
|---|---|---|
| `MAX_DEPTH` | 2 | 재귀 최대 깊이. depth 0,1,2 에이전트가 존재 가능. depth=2 에이전트는 자식 호출 불가. |
| `MAX_CHILD_CALLS_PER_AGENT` | 3 | 한 에이전트가 자식을 호출할 수 있는 최대 횟수 |
| `MAX_ROUNDS` | 5 | `MAX_CHILD_CALLS_PER_AGENT + 2` — 1 초기 + N 자식 + 1 마지막 done |

---

## 4. 두 에이전트의 인터랙션

### 4.1 디스패치 (Orchestrator → Explorer)

오케스트레이터가 `explore` 또는 `explore_parallel` 액션을 골랐을 때:

1. `currentSerp.result.links[linkId]`에서 URL 추출 (병렬은 각 branch별로)
2. `exploredUrls` 등록 (병렬은 한꺼번에 — 같은 배치 내 충돌 방지)
3. `MissionBrief` 구성: `agentId="explorer-${round}"` (병렬은 `"explorer-${round}-${i+1}"`), `parentAgentId="orchestrator"`, `goal=task`, `url`, `parentGoal=options.query`, `depth=0`
4. `runExplorationAgent(brief, client, logger)` 호출 — **`visitedUrls` 인자 미전달** → 새 Set 생성 → **오케스트레이터의 explore 트리들은 서로 독립**

### 4.2 보고 흐름 (Explorer → Orchestrator)

- 단일 explore: `runExplorationAgent` 반환값을 `reports.push(...)` + `buildExploreResultMessage`로 user 메시지 append
- 병렬 explore: `Promise.all` 결과를 한꺼번에 `reports.push(...)` + `buildParallelExploreResultMessage`로 통합 user 메시지 append (선언 순서 = branch 순서 = 결정적)

### 4.3 디스패치 (Explorer → Child Explorer)

부모 explorer가 `explore` 액션을 골랐을 때:

1. `result.links[linkId]`에서 URL 추출
2. 부모 자신의 `visitedUrls` 인자를 그대로 자식에게 전달 — **트리 내 공유** 보장
3. `MissionBrief` 구성: `agentId="${parent}-${linkId.lower()}"`, `parentAgentId=brief.agentId`, `goal=task`, `url`, `parentGoal=brief.parentGoal`, `depth=brief.depth+1`
4. 직렬 호출 (`await runExplorationAgent(...)`) — 현재는 **explorer 레벨 병렬 미지원**

### 4.4 URL 공유의 한계

| 범위 | 공유 |
|---|---|
| 오케스트레이터 레벨 `exploredUrls` | 오케스트레이터의 라운드 사이에만 공유 |
| 한 explorer 트리 내 `visitedUrls` | 부모/자식/형제 explorer 사이 공유 |
| **다른 explorer 트리 사이** | **공유 안 됨** ← 같은 URL이 트리마다 재변환될 수 있음 (IMPROVEMENTS.md 항목으로 등록) |

---

## 5. 메시지 누적 규칙 (append-only)

두 에이전트 모두 동일 원칙:

```
messages = [system, user_initial]                        # 라운드 0의 입력
                                                          # ─ LLM 호출 ─
messages.push({role:"assistant", content:llm_raw_text})  # LLM 응답 (decision 래핑된 JSON)
messages.push({role:"user", content:action_result_text}) # 시스템이 행동을 실행한 결과
                                                          # ─ LLM 호출 ─
messages.push({role:"assistant", content:...})
messages.push({role:"user", content:...})
...
```

재구성/요약/삭제 없음 — OpenAI prefix cache 키 안정화 목적. 응답은 OpenAI Structured Outputs가 강제하는 `{ "decision": { "action": ..., ... } }` 형태로 그대로 들어감.

---

## 6. 데이터 흐름 한눈에 (예시)

질문: "X 회사의 매출과 직원 수"

```
[Orchestrator]
  Round 1: search(google, "X 회사 매출 직원 수", ...)
    → SERP markdown + 링크 [L1..Ln]
    → currentSerp 갱신, user 메시지에 SERP 스니펫 append

  Round 2: explore_parallel(L3=매출 페이지, L5=인사 페이지)
    [Explorer-2-1: 매출 페이지]
      converted page → LLM → done(found, partial, summary="매출 1.2조", excerpts, missingInfo=["연도 명시"])
    [Explorer-2-2: 인사 페이지]
      converted page → LLM → done(found, complete, summary="직원 1234명", excerpts, missingInfo=[])
    → reports에 둘 다 push
    → user 메시지에 두 보고 통합 append

  Round 3: search(google, "X 회사 2024년 매출", ...)
    (D 게이트: 이전 보고가 partial이라 missingInfo 메우러 재검색)

  Round 4: explore(L2=공시 페이지)
    [Explorer-4: 공시 페이지]
      → done(found, complete, summary="2024년 매출 1.21조")

  Round 5: done("매출과 직원 수 확인 완료")

[Orchestrator 합성]
  usefulReports = [Explorer-2-1, Explorer-2-2, Explorer-4]
  → buildSynthesisPrompt(..., serpOnly=false)
  → LLM (스키마 없음) → 자연어 답변 → stdout
```

---

## 7. 책임 경계 요약

| 책임 | 오케스트레이터 | 탐색 에이전트 |
|---|---|---|
| 검색 엔진/쿼리 결정 | ✓ | — |
| SERP 페이지 가져오기 | ✓ | — |
| SERP에서 후보 선택 | ✓ | — |
| 단일 페이지 분석 | — (Explorer에게 위임) | ✓ |
| 페이지 안의 링크 따라가기 | — | ✓ (자식 호출) |
| 보고의 선별·통합 | — (raw report만 받음) | ✓ (자식 보고를 자기 summary에 통합) |
| 사용자에게 답변 합성 | ✓ | — |
| 토큰 누적 집계 | — (라운드별 미집계) | ✓ (자식 트리 누적) |
| 거부 경로 로깅 | ✓ (`orchestrator_plan` action="rejected") | ✓ (`recursion_decision` action="skipped") |
| 컨텍스트 격리 | ✓ (보고 요약만 받음) | ✓ (자식 raw 페이지 못 봄) |

---

## 8. 의도된 비대칭 / 한계

현재 코드에 의도적으로 남아 있는 비대칭이나 한계 (정식 문제는 아니지만 IMPROVEMENTS.md의 후보):

- **Explorer 트리 간 URL 공유 없음** — 오케스트레이터 입장에서 같은 URL이 다른 트리 안에서 재변환될 수 있음.
- **Explorer 레벨 병렬 호출 없음** — 자식 호출이 직렬. fan-out 시나리오에서 wall-clock 손실.
- **부모 explorer 컨텍스트에 raw 페이지 본문이 계속 남음** — 첫 자식 호출 후에도 prefix에 거대한 페이지가 누적.
- **합성은 스키마 없는 자연어** — 의도된 동작 (답변은 자연어여야 함).
- **종료 게이트는 프롬프트로만 강제** — 코드 차원의 강제 없음. LLM이 게이트를 잘못 적용하면 시스템은 그대로 진행.
- **MAX_DEPTH=2의 의미** — Google → landing → list → item처럼 4단계 네비게이션이 필요한 시나리오에 빠듯.

자세한 개선 후보는 `IMPROVEMENTS.md` 참고.
