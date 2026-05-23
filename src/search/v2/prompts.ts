// Researcher v2 프롬프트와 응답 스키마.
// v1의 검증된 가드(grounding, list/history, partial 후속, done.reason 그라운딩 등)를 적응해 가져왔다.
// v1 prompts.ts를 import하지 않는 이유: v2가 독립적으로 진화할 수 있어야 함.
//
// 통합 변화점:
//   - 단일 에이전트(리서처)가 root와 child 모두를 표현
//   - 출력은 자연어 (자식이든 root든) — JSON 구조화 응답 아님
//   - search/paginate/delegate/delegate_parallel/done 행동을 호출 상태별로 허용
//   - 자식에 보내는 호출과 root 호출 모두 같은 인터페이스
import type { LLMMessage } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schemas (OpenAI Structured Outputs / json_schema strict 모드)
//
// 루트 스키마는 type:"object"여야 하며 anyOf 루트는 거부됨.
// 따라서 5종 행동을 { decision: <anyOf 5종> } 형태로 감싼다 (v1과 동일 패턴).
// ─────────────────────────────────────────────────────────────────────────────

const actionSearch = {
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

const actionPaginate = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["paginate"] },
    page: { type: "integer", minimum: 1, description: "Target page number (1-based)" },
    rationale: { type: "string" },
  },
  required: ["action", "page", "rationale"],
  additionalProperties: false,
} as const;

const actionDelegate = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["delegate"] },
    task: { type: "string", description: "Natural-language sub-goal for the child researcher" },
    targetId: {
      type: ["string", "null"],
      description: "Candidate ID such as C12 from the current SERP/page, or null",
    },
    linkId: {
      type: ["string", "null"],
      description: "Deprecated. Use targetId instead. Keep null unless an older prompt explicitly requires linkId.",
    },
    startUrl: {
      type: ["string", "null"],
      description: "Explicit starting URL from prior reports, or null when the child should discover sources itself",
    },
    rationale: { type: "string" },
  },
  required: ["action", "task", "targetId", "linkId", "startUrl", "rationale"],
  additionalProperties: false,
} as const;

function buildActionDelegateParallel(maxParallel: number) {
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["delegate_parallel"] },
      branches: {
        type: "array",
        minItems: 2,
        maxItems: maxParallel,
        items: {
          type: "object",
          properties: {
            task: { type: "string" },
            targetId: { type: ["string", "null"] },
            linkId: { type: ["string", "null"] },
            startUrl: { type: ["string", "null"] },
            rationale: { type: "string" },
          },
          required: ["task", "targetId", "linkId", "startUrl", "rationale"],
          additionalProperties: false,
        },
      },
      rationale: { type: "string", description: "Why these branches are independent" },
    },
    required: ["action", "branches", "rationale"],
    additionalProperties: false,
  } as const;
}

// done의 answer는 자연어 답변 (외부/부모 모두에게 동일한 형태).
// 템플릿 강제(ANSWER/SOURCES/COVERAGE/GAPS)는 프롬프트로 안내하고 스키마에서는 string만 강제.
const actionDone = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["done"] },
    answer: {
      type: "string",
      description:
        "Final natural-language answer in the template format (ANSWER / SOURCES / COVERAGE / GAPS sections).",
    },
  },
  required: ["action", "answer"],
  additionalProperties: false,
} as const;

// 루트는 직접 검색/페이지 열람을 하지 않는다. 자연어 작업을 하위 리서처에게 위임하거나,
// 이미 충분한 보고가 쌓였을 때만 done 한다.
export function buildRootSchema(maxParallel: number) {
  return {
    name: "researcher_action_root",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionDelegate, buildActionDelegateParallel(maxParallel), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

export function buildRootInitialDelegateSchema(maxParallel: number) {
  return {
    name: "researcher_action_root_initial_delegate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionDelegate, buildActionDelegateParallel(maxParallel)] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 페이지 없는 서브 리서처의 첫 행동 — 자기 조사 맥락을 만들기 위해 search부터 시작.
export function buildSubInitialSchema() {
  return {
    name: "researcher_action_sub_initial",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: actionSearch },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 일반 — 검색/페이지네이션/위임/완료 가능.
export function buildFullActionSchema(maxParallel: number) {
  return {
    name: "researcher_action",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: {
          anyOf: [actionSearch, actionPaginate, actionDelegate, buildActionDelegateParallel(maxParallel), actionDone],
        },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 페이지네이션 불가 — 현재 표면이 SERP가 아닐 때 사용.
export function buildNoPaginateSchema(maxParallel: number) {
  return {
    name: "researcher_action_no_paginate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionSearch, actionDelegate, buildActionDelegateParallel(maxParallel), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 위임 불가 (깊이 한도 또는 budget 소진) — delegate/delegate_parallel 제외.
export function buildNoDelegateSchema(canPaginate: boolean) {
  return {
    name: "researcher_action_no_delegate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: canPaginate ? [actionSearch, actionPaginate, actionDone] : [actionSearch, actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 검색도 불가 — 현재 표면에서 위임과 완료만.
export function buildNoSearchSchema(maxParallel: number) {
  return {
    name: "researcher_action_no_search",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionDelegate, buildActionDelegateParallel(maxParallel), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 시작 페이지를 받은 서브 리서처의 첫 행동 — 페이지를 분석하고 done 또는 하위 위임만 가능.
// 첫 라운드 search는 스키마로 차단한다.
export function buildStartPageFirstSchema(maxParallel: number) {
  return {
    name: "researcher_action_start_page_first",
    strict: true,
    schema: {
      type: "object",
      properties: {
        decision: { anyOf: [actionDelegate, buildActionDelegateParallel(maxParallel), actionDone] },
      },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// 모든 행동 불가 — done만 강제.
export function buildDoneOnlySchema() {
  return {
    name: "researcher_action_done_only",
    strict: true,
    schema: {
      type: "object",
      properties: { decision: actionDone },
      required: ["decision"],
      additionalProperties: false,
    },
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// 프롬프트
// ─────────────────────────────────────────────────────────────────────────────

// 자연어 답변 템플릿 — 모든 리서처의 출력 형태.
// 부모 리서처의 LLM과 외부 호출자가 동일한 형식으로 파싱 가능.
const ANSWER_TEMPLATE = `Your final \`done.answer\` MUST follow this exact template (sections in this order):

ANSWER:
<concise natural-language answer addressing the goal. Cite sources inline as "(source: https://...)".>

SOURCES:
- <url 1>
- <url 2>
(If you used SERP snippets only, list "SERP only — pages not verified" and omit URLs.)

COVERAGE: <complete | partial | none>

GAPS:
- <missing item 1>
- <missing item 2>

NEXT_CANDIDATES:
- <url or short candidate description> — <why it may help>
(Use a single line "(none)" if no follow-up candidates.)`;

// 모든 리서처가 공유하는 시스템 프롬프트의 본문 (정책 가드).
// v1의 검증된 게이트를 그대로 가져옴.
const POLICY_GUARDS = `Decision policy — apply these gates strictly:

Pre-done verification gate (must satisfy BEFORE returning done):
- For list, history, "all of X", comprehensive coverage, or "역대/전체/모든" style questions, you MUST delegate at least one authoritative source page for deep reading before done. Search snippets alone never constitute a verified complete list.
- For factual questions, prefer at least one delegated authoritative page read unless multiple SERP snippets phrase the exact answer identically.
- Before choosing done, ask yourself: would an unvisited authoritative-looking candidate plausibly add, complete, or correct a name / date / number / list item? If yes, delegate it first.
- Partial-report follow-up: if a previous child report you have received reported "COVERAGE: partial" with non-empty "GAPS:", you must take one more targeted action — delegate another candidate, paginate, or refine search — before you may choose done. Proceed to done despite partial only after such a follow-up also fails.
- Treat each child report's GAPS as a literal todo list for your next action.

Do NOT choose done because:
- "I already know this from training" — your training data is not a permitted source.
- "The SERP snippets mention some of the items" — partial mention is not verification for list-style questions.

Engine and query strategy (when you choose search):
- "google": broad English / global web. Default for most topics.
- "naver": Korean web — laws, regulations, domestic media, Korean-language sources.
- "bing": secondary general web; useful when google looks saturated.
- Reformulate query before reaching for pagination. Change key terms, add qualifiers (year, jurisdiction, technical vocab), switch language (Korean ↔ English).
- Do not repeat the exact same (engine, query, page) triple.

Pagination guidance:
- Paginate only when the current first page has reasonable candidates and you want more of the same kind.
- If page 1 is filled with off-topic results, prefer a query change over pagination.

delegate vs delegate_parallel:
- Delegate when a candidate needs deep reading, independent verification, or a separate source family investigation.
- Stay in your own context for query reformulation, SERP pagination, and candidate triage.
- Use delegate_parallel when 2-__MAX_PARALLEL__ branches are independent and ALL are worth checking.
- Do NOT parallel-dispatch duplicates or paraphrases of the same primary source.

Grounding rules for answers:
- Base your answer ONLY on information that appeared in this conversation (SERP snippets or child reports). Do not supplement with prior knowledge.
- If the visited pages lack a detail (exact dates, full lists, roles), do not infer it — say so in GAPS.
- Source URLs cited must be ones actually returned in action results above.`;

function policyGuards(maxParallel: number): string {
  return POLICY_GUARDS.replace("__MAX_PARALLEL__", String(maxParallel));
}

// 리서처 시스템 프롬프트 — root와 child 통합.
// startUrl 유무에 따라 첫 user 메시지가 달라질 뿐, 시스템 프롬프트는 동일.
export function buildResearcherSystemPrompt(maxParallel: number): string {
  return `You are a Researcher — a recursive natural-language research agent.

You receive a goal in natural language and produce a natural-language answer. You may dispatch sub-Researchers (which are instances of yourself) to investigate specific URLs in parallel or serially. The interface to a sub-Researcher is identical to your own: you give it a natural-language task and a starting URL, and it returns a natural-language answer in the same template you must follow.

You operate as an agentic loop. Each round you choose exactly one action; the system runs it and appends the result to this conversation. Continue until you have enough information to answer the goal, or until further search is clearly unproductive.

Available actions (subject to per-round constraints — the schema will only allow currently valid ones):

1. search — fetch a fresh search-engine results page (SERP). Available to sub-Researchers, not the root.
2. paginate — move to a different page of the CURRENT SERP.
3. delegate — dispatch a sub-Researcher with a natural-language task. Optionally provide a targetId from the current surface or an explicit startUrl from prior reports.
4. delegate_parallel — dispatch 2-${maxParallel} sub-Researchers in parallel to independent tasks.
5. done — terminate with your final natural-language answer.

${policyGuards(maxParallel)}

${ANSWER_TEMPLATE}

Important:
- targetId in delegate/delegate_parallel MUST be a candidate ID like [C12] from the most recent SERP or page result shown above. Do not invent IDs. Do not use stale candidate IDs from earlier SERPs.
- linkId is deprecated; keep it null unless the current message explicitly shows old-style [L*] IDs.
- startUrl in delegate/delegate_parallel may be an explicit URL that appeared in a previous child report; use null if the child should discover sources itself.
- task in delegate/delegate_parallel is the child's natural-language input. It should be self-contained and expressed in terms of the user's overall goal.
- Once you return done, this branch is locked — you cannot revisit. Make sure the verification gates are satisfied first.`;
}

// 루트 전용 초기 메시지. 루트는 직접 검색/페이지 열람을 하지 않고, 하위 리서처의 자연어
// 보고만 보고 최종 판단을 내린다.
export function buildRootCoordinatorMessages(goal: string, maxParallel: number): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `Goal: ${goal}

You are the root Researcher. You do not directly search, open, or read pages. Delegate natural-language research tasks to sub-Researchers, compare their reports, and return the final answer when the reports are sufficient.

Your first action should normally be delegate or delegate_parallel. Use done only when the request can be answered from already-provided child reports.`,
    },
  ];
}

// 페이지 없는 서브 리서처의 초기 메시지. 이 호출은 루트가 자연어 작업만 넘긴 경우다.
export function buildSubResearcherInitialMessages(goal: string, parentGoal: string, maxParallel: number): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `Goal: ${goal}
Original user question: ${parentGoal}

You are a sub-Researcher with no starting URL. Create an investigation context yourself: search, reformulate queries, paginate SERPs when useful, and triage candidates. Delegate deep reading of specific candidate pages to child Researchers instead of pulling long page bodies into your own context.`,
    },
  ];
}

// startUrl이 주어진 child researcher의 초기 user 메시지.
// 페이지 본문은 첫 user 메시지에 포함되어 LLM이 즉시 분석 가능.
//
// 중요: 시작 페이지가 주어진 자식은 *반드시 그 페이지를 먼저 분석*해야 한다.
// 부모는 이 페이지가 goal을 해결할 수 있다고 판단해서 자식을 디스패치했다.
// 첫 행동으로 search를 선택하는 것은 부모의 판단을 무시하고 새 탐색을 시작하는
// 것이므로 비효율적. 따라서 첫 행동을 done/delegate로 제한한다.
export function buildChildInitialMessages(
  goal: string,
  parentGoal: string,
  startUrl: string,
  pageMarkdown: string,
  maxParallel: number
): LLMMessage[] {
  return [
    { role: "system", content: buildResearcherSystemPrompt(maxParallel) },
    {
      role: "user",
      content: `Goal: ${goal}
Original user question: ${parentGoal}
Starting URL: ${startUrl}

You are a sub-Researcher. A starting URL has been visited for you; its content is below.
Treat the page below as a verified page read for this branch. If you use facts from it, cite the Starting URL in SOURCES and inline source citations.

Your first action MUST analyze THIS PAGE:
- If this page directly contains enough information to address the goal, choose done immediately and write the answer.
- If this page does not directly answer but contains relevant linked pages (look for [C*] candidate IDs in the content), choose delegate or delegate_parallel to send those pages to child Researchers.
- Do NOT choose search as your first action. Your parent dispatched you here because this page (and pages linked from it) is the right starting point. Only consider search after you have established that this page and its links cannot lead to the answer.

Page content:
${pageMarkdown}`,
    },
  ];
}

// search/paginate 결과를 messages에 append.
export function buildSerpResultMessage(
  engine: string,
  query: string,
  page: number,
  serpSnippets: string,
  budgetSummary: string
): LLMMessage {
  const body = serpSnippets.trim() || "(no usable results found on this page)";
  return {
    role: "user",
    content: `[SERP — engine=${engine}, query="${query}", page=${page}]
${body}

(${budgetSummary})

Choose your next action.`,
  };
}

// 단일 delegate 자식 답변을 messages에 append.
// 자식 답변은 이미 ANSWER/SOURCES/COVERAGE/GAPS 템플릿 형식의 자연어이므로 그대로 첨부.
export function buildDelegateResultMessage(childLabel: string, childAnswer: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[Child Researcher result — ${childLabel}]
${childAnswer}

(${budgetSummary})

Re-apply the partial-report follow-up gate: if the child reported "COVERAGE: partial" with non-empty GAPS, take one more targeted action before considering done. Choose your next action.`,
  };
}

// 병렬 delegate 자식들의 답변을 한꺼번에 messages에 append.
export function buildParallelDelegateResultMessage(
  children: Array<{ label: string; answer: string }>,
  budgetSummary: string
): LLMMessage {
  const body = children
    .map((c, i) => `[${i + 1}] ${c.label}\n${c.answer}`)
    .join("\n\n---\n\n");
  return {
    role: "user",
    content: `[Parallel child Researchers — ${children.length} branches]
${body}

(${budgetSummary})

Re-apply the partial-report follow-up gate: if any child reported "COVERAGE: partial" with non-empty GAPS, take one more targeted action before considering done. Choose your next action.`,
  };
}

// 거부 / 안내 메시지 (잘못된 입력 / 한도 소진 등).
export function buildResearcherErrorMessage(detail: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[Action could not be executed] ${detail}

(${budgetSummary})

Choose a different action.`,
  };
}

// 한도 임박 경고. round나 budget이 얼마 남지 않았을 때 주입.
export function buildBudgetWarningMessage(detail: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[Budget notice] ${detail}

(${budgetSummary})

Prioritize wrapping up — answer the goal with what you have, or take one final targeted action before done.`,
  };
}

// 한도 도달로 더 이상 행동을 못 할 때, 강제로 done 합성을 유도하는 메시지.
// LLM에 done-only 스키마와 함께 보내, 누적된 messages 만으로 최선의 답변을 생성하게 한다.
export function buildForcedSynthesisMessage(reason: string, budgetSummary: string): LLMMessage {
  return {
    role: "user",
    content: `[Limit reached — synthesize now] ${reason}. You cannot take any more search or delegate actions.

Synthesize your final answer using ONLY the information that has already appeared in this conversation (SERP snippets, child reports, your own page reads). Follow the ANSWER / SOURCES / COVERAGE / GAPS template. Set COVERAGE honestly based on what you have gathered; list any unresolved items in GAPS. Do not refuse — even if information is incomplete, return the best partial answer you can from what you already have.

(${budgetSummary})`,
  };
}
