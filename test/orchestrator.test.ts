import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertPage } from "../src/index.js";
import { runExplorationAgent } from "../src/search/explorer.js";
import { runSearch } from "../src/search/orchestrator.js";
import { buildOrchestratorInitialPrompt } from "../src/search/prompts.js";
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
    url: "https://example.com/page",
    found: true,
    completeness: "partial",
    summary: "Some relevant content found, but the answer is incomplete.",
    relevantExcerpts: [],
    missingInfo: ["Some details are missing."],
    tokenUsage,
    ...overrides,
  };
}

// 임의의 (engine, query, page) 조합에 대해 SERP 형태의 ConvertResult를 생성한다.
// links는 호출 측이 직접 주입한다(테스트마다 다른 링크가 필요).
function makeSerp(opts: {
  url: string;
  links: ConvertResult["links"]["links"];
  body?: string;
}): ConvertResult {
  const linkIds = Object.keys(opts.links);
  const lines = ["# SERP", "", "## Main Content", ""];
  for (const id of linkIds) {
    lines.push(`${opts.links[id]!.text} [${id}]`);
  }
  if (opts.body) lines.push("", opts.body);

  return {
    markdown: lines.join("\n"),
    links: {
      pageId: "SERP",
      sourceUrl: opts.url,
      links: opts.links,
    },
    page: {
      pageId: "SERP",
      title: "SERP",
      urlHost: new URL(opts.url).host,
      sourceUrl: opts.url,
      generatedAt: "2026-05-21T00:00:00.000Z",
      blocks: [],
      stats: { linkCount: linkIds.length, elementCount: 0, blockCount: 0 },
    },
    elements: {
      pageId: "SERP",
      sourceUrl: opts.url,
      elements: {},
    },
  };
}

// LLM action 응답을 손쉽게 만드는 헬퍼.
function actionResponse(payload: unknown) {
  return { text: JSON.stringify(payload), tokenUsage };
}

describe("runSearch (agentic orchestrator)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a search action then dispatches an explorer on the resulting SERP", async () => {
    const googleSerp = makeSerp({
      url: "https://www.google.com/search?q=...",
      links: {
        L1: {
          id: "L1",
          text: "Authoritative page",
          url: "https://example.com/authoritative",
          kind: "external",
          sourcePath: "a",
        },
      },
    });
    vi.mocked(convertPage).mockResolvedValue(googleSerp);
    vi.mocked(runExplorationAgent).mockResolvedValue(
      report({ agentId: "explorer-2", url: "https://example.com/authoritative", completeness: "complete", missingInfo: [] }),
    );

    // 라운드 호출 순서대로 응답을 반환하는 mock
    const responses: unknown[] = [
      { action: "search", engine: "google", query: "test query", rationale: "default engine" },
      { action: "explore", linkId: "L1", task: "Extract authoritative content", rationale: "Looks canonical" },
      { action: "done", reason: "Sufficient" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(async (_id: string, messages: LLMMessage[]) => {
        const first = messages[0]?.content ?? "";
        if (first.startsWith("You are a research synthesizer")) {
          return { text: "final answer", tokenUsage };
        }
        const next = responses[i++];
        return actionResponse(next);
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };

    const answer = await runSearch(
      { query: "테스트 질문", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    expect(answer).toBe("final answer");
    // convertPage는 SERP 1회만 호출 (explorer가 mock이라 페이지 변환 추가 호출 없음)
    expect(convertPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(convertPage).mock.calls[0][0]).toContain("google.com/search");
    expect(runExplorationAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://example.com/authoritative",
      goal: "Extract authoritative content",
    });
  });

  it("can re-search on a different engine after an unsatisfying SERP", async () => {
    const googleSerp = makeSerp({
      url: "https://www.google.com/search?q=...",
      links: {
        L1: { id: "L1", text: "Blog spam", url: "https://spam.example.com/a", kind: "external", sourcePath: "a" },
      },
    });
    const naverSerp = makeSerp({
      url: "https://search.naver.com/search.naver?query=...",
      links: {
        L1: { id: "L1", text: "공식 문서", url: "https://official.example.kr/", kind: "external", sourcePath: "a" },
      },
    });
    vi.mocked(convertPage).mockResolvedValueOnce(googleSerp).mockResolvedValueOnce(naverSerp);
    vi.mocked(runExplorationAgent).mockResolvedValue(
      report({ url: "https://official.example.kr/", completeness: "complete", missingInfo: [] }),
    );

    const responses: unknown[] = [
      { action: "search", engine: "google", query: "한국 통계", rationale: "global default" },
      // SERP가 스팸이라 판단 → 네이버로 재검색
      { action: "search", engine: "naver", query: "한국 공식 통계 보고서", rationale: "Korean topic" },
      { action: "explore", linkId: "L1", task: "공식 보고서에서 통계 추출", rationale: "official source" },
      { action: "done", reason: "got the official figure" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(async (_id: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.startsWith("You are a research synthesizer")) {
          return { text: "final answer", tokenUsage };
        }
        return actionResponse(responses[i++]);
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };

    await runSearch(
      { query: "한국 통계", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    expect(convertPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(convertPage).mock.calls[0][0]).toContain("google.com/search");
    expect(vi.mocked(convertPage).mock.calls[1][0]).toContain("search.naver.com");
    expect(runExplorationAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://official.example.kr/",
    });
  });

  it("paginates within the same SERP when LLM chooses paginate", async () => {
    const page1 = makeSerp({
      url: "https://www.google.com/search?q=...",
      links: {
        L1: { id: "L1", text: "Result 1", url: "https://example.com/p1", kind: "external", sourcePath: "a" },
      },
    });
    const page2 = makeSerp({
      url: "https://www.google.com/search?q=...&start=10",
      links: {
        L1: { id: "L1", text: "Result 11", url: "https://example.com/p11", kind: "external", sourcePath: "a" },
      },
    });
    vi.mocked(convertPage).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    vi.mocked(runExplorationAgent).mockResolvedValue(
      report({ url: "https://example.com/p11", completeness: "complete", missingInfo: [] }),
    );

    const responses: unknown[] = [
      { action: "search", engine: "google", query: "rare topic", rationale: "default" },
      { action: "paginate", page: 2, rationale: "first page lacked the right candidate" },
      { action: "explore", linkId: "L1", task: "deep dive", rationale: "promising" },
      { action: "done", reason: "done" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(async (_id: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.startsWith("You are a research synthesizer")) {
          return { text: "final answer", tokenUsage };
        }
        return actionResponse(responses[i++]);
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };

    await runSearch(
      { query: "rare topic", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    expect(convertPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(convertPage).mock.calls[1][0]).toContain("start=10");
    expect(runExplorationAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://example.com/p11",
    });
  });

  it("dispatches multiple explorers concurrently when LLM picks explore_parallel", async () => {
    const serp = makeSerp({
      url: "https://www.google.com/search?q=...",
      links: {
        L1: { id: "L1", text: "A", url: "https://example.com/a", kind: "external", sourcePath: "a" },
        L2: { id: "L2", text: "B", url: "https://example.com/b", kind: "external", sourcePath: "a" },
        L3: { id: "L3", text: "C", url: "https://example.com/c", kind: "external", sourcePath: "a" },
      },
    });
    vi.mocked(convertPage).mockResolvedValue(serp);

    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(runExplorationAgent).mockImplementation(async (brief) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active >= 3) release();
      await gate;
      active--;
      return report({ agentId: brief.agentId, url: brief.url });
    });

    const responses: unknown[] = [
      { action: "search", engine: "google", query: "x", rationale: "go" },
      {
        action: "explore_parallel",
        branches: [
          { linkId: "L1", task: "t1", rationale: "r1" },
          { linkId: "L2", task: "t2", rationale: "r2" },
          { linkId: "L3", task: "t3", rationale: "r3" },
        ],
        rationale: "independent",
      },
      { action: "done", reason: "ok" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(async (_id: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.startsWith("You are a research synthesizer")) {
          return { text: "final answer", tokenUsage };
        }
        return actionResponse(responses[i++]);
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };

    await runSearch(
      { query: "x", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    expect(runExplorationAgent).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(3);
  });

  it("injects an error message and retries when the LLM picks explore before any search", async () => {
    const serp = makeSerp({
      url: "https://www.google.com/search?q=...",
      links: {
        L1: { id: "L1", text: "A", url: "https://example.com/a", kind: "external", sourcePath: "a" },
      },
    });
    vi.mocked(convertPage).mockResolvedValue(serp);
    vi.mocked(runExplorationAgent).mockResolvedValue(report({ url: "https://example.com/a" }));

    const responses: unknown[] = [
      // 첫 라운드에서 SERP 없이 explore — 에러 메시지 주입 후 다음 라운드로
      { action: "explore", linkId: "L1", task: "premature", rationale: "wrong" },
      { action: "search", engine: "google", query: "x", rationale: "recover" },
      { action: "explore", linkId: "L1", task: "good", rationale: "now valid" },
      { action: "done", reason: "done" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(async (_id: string, messages: LLMMessage[]) => {
        if (messages[0]?.content.startsWith("You are a research synthesizer")) {
          return { text: "final answer", tokenUsage };
        }
        return actionResponse(responses[i++]);
      }),
    };
    const logger = { startAgent: vi.fn(), log: vi.fn(async () => undefined) };

    await runSearch(
      { query: "x", model: "test", debug: false, logDir: "." },
      client as never,
      logger as never,
    );

    // explore는 두 번째 시도(SERP 확보 이후)에 한 번만 성공
    expect(runExplorationAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExplorationAgent).mock.calls[0][0]).toMatchObject({
      url: "https://example.com/a",
      goal: "good",
    });
    // 4라운드의 응답이 messages에 모두 append되었는지 — assistant 메시지 4개
    const lastCallMessages = client.complete.mock.calls
      .filter((c) => !(c[1] as LLMMessage[])[0].content.startsWith("You are a research synthesizer"))
      .at(-1)![1] as LLMMessage[];
    const assistantCount = lastCallMessages.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBeGreaterThanOrEqual(3);
  });
});

describe("buildOrchestratorInitialPrompt", () => {
  it("describes all five actions and the supported engines", () => {
    const messages = buildOrchestratorInitialPrompt("a sample question");
    const sys = messages[0]!.content;

    for (const action of ["search", "paginate", "explore", "explore_parallel", "done"]) {
      expect(sys).toContain(action);
    }
    for (const engine of ["google", "bing", "naver"]) {
      expect(sys).toContain(engine);
    }
    expect(sys).toContain("agentic loop");
    expect(messages[1]?.content).toContain("a sample question");
  });
});
