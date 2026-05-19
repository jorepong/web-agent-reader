// 모든 LLM 프롬프트 템플릿을 한곳에서 관리.
// 프롬프트 변경은 반드시 이 파일에서만 수행한다.
import type { ExplorationReport, LLMMessage, MissionBrief } from "./types.js";

// 탐색 에이전트의 재귀 최대 깊이.
// depth 0 에이전트는 자식을 만들 수 있고(depth 1), depth 1은 자식(depth 2)을 만들 수 있다.
// depth 2(= MAX_DEPTH)부터는 재귀 없이 현재 페이지 분석만 수행.
// Phase 5에서 CLI 옵션 --max-depth로 옵션화 예정.
export const MAX_DEPTH = 2;

// 한 탐색 에이전트가 자식을 호출할 수 있는 최대 횟수 (비용 폭발 방지).
// 실제 LLM 호출 수는 최대 MAX_CHILD_CALLS_PER_AGENT + 2회 (초기 + 자식들 + 마지막 done).
// Phase 5에서 CLI 옵션으로 옵션화 예정.
export const MAX_CHILD_CALLS_PER_AGENT = 3;

// 사용자 질문을 Google 검색에 최적화된 영어 쿼리로 변환.
// 한국어 질문을 그대로 Google에 넣으면 영어 자료 접근이 제한되므로 사전 변환.
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

// 오케스트레이터가 매 라운드 SERP를 보고 "더 탐색할지 / 종료할지" 판단하는 프롬프트.
// serpMarkdown: 링크 ID가 포함된 SERP 스니펫 (keepLinkIds=true로 추출).
//   링크 ID를 남겨두는 이유 — LLM이 linkId를 응답에 명시해야 하는데, 없으면 할루시네이션.
// reports: 상위 레벨 탐색 보고만 포함 (자식 보고는 explorer가 선별해 summary에 통합).
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
Stop:    {"action": "done", "reason": "Why current findings are sufficient"}

The linkId MUST be one of the IDs (e.g. [L5]) visible in the search results above. Do not invent IDs.`,
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

// 탐색 에이전트 아젠틱 루프의 초기 프롬프트.
// 페이지를 분석하고 explore / done 중 하나를 결정하도록 요청.
// depth >= MAX_DEPTH: 더 이상 자식 호출 불가 → done만 허용하는 별도 시스템 메시지 사용.
export function buildExplorerInitialPrompt(brief: MissionBrief, pageMarkdown: string): LLMMessage[] {
  const canExplore = brief.depth < MAX_DEPTH;

  const systemContent = canExplore
    ? `You are a focused research agent with a specific goal.
Analyze the given web page and find information relevant to the goal.

After analysis, decide your next action:
1. Explore — if a specific linked page clearly contains more relevant information not present here
2. Done — if you have sufficient information, or no valuable links exist

Link IDs look like [L1], [L2], etc. You can explore at most ${MAX_CHILD_CALLS_PER_AGENT} links total.

Respond with JSON only (no markdown code fences):
Explore: {"action": "explore", "linkId": "L3", "rationale": "Why this link is worth exploring"}
Done:    {"action": "done", "found": true, "summary": "2-5 sentence digest of relevant findings", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"]}

Rules:
- Only explore if it would meaningfully add to your findings
- The linkId MUST appear in the page content above. Do not invent IDs.
- Always omit link IDs from relevantExcerpts

If nothing relevant found:
{"action": "done", "found": false, "summary": "Page did not contain relevant information.", "relevantExcerpts": []}`
    : `You are a focused research agent with a specific goal.
Analyze the given web page and find information relevant to the goal. You cannot explore further links.

Respond with JSON only (no markdown code fences):
{"action": "done", "found": true, "summary": "2-5 sentence digest of relevant findings", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"]}

If nothing relevant found:
{"action": "done", "found": false, "summary": "Page did not contain relevant information.", "relevantExcerpts": []}`;

  return [
    { role: "system", content: systemContent },
    {
      role: "user",
      content: `Goal: ${brief.goal}\nOriginal question: ${brief.parentGoal}\n\nPage content:\n${pageMarkdown}`,
    },
  ];
}

// 자식 에이전트 보고를 받은 후 context에 append하는 user 메시지.
// 호출 순서: messages.push({role:"assistant", content: prevText}) → messages.push(이 함수 결과)
// canExploreMore: 아직 자식 호출 여유가 있는지 — LLM이 다음 행동을 결정하는 데 사용.
export function buildExplorerContinueMessage(childReport: ExplorationReport, canExploreMore: boolean): LLMMessage {
  const excerptText =
    childReport.relevantExcerpts.length > 0
      ? `\nKey excerpts:\n${childReport.relevantExcerpts.map((e) => `  - ${e}`).join("\n")}`
      : "";

  const continueHint = canExploreMore
    ? "Based on this result, decide your next action: explore another page or report your final findings."
    : "No more pages can be explored. Based on all information collected, provide your final report now.";

  return {
    role: "user",
    content: `Child exploration result from ${childReport.url}:
found: ${childReport.found}
summary: ${childReport.summary}${excerptText}

${continueHint}`,
  };
}

// 합성 프롬프트.
// serpOnly=true: 실제 페이지를 방문하지 않았거나 모든 탐색이 실패한 경우.
//   URL 인용 금지 — 방문하지 않은 페이지를 출처로 인용하면 신뢰도 문제.
// serpOnly=false: 탐색 성공 시. 방문한 URL을 출처로 명시적으로 인용.
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
Do not mention the search process or internal workings. Write for the end user.
Do not offer follow-up help or ask if the user wants more information.`
    : `You are a research synthesizer. You receive findings from web pages explored on behalf of a user's question.
Write a clear, factual answer (3-6 paragraphs) that directly addresses the question.
Cite sources inline using the URL from each report, like: (source: https://...).
If reports conflict, note the disagreement. If no useful information was found, say so directly.
Do not mention the exploration process or internal workings. Write for the end user.
Do not offer follow-up help or ask if the user wants more information.`;

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
