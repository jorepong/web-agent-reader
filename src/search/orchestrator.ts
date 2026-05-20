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
  buildOrchestratorErrorMessage,
  buildOrchestratorInitialPrompt,
  buildParallelExploreResultMessage,
  buildSerpResultMessage,
  buildSynthesisPrompt,
  MAX_PARALLEL,
  ORCHESTRATOR_MAX_EXPLORES,
  ORCHESTRATOR_MAX_ROUNDS,
  ORCHESTRATOR_MAX_SEARCHES,
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

  // append-only messages: 시스템 + 첫 user 메시지 이후 (assistant + user) 페어가 라운드마다 추가됨.
  const messages: LLMMessage[] = buildOrchestratorInitialPrompt(options.query);

  const reports: ExplorationReport[] = [];
  const exploredUrls: string[] = [];
  // 같은 (engine, query, page) 삼중쌍의 중복 검색 방지
  const searchHistory: Array<{ engine: SearchEngine; query: string; page: number }> = [];

  let currentSerp: CurrentSerp | null = null;
  let searchCount = 0;
  let exploreCount = 0;

  for (let round = 1; round <= ORCHESTRATOR_MAX_ROUNDS; round++) {
    const { text } = await client.complete("orchestrator", messages, { jsonResponse: true });
    // LLM 응답은 항상 assistant 메시지로 append — 다음 라운드의 prefix cache 키 안정화.
    messages.push({ role: "assistant", content: text });

    const action = parseJsonResponse<ParsedAction>(text);
    if (!action || typeof action.action !== "string") {
      await logger.log("orchestrator_plan", "orchestrator", { round, action: "error", reason: "invalid JSON" });
      messages.push(buildOrchestratorErrorMessage("Your previous response was not valid JSON or had no 'action' field.", searchCount, exploreCount));
      continue;
    }

    if (action.action === "done") {
      await logger.log("orchestrator_plan", "orchestrator", { round, action: "done", reason: action.reason });
      break;
    }

    if (action.action === "search" || action.action === "paginate") {
      if (searchCount >= ORCHESTRATOR_MAX_SEARCHES) {
        const reason = `Search/paginate limit (${ORCHESTRATOR_MAX_SEARCHES}) reached.`;
        await logger.log("orchestrator_plan", "orchestrator", { round, action: action.action, status: "limit", reason });
        messages.push(buildOrchestratorErrorMessage(`${reason} Pick explore on existing SERP, or done.`, searchCount, exploreCount));
        continue;
      }

      let engine: SearchEngine;
      let query: string;
      let page: number;

      if (action.action === "search") {
        if (typeof action.engine !== "string" || !isSupportedEngine(action.engine)) {
          messages.push(buildOrchestratorErrorMessage(`Unsupported or missing engine. Use one of "google", "bing", "naver".`, searchCount, exploreCount));
          continue;
        }
        if (typeof action.query !== "string" || !action.query.trim()) {
          messages.push(buildOrchestratorErrorMessage(`search.query is required and must be a non-empty string.`, searchCount, exploreCount));
          continue;
        }
        engine = action.engine;
        query = action.query.trim();
        page = typeof action.page === "number" && action.page >= 1 ? Math.floor(action.page) : 1;
      } else {
        // paginate
        if (!currentSerp) {
          messages.push(buildOrchestratorErrorMessage(`paginate requires an existing SERP. Use search first.`, searchCount, exploreCount));
          continue;
        }
        if (typeof action.page !== "number" || action.page < 1) {
          messages.push(buildOrchestratorErrorMessage(`paginate.page must be a positive integer.`, searchCount, exploreCount));
          continue;
        }
        engine = currentSerp.engine;
        query = currentSerp.query;
        page = Math.floor(action.page);
      }

      if (searchHistory.some((h) => h.engine === engine && h.query === query && h.page === page)) {
        messages.push(
          buildOrchestratorErrorMessage(
            `Already attempted ${engine}/"${query}" page ${page}. Pick a different query, engine, or page.`,
            searchCount,
            exploreCount
          )
        );
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
        messages.push(
          buildOrchestratorErrorMessage(
            `Failed to load SERP for ${engine}/"${query}" page ${page}: ${detail}`,
            searchCount,
            exploreCount
          )
        );
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

      messages.push(buildSerpResultMessage(engine, query, page, snippets, searchCount, exploreCount));
      continue;
    }

    if (action.action === "explore") {
      if (!currentSerp) {
        messages.push(buildOrchestratorErrorMessage(`explore requires a SERP. Use search first.`, searchCount, exploreCount));
        continue;
      }
      if (exploreCount >= ORCHESTRATOR_MAX_EXPLORES) {
        messages.push(
          buildOrchestratorErrorMessage(
            `Explorer dispatch limit (${ORCHESTRATOR_MAX_EXPLORES}) reached. Return done with what you have.`,
            searchCount,
            exploreCount
          )
        );
        continue;
      }
      if (typeof action.linkId !== "string" || !action.linkId) {
        messages.push(buildOrchestratorErrorMessage(`explore.linkId is required.`, searchCount, exploreCount));
        continue;
      }
      const entry = currentSerp.result.links.links[action.linkId];
      if (!entry) {
        messages.push(
          buildOrchestratorErrorMessage(`linkId ${action.linkId} not found on the current SERP.`, searchCount, exploreCount)
        );
        continue;
      }
      if (exploredUrls.includes(entry.url)) {
        messages.push(buildOrchestratorErrorMessage(`${entry.url} was already explored.`, searchCount, exploreCount));
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

      const report = await runExplorationAgent(brief, client, logger);
      reports.push(report);
      messages.push(buildExploreResultMessage(report, searchCount, exploreCount));
      continue;
    }

    if (action.action === "explore_parallel") {
      if (!currentSerp) {
        messages.push(buildOrchestratorErrorMessage(`explore_parallel requires a SERP. Use search first.`, searchCount, exploreCount));
        continue;
      }
      if (exploreCount >= ORCHESTRATOR_MAX_EXPLORES) {
        messages.push(
          buildOrchestratorErrorMessage(
            `Explorer dispatch limit (${ORCHESTRATOR_MAX_EXPLORES}) reached. Return done.`,
            searchCount,
            exploreCount
          )
        );
        continue;
      }

      const remainingBudget = ORCHESTRATOR_MAX_EXPLORES - exploreCount;
      const limit = Math.min(MAX_PARALLEL, remainingBudget);
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
        messages.push(
          buildOrchestratorErrorMessage(
            `No valid branches: all linkIds were missing on the current SERP or already explored.`,
            searchCount,
            exploreCount
          )
        );
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
          return runExplorationAgent(brief, client, logger);
        })
      );
      reports.push(...parallelReports);
      messages.push(buildParallelExploreResultMessage(parallelReports, searchCount, exploreCount));
      continue;
    }

    // 알 수 없는 action — 에러 안내 후 다음 라운드에서 LLM이 재선택
    messages.push(buildOrchestratorErrorMessage(`Unknown action "${action.action}".`, searchCount, exploreCount));
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
