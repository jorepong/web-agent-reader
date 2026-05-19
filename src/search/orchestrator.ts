// 검색 오케스트레이터. 전체 탐색 흐름을 조율한다.
// 흐름: 검색 쿼리 생성 → SERP 변환 → 아젠틱 탐색 루프 → 최종 합성
import { convertPage } from "../index.js";
import { runExplorationAgent } from "./explorer.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildNextActionPrompt, buildSearchQueryPrompt, buildSynthesisPrompt } from "./prompts.js";
import type { ExplorationReport, MissionBrief, SearchOptions } from "./types.js";

// 오케스트레이터 레벨에서 탐색할 수 있는 최대 페이지 수 (비용 폭발 방지 안전장치).
// 탐색 에이전트 내부의 재귀 깊이 제한(MAX_DEPTH)과는 별개.
const MAX_PAGES = 5;


// SERP 마크다운에서 Main Content 섹션만 추출하고 노이즈를 제거한다.
// keepLinkIds=true: 오케스트레이터 판단 루프용 — LLM이 linkId를 골라야 하므로 ID 유지.
// keepLinkIds=false: 합성용 — 실제 방문하지 않은 URL 인용 방지를 위해 ID 제거.
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

export async function runSearch(options: SearchOptions, client: OpenAIClient, logger: DebugLogger): Promise<string> {
  logger.startAgent("orchestrator", null);

  // Step 1: 사용자 질문을 Google 검색에 최적화된 영어 쿼리로 변환
  const { text: searchQuery } = await client.complete("orchestrator", buildSearchQueryPrompt(options.query));
  const trimmedQuery = searchQuery.trim();

  // Step 2: Google SERP 변환
  // scroll=false: SERP는 초기 로딩에 모든 결과가 포함되어 스크롤 불필요
  // stealth=true: Google이 headless Chromium을 차단하므로 실제 Chrome 채널 사용
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmedQuery)}&hl=en&gl=us`;
  const serpResult = await convertPage(googleUrl, { scroll: false, stealth: true, pageId: "SERP" });

  await logger.log("page_markdown", "orchestrator", {
    url: googleUrl,
    markdown: serpResult.markdown,
    pageId: "SERP",
  });

  // Step 3: 아젠틱 탐색 루프
  // serpSnippets에 링크 ID를 유지 — 오케스트레이터가 linkId로 탐색 대상 선택하기 때문
  const serpSnippets = extractSerpSnippets(serpResult.markdown, true);
  const reports: ExplorationReport[] = [];
  // exploredUrls: 오케스트레이터 레벨 중복 방지 (explorer 내부 visitedUrls와 별개)
  const exploredUrls: string[] = [];

  for (let round = 1; round <= MAX_PAGES; round++) {
    const { text: actionJson } = await client.complete(
      "orchestrator",
      buildNextActionPrompt(options.query, serpSnippets, reports, exploredUrls, MAX_PAGES)
    );

    let action: { action: "explore" | "done"; linkId?: string; rationale?: string; reason?: string };
    try {
      action = JSON.parse(actionJson);
    } catch {
      // JSON 파싱 실패 = LLM 응답 오류, 더 이상 탐색 불가
      break;
    }

    if (action.action === "done") {
      await logger.log("orchestrator_plan", "orchestrator", { round, action: "done", reason: action.reason });
      break;
    }

    if (!action.linkId) break;

    const entry = serpResult.links.links[action.linkId];
    // 유효하지 않은 linkId이거나 이미 탐색한 URL인 경우 — break 대신 continue로 루프 유지.
    // LLM이 실수로 잘못된 ID를 골랐을 때 다음 라운드에서 다른 링크를 선택할 기회를 준다.
    if (!entry || exploredUrls.includes(entry.url)) continue;

    await logger.log("orchestrator_plan", "orchestrator", {
      round,
      action: "explore",
      linkId: action.linkId,
      url: entry.url,
      rationale: action.rationale,
    });

    exploredUrls.push(entry.url);

    const brief: MissionBrief = {
      agentId: `explorer-${round}`,
      parentAgentId: "orchestrator",
      goal: action.rationale ?? options.query,
      url: entry.url,
      parentGoal: options.query,
      depth: 0, // 오케스트레이터가 생성하는 탐색 에이전트는 항상 depth 0에서 시작
    };

    const report = await runExplorationAgent(brief, client, logger);
    reports.push(report);
  }

  // Step 4: 최종 답변 합성
  // 각 explorer가 아젠틱 루프에서 자식 보고를 선별 통합한 summary를 반환하므로
  // 오케스트레이터는 최상위 보고만 수신 — flattenReports 불필요.
  const usefulReports = reports.filter((r) => r.found);

  // useSerpSynthesis=true가 되는 두 가지 경우:
  //   (a) 탐색을 아예 하지 않음 (LLM이 1라운드에서 done 결정)
  //   (b) 탐색했지만 모든 결과가 found=false
  // 두 경우 모두 실제 방문 페이지에서 확인된 정보가 없으므로 SERP 스니펫으로 폴백.
  const useSerpSynthesis = usefulReports.length === 0;
  const reportsForSynthesis: ExplorationReport[] = useSerpSynthesis
    ? [{
        agentId: "orchestrator",
        url: googleUrl,
        found: true,
        // 합성용이므로 링크 ID 제거 — 방문하지 않은 URL 인용 방지
        summary: extractSerpSnippets(serpResult.markdown, false),
        relevantExcerpts: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }]
    : usefulReports;

  const { text: answer } = await client.complete("orchestrator", buildSynthesisPrompt(options.query, reportsForSynthesis, useSerpSynthesis));
  await logger.log("final_answer", "orchestrator", { answer });
  return answer;
}
