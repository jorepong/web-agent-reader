import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertPage } from "../src/index.js";
import { runExplorationAgent } from "../src/search/explorer.js";
import { runSearch } from "../src/search/orchestrator.js";
import { buildNextActionPrompt } from "../src/search/prompts.js";
import type { ConvertResult } from "../src/types.js";
import type { ExplorationReport, LLMMessage, TokenUsage } from "../src/search/types.js";

vi.mock("../src/index.js", () => ({
  convertPage: vi.fn(),
}));

vi.mock("../src/search/explorer.js", () => ({
  runExplorationAgent: vi.fn(),
}));

const tokenUsage: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function report(overrides: Partial<ExplorationReport>): ExplorationReport {
  return {
    agentId: "explorer-1",
    url: "https://lol.fandom.com/wiki/Faker",
    found: true,
    completeness: "partial",
    summary: "Impact, MaRin, Huni, Khan, and Doran were found, but the list is not complete.",
    relevantExcerpts: [],
    missingInfo: ["Full historical roster coverage is missing."],
    tokenUsage,
    ...overrides,
  };
}

function serpResult(): ConvertResult {
  const sourceUrl = "https://www.google.com/search?q=faker";
  return {
    markdown: [
      "# Google",
      "",
      "## Main Content",
      "",
      "Faker - Leaguepedia [L1]",
      "T1 - Leaguepedia [L2]",
    ].join("\n"),
    links: {
      pageId: "SERP",
      sourceUrl,
      links: {
        L1: {
          id: "L1",
          text: "Faker",
          url: "https://lol.fandom.com/wiki/Faker",
          kind: "external",
          sourcePath: "a",
        },
        L2: {
          id: "L2",
          text: "T1",
          url: "https://lol.fandom.com/wiki/T1",
          kind: "external",
          sourcePath: "a",
        },
      },
    },
    page: {
      pageId: "SERP",
      title: "Google",
      urlHost: "www.google.com",
      sourceUrl,
      generatedAt: "2026-05-19T00:00:00.000Z",
      blocks: [],
      stats: { linkCount: 2, elementCount: 0, blockCount: 0 },
    },
    elements: {
      pageId: "SERP",
      sourceUrl,
      elements: {},
    },
  };
}

describe("runSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("can explore another SERP result after a partial report when the orchestrator chooses it", async () => {
    vi.mocked(convertPage).mockResolvedValue(serpResult());

    vi.mocked(runExplorationAgent)
      .mockResolvedValueOnce(report({}))
      .mockResolvedValueOnce(report({
        agentId: "explorer-2",
        url: "https://lol.fandom.com/wiki/T1",
        completeness: "complete",
        summary: "Complete roster-derived top-laner list found.",
        missingInfo: [],
      }));

    const client = {
      complete: vi.fn(async (_agentId: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.includes("search query specialist")) {
          return { text: "Faker teammates top laners history", tokenUsage };
        }
        if (messages[0]?.content.includes("research agent deciding")) {
          const content = messages[1]?.content ?? "";
          if (content.includes("Already explored (0/5)")) {
            return {
              text: JSON.stringify({
                action: "explore",
                linkId: "L1",
                task: "Extract Faker top-lane teammates",
                rationale: "Faker page is the best starting point.",
              }),
              tokenUsage,
            };
          }
          if (content.includes("Already explored (1/5)")) {
            return {
              text: JSON.stringify({
                action: "explore",
                linkId: "L2",
                task: "Extract T1 historical top-lane roster entries overlapping Faker",
                rationale: "T1 page is a structured team roster source.",
              }),
              tokenUsage,
            };
          }
          return {
            text: JSON.stringify({
              action: "done",
              reason: "The structured team page completed the answer.",
            }),
            tokenUsage,
          };
        }
        return { text: "final answer", tokenUsage };
      }),
    };
    const logger = {
      startAgent: vi.fn(),
      log: vi.fn(async () => undefined),
    };

    await runSearch(
      { query: "페이커와 함께한 역대 탑라이너", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    expect(runExplorationAgent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://lol.fandom.com/wiki/Faker",
    });
    expect(vi.mocked(runExplorationAgent).mock.calls[1][0]).toMatchObject({
      goal: "Extract T1 historical top-lane roster entries overlapping Faker",
      url: "https://lol.fandom.com/wiki/T1",
    });
  });
});

describe("buildNextActionPrompt", () => {
  it("instructs the orchestrator to keep exploring clearer or more authoritative SERP candidates", () => {
    const messages = buildNextActionPrompt(
      "페이커와 함께한 역대 탑라이너",
      "Faker - Leaguepedia [L1]\nT1 - Leaguepedia [L2]",
      [report({
        completeness: "complete",
        summary: "A complete-looking answer was found.",
        missingInfo: [],
      })],
      ["https://lol.fandom.com/wiki/Faker"],
      5,
    );

    expect(messages[0]?.content).toContain("Even if current findings appear to answer the question");
    expect(messages[0]?.content).toContain("clearer, more structured, more authoritative, or better for verification");
    expect(messages[0]?.content).toContain("strong confidence");
  });
});
