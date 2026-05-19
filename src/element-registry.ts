import type { ElementEntry, ElementRegistry } from "./types.js";

const TYPE_PREFIX = { button: "B", input: "I", select: "S", textarea: "T" } as const;

export class ElementRegistryBuilder {
  private counters = { button: 0, input: 0, select: 0, textarea: 0 };
  private entries: Record<string, ElementEntry> = {};

  constructor(
    private readonly pageId: string,
    private readonly sourceUrl: string,
  ) {}

  register(
    type: ElementEntry["type"],
    text: string,
    sourcePath: string,
    extra?: { inputType?: string; options?: string[] },
  ): string {
    this.counters[type]++;
    const id = `${TYPE_PREFIX[type]}${this.counters[type]}`;
    this.entries[id] = { id, type, text, sourcePath, ...extra };
    return id;
  }

  build(): ElementRegistry {
    return { pageId: this.pageId, sourceUrl: this.sourceUrl, elements: { ...this.entries } };
  }
}
