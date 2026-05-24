// 긴 페이지를 리서처가 한 번에 읽지 않도록, 마크다운을 heading 기반 섹션 인덱스로 나눈다.
// 변환기 API는 그대로 두고 v2의 페이지 읽기 계층에서만 progressive disclosure를 적용한다.

export interface PageSection {
  id: string;
  title: string;
  path: string[];
  level: number;
  startLine: number;
  endLine: number;
  charCount: number;
  linkCount: number;
  tableCount: number;
  preview: string;
}

export interface SectionedMarkdown {
  markdown: string;
  lines: string[];
  sections: PageSection[];
}

interface Heading {
  lineIndex: number;
  level: number;
  title: string;
  path: string[];
}

export function buildSectionedMarkdown(markdown: string): SectionedMarkdown {
  const lines = markdown.split("\n");
  const headings = collectHeadings(lines);
  const firstRegionHeading = headings.find((h) => h.level >= 2);
  const usableHeadings = firstRegionHeading ? headings.filter((h) => h.level >= 2) : headings;
  const sections: PageSection[] = [];

  if (firstRegionHeading && firstRegionHeading.lineIndex > 0) {
    const preamble = createSection("S1", "Document Overview", ["Document Overview"], 1, 0, firstRegionHeading.lineIndex, lines);
    if (preamble.charCount > 0) sections.push(preamble);
  }

  for (const heading of usableHeadings) {
    const endLine =
      usableHeadings.find((candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level)?.lineIndex ??
      lines.length;
    sections.push(
      createSection(
        `S${sections.length + 1}`,
        heading.title,
        heading.path.filter((part, index) => index > 0 || heading.level === 1),
        heading.level,
        heading.lineIndex,
        endLine,
        lines
      )
    );
  }

  if (sections.length === 0) {
    sections.push(createSection("S1", "Document", ["Document"], 1, 0, lines.length, lines));
  }

  return { markdown, lines, sections };
}

export function formatSectionOutline(sections: PageSection[]): string {
  return sections
    .map((section) => {
      const path = section.path.length > 0 ? section.path.join(" > ") : section.title;
      const preview = section.preview ? ` preview="${section.preview}"` : "";
      return `[${section.id}] ${path} | level=${section.level} | chars=${section.charCount} | links=${section.linkCount} | tables=${section.tableCount}${preview}`;
    })
    .join("\n");
}

export function selectSectionMarkdown(
  sectioned: SectionedMarkdown,
  sectionIds: string[],
  options: { readWholePage?: boolean; maxChars: number }
): { markdown: string; selectedIds: string[]; truncated: boolean } {
  if (options.readWholePage) {
    return limitMarkdown(sectioned.markdown, sectioned.sections.map((s) => s.id), options.maxChars);
  }

  const requested = new Set(sectionIds.map((id) => id.trim()).filter(Boolean));
  const selected = sectioned.sections.filter((section) => requested.has(section.id));
  const ranges = mergeRanges(selected.map((section) => ({ start: section.startLine, end: section.endLine })));
  const markdown = ranges.map((range) => sectioned.lines.slice(range.start, range.end).join("\n").trim()).filter(Boolean).join("\n\n---\n\n");
  return limitMarkdown(markdown || sectioned.markdown, selected.map((s) => s.id), options.maxChars);
}

export function defaultSectionIds(sectioned: SectionedMarkdown, maxSections = 4): string[] {
  const preferred = sectioned.sections.filter((section) => /main content|본문|content|article/i.test(section.path.join(" ")));
  const pool = preferred.length > 0 ? preferred : sectioned.sections;
  return pool.slice(0, maxSections).map((section) => section.id);
}

function collectHeadings(lines: string[]): Heading[] {
  const stack: Array<{ level: number; title: string }> = [];
  const headings: Heading[] = [];

  lines.forEach((line, lineIndex) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    const level = match[1]!.length;
    const title = match[2]!.replace(/\s+\[C\d+\]$/g, "").trim();
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title });
    headings.push({ lineIndex, level, title, path: stack.map((item) => item.title) });
  });

  return headings;
}

function createSection(
  id: string,
  title: string,
  path: string[],
  level: number,
  startLine: number,
  endLine: number,
  lines: string[]
): PageSection {
  const content = lines.slice(startLine, endLine).join("\n").trim();
  return {
    id,
    title,
    path,
    level,
    startLine,
    endLine,
    charCount: content.length,
    linkCount: (content.match(/\[C\d+\]/g) ?? []).length,
    tableCount: content.split("\n").filter((line) => /^\s*\|.*\|\s*$/.test(line)).length > 1 ? 1 : 0,
    preview: buildPreview(content),
  };
}

function buildPreview(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^#+\s+/, "").trim())
    .filter((line) => line && !/^[-*]\s*Page ID:/.test(line) && !/^[-*]\s*Host:/.test(line))
    .slice(0, 3)
    .join(" / ")
    .replace(/"/g, "'")
    .slice(0, 180);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function limitMarkdown(markdown: string, selectedIds: string[], maxChars: number): { markdown: string; selectedIds: string[]; truncated: boolean } {
  if (markdown.length <= maxChars) return { markdown, selectedIds, truncated: false };
  return {
    markdown:
      markdown.slice(0, maxChars).trimEnd() +
      `\n\n[Section read truncated at ${maxChars} characters. If the answer remains incomplete, report the missing information in GAPS.]`,
    selectedIds,
    truncated: true,
  };
}
