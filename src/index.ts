import { chromium, type Page } from "playwright";
import { convertHtml } from "./dom-normalizer.js";
import { readLinkRegistry } from "./io.js";
import type { ConvertOptions, ConvertResult, LinkEntry, RenderMetadata, RenderSnapshot } from "./types.js";

export { convertHtml } from "./dom-normalizer.js";
export { readLinkRegistry, writeResult } from "./io.js";
export type * from "./types.js";

export async function convertPage(url: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const stealth = options.stealth ?? false;
  const browser = await chromium.launch({
    headless: true,
    ...(stealth && {
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
    }),
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ko-KR",
      ...(stealth && {
        extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7" },
      }),
    });
    if (stealth) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    }
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const render = await stabilizeByScrolling(page, options);
    const html = await page.content();
    return convertHtml(html, page.url(), { ...options, render });
  } finally {
    await browser.close();
  }
}

async function stabilizeByScrolling(page: Page, options: ConvertOptions): Promise<RenderMetadata> {
  const enabled = options.scroll ?? true;
  const before = await snapshot(page);
  if (!enabled) {
    return { scrolled: false, scrolls: 0, stoppedBy: "disabled", before, after: before };
  }

  const maxScrolls = options.maxScrolls ?? 15;
  const scrollWaitMs = options.scrollWaitMs ?? 800;
  const stopAfterStableRounds = options.stopAfterStableRounds ?? 2;
  let previous = before;
  let after = before;
  let stableRounds = 0;
  let scrolls = 0;
  let stoppedBy: RenderMetadata["stoppedBy"] = "max-scrolls";

  for (let index = 0; index < maxScrolls; index++) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 2.5, 1_600));
    });
    scrolls++;
    await page.waitForTimeout(scrollWaitMs);
    after = await snapshot(page);

    const changed =
      after.height > previous.height + 100 ||
      after.textLength > previous.textLength + 300 ||
      after.linkCount > previous.linkCount;
    const nearBottom = after.distanceToBottom <= 80;

    if (changed || !nearBottom) {
      stableRounds = 0;
    } else {
      stableRounds++;
    }

    if (stableRounds >= stopAfterStableRounds) {
      stoppedBy = "stable";
      break;
    }

    previous = after;
  }

  return { scrolled: scrolls > 0, scrolls, stoppedBy, before, after };
}

async function snapshot(page: Page): Promise<RenderSnapshot> {
  return page.evaluate(() => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    return {
      height,
      scrollY,
      viewportHeight,
      distanceToBottom: Math.max(0, height - scrollY - viewportHeight),
      textLength: document.body?.innerText?.length ?? 0,
      linkCount: document.querySelectorAll("a[href]").length,
    };
  });
}

export async function resolveLink(stateDir: string, pageId: string, linkId: string): Promise<LinkEntry> {
  const registry = await readLinkRegistry(stateDir);
  if (registry.pageId !== pageId) {
    throw new Error(`Page ID mismatch: state has ${registry.pageId}, requested ${pageId}`);
  }
  const link = registry.links[linkId];
  if (!link) {
    throw new Error(`Link not found: ${linkId}`);
  }
  return link;
}

export async function openLink(stateDir: string, pageId: string, linkId: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const link = await resolveLink(stateDir, pageId, linkId);
  return convertPage(link.url, options);
}
