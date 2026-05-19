// llm-search 전체에서 공유하는 타입 정의.
// 에이전트 간 통신(MissionBrief, ExplorationReport)과 로깅(LogEventKind) 타입이 핵심.

export interface SearchOptions {
  query: string;
  model: string;
  debug: boolean;
  logDir: string;
}

// 상위 에이전트가 하위 에이전트에게 넘기는 임무 명세.
// goal: 이 에이전트가 달성해야 할 구체적인 목적 (오케스트레이터가 결정)
// parentGoal: 원래 사용자 질문 — 하위 에이전트가 맥락을 잃지 않도록 전달
// depth: 재귀 깊이 (오케스트레이터→explorer = 0, explorer→sub-explorer = 1, ...)
// 미션 브리핑은 의도적으로 짧게 유지 — 자식 에이전트는 prefix cache 이점이 없으므로
export interface MissionBrief {
  agentId: string;
  parentAgentId: string;
  goal: string;
  url: string;
  parentGoal: string;
  depth: number;
}

export type ReportCompleteness = "complete" | "partial" | "none";

// 탐색 에이전트가 상위 에이전트에게 반환하는 보고서.
// summary: 에이전트가 자식 탐색 결과를 선별·통합한 최종 요약 (아젠틱 루프 내에서 합성됨).
export interface ExplorationReport {
  agentId: string;
  url: string;
  found: boolean;
  completeness: ReportCompleteness;
  summary: string;
  relevantExcerpts: string[];
  missingInfo: string[];
  tokenUsage: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// 디버그 로그에 기록되는 이벤트 종류.
// 에이전트 계층 구조를 반영해 설계됨:
//   llm_request / llm_response — LLM 호출 쌍 (callId로 매칭)
//   mission_brief / exploration_report — 에이전트 간 통신
//   page_markdown — convertPage 결과 전문
//   orchestrator_plan — 오케스트레이터의 매 라운드 판단 (explore/done)
//   recursion_decision — 탐색 에이전트의 재귀 여부 결정
//   final_answer — 최종 합성 결과
export type LogEventKind =
  | "mission_brief"
  | "exploration_report"
  | "llm_request"
  | "llm_response"
  | "page_markdown"
  | "orchestrator_plan"
  | "final_answer"
  | "recursion_decision";
