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
});
