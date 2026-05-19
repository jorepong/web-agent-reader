// 탐색 에이전트. 단일 URL을 방문하고 아젠틱 루프를 실행해 목표 관련 정보를 수집한다.
//
// 루프 구조 (오케스트레이터와 동일):
//   1. 페이지 변환 후 초기 messages 구성
//   2. 루프: LLM 호출 → explore / done 판단
//      - explore: 자식 에이전트 실행, 보고 수신, messages에 append (재구성 없음), 루프 계속
//      - done: ExplorationReport 반환 (자식 결과를 선별 통합한 summary 포함)
//   3. 하드 리밋 도달 시 "탐색 불가" 메시지를 주입해 LLM이 done을 반환하도록 유도
import { convertPage } from "../index.js";
import { parseJsonResponse } from "./json-utils.js";
import type { DebugLogger } from "./logger.js";
import type { OpenAIClient } from "./openai-client.js";
import { buildExplorerContinueMessage, buildExplorerInitialPrompt, MAX_CHILD_CALLS_PER_AGENT, MAX_DEPTH } from "./prompts.js";
import type { ExplorationReport, LLMMessage, MissionBrief, ReportCompleteness, TokenUsage } from "./types.js";

export async function runExplorationAgent(
  brief: MissionBrief,
  client: OpenAIClient,
  logger: DebugLogger,
  // visitedUrls: 재귀 트리 내 중복 방문 방지. 부모-자식-형제 모두 공유.
  // 오케스트레이터의 exploredUrls와는 별개 (오케스트레이터 레벨 중복은 orchestrator.ts에서 관리).
  visitedUrls: Set<string> = new Set()
): Promise<ExplorationReport> {
  logger.startAgent(brief.agentId, brief.parentAgentId);
  await logger.log("mission_brief", brief.agentId, { brief });

  // convertPage 실패 시에도 URL이 visited로 남아 재시도 불가 — 의도된 동작.
  visitedUrls.add(brief.url);

  try {
    const result = await convertPage(brief.url, { scroll: true, stealth: true, pageId: brief.agentId });

    await logger.log("page_markdown", brief.agentId, {
      url: brief.url,
      markdown: result.markdown,
      pageId: result.page.pageId,
    });

    // context append 원칙: messages 배열에 추가만 하고 재구성하지 않는다.
    // 자식 보고를 받을 때마다 배열 끝에 assistant + user 메시지를 push.
    const messages: LLMMessage[] = buildExplorerInitialPrompt(brief, result.markdown);

    // 여러 LLM 호출의 토큰 사용량을 누산해 최종 보고에 포함
    let totalTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let childCallCount = 0;
    // 루프 상한: MAX_CHILD_CALLS_PER_AGENT 번 자식 호출 + 1번 초기 + 1번 마지막 done
    const MAX_ROUNDS = MAX_CHILD_CALLS_PER_AGENT + 2;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { text, tokenUsage } = await client.complete(brief.agentId, messages, { jsonResponse: true });
      totalTokenUsage = {
        promptTokens: totalTokenUsage.promptTokens + tokenUsage.promptTokens,
        completionTokens: totalTokenUsage.completionTokens + tokenUsage.completionTokens,
        totalTokens: totalTokenUsage.totalTokens + tokenUsage.totalTokens,
      };

      type ParsedAction = {
        action: "explore" | "done";
        linkId?: string;
        task?: string;      // 자식 에이전트에게 전달할 명확한 작업 지시
        rationale?: string; // 왜 이 링크를 선택했는지 (로그용)
        found?: boolean;
        completeness?: unknown;
        summary?: string;
        relevantExcerpts?: unknown;
        missingInfo?: unknown;
      };
      // 관대한 JSON 파서: 코드펜스/주변 prose가 섞여도 첫 번째 JSON 블록을 추출.
      const parsedOrNull = parseJsonResponse<ParsedAction>(text);
      const parsed: ParsedAction = parsedOrNull ?? {
        action: "done",
        found: false,
        summary: "Failed to parse LLM response.",
        relevantExcerpts: [],
      };

      if (parsed.action === "done") {
        const found = parsed.found ?? false;
        const report: ExplorationReport = {
          agentId: brief.agentId,
          url: brief.url,
          found,
          completeness: normalizeCompleteness(parsed.completeness, found),
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          relevantExcerpts: normalizeStringArray(parsed.relevantExcerpts),
          missingInfo: found ? normalizeStringArray(parsed.missingInfo) : [],
          tokenUsage: totalTokenUsage,
        };
        await logger.log("exploration_report", brief.agentId, { report });
        return report;
      }

      // action === "explore"
      const linkId = parsed.linkId;
      const entry = linkId ? result.links.links[linkId] : undefined;
      // 마지막 라운드는 LLM이 done을 반환해야 하므로 자식 호출 불가
      const isLastRound = round === MAX_ROUNDS - 1;
      const canRunChild =
        !isLastRound &&
        brief.depth < MAX_DEPTH &&
        childCallCount < MAX_CHILD_CALLS_PER_AGENT;

      if (canRunChild && entry && !visitedUrls.has(entry.url)) {
        await logger.log("recursion_decision", brief.agentId, {
          round,
          depth: brief.depth,
          action: "explore",
          linkId,
          url: entry.url,
          task: parsed.task,
          rationale: parsed.rationale,
        });

        // 자식 호출 전에 등록 — Phase 3 병렬화 대비 선제 등록
        visitedUrls.add(entry.url);
        childCallCount++;

        const childBrief: MissionBrief = {
          agentId: `${brief.agentId}-${linkId!.toLowerCase()}`,
          parentAgentId: brief.agentId,
          // task: 자식 에이전트에게 전달할 명확한 작업 지시 (rationale은 로그용)
          goal: parsed.task ?? brief.goal,
          url: entry.url,
          parentGoal: brief.parentGoal,
          depth: brief.depth + 1,
        };

        const childReport = await runExplorationAgent(childBrief, client, logger, visitedUrls);

        // 자식 보고를 context에 append (재구성 금지 — prefix cache 히트율 유지)
        const canExploreMore = childCallCount < MAX_CHILD_CALLS_PER_AGENT && round + 1 < MAX_ROUNDS - 1;
        messages.push({ role: "assistant", content: text });
        messages.push(buildExplorerContinueMessage(childReport, canExploreMore));
      } else {
        // 탐색 불가 사유 결정
        const reason = isLastRound
          ? "최대 라운드 도달"
          : !canRunChild
            ? brief.depth >= MAX_DEPTH
              ? "최대 깊이 도달"
              : "최대 자식 탐색 횟수 도달"
            : !entry
              ? `링크를 찾을 수 없음 (ID: ${linkId ?? "없음"})`
              : "이미 방문한 URL";

        await logger.log("recursion_decision", brief.agentId, {
          round,
          depth: brief.depth,
          action: "skipped",
          requestedLinkId: linkId,
          reason,
        });

        // "탐색 불가" 메시지를 주입 → 다음 LLM 호출에서 done 반환을 유도
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: `[탐색 불가: ${reason}. 지금까지 수집한 정보를 바탕으로 최종 보고를 해주세요.]`,
        });
      }
    }

    // MAX_ROUNDS를 소진했는데도 done이 없는 경우 — 실제로는 "탐색 불가" 주입으로 방지되지만 안전망.
    const fallback: ExplorationReport = {
      agentId: brief.agentId,
      url: brief.url,
      found: false,
      completeness: "none",
      summary: "탐색 한도 초과로 보고를 완료하지 못했습니다.",
      relevantExcerpts: [],
      missingInfo: [],
      tokenUsage: totalTokenUsage,
    };
    await logger.log("exploration_report", brief.agentId, { report: fallback });
    return fallback;
  } catch (err) {
    // 페이지 로드/변환 실패 시 크래시 없이 빈 보고 반환.
    const report: ExplorationReport = {
      agentId: brief.agentId,
      url: brief.url,
      found: false,
      completeness: "none",
      summary: `Page could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      relevantExcerpts: [],
      missingInfo: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
    await logger.log("exploration_report", brief.agentId, { report });
    return report;
  }
}

function normalizeCompleteness(completeness: unknown, found: boolean): ReportCompleteness {
  if (!found) return "none";
  return completeness === "complete" || completeness === "partial" ? completeness : "partial";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
