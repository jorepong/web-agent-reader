import { convertPage } from "../index.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildExplorerPrompt, MAX_DEPTH } from "./prompts.js";
import type { ExplorationReport, MissionBrief } from "./types.js";

export async function runExplorationAgent(
  brief: MissionBrief,
  client: OpenAIClient,
  logger: DebugLogger,
  visitedUrls: Set<string> = new Set()
): Promise<ExplorationReport> {
  logger.startAgent(brief.agentId, brief.parentAgentId);
  await logger.log("mission_brief", brief.agentId, { brief });

  visitedUrls.add(brief.url);

  try {
    const result = await convertPage(brief.url, { scroll: true, stealth: true, pageId: brief.agentId });

    await logger.log("page_markdown", brief.agentId, {
      url: brief.url,
      markdown: result.markdown,
      pageId: result.page.pageId,
    });

    const messages = buildExplorerPrompt(brief, result.markdown);
    const { text, tokenUsage } = await client.complete(brief.agentId, messages);

    let parsed: {
      found: boolean;
      summary: string;
      relevantExcerpts: string[];
      shouldExploreDeeper?: boolean;
      suggestedLinkIds?: string[];
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { found: false, summary: "Failed to parse LLM response.", relevantExcerpts: [] };
    }

    const childReports: ExplorationReport[] = [];
    const suggestedLinkIds = parsed.suggestedLinkIds ?? [];

    await logger.log("recursion_decision", brief.agentId, {
      depth: brief.depth,
      shouldExploreDeeper: parsed.shouldExploreDeeper ?? false,
      suggestedLinkIds,
      resolvedLinks: suggestedLinkIds.map((id) => ({
        linkId: id,
        url: result.links.links[id]?.url ?? null,
        skipped: !result.links.links[id] || visitedUrls.has(result.links.links[id].url),
      })),
    });

    if (brief.depth < MAX_DEPTH && parsed.shouldExploreDeeper && suggestedLinkIds.length > 0) {
      for (const linkId of suggestedLinkIds.slice(0, 3)) {
        const entry = result.links.links[linkId];
        if (!entry || visitedUrls.has(entry.url)) continue;

        visitedUrls.add(entry.url);

        const childBrief: MissionBrief = {
          agentId: `${brief.agentId}-${linkId.toLowerCase()}`,
          parentAgentId: brief.agentId,
          goal: brief.goal,
          url: entry.url,
          parentGoal: brief.parentGoal,
          depth: brief.depth + 1,
        };

        const childReport = await runExplorationAgent(childBrief, client, logger, visitedUrls);
        childReports.push(childReport);
      }
    }

    const report: ExplorationReport = {
      agentId: brief.agentId,
      url: brief.url,
      found: parsed.found ?? false,
      summary: parsed.summary ?? "",
      relevantExcerpts: parsed.relevantExcerpts ?? [],
      tokenUsage,
      ...(childReports.length > 0 && { childReports }),
    };

    await logger.log("exploration_report", brief.agentId, { report });
    return report;
  } catch (err) {
    const report: ExplorationReport = {
      agentId: brief.agentId,
      url: brief.url,
      found: false,
      summary: `Page could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      relevantExcerpts: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    await logger.log("exploration_report", brief.agentId, { report });
    return report;
  }
}
