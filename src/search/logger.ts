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

  async log(kind: LogEventKind, agentId: string, payload: unknown): Promise<void> {
    if (!this.enabled) return;
    this.printStatus(kind, agentId, payload);
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.events.push({ timestamp: new Date().toISOString(), kind, payload });
    }
  }

  async finalize(): Promise<void> {
    if (!this.enabled || this.agents.size === 0) return;
    try {
      await writeFile(this.filePath, JSON.stringify(this.buildTree(), null, 2));
    } catch (err) {
      process.stderr.write(`[logger] JSON 파일 저장 실패: ${err}\n`);
    }
  }

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
      case "final_answer":
        process.stderr.write(`${tag} 최종 답변 합성 중...\n`);
        break;
    }
  }
}
