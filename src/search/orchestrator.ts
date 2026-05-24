// 검색 오케스트레이터. 행동(action) 집합 위에서 도는 에이전틱 루프.
//
// 흐름:
//   1. 시스템 + 사용자 질문으로 messages 초기화
//   2. 루프 (최대 ORCHESTRATOR_MAX_ROUNDS):
//        [LLM] 한 행동을 JSON으로 출력
//          - search(engine, query)          → 새 SERP 획득
//          - paginate(page)                 → 현재 SERP를 다른 페이지로 이동
//          - explore(linkId, task)          → 단일 탐색 에이전트 디스패치
//          - explore_parallel(branches[])   → 병렬 탐색 디스패치 (Promise.all)
//          - done(reason)                   → 종료
//        실행 결과를 messages 끝에 append (재구성 금지 — OpenAI prefix cache 히트 유지)
//   3. 수집된 ExplorationReport로 최종 답변 합성. 보고가 없으면 마지막 SERP로 폴백.
//
// 설계 원칙:
//   - 검색 엔진/쿼리/페이지/탐색 대상 모두 LLM이 자율 판단.
//   - 잘못된 입력(무효 linkId, 한도 초과, 중복 검색)은 크래시 없이 에러 메시지 주입 → LLM이 재선택.
//   - 하드 리밋은 안전망: ORCHESTRATOR_MAX_ROUNDS / _MAX_SEARCHES / _MAX_EXPLORES.
import { convertPage } from "../index.js";
import { runExplorationAgent } from "./explorer.js";
import { parseJsonResponse } from "./json-utils.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import {
  buildExploreResultMessage,
  buildOrchestratorActionSchema,
  buildOrchestratorErrorMessage,
  buildOrchestratorInitialPrompt,
  buildParallelExploreResultMessage,
  buildSerpResultMessage,
  buildSynthesisPrompt,
  DEFAULT_SEARCH_LIMITS,
} from "./prompts.js";
import { buildSerpUrl, isSupportedEngine, type SearchEngine } from "./search-engines.js";
import type { ConvertResult } from "../types.js";
import type { ExplorationReport, LLMMessage, MissionBrief, SearchOptions } from "./types.js";

// SERP 마크다운에서 Main Content 섹션만 추출하고 노이즈를 제거한다.
// keepLinkIds=true: 오케스트레이터 판단 루프용 — LLM이 linkId를 골라야 하므로 ID 유지.
// keepLinkIds=false: 합성용 — 실제 방문하지 않은 URL 인용 방지를 위해 ID 제거.
//
// 현재 skip 필터는 google SERP 어휘에 맞춰져 있지만, 다른 엔진에서는 단순히 매칭이
// 일어나지 않을 뿐 동작에 문제는 없다. ## Main Content 섹션이 없으면 전체 마크다운을 사용.
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

interface CurrentSerp {
  engine: SearchEngine;
  query: string;
  page: number;
  url: string;
  result: ConvertResult;
}

interface ParsedAction {
  action?: string;
  engine?: string;
  query?: string;
  page?: number;
  linkId?: string;
  task?: string;
  rationale?: string;
  reason?: string;
  branches?: Array<{ linkId?: string; task?: string; rationale?: string }>;
}

export async function runSearch(options: SearchOptions, client: OpenAIClient, logger: DebugLogger): Promise<string> {
  logger.startAgent("orchestrator", null);
  const limits = { ...DEFAULT_SEARCH_LIMITS, ...options.limits };
  const orchestratorActionSchema = buildOrchestratorActionSchema(limits.maxParallel);

  // append-only messages: 시스템 + 첫 user 메시지 이후 (assistant + user) 페어가 라운드마다 추가됨.
  const messages: LLMMessage[] = buildOrchestratorInitialPrompt(options.query, limits);

  const reports: ExplorationReport[] = [];
  const exploredUrls: string[] = [];
  // 같은 (engine, query, page) 삼중쌍의 중복 검색 방지
  const searchHistory: Array<{ engine: SearchEngine; query: string; page: number }> = [];

  let currentSerp: CurrentSerp | null = null;
  let searchCount = 0;
  let exploreCount = 0;

  for (let round = 1; round <= limits.maxRounds; round++) {
    // 거부 경로 공통 로깅 + 에러 메시지 주입.
    // 모든 거부(파싱 실패 / 무효 입력 / 한도 초과 / 이미 방문 / 알 수 없는 action)는
    // orchestrator_plan 이벤트로 남도록 통일 → 매 라운드의 결정이 디버그 로그에 흔적을 남긴다.
    const reject = async (requestedAction: string, reason: string, context: Record<string, unknown> = {}) => {
      await logger.log("orchestrator_plan", "orchestrator", {
        round,
        action: "rejected",
        requestedAction,
        reason,
        ...context,
      });
      messages.push(buildOrchestratorErrorMessage(reason, searchCount, exploreCount, limits));
    };

    const { text } = await client.complete("orchestrator", messages, { responseSchema: orchestratorActionSchema });
    // LLM 응답은 항상 assistant 메시지로 append — 다음 라운드의 prefix cache 키 안정화.
    messages.push({ role: "assistant", content: text });

    // 스키마가 { decision: <action> } 형태로 응답을 감싸므로 .decision 필드를 꺼낸다.
    const wrapper = parseJsonResponse<{ decision?: ParsedAction }>(text);
    const action = wrapper?.decision;
    if (!action || typeof action.action !== "string") {
      await reject("unknown", "Your previous response was not valid JSON or had no 'decision.action' field.", {
        rawResponsePreview: text.slice(0, 200),
      });
      continue;
    }

    if (action.action === "done") {
      await logger.log("orchestrator_plan", "orchestrator", { round, action: "done", reason: action.reason });
      break;
    }

    if (action.action === "search" || action.action === "paginate") {
      if (searchCount >= limits.maxSearches) {
        await reject(action.action, `Search/paginate limit (${limits.maxSearches}) reached. Pick explore on existing SERP, or done.`);
        continue;
      }

      let engine: SearchEngine;
      let query: string;
      let page: number;

      if (action.action === "search") {
        if (typeof action.engine !== "string" || !isSupportedEngine(action.engine)) {
          await reject("search", `Unsupported or missing engine. Use one of "google", "bing", "naver".`, {
            providedEngine: action.engine,
          });
          continue;
        }
        if (typeof action.query !== "string" || !action.query.trim()) {
          await reject("search", `search.query is required and must be a non-empty string.`);
          continue;
        }
        engine = action.engine;
        query = action.query.trim();
        page = typeof action.page === "number" && action.page >= 1 ? Math.floor(action.page) : 1;
      } else {
        // paginate
        if (!currentSerp) {
          await reject("paginate", `paginate requires an existing SERP. Use search first.`);
          continue;
        }
        if (typeof action.page !== "number" || action.page < 1) {
          await reject("paginate", `paginate.page must be a positive integer.`, { providedPage: action.page });
          continue;
        }
        engine = currentSerp.engine;
        query = currentSerp.query;
        page = Math.floor(action.page);
      }

      if (searchHistory.some((h) => h.engine === engine && h.query === query && h.page === page)) {
        await reject(action.action, `Already attempted ${engine}/"${query}" page ${page}. Pick a different query, engine, or page.`, {
          engine,
          query,
          page,
        });
        continue;
      }

      const url = buildSerpUrl(engine, query, page);
      const pageId = `SERP-${round}`;

      await logger.log("orchestrator_plan", "orchestrator", {
        round,
        action: action.action,
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
        // 실패한 시도도 history에 기록 — LLM이 같은 (engine,query,page) 재시도로 무한 루프 안 가게.
        searchHistory.push({ engine, query, page });
        searchCount++;
        await reject(action.action, `Failed to load SERP for ${engine}/"${query}" page ${page}: ${detail}`, {
          engine,
          query,
          page,
          url,
          error: detail,
        });
        continue;
      }

      const snippets = extractSerpSnippets(result.markdown, true);
      currentSerp = { engine, query, page, url, result };
      searchHistory.push({ engine, query, page });
      searchCount++;

      await logger.log("page_markdown", "orchestrator", {
        url,
        markdown: result.markdown,
        pageId,
      });

      messages.push(buildSerpResultMessage(engine, query, page, snippets, searchCount, exploreCount, limits));
      continue;
    }

    if (action.action === "explore") {
      if (!currentSerp) {
        await reject("explore", `explore requires a SERP. Use search first.`);
        continue;
      }
      if (exploreCount >= limits.maxExplores) {
        await reject("explore", `Explorer dispatch limit (${limits.maxExplores}) reached. Return done with what you have.`);
        continue;
      }
      if (typeof action.linkId !== "string" || !action.linkId) {
        await reject("explore", `explore.linkId is required.`);
        continue;
      }
      const entry = currentSerp.result.links.links[action.linkId];
      if (!entry) {
        await reject("explore", `linkId ${action.linkId} not found on the current SERP.`, { linkId: action.linkId });
        continue;
      }
      if (exploredUrls.includes(entry.url)) {
        await reject("explore", `${entry.url} was already explored.`, { linkId: action.linkId, url: entry.url });
        continue;
      }

      exploredUrls.push(entry.url);
      exploreCount++;

      await logger.log("orchestrator_plan", "orchestrator", {
        round,
        action: "explore",
        linkId: action.linkId,
        url: entry.url,
        task: action.task,
        rationale: action.rationale,
      });

      const brief: MissionBrief = {
        agentId: `explorer-${round}`,
        parentAgentId: "orchestrator",
        goal: action.task ?? options.query,
        url: entry.url,
        parentGoal: options.query,
        depth: 0,
      };

      const report = await runExplorationAgent(brief, client, logger, new Set(), limits);
      reports.push(report);
      messages.push(buildExploreResultMessage(report, searchCount, exploreCount, limits));
      continue;
    }

    if (action.action === "explore_parallel") {
      if (!currentSerp) {
        await reject("explore_parallel", `explore_parallel requires a SERP. Use search first.`);
        continue;
      }
      if (exploreCount >= limits.maxExplores) {
        await reject("explore_parallel", `Explorer dispatch limit (${limits.maxExplores}) reached. Return done.`);
        continue;
      }

      const remainingBudget = limits.maxExplores - exploreCount;
      const limit = Math.min(limits.maxParallel, remainingBudget);
      const rawBranches = Array.isArray(action.branches) ? action.branches : [];

      const validBranches: Array<{ linkId: string; task?: string; rationale?: string; url: string }> = [];
      for (const b of rawBranches) {
        if (!b || typeof b.linkId !== "string") continue;
        const entry = currentSerp.result.links.links[b.linkId];
        if (!entry) continue;
        if (exploredUrls.includes(entry.url)) continue;
        if (validBranches.some((vb) => vb.url === entry.url)) continue;
        validBranches.push({ linkId: b.linkId, task: b.task, rationale: b.rationale, url: entry.url });
        if (validBranches.length >= limit) break;
      }

      if (validBranches.length === 0) {
        await reject("explore_parallel", `No valid branches: all linkIds were missing on the current SERP or already explored.`, {
          requestedLinkIds: rawBranches.map((b) => b?.linkId).filter((v): v is string => typeof v === "string"),
        });
        continue;
      }

      for (const vb of validBranches) {
        exploredUrls.push(vb.url);
        exploreCount++;
      }

      await logger.log("orchestrator_plan", "orchestrator", {
        round,
        action: "explore_parallel",
        rationale: action.rationale,
        branches: validBranches.map((vb) => ({ linkId: vb.linkId, url: vb.url, task: vb.task, rationale: vb.rationale })),
      });

      const parallelReports = await Promise.all(
        validBranches.map((vb, i) => {
          const brief: MissionBrief = {
            agentId: `explorer-${round}-${i + 1}`,
            parentAgentId: "orchestrator",
            goal: vb.task ?? options.query,
            url: vb.url,
            parentGoal: options.query,
            depth: 0,
          };
          return runExplorationAgent(brief, client, logger, new Set(), limits);
        })
      );
      reports.push(...parallelReports);
      messages.push(buildParallelExploreResultMessage(parallelReports, searchCount, exploreCount, limits));
      continue;
    }

    // 알 수 없는 action
    await reject(String(action.action), `Unknown action "${action.action}".`);
  }

  // Step: 최종 답변 합성
  // useSerpSynthesis=true가 되는 경우:
  //   (a) explorer가 한 번도 디스패치되지 않음 (LLM이 바로 done 또는 search만 했음)
  //   (b) explorer를 디스패치했지만 모든 보고가 found=false
  // 두 경우 모두 실제 방문 페이지에서 확인된 정보가 없으므로 마지막 SERP 스니펫으로 폴백.
  // currentSerp도 없으면(검색 자체를 안 한 경우) 빈 보고로 합성 → "no data" 메시지 생성.
  const usefulReports = reports.filter((r) => r.found);
  const useSerpSynthesis = usefulReports.length === 0;

  let reportsForSynthesis: ExplorationReport[];
  if (!useSerpSynthesis) {
    reportsForSynthesis = usefulReports;
  } else if (currentSerp) {
    reportsForSynthesis = [
      {
        agentId: "orchestrator",
        url: currentSerp.url,
        found: true,
        completeness: "partial",
        // 합성용이므로 링크 ID 제거 — 방문하지 않은 URL 인용 방지
        summary: extractSerpSnippets(currentSerp.result.markdown, false),
        relevantExcerpts: [],
        missingInfo: ["Only search-engine snippets were available; pages were not verified."],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    ];
  } else {
    reportsForSynthesis = [
      {
        agentId: "orchestrator",
        url: "",
        found: false,
        completeness: "none",
        summary: "No search was performed during this session.",
        relevantExcerpts: [],
        missingInfo: ["No data collected."],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    ];
  }

  const { text: answer } = await client.complete(
    "orchestrator",
    buildSynthesisPrompt(options.query, reportsForSynthesis, useSerpSynthesis)
  );
  await logger.log("final_answer", "orchestrator", { answer });
  return answer;
}
