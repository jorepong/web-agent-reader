// Researcher v2 — 단일 재귀 에이전트.
//
// 외부 인터페이스:
//   research(goal, options) → string (자연어 답변)
//
// 내부 재귀:
//   runResearcher(brief) → string
//     - brief.startUrl 있음: 페이지에서 시작 (자식 호출)
//     - brief.startUrl 없음: root는 위임부터, 일반 서브 리서처는 search부터 시작
//   각 행동의 결과는 자연어 메시지로 messages에 append-only.
//   delegate/delegate_parallel 액션은 자기 자신을 재귀 호출.
//
// v1 대비 변화:
//   - 단일 에이전트 타입 (오케스트레이터/탐색 에이전트 구분 없음)
//   - 모든 깊이에서 5종 행동 가능 (단, budget/depth에 따라 동적 스키마로 제한)
//   - 출력이 자연어 문자열 (자식이든 root든 동일 형태)
//   - SharedBudget이 트리 전체의 비용·중복을 관리
//   - 거부 경로 로깅은 v1 패턴 유지 (orchestrator_plan action="rejected")
//
// v1에서 그대로 import해 쓰는 인프라:
//   convertPage, DebugLogger, OpenAIClient, parseJsonResponse, buildSerpUrl, isSupportedEngine
import { convertPage } from "../../index.js";
import type { ConvertResult } from "../../types.js";
import { parseJsonResponse } from "../json-utils.js";
import type { OpenAIClient } from "../openai-client.js";
import { buildSerpUrl, isSupportedEngine, type SearchEngine } from "../search-engines.js";
import { SharedBudget } from "./budget.js";
import type { V2Logger } from "./logger.js";
import {
  buildChildInitialMessages,
  buildDelegateResultMessage,
  buildDoneOnlySchema,
  buildForcedSynthesisMessage,
  buildFullActionSchema,
  buildNoDelegateSchema,
  buildNoPaginateSchema,
  buildNoSearchSchema,
  buildParallelDelegateResultMessage,
  buildResearcherErrorMessage,
  buildRootCoordinatorMessages,
  buildRootInitialDelegateSchema,
  buildRootSchema,
  buildSerpResultMessage,
  buildStartPageFirstSchema,
  buildSubInitialSchema,
  buildSubResearcherInitialMessages,
} from "./prompts.js";
import type { CandidateLink, CurrentSurface, LLMMessage, ResearcherBrief, ResearchOptions, SurfaceKind } from "./types.js";

class CandidateRegistry {
  private nextId = 1;
  private byId: Record<string, CandidateLink> = {};

  registerSurface(result: ConvertResult, surfaceKind: SurfaceKind, surfaceUrl: string): Record<string, CandidateLink> {
    const candidates: Record<string, CandidateLink> = {};
    for (const entry of Object.values(result.links.links)) {
      const id = `C${this.nextId++}`;
      const candidate: CandidateLink = {
        id,
        originalLinkId: entry.id,
        text: entry.text,
        url: entry.url,
        sourcePath: entry.sourcePath,
        surfaceUrl,
        surfaceKind,
      };
      candidates[id] = candidate;
      this.byId[id] = candidate;
    }
    return candidates;
  }

  get(id: string): CandidateLink | undefined {
    return this.byId[id];
  }
}

function rewriteLinkIds(markdown: string, candidates: Record<string, CandidateLink>): string {
  const originalToCandidate = new Map<string, string>();
  for (const candidate of Object.values(candidates)) originalToCandidate.set(candidate.originalLinkId, candidate.id);
  return markdown.replace(/\[L\d+\]/g, (match) => {
    const original = match.slice(1, -1);
    const candidateId = originalToCandidate.get(original);
    return candidateId ? `[${candidateId}]` : match;
  });
}

// SERP 마크다운에서 Main Content 섹션만 추출하고 노이즈 제거.
function extractSerpSnippets(markdown: string, candidates: Record<string, CandidateLink>, keepCandidateIds = false): string {
  const mainMatch = markdown.match(/## Main Content\n([\s\S]*?)(?=\n## |$)/);
  const main = mainMatch ? mainMatch[1] : markdown;
  const rewritten = rewriteLinkIds(main, candidates);

  const skipPrefixes = ["Translate this page", "Read more", "Missing:", "People also search for", "### "];

  return rewritten
    .split("\n")
    .map((line) => (keepCandidateIds ? line.trim() : line.replace(/\s*\[C\d+\]/g, "").trim()))
    .filter((line) => {
      if (!line) return false;
      if (skipPrefixes.some((p) => line.startsWith(p))) return false;
      if (/^\d+:\d+$/.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 한 라운드 동안 LLM에 허용할 행동을 동적으로 결정.
// budget 상태와 currentSurface / 깊이 한도에 따라 스키마를 좁힌다.
function pickSchema(
  brief: ResearcherBrief,
  budget: SharedBudget,
  currentSurface: CurrentSurface | null,
  round: number,
  childCallCount: number
) {
  if (brief.parentAgentId === null) {
    if (childCallCount === 0) return buildRootInitialDelegateSchema(budget.limits.maxParallel);
    return buildRootSchema(budget.limits.maxParallel);
  }

  const hasSurface = currentSurface !== null || brief.startUrl !== undefined;
  const canPaginate = currentSurface?.kind === "serp";
  const canSearch = budget.searchesUsed < budget.limits.maxSearches;
  const canRecurse =
    budget.canRecurseDeeper(brief.depth) && budget.exploresUsed < budget.limits.maxExplores;

  if (!hasSurface) {
    return buildSubInitialSchema();
  }
  if (brief.startUrl && round === 1) {
    return canRecurse ? buildStartPageFirstSchema(budget.limits.maxParallel) : buildDoneOnlySchema();
  }
  if (canSearch && canRecurse && canPaginate) return buildFullActionSchema(budget.limits.maxParallel);
  if (canSearch && canRecurse && !canPaginate) return buildNoPaginateSchema(budget.limits.maxParallel);
  if (canSearch && !canRecurse) return buildNoDelegateSchema(canPaginate);
  if (!canSearch && canRecurse) return buildNoSearchSchema(budget.limits.maxParallel);
  return buildDoneOnlySchema();
}

// 한 라운드의 거부를 일관되게 로깅 + 메시지 주입.
// v1의 reject 헬퍼와 동일한 의도.
function makeRejecter(
  logger: V2Logger,
  agentId: string,
  budget: SharedBudget,
  messages: LLMMessage[]
) {
  return async (round: number, requestedAction: string, reason: string, context: Record<string, unknown> = {}) => {
    await logger.log("orchestrator_plan", agentId, {
      round,
      action: "rejected",
      requestedAction,
      reason,
      ...context,
    });
    messages.push(buildResearcherErrorMessage(reason, budget.summary()));
  };
}

interface ParsedAction {
  action?: string;
  engine?: string;
  query?: string;
  page?: number;
  targetId?: string | null;
  linkId?: string;
  startUrl?: string | null;
  task?: string;
  rationale?: string;
  answer?: string;
  branches?: Array<{ targetId?: string | null; linkId?: string | null; startUrl?: string | null; task?: string; rationale?: string }>;
}

interface DelegateTarget {
  task: string;
  startUrl?: string;
  label: string;
  targetId?: string;
  linkId?: string;
  rationale?: string;
}

function resolveDelegateTarget(
  action: { task?: string; targetId?: string | null; linkId?: string | null; startUrl?: string | null; rationale?: string },
  currentSurface: CurrentSurface | null,
  candidateRegistry: CandidateRegistry
): { ok: true; target: DelegateTarget } | { ok: false; reason: string } {
  if (typeof action.task !== "string" || !action.task.trim()) {
    return { ok: false, reason: `delegate.task is required (natural-language sub-goal).` };
  }

  const targetId = typeof action.targetId === "string" && action.targetId.trim() ? action.targetId.trim() : undefined;
  const linkId = typeof action.linkId === "string" && action.linkId.trim() ? action.linkId.trim() : undefined;
  const rawStartUrl = typeof action.startUrl === "string" && action.startUrl.trim() ? action.startUrl.trim() : undefined;

  const selectorCount = [targetId, linkId, rawStartUrl].filter(Boolean).length;
  if (selectorCount > 1) {
    return { ok: false, reason: `Provide only one of targetId, linkId, or startUrl for delegate.` };
  }

  if (targetId) {
    if (!currentSurface) return { ok: false, reason: `delegate.targetId requires a current SERP/page surface.` };
    const candidate = currentSurface.candidates[targetId];
    if (!candidate) {
      const known = candidateRegistry.get(targetId);
      const stale = known ? ` It appeared on an earlier ${known.surfaceKind} surface and is stale now.` : "";
      return { ok: false, reason: `targetId ${targetId} not found on the current SERP/page.${stale}` };
    }
    return {
      ok: true,
      target: {
        task: action.task.trim(),
        startUrl: candidate.url,
        label: `candidate ${candidate.id}: ${candidate.text} (${candidate.url})`,
        targetId: candidate.id,
        linkId: candidate.originalLinkId,
        rationale: action.rationale,
      },
    };
  }

  if (linkId) {
    if (!currentSurface) return { ok: false, reason: `delegate.linkId requires a current SERP/page surface.` };
    const entry = currentSurface.result.links.links[linkId];
    if (!entry) return { ok: false, reason: `linkId ${linkId} not found on the current SERP/page.` };
    return {
      ok: true,
      target: {
        task: action.task.trim(),
        startUrl: entry.url,
        label: `legacy link ${linkId}: ${entry.text} (${entry.url})`,
        linkId,
        rationale: action.rationale,
      },
    };
  }

  if (rawStartUrl) {
    try {
      const normalized = new URL(rawStartUrl).toString();
      return {
        ok: true,
        target: {
          task: action.task.trim(),
          startUrl: normalized,
          label: `starting URL: ${normalized}`,
          rationale: action.rationale,
        },
      };
    } catch {
      return { ok: false, reason: `delegate.startUrl must be a valid absolute URL.` };
    }
  }

  return {
    ok: true,
    target: {
      task: action.task.trim(),
      label: `task-only delegation: ${action.task.trim()}`,
      rationale: action.rationale,
    },
  };
}

// 재귀 본체.
// 외부 호출자와 자기 자신(재귀)이 동일 인터페이스로 호출.
export async function runResearcher(
  brief: ResearcherBrief,
  client: OpenAIClient,
  logger: V2Logger,
  budget: SharedBudget,
  candidateRegistry: CandidateRegistry = new CandidateRegistry()
): Promise<string> {
  logger.startAgent(brief.agentId, brief.parentAgentId);
  await logger.log("mission_brief", brief.agentId, { brief: { ...brief, budget: undefined } });

  // 초기 messages: startUrl 유무로 분기
  let messages: LLMMessage[];
  let currentSurface: CurrentSurface | null = null;

  if (brief.startUrl) {
    // 자식 리서처: 시작 페이지가 주어짐.
    // budget의 visitedUrls는 부모가 reserveExplore에서 이미 등록했으므로 여기선 안 등록.
    try {
      const result = await convertPage(brief.startUrl, { scroll: true, stealth: true, pageId: brief.agentId });
      await logger.log("page_markdown", brief.agentId, {
        url: brief.startUrl,
        markdown: result.markdown,
        pageId: result.page.pageId,
      });
      const candidates = candidateRegistry.registerSurface(result, "page", brief.startUrl);
      messages = buildChildInitialMessages(
        brief.goal,
        brief.parentGoal,
        brief.startUrl,
        rewriteLinkIds(result.markdown, candidates),
        budget.limits.maxParallel
      );
      // 자식의 시작 페이지를 currentSurface로 둔다 → 페이지의 [C*] 후보를 delegate할 때 동일 메커니즘 사용.
      // 검색 결과가 아니라 일반 페이지지만, links 레지스트리는 같은 형태라 그대로 활용 가능.
      currentSurface = {
        kind: "page",
        engine: "google", // placeholder; paginate는 의미 없으나 schema가 막아주진 않음 — 호출부 검사
        query: "",
        page: 1,
        url: brief.startUrl,
        result,
        candidates,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const fallback = buildEmergencyFallback(brief, `Page could not be loaded: ${detail}`);
      await logger.log("exploration_report", brief.agentId, {
        report: { agentId: brief.agentId, url: brief.startUrl, answer: fallback },
      });
      return fallback;
    }
  } else {
    messages =
      brief.parentAgentId === null
        ? buildRootCoordinatorMessages(brief.goal, budget.limits.maxParallel)
        : buildSubResearcherInitialMessages(brief.goal, brief.parentGoal, budget.limits.maxParallel);
  }

  const reject = makeRejecter(logger, brief.agentId, budget, messages);
  let childCallCount = 0;
  // 각 리서처 자기 자신의 라운드 상한: 자식 호출 + 초기/종결 라운드 여유분.
  const perAgentMaxRounds = budget.limits.maxChildCallsPerAgent + 3;

  for (let round = 1; round <= perAgentMaxRounds; round++) {
    if (budget.roundsRemaining() <= 0) {
      // 트리 전체 라운드 한도 도달 — 누적된 정보로 합성을 강제하여 빈손으로 끝나지 않게 한다.
      return synthesizeFinalAnswer(brief, messages, client, logger, budget, "Tree-wide round budget exhausted.");
    }
    budget.consumeRound();

    const schema = pickSchema(brief, budget, currentSurface, round, childCallCount);
    const { text } = await client.complete(brief.agentId, messages, { responseSchema: schema });

    const wrapper = parseJsonResponse<{ decision?: ParsedAction }>(text);
    const action = wrapper?.decision;
    if (!action || typeof action.action !== "string") {
      messages.push({ role: "assistant", content: text });
      await reject(round, "unknown", "Your previous response had no valid 'decision.action' field.", {
        rawResponsePreview: text.slice(0, 200),
      });
      continue;
    }
    messages.push({ role: "assistant", content: `${JSON.stringify({ decision: action })}\n` });

    if (action.action === "done") {
      // 자연어 답변을 그대로 반환. root든 child든 동일.
      const answer = typeof action.answer === "string" ? action.answer : "";
      await logger.log("orchestrator_plan", brief.agentId, { round, action: "done" });
      await logger.log("exploration_report", brief.agentId, {
        report: { agentId: brief.agentId, url: brief.startUrl ?? "", answer },
      });
      return answer;
    }

    if (action.action === "search") {
      if (typeof action.engine !== "string" || !isSupportedEngine(action.engine)) {
        await reject(round, "search", `Unsupported or missing engine.`, { providedEngine: action.engine });
        continue;
      }
      if (typeof action.query !== "string" || !action.query.trim()) {
        await reject(round, "search", `search.query is required.`);
        continue;
      }
      const engine = action.engine;
      const query = action.query.trim();
      const page = typeof action.page === "number" && action.page >= 1 ? Math.floor(action.page) : 1;

      const res = budget.reserveSearch(engine, query, page);
      if (!res.ok) {
        await reject(round, "search", res.reason, { engine, query, page });
        continue;
      }

      const url = buildSerpUrl(engine, query, page);
      const pageId = `SERP-${brief.agentId}-${round}`;
      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "search",
        engine,
        query,
        page,
        url,
        rationale: action.rationale,
      });

      let result: ConvertResult;
      try {
        result = await convertPage(url, { scroll: false, stealth: true, pageId });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await reject(round, "search", `Failed to load SERP: ${detail}`, { url });
        continue;
      }

      const candidates = candidateRegistry.registerSurface(result, "serp", url);
      const snippets = extractSerpSnippets(result.markdown, candidates, true);
      currentSurface = { kind: "serp", engine, query, page, url, result, candidates };
      await logger.log("page_markdown", brief.agentId, { url, markdown: result.markdown, pageId });
      messages.push(buildSerpResultMessage(engine, query, page, snippets, budget.summary()));
      continue;
    }

    if (action.action === "paginate") {
      if (!currentSurface || currentSurface.kind !== "serp" || !currentSurface.query) {
        await reject(round, "paginate", `paginate requires an active SERP context (no SERP in this researcher yet).`);
        continue;
      }
      if (typeof action.page !== "number" || action.page < 1) {
        await reject(round, "paginate", `paginate.page must be a positive integer.`, { providedPage: action.page });
        continue;
      }
      const engine = currentSurface.engine;
      const query = currentSurface.query;
      const page = Math.floor(action.page);
      const res = budget.reserveSearch(engine, query, page);
      if (!res.ok) {
        await reject(round, "paginate", res.reason, { engine, query, page });
        continue;
      }

      const url = buildSerpUrl(engine, query, page);
      const pageId = `SERP-${brief.agentId}-${round}`;
      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "paginate",
        engine,
        query,
        page,
        url,
        rationale: action.rationale,
      });

      let result: ConvertResult;
      try {
        result = await convertPage(url, { scroll: false, stealth: true, pageId });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await reject(round, "paginate", `Failed to load SERP: ${detail}`, { url });
        continue;
      }

      const candidates = candidateRegistry.registerSurface(result, "serp", url);
      const snippets = extractSerpSnippets(result.markdown, candidates, true);
      currentSurface = { kind: "serp", engine, query, page, url, result, candidates };
      await logger.log("page_markdown", brief.agentId, { url, markdown: result.markdown, pageId });
      messages.push(buildSerpResultMessage(engine, query, page, snippets, budget.summary()));
      continue;
    }

    if (action.action === "delegate") {
      if (!budget.canRecurseDeeper(brief.depth)) {
        await reject(round, "delegate", `Max depth (${budget.limits.maxDepth}) reached at this researcher.`);
        continue;
      }
      if (childCallCount >= budget.limits.maxChildCallsPerAgent) {
        await reject(round, "delegate", `Per-agent child call limit (${budget.limits.maxChildCallsPerAgent}) reached.`);
        continue;
      }
      const resolved = resolveDelegateTarget(action, currentSurface, candidateRegistry);
      if (!resolved.ok) {
        await reject(round, "delegate", resolved.reason, { targetId: action.targetId, linkId: action.linkId, startUrl: action.startUrl });
        continue;
      }
      const reserve = budget.reserveDelegate(resolved.target.startUrl);
      if (!reserve.ok) {
        await reject(round, "delegate", reserve.reason, {
          targetId: action.targetId,
          linkId: action.linkId,
          startUrl: resolved.target.startUrl,
        });
        continue;
      }

      childCallCount++;
      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "delegate",
        targetId: resolved.target.targetId,
        linkId: resolved.target.linkId,
        url: resolved.target.startUrl,
        task: resolved.target.task,
        rationale: action.rationale,
      });

      const childBrief: ResearcherBrief = {
        agentId: `${brief.agentId}-d${round}-${childCallCount}`,
        parentAgentId: brief.agentId,
        goal: resolved.target.task,
        parentGoal: brief.parentGoal,
        startUrl: resolved.target.startUrl,
        depth: brief.depth + 1,
      };

      // 재귀 호출 — 자기 자신을 호출. 자식의 답변은 자연어 문자열.
      const childAnswer = await runResearcher(childBrief, client, logger, budget, candidateRegistry);
      messages.push(buildDelegateResultMessage(resolved.target.label, childAnswer, budget.summary()));
      continue;
    }

    if (action.action === "delegate_parallel") {
      if (!budget.canRecurseDeeper(brief.depth)) {
        await reject(round, "delegate_parallel", `Max depth (${budget.limits.maxDepth}) reached.`);
        continue;
      }
      const remainingPerAgent = budget.limits.maxChildCallsPerAgent - childCallCount;
      const remainingTree = budget.parallelSlotsRemaining();
      const limit = Math.min(remainingPerAgent, remainingTree, budget.limits.maxParallel);
      if (limit <= 0) {
        await reject(round, "delegate_parallel", `No parallel slots remaining (per-agent or budget exhausted).`);
        continue;
      }
      const rawBranches = Array.isArray(action.branches) ? action.branches : [];

      const validBranches: DelegateTarget[] = [];
      for (const b of rawBranches) {
        const resolved = resolveDelegateTarget(b ?? {}, currentSurface, candidateRegistry);
        if (!resolved.ok) continue;
        if (resolved.target.startUrl && validBranches.some((vb) => vb.startUrl === resolved.target.startUrl)) continue;
        const r = budget.reserveDelegate(resolved.target.startUrl);
        if (!r.ok) continue;
        validBranches.push(resolved.target);
        if (validBranches.length >= limit) break;
      }

      if (validBranches.length < 2) {
        await reject(
          round,
          "delegate_parallel",
          validBranches.length === 0
            ? `No valid branches (invalid targetIds/startUrls, missing tasks, or all already visited).`
            : `delegate_parallel requires at least 2 valid branches after filtering; use delegate for a single remaining branch.`,
        );
        continue;
      }

      childCallCount += validBranches.length;
      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "delegate_parallel",
        rationale: action.rationale,
        branches: validBranches.map((vb) => ({ targetId: vb.targetId, linkId: vb.linkId, url: vb.startUrl, task: vb.task, rationale: vb.rationale })),
      });

      const childAnswers = await Promise.all(
        validBranches.map((vb, i) => {
          const childBrief: ResearcherBrief = {
            agentId: `${brief.agentId}-${round}-${i + 1}`,
            parentAgentId: brief.agentId,
            goal: vb.task,
            parentGoal: brief.parentGoal,
            startUrl: vb.startUrl,
            depth: brief.depth + 1,
          };
          return runResearcher(childBrief, client, logger, budget, candidateRegistry);
        })
      );

      messages.push(
        buildParallelDelegateResultMessage(
          validBranches.map((vb, i) => ({ label: vb.label, answer: childAnswers[i] ?? "" })),
          budget.summary()
        )
      );
      continue;
    }

    // 알 수 없는 action — schema가 막아줄 것이지만 방어적 처리.
    await reject(round, String(action.action), `Unknown action "${action.action}".`);
  }

  // 자기 자신의 라운드 한도 소진 — 누적된 정보로 합성을 강제한다.
  return synthesizeFinalAnswer(
    brief,
    messages,
    client,
    logger,
    budget,
    "Per-agent round budget exhausted."
  );
}

// 한도 도달 시 LLM에 done-only 스키마와 함께 한 번 더 호출해 누적된 messages로 답변을 합성한다.
// 어떤 한도든 (트리 라운드 / 에이전트 라운드) 빈손으로 끝나지 않게 한다.
// LLM 호출 자체가 실패하거나 빈 답변이 돌아오면 buildEmergencyFallback으로 최종 폴백.
async function synthesizeFinalAnswer(
  brief: ResearcherBrief,
  messages: LLMMessage[],
  client: OpenAIClient,
  logger: V2Logger,
  budget: SharedBudget,
  reason: string
): Promise<string> {
  messages.push(buildForcedSynthesisMessage(reason, budget.summary()));

  try {
    const schema = buildDoneOnlySchema();
    const { text } = await client.complete(brief.agentId, messages, { responseSchema: schema });
    const wrapper = parseJsonResponse<{ decision?: { answer?: string } }>(text);
    const answer = wrapper?.decision?.answer;
    if (typeof answer === "string" && answer.trim().length > 0) {
      messages.push({ role: "assistant", content: `${JSON.stringify({ decision: wrapper?.decision })}\n` });
      await logger.log("orchestrator_plan", brief.agentId, { round: -1, action: "done", forced: true, reason });
      await logger.log("exploration_report", brief.agentId, {
        report: { agentId: brief.agentId, url: brief.startUrl ?? "", answer },
      });
      return answer;
    }
  } catch {
    // LLM 호출 자체가 실패 — 아래 emergency fallback으로
  }

  const fallback = buildEmergencyFallback(brief, reason);
  await logger.log("exploration_report", brief.agentId, {
    report: { agentId: brief.agentId, url: brief.startUrl ?? "", answer: fallback },
  });
  return fallback;
}

// 마지막 안전망 — 합성 LLM 호출조차 실패한 경우.
// 페이지 로드 실패 같은 명확한 시스템 에러에도 사용.
function buildEmergencyFallback(brief: ResearcherBrief, reason: string): string {
  return `ANSWER:
This researcher could not produce a synthesized answer (${reason}). Goal was: "${brief.goal}".

SOURCES:
(none)

COVERAGE: none

GAPS:
- ${reason}`;
}

// 외부 노출 인터페이스.
// CLI든 다른 LLM 도구든 이 함수 하나만 호출하면 된다.
export async function research(
  goal: string,
  options: ResearchOptions,
  client: OpenAIClient,
  logger: V2Logger
): Promise<string> {
  const budget = new SharedBudget(options.budget);
  const rootBrief: ResearcherBrief = {
    agentId: "researcher-root",
    parentAgentId: null,
    goal,
    parentGoal: goal,
    depth: 0,
  };
  return runResearcher(rootBrief, client, logger, budget);
}
