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
import { activateLink, convertPage } from "../../index.js";
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
  buildPageSectionReadResultMessage,
  buildReadSectionsOrDoneSchema,
  buildResearcherErrorMessage,
  buildRootCoordinatorMessages,
  buildRootInitialDelegateSchema,
  buildRootSchema,
  buildSectionSelectionMessages,
  buildSectionSelectionSchema,
  buildSerpResultMessage,
  buildStartPageFirstSchema,
  buildSubInitialSchema,
  buildSubResearcherInitialMessages,
} from "./prompts.js";
import {
  buildSectionedMarkdown,
  defaultSectionIds,
  formatSectionOutline,
  selectSectionMarkdown,
} from "./sections.js";
import type { ActivateTarget, CandidateLink, CurrentSurface, LLMMessage, ResearcherBrief, ResearchOptions, RuntimeContext, SurfaceKind } from "./types.js";

const SECTION_SELECTION_THRESHOLD_CHARS = 40_000;
const MAX_SELECTED_PAGE_CHARS = 60_000;
const MAX_SCHEMA_CANDIDATE_IDS = 400;

function buildRuntimeContext(now = new Date()): RuntimeContext {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const localDateTime = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);
  return {
    currentDateTime: `${localDateTime} (${timeZone}; ISO ${now.toISOString()})`,
  };
}

class CandidateRegistry {
  private nextId = 1;
  private byId: Record<string, CandidateLink> = {};

  registerSurface(result: ConvertResult, surfaceKind: SurfaceKind, surfaceUrl: string): Record<string, CandidateLink> {
    const candidates: Record<string, CandidateLink> = {};
    for (const entry of Object.values(result.links.links)) {
      const id = `C${this.nextId++}`;
      const isActivate = entry.resolution === "activate" && Boolean(entry.locator);
      const candidate: CandidateLink = {
        id,
        originalLinkId: entry.id,
        text: entry.text,
        // activate 후보는 실 URL이 없으므로 예산 중복방지가 동작하도록 합성 키를 넣는다.
        url: isActivate ? `activate:${surfaceUrl}#${entry.locator!.text}` : entry.url,
        sourcePath: entry.sourcePath,
        surfaceUrl,
        surfaceKind,
        ...(isActivate ? { resolution: "activate" as const, locator: entry.locator } : {}),
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

function visibleCandidateIds(markdown: string): string[] {
  return Array.from(new Set((markdown.match(/\[C\d+\]/g) ?? []).map((match) => match.slice(1, -1))));
}

function limitVisibleCandidates(markdown: string): { markdown: string; visibleIds: string[]; omittedCount: number } {
  const visibleIds = visibleCandidateIds(markdown);
  if (visibleIds.length <= MAX_SCHEMA_CANDIDATE_IDS) return { markdown, visibleIds, omittedCount: 0 };

  const allowed = new Set(visibleIds.slice(0, MAX_SCHEMA_CANDIDATE_IDS));
  const filteredMarkdown = markdown.replace(/\[C\d+\]/g, (match) => {
    const id = match.slice(1, -1);
    return allowed.has(id) ? match : "";
  });
  return {
    markdown: filteredMarkdown,
    visibleIds: visibleIds.slice(0, MAX_SCHEMA_CANDIDATE_IDS),
    omittedCount: visibleIds.length - MAX_SCHEMA_CANDIDATE_IDS,
  };
}

function mergeVisibleCandidateIds(existing: string[], next: string[]): string[] {
  const merged: string[] = [];
  for (const id of [...existing, ...next]) {
    if (!merged.includes(id)) merged.push(id);
    if (merged.length >= MAX_SCHEMA_CANDIDATE_IDS) break;
  }
  return merged;
}

function availableVisibleCandidateIds(currentSurface: CurrentSurface | null, visitedUrls: Set<string>): string[] {
  if (!currentSurface) return [];
  return currentSurface.visibleCandidateIds.filter((id) => {
    const candidate = currentSurface.candidates[id];
    return Boolean(candidate) && !visitedUrls.has(candidate.url);
  });
}

function stripSectionPreviews(outline: string): string {
  return outline.replace(/\s+\|\s+미리보기="[^"]*"/g, "");
}

function formatCandidateStatus(
  candidates: Record<string, CandidateLink>,
  candidateIds: string[],
  visitedUrls: Set<string>,
  maxRows = 40
): string {
  const rows = candidateIds
    .map((id) => candidates[id])
    .filter((candidate): candidate is CandidateLink => Boolean(candidate))
    .slice(0, maxRows)
    .map((candidate) => {
      const status = visitedUrls.has(candidate.url) ? "이미 방문함" : "사용 가능";
      return `[${candidate.id}] ${status} — ${candidate.text} — ${candidate.url}`;
    });
  if (rows.length === 0) return "";
  if (candidateIds.length > maxRows) rows.push(`... 표시 후보 ${candidateIds.length - maxRows}개는 상태 목록에서 생략됨`);
  return rows.join("\n");
}

interface ParsedSectionSelection {
  readWholePage?: boolean;
  sectionIds?: string[];
  rationale?: string;
}

interface PreparedPageRead {
  markdown: string;
  selectedIds: string[];
  sectioned?: ReturnType<typeof buildSectionedMarkdown>;
  outline?: string;
}

async function preparePageReadMarkdown(
  brief: ResearcherBrief,
  result: ConvertResult,
  candidates: Record<string, CandidateLink>,
  client: OpenAIClient,
  logger: V2Logger,
  budget: SharedBudget
): Promise<PreparedPageRead> {
  const rewritten = rewriteLinkIds(result.markdown, candidates);
  if (rewritten.length <= SECTION_SELECTION_THRESHOLD_CHARS) return { markdown: rewritten, selectedIds: [] };

  const sectioned = buildSectionedMarkdown(rewritten);
  if (sectioned.sections.length <= 1) return { markdown: rewritten, selectedIds: [] };

  const outline = formatSectionOutline(sectioned.sections);
  await logger.log("page_sections", brief.agentId, {
    url: brief.startUrl,
    totalChars: rewritten.length,
    sectionCount: sectioned.sections.length,
    outline,
  });

  let selection: ParsedSectionSelection | undefined;
  try {
    const { text } = await client.complete(
      brief.agentId,
      buildSectionSelectionMessages(
        brief.goal,
        brief.parentGoal,
        brief.startUrl ?? result.page.sourceUrl,
        outline,
        rewritten.length,
        budget.limits.maxParallel,
        brief.runtimeContext?.currentDateTime
      ),
      { responseSchema: buildSectionSelectionSchema(), reasoningEffort: "low" }
    );
    selection = parseJsonResponse<{ selection?: ParsedSectionSelection }>(text)?.selection;
  } catch (err) {
    await logger.log("page_section_selection", brief.agentId, {
      url: brief.startUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const validIds = new Set(sectioned.sections.map((section) => section.id));
  const requestedIds = Array.isArray(selection?.sectionIds)
    ? selection.sectionIds.filter((id) => typeof id === "string" && validIds.has(id))
    : [];
  const fallbackIds = requestedIds.length > 0 ? requestedIds : defaultSectionIds(sectioned);
  const selected = selectSectionMarkdown(sectioned, fallbackIds, {
    readWholePage: selection?.readWholePage === true,
    maxChars: MAX_SELECTED_PAGE_CHARS,
  });

  await logger.log("page_section_selection", brief.agentId, {
    url: brief.startUrl,
    readWholePage: selection?.readWholePage === true,
    requestedIds,
    selectedIds: selected.selectedIds,
    selectedChars: selected.markdown.length,
    truncated: selected.truncated,
    rationale: selection?.rationale,
  });

  return {
    markdown: `${brief.startUrl ?? result.page.sourceUrl}에서 선택한 페이지 섹션입니다.
읽지 않은 섹션에 관련 세부 정보가 남아 있을 수 있습니다. 범위가 불완전하면 추론하지 말고 부족한 점을 보고하세요.

${selected.markdown}`,
    selectedIds: selected.selectedIds,
    sectioned,
    outline: stripSectionPreviews(outline),
  };
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
  const canDelegate =
    budget.canRecurseDeeper(brief.depth) &&
    budget.exploresUsed < budget.limits.maxExplores &&
    childCallCount < budget.limits.maxChildCallsPerAgent;
  const parallelLimit = Math.min(
    budget.limits.maxParallel,
    Math.max(0, budget.limits.maxChildCallsPerAgent - childCallCount),
    budget.parallelSlotsRemaining()
  );
  const candidateIds = availableVisibleCandidateIds(currentSurface, budget.visitedUrls);
  const canReadSections = currentSurface?.kind === "page" && Boolean(currentSurface.pageSections);

  if (brief.parentAgentId === null) {
    if (!canDelegate) return buildDoneOnlySchema();
    if (childCallCount === 0) return buildRootInitialDelegateSchema(parallelLimit, candidateIds);
    return buildRootSchema(parallelLimit, candidateIds);
  }

  const hasSurface = currentSurface !== null || brief.startUrl !== undefined;
  const canPaginate = currentSurface?.kind === "serp";
  const canSearch = budget.searchesUsed < budget.limits.maxSearches;

  if (!hasSurface) {
    return buildSubInitialSchema();
  }
  if (brief.startUrl && round === 1) {
    return canDelegate ? buildStartPageFirstSchema(parallelLimit, candidateIds, canReadSections) : (canReadSections ? buildReadSectionsOrDoneSchema() : buildDoneOnlySchema());
  }
  if (canSearch && canDelegate && canPaginate) return buildFullActionSchema(parallelLimit, candidateIds, canReadSections);
  if (canSearch && canDelegate && !canPaginate) return buildNoPaginateSchema(parallelLimit, candidateIds, canReadSections);
  if (canSearch && !canDelegate) return buildNoDelegateSchema(canPaginate, canReadSections);
  if (!canSearch && canDelegate) return buildNoSearchSchema(parallelLimit, candidateIds, canReadSections);
  if (canReadSections) return buildReadSectionsOrDoneSchema();
  return buildDoneOnlySchema();
}

function actionReasoningEffort(schemaName: string, currentSurface: CurrentSurface | null): "medium" | "high" {
  void schemaName;
  void currentSurface;
  return "high";
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
  sectionIds?: unknown;
  branches?: Array<{ targetId?: string | null; linkId?: string | null; startUrl?: string | null; task?: string; rationale?: string }>;
}

interface DelegateTarget {
  task: string;
  startUrl?: string;
  label: string;
  targetId?: string;
  linkId?: string;
  rationale?: string;
  // 비-앵커 카드로의 위임이면, 자식은 startUrl을 convertPage가 아니라 클릭으로 해소한다.
  activate?: ActivateTarget;
}

function resolveDelegateTarget(
  action: { task?: string; targetId?: string | null; linkId?: string | null; startUrl?: string | null; rationale?: string },
  currentSurface: CurrentSurface | null,
  candidateRegistry: CandidateRegistry
): { ok: true; target: DelegateTarget } | { ok: false; reason: string } {
  if (typeof action.task !== "string" || !action.task.trim()) {
    return { ok: false, reason: `delegate.task가 필요합니다. 자연어 하위 목표를 제공하세요.` };
  }

  const targetId = typeof action.targetId === "string" && action.targetId.trim() ? action.targetId.trim() : undefined;
  const linkId = typeof action.linkId === "string" && action.linkId.trim() ? action.linkId.trim() : undefined;
  const rawStartUrl = typeof action.startUrl === "string" && action.startUrl.trim() ? action.startUrl.trim() : undefined;

  const selectorCount = [targetId, linkId, rawStartUrl].filter(Boolean).length;
  if (selectorCount > 1) {
    return { ok: false, reason: `delegate에는 targetId, linkId, startUrl 중 하나만 제공하세요.` };
  }

  if (targetId) {
    if (!currentSurface) return { ok: false, reason: `delegate.targetId를 사용하려면 현재 SERP 또는 페이지 표면이 필요합니다.` };
    const candidate = currentSurface.candidates[targetId];
    if (!candidate) {
      const known = candidateRegistry.get(targetId);
      const stale = known ? ` 이 ID는 이전 ${known.surfaceKind} 표면에 있었으므로 지금은 오래된 후보입니다.` : "";
      return { ok: false, reason: `현재 SERP 또는 페이지에서 targetId ${targetId}를 찾을 수 없습니다.${stale}` };
    }
    const activate: ActivateTarget | undefined =
      candidate.resolution === "activate" && candidate.locator
        ? { pageUrl: candidate.surfaceUrl, locator: candidate.locator }
        : undefined;
    const label = activate
      ? `후보 ${candidate.id}: ${candidate.text} (클릭으로 해소: ${candidate.surfaceUrl})`
      : `후보 ${candidate.id}: ${candidate.text} (${candidate.url})`;
    return {
      ok: true,
      target: {
        task: action.task.trim(),
        startUrl: candidate.url,
        label,
        targetId: candidate.id,
        linkId: candidate.originalLinkId,
        rationale: action.rationale,
        activate,
      },
    };
  }

  if (linkId) {
    if (!currentSurface) return { ok: false, reason: `delegate.linkId를 사용하려면 현재 SERP 또는 페이지 표면이 필요합니다.` };
    const entry = currentSurface.result.links.links[linkId];
    if (!entry) return { ok: false, reason: `현재 SERP 또는 페이지에서 linkId ${linkId}를 찾을 수 없습니다.` };
    return {
      ok: true,
      target: {
        task: action.task.trim(),
        startUrl: entry.url,
        label: `이전 형식 링크 ${linkId}: ${entry.text} (${entry.url})`,
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
      return { ok: false, reason: `delegate.startUrl은 유효한 절대 URL이어야 합니다.` };
    }
  }

  return {
    ok: true,
    target: {
      task: action.task.trim(),
      label: `작업만 위임: ${action.task.trim()}`,
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
      // 일반 위임은 startUrl을 convertPage로, activate 위임은 부모 표면에서 카드를 클릭해 해소한다.
      const result = brief.activate
        ? await activateLink(brief.activate.pageUrl, brief.activate.locator, { scroll: true, stealth: true, pageId: brief.agentId })
        : await convertPage(brief.startUrl, { scroll: true, stealth: true, pageId: brief.agentId });
      const resolvedUrl = result.page.sourceUrl;
      await logger.log("page_markdown", brief.agentId, {
        url: resolvedUrl,
        activatedFrom: brief.activate ? brief.activate.pageUrl : undefined,
        markdown: result.markdown,
        pageId: result.page.pageId,
      });
      const candidates = candidateRegistry.registerSurface(result, "page", resolvedUrl);
      const prepared = await preparePageReadMarkdown(brief, result, candidates, client, logger, budget);
      const limited = limitVisibleCandidates(prepared.markdown);
      if (limited.omittedCount > 0) {
        await logger.log("page_section_selection", brief.agentId, {
          url: resolvedUrl,
          schemaCandidateLimit: MAX_SCHEMA_CANDIDATE_IDS,
          omittedCandidateIds: limited.omittedCount,
        });
      }
      const candidateStatus = formatCandidateStatus(candidates, limited.visibleIds, budget.visitedUrls);
      messages = buildChildInitialMessages(
        brief.goal,
        brief.parentGoal,
        resolvedUrl,
        limited.markdown,
        budget.limits.maxParallel,
        candidateStatus,
        prepared.outline,
        brief.runtimeContext?.currentDateTime
      );
      // 자식의 시작 페이지를 currentSurface로 둔다 → 페이지의 [C*] 후보를 delegate할 때 동일 메커니즘 사용.
      // 검색 결과가 아니라 일반 페이지지만, links 레지스트리는 같은 형태라 그대로 활용 가능.
      currentSurface = {
        kind: "page",
        engine: "google", // placeholder; paginate는 의미 없으나 schema가 막아주진 않음 — 호출부 검사
        query: "",
        page: 1,
        url: resolvedUrl,
        result,
        candidates,
        visibleCandidateIds: limited.visibleIds,
        pageSections:
          prepared.sectioned && prepared.outline
            ? { sectioned: prepared.sectioned, outline: prepared.outline, readSectionIds: prepared.selectedIds }
            : undefined,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const fallback = buildEmergencyFallback(brief, `페이지를 불러올 수 없음: ${detail}`);
      await logger.log("exploration_report", brief.agentId, {
        report: { agentId: brief.agentId, url: brief.startUrl, answer: fallback },
      });
      return fallback;
    }
  } else {
    messages =
      brief.parentAgentId === null
        ? buildRootCoordinatorMessages(brief.goal, budget.limits.maxParallel, brief.runtimeContext?.currentDateTime)
        : buildSubResearcherInitialMessages(brief.goal, brief.parentGoal, budget.limits.maxParallel, brief.runtimeContext?.currentDateTime);
  }

  const reject = makeRejecter(logger, brief.agentId, budget, messages);
  let childCallCount = 0;
  // 각 리서처 자기 자신의 라운드 상한: 자식 호출 + 초기/종결 라운드 여유분.
  const perAgentMaxRounds = budget.limits.maxChildCallsPerAgent + 3;

  for (let round = 1; round <= perAgentMaxRounds; round++) {
    if (budget.roundsRemaining() <= 0) {
      // 트리 전체 라운드 한도 도달 — 누적된 정보로 합성을 강제하여 빈손으로 끝나지 않게 한다.
      return synthesizeFinalAnswer(brief, messages, client, logger, budget, "트리 전체 라운드 예산이 소진되었습니다.");
    }
    budget.consumeRound();

    const schema = pickSchema(brief, budget, currentSurface, round, childCallCount);
    const { text } = await client.complete(brief.agentId, messages, {
      responseSchema: schema,
      reasoningEffort: actionReasoningEffort(schema.name, currentSurface),
    });

    const wrapper = parseJsonResponse<{ decision?: ParsedAction }>(text);
    const action = wrapper?.decision;
    if (!action || typeof action.action !== "string") {
      messages.push({ role: "assistant", content: text });
      await reject(round, "unknown", "이전 응답에 유효한 'decision.action' 필드가 없습니다.", {
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

    if (action.action === "read_sections") {
      if (!currentSurface || currentSurface.kind !== "page" || !currentSurface.pageSections) {
        await reject(round, "read_sections", `read_sections를 사용하려면 섹션 목록이 있는 현재 페이지가 필요합니다.`);
        continue;
      }

      const requestedIds = Array.isArray(action.sectionIds)
        ? action.sectionIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      if (requestedIds.length === 0) {
        await reject(round, "read_sections", `read_sections.sectionIds에는 섹션 ID가 하나 이상 있어야 합니다.`);
        continue;
      }
      const validSectionIds = new Set(currentSurface.pageSections.sectioned.sections.map((section) => section.id));
      const validRequestedIds = requestedIds.filter((id) => validSectionIds.has(id));
      if (validRequestedIds.length === 0) {
        await reject(round, "read_sections", `요청한 섹션 ID가 현재 페이지에 존재하지 않습니다.`, { requestedIds });
        continue;
      }

      const selected = selectSectionMarkdown(currentSurface.pageSections.sectioned, validRequestedIds, {
        readWholePage: false,
        maxChars: MAX_SELECTED_PAGE_CHARS,
      });
      currentSurface.pageSections.readSectionIds = Array.from(
        new Set([...currentSurface.pageSections.readSectionIds, ...selected.selectedIds])
      );

      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "read_sections",
        url: currentSurface.url,
        sectionIds: selected.selectedIds,
        requestedIds,
        rationale: action.rationale,
      });
      await logger.log("page_section_selection", brief.agentId, {
        url: currentSurface.url,
        requestedIds,
        selectedIds: selected.selectedIds,
        selectedChars: selected.markdown.length,
        truncated: selected.truncated,
        incremental: true,
        rationale: action.rationale,
      });

      const sectionMarkdown = `${currentSurface.url}에서 추가로 선택한 페이지 섹션입니다.
이 분기에서 이미 읽은 섹션: ${currentSurface.pageSections.readSectionIds.join(", ") || "(none)"}.

${selected.markdown}`;
      const limited = limitVisibleCandidates(sectionMarkdown);
      currentSurface.visibleCandidateIds = mergeVisibleCandidateIds(currentSurface.visibleCandidateIds, limited.visibleIds);
      const candidateStatus = formatCandidateStatus(currentSurface.candidates, currentSurface.visibleCandidateIds, budget.visitedUrls);
      messages.push(
        buildPageSectionReadResultMessage(
          currentSurface.url,
          selected.selectedIds,
          limited.markdown,
          currentSurface.pageSections.outline,
          budget.summary(),
          candidateStatus
        )
      );
      continue;
    }

    if (action.action === "search") {
      if (typeof action.engine !== "string" || !isSupportedEngine(action.engine)) {
        await reject(round, "search", `지원하지 않거나 누락된 검색 엔진입니다.`, { providedEngine: action.engine });
        continue;
      }
      if (typeof action.query !== "string" || !action.query.trim()) {
        await reject(round, "search", `search.query가 필요합니다.`);
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
        await reject(round, "search", `SERP를 불러오지 못했습니다: ${detail}`, { url });
        continue;
      }

      const candidates = candidateRegistry.registerSurface(result, "serp", url);
      const limited = limitVisibleCandidates(extractSerpSnippets(result.markdown, candidates, true));
      const candidateStatus = formatCandidateStatus(candidates, limited.visibleIds, budget.visitedUrls);
      currentSurface = { kind: "serp", engine, query, page, url, result, candidates, visibleCandidateIds: limited.visibleIds };
      await logger.log("page_markdown", brief.agentId, { url, markdown: result.markdown, pageId });
      messages.push(buildSerpResultMessage(engine, query, page, limited.markdown, budget.summary(), candidateStatus));
      continue;
    }

    if (action.action === "paginate") {
      if (!currentSurface || currentSurface.kind !== "serp" || !currentSurface.query) {
        await reject(round, "paginate", `paginate를 사용하려면 활성 SERP 컨텍스트가 필요합니다. 아직 이 리서처에 SERP가 없습니다.`);
        continue;
      }
      if (typeof action.page !== "number" || action.page < 1) {
        await reject(round, "paginate", `paginate.page는 양의 정수여야 합니다.`, { providedPage: action.page });
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
        await reject(round, "paginate", `SERP를 불러오지 못했습니다: ${detail}`, { url });
        continue;
      }

      const candidates = candidateRegistry.registerSurface(result, "serp", url);
      const limited = limitVisibleCandidates(extractSerpSnippets(result.markdown, candidates, true));
      const candidateStatus = formatCandidateStatus(candidates, limited.visibleIds, budget.visitedUrls);
      currentSurface = { kind: "serp", engine, query, page, url, result, candidates, visibleCandidateIds: limited.visibleIds };
      await logger.log("page_markdown", brief.agentId, { url, markdown: result.markdown, pageId });
      messages.push(buildSerpResultMessage(engine, query, page, limited.markdown, budget.summary(), candidateStatus));
      continue;
    }

    if (action.action === "delegate") {
      if (!budget.canRecurseDeeper(brief.depth)) {
        await reject(round, "delegate", `이 리서처에서 최대 깊이(${budget.limits.maxDepth})에 도달했습니다.`);
        continue;
      }
      if (childCallCount >= budget.limits.maxChildCallsPerAgent) {
        await reject(round, "delegate", `에이전트별 하위 호출 한도(${budget.limits.maxChildCallsPerAgent})에 도달했습니다.`);
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
        runtimeContext: brief.runtimeContext,
        activate: resolved.target.activate,
      };

      // 재귀 호출 — 자기 자신을 호출. 자식의 답변은 자연어 문자열.
      const childAnswer = await runChildResearcherSafely(childBrief, client, logger, budget, candidateRegistry);
      messages.push(buildDelegateResultMessage(resolved.target.label, childAnswer, budget.summary()));
      continue;
    }

    if (action.action === "delegate_parallel") {
      if (!budget.canRecurseDeeper(brief.depth)) {
        await reject(round, "delegate_parallel", `최대 깊이(${budget.limits.maxDepth})에 도달했습니다.`);
        continue;
      }
      const remainingPerAgent = budget.limits.maxChildCallsPerAgent - childCallCount;
      const remainingTree = budget.parallelSlotsRemaining();
      const limit = Math.min(remainingPerAgent, remainingTree, budget.limits.maxParallel);
      if (limit <= 0) {
        await reject(round, "delegate_parallel", `남은 병렬 슬롯이 없습니다. 에이전트별 한도 또는 전체 예산이 소진되었습니다.`);
        continue;
      }
      const rawBranches = Array.isArray(action.branches) ? action.branches : [];

      const runDowngradedBranch = async (branch: DelegateTarget, reason: string, alreadyReserved = false): Promise<boolean> => {
        if (!alreadyReserved) {
          const reserve = budget.reserveDelegate(branch.startUrl);
          if (!reserve.ok) {
            await reject(round, "delegate_parallel", reserve.reason, { startUrl: branch.startUrl, targetId: branch.targetId, linkId: branch.linkId });
            return false;
          }
        }

        childCallCount++;
        await logger.log("orchestrator_plan", brief.agentId, {
          round,
          action: "delegate_parallel_downgraded",
          downgradedTo: "delegate",
          reason,
          targetId: branch.targetId,
          linkId: branch.linkId,
          url: branch.startUrl,
          task: branch.task,
          rationale: branch.rationale ?? action.rationale,
        });

        const childBrief: ResearcherBrief = {
          agentId: `${brief.agentId}-d${round}-${childCallCount}`,
          parentAgentId: brief.agentId,
          goal: branch.task,
          parentGoal: brief.parentGoal,
          startUrl: branch.startUrl,
          depth: brief.depth + 1,
          runtimeContext: brief.runtimeContext,
          activate: branch.activate,
        };
        const childAnswer = await runChildResearcherSafely(childBrief, client, logger, budget, candidateRegistry);
        messages.push(buildDelegateResultMessage(branch.label, childAnswer, budget.summary()));
        return true;
      };

      const validBranches: DelegateTarget[] = [];
      for (const b of rawBranches) {
        const resolved = resolveDelegateTarget(b ?? {}, currentSurface, candidateRegistry);
        if (!resolved.ok) continue;
        if (resolved.target.startUrl && validBranches.some((vb) => vb.startUrl === resolved.target.startUrl)) continue;
        if (resolved.target.startUrl && budget.visitedUrls.has(resolved.target.startUrl)) continue;
        validBranches.push(resolved.target);
        if (validBranches.length >= limit) break;
      }

      if (validBranches.length === 0) {
        await reject(round, "delegate_parallel", `유효한 분기가 없습니다. targetId/startUrl이 잘못되었거나 task가 없거나 모두 이미 방문했습니다.`);
        continue;
      }
      if (validBranches.length === 1) {
        await runDowngradedBranch(validBranches[0]!, "필터링 후 유효한 분기가 하나만 남았습니다.");
        continue;
      }

      const reservedBranches: DelegateTarget[] = [];
      for (const branch of validBranches) {
        const reserve = budget.reserveDelegate(branch.startUrl);
        if (!reserve.ok) continue;
        reservedBranches.push(branch);
      }

      if (reservedBranches.length === 0) {
        await reject(round, "delegate_parallel", `예약 후 남은 유효 분기가 없습니다.`);
        continue;
      }
      if (reservedBranches.length === 1) {
        await runDowngradedBranch(reservedBranches[0]!, "예약 후 유효한 분기가 하나만 남았습니다.", true);
        continue;
      }

      childCallCount += reservedBranches.length;
      await logger.log("orchestrator_plan", brief.agentId, {
        round,
        action: "delegate_parallel",
        rationale: action.rationale,
        branches: reservedBranches.map((vb) => ({ targetId: vb.targetId, linkId: vb.linkId, url: vb.startUrl, task: vb.task, rationale: vb.rationale })),
      });

      const childAnswers = await Promise.all(
        reservedBranches.map((vb, i) => {
          const childBrief: ResearcherBrief = {
            agentId: `${brief.agentId}-${round}-${i + 1}`,
            parentAgentId: brief.agentId,
            goal: vb.task,
            parentGoal: brief.parentGoal,
            startUrl: vb.startUrl,
            depth: brief.depth + 1,
            runtimeContext: brief.runtimeContext,
            activate: vb.activate,
          };
          return runChildResearcherSafely(childBrief, client, logger, budget, candidateRegistry);
        })
      );

      messages.push(
        buildParallelDelegateResultMessage(
          reservedBranches.map((vb, i) => ({ label: vb.label, answer: childAnswers[i] ?? "" })),
          budget.summary()
        )
      );
      continue;
    }

    // 알 수 없는 action — schema가 막아줄 것이지만 방어적 처리.
    await reject(round, String(action.action), `알 수 없는 행동입니다: "${action.action}".`);
  }

  // 자기 자신의 라운드 한도 소진 — 누적된 정보로 합성을 강제한다.
  return synthesizeFinalAnswer(
    brief,
    messages,
    client,
    logger,
    budget,
    "에이전트별 라운드 예산이 소진되었습니다."
  );
}

async function runChildResearcherSafely(
  childBrief: ResearcherBrief,
  client: OpenAIClient,
  logger: V2Logger,
  budget: SharedBudget,
  candidateRegistry: CandidateRegistry
): Promise<string> {
  try {
    return await runResearcher(childBrief, client, logger, budget, candidateRegistry);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const fallback = buildEmergencyFallback(childBrief, `하위 리서처 실패: ${detail}`);
    await logger.log("exploration_report", childBrief.agentId, {
      report: { agentId: childBrief.agentId, url: childBrief.startUrl ?? "", answer: fallback, error: detail },
    });
    return fallback;
  }
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
이 리서처는 합성 답변을 만들지 못했습니다. 사유: ${reason}. 목표: "${brief.goal}".

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
  const runtimeContext = buildRuntimeContext();
  const rootBrief: ResearcherBrief = {
    agentId: "researcher-root",
    parentAgentId: null,
    goal,
    parentGoal: goal,
    depth: 0,
    runtimeContext,
  };
  return runResearcher(rootBrief, client, logger, budget);
}
