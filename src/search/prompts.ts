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

// 오케스트레이터가 한 번의 explore_parallel 라운드에서 동시에 실행할 수 있는 최대 explorer 수.
// Playwright 브라우저가 동시에 여러 개 실행되어 메모리 사용량이 증가하므로 안전장치.
// Phase 5에서 CLI 옵션 --max-parallel로 옵션화 예정.
export const MAX_PARALLEL = 3;

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
          .map((r, i) => {
            const missing = r.missingInfo.length > 0 ? `\n  missing=${r.missingInfo.join("; ")}` : "";
            return `[${i + 1}] ${r.url}\n  found=${r.found}, completeness=${r.completeness} — ${r.summary}${missing}`;
          })
          .join("\n\n");

  const exploredList = exploredUrls.length === 0 ? "None." : exploredUrls.map((u) => `- ${u}`).join("\n");

  return [
    {
      role: "system",
      content: `You are a research agent deciding how to proceed with a web search.

Output format requirement (read first): respond with a single JSON object only. No prose, no chain-of-thought, no markdown code fences, no text before or after the JSON. Output exactly one of the JSON shapes shown below and nothing else.

You have access to a Google search results page. Based on findings so far, choose exactly one of:
1. Explore one page — when the next page to visit depends on what the current findings tell you, or when only one unvisited candidate is worth dispatching right now
2. Explore multiple pages in parallel — when 2-${MAX_PARALLEL} unvisited candidates are independently worth exploring AND none of them needs to see another's result before being dispatched
3. Stop — if you already have enough information to give a complete, reliable answer

Rules:
- Only explore if it would meaningfully improve the answer
- Never re-explore an already-visited URL
- You have explored ${exploredUrls.length} of max ${maxPages} pages
- If findings contain information that seems inferred or imprecise (e.g., dates estimated from context), consider exploring a more authoritative source
- Even if current findings appear to answer the question, inspect the remaining SERP candidates before choosing done.
- If an unexplored SERP result is likely to be clearer, more structured, more authoritative, or better for verification, choose Explore instead of Stop.
- Stop only when you have strong confidence in the answer, or when no relevant unvisited SERP candidate is likely to improve completeness or reliability.
- Do not explore just to be broad; explore only when the page is likely to improve completeness, precision, authority, or verification.

Parallel vs serial — choose by dependency, not by breadth:

Use explore_parallel (must) when 2-${MAX_PARALLEL} branches are independent and ALL are needed. Patterns:
- Aspect decomposition: distinct facts about one subject live on different canonical pages, and no fact changes how another should be looked up (e.g., a company's headcount, headquarters location, and founding year on three separate official or reference pages).
- Comparison: the same attribute looked up across multiple subjects, each on its own page (e.g., the spec sheet of two competing products to compare a single field).
- List completion from complementary sources: each source contributes a disjoint slice of the list you need to assemble.

Use serial explore (must) when later choices depend on earlier results. Patterns:
- Drill-down: you cannot phrase the next task until you have read the current page (e.g., to find the most-cited work of a recent award winner you must first identify the winner from one page, then look up their citations on another).
- Conditional fallback: one authoritative page is likely enough; visit secondary candidates only if it does not answer. Saves budget when the first source suffices.
- Bridge question: the answer of one lookup IS the subject of the next (e.g., "Who founded the company that acquired X?" — the acquirer must be resolved before its founder can be searched).

When dependency is unclear, lean toward the efficient option:
- All candidates would be visited regardless of each other's results → prefer parallel; it saves wall-clock without changing the outcome.
- A single page clearly dominates the rest or is likely sufficient → prefer a single explore; do not batch for breadth's sake.
- Any suspicion that one branch's result would reshape another branch's task → prefer serial; do not run work you may have to discard.

Do NOT use explore_parallel for:
- Duplicates or paraphrases of the same primary source (the same article in different languages, multiple outlets republishing one wire story, aggregators that repackage a single source). Pick the most authoritative one instead.
- "Safety" candidates added just in case — only batch what you would have visited anyway under serial.

Respond with JSON only (no markdown code fences):
Explore one:        {"action": "explore", "linkId": "L5", "task": "Concise instruction for the sub-agent (what to find)", "rationale": "Why this page is worth exploring"}
Explore in parallel:{"action": "explore_parallel", "branches": [{"linkId": "L3", "task": "...", "rationale": "..."}, {"linkId": "L7", "task": "...", "rationale": "..."}], "rationale": "Why these branches are independent"}
Stop:               {"action": "done", "reason": "Why current findings are sufficient"}

Rules for task vs rationale:
- task: short imperative instruction stating WHAT the sub-agent should find, treating the chosen URL as ITS starting point (the sub-agent may follow further links from there). E.g. "Faker 페이지를 기점으로 함께한 역대 탑라이너 목록 추출"
- rationale: brief justification for WHY this URL was selected (for logging only)
The linkId MUST be one of the IDs (e.g. [L5]) visible in the search results above. Do not invent IDs.
In explore_parallel, every branch must use a distinct linkId visible above; do not repeat IDs.`,
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
  // canExplore 분기에서는 본문(systemContent)의 done 게이트가 이 역할을 직접 수행한다.
  // 여기서는 자식 호출이 불가능한 경우(depth >= MAX_DEPTH)의 부가 룰만 남긴다.
  const linkDecisionRules = canExplore
    ? ""
    : `- You cannot explore further links.
- If a linked page looks relevant but could not be visited, mention the missing verification need in missingInfo.
- Do not claim information from unvisited linked pages.`;

  // 할루시네이션 방지 규칙 — 모든 에이전트 깊이에 공통 적용.
  // 페이지에 없는 정보를 학습 데이터로 채우는 것을 명시적으로 금지.
  const groundingRules = `
Critical rules for summary and excerpts:
- Base your summary ONLY on information explicitly stated in this page. Do not supplement with prior knowledge.
- If the page lacks certain details (e.g., exact dates, roles, complete lists), do not infer or assume them — say the page does not contain that information.
- relevantExcerpts must be verbatim quotes from the page. Do not paraphrase or reconstruct.
- If the question asks for historical/all/complete/list-style coverage and this page only contains examples or partial data, mark the report as partial.
${linkDecisionRules}`;

  const systemContent = canExplore
    ? `You are a focused research agent with a specific goal.

Output format requirement (read first): respond with a single JSON object only. No prose, no chain-of-thought, no markdown code fences, no text before or after the JSON. Output exactly one of the JSON shapes shown below and nothing else.

The given web page is your starting point. Your goal may be answerable from this page alone, or it may require following links on this page to other pages — you can dispatch a sub-agent to any linked page, and that sub-agent can in turn dispatch its own sub-agents. Treat link-following as a normal part of the mission, not a last resort.

At each step, choose exactly one of these two options (they are equal choices — neither is the default):
- Explore: dispatch a sub-agent to a linked page on this page (you can do this up to ${MAX_CHILD_CALLS_PER_AGENT} times total during this mission)
- Done: stop and return your final report

Choose \`done\` only when BOTH hold:
(a) no remaining link on this page appears likely to contain additional, more authoritative, or more verifiable information beyond what you have already gathered, AND
(b) you have all the verifiable information explicitly required by the goal.

Important: once you return \`done\`, this page and every page reachable from it are locked — you cannot revisit, extend, or correct the report later. Decide carefully.
${groundingRules}

Link IDs look like [L1], [L2], etc.

Respond with JSON only (no markdown code fences):
Explore: {"action": "explore", "linkId": "L3", "task": "Concise instruction for the sub-agent (treating the chosen linked page as ITS starting point)", "rationale": "Why this link is worth exploring"}
Done:    {"action": "done", "found": true, "completeness": "complete", "summary": "2-5 sentence digest of findings, based on the pages you have visited", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"], "missingInfo": []}
Partial: {"action": "done", "found": true, "completeness": "partial", "summary": "Relevant but incomplete findings, based on the pages you have visited", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"], "missingInfo": ["what is missing"]}

Rules:
- The linkId MUST appear in the page content above. Do not invent IDs.
- For broad questions asking for all/history/complete lists, do not return completeness="complete" unless the information gathered across visited pages explicitly supports full coverage.
- Always omit link IDs from relevantExcerpts
- task: short imperative instruction stating WHAT the sub-agent should find, using the chosen linked page as ITS starting point (the sub-agent may follow further links from there). E.g. "T1 팀 페이지를 기점으로 시즌별 탑라이너 로스터 추출"

If nothing relevant found:
{"action": "done", "found": false, "completeness": "none", "summary": "Page did not contain relevant information.", "relevantExcerpts": [], "missingInfo": []}`
    : `You are a focused research agent with a specific goal.
Analyze the given web page and find information relevant to the goal. You cannot explore further links.
${groundingRules}

Respond with JSON only (no markdown code fences):
{"action": "done", "found": true, "completeness": "complete", "summary": "2-5 sentence digest of relevant findings from this page only", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"], "missingInfo": []}
Partial: {"action": "done", "found": true, "completeness": "partial", "summary": "Relevant but incomplete findings from this page only", "relevantExcerpts": ["up to 3 short verbatim quotes — omit link IDs like [L1]"], "missingInfo": ["what is missing or which verification could not be performed"]}

If nothing relevant found:
{"action": "done", "found": false, "completeness": "none", "summary": "Page did not contain relevant information.", "relevantExcerpts": [], "missingInfo": []}`;

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
    ? `Based on this child report, decide your next action.

Re-apply the same gate: choose \`done\` only when BOTH hold — (a) no remaining unvisited link on the original page appears likely to add or verify information beyond what is already gathered, AND (b) you have all the verifiable information explicitly required by the goal.

Once you return done, the entire chain of pages reachable from your starting point is locked — you cannot revisit. Your final summary must be based only on information explicitly found across the pages visited — do not supplement with prior knowledge.`
    : "No more pages can be explored. Based on all information collected from the pages visited, provide your final report. Include only what was explicitly found — do not supplement with prior knowledge.";

  return {
    role: "user",
    content: `Child exploration result from ${childReport.url}:
found: ${childReport.found}
completeness: ${childReport.completeness}
summary: ${childReport.summary}${excerptText}
missingInfo: ${childReport.missingInfo.length ? childReport.missingInfo.join("; ") : "None"}

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
      const missing = r.missingInfo.length > 0 ? `\nMissing info: ${r.missingInfo.join("; ")}` : "";
      return `--- Source: ${r.url}\nCompleteness: ${r.completeness}\n${r.summary}${missing}${excerpts}`;
    })
    .join("\n\n");

  // 할루시네이션 방지 규칙 — 학습 지식으로 공백을 채우는 것을 명시적으로 금지.
  const groundingRule = `
Critical: Base your answer strictly on the findings provided above. Do not add, infer, or supplement with prior knowledge. If the findings are incomplete or imprecise for any part of the answer, explicitly state what is known and what is uncertain — do not fill gaps from prior knowledge.`;

  const systemContent = serpOnly
    ? `You are a research synthesizer. You receive Google search result snippets for a user's question.
Write a clear, factual answer that directly addresses the question based on the snippets.
Do NOT cite any URLs — the actual pages were not visited, so you cannot verify their content.
If snippets conflict, note the disagreement. If information is insufficient, say so directly.
Do not mention the search process or internal workings. Write for the end user.
Do not offer follow-up help or ask if the user wants more information.${groundingRule}`
    : `You are a research synthesizer. You receive findings from web pages explored on behalf of a user's question.
Write a clear, factual answer (3-6 paragraphs) that directly addresses the question.
Cite sources inline using the URL from each report, like: (source: https://...).
Prefer complete findings over partial findings. If only partial findings are available, make that limitation explicit and avoid presenting the answer as exhaustive.
If reports conflict, note the disagreement. If no useful information was found, say so directly.
Do not mention the exploration process or internal workings. Write for the end user.
Do not offer follow-up help or ask if the user wants more information.${groundingRule}`;

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
