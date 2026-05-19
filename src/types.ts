export type RegionRole = "navigation" | "main" | "aside" | "footer" | "footnotes";

export interface ConvertOptions {
  pageId?: string;
  maxTableRows?: number;
  maxTableColumns?: number;
  maxCellLength?: number;
  timeoutMs?: number;
  scroll?: boolean;
  maxScrolls?: number;
  scrollWaitMs?: number;
  stopAfterStableRounds?: number;
  render?: RenderMetadata;
  /** Use real Chrome and remove automation fingerprints to bypass bot detection */
  stealth?: boolean;
}

export interface LinkEntry {
  id: string;
  text: string;
  url: string;
  kind: "internal" | "external" | "anchor" | "asset" | "unknown";
  sourcePath: string;
}

export interface LinkRegistry {
  pageId: string;
  sourceUrl: string;
  links: Record<string, LinkEntry>;
}

export interface ElementEntry {
  id: string;
  type: "button" | "input" | "select" | "textarea";
  text: string;
  inputType?: string;
  options?: string[];
  sourcePath: string;
}

export interface ElementRegistry {
  pageId: string;
  sourceUrl: string;
  elements: Record<string, ElementEntry>;
}

export type ContentBlock =
  | RegionBlock
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | ImageBlock
  | ControlBlock;

export interface RegionBlock {
  type: "region";
  role: RegionRole;
  title: string;
  children: ContentBlock[];
}

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: string[];
}

export interface TableBlock {
  type: "table";
  title?: string;
  headers: string[];
  rows: string[][];
  originalRows: number;
  originalColumns: number;
  truncated: boolean;
}

export interface ImageBlock {
  type: "image";
  alt: string;
  srcId?: string;
}

export interface ControlBlock {
  type: "control";
  control: "button" | "input" | "select" | "textarea";
  text: string;
  elementId: string;
}

export interface PageAst {
  pageId: string;
  title: string;
  urlHost: string;
  sourceUrl: string;
  generatedAt: string;
  blocks: ContentBlock[];
  stats: {
    linkCount: number;
    elementCount: number;
    blockCount: number;
  };
  render?: RenderMetadata;
}

export interface RenderMetadata {
  scrolled: boolean;
  scrolls: number;
  stoppedBy: "disabled" | "stable" | "max-scrolls";
  before: RenderSnapshot;
  after: RenderSnapshot;
}

export interface RenderSnapshot {
  height: number;
  scrollY: number;
  viewportHeight: number;
  distanceToBottom: number;
  textLength: number;
  linkCount: number;
}

export interface ConvertResult {
  page: PageAst;
  markdown: string;
  links: LinkRegistry;
  elements: ElementRegistry;
}
