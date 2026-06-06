import { describe, expect, it } from "vitest";
import { convertPage } from "../src/index.js";

// 라이브 네트워크 테스트 — 실제 브라우저로 외부 URL을 연다. 기본 `npm test`에서는 건너뛴다.
// 실행: LIVE_HTTP_TEST=1 npx vitest run test/live-http-status.test.ts
//
// 목적: 검색 실행(researcher-2026-06-06T07-26-30) 당시 403 Forbidden으로 빈 페이지(본문 144/148자)가
// 들어왔던 g-enews 기사 URL을, 검색 파이프라인이 자식 페이지를 여는 것과 *동일한 변환 로직·옵션*
// (`convertPage` + `{ scroll: true, stealth: true }`)으로 다시 열어, HTTP 상태가 `ConvertResult.httpStatus`로
// 잡히는지 검증한다.
//
// 주의: g-enews의 차단은 요청 단위로 비결정적이라(같은 URL이라도 200/403이 번갈아 나옴), "반드시 403"을
// 단정하지 않는다. 대신 (1) 상태 코드가 캡처되는지와 (2) 4xx/5xx일 때 본문이 사실상 비어 있는지를 확인하고,
// 실제 상태·본문 길이는 콘솔에 출력해 관찰할 수 있게 한다.
const LIVE = !!process.env.LIVE_HTTP_TEST;

// 실행 당시 실제로 403(본문 144/148자)이었던 두 페이지.
const PREVIOUSLY_403_URLS = [
  "https://www.g-enews.com/article/Securities/2026/06/20260604204602140e250e8e188_1",
  "https://www.g-enews.com/article/Securities/2026/06/202606060648171751e250e8e188_1",
];

describe.runIf(LIVE)("live HTTP status capture on previously-403 pages", () => {
  for (const url of PREVIOUSLY_403_URLS) {
    it(
      `captures HTTP status for ${url}`,
      async () => {
        // 검색 파이프라인(researcher.ts)이 자식 시작 페이지를 여는 것과 동일한 옵션.
        const result = await convertPage(url, { scroll: true, stealth: true });
        const status = result.httpStatus;
        const bodyChars = result.markdown.length;
        // 실제 상태와 본문 길이를 관찰용으로 출력한다(403인지 200인지 매 실행 달라질 수 있음).
        console.log(`[live] ${url}\n  httpStatus=${status}  bodyChars=${bodyChars}`);

        // (1) 상태 코드가 캡처되는지 — 이번 변경의 핵심 메커니즘.
        expect(typeof status).toBe("number");

        // (2) 차단/오류(4xx·5xx)면 본문이 사실상 비어 있어야 한다(빈 페이지 신호).
        if (typeof status === "number" && status >= 400) {
          expect(bodyChars).toBeLessThan(500);
        }
      },
      60_000,
    );
  }
});
