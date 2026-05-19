import { convertPage } from "../index.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildExplorerPrompt } from "./prompts.js";
import type { ExplorationReport, MissionBrief } from "./types.js";

export async function runExplorationAgent(
  brief: MissionBrief,
  client: OpenAIClient,
  logger: DebugLogger
): Promise<ExplorationReport> {
  logger.startAgent(brief.agentId, brief.parentAgentId);
  await logger.log("mission_brief", brief.agentId, { brief });

  try {
    const result = await convertPage(brief.url, { scroll: true, stealth: true, pageId: brief.agentId });

    await logger.log("page_markdown", brief.agentId, {
      url: brief.url,
      markdown: result.markdown,
      pageId: result.page.pageId,
    });

    const messages = buildExplorerPrompt(brief, result.markdown);
    const { text, tokenUsage } = await client.complete(brief.agentId, messages);

    let parsed: { found: boolean; summary: string; relevantExcerpts: string[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { found: false, summary: "Failed to parse LLM response.", relevantExcerpts: [] };
    }

    const report: ExplorationReport = {
      agentId: brief.agentId,
      url: brief.url,
      found: parsed.found ?? false,
      summary: parsed.summary ?? "",
      relevantExcerpts: parsed.relevantExcerpts ?? [],
      tokenUsage,
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
