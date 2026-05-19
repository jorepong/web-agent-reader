# llm-page-reader

웹 페이지를 LLM이 탐색하기 좋은 형식으로 변환하는 도구입니다.

HTML을 그대로 LLM에 주입하는 대신, 두 계층으로 분리합니다.

- **`page.md`**: 본문·메뉴·표·입력창·버튼을 마크다운으로 정리하고, 링크는 `[L1]`·`[L2]` 같은 ID로만 표시
- **`links.json` / `elements.json`**: 링크 ID와 실제 URL, 요소 ID와 상호작용 정보를 별도 저장

LLM은 `page.md`만 읽고 어떤 링크를 따라갈지 판단한 뒤, 필요한 URL만 꺼내 쓸 수 있습니다.

---

## 설치

```bash
npm install
npx playwright install chromium
npm run build
```

> Google 검색처럼 봇 탐지가 있는 사이트를 사용하려면 시스템에 Chrome이 설치되어 있어야 합니다 (`--stealth` 옵션).

---

## llm-page — 페이지 변환 CLI

### 페이지 변환

```bash
node dist/cli.js convert "https://example.com" --out ./out/example
```

`out/example/` 에 `page.md`, `page.json`, `links.json`, `elements.json` 생성.

옵션:

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--out <dir>` | `out` | 출력 디렉토리 |
| `--page-id <id>` | `P1` | 페이지 ID |
| `--no-scroll` | — | 자동 스크롤 비활성화 |
| `--max-scrolls <n>` | `15` | 최대 스크롤 횟수 |
| `--scroll-wait-ms <n>` | `800` | 스크롤 후 대기 시간(ms) |
| `--stable-rounds <n>` | `2` | 안정화 판단 반복 횟수 |
| `--stealth` | — | bot 탐지 우회 (Chrome 필요) |

### 링크 URL 조회

```bash
node dist/cli.js resolve P1 L23 --state ./out/example
# https://example.com/some/path
```

### 링크 열고 다음 페이지 변환

```bash
node dist/cli.js open P1 L23 --state ./out/example --out ./out/next --page-id P2
```

---

## llm-search — 에이전트 검색 CLI

LLM이 자율적으로 웹을 탐색하여 질문에 답변합니다.

```bash
node dist/search/cli.js --query "질문"
```

옵션:

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--query <str>` | 필수 | 검색할 질문 |
| `--model <str>` | `gpt-5.4-mini` | OpenAI 모델명 |
| `--debug` | — | 디버그 로그 저장 |
| `--log-dir <dir>` | `.` | 로그 저장 경로 |
| `--env <path>` | `.env` | 환경변수 파일 경로 |

OpenAI API 키가 필요합니다. 프로젝트 루트에 `.env` 파일을 생성하세요.

```
OPENAI_API_KEY=sk-...
```

### 디버그 모드

`--debug` 활성화 시 에이전트 실행 과정 전체를 JSON 파일로 저장합니다.

```bash
node dist/search/cli.js --query "질문" --debug --log-dir ./logs
```

터미널에는 실시간 상태가 출력되고, `logs/search-*.json`에 에이전트 계층 구조와 모든 LLM 호출 내역·토큰 사용량이 기록됩니다.

---

## 라이브러리 API

```typescript
import { convertPage, resolveLink, openLink, convertHtml } from "llm-page-reader";

// 페이지 변환
const result = await convertPage("https://example.com", {
  pageId: "P1",
  maxScrolls: 15,
  stealth: false,
});
// result.markdown — LLM에 전달할 마크다운
// result.links    — 링크 레지스트리
// result.elements — 요소 레지스트리
// result.page     — 구조화된 AST

// 링크 해석
const link = await resolveLink("./out/example", "P1", "L23");
// link.url — 실제 URL

// 링크 열고 다음 페이지 변환
const next = await openLink("./out/example", "P1", "L23", { pageId: "P2" });

// HTML 직접 변환 (브라우저 없이)
const result = convertHtml(htmlString, "https://source-url.com", { pageId: "P1" });
```

---

## 출력 파일 형식

### page.md

```markdown
# NAVER

- Page ID: P1
- Host: www.naver.com
- Links: 108

## Navigation

- 메일 [L1]
- 카페 [L2]

[input#I1: 검색어를 입력해 주세요.]
[button#B1: 검색]

## Main Content

...
```

### links.json

```json
{
  "pageId": "P1",
  "sourceUrl": "https://www.naver.com/",
  "links": {
    "L1": {
      "id": "L1",
      "text": "메일",
      "url": "https://mail.naver.com/",
      "kind": "external",
      "sourcePath": "div#header > a"
    }
  }
}
```

### elements.json

```json
{
  "pageId": "P1",
  "sourceUrl": "https://www.naver.com/",
  "elements": {
    "I1": { "id": "I1", "type": "input", "text": "검색어를 입력해 주세요.", "inputType": "text" },
    "B1": { "id": "B1", "type": "button", "text": "검색" },
    "S1": { "id": "S1", "type": "select", "options": ["10개 보기", "20개 보기"] }
  }
}
```

---

## 알려진 한계

- 복잡한 캘린더, 캐러셀, 탭 UI, 무한 스크롤은 완벽히 재현되지 않을 수 있습니다.
- 이미지 자체의 시각 정보는 추출하지 않습니다 (alt/title/캡션만 활용).
- 로그인 상태나 지역·개인화 설정에 따라 출력이 달라질 수 있습니다.
- 광고 제거는 보수적으로 동작하므로 일부 광고성 콘텐츠가 남을 수 있습니다.

---

## 테스트 및 빌드

```bash
npm run build   # TypeScript 컴파일
npm test        # Vitest 테스트 실행
```
