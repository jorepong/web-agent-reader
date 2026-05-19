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
});
