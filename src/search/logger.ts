// 디버그 로거. 모든 에이전트 이벤트를 시간순 들여쓰기 JSONL 파일로 저장한다.
//
// 출력 형식: 각 줄이 유효한 JSON 객체, depth * 2 스페이스로 들여쓰기
//   {"timestamp":"...","agentId":"orchestrator","depth":0,"kind":"llm_request",...}
//     {"timestamp":"...","agentId":"explorer-1","depth":1,"kind":"mission_brief",...}
//       {"timestamp":"...","agentId":"explorer-1-l3","depth":2,"kind":"page_markdown",...}
//     {"timestamp":"...","agentId":"explorer-1","depth":1,"kind":"exploration_report",...}
//   {"timestamp":"...","agentId":"orchestrator","depth":0,"kind":"final_answer",...}
//
// 설계 원칙:
//   - 모든 이벤트를 메모리에 누적한 뒤 finalize()에서 일괄 저장.
//     단점: 크래시 시 로그 유실. 장점: 타임스탬프 기반 정렬이 finalize 시점에 가능.
//   - 에이전트 깊이(depth)는 startAgent() 호출 시 parentAgentId를 기반으로 자동 계산.
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
    this.filePath = path.join(logDir, `search-${timestamp}.jsonl`);
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
      const lines = this.buildFlatLog();
      await writeFile(this.filePath, lines.join("\n") + "\n");
    } catch (err) {
      process.stderr.write(`[logger] JSONL 파일 저장 실패: ${err}\n`);
    }
  }

  // 모든 에이전트의 이벤트를 모아 타임스탬프 순으로 정렬한 뒤,
  // 각 이벤트를 depth * 2 스페이스로 들여쓴 JSON 줄로 변환한다.
  // ISO 8601 타임스탬프는 문자열 사전순 정렬이 시간순 정렬과 동일하다.
  private buildFlatLog(): string[] {
    const entries: { timestamp: string; agentId: string; depth: number; kind: LogEventKind; payload: unknown }[] = [];

    for (const agent of this.agents.values()) {
      for (const event of agent.events) {
        entries.push({
          timestamp: event.timestamp,
          agentId: agent.agentId,
          depth: agent.depth,
          kind: event.kind,
          payload: event.payload,
        });
      }
    }

    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return entries.map(({ timestamp, agentId, depth, kind, payload }) => {
      const indent = " ".repeat(depth * 2);
      return indent + JSON.stringify({ timestamp, agentId, depth, kind, payload });
    });
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
        const action = p["action"];
        if (action === "done") {
          process.stderr.write(`${tag} [${round}라운드] 판단: 탐색 종료 — ${p["reason"]}\n`);
        } else if (action === "search") {
          process.stderr.write(`${tag} [${round}라운드] 판단: 검색 → ${p["engine"]}: "${p["query"]}" (page ${p["page"]})\n`);
          if (p["rationale"]) process.stderr.write(`  이유: ${p["rationale"]}\n`);
        } else if (action === "paginate") {
          process.stderr.write(`${tag} [${round}라운드] 판단: 페이지 이동 → ${p["engine"]}: "${p["query"]}" (page ${p["page"]})\n`);
          if (p["rationale"]) process.stderr.write(`  이유: ${p["rationale"]}\n`);
        } else if (action === "explore_parallel") {
          const branches = (p["branches"] as Array<Record<string, unknown>>) ?? [];
          process.stderr.write(`${tag} [${round}라운드] 판단: 병렬 탐색 ${branches.length}개\n`);
          for (const b of branches) {
            process.stderr.write(`  → ${b["url"]} (${b["linkId"]})\n`);
          }
          if (p["rationale"]) process.stderr.write(`  이유: ${p["rationale"]}\n`);
        } else if (action === "explore") {
          process.stderr.write(`${tag} [${round}라운드] 판단: 탐색 → ${p["url"]} (${p["linkId"]})\n`);
          if (p["rationale"]) process.stderr.write(`  이유: ${p["rationale"]}\n`);
        } else if (action === "rejected") {
          process.stderr.write(`${tag} [${round}라운드] 판단 거부 (${String(p["requestedAction"] ?? "?")}) — ${p["reason"]}\n`);
        } else {
          process.stderr.write(`${tag} [${round}라운드] 판단: ${String(action)} (${String(p["reason"] ?? "")})\n`);
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
