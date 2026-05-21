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

// 오케스트레이터 에이전틱 루프의 전체 라운드 상한 (LLM 판단 횟수).
// search/paginate/explore/explore_parallel 모든 행동이 1라운드를 소비한다.
// done이 라운드 도달 전에 나와야 정상.
export const ORCHESTRATOR_MAX_ROUNDS = 12;

// search + paginate 액션의 합계 상한.
// 같은 쿼리/엔진/페이지 조합이 반복되지 않도록 추가로 dedup 한다.
export const ORCHESTRATOR_MAX_SEARCHES = 5;

// explore + explore_parallel로 디스패치 가능한 누적 explorer 수의 상한.
// (기존 MAX_PAGES와 동일한 의미 — Phase 4에서 오케스트레이터 내부로 이동)
export const ORCHESTRATOR_MAX_EXPLORES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schemas (OpenAI Structured Outputs / json_schema strict 모드)
// ─────────────────────────────────────────────────────────────────────────────
// 각 schema는 LLM 응답이 정확히 한 가지 행동(action) 형태를 따르도록 강제한다.
// anyOf 안의 각 가지가 action 값으로 자기를 구분(discriminated union).
//
// strict 모드 제약:
//   - additionalProperties: false 필수
//   - 모든 property는 required에 포함
//   - 옵션 필드는 type을 ["string", "null"] 같은 union으로 표현 (현재 스키마에는 없음)
//
// 스키마가 응답을 강제하므로 프롬프트에서 "Respond with JSON only..." 같은 예시는 불필요.

const explorerActionExplore = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["explore"] },
    linkId: { type: "string", description: "Link ID such as L3 visible on the current page" },
    task: { type: "string", description: "Concise instruction for the sub-agent" },
    rationale: { type: "string", description: "Why this link is worth exploring" },
  },
  required: ["action", "linkId", "task", "rationale"],
  additionalProperties: false,
} as const;

const explorerActionDone = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["done"] },
    found: { type: "boolean", description: "Whether relevant information was found on the visited pages" },
    completeness: {
      type: "string",
      enum: ["complete", "partial", "none"],
      description: "complete = full answer verified; partial = some gaps; none = nothing relevant",
    },
    summary: { type: "string", description: "2-5 sentence digest based only on visited pages" },
    relevantExcerpts: {
      type: "array",
      items: { type: "string" },
      description: "Up to 3 short verbatim quotes from the visited pages (no link IDs)",
    },
    missingInfo: {
      type: "array",
      items: { type: "string" },
      description: "List of items that the visited pages did not verify; empty when completeness=complete",
    },
  },
  required: ["action", "found", "completeness", "summary", "relevantExcerpts", "missingInfo"],
  additionalProperties: false,
} as const;

// OpenAI Structured Outputs 제약: 루트 스키마는 type: "object"여야 하며 anyOf가 루트에 올 수 없다.
// 따라서 discriminated union은 하나의 속성(`decision`) 안에 anyOf로 감싼다.
// LLM 출력 예: {"decision": {"action": "search", "engine": "google", ...}}
// 호출부는 parseJsonResponse 결과의 .decision 필드를 꺼내 사용한다.
function wrapDecisionSchema(name: string, branches: readonly unknown[]) {
  return {
    name,
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: branches.length === 1 ? branches[0] : { anyOf: branches },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 탐색 에이전트가 자식 호출을 더 할 수 있을 때 사용 (depth < MAX_DEPTH).
// explore / done 둘 다 가능.
export const explorerActionSchemaCanExplore = wrapDecisionSchema("explorer_action", [
  explorerActionExplore,
  explorerActionDone,
]);

// 탐색 에이전트가 자식 호출을 더 할 수 없을 때 (depth >= MAX_DEPTH).
// done만 허용.
export const explorerActionSchemaTerminal = wrapDecisionSchema("explorer_action_terminal", [explorerActionDone]);

const orchestratorActionSearch = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search"] },
    engine: { type: "string", enum: ["google", "naver", "bing"] },
    query: { type: "string", description: "Concise search query" },
    rationale: { type: "string", description: "Why this engine and this query" },
  },
  required: ["action", "engine", "query", "rationale"],
  additionalProperties: false,
} as const;

const orchestratorActionPaginate = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["paginate"] },
    page: { type: "integer", minimum: 1, description: "Target page number (1-based)" },
    rationale: { type: "string" },
  },
  required: ["action", "page", "rationale"],
  additionalProperties: false,
} as const;

const orchestratorActionExploreSingle = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["explore"] },
    linkId: { type: "string", description: "Link ID from the most recent SERP" },
    task: { type: "string", description: "What the sub-agent should find" },
    rationale: { type: "string" },
  },
  required: ["action", "linkId", "task", "rationale"],
  additionalProperties: false,
} as const;

const orchestratorActionExploreParallel = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["explore_parallel"] },
    branches: {
      type: "array",
      minItems: 2,
      maxItems: MAX_PARALLEL,
      items: {
        type: "object",
        properties: {
          linkId: { type: "string" },
          task: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["linkId", "task", "rationale"],
        additionalProperties: false,
      },
    },
    rationale: { type: "string", description: "Why these branches are independent" },
  },
  required: ["action", "branches", "rationale"],
  additionalProperties: false,
} as const;

const orchestratorActionDone = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["done"] },
    reason: { type: "string", description: "Why stopping now; must reference only action results from above" },
  },
  required: ["action", "reason"],
  additionalProperties: false,
} as const;

// 오케스트레이터의 매 라운드 행동.
// 5종 중 정확히 하나. (루트는 wrapDecisionSchema 규약대로 { decision: ... } 형태로 감싸짐.)
export const orchestratorActionSchema = wrapDecisionSchema("orchestrator_action", [
  orchestratorActionSearch,
  orchestratorActionPaginate,
  orchestratorActionExploreSingle,
  orchestratorActionExploreParallel,
  orchestratorActionDone,
]);

// 오케스트레이터 에이전틱 루프의 초기 프롬프트.
// 이 시스템 메시지와 첫 user 메시지 이후, 매 라운드의 action JSON(assistant)과
// action 실행 결과(user)가 append-only로 messages 배열에 추가된다.
// → 시스템 프롬프트는 라운드와 무관하게 고정 → OpenAI prefix cache가 라운드 누적 동안 유지됨.
//
// 어떤 행동(search/paginate/explore/explore_parallel/done)을 언제 할지는 LLM의 자율 판단.
// 종료 조건도 LLM이 휴리스틱으로 결정 — 정보 충분 / 반복 실패 / 관련성 하락.
export function buildOrchestratorInitialPrompt(userQuery: string): LLMMessage[] {
  return [
    {
      role: "system",
      content: `You are a research orchestrator with full autonomy over the search process.

You operate as an agentic loop. Each round you choose ONE action; the system runs it and appends the result to this conversation. Continue until you have enough information to answer the user's question, or until further search is clearly unproductive. Your response is constrained by a JSON schema — choose exactly one of the five action variants.

Available actions:

1. search — fetch a fresh search-engine results page (SERP). You pick engine and query.
   Engines supported:
   - "google": broad English / global web. Default for most topics.
   - "naver": Korean web. Best for Korean-domestic topics — laws, regulations, domestic media, Korean-language documentation, communities.
   - "bing": secondary general web. Sometimes ranks differently from google; useful when google looks saturated.

2. paginate — move to a different page of the CURRENT SERP (same engine, same query).

3. explore — dispatch a sub-agent to one linkId from the current SERP. The sub-agent treats the chosen URL as its starting point and may follow further links itself.

4. explore_parallel — dispatch 2-${MAX_PARALLEL} sub-agents in parallel to independent linkIds from the current SERP.

5. done — terminate and synthesize the answer.

When to choose done — apply these gates strictly:

Pre-done verification gate (must satisfy BEFORE returning done):
- For list, history, "all of X", comprehensive coverage, or "역대/전체/모든" style questions, you MUST run at least one explore on an authoritative source page before done. SERP snippets alone never constitute a verified complete list — they show only the top fragments search engines chose to render.
- For factual questions, prefer at least one explore on an authoritative page unless the SERP snippets contain the exact answer phrased identically across multiple snippets.
- Before choosing done, ask yourself: would an unvisited authoritative-looking candidate on the current SERP plausibly add, complete, or correct a name / date / number / list item? If yes, explore it before done.
- Partial-report follow-up: if ANY explore result you have received above reported completeness="partial" with a non-empty missingInfo, you must take one more targeted action — explore a different SERP candidate, paginate, or run a refined search that addresses that missingInfo — before you may choose done. You may proceed to done despite a partial report only if you have separately tried (in a later round) to fill the gap and that attempt also failed to add verifiable information.
- When reading each explore result, treat its missingInfo field as a literal todo list for your next action, not as a footnote you can ignore.

Conditions that justify done:
- You have explored enough authoritative pages that the visited material directly contains the verifiable information required by the question.
- You have tried several distinct queries / engines / pages and they consistently return low-relevance, spam-like, or repeated results.
- Relevance of new candidates is clearly declining round over round.

Do NOT choose done because:
- "I already know this from training" — your training data is not a permitted source in this loop.
- "The SERP snippets mention some of the items" — partial mention is not verification; for list-style questions, verify the full list on an actual page.

Engine and query strategy:
- Start with whichever engine best fits the topic — naver for Korean-domestic subjects, google otherwise.
- Reformulate the query before reaching for pagination. Change key terms, add qualifiers (year, jurisdiction, technical vocabulary), or switch language (Korean ↔ English).
- Switch engines if one keeps returning irrelevant / spam-like results.
- Do not repeat the exact same (engine, query, page) triple.

Pagination guidance:
- Paginate only when the current page's top candidates look reasonable and you want more of the same kind.
- If the first page is filled with off-topic results, prefer a query change over pagination.

explore vs explore_parallel:
- Parallel for independent branches that all need to be visited (aspect decomposition, comparisons, complementary list sources).
- Serial when later choices depend on earlier results (drill-down, conditional fallback, bridge questions).
- Do not parallel-dispatch redundant or duplicate sources.

Hard limits (the system will inject a notice when a limit is hit; respond by switching strategy or returning done):
- At most ${ORCHESTRATOR_MAX_ROUNDS} total actions.
- At most ${ORCHESTRATOR_MAX_SEARCHES} search/paginate actions combined.
- At most ${ORCHESTRATOR_MAX_EXPLORES} explorer dispatches (each branch of explore_parallel counts as one).

Important:
- linkId must come from the most recent SERP shown above. Do not invent IDs.
- Do not reference content from prior knowledge — only from action results in this conversation.
- The first user message gives the original question. Choose your first action from there.

Grounding rule for done.reason (read carefully):
- The "reason" field of a done action must reference ONLY information that has actually appeared earlier in this conversation as an action result (a SERP snippet or an explore report). It must not contain names, dates, numbers, or facts that have not appeared above.
- If you find yourself wanting to write a "reason" that lists items not present in prior action results, that is a signal to explore one more page rather than stop.
- Acceptable reason: "T1 official roster page confirmed top-laners A, B, C across the seasons listed there." Unacceptable reason: a roll-up of names you remember from training and never saw in any action result above.`,
    },
    {
      role: "user",
      content: `User question: ${userQuery}

Choose your first action.`,
    },
  ];
}

// search/paginate 액션이 성공적으로 SERP를 가져온 뒤 messages에 append할 user 메시지.
// serpSnippets: 링크 ID를 유지한 Main Content 추출 결과.
export function buildSerpResultMessage(
  engine: string,
  query: string,
  page: number,
  serpSnippets: string,
  searchesUsed: number,
  exploresUsed: number
): LLMMessage {
  const body = serpSnippets.trim() || "(no usable results found on this page)";
  return {
    role: "user",
    content: `[SERP — engine=${engine}, query="${query}", page=${page}]
${body}

(searches used: ${searchesUsed}/${ORCHESTRATOR_MAX_SEARCHES}, explorer dispatches used: ${exploresUsed}/${ORCHESTRATOR_MAX_EXPLORES})

Choose your next action.`,
  };
}

// 단일 explore 결과를 messages에 append할 user 메시지.
export function buildExploreResultMessage(report: ExplorationReport, searchesUsed: number, exploresUsed: number): LLMMessage {
  const excerptText =
    report.relevantExcerpts.length > 0
      ? `\nKey excerpts:\n${report.relevantExcerpts.map((e) => `  - ${e}`).join("\n")}`
      : "";
  return {
    role: "user",
    content: `[explore result — ${report.url}]
found: ${report.found}
completeness: ${report.completeness}
summary: ${report.summary}${excerptText}
missingInfo: ${report.missingInfo.length ? report.missingInfo.join("; ") : "None"}

(searches used: ${searchesUsed}/${ORCHESTRATOR_MAX_SEARCHES}, explorer dispatches used: ${exploresUsed}/${ORCHESTRATOR_MAX_EXPLORES})

Choose your next action.`,
  };
}

// explore_parallel 결과(여러 보고)를 한 번에 messages에 append.
export function buildParallelExploreResultMessage(
  reports: ExplorationReport[],
  searchesUsed: number,
  exploresUsed: number
): LLMMessage {
  const body = reports
    .map((r, i) => {
      const excerptText =
        r.relevantExcerpts.length > 0 ? `\n  excerpts: ${r.relevantExcerpts.map((e) => `"${e}"`).join(" | ")}` : "";
      const missing = r.missingInfo.length ? `\n  missingInfo: ${r.missingInfo.join("; ")}` : "";
      return `[${i + 1}] ${r.url}\n  found=${r.found}, completeness=${r.completeness}\n  summary: ${r.summary}${excerptText}${missing}`;
    })
    .join("\n\n");

  return {
    role: "user",
    content: `[parallel explore results — ${reports.length} branches]
${body}

(searches used: ${searchesUsed}/${ORCHESTRATOR_MAX_SEARCHES}, explorer dispatches used: ${exploresUsed}/${ORCHESTRATOR_MAX_EXPLORES})

Choose your next action.`,
  };
}

// 잘못된 액션(파싱 실패, 무효 linkId, 한도 초과 등)에 대한 안내 메시지.
// LLM이 다음 라운드에서 다른 행동을 선택하도록 유도한다.
export function buildOrchestratorErrorMessage(detail: string, searchesUsed: number, exploresUsed: number): LLMMessage {
  return {
    role: "user",
    content: `[action could not be executed] ${detail}

(searches used: ${searchesUsed}/${ORCHESTRATOR_MAX_SEARCHES}, explorer dispatches used: ${exploresUsed}/${ORCHESTRATOR_MAX_EXPLORES})

Choose a different action.`,
  };
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
    ? `You are a focused research agent with a specific goal. Your response is constrained by a JSON schema — choose exactly one of the two action variants (explore or done).

The given web page is your starting point. Your goal may be answerable from this page alone, or it may require following links on this page to other pages — you can dispatch a sub-agent to any linked page, and that sub-agent can in turn dispatch its own sub-agents. Treat link-following as a normal part of the mission, not a last resort.

At each step, choose exactly one of these two options (they are equal choices — neither is the default):
- explore: dispatch a sub-agent to a linked page on this page (you can do this up to ${MAX_CHILD_CALLS_PER_AGENT} times total during this mission)
- done: stop and return your final report

Choose \`done\` only when BOTH hold:
(a) no remaining link on this page appears likely to contain additional, more authoritative, or more verifiable information beyond what you have already gathered, AND
(b) you have all the verifiable information explicitly required by the goal.

Important: once you return \`done\`, this page and every page reachable from it are locked — you cannot revisit, extend, or correct the report later. Decide carefully.
${groundingRules}

Link IDs in the page look like [L1], [L2], etc. The linkId field must reference one of these — do not invent IDs.

Rules for the fields:
- task (explore): short imperative instruction stating WHAT the sub-agent should find, using the chosen linked page as ITS starting point (the sub-agent may follow further links from there). E.g. "T1 팀 페이지를 기점으로 시즌별 탑라이너 로스터 추출"
- relevantExcerpts (done): up to 3 short verbatim quotes. Always omit link IDs like [L1] from quoted text.
- completeness (done): for broad questions asking for all/history/complete lists, do not return "complete" unless the information gathered across visited pages explicitly supports full coverage. Prefer "partial" with explicit missingInfo when in doubt.
- found=false + completeness=none: use when the page did not contain relevant information.`
    : `You are a focused research agent with a specific goal. Your response is constrained by a JSON schema — you must return a done action.
Analyze the given web page and find information relevant to the goal. You cannot explore further links.
${groundingRules}

Rules for the fields:
- relevantExcerpts: up to 3 short verbatim quotes. Always omit link IDs like [L1] from quoted text.
- completeness: "complete" only when this single page explicitly contains all required information; otherwise "partial" with explicit missingInfo, or "none" with found=false if irrelevant.`;

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
