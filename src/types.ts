export type RegionRole = "navigation" | "highlights" | "main" | "aside" | "footer" | "footnotes";

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

// 클릭으로만 목적지가 정해지는 비-앵커 작동 요소(예: SPA 카드)를 다시 찾기 위한 locator.
// id는 렌더마다 바뀌므로, 재현 가능한 신호(보이는 텍스트 + 반복 그룹 내 순번)만 저장한다.
export interface ActivateLocator {
  /** 요소의 보이는 라벨. 렌더가 바뀌어도 동일하게 매칭된다. */
  text: string;
  /** 같은 구조로 반복되는 형제 중 0부터 센 순번. 텍스트가 유일하지 않을 때의 보조 키. */
  index: number;
}

export interface LinkEntry {
  id: string;
  text: string;
  /** href 링크의 절대 URL. activate 링크는 클릭 전까지 URL이 없어 빈 문자열이다. */
  url: string;
  kind: "internal" | "external" | "anchor" | "asset" | "action" | "unknown";
  sourcePath: string;
  /** href: 정적 URL로 즉시 해소(기본). activate: 클릭해야 목적지가 정해지는 작동 요소. */
  resolution?: "href" | "activate";
  /** resolution === "activate"일 때 그 요소를 다시 찾기 위한 locator. */
  locator?: ActivateLocator;
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
