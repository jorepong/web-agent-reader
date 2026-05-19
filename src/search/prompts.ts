import type { ExplorationReport, LLMMessage, MissionBrief } from "./types.js";

export function buildSearchQueryPrompt(userQuery: string): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a search query specialist. Given a user's question, produce a single, concise Google search query (no longer than 10 words) that will find the most relevant pages. Output only the raw query string with no explanation, no quotes.",
    },
    {
      role: "user",
      content: userQuery,
    },
  ];
}

export function buildNextActionPrompt(
  userQuery: string,
  serpMarkdown: string,
  reports: ExplorationReport[],
  exploredUrls: string[],
  maxPages: number
): LLMMessage[] {
  const findingsSummary =
    reports.length === 0
      ? "None yet."
      : reports
          .map((r, i) => `[${i + 1}] ${r.url}\n  found=${r.found} — ${r.summary}`)
          .join("\n\n");

  const exploredList = exploredUrls.length === 0 ? "None." : exploredUrls.map((u) => `- ${u}`).join("\n");

  return [
    {
      role: "system",
      content: `You are a research agent deciding how to proceed with a web search.

You have access to a Google search results page. Based on findings so far, decide:
1. Explore another page — if current findings are insufficient to answer the question
2. Stop — if you already have enough information to give a complete, reliable answer

Rules:
- Only explore if it would meaningfully improve the answer
- Stop if you have sufficient, reliable information — do not explore just to be thorough
- Never re-explore an already-visited URL
- You have explored ${exploredUrls.length} of max ${maxPages} pages

Respond with JSON only (no markdown code fences):
Explore: {"action": "explore", "linkId": "L5", "rationale": "Why this page is worth exploring next"}
Stop:    {"action": "done", "reason": "Why current findings are sufficient"}`,
    },
    {
      role: "user",
      content: `User question: ${userQuery}

Search results:
${serpMarkdown}

Already explored (${exploredUrls.length}/${maxPages}):
${exploredList}

Findings so far:
${findingsSummary}`,
    },
  ];
}

export function buildExplorerPrompt(brief: MissionBrief, pageMarkdown: string): LLMMessage[] {
  return [
    {
      role: "system",
      content: `You are a focused research assistant. You receive a web page in Markdown and a specific goal.
Extract only information relevant to the goal. Do not summarize the whole page.

Respond with JSON only (no markdown code fences):
{
  "found": true,
  "summary": "2-5 sentence digest of what was found relevant to the goal",
  "relevantExcerpts": ["up to 3 short verbatim quotes from the page that support the summary — omit link IDs like [L1] and markdown headings like ## Heading"]
}

If nothing relevant is found:
{"found": false, "summary": "Page did not contain relevant information.", "relevantExcerpts": []}`,
    },
    {
      role: "user",
      content: `Goal: ${brief.goal}\nOriginal user question: ${brief.parentGoal}\n\nPage content:\n${pageMarkdown}`,
    },
  ];
}

export function buildSynthesisPrompt(userQuery: string, reports: ExplorationReport[], serpOnly: boolean): LLMMessage[] {
  const findings = reports
    .map((r) => {
      const excerpts = r.relevantExcerpts.length > 0 ? `\nExcerpts:\n${r.relevantExcerpts.map((e) => `- ${e}`).join("\n")}` : "";
      return `--- Source: ${r.url}\n${r.summary}${excerpts}`;
    })
    .join("\n\n");

  const systemContent = serpOnly
    ? `You are a research synthesizer. You receive Google search result snippets for a user's question.
Write a clear, factual answer that directly addresses the question based on the snippets.
Do NOT cite any URLs — the actual pages were not visited, so you cannot verify their content.
If snippets conflict, note the disagreement. If information is insufficient, say so directly.
Do not mention the search process or internal workings. Write for the end user.`
    : `You are a research synthesizer. You receive findings from web pages explored on behalf of a user's question.
Write a clear, factual answer (3-6 paragraphs) that directly addresses the question.
Cite sources inline using the URL from each report, like: (source: https://...).
If reports conflict, note the disagreement. If no useful information was found, say so directly.
Do not mention the exploration process or internal workings. Write for the end user.`;

  return [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: `User question: ${userQuery}\n\nFindings:\n${findings}`,
    },
  ];
}
