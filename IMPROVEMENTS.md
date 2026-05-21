# 개선점 후보

지난 평가 사이클(페이커 케이스 3회 실행 분석, 아키텍처 리뷰, 토스 채용 시나리오 토론)에서 도출된 개선 후보 목록.

**전제**: 여기 적힌 항목들은 **확실한 버그/문제가 아니라 잠재적 개선점**이다. 현재 동작은 모두 의도된 범위 안에 있다. 적용 여부와 우선순위는 프로젝트 정체성(학습용 / niche 도구 / 라이브러리)에 따라 달라질 수 있다.

우선순위 표기: ★★★ (큰 임팩트) / ★★ (의미 있는 임팩트) / ★ (정리 차원)

각 항목은 TODO.md의 Phase 로드맵과는 별개의 탐색적 후보다. Phase 5 등 정식 진행 항목은 TODO.md를 참고할 것.

---

## 1. 비용 / 효율

- [ ] **★★★ Explorer 트리 간 visited URL 공유**
  - 현재 `visitedUrls`는 한 explorer 트리 내에서만 공유되어, 다른 라운드의 explorer 트리가 동일 URL을 다시 변환하는 일이 생긴다 (페이커 케이스에서 SK_Telecom_T1 페이지가 3회 변환됨).
  - `runSearch` 안에서 단일 `Set<string>`을 만들어 모든 `runExplorationAgent` 호출에 주입하면 한 쿼리 내 중복 변환을 0회로 줄일 수 있다.
  - 기대 효과: 페이지 변환 비용 + 그 페이지를 분석하는 LLM 토큰이 같이 절감. 페이커 케이스 기준 약 30% 토큰 절감 추정.

- [ ] **★★★ 부모 explorer 컨텍스트의 페이지 본문 슬림화**
  - 현재 부모 explorer의 첫 user 메시지는 raw 페이지 본문(수만~10만 자) 그대로다. 첫 자식 호출 후에는 이 본문이 "링크 선택의 근거"로만 쓰이는데, 매 라운드 prefix에 통째로 남아 누적 토큰이 커진다.
  - 첫 자식이 보고하고 돌아오면 본문을 "이 페이지의 링크 인덱스(섹션별 [L3] 형식 목록) + 1~2문장 페이지 개요"로 압축하는 방안.
  - 기대 효과: explorer 라운드 N에서의 prefix 토큰이 페이지 크기와 무관하게 일정 수준으로 유지됨. 토스처럼 50KB+ 페이지가 등장할 때 효과 큼.

- [ ] **★★ Explorer 레벨 `explore_parallel` 도입**
  - 현재 explorer는 자식 호출을 직렬로만 한다. 토스 채용처럼 "10개 position 페이지를 자식들이 각자 검증" 같은 fan-out 시나리오에 부적합.
  - 오케스트레이터에 도입된 `explore_parallel`을 explorer 프롬프트에도 반영. 단, prefix cache 키 안정성을 위해 자식 보고를 결정적 순서(예: linkId 정렬)로 append.
  - 기대 효과: list 검증 시나리오의 wall-clock 시간 1/N로 단축.

- [ ] **★★ 동일 (engine, query, page) SERP 결과 세션 내 캐싱**
  - 현재는 같은 (engine, query, page) 재검색을 차단하지만, 다른 쿼리/엔진 조합으로 같은 페이지에 도달하는 케이스는 캐시 못 한다.
  - URL 단위 SERP 캐시: 한 세션 내 동일 SERP URL이면 변환 결과 재사용.

---

## 2. 탐색 품질 / 정확성

- [ ] **★★ Partial 보고에 대한 후속 시도 상한**
  - (D) 게이트가 partial 보고를 끝까지 추적하도록 유도하지만, 같은 missingInfo 항목으로 라운드가 무한히 늘어날 수 있다 (페이커 케이스의 "Burdol 토끼굴" — 3 라운드 소비).
  - 룰 후보: "동일 missingInfo 키워드에 대한 후속 시도는 최대 2회. 그 후엔 partial 그대로 done 가능하되 답변에 명시적으로 불완전성 언급."
  - 기대 효과: 사소한 엔티티 검증에 라운드 예산을 과하게 쓰는 패턴 차단.

- [ ] **★★ 엔티티 리브랜딩/분할 의심 가드 (이전 논의의 (E) 항목)**
  - 토스 케이스 / T1 리브랜딩 케이스처럼, 엔티티가 시기에 따라 다른 페이지로 분할/리브랜딩되는 경우 한 페이지만 보면 시간축 누락이 생긴다.
  - 룰 후보: "History-style 질문은 done 전에 엔티티가 리브랜딩되거나 시기별로 분리되어 있을 가능성을 점검하라. 의심되면 분리된 페이지를 모두 확인한다."
  - 기대 효과: T1 / SKT T1 분리 같은 일반적인 시간축 단절을 사전에 메움.

- [ ] **★ `site:` 연산자 명시적 권장**
  - 페이커 케이스에서 LLM은 자체적으로 `site:lol.fandom.com`을 채택했지만, 누가 보장해주는 동작은 아니다.
  - 프롬프트에 "권위 도메인이 명확한 경우 `site:` 연산자로 좁히는 것을 고려하라"를 명시.
  - 기대 효과: 권위 출처가 분명한 도메인 질문에서 SERP 노이즈 절감.

- [ ] **★ Query 시기 한정 가드**
  - "이번 주에 ~" 같은 시간 한정 질문에서, LLM이 자동으로 `after:YYYY-MM-DD` 같은 Google 연산자를 쓰거나 쿼리에 연도/날짜를 박는 패턴을 유도.

---

## 3. 신뢰성 / 안정성

- [x] **★★ 행동 호출을 OpenAI Structured Outputs로 마이그레이션** *(json_schema strict 모드로 적용 완료)*
  - 5종 오케스트레이터 액션과 2종 탐색 에이전트 액션을 JSON Schema (anyOf discriminated union) 로 정의.
  - `complete()`에 `responseSchema` 옵션을 추가하고 `response_format: { type: "json_schema", json_schema: { strict: true, ... } }` 로 호출.
  - 프롬프트에서 "Respond with JSON only..." 예시 블록과 행동별 JSON 형태 견본 제거 → 라운드당 프롬프트 토큰 절감.
  - 효과: 파싱 실패 0, JSON 중복 출력 자연 해소, 라운드 비용 절감.

- [x] **★ 알 수 없는 action / 파싱 실패 로깅 강화** *(거부 경로 구조화 작업으로 해소됨)*
  - 모든 거부 경로가 `orchestrator_plan` 이벤트(`action: "rejected"`)로 로깅되며, JSON 파싱 실패 케이스는 `rawResponsePreview` 필드에 raw 응답 앞 200자를 함께 기록.

- [x] **★ LLM 중복 출력 정규화** *(Structured Outputs 적용으로 해소됨)*
  - 스키마가 단일 객체 응답을 강제하므로 한 응답 안에 같은 JSON이 반복되는 GPT-5 reasoning의 출력 패턴이 발생하지 않게 됨.
  - 결과적으로 messages에 누적되는 raw 응답도 정규화된 단일 JSON.

- [ ] **★ 하드 리밋 임박 경고 메시지 주입**
  - 페이커 케이스가 11/12 라운드로 종료 — 하드 리밋 한 칸 차이로 incomplete 답변 위험.
  - 라운드 ≥ MAX_ROUNDS-3 부터 user 메시지에 "남은 N 라운드. 미해결 항목은 partial 처리 권장" 안내.
  - 기대 효과: 라운드 끝에서 우선순위 압박이 명시적으로 들어가 done 의사결정이 합리화됨.

- [ ] **★ MAX_DEPTH 의미 재검토**
  - 토스 케이스(Google → careers landing → positions list → individual position = depth 3)에서 현재 `MAX_DEPTH=2`는 빠듯하다.
  - 옵션 1: depth 한도를 4~5로 풀고, 비용 한도는 누적 페이지 수/토큰 수로 관리.
  - 옵션 2: 그대로 두되 더 깊은 트리를 요구하는 시나리오는 의도적으로 막는 정책.

---

## 4. 측정 / 평가

- [ ] **★★★ 평가 하네스 도입**
  - 현재는 프롬프트 수정 후 한 쿼리로 돌려보고 답변을 살펴보는 식의 ad-hoc 검증.
  - 다양한 형태(단일 사실 / list / history / 시기 한정 / 한국어 도메인 / 영문 기술 등) 10~30개 질문 셋을 만들고, 각 질문에 "핵심 항목 포함 여부" 같은 채점 기준 정의.
  - LLM-as-judge 자동 채점으로 회귀 추적 가능. Phase 단위로 점수 추이 비교.
  - 기대 효과: 어떤 프롬프트 변경이 어떤 시나리오를 개선/악화시켰는지 정량 측정. 가드 추가/삭제의 임팩트가 보임.

- [ ] **★★ 라운드별/단계별 토큰 집계 노출**
  - 현재 explorer 보고에는 누적 토큰이 있지만 오케스트레이터 라운드별 누적은 별도 집계 없음.
  - 라운드 종료마다 cumulative tokens를 stderr/log에 출력. SERP 라운드, explore 라운드, partial 후속 라운드별 비용 패턴이 보이도록.

- [ ] **★★ Logger payload의 mutable 객체 스냅샷화** *(이번 평가에서 추가)*
  - `logger.log(kind, agentId, payload)`가 payload를 그대로 보관(`agent.events.push(...)`)하므로, `messages` 같은 mutable 배열은 레퍼런스로 저장된다. `finalize()` 시점에 JSON.stringify되면 그때의 *최종* 상태가 직렬화된다.
  - 결과: 모든 `llm_request` 이벤트의 messages 필드가 세션 종료 시점의 동일한 messages 배열을 보여줌. 특정 라운드에 LLM이 본 입력을 사후 분석 불가.
  - 페이커 케이스 round 5/6의 messages를 비교하려 했을 때 둘 다 round 11까지 포함된 같은 상태로 직렬화된 게 이 문제.
  - 구현: `logger.ts`의 `log()` 메서드에서 `payload`를 `structuredClone(payload)` 또는 `JSON.parse(JSON.stringify(payload))`로 deep copy 후 저장.
  - 트레이드오프: 로그 메모리 사용량 증가 (현재는 reference만 보관 → 거의 0). 매 라운드 messages가 커지면 그 시점의 스냅샷이 각각 저장됨.
  - 완화책: `messages`처럼 큰 mutable만 선택적으로 스냅샷(예: 추가 옵션 `{ snapshotKeys: ["messages"] }`)으로 보관하거나, raw 페이지 본문 같은 거대 payload는 hash로 저장하고 raw는 별도 파일.

- [ ] **★ 답변에 신뢰도 메타데이터 첨부**
  - 최종 답변과 함께 "방문 페이지 N개, useful report M개, 미해결 missingInfo K개" 같은 요약을 사용자에게 표시.
  - 기대 효과: 사용자가 답변의 한계를 즉시 판단 가능.

---

## 5. 구조 / 패키징

- [ ] **★★ 변환기(`llm-page-reader`) 패키지 분리**
  - 현재는 한 npm 패키지에 변환기와 검색 도구가 함께 있다. 변환기는 검색 도구보다 일반화 가능성이 큰 자산(RAG 인덱싱, 브라우저 자동화 등에 재사용 가능).
  - `llm-page-reader-core` / `llm-search` 두 패키지로 분리. 검색 도구가 변환기를 디펜던시로 끌어 쓰는 구조.
  - 기대 효과: 변환기의 외부 사용 진입 장벽 낮춤. 검색 도구의 코드 응집도 향상.

- [ ] **★ 프롬프트의 누적된 가드 룰 정리**
  - 가드(A)(B)(D)가 차례로 추가되며 `buildOrchestratorInitialPrompt`의 "When to choose done" 섹션이 길어지는 중. 새 가드를 추가하기 전에 기존 가드 중 효과가 작거나 다른 가드로 흡수 가능한 것은 정리.
  - 평가 하네스가 있어야 안전하게 진행 가능 (4번 항목과 묶임).

- [ ] **★ 검색 엔진 어댑터 확장 지점 정리**
  - `search-engines.ts`에 DuckDuckGo / arXiv / Stack Overflow / GitHub Code Search 등 도메인 특화 소스를 추가할 때의 인터페이스 명확화.
  - 현재 `buildSerpUrl(engine, query, page)` 시그니처가 단순해서 좋지만, 특화 소스가 늘어나면 메타데이터(엔진별 추천 사용 케이스, 결과 마크다운 후처리 차이)가 따라 붙을 가능성.

---

## 적용 순서 제안

평가 하네스(4번 ★★★)와 URL 공유(1번 ★★★)를 가장 먼저 손대는 게 가장 큰 레버리지. 그 이후엔 측정 결과를 보면서 우선순위를 재조정.

1. **평가 하네스** — 이후 어떤 변경도 회귀 측정 가능해짐
2. **Logger payload 스냅샷화** — 평가 하네스가 라운드별 입력을 비교 가능하려면 필수
3. **Explorer 트리 간 visited URL 공유** — 비용 폭발의 가장 큰 누수 차단
4. **부모 explorer 컨텍스트 슬림화** — 토스 같은 큰 페이지 시나리오 대비
5. 이후 평가 하네스 점수 추이를 보고 결정

---

## 완료 이력

- 2026-05-21: **거부 경로 구조화 로깅** — 모든 거부 경로에서 `orchestrator_plan` 이벤트(`action: "rejected"`, `requestedAction`, `reason`, 부가 context)를 emit하도록 `orchestrator.ts` / `logger.ts` 수정. 라운드의 LLM 호출 결과가 거부되더라도 디버그 로그에 흔적이 남는다.
- 2026-05-21: **Structured Outputs 마이그레이션** — 오케스트레이터/탐색 에이전트 응답을 JSON Schema (json_schema strict 모드) 로 강제. 프롬프트의 JSON 예시/형식 안내 블록 제거. `parseJsonResponse`의 관대한 파싱은 방어 레이어로 유지. 부작용으로 LLM 중복 JSON 출력과 파싱 실패가 해소되고 프롬프트 토큰이 줄어든다.
