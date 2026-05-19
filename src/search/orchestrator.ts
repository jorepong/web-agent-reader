import { convertPage } from "../index.js";
import { runExplorationAgent } from "./explorer.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildNextActionPrompt, buildSearchQueryPrompt, buildSynthesisPrompt } from "./prompts.js";
import type { ExplorationReport, MissionBrief, SearchOptions } from "./types.js";

const MAX_PAGES = 5;

function extractSerpSnippets(markdown: string): string {
  const mainMatch = markdown.match(/## Main Content\n([\s\S]*?)(?=\n## |$)/);
  const main = mainMatch ? mainMatch[1] : markdown;

  const skipPrefixes = ["Translate this page", "Read more", "Missing:", "People also search for", "### "];

  return main
    .split("\n")
    .map((line) => line.replace(/\s*\[L\d+\]/g, "").trim())
    .filter((line) => {
      if (!line) return false;
      if (skipPrefixes.some((p) => line.startsWith(p))) return false;
      if (/^\d+:\d+$/.test(line)) return false; // 영상 길이 표시 (e.g. "9:22")
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runSearch(options: SearchOptions, client: OpenAIClient, logger: DebugLogger): Promise<string> {
  logger.startAgent("orchestrator", null);

  // Step 1: formulate search query
  const { text: searchQuery } = await client.complete("orchestrator", buildSearchQueryPrompt(options.query));
  const trimmedQuery = searchQuery.trim();

  // Step 2: convert Google SERP
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmedQuery)}&hl=en&gl=us`;
  const serpResult = await convertPage(googleUrl, { scroll: false, stealth: true, pageId: "SERP" });

  await logger.log("page_markdown", "orchestrator", {
    url: googleUrl,
    markdown: serpResult.markdown,
    pageId: "SERP",
  });

  // Step 3: agentic exploration loop
  const serpSnippets = extractSerpSnippets(serpResult.markdown);
  const reports: ExplorationReport[] = [];
  const exploredUrls: string[] = [];

  for (let round = 1; round <= MAX_PAGES; round++) {
    const { text: actionJson } = await client.complete(
      "orchestrator",
      buildNextActionPrompt(options.query, serpSnippets, reports, exploredUrls, MAX_PAGES)
    );

    let action: { action: "explore" | "done"; linkId?: string; rationale?: string; reason?: string };
    try {
      action = JSON.parse(actionJson);
    } catch {
      break;
    }

    if (action.action === "done") {
      await logger.log("orchestrator_plan", "orchestrator", { round, action: "done", reason: action.reason });
      break;
    }

    if (!action.linkId) break;
    const entry = serpResult.links.links[action.linkId];
    if (!entry || exploredUrls.includes(entry.url)) break;

    await logger.log("orchestrator_plan", "orchestrator", {
      round,
      action: "explore",
      linkId: action.linkId,
      url: entry.url,
      rationale: action.rationale,
    });

    exploredUrls.push(entry.url);

    const brief: MissionBrief = {
      agentId: `explorer-${round}`,
      parentAgentId: "orchestrator",
      goal: action.rationale ?? options.query,
      url: entry.url,
      parentGoal: options.query,
    };

    const report = await runExplorationAgent(brief, client, logger);
    reports.push(report);
  }

  // Step 4: synthesize final answer
  // SERP 자체에서 충분한 정보를 얻어 탐색 없이 종료한 경우, SERP를 소스로 합성
  const serpOnly = reports.length === 0;
  if (serpOnly) {
    reports.push({
      agentId: "orchestrator",
      url: googleUrl,
      found: true,
      summary: extractSerpSnippets(serpResult.markdown),
      relevantExcerpts: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  }

  const usefulReports = reports.filter((r) => r.found);
  const reportsForSynthesis = usefulReports.length > 0 ? usefulReports : reports;

  const { text: answer } = await client.complete("orchestrator", buildSynthesisPrompt(options.query, reportsForSynthesis, serpOnly));
  await logger.log("final_answer", "orchestrator", { answer });
  return answer;
}
