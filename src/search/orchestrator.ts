import { convertPage } from "../index.js";
import { runExplorationAgent } from "./explorer.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildNextActionPrompt, buildSearchQueryPrompt, buildSynthesisPrompt } from "./prompts.js";
import type { ExplorationReport, MissionBrief, SearchOptions } from "./types.js";

const MAX_PAGES = 5;

function flattenReports(reports: ExplorationReport[]): ExplorationReport[] {
  const result: ExplorationReport[] = [];
  for (const report of reports) {
    result.push(report);
    if (report.childReports?.length) {
      result.push(...flattenReports(report.childReports));
    }
  }
  return result;
}

function extractSerpSnippets(markdown: string, keepLinkIds = false): string {
  const mainMatch = markdown.match(/## Main Content\n([\s\S]*?)(?=\n## |$)/);
  const main = mainMatch ? mainMatch[1] : markdown;

  const skipPrefixes = ["Translate this page", "Read more", "Missing:", "People also search for", "### "];

  return main
    .split("\n")
    .map((line) => (keepLinkIds ? line.trim() : line.replace(/\s*\[L\d+\]/g, "").trim()))
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
  const serpSnippets = extractSerpSnippets(serpResult.markdown, true); // 링크 ID 유지: 오케스트레이터가 linkId로 탐색 대상 선택
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
    if (!entry || exploredUrls.includes(entry.url)) continue;

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
      depth: 0,
    };

    const report = await runExplorationAgent(brief, client, logger);
    reports.push(report);
  }

  // Step 4: synthesize final answer
  const allReports = flattenReports(reports);
  const usefulReports = allReports.filter((r) => r.found);

  // 탐색이 없었거나 모든 탐색이 found=false인 경우 → SERP 스니펫으로 합성
  const useSerpSynthesis = usefulReports.length === 0;
  const reportsForSynthesis: ExplorationReport[] = useSerpSynthesis
    ? [{
        agentId: "orchestrator",
        url: googleUrl,
        found: true,
        summary: extractSerpSnippets(serpResult.markdown, false), // 링크 ID 제거: 실제 방문 안 한 URL 인용 방지
        relevantExcerpts: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }]
    : usefulReports;

  const { text: answer } = await client.complete("orchestrator", buildSynthesisPrompt(options.query, reportsForSynthesis, useSerpSynthesis));
  await logger.log("final_answer", "orchestrator", { answer });
  return answer;
}
