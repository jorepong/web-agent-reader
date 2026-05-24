import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertPage } from "../src/index.js";
import { SharedBudget } from "../src/search/v2/budget.js";
import { runResearcher } from "../src/search/v2/researcher.js";
import type { ResearcherBrief } from "../src/search/v2/types.js";
import type { ConvertResult } from "../src/types.js";

vi.mock("../src/index.js", () => ({
  convertPage: vi.fn(),
}));

const tokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function response(decision: unknown) {
  return { text: JSON.stringify({ decision }), tokenUsage };
}

function makeResult(url: string, links: ConvertResult["links"]["links"] = {}): ConvertResult {
  const lines = ["# Page", "", "## Main Content", ""];
  for (const id of Object.keys(links)) lines.push(`${links[id]!.text} [${id}]`);
  return makeMarkdownResult(url, lines.join("\n"), links);
}

function makeMarkdownResult(url: string, markdown: string, links: ConvertResult["links"]["links"] = {}): ConvertResult {
  return {
    markdown,
    links: { pageId: "P", sourceUrl: url, links },
    page: {
      pageId: "P",
      title: "Page",
      urlHost: new URL(url).host,
      sourceUrl: url,
      generatedAt: "2026-05-24T00:00:00.000Z",
      blocks: [],
      stats: { linkCount: Object.keys(links).length, elementCount: 0, blockCount: 0 },
    },
    elements: { pageId: "P", sourceUrl: url, elements: {} },
  };
}

function collectTargetIdEnums(value: unknown, enums: unknown[][] = []): unknown[][] {
  if (!value || typeof value !== "object") return enums;
  const record = value as Record<string, unknown>;
  if (record["targetId"] && typeof record["targetId"] === "object") {
    const target = record["targetId"] as Record<string, unknown>;
    if (Array.isArray(target["enum"])) enums.push(target["enum"]);
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) collectTargetIdEnums(item, enums);
    } else {
      collectTargetIdEnums(child, enums);
    }
  }
  return enums;
}

describe("Researcher v2 delegation model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces the root researcher to delegate before it can synthesize", async () => {
    vi.mocked(convertPage).mockResolvedValue(makeResult("https://www.google.com/search?q=x"));

    const schemaNames: string[] = [];
    const client = {
      complete: vi.fn(async (agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        schemaNames.push(`${agentId}:${options.responseSchema?.name ?? "none"}`);
        if (agentId === "researcher-root") {
          if (schemaNames.filter((name) => name.startsWith("researcher-root:")).length === 1) {
            return response({
              action: "delegate",
              task: "Find candidate sources for the question.",
              linkId: null,
              startUrl: null,
              rationale: "Root delegates discovery instead of searching directly.",
            });
          }
          return response({
            action: "done",
            answer: "ANSWER:\nDone from child report.\n\nSOURCES:\n(none)\n\nCOVERAGE: partial\n\nGAPS:\n- (none)\n\nNEXT_CANDIDATES:\n(none)",
          });
        }
        return response({
          action: "done",
          answer: "ANSWER:\nChild report.\n\nSOURCES:\nSERP only — pages not verified\n\nCOVERAGE: partial\n\nGAPS:\n- Needs verification\n\nNEXT_CANDIDATES:\n- https://example.com/a — candidate",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root",
      parentAgentId: null,
      goal: "question",
      parentGoal: "question",
      depth: 0,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(answer).toContain("Done from child report");
    expect(schemaNames[0]).toBe("researcher-root:researcher_action_root_initial_delegate");
    expect(schemaNames).not.toContain("researcher-root:researcher_action_sub_initial");
  });

  it("forces root synthesis when delegate budget is exhausted", async () => {
    const schemaNames: string[] = [];
    const client = {
      complete: vi.fn(async (agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        schemaNames.push(`${agentId}:${options.responseSchema?.name ?? "none"}`);
        return response({
          action: "done",
          answer: "ANSWER:\nNo delegate budget remains.\n\nSOURCES:\n(none)\n\nCOVERAGE: none\n\nGAPS:\n- No child researcher budget\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root",
      parentAgentId: null,
      goal: "question",
      parentGoal: "question",
      depth: 0,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget({ maxExplores: 0 }));

    expect(answer).toContain("No delegate budget remains");
    expect(schemaNames[0]).toBe("researcher-root:researcher_action_done_only");
  });

  it("blocks search on the first round when a sub-researcher starts from a URL", async () => {
    vi.mocked(convertPage).mockResolvedValue(makeResult("https://example.com/page"));

    const schemaNames: string[] = [];
    const client = {
      complete: vi.fn(async (agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        schemaNames.push(`${agentId}:${options.responseSchema?.name ?? "none"}`);
        return response({
          action: "done",
          answer: "ANSWER:\nRead the starting page.\n\nSOURCES:\n- https://example.com/page\n\nCOVERAGE: complete\n\nGAPS:\n(none)\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d1",
      parentAgentId: "researcher-root",
      goal: "Read this page.",
      parentGoal: "question",
      startUrl: "https://example.com/page",
      depth: 1,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(answer).toContain("Read the starting page");
    expect(schemaNames[0]).toBe("researcher-root-d1:researcher_action_start_page_first");
    expect(convertPage).toHaveBeenCalledWith("https://example.com/page", expect.objectContaining({ scroll: true }));
  });

  it("still blocks first-round search for a URL-started researcher at max depth", async () => {
    vi.mocked(convertPage).mockResolvedValue(makeResult("https://example.com/deep"));

    const schemaNames: string[] = [];
    const client = {
      complete: vi.fn(async (agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        schemaNames.push(`${agentId}:${options.responseSchema?.name ?? "none"}`);
        return response({
          action: "done",
          answer: "ANSWER:\nRead what is available from the starting page.\n\nSOURCES:\n- https://example.com/deep\n\nCOVERAGE: partial\n\nGAPS:\n- No deeper delegation available\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d3",
      parentAgentId: "researcher-root-d2",
      goal: "Read this deep page.",
      parentGoal: "question",
      startUrl: "https://example.com/deep",
      depth: 3,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget({ maxDepth: 3 }));

    expect(answer).toContain("Read what is available");
    expect(schemaNames[0]).toBe("researcher-root-d3:researcher_action_done_only");
    expect(schemaNames[0]).not.toContain("researcher_action_no_delegate");
  });

  it("asks which sections to read before sending a long starting page", async () => {
    const longMarkdown = [
      "# Page",
      "",
      "## Navigation",
      "Home",
      "",
      "## Main Content",
      "",
      "### Needed section",
      "Important roster fact.",
      "",
      "### Unneeded section",
      `UNNEEDED-FILLER ${"x".repeat(45_000)}`,
    ].join("\n");
    vi.mocked(convertPage).mockResolvedValue(makeMarkdownResult("https://example.com/long", longMarkdown));

    const schemaNames: string[] = [];
    let sectionPrompt = "";
    let pageReadPrompt = "";
    const client = {
      complete: vi.fn(async (_agentId: string, messages: Array<{ content: string }>, options: { responseSchema?: { name: string }; reasoningEffort?: string }) => {
        schemaNames.push(options.responseSchema?.name ?? "none");
        if (options.responseSchema?.name === "researcher_page_section_selection") {
          expect(options.reasoningEffort).toBe("low");
          sectionPrompt = messages.map((message) => message.content).join("\n");
          return { text: JSON.stringify({ selection: { readWholePage: false, sectionIds: ["S4"], rationale: "Needed section matches the goal." } }), tokenUsage };
        }
        pageReadPrompt = messages.map((message) => message.content).join("\n");
        return response({
          action: "done",
          answer: "ANSWER:\nImportant roster fact.\n\nSOURCES:\n- https://example.com/long\n\nCOVERAGE: complete\n\nGAPS:\n(none)\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-long",
      parentAgentId: "researcher-root",
      goal: "Find the roster fact.",
      parentGoal: "question",
      startUrl: "https://example.com/long",
      depth: 1,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(answer).toContain("Important roster fact");
    expect(schemaNames[0]).toBe("researcher_page_section_selection");
    expect(schemaNames[1]).toBe("researcher_action_start_page_first");
    expect(sectionPrompt).toContain("[S4] Main Content > Needed section");
    expect(pageReadPrompt).toContain("Important roster fact");
    expect(pageReadPrompt).not.toContain("UNNEEDED-FILLER");
  });

  it("can read additional sections from the same starting page before answering", async () => {
    const longMarkdown = [
      "# Page",
      "",
      "## Navigation",
      "Home",
      "",
      "## Main Content",
      "",
      "### Initial section",
      "Initial roster fact.",
      "",
      "### Additional section",
      "Additional roster detail.",
      "",
      "### Filler section",
      `FILLER ${"x".repeat(45_000)}`,
    ].join("\n");
    vi.mocked(convertPage).mockResolvedValue(makeMarkdownResult("https://example.com/sectioned", longMarkdown));

    const schemaNames: string[] = [];
    let sawAdditionalSection = false;
    const client = {
      complete: vi.fn(async (_agentId: string, messages: Array<{ content: string }>, options: { responseSchema?: { name: string } }) => {
        schemaNames.push(options.responseSchema?.name ?? "none");
        const allMessages = messages.map((message) => message.content).join("\n");
        if (options.responseSchema?.name === "researcher_page_section_selection") {
          return { text: JSON.stringify({ selection: { readWholePage: false, sectionIds: ["S4"], rationale: "Start with the initial section." } }), tokenUsage };
        }
        if (options.responseSchema?.name === "researcher_action_start_page_first") {
          expect(allMessages).toContain("Current page section outline");
          return response({ action: "read_sections", sectionIds: ["S5"], rationale: "Need the adjacent detail section before answering." });
        }
        sawAdditionalSection = allMessages.includes("Additional roster detail.");
        return response({
          action: "done",
          answer: "ANSWER:\nInitial and additional facts.\n\nSOURCES:\n- https://example.com/sectioned\n\nCOVERAGE: complete\n\nGAPS:\n(none)\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-sectioned",
      parentAgentId: "researcher-root",
      goal: "Find roster facts.",
      parentGoal: "question",
      startUrl: "https://example.com/sectioned",
      depth: 1,
    };

    const answer = await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(answer).toContain("Initial and additional facts");
    expect(schemaNames).toContain("researcher_action_start_page_first");
    expect(sawAdditionalSection).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(
      "orchestrator_plan",
      "researcher-root-sectioned",
      expect.objectContaining({ action: "read_sections", sectionIds: ["S5"] }),
    );
  });

  it("rejects delegate_parallel when filtering leaves only one valid branch", async () => {
    vi.mocked(convertPage).mockResolvedValue(
      makeResult("https://www.google.com/search?q=x", {
        L1: { id: "L1", text: "Only valid", url: "https://example.com/a", kind: "external", sourcePath: "a" },
      }),
    );

    const client = {
      complete: vi.fn(async (_agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        if (options.responseSchema?.name === "researcher_action_sub_initial") {
          return response({ action: "search", engine: "google", query: "x", rationale: "start" });
        }
        if (options.responseSchema?.name === "researcher_action") {
          return response({
            action: "delegate_parallel",
            branches: [
              { task: "Read valid page.", linkId: "L1", startUrl: null, rationale: "valid" },
              { task: "Read invalid page.", linkId: "L404", startUrl: null, rationale: "invalid" },
            ],
            rationale: "try two",
          });
        }
        return response({
          action: "done",
          answer: "ANSWER:\nStopped.\n\nSOURCES:\n(none)\n\nCOVERAGE: partial\n\nGAPS:\n- branch rejected\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d1",
      parentAgentId: "researcher-root",
      goal: "Find sources.",
      parentGoal: "question",
      depth: 1,
    };

    await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(logger.log).toHaveBeenCalledWith(
      "orchestrator_plan",
      "researcher-root-d1",
      expect.objectContaining({
        action: "rejected",
        requestedAction: "delegate_parallel",
        reason: expect.stringContaining("at least 2 valid branches"),
      }),
    );
  });

  it("does not mark a single valid branch as visited when delegate_parallel is rejected", async () => {
    vi.mocked(convertPage).mockResolvedValue(
      makeResult("https://www.google.com/search?q=x", {
        L1: { id: "L1", text: "Only valid", url: "https://example.com/a", kind: "external", sourcePath: "a" },
      }),
    );

    const budget = new SharedBudget();
    const client = {
      complete: vi.fn(async (_agentId: string, _messages: unknown[], options: { responseSchema?: { name: string } }) => {
        if (options.responseSchema?.name === "researcher_action_sub_initial") {
          return response({ action: "search", engine: "google", query: "x", rationale: "start" });
        }
        if (options.responseSchema?.name === "researcher_action") {
          return response({
            action: "delegate_parallel",
            branches: [
              { task: "Read valid page.", linkId: "L1", startUrl: null, rationale: "valid" },
              { task: "Read invalid page.", linkId: "L404", startUrl: null, rationale: "invalid" },
            ],
            rationale: "try two",
          });
        }
        return response({
          action: "done",
          answer: "ANSWER:\nStopped.\n\nSOURCES:\n(none)\n\nCOVERAGE: partial\n\nGAPS:\n- branch rejected\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d1",
      parentAgentId: "researcher-root",
      goal: "Find sources.",
      parentGoal: "question",
      depth: 1,
    };

    await runResearcher(brief, client as never, logger as never, budget);

    expect(budget.visitedUrls.has("https://example.com/a")).toBe(false);
    expect(budget.exploresUsed).toBe(0);
  });

  it("uses session-wide candidate ids instead of page-local link ids", async () => {
    vi.mocked(convertPage)
      .mockResolvedValueOnce(
        makeResult("https://www.google.com/search?q=x", {
          L1: { id: "L1", text: "First candidate", url: "https://example.com/first", kind: "external", sourcePath: "a" },
        }),
      )
      .mockResolvedValueOnce(makeResult("https://example.com/first"));

    let sawCandidateId = false;
    let actionSchema: unknown;
    const client = {
      complete: vi.fn(async (_agentId: string, messages: Array<{ content: string }>, options: { responseSchema?: { name: string; schema?: unknown }; reasoningEffort?: string }) => {
        if (options.responseSchema?.name === "researcher_action_sub_initial") {
          expect(options.reasoningEffort).toBe("medium");
          return response({ action: "search", engine: "google", query: "x", rationale: "start" });
        }
        if (options.responseSchema?.name === "researcher_action") {
          expect(options.reasoningEffort).toBe("medium");
          actionSchema = options.responseSchema.schema;
          sawCandidateId = messages.some((message) => message.content.includes("[C1]"));
          return response({
            action: "delegate",
            task: "Read the first candidate.",
            targetId: "C1",
            linkId: null,
            startUrl: null,
            rationale: "candidate id is globally scoped",
          });
        }
        return response({
          action: "done",
          answer: "ANSWER:\nRead candidate.\n\nSOURCES:\n- https://example.com/first\n\nCOVERAGE: complete\n\nGAPS:\n(none)\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d1",
      parentAgentId: "researcher-root",
      goal: "Find sources.",
      parentGoal: "question",
      depth: 1,
    };

    await runResearcher(brief, client as never, logger as never, new SharedBudget());

    expect(sawCandidateId).toBe(true);
    const targetIdEnums = collectTargetIdEnums(actionSchema);
    expect(targetIdEnums.some((values) => values.includes("C1"))).toBe(true);
    expect(targetIdEnums.some((values) => values.includes("[C1]"))).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      "orchestrator_plan",
      "researcher-root-d1",
      expect.objectContaining({
        action: "delegate",
        targetId: "C1",
        linkId: "L1",
        url: "https://example.com/first",
      }),
    );
  });

  it("shows already visited status for visible SERP candidates", async () => {
    vi.mocked(convertPage).mockResolvedValue(
      makeResult("https://www.google.com/search?q=x", {
        L1: { id: "L1", text: "Visited candidate", url: "https://example.com/visited", kind: "external", sourcePath: "a" },
        L2: { id: "L2", text: "Fresh candidate", url: "https://example.com/fresh", kind: "external", sourcePath: "b" },
      }),
    );

    let serpPrompt = "";
    const client = {
      complete: vi.fn(async (_agentId: string, messages: Array<{ content: string }>, options: { responseSchema?: { name: string } }) => {
        if (options.responseSchema?.name === "researcher_action_sub_initial") {
          return response({ action: "search", engine: "google", query: "x", rationale: "start" });
        }
        serpPrompt = messages.map((message) => message.content).join("\n");
        return response({
          action: "done",
          answer: "ANSWER:\nStopped.\n\nSOURCES:\nSERP only — pages not verified\n\nCOVERAGE: partial\n\nGAPS:\n- Not delegated\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-d1",
      parentAgentId: "researcher-root",
      goal: "Find sources.",
      parentGoal: "question",
      depth: 1,
    };
    const budget = new SharedBudget();
    budget.visitedUrls.add("https://example.com/visited");

    await runResearcher(brief, client as never, logger as never, budget);

    expect(serpPrompt).toContain("[C1] already visited");
    expect(serpPrompt).toContain("[C2] available");
    expect(serpPrompt).toContain("Do not delegate candidates marked \"already visited\"");
  });

  it("caps visible targetId enums so structured outputs stay under provider limits", async () => {
    const links: ConvertResult["links"]["links"] = {};
    for (let i = 1; i <= 405; i++) {
      links[`L${i}`] = {
        id: `L${i}`,
        text: `Candidate ${i}`,
        url: `https://example.com/${i}`,
        kind: "external",
        sourcePath: `a${i}`,
      };
    }
    vi.mocked(convertPage).mockResolvedValue(makeResult("https://example.com/many", links));

    let pagePrompt = "";
    let actionSchema: unknown;
    const client = {
      complete: vi.fn(async (_agentId: string, messages: Array<{ content: string }>, options: { responseSchema?: { name: string; schema?: unknown } }) => {
        actionSchema = options.responseSchema?.schema;
        pagePrompt = messages.map((message) => message.content).join("\n");
        return response({
          action: "done",
          answer: "ANSWER:\nStopped.\n\nSOURCES:\n- https://example.com/many\n\nCOVERAGE: partial\n\nGAPS:\n- Not delegated\n\nNEXT_CANDIDATES:\n(none)",
        });
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };
    const brief: ResearcherBrief = {
      agentId: "researcher-root-many",
      parentAgentId: "researcher-root",
      goal: "Read visible candidates.",
      parentGoal: "question",
      startUrl: "https://example.com/many",
      depth: 1,
    };

    await runResearcher(brief, client as never, logger as never, new SharedBudget());

    const targetIdEnums = collectTargetIdEnums(actionSchema);
    expect(targetIdEnums.length).toBeGreaterThan(0);
    for (const values of targetIdEnums) {
      expect(values.length).toBeLessThanOrEqual(401);
      expect(values).toContain("C400");
      expect(values).not.toContain("C401");
    }
    expect(pagePrompt).toContain("[C400]");
    expect(pagePrompt).not.toContain("[C401]");
  });
});
