# TODO.md — 로드맵과 개선 후보

현재 작업 후보와 개선 아이디어를 한 곳에서 관리합니다.

---

## 현재 상태 요약

`llm-search`는 v1과 v2가 공존합니다. 프로젝트 루트의 `llm-search.config.json` 기본 버전은 `v2`입니다.

v1은 오케스트레이터와 탐색 에이전트를 분리한 구조입니다. 오케스트레이터는 `search`, `paginate`, `explore`, `explore_parallel`, `done` 행동 루프를 수행하고, explorer는 시작 URL 하나를 깊게 읽으며 필요하면 페이지 내부 링크를 따라 자식 explorer를 직렬 호출합니다.

v2는 단일 재귀 `Researcher` 구조입니다. 루트, URL 없는 서브 리서처, 시작 페이지가 있는 리서처가 모두 같은 함수(`runResearcher`)로 실행되며, 상태별 스키마가 `search`, `paginate`, `read_sections`, `delegate`, `delegate_parallel`, `done` 중 가능한 행동만 허용합니다.

현재 검증 상태:

- `npm run build` 통과
- `npm test` 통과
- v2 테스트 파일: `test/researcher-v2.test.ts`

---

## v1 로드맵

| Phase | 상태 | 내용 |
|---|---|---|
| 1 | 완료 | 단일 깊이 직렬 탐색 CLI |
| 2 | 완료 | 탐색 에이전트 아젠틱 루프 |
| 3 | 완료 | 오케스트레이터 레벨 병렬 에이전트 호출 (`explore_parallel`) |
| 4 | 완료 | 오케스트레이터 자율 행동 루프 (`search/paginate/explore/explore_parallel/done`) |
| 5 | 일부 완료 | CLI 옵션 고도화. config 기반 한도 조정과 v1/v2 선택은 구현됨. 추가 UX 옵션은 남아 있음. |

v1은 안정 구조로 보존합니다. 구조 설명은 `ARCHITECTURE.md`가 v1 기준 명세입니다.

---

## v2 로드맵

| 단계 | 상태 | 내용 |
|---|---|---|
| 설계 문서화 | 완료 | `RESEARCHER_V2.md` 작성 |
| 핵심 구조 구현 | 완료 | `types/budget/sections/prompts/researcher/logger/cli` |
| 통합 CLI 연결 | 완료 | `llm-search`, `llm-search-v1`, `llm-search-v2`, `--version`, config 지원 |
| 자동 테스트 | 완료 | `test/researcher-v2.test.ts` |
| 긴 페이지 섹션 읽기 | 완료 | 섹션 선택 + `read_sections` 액션 |
| 후보 ID 안정화 | 완료 | `[L*]`를 `[C*]` 후보 ID로 재매핑하고 스키마 enum으로 제한 |
| v1 deprecation 결정 | 대기 | v2 실사용 안정화 후 결정 |

현재 설정 파일 기준 v2 한도는 `maxRounds=30`, `maxSearches=20`, `maxExplores=20`, `maxParallel=3`, `maxDepth=5`, `maxChildCallsPerAgent=3`입니다. 설정 파일이 없을 때 코드 기본값은 `20/8/10/3/3/3`입니다.

---

## 우선순위 높은 작업

### 1. 평가 하네스 도입

다양한 질문 셋을 만들고 핵심 항목 포함 여부를 자동 채점합니다. 단일 사실, list/history, 시기 한정, 한국어 도메인, 영문 기술 질문을 포함한 10~30개 정도의 회귀 세트가 필요합니다.

효과: 프롬프트와 구조 변경이 어떤 시나리오를 개선하거나 악화시키는지 정량적으로 볼 수 있습니다.

### 2. Logger payload 스냅샷화

현재 logger는 messages 배열 자체는 새 배열로 넘기지만 payload 전체를 깊게 스냅샷하지 않습니다. 큰 mutable payload를 어느 시점의 입력으로 정확히 보존하려면 선택적 deep copy나 별도 raw 파일 저장 전략이 필요합니다.

효과: 라운드별 LLM 입력을 사후 분석하기 쉬워집니다.

### 3. v2 자식 책임 경계 평가

v2는 시작 페이지가 있는 리서처의 첫 라운드 search를 스키마로 차단합니다. 그래도 이후 라운드에서 search가 열릴 수 있으므로, “시작 페이지와 연결 문맥을 확인하고 안 되면 부모에게 보고”하는 책임 경계가 실제로 지켜지는지 평가해야 합니다.

후보 작업:

- 같은 리서처가 연속 search만 반복할 때 `search/paginate`를 잠시 닫는 saturation 가드
- dead page 감지 후 빠른 `COVERAGE: none` 유도
- 자식 보고에서 `NEXT_CANDIDATES`를 더 안정적으로 활용하는 부모 프롬프트 보강

### 4. v1 Explorer 트리 간 URL 공유

v1은 오케스트레이터 레벨 `exploredUrls`와 각 explorer 트리 내부 `visitedUrls`가 분리되어 있습니다. 서로 다른 explorer 트리에서 같은 URL을 다시 변환할 수 있습니다.

후보 구현: `runSearch` 안에서 단일 `Set<string>`을 만들고 모든 `runExplorationAgent` 호출에 주입합니다.

### 5. 부모 explorer 컨텍스트 슬림화

v1 explorer는 첫 user 메시지에 raw 페이지 본문을 크게 넣고, 자식 호출 후에도 그 본문이 prefix에 남습니다. 첫 자식 보고 이후에는 페이지 개요와 링크 인덱스로 압축하는 방안을 검토합니다.

효과: 큰 페이지에서 explorer 라운드 비용을 줄일 수 있습니다.

---

## 품질 / 정확성 개선 후보

- Partial 보고 후속 시도 상한: 같은 missingInfo를 무한히 추적하지 않도록 동일 갭에 대한 후속 시도를 제한합니다.
- 엔티티 리브랜딩/분할 의심 가드: history/list 질문에서 시기별 페이지 분리나 리브랜딩 가능성을 점검합니다.
- `site:` 연산자 권장: 권위 도메인이 명확한 경우 검색 쿼리를 좁히도록 유도합니다.
- Query 시기 한정 가드: “이번 주”, “최근”, 특정 연도 질문에서 날짜·연도·검색 연산자 사용을 더 일관되게 유도합니다.
- 답변 신뢰도 메타데이터: 방문 페이지 수, useful report 수, unresolved gap 수를 최종 답변 주변에 표시할지 검토합니다.

---

## 효율 / 안정성 개선 후보

- v1 explorer 레벨 `explore_parallel`: v1 explorer 내부 자식 호출은 현재 직렬입니다. fan-out 검증 시나리오에서 병렬화 가능성이 있습니다.
- 동일 SERP URL 세션 캐싱: 같은 URL 변환 결과를 한 세션 안에서 재사용합니다.
- 하드 리밋 임박 경고 메시지: 남은 라운드가 적을 때 우선순위 압박을 명시합니다.
- MAX_DEPTH 정책 재검토: v1의 `maxDepth=2`는 깊은 네비게이션에 빠듯합니다. v2 설정은 현재 `maxDepth=5`입니다.

---

## 구조 / 패키징 후보

- 변환기와 검색 도구 패키지 분리: `llm-page-reader-core`와 `llm-search`로 나누는 방안입니다.
- 검색 엔진 어댑터 확장: DuckDuckGo, arXiv, Stack Overflow, GitHub 등 특화 소스를 추가할 때의 인터페이스를 정리합니다.
- 프롬프트 가드 정리: v1/v2 프롬프트에 누적된 가드가 많아졌으므로 평가 하네스 이후 효과가 낮은 규칙을 정리합니다.
- MCP 서버 노출: v2의 자연어 `research(goal)` 인터페이스는 외부 도구화에 적합합니다.

---

## 완료 이력

- 2026-05-21: v1 거부 경로 구조화 로깅. 모든 거부 경로가 `orchestrator_plan` 이벤트(`action: "rejected"`)로 남도록 정리.
- 2026-05-21: OpenAI Structured Outputs 마이그레이션. v1 오케스트레이터와 explorer 액션을 JSON Schema strict 모드로 강제.
- 2026-05-24: v2 Researcher 구조 구현. `SharedBudget`, 단일 재귀 `runResearcher`, `V2Logger`, 통합 CLI 연결.
- 2026-05-24: v2 섹션 읽기와 후보 ID 안정화. 긴 페이지 섹션 선택, `read_sections`, `[C*]` 후보 ID 스키마 제한, 관련 테스트 추가.
