import { parseHTML } from "linkedom";
import { ElementRegistryBuilder } from "./element-registry.js";
import { compact, LinkRegistryBuilder } from "./link-registry.js";
import type {
  ContentBlock,
  ConvertOptions,
  ConvertResult,
  PageAst,
  RegionBlock,
  RegionRole,
  TableBlock,
} from "./types.js";

const DEFAULTS = {
  maxTableRows: 24,
  maxTableColumns: 8,
  maxCellLength: 160,
};

export function convertHtml(html: string, sourceUrl: string, options: ConvertOptions = {}): ConvertResult {
  const pageId = options.pageId ?? "P1";
  const settings = { ...DEFAULTS, ...options };
  const { document } = parseHTML(html);
  cleanupDocument(document);

  const registry = new LinkRegistryBuilder(pageId, sourceUrl);
  const elementRegistry = new ElementRegistryBuilder(pageId, sourceUrl);
  const title = compact(document.querySelector("title")?.textContent ?? document.querySelector("h1")?.textContent ?? sourceUrl);
  const regions = buildRegions(document, registry, elementRegistry, settings);
  const links = registry.build();
  const elements = elementRegistry.build();
  const page: PageAst = {
    pageId,
    title,
    urlHost: new URL(sourceUrl).host,
    sourceUrl,
    generatedAt: new Date().toISOString(),
    blocks: regions,
    stats: {
      linkCount: Object.keys(links.links).length,
      elementCount: Object.keys(elements.elements).length,
      blockCount: countBlocks(regions),
    },
    render: options.render,
  };

  return {
    page,
    markdown: renderPage(page),
    links,
    elements,
  };
}

function cleanupDocument(document: Document): void {
  const selectors = [
    "script",
    "style",
    "meta",
    "link",
    "noscript",
    "template",
    "svg",
    "[hidden]",
    'iframe[src*="ads"]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    '[class*="advert"]',
    '[id*="advert"]',
    '[class*="sponsor"]',
    '[id*="sponsor"]',
    '[class*="promotion"]',
    '[id*="promotion"]',
    '[aria-label*="advertisement" i]',
    '[aria-label*="광고"]',
    'img[alt^="[광고]"]',
  ];
  document.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());
  document.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") ?? "";
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) el.remove();
  });
  document.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (/^data:/i.test(src)) img.remove();
  });
  removeExplicitAdSections(document);
}

function removeExplicitAdSections(document: Document): void {
  Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).forEach((heading) => {
    const title = compact(heading.textContent ?? "").toLowerCase();
    if (!/^(광고|ad|ads|advertisement|advertisements|sponsored)$/.test(title)) return;
    const level = Number(heading.tagName[1]);
    let next = heading.nextSibling;
    while (next) {
      const current = next;
      next = next.nextSibling;
      if (
        current.nodeType === 1 &&
        /^H[1-6]$/.test((current as Element).tagName) &&
        Number((current as Element).tagName[1]) <= level
      ) {
        break;
      }
      current.parentNode?.removeChild(current);
    }
    heading.remove();
  });
}

function buildRegions(document: Document, registry: LinkRegistryBuilder, elementRegistry: ElementRegistryBuilder, options: Required<Pick<ConvertOptions, "maxTableRows" | "maxTableColumns" | "maxCellLength">>): RegionBlock[] {
  const body = document.body;
  const main = findMainElement(document) ?? body;
  const regions: RegionBlock[] = [];
  const navBlocks = findNavigationElements(document).slice(0, 4);
  const asideBlocks = uniqueElements(Array.from(document.querySelectorAll("aside"))).slice(0, 2);
  const footerBlocks = findFooterElements(document).slice(0, 2);
  const footnoteBlocks = uniqueElements(Array.from(document.querySelectorAll('[role="doc-endnotes"], .footnotes, .references, ol[id*="footnote"], ol[class*="footnote"]'))).slice(0, 2);

  const navigation = collectChildren(navBlocks, registry, elementRegistry, options, "navigation");
  if (navigation.length) regions.push(region("navigation", "Navigation", navigation));

  const mainChildren = elementToBlocks(main, registry, elementRegistry, options, "main");
  if (mainChildren.length) regions.push(region("main", "Main Content", mainChildren));

  const aside = collectChildren(asideBlocks, registry, elementRegistry, options, "aside");
  if (aside.length) regions.push(region("aside", "Aside", aside));

  const footer = collectChildren(footerBlocks, registry, elementRegistry, options, "footer");
  if (footer.length) regions.push(region("footer", "Footer", footer));

  const footnotes = collectChildren(footnoteBlocks, registry, elementRegistry, options, "footnotes");
  if (footnotes.length) regions.push(region("footnotes", "Footnotes", footnotes));

  return regions.length ? regions : [region("main", "Main Content", elementToBlocks(body, registry, elementRegistry, options, "main"))];
}

function region(role: RegionRole, title: string, children: ContentBlock[]): RegionBlock {
  return { type: "region", role, title, children };
}

function collectChildren(elements: Element[], registry: LinkRegistryBuilder, elementRegistry: ElementRegistryBuilder, options: Required<Pick<ConvertOptions, "maxTableRows" | "maxTableColumns" | "maxCellLength">>, role: RegionRole): ContentBlock[] {
  return elements.flatMap((el) => elementToBlocks(el, registry, elementRegistry, options, role));
}

function findMainElement(document: Document): Element | undefined {
  const direct = document.querySelector("main, [role='main']");
  if (direct) return direct;
  const candidates = Array.from(document.querySelectorAll("article, section, div"))
    .filter((el) => !el.closest("header,nav,footer,aside") && !isNavigationLikeElement(el) && !isFooterLikeElement(el))
    .map((el) => ({ el, score: (el.textContent ?? "").trim().length }))
    .filter((x) => x.score > 500)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.el;
}

function findNavigationElements(document: Document): Element[] {
  const candidates = Array.from(
    document.querySelectorAll(
      "header, nav, [role='navigation'], [class*='header' i], [id*='header' i], [class*='gnb' i], [id*='gnb' i], [class*='lnb' i], [id*='lnb' i], [class*='nav' i], [id*='nav' i], [class*='shortcut' i], [id*='shortcut' i], [class*='search' i], [id*='search' i]",
    ),
  )
    .filter(isNavigationLikeElement)
    .map((el, index) => ({ el, index, priority: navigationPriority(el) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((x) => x.el);
  return uniqueElements(candidates);
}

function findFooterElements(document: Document): Element[] {
  return uniqueElements(
    Array.from(
      document.querySelectorAll(
        "footer, [role='contentinfo'], [class*='footer' i], [id*='footer' i], [class*='copyright' i], [id*='copyright' i], [class*='tail' i], [id*='tail' i]",
      ),
    ).filter(isFooterLikeElement),
  );
}

function uniqueElements(elements: Element[]): Element[] {
  const result: Element[] = [];
  for (const el of elements) {
    if (result.some((kept) => kept.contains(el) || el.contains(kept))) continue;
    result.push(el);
  }
  return result;
}

function elementToBlocks(element: Element, registry: LinkRegistryBuilder, elementRegistry: ElementRegistryBuilder, options: Required<Pick<ConvertOptions, "maxTableRows" | "maxTableColumns" | "maxCellLength">>, role: RegionRole): ContentBlock[] {
  const tag = element.tagName.toLowerCase();
  if (isIgnorable(element)) return [];
  if (role !== "navigation" && isNavigationLikeElement(element)) return [];
  if (role !== "footer" && isFooterLikeElement(element)) return [];
  if (role !== "footnotes" && isFootnoteContainer(element)) return [];

  if (/^h[1-6]$/.test(tag)) {
    const text = headingText(element, registry);
    return text ? [{ type: "heading", level: Number(tag[1]), text }] : [];
  }
  if (tag === "p" || tag === "blockquote" || tag === "li") {
    const text = inlineText(element, registry, cssPath(element));
    return text ? [{ type: "paragraph", text: tag === "blockquote" ? `> ${text}` : text }] : [];
  }
  if (tag === "ul" || tag === "ol") {
    const list = listBlock(element, registry);
    if (list.length) return list;
  }
  if (tag === "table") return [tableBlock(element, registry, options)];
  if (tag === "img") {
    const alt = compact(element.getAttribute("alt") ?? element.getAttribute("title") ?? "");
    if (!alt) return [];
    const srcId = registry.register(element.getAttribute("src"), alt, cssPath(element));
    return [{ type: "image", alt, srcId }];
  }
  if (tag === "a") {
    const text = linkText(element, registry);
    const linkId = registry.register(element.getAttribute("href"), text, cssPath(element));
    return text ? [{ type: "paragraph", text: linkId ? `${text} [${linkId}]` : text }] : [];
  }
  if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") {
    const controlTag = tag as "button" | "input" | "select" | "textarea";
    const text = controlText(element);
    if (!text) return [];
    const inputType = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : undefined;
    const selectOptions = tag === "select"
      ? Array.from(element.querySelectorAll("option")).map((o) => compact(o.textContent ?? "")).filter(Boolean)
      : undefined;
    const elementId = elementRegistry.register(controlTag, text, cssPath(element), { inputType, options: selectOptions });
    return [{ type: "control", control: controlTag, text, elementId }];
  }
  if (isParagraphLikeContainer(element)) {
    const text = inlineText(element, registry, cssPath(element));
    return text ? [{ type: "paragraph", text }] : [];
  }

  const blocks = Array.from(element.children).flatMap((child) => elementToBlocks(child, registry, elementRegistry, options, role));
  if (blocks.length) return blocks;
  const text = compact(element.textContent ?? "");
  return text.length > 30 && !isLayoutOnly(role, tag) ? [{ type: "paragraph", text }] : [];
}

function isIgnorable(element: Element): boolean {
  if (/^(a|img|input|button|select|textarea)$/i.test(element.tagName)) return false;
  const text = compact(element.textContent ?? "");
  if (!text && !element.querySelector("a[href],img,input,button,select,textarea")) return true;
  const cls = element.getAttribute("class") ?? "";
  const id = element.getAttribute("id") ?? "";
  const role = element.getAttribute("role") ?? "";
  const label = element.getAttribute("aria-label") ?? "";
  return /(^|[-_\s])(ads|advert|advertisement|banner|sponsor|sponsored|tracking|promotion)([-_\s]|$)/i.test(`${cls} ${id} ${role} ${label}`);
}

function isFootnoteContainer(element: Element): boolean {
  const role = element.getAttribute("role") ?? "";
  const cls = element.getAttribute("class") ?? "";
  const id = element.getAttribute("id") ?? "";
  return /doc-endnotes|footnotes?|references/i.test(`${role} ${cls} ${id}`);
}

function isNavigationLikeElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? "";
  if (tag === "header" || tag === "nav" || role.toLowerCase() === "navigation") return true;

  const cls = element.getAttribute("class") ?? "";
  const id = element.getAttribute("id") ?? "";
  const name = `${cls} ${id}`;
  if (!/(^|[-_\s])(header|head|gnb|lnb|nav|navigation|shortcut|search)([-_\s]|$)/i.test(name)) return false;
  if (element.closest("main, article, section, [role='main']")) return false;

  const text = compact(element.textContent ?? "");
  const linkCount = element.querySelectorAll("a[href], button, input, select").length;
  return linkCount > 0 && text.length <= 2_000;
}

function navigationPriority(element: Element): number {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? "";
  const name = `${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`;
  if (role.toLowerCase() === "navigation") return 100;
  if (/(^|[-_\s])(shortcut|search)([-_\s]|$)/i.test(name)) return 90;
  if (tag === "nav") return 80;
  if (tag === "header" || /(^|[-_\s])(header|head|gnb|lnb)([-_\s]|$)/i.test(name)) return 70;
  return 10;
}

function isFooterLikeElement(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") ?? "";
  if (tag === "footer" || role.toLowerCase() === "contentinfo") return true;

  const cls = element.getAttribute("class") ?? "";
  const id = element.getAttribute("id") ?? "";
  const name = `${cls} ${id}`;
  if (!/(^|[-_\s])(footer|foot|tail|copyright|copy-?right|contentinfo)([-_\s]|$)/i.test(name)) return false;

  const text = compact(element.textContent ?? "");
  return /(회사소개|이용약관|개인정보|청소년보호|고객센터|사업자|copyright|all rights reserved|ⓒ|©)/i.test(text);
}

function isLayoutOnly(role: RegionRole, tag: string): boolean {
  return role !== "main" && ["div", "span"].includes(tag);
}

function isParagraphLikeContainer(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (!["div", "span"].includes(tag)) return false;
  const directText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join(" ");
  if (compact(directText).length < 20) return false;
  return !Array.from(element.children).some((child) =>
    /^(h[1-6]|table|ul|ol|li|section|article|main|nav|aside|footer|form)$/i.test(child.tagName),
  );
}

function listBlock(element: Element, registry: LinkRegistryBuilder): ContentBlock[] {
  const ordered = element.tagName.toLowerCase() === "ol";
  const children = Array.from(element.children);
  if (children.some((child) => child.tagName.toLowerCase() !== "li")) return [];
  const items = children
    .map((child) => inlineText(child, registry, cssPath(child)))
    .filter(Boolean)
    .slice(0, 80);
  return items.length ? [{ type: "list", ordered, items }] : [];
}

function tableBlock(table: Element, registry: LinkRegistryBuilder, options: Required<Pick<ConvertOptions, "maxTableRows" | "maxTableColumns" | "maxCellLength">>): TableBlock {
  const sourceRows = Array.from(table.querySelectorAll("tr"));
  const grid = sourceRows.map((tr) =>
    Array.from(tr.querySelectorAll("th,td"))
      .slice(0, options.maxTableColumns)
      .map((cell) => trimCell(inlineText(cell, registry, cssPath(cell)), options.maxCellLength)),
  );
  const originalColumns = Math.max(0, ...grid.map((row) => row.length));
  const rows = grid.slice(0, options.maxTableRows);
  const width = Math.min(options.maxTableColumns, Math.max(1, ...rows.map((row) => row.length)));
  const padded = rows.map((row) => pad(row, width));
  const firstRowLooksLikeHeader = sourceRows[0]?.querySelectorAll("th").length > 0;
  const headers = firstRowLooksLikeHeader ? padded.shift() ?? [] : keyValueHeaders(padded) ?? Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return {
    type: "table",
    headers,
    rows: padded,
    originalRows: sourceRows.length,
    originalColumns,
    truncated: sourceRows.length > options.maxTableRows || originalColumns > options.maxTableColumns,
  };
}

function keyValueHeaders(rows: string[][]): string[] | undefined {
  if (rows.length >= 2 && rows.every((row) => row.length <= 2)) return ["항목", "내용"];
  return undefined;
}

function pad(row: string[], width: number): string[] {
  return [...row, ...Array(Math.max(0, width - row.length)).fill("")];
}

function trimCell(value: string, maxLength: number): string {
  const clean = compact(value);
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function inlineText(element: Element, registry: LinkRegistryBuilder, sourcePath: string, insideLink = false): string {
  const parts: string[] = [];
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg") continue;
    if (tag === "br") {
      parts.push(" ");
    } else if (tag === "a") {
      const text = linkText(child, registry);
      const linkId = registry.register(child.getAttribute("href"), text, cssPath(child));
      parts.push(linkId ? `${text} [${linkId}]` : text);
    } else if (tag === "img") {
      const alt = compact(child.getAttribute("alt") ?? child.getAttribute("title") ?? "");
      if (!alt) continue;
      if (insideLink) {
        // Inside an anchor, the href is already registered — skip registering the img src separately.
        parts.push(`[image: ${alt}]`);
      } else {
        const linkId = registry.register(child.getAttribute("src"), alt, cssPath(child));
        parts.push(`[image: ${alt}${linkId ? ` ${linkId}` : ""}]`);
      }
    } else if (tag === "button" || tag === "input") {
      const text = controlText(child);
      if (text) parts.push(`[${tag}: ${text}]`);
    } else {
      parts.push(inlineText(child, registry, sourcePath, insideLink));
    }
  }
  return compact(parts.join(" "));
}

function linkText(element: Element, registry: LinkRegistryBuilder): string {
  return compact(
    inlineText(element, registry, cssPath(element), true) ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      "",
  );
}

function headingText(element: Element, registry: LinkRegistryBuilder): string {
  const clone = element.cloneNode(true) as Element;
  Array.from(clone.querySelectorAll("a,button")).forEach((child) => {
    const text = compact(child.textContent ?? child.getAttribute("aria-label") ?? child.getAttribute("title") ?? "");
    const href = child.getAttribute("href") ?? "";
    if (/^(편집|edit|share|copy link|링크 복사)$/i.test(text) || /\/edit\/|[?&]action=edit|#toc$/i.test(href)) {
      child.remove();
    }
  });
  const raw = inlineText(clone, registry, cssPath(element)).replace(/\[\s*\]/g, "").replace(/\s*\[\s*편집\s*\]\s*$/i, "").trim();
  return deduplicateLinkIds(raw);
}

function deduplicateLinkIds(text: string): string {
  const seen = new Set<string>();
  const parts = text.split(/(\[L\d+\])/);
  const result: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (/^\[L\d+\]$/.test(part)) {
      if (!seen.has(part)) {
        seen.add(part);
        result.unshift(part);
      }
    } else {
      result.unshift(part);
    }
  }
  return compact(result.join(""));
}

function controlText(element: Element): string {
  if (element.tagName.toLowerCase() === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") return "";
    const labelled = compact(
      element.getAttribute("aria-label") ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        "",
    );
    if (labelled) return labelled;
    if (["checkbox", "radio"].includes(type)) return "";
    return compact(element.getAttribute("value") || "");
  }
  return compact(
    element.textContent ||
      element.getAttribute("aria-label") ||
      element.getAttribute("value") ||
      element.getAttribute("placeholder") ||
      "",
  );
}

function cssPath(element: Element): string {
  const names: string[] = [];
  let current: Element | null = element;
  while (current && names.length < 5) {
    const tag = current.tagName.toLowerCase();
    const id = current.getAttribute("id");
    names.unshift(id ? `${tag}#${id}` : tag);
    current = current.parentElement;
  }
  return names.join(" > ");
}

function countBlocks(blocks: ContentBlock[]): number {
  return blocks.reduce((count, block) => count + 1 + (block.type === "region" ? countBlocks(block.children) : 0), 0);
}

function renderPage(page: PageAst): string {
  const lines = [
    `# ${page.title}`,
    "",
    `- Page ID: ${page.pageId}`,
    `- Host: ${page.urlHost}`,
    `- Links: ${page.stats.linkCount}`,
    `- Elements: ${page.stats.elementCount}`,
    "",
  ];
  for (const block of page.blocks) lines.push(...renderBlock(block), "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderBlock(block: ContentBlock): string[] {
  switch (block.type) {
    case "region":
      return [`## ${block.title}`, "", ...block.children.flatMap((child) => [...renderBlock(child), ""])];
    case "heading":
      return [`${"#".repeat(Math.min(6, block.level + 1))} ${block.text}`];
    case "paragraph":
      return [block.text];
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`);
    case "image":
      return [`[image${block.alt ? `: ${block.alt}` : ""}${block.srcId ? ` ${block.srcId}` : ""}]`];
    case "control":
      return [`[${block.control}#${block.elementId}: ${block.text}]`];
    case "table":
      return renderTable(block);
  }
}

function renderTable(table: TableBlock): string[] {
  const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
  const headers = pad(table.headers, width).map(escapeCell);
  const lines = [
    table.truncated ? `_Table truncated from ${table.originalRows} rows x ${table.originalColumns} columns._` : "",
    `| ${headers.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...table.rows.map((row) => `| ${pad(row, width).map(escapeCell).join(" | ")} |`),
  ];
  return lines.filter(Boolean);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
