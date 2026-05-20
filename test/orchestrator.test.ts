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
      "SKT T1 history - Wikipedia [L3]",
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
        L3: {
          id: "L3",
          text: "SKT T1 history",
          url: "https://en.wikipedia.org/wiki/T1_(esports)",
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
      stats: { linkCount: 3, elementCount: 0, blockCount: 0 },
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

  it("dispatches multiple explorers concurrently when the orchestrator chooses explore_parallel", async () => {
    vi.mocked(convertPage).mockResolvedValue(serpResult());

    // 동시 실행 여부를 검증하기 위해 호출 시작/종료 시점을 추적한다.
    let activeCalls = 0;
    let maxActiveCalls = 0;
    let releaseExplorers!: () => void;
    const explorersStarted = new Promise<void>((resolve) => {
      releaseExplorers = resolve;
    });

    vi.mocked(runExplorationAgent).mockImplementation(async (brief) => {
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      // 모든 explorer가 시작되기 전까지 첫 explorer가 완료되지 않도록 막아 동시성을 강제한다.
      if (activeCalls >= 2) releaseExplorers();
      await explorersStarted;
      activeCalls--;
      return report({
        agentId: brief.agentId,
        url: brief.url,
      });
    });

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
                action: "explore_parallel",
                branches: [
                  { linkId: "L1", task: "Faker page details", rationale: "Player profile" },
                  { linkId: "L2", task: "T1 roster history", rationale: "Team page" },
                  { linkId: "L3", task: "Wikipedia history", rationale: "Independent overview" },
                ],
                rationale: "These pages are independent.",
              }),
              tokenUsage,
            };
          }
          return {
            text: JSON.stringify({
              action: "done",
              reason: "Parallel batch produced enough information.",
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

    expect(runExplorationAgent).toHaveBeenCalledTimes(3);
    // 셋이 동시에 진행됐는지 검증 (직렬 실행이었다면 maxActiveCalls=1).
    expect(maxActiveCalls).toBe(3);
    const briefs = vi.mocked(runExplorationAgent).mock.calls.map((c) => c[0]);
    expect(briefs.map((b) => b.url).sort()).toEqual([
      "https://en.wikipedia.org/wiki/T1_(esports)",
      "https://lol.fandom.com/wiki/Faker",
      "https://lol.fandom.com/wiki/T1",
    ]);
    expect(briefs.every((b) => b.parentAgentId === "orchestrator")).toBe(true);
    expect(briefs.every((b) => b.depth === 0)).toBe(true);
  });

  it("falls through to the next round when explore_parallel branches are all invalid", async () => {
    vi.mocked(convertPage).mockResolvedValue(serpResult());

    vi.mocked(runExplorationAgent).mockResolvedValue(
      report({
        agentId: "explorer-2",
        url: "https://lol.fandom.com/wiki/Faker",
        completeness: "complete",
        missingInfo: [],
      }),
    );

    let callIndex = 0;
    const client = {
      complete: vi.fn(async (_agentId: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.includes("search query specialist")) {
          return { text: "Faker", tokenUsage };
        }
        if (messages[0]?.content.includes("research agent deciding")) {
          callIndex++;
          if (callIndex === 1) {
            return {
              text: JSON.stringify({
                action: "explore_parallel",
                branches: [
                  { linkId: "L99", task: "bogus", rationale: "invalid" },
                  { linkId: "L98", task: "bogus", rationale: "invalid" },
                ],
                rationale: "Independent.",
              }),
              tokenUsage,
            };
          }
          if (callIndex === 2) {
            return {
              text: JSON.stringify({
                action: "explore",
                linkId: "L1",
                task: "Fall back to Faker",
                rationale: "Recover from bad batch",
              }),
              tokenUsage,
            };
          }
          return {
            text: JSON.stringify({ action: "done", reason: "done" }),
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
      { query: "Faker", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    // 1라운드의 모든 branch가 무효 → explorer 호출 없음. 2라운드의 단일 explore는 진행됨.
    expect(runExplorationAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://lol.fandom.com/wiki/Faker",
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
