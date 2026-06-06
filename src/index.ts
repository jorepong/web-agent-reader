import { chromium, type Browser, type Locator, type Page } from "playwright";
import { convertHtml } from "./dom-normalizer.js";
import { readLinkRegistry } from "./io.js";
import type { ActivateLocator, ConvertOptions, ConvertResult, LinkEntry, RenderMetadata, RenderSnapshot } from "./types.js";

export { convertHtml } from "./dom-normalizer.js";
export { readLinkRegistry, writeResult } from "./io.js";
export type * from "./types.js";

export async function convertPage(url: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const { browser, page } = await launchPage(options);
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    return await finalizePage(page, options, response?.status());
  } finally {
    await browser.close();
  }
}

// 비-앵커 작동 요소(activate 링크)를 해소한다.
// pageUrl을 새로 열고, locator로 그 요소를 찾아 클릭한 뒤 도착한 페이지를 변환한다.
// 부모의 살아있는 페이지를 건드리지 않으므로 병렬 해소에도 안전하다.
export async function activateLink(pageUrl: string, locator: ActivateLocator, options: ConvertOptions = {}): Promise<ConvertResult> {
  const { browser, page } = await launchPage(options);
  try {
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs ?? 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    // 지연 로딩되는 카드까지 나타나도록 한 번 안정화한 뒤 대상을 찾는다.
    await stabilizeByScrolling(page, options);

    const target = await locateActivateTarget(page, locator);
    if (!target) {
      throw new Error(`activate 대상을 찾지 못했습니다 (locator.text="${locator.text}")`);
    }

    const before = page.url();
    const popupPromise = page.context().waitForEvent("page", { timeout: 4_000 }).catch(() => null);
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.click({ timeout: 10_000 });

    // 새 탭으로 열렸으면 그 탭을, 아니면 같은 페이지의 SPA 라우팅을 기다린다.
    const popup = await popupPromise;
    const active = popup ?? page;
    if (!popup) {
      await page.waitForFunction((prev) => location.href !== prev, before, { timeout: 8_000 }).catch(() => undefined);
    }
    await active.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

    return await finalizePage(active, options);
  } finally {
    await browser.close();
  }
}

async function launchPage(options: ConvertOptions): Promise<{ browser: Browser; page: Page }> {
  const stealth = options.stealth ?? false;
  const browser = await chromium.launch({
    // headless:false + --headless=new 로 구형 headless-shell 대신 신형 헤드리스를 강제한다.
    // (headless:true면 Playwright가 자체 --headless를 주입해 신형 지정이 무력화될 수 있다.)
    // 신형 헤드리스는 일반 브라우저와 동작이 더 가까워 봇 탐지 난도가 높다.
    headless: false,
    args: [
      "--headless=new",
      ...(stealth ? ["--disable-blink-features=AutomationControlled"] : []),
    ],
    ...(stealth && { channel: "chrome" }),
  });
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
  return { browser, page };
}

async function finalizePage(page: Page, options: ConvertOptions, httpStatus?: number): Promise<ConvertResult> {
  const render = await stabilizeByScrolling(page, options);
  await removeNonRenderedElements(page);
  const html = await page.content();
  return { ...convertHtml(html, page.url(), { ...options, render }), httpStatus };
}

// 보이는 텍스트로 activate 대상을 찾는다. id가 렌더마다 바뀌어도 내용 기반이라 안정적이다.
async function locateActivateTarget(page: Page, locator: ActivateLocator): Promise<Locator | null> {
  const tryText = async (text: string): Promise<Locator | null> => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const matches = page.getByText(trimmed, { exact: false });
    const count = await matches.count().catch(() => 0);
    if (count === 0) return null;
    if (count === 1) return matches.first();
    return matches.nth(Math.min(Math.max(locator.index, 0), count - 1));
  };

  // 전체 라벨 → 실패 시 앞부분 일부(분할 렌더로 전체 매칭이 안 될 때)로 후퇴.
  return (await tryText(locator.text)) ?? (await tryText(locator.text.slice(0, 24)));
}

async function removeNonRenderedElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const element of Array.from(document.body?.querySelectorAll("*") ?? [])) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
        element.remove();
      }
    }
  });
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
  const registry = await readLinkRegistry(stateDir);
  if (registry.pageId !== pageId) {
    throw new Error(`Page ID mismatch: state has ${registry.pageId}, requested ${pageId}`);
  }
  const link = registry.links[linkId];
  if (!link) {
    throw new Error(`Link not found: ${linkId}`);
  }
  // activate 링크는 URL이 없으므로, 카드가 있던 표면 페이지를 다시 열어 locator로 클릭해 해소한다.
  if (link.resolution === "activate") {
    if (!link.locator) throw new Error(`Activate link ${linkId} has no locator.`);
    return activateLink(registry.sourceUrl, link.locator, options);
  }
  if (!link.url) throw new Error(`Link ${linkId} has no URL to open.`);
  return convertPage(link.url, options);
}
