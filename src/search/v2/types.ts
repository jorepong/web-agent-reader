// Researcher v2 전용 타입.
// v1과 의도적으로 분리되어 있다. v1의 SearchOptions/MissionBrief/ExplorationReport와는
// 독립적으로 진화한다.

import type { ConvertResult } from "../../types.js";
import type { SearchEngine } from "../search-engines.js";

// 외부 호출자가 사용하는 입력 옵션.
// goal은 함수의 첫 인자로 분리. options는 모두 선택.
export interface ResearchOptions {
  model?: string;
  debug?: boolean;
  logDir?: string;
  budget?: Partial<BudgetLimits>;
}

// 트리 전체가 공유하는 비용·중복 한도.
// 모든 필드 기본값은 SharedBudget 생성자에서 채워진다.
export interface BudgetLimits {
  maxRounds: number;            // 트리 전체 LLM 라운드 한도
  maxSearches: number;          // 트리 전체 search + paginate 한도
  maxExplores: number;          // 트리 전체 explorer(=리서처 자식) 디스패치 한도
  maxParallel: number;          // 한 explore_parallel 배치 동시 디스패치 한도
  maxDepth: number;             // 재귀 최대 깊이 (root=0)
  maxChildCallsPerAgent: number; // 한 리서처가 자식 호출 가능 횟수
}

// 한 리서처가 호출될 때의 임무 명세.
// task/goal은 항상 자연어다. startUrl은 자연어 작업에 붙는 런타임 출발점일 뿐,
// 리서처의 의미상 입력은 goal이다.
export interface ResearcherBrief {
  agentId: string;
  parentAgentId: string | null;  // root는 null
  goal: string;                   // 자연어 목표 (이 리서처가 답해야 할 질문)
  parentGoal: string;             // 원래 사용자 질문 — 깊이와 무관하게 보존
  startUrl?: string;              // 있으면 시작점 페이지, 없으면 root
  depth: number;                  // root=0
}

// 리서처가 반환하는 자연어 답변.
// 일정한 템플릿(ANSWER / SOURCES / COVERAGE / GAPS)을 따르되, 형식은 프롬프트로 강제하고
// 코드 차원에서는 plain string으로 다룬다. 외부 호출자도 부모 리서처의 LLM도 같은 형태로 본다.
export type ResearcherAnswer = string;

// LLM 메시지. v1의 LLMMessage와 시그니처 동일하지만 결합도를 줄이기 위해 v2 안에서도 별도 정의.
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type SurfaceKind = "serp" | "page";

// 현재 리서처가 직접 보고 있는 얕은 표면.
// SERP는 후보 발견/페이지네이션용이고, page는 시작 URL 또는 일반 목록 페이지의 링크 표면이다.
export interface CurrentSurface {
  kind: SurfaceKind;
  engine: SearchEngine;
  query: string;
  page: number;
  url: string;
  result: ConvertResult;
  candidates: Record<string, CandidateLink>;
}

export interface CandidateLink {
  id: string;
  originalLinkId: string;
  text: string;
  url: string;
  sourcePath: string;
  surfaceUrl: string;
  surfaceKind: SurfaceKind;
}
