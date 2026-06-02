import type { ActivateLocator, LinkEntry, LinkRegistry } from "./types.js";

export class LinkRegistryBuilder {
  private links = new Map<string, LinkEntry>();
  private urlToId = new Map<string, string>();
  private activateTextToId = new Map<string, string>();
  private nextId = 1;

  constructor(
    private readonly pageId: string,
    private readonly sourceUrl: string,
  ) {}

  register(rawUrl: string | null, text: string, sourcePath: string): string | undefined {
    const normalized = this.normalizeUrl(rawUrl);
    const cleanText = compact(text);
    if (!normalized || !cleanText) return undefined;
    if (this.urlToId.has(normalized)) return this.urlToId.get(normalized);

    const id = `L${this.nextId++}`;
    const entry: LinkEntry = {
      id,
      text: cleanText,
      url: normalized,
      kind: classifyUrl(normalized, this.sourceUrl),
      sourcePath,
    };
    this.links.set(id, entry);
    this.urlToId.set(normalized, id);
    return id;
  }

  // 클릭으로만 목적지가 정해지는 비-앵커 작동 요소를 href 링크와 같은 L# 네임스페이스로 등록한다.
  // URL이 없으므로 보이는 라벨로 중복을 제거하고, 다시 찾을 locator를 함께 저장한다.
  registerActivate(text: string, locator: ActivateLocator, sourcePath: string): string | undefined {
    const cleanText = compact(text);
    if (!cleanText) return undefined;
    const existing = this.activateTextToId.get(cleanText);
    if (existing) return existing;

    const id = `L${this.nextId++}`;
    const entry: LinkEntry = {
      id,
      text: cleanText,
      url: "",
      kind: "action",
      sourcePath,
      resolution: "activate",
      locator: { text: compact(locator.text), index: locator.index },
    };
    this.links.set(id, entry);
    this.activateTextToId.set(cleanText, id);
    return id;
  }

  build(): LinkRegistry {
    return {
      pageId: this.pageId,
      sourceUrl: this.sourceUrl,
      links: Object.fromEntries(this.links),
    };
  }

  private normalizeUrl(rawUrl: string | null): string | undefined {
    if (!rawUrl) return undefined;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed === "#") return undefined;
    if (/^(javascript|mailto|tel):/i.test(trimmed)) return undefined;
    if (/^data:/i.test(trimmed)) return undefined;
    try {
      return new URL(trimmed, this.sourceUrl).toString();
    } catch {
      return undefined;
    }
  }
}

export function compact(value: string): string {
  return value.replace(/\s+/g, " ").replace(/(\d)\s+(?=[가-힣])/g, "$1").replace(/·\s+(?=\d|[가-힣])/g, "·").trim();
}

function classifyUrl(url: string, sourceUrl: string): LinkEntry["kind"] {
  const parsed = new URL(url);
  const source = new URL(sourceUrl);
  if (parsed.origin === source.origin && parsed.pathname === source.pathname && parsed.search === source.search && parsed.hash) return "anchor";
  if (/\.(png|jpe?g|gif|webp|svg|pdf|zip)$/i.test(parsed.pathname)) return "asset";
  return parsed.origin === source.origin ? "internal" : "external";
}
