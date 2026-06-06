import { describe, expect, it } from "vitest";
import { convertHtml } from "../src/dom-normalizer.js";

const html = `<!doctype html>
<html>
  <head>
    <title>Fixture Page</title>
    <style>.x{color:red}</style>
    <script>window.nope = true</script>
  </head>
  <body>
    <header>
      <nav>
        <a href="/home">Home</a>
        <a href="/docs?very=long&query=string&that=should&not=appear">Docs</a>
        <a href="/docs?very=long&query=string&that=should&not=appear">Docs again</a>
      </nav>
    </header>
    <div id="shortcutArea" class="shortcut_area type_ad">
      <a href="/mail">Mail</a>
      <a href="/blog">Blog</a>
      <button>More shortcuts</button>
    </div>
    <div id="content-root" class="ad-layout">
      <article>
        <h1>Important Heading</h1>
        <h2>Section <a href="/edit/section">edit</a></h2>
        <p>Read the <a href="/guide">guide</a> before continuing.</p>
        <div class="sponsored-card"><a href="https://ad.example">Sponsored result</a></div>
        <img src="data:image/png;base64,AAAA" alt="tracking pixel">
        <img src="/pixel.png">
        <table>
          <tr><th>Name</th><th>URL</th></tr>
          <tr><td>Guide</td><td><a href="/guide">guide link</a></td></tr>
        </table>
        <form>
          <input type="text" placeholder="Search docs">
          <button>Submit</button>
        </form>
        <h2>광고</h2>
        <p>Buy this promoted product</p>
        <h2>Real Section</h2>
        <p>Real content remains.</p>
      </article>
      <article>
        <h2>Sibling News</h2>
        <p>This sibling article should not be dropped when the first article exists.</p>
      </article>
      <div class="commu-tail">
        <a href="/terms">Terms</a>
        <p>Copyright Example. All rights reserved.</p>
      </div>
    </div>
  </body>
</html>`;

describe("convertHtml", () => {
  it("keeps page structure while moving full URLs to the registry", () => {
    const result = convertHtml(html, "https://example.com/start", { pageId: "P9" });

    expect(result.markdown).toContain("## Navigation");
    expect(result.markdown).toContain("## Main Content");
    expect(result.markdown).toContain("Mail");
    expect(result.markdown).toContain("More shortcuts");
    expect(result.markdown).toContain("Important Heading");
    expect(result.markdown).toContain("Section");
    expect(result.markdown).not.toContain("edit [L");
    expect(result.markdown).toContain("guide [L");
    expect(result.markdown).toContain("| Name | URL |");
    expect(result.markdown).toMatch(/\[input#I\d+: Search docs\]/);
    expect(result.markdown).toMatch(/\[button#B\d+: Submit\]/);
    expect(result.markdown).toContain("Sibling News");
    expect(result.markdown).not.toContain("very=long");
    expect(result.markdown).not.toContain("base64");
    expect(result.markdown).not.toContain("Sponsored result");
    expect(result.markdown).not.toContain("Buy this promoted product");
    expect(result.markdown).toContain("Real content remains.");
    expect(result.markdown).toContain("## Footer");
    expect(result.markdown).toContain("Terms");
    expect(result.markdown).not.toContain("pixel.png");
    expect(result.links.pageId).toBe("P9");
    expect(Object.values(result.links.links).some((link) => link.url === "https://example.com/guide")).toBe(true);
  });

  it("deduplicates repeated links", () => {
    const result = convertHtml(html, "https://example.com/start", { pageId: "P1" });
    const docsLinks = Object.values(result.links.links).filter((link) => link.url.includes("/docs?"));
    expect(docsLinks).toHaveLength(1);
  });

  it("keeps links when a list contains non-li interactive children", () => {
    const result = convertHtml(
      `<!doctype html>
      <html>
        <body>
          <main>
            <ul>
              <li><a href="/career/job-detail?job_id=111">AIOps Platform Engineer</a></li>
              <a href="/career/job-detail?job_id=6677722003">
                <p>Cloud Engineer</p>
                <p>인프라 ・ 오픈스택 ・ 클라우드</p>
                <p>토스</p>
              </a>
            </ul>
          </main>
        </body>
      </html>`,
      "https://toss.im/career/jobs?main_category=Engineering",
      { pageId: "P1" },
    );

    expect(result.markdown).toContain("Cloud Engineer");
    expect(result.markdown).toContain("AIOps Platform Engineer");
    expect(Object.values(result.links.links).some((link) => link.url === "https://toss.im/career/job-detail?job_id=111")).toBe(true);
    expect(Object.values(result.links.links).some((link) => link.url === "https://toss.im/career/job-detail?job_id=6677722003")).toBe(true);
  });

  it("uses accessible labels for links without visible text", () => {
    const result = convertHtml(
      `<!doctype html>
      <html>
        <body>
          <main>
            <a href="/settings" aria-label="Settings"></a>
            <a href="/profile" title="Profile"></a>
          </main>
        </body>
      </html>`,
      "https://example.com/start",
      { pageId: "P1" },
    );

    expect(result.markdown).toContain("Settings [L1]");
    expect(result.markdown).toContain("Profile [L2]");
    expect(result.links.links.L1?.url).toBe("https://example.com/settings");
    expect(result.links.links.L2?.url).toBe("https://example.com/profile");
  });

  it("keeps compact card labels and separates nested text runs", () => {
    const result = convertHtml(
      `<!doctype html>
      <html>
        <body>
          <main>
            <div>
              <div>
                <span>6</span><span>개 계열사·</span><span>20</span><span>개의 포지션이 열려 있어요</span>
              </div>
              <div>
                <div>
                  <div><span>토스</span></div>
                  <span>간편하면서도 안전한, 금융을 넘어선 서비스를 만들어요.</span>
                </div>
                <div>
                  <div>3개 포지션</div>
                  <div>Product</div>
                  <div>Platform</div>
                  <div>Productivity</div>
                </div>
              </div>
              <div>
                <div>토스 서버의 조직 구조를 알려드려요</div>
                <div>토스의 Server Developer는 Product, Platform, Productivity 세 개의 Chapter로 나뉘어 일합니다.</div>
              </div>
              <div style="display:none">6개 계열사·20개의 포지션이 열려 있어요</div>
            </div>
          </main>
        </body>
      </html>`,
      "https://toss.im/career/job-detail?job_id=4071141003",
      { pageId: "P1" },
    );

    expect(result.markdown).toContain("6개 계열사·20개의 포지션이 열려 있어요");
    expect(result.markdown.match(/6개 계열사/g) ?? []).toHaveLength(1);
    expect(result.markdown).toContain("토스 간편하면서도 안전한, 금융을 넘어선 서비스를 만들어요.");
    expect(result.markdown).toContain("3개 포지션 Product Platform Productivity");
    expect(result.markdown).not.toContain("3개 포지션ProductPlatformProductivity");
    expect(result.markdown).not.toContain("6 개 계열사· 20 개의 포지션이 열려 있어요");
  });

  it("registers non-anchor repeated cards as activate links", () => {
    const card = (corp: string, title: string) =>
      `<div class="card">
         <h4>[${corp}] ${title}</h4>
         <div><span>Tech</span><span>경력</span></div>
       </div>`;
    const result = convertHtml(
      `<!doctype html>
      <html>
        <body>
          <main>
            <section class="list">
              ${card("NHN COMMERCE", "커머스 솔루션 QA 담당자")}
              ${card("NHN", "AI 전환 백엔드 개발")}
              ${card("NHN Cloud", "데이터 보안 기술 개발")}
              ${card("NHN PAYCO", "Java 서버 개발")}
            </section>
          </main>
        </body>
      </html>`,
      "https://careers.nhn.com/recruits",
      { pageId: "P1" },
    );

    // 카드 4개가 모두 activate 링크로 등록되고 [L#] 마커가 제목에 붙는다.
    const activate = Object.values(result.links.links).filter((l) => l.resolution === "activate");
    expect(activate).toHaveLength(4);
    expect(result.markdown).toMatch(/\[NHN COMMERCE\] 커머스 솔루션 QA 담당자 \[L\d+\]/);

    // locator는 보이는 텍스트 + 0부터 센 순번을 담는다.
    const first = activate.find((l) => l.text.includes("커머스 솔루션 QA"));
    expect(first?.locator?.index).toBe(0);
    expect(first?.locator?.text).toContain("커머스 솔루션 QA 담당자");
    expect(first?.url).toBe("");
    expect(first?.kind).toBe("action");
  });

  it("does not treat native control groups as activate links", () => {
    const result = convertHtml(
      `<!doctype html>
      <html>
        <body>
          <main>
            <div class="filters">
              <button>ALL</button>
              <button>Tech</button>
              <button>Business</button>
              <button>Design</button>
            </div>
          </main>
        </body>
      </html>`,
      "https://careers.nhn.com/recruits",
      { pageId: "P1" },
    );

    expect(Object.values(result.links.links).filter((l) => l.resolution === "activate")).toHaveLength(0);
  });

  it("captures bare text nodes that sit directly under a container (no <p> wrappers)", () => {
    // 일부 언론 CMS는 본문을 <p> 없이 텍스트+<br>로 쓰고, 깨진 마크업이 본문을 컨테이너
    // 직속으로 밀어낸다. 자식 요소만 재귀하면 본문이 통째로 누락된다.
    const result = convertHtml(
      `<!doctype html><html><body><main>
        <article>
          <div class="summury"><h2>소제목</h2></div>
          [서울=뉴시스] 김경택 기자 = 삼성전자와 SK하이닉스가 큰 폭의 급락세를 맞았다.<br /><br />
          5일 한국거래소에 따르면 삼성전자는 2만2500원(6.40%) 내린 32만9000원에 거래를 마쳤다.
          <a href="/related">관련 기사</a>
        </article>
      </main></body></html>`,
      "https://www.newsis.com/view/X",
      { pageId: "P1" },
    );
    expect(result.markdown).toContain("삼성전자와 SK하이닉스가 큰 폭의 급락세");
    expect(result.markdown).toContain("6.40%");
    // 소제목과 링크 같은 자식 블록도 그대로 유지된다.
    expect(result.markdown).toContain("소제목");
    expect(result.markdown).toMatch(/관련 기사 \[L\d+\]/);
  });

  it("preserves sign/direction from accessible text via [a11y: ...] marker", () => {
    const result = convertHtml(
      `<!doctype html><html><body><main>
        <p><span>478.82</span> <span class="icon down is_minus" aria-label="-5.54% 감소">5.54%</span></p>
      </main></body></html>`,
      "https://example.com",
      { pageId: "P1" },
    );
    // 보이는 텍스트(5.54%)와 접근성 텍스트(-5.54% 감소)가 다르면 표식으로 부호·방향을 보존한다.
    expect(result.markdown).toContain("[a11y: -5.54% 감소]");
  });

  it("does not add an a11y marker when accessible text matches visible text", () => {
    const result = convertHtml(
      `<!doctype html><html><body><main>
        <p>설명이 충분히 길어 main으로 분류되는 문단. <span aria-label="확인">확인</span></p>
      </main></body></html>`,
      "https://example.com",
      { pageId: "P1" },
    );
    expect(result.markdown).not.toContain("[a11y:");
  });

  it("surfaces role=text aria value nodes as a deduplicated Key Values region", () => {
    const ticker = `<li><div class="item" role="text"><b>코스피</b><p aria-label="8,160.59원, -5.54% 감소"><span aria-hidden="true">8,160.59</span><span aria-hidden="true">-5.54%</span></p></div></li>`;
    const result = convertHtml(
      `<!doctype html><html><body>
        <header><ul class="ticker">${ticker}${ticker}${ticker}</ul></header>
        <main><article><h1>지수</h1><p>지수 상세 표 본문이 충분히 길어 main 영역으로 분류되도록 채운 문단입니다. 부호가 클래스로만 표현된 표는 별도로 존재합니다.</p></article></main>
      </body></html>`,
      "https://stock.example.com",
      { pageId: "P1" },
    );
    const md = result.markdown;
    const start = md.indexOf("## Key Values");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = md.slice(start + 1);
    const end = rest.indexOf("\n## ");
    const section = end >= 0 ? rest.slice(0, end) : rest;
    expect(section).toContain("[a11y: 8,160.59원, -5.54% 감소]");
    // 티커가 3회 복제됐어도 Key Values 안에서는 한 번만 남는다.
    expect(section.split("코스피").length - 1).toBe(1);
  });
});
