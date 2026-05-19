export interface SearchOptions {
  query: string;
  model: string;
  debug: boolean;
  logDir: string;
}

export interface MissionBrief {
  agentId: string;
  parentAgentId: string;
  goal: string;
  url: string;
  parentGoal: string;
  depth: number;
}

export interface ExplorationReport {
  agentId: string;
  url: string;
  found: boolean;
  summary: string;
  relevantExcerpts: string[];
  tokenUsage: TokenUsage;
  childReports?: ExplorationReport[];
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

export type LogEventKind =
  | "mission_brief"
  | "exploration_report"
  | "llm_request"
  | "llm_response"
  | "page_markdown"
  | "orchestrator_plan"
  | "final_answer"
  | "recursion_decision";
