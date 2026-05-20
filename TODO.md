# LLM Search Tool — 설계 문서 및 구현 로드맵

---

## 1. 이 도구가 하는 일

사용자가 질문이나 검색을 요청하면, LLM이 자율적으로 웹을 탐색하여 정보를 수집하고 최종 답변을 반환하는 CLI 도구.

기존 llm-page-reader(웹 페이지를 LLM이 읽기 좋은 마크다운으로 변환하는 라이브러리) 위에 구축된다.

실행 방법:
```bash
node dist/search/cli.js --query "질문" [--debug] [--log-dir ./logs] [--model gpt-5.4-mini] [--env .env]
```

---

## 2. 핵심 설계 철학

### 2-1. 계층적 에이전트 구조

```
최상위 에이전트 (오케스트레이터)
  └── 탐색 에이전트 (explorer)
        └── 하위 탐색 에이전트 (재귀, Phase 2~)
              └── ...
```

- **오케스트레이터**: 사용자 쿼리 수신 → 검색 수행 → 탐색 에이전트 지시 → 결과 종합 → 최종 응답
- **탐색 에이전트**: 페이지 변환 → LLM으로 정보 추출 → 더 깊이 탐색할지 판단 → 상위에 보고

### 2-2. LLM이 탐색 너비와 깊이를 자율 판단

- 사전에 "몇 개 페이지를 탐색할지" 고정하지 않는다
- 매 탐색 후 LLM이 판단: "충분한 정보를 얻었는가? 아니면 더 탐색해야 하는가?"
- 중복 정보가 반복되거나 관련성이 낮아지면 스스로 종료
- 하드 리밋(최대 깊이, 최대 페이지 수)은 비용 폭발 방지용 안전장치로만 사용

### 2-3. 에이전트 간 정보 전달 원칙

**상위 → 하위 (미션 브리핑)**:
- 간결하게. 자식 에이전트가 독립적으로 판단할 수 있는 최소한의 정보만 전달
- 포함 내용: 탐색 목표(goal), 탐색할 URL, 원래 사용자 쿼리(parentGoal), 깊이 제한

**하위 → 상위 (탐색 보고)**:
- 맥락과 행동이 손실되지 않을 정도로 충분하게
- 포함 내용: 탐색한 URL, 발견 여부, 요약, 핵심 발췌문, 토큰 사용량

**부모 에이전트의 컨텍스트 구조**:
- 하위 보고를 받을 때 기존 컨텍스트를 재구성하지 않고 append만 함
- 이렇게 해야 prefix cache 히트율이 유지됨 (OpenAI prompt caching 대응)
- 자식 에이전트는 매번 새로 시작하므로 캐시 이점 없음 → 미션 브리핑을 짧게 유지하는 이유

### 2-4. 병렬 vs 직렬

- 독립적인 탐색 브랜치(결과와 무관하게 병렬로 탐색 가능)는 병렬 호출
- 이전 탐색 결과에 따라 다음 탐색이 결정되는 경우는 직렬
- 어떤 것이 병렬 가능한지도 LLM이 판단

---

## 3. 현재 구현 상태 (Phase 1 완료 / Phase 2 진행 중)

### 파일 구조

```
src/search/
  types.ts          — 공유 타입 정의
  logger.ts         — 디버그 로거 (JSON 트리 구조)
  openai-client.ts  — OpenAI SDK 래퍼
  prompts.ts        — 모든 LLM 프롬프트
  explorer.ts       — 탐색 에이전트
  orchestrator.ts   — 오케스트레이터
  cli.ts            — CLI 진입점
src/cli-utils.ts    — CLI 파싱 헬퍼 (option, intOption, required)
```

### Phase 1 동작 흐름

```
사용자 쿼리
  → [LLM] 검색 쿼리 생성 (한국어 → 영어 등 최적화)
  → Google SERP 변환 (convertPage, stealth=true, scroll=false)
  → 루프 (최대 MAX_PAGES=5회):
      [LLM] 판단: 더 탐색할지(explore) vs 종료(done)?
        - explore → 선택한 링크 URL로 탐색 에이전트 실행
            → convertPage(url, stealth=true, scroll=true)
            → [LLM] 관련 정보 추출 → ExplorationReport 반환
        - done → 루프 종료
  → [LLM] 수집된 보고들로 최종 답변 합성
  → stdout 출력
```

### 특이 동작: SERP 기반 합성

SERP 자체에서 충분한 정보를 얻은 경우(단순 사실 질문 등) LLM이 1라운드에서 "done"을 결정할 수 있음.
이 경우 탐색 없이 SERP 스니펫으로 바로 합성.
- SERP 기반 합성 시 출처 URL 인용 금지 (실제 방문하지 않았으므로)
- 페이지 탐색 기반 합성 시 출처 URL 인용 가능

### 토큰 효율화 (구현됨)

- **SERP → 판단 루프**: `extractSerpSnippets()` 적용. 네비게이션/푸터/링크ID 제거, Main Content 스니펫만 전달. 루프 진입 전 한 번만 실행, 매 라운드 재사용
- **SERP → 합성**: 위와 동일하게 스니펫만 전달

### 디버그 로그

`--debug` 플래그 활성화 시 `--log-dir` 경로에 JSON 파일 생성.

구조: 에이전트 계층을 반영한 트리 JSON
```json
{
  "agentId": "orchestrator",
  "depth": 0,
  "events": [ ... ],
  "children": [
    {
      "agentId": "explorer-1",
      "depth": 1,
      "events": [ ... ],
      "children": []
    }
  ]
}
```

기록 이벤트 종류:
- `llm_request` / `llm_response` — LLM 호출 입출력 + 토큰 사용량
- `page_markdown` — convertPage로 변환된 페이지 전문
- `mission_brief` — 상위 → 하위 에이전트 지시
- `exploration_report` — 하위 → 상위 에이전트 보고
- `orchestrator_plan` — 오케스트레이터의 매 라운드 판단 (explore/done)
- `final_answer` — 최종 답변

터미널 실시간 출력 (stderr): 에이전트 동작 상황을 한국어로 표시

---


## 5. Phase 2: 재귀 탐색

**목표**: 각 탐색 에이전트가 오케스트레이터와 동일한 구조의 아젠틱 루프를 실행한다. 자식 에이전트를 필요에 따라 반복 호출하고, 수집한 정보를 자율적으로 선별·통합해 단일 보고를 상위에 반환한다.

---

### 설계: 탐색 에이전트 아젠틱 루프

탐색 에이전트는 고정된 1회성 작업자가 아니라, 오케스트레이터와 동일한 루프 구조를 갖는 **미니 오케스트레이터**다.

```
[Explorer, depth=N]
  1. convertPage(url) → 페이지 마크다운 획득
  2. 초기 messages 구성: [system, user(goal + page_markdown)]
  3. 루프 (최대 MAX_CHILD_CALLS_PER_AGENT=3회):
       [LLM] 판단:
         explore(linkId, rationale)
           → 해당 링크로 자식 에이전트 실행 (depth=N+1)
           → 자식 ExplorationReport 수신
           → messages에 자식 보고 append (messages 재구성 금지)
           → 루프 계속
         done(found, summary, relevantExcerpts)
           → 루프 종료
           → ExplorationReport 반환 (부모에게)
  ※ depth >= MAX_DEPTH 이면 explore 판단이 나와도 자식 호출 안 함, 즉시 done으로 처리
```

**핵심 원칙**:
- 자식 보고를 상위 에이전트가 직접 보지 않는다. 깊이 N+1의 보고는 깊이 N 에이전트에게만 전달된다.
- 깊이 N 에이전트는 자신의 목적 기준으로 자식 보고를 평가하고, 관련 있는 내용만 자신의 `summary`에 통합한다. 자식 보고 전체를 상위에 올리지 않는다.
- 오케스트레이터는 `flattenReports` 없이 최상위 explorer의 단일 보고만 수신한다.
- 컨텍스트 append만 허용 (재구성 금지): 자식 보고를 받을 때마다 기존 messages 배열 끝에 추가. prefix cache 히트율 유지 목적.
- 하드 리밋(MAX_DEPTH, MAX_CHILD_CALLS_PER_AGENT)은 비용 폭발 방지 안전장치일 뿐, 탐색 구조를 규정하지 않는다.

**탐색 종료 조건** (LLM 자율 판단):
- 목표에 충분한 정보를 확보했을 때
- 탐색할 만한 관련 링크가 없을 때
- 자식 에이전트가 반복적으로 무관한 정보만 가져올 때
- 하드 리밋 도달 (강제 종료)

---

### 현재 구현 상태 (완료)

- [x] `MissionBrief`에 `depth` 필드 추가
- [x] 탐색 에이전트 내 `visitedUrls` 중복 방지 로직
- [x] explorer를 아젠틱 루프 구조로 재구현 (`explorer.ts`)
  - 페이지 변환 후 초기 messages 배열 구성
  - 루프: LLM 호출 → `explore(linkId)` 또는 `done(summary)` 판단
  - `explore`: 자식 에이전트 호출, 보고 수신, messages에 자식 보고 append (재구성 금지)
  - `done`: `ExplorationReport` 반환 (자식 결과를 선별 통합한 summary 포함)
  - `depth >= MAX_DEPTH` 시 "탐색 불가" 메시지 주입 → LLM이 done 반환하도록 유도
- [x] 새 프롬프트 함수 추가 (`prompts.ts`)
  - `buildExplorerInitialPrompt(brief, pageMarkdown)`
  - `buildExplorerContinueMessage(childReport, canExploreMore)`
  - 기존 `buildExplorerPrompt` 제거
- [x] orchestrator에서 `flattenReports` 제거 (`orchestrator.ts`)
- [x] `ExplorationReport`에서 `childReports` 필드 제거 (`types.ts`)
- [x] 하드코딩 상수:
  - `MAX_DEPTH = 2` (Phase 5에서 옵션화)
  - `MAX_CHILD_CALLS_PER_AGENT = 3` (Phase 5에서 옵션화)
- [x] logger의 `children` 구조가 재귀 깊이를 자동 반영함

---

## 6. Phase 3: 병렬 호출 (완료)

**목표**: 독립적인 탐색 브랜치를 동시에 실행해 전체 탐색 시간을 줄인다.

**설계 원칙**:
- 병렬 가능 조건: 탐색 결과와 무관하게 독립적으로 진행 가능한 경우
- 직렬 유지 조건: 이전 탐색 결과를 보고 다음 탐색 대상을 결정해야 하는 경우
- 어떤 것을 병렬로 실행할지도 LLM이 판단

**현재 구현 상태 (오케스트레이터 레벨)**:
- [x] 오케스트레이터 프롬프트에 `explore_parallel` 액션 추가 — LLM이 한 라운드에서 2-`MAX_PARALLEL`개의 독립 브랜치를 선택
- [x] `Promise.all` 기반 병렬 explorer 실행 (`orchestrator.ts`)
- [x] 병렬 보고 결과 수집 및 병합 (`reports.push(...parallelReports)`)
- [x] `MAX_PARALLEL = 3` 상수 (`prompts.ts`) — Phase 5에서 `--max-parallel`로 옵션화 예정
- [x] 루프 상한 이중화: `round ≤ MAX_PAGES` AND `exploredUrls.length < MAX_PAGES` (병렬 배치가 페이지 예산을 더 빨리 소진)
- [x] 같은 배치 내 URL/linkId 중복 차단, 무효 branch 전부 폴백 시 `continue`로 다음 라운드 유도
- [x] `orchestrator_plan` 로그에 `branches[]` 페이로드 추가, stderr 출력도 분기 처리

**남은 검토 항목**:
- [ ] 탐색 에이전트(explorer) 내부 자식 호출 병렬화는 별도 작업 (Phase 3에서는 오케스트레이터 레벨만 다룸)
- [ ] Playwright 브라우저 동시 실행 시 메모리 사용량 모니터링 — 실사용 케이스에서 관찰 필요

---

## 7. Phase 4: 지능적 종료 강화

**현재 상태**: 오케스트레이터 레벨에서 매 라운드 판단 (이미 구현됨). 다만 판단 기준이 단순함.

**목표**: 더 정교한 종료 판단. 탐색이 더 이상 가치 없음을 조기에 감지.

**구현 항목**:
- [ ] 탐색 이력에서 패턴 감지: 연속 N번 `found=false`이면 종료
- [ ] 유사도 기반 중복 감지: 이미 수집한 정보와 중복되는 내용만 계속 나오면 종료
- [ ] 목표 달성 신뢰도 점수: ExplorationReport에 `confidence` 필드 추가, 임계값 초과 시 조기 종료
- [ ] `ExplorationReport`에 `stopReason` 필드 추가 (why stopped: 정보충분/중복/관련없음/깊이초과)

---

## 8. Phase 5: 옵션 고도화

**목표**: 비용·속도 제어를 사용자가 CLI 옵션으로 조정할 수 있게 한다.

**구현 항목**:
- [ ] `--max-depth N` — 재귀 최대 깊이 (기본값: 2)
- [ ] `--max-pages N` — 전체 변환 페이지 수 상한 (기본값: 5)
- [ ] `--max-parallel N` — 최대 병렬 호출 수 (기본값: 3)
- [ ] `--timeout N` — 전체 탐색 타임아웃 초 (기본값: 없음)
- [ ] 이 값들을 `MissionBrief`에 포함시켜 에이전트가 자기 제한을 인식하게 함
- [ ] `SearchOptions` 타입에 위 필드들 추가

---

## 9. 미분류 / 나중에 검토

- **탐색 결과 캐싱**: 동일 URL 재방문 방지. 현재 `exploredUrls` 배열로 오케스트레이터 레벨에서만 방지. Phase 2 재귀에서 전역 visited set 필요.
- **검색 소스 라우팅**: 쿼리 의도에 따라 다른 소스 선택 (기술 질문 → Stack Overflow, 국내 뉴스 → Naver, 논문 → arXiv 등)
- **MCP 서버 포팅**: Phase 1 완료 후 검토. Claude 등 LLM 클라이언트에서 tool로 호출 가능하게.
- **탐색 세션 저장**: `--out` 옵션으로 변환된 페이지들을 디스크에 저장, 재실행 시 재사용

---

## 10. 주요 기술 결정 및 이유

| 결정 | 이유 |
|------|------|
| Google SERP에 `stealth=true` | Google이 headless Chromium 차단. 실제 Chrome 필요 |
| SERP 변환 시 `scroll=false` | Google SERP는 초기 로딩에 모든 결과 포함, 스크롤 불필요 |
| 탐색 페이지 변환 시 `scroll=true` | 콘텐츠 지연 로딩 대응 |
| LLM 응답 `temperature=0` | 에이전트 판단의 일관성·예측 가능성 확보 |
| 프롬프트에서 JSON 직접 요청 (tool use 미사용) | MVP 단순성. Phase 2 이후 OpenAI function calling 도입 검토 |
| SERP 합성 시 URL 인용 금지 | 실제 방문하지 않은 페이지 URL을 출처로 인용하면 신뢰도 문제 |
| logger가 메모리에 트리 누적 후 finalize 시 일괄 저장 | 에이전트 계층을 JSON 트리로 표현하기 위함. 단점: 크래시 시 로그 유실 |
| `extractSerpSnippets()` 결과를 루프 외부에서 1회만 계산 | 매 라운드 반복 계산 및 토큰 낭비 방지 |
