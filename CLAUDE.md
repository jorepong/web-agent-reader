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
  logger.ts         — 디버그 로거 (JSON 트리 구조, finalize()로 일괄 저장)
  openai-client.ts  — OpenAI SDK 래퍼 (자동 로깅 내장)
  prompts.ts        — 모든 LLM 프롬프트 템플릿
  explorer.ts       — 탐색 에이전트 (runExplorationAgent)
  orchestrator.ts   — 오케스트레이터 (runSearch)
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
MissionBrief    — 상위 → 하위 에이전트 지시 (agentId, parentAgentId, goal, url, parentGoal)
ExplorationReport — 하위 → 상위 에이전트 보고 (url, found, summary, relevantExcerpts, tokenUsage)
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

`runSearch(options)` 흐름:
1. [LLM] 검색 쿼리 생성 (한국어 → 영어 등 최적화)
2. `convertPage(googleUrl, { scroll: false, stealth: true })` — SERP 변환
3. `extractSerpSnippets(markdown)` — Main Content 스니펫만 추출 (루프 전 1회 실행)
4. 루프 (최대 MAX_PAGES=5):
   - [LLM] 판단: explore(linkId 선택) or done
   - explore → `runExplorationAgent(brief)` 실행 후 보고 수신
5. [LLM] 수집된 보고로 최종 답변 합성

**SERP 기반 합성 특이 동작**: SERP에서 충분한 정보를 얻으면 탐색 없이 즉시 합성.
이 경우 `serpOnly=true`로 합성 프롬프트에 전달 → URL 인용 금지 (실제 방문 안 함).

`extractSerpSnippets()` 제거 대상: Navigation/Footer/Aside 섹션, `[LN]` 링크 ID, `Translate this page` / `Read more` / `Missing:` 텍스트, 섹션 헤더.

**주의**: `[LN]` 링크 ID는 탐색 에이전트 페이지 마크다운에서 제거하면 안 됨.
Phase 2 재귀 탐색에서 에이전트가 어떤 링크로 내려갈지 결정할 때 필요.

---

## 디버그 로그 구조

`--debug` 활성화 시 에이전트 계층을 반영한 JSON 트리 파일 생성:

```json
{
  "agentId": "orchestrator",
  "depth": 0,
  "events": [
    { "kind": "llm_request", "payload": { "callId": "...", "messages": [...] } },
    { "kind": "llm_response", "payload": { "callId": "...", "response": "...", "tokenUsage": {...} } },
    { "kind": "orchestrator_plan", "payload": { "round": 1, "action": "explore", "url": "..." } }
  ],
  "children": [
    {
      "agentId": "explorer-1",
      "depth": 1,
      "events": [...],
      "children": []
    }
  ]
}
```

`logger.finalize()`는 프로세스 종료 전(성공/실패 모두) 반드시 호출해야 함. `cli.ts`의 try/catch 양쪽에서 호출.

---

## 코딩 컨벤션

- 새 파일은 기존 패턴 그대로 따름
- 에러 처리: 탐색 에이전트는 크래시 없이 폴백 리포트 반환 (found: false)
- LLM 응답 JSON 파싱은 항상 try/catch로 감쌈
- 싱글톤/전역 상태 금지 — logger, client 인스턴스는 명시적으로 주입
- 프롬프트 변경은 모두 `prompts.ts`에서만

---

## 로드맵 요약

상세 내용은 `TODO.md` 참고.

| Phase | 상태 | 내용 |
|-------|------|------|
| 1 | 완료 | 단일 깊이 직렬 탐색 CLI |
| 2 | 미구현 | 탐색 에이전트 재귀 탐색 |
| 3 | 미구현 | 병렬 에이전트 호출 |
| 4 | 미구현 | 지능적 종료 강화 |
| 5 | 미구현 | CLI 옵션 고도화 |

**다음 구현 예정**: 탐색 에이전트 페이지 마크다운 토큰 효율화 (Navigation/Footer 섹션 및 UI 컨트롤 제거, `[LN]` 링크 ID는 유지)
