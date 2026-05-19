// 디버그 로거. 에이전트 계층을 반영한 JSON 트리 파일을 생성한다.
//
// 설계 원칙:
//   - 모든 이벤트를 메모리에 누적한 뒤 finalize()에서 일괄 저장.
//     단점: 크래시 시 로그 유실. 장점: 에이전트 트리를 정확히 구성할 수 있음.
//   - 에이전트 깊이(depth)는 startAgent() 호출 시 parentAgentId를 기반으로 자동 계산.
//     MissionBrief의 depth와는 별개 — 로거가 독립적으로 트리를 추적.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LogEventKind } from "./types.js";

interface AgentEvent {
  timestamp: string;
  kind: LogEventKind;
  payload: unknown;
}

interface AgentNode {
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  startedAt: string;
  events: AgentEvent[];
}

export class DebugLogger {
  private filePath: string;
  private enabled: boolean;
  // Map 순서 = 에이전트 등록 순서 → buildTree()에서 children 정렬 시 활용
  private agents: Map<string, AgentNode> = new Map();

  constructor(enabled: boolean, logDir = ".") {
    this.enabled = enabled;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(logDir, `search-${timestamp}.json`);
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    console.log(`디버그 로그: ${this.filePath}`);
  }

  // 에이전트를 등록하고 깊이를 계산한다.
  // 부모가 아직 등록되지 않은 경우(parentAgentId가 Map에 없음) depth를 0으로 설정하는데,
  // 이는 오케스트레이터(parentAgentId=null)가 항상 먼저 등록된다는 전제 하에 안전.
  startAgent(agentId: string, parentAgentId: string | null): void {
    if (!this.enabled) return;
    const parentDepth = parentAgentId ? (this.agents.get(parentAgentId)?.depth ?? -1) : -1;
    this.agents.set(agentId, {
      agentId,
      parentAgentId,
      depth: parentDepth + 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
  }

  // agentId가 Map에 없으면 이벤트를 조용히 버린다 — 크래시 없이 진행.
  async log(kind: LogEventKind, agentId: string, payload: unknown): Promise<void> {
    if (!this.enabled) return;
    this.printStatus(kind, agentId, payload);
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.events.push({ timestamp: new Date().toISOString(), kind, payload });
    }
  }

  // 성공/실패 양쪽 경로에서 반드시 호출해야 한다 (cli.ts의 try/catch 참고).
  async finalize(): Promise<void> {
    if (!this.enabled || this.agents.size === 0) return;
    try {
      await writeFile(this.filePath, JSON.stringify(this.buildTree(), null, 2));
    } catch (err) {
      process.stderr.write(`[logger] JSON 파일 저장 실패: ${err}\n`);
    }
  }

  // 에이전트 Map을 순회해 parentAgentId 기반으로 트리를 재귀 구성한다.
  // 루트가 정확히 하나면 객체로, 여러 개면 배열로 반환 (정상 상황은 항상 단일 루트).
  private buildTree(): unknown {
    const buildNode = (node: AgentNode): unknown => ({
      agentId: node.agentId,
      depth: node.depth,
      startedAt: node.startedAt,
      events: node.events,
      children: [...this.agents.values()]
        .filter((a) => a.parentAgentId === node.agentId)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map(buildNode),
    });

    const roots = [...this.agents.values()].filter((a) => a.parentAgentId === null);
    return roots.length === 1 ? buildNode(roots[0]) : roots.map(buildNode);
  }

  // 터미널 실시간 출력 — stderr에 기록해 stdout(최종 답변)과 분리.
  private printStatus(kind: LogEventKind, agentId: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;
    const tag = `[${agentId}]`;
    switch (kind) {
      case "mission_brief": {
        const brief = p["brief"] as Record<string, unknown>;
        process.stderr.write(`${tag} 탐색 시작: ${brief["url"]}\n`);
        break;
      }
      case "page_markdown": {
        const md = (p["markdown"] as string) ?? "";
        process.stderr.write(`${tag} 페이지 변환 완료: ${p["url"]} (${md.length}자)\n`);
        break;
      }
      case "llm_request": {
        const msgs = p["messages"] as unknown[];
        process.stderr.write(`${tag} LLM 호출 중... (메시지 ${msgs.length}개)\n`);
        break;
      }
      case "llm_response": {
        const usage = p["tokenUsage"] as Record<string, number>;
        process.stderr.write(`${tag} LLM 응답 완료 — 입력: ${usage["promptTokens"]}, 출력: ${usage["completionTokens"]}, 합계: ${usage["totalTokens"]} 토큰\n`);
        break;
      }
      case "orchestrator_plan": {
        const round = p["round"] as number;
        if (p["action"] === "done") {
          process.stderr.write(`${tag} [${round}라운드] 판단: 탐색 종료 — ${p["reason"]}\n`);
        } else {
          process.stderr.write(`${tag} [${round}라운드] 판단: 탐색 계속 → ${p["url"]}\n`);
          process.stderr.write(`  이유: ${p["rationale"]}\n`);
        }
        break;
      }
      case "exploration_report": {
        const report = p["report"] as Record<string, unknown>;
        const status = report["found"] ? "관련 정보 발견" : "관련 정보 없음";
        process.stderr.write(`${tag} 보고: ${status} — ${String(report["summary"]).slice(0, 100)}\n`);
        break;
      }
      case "recursion_decision": {
        const round = p["round"] as number;
        const depth = p["depth"] as number;
        if (p["action"] === "explore") {
          process.stderr.write(`${tag} [round=${round}, depth=${depth}] 재귀 탐색 → ${p["url"]} (${p["linkId"]})\n`);
        } else {
          process.stderr.write(`${tag} [round=${round}, depth=${depth}] 재귀 건너뜀 — ${p["reason"]}\n`);
        }
        break;
      }
      case "final_answer":
        process.stderr.write(`${tag} 최종 답변 합성 중...\n`);
        break;
    }
  }
}
