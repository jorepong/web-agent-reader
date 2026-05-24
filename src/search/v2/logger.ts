// V2Logger — Researcher v2 전용 디버그 로거.
//
// v2의 페이로드 필드(startUrl, answer, …)에 맞춰 stderr 출력을 다시 만들었다.
// JSONL 파일 저장 인프라는 v1과 동일한 방식(시간순 들여쓰기)으로 자체 구현.
//
// 상속 구조의 의미: OpenAIClient가 생성자에서 `logger: DebugLogger` 타입을 요구한다.
// V2Logger를 DebugLogger의 서브클래스로 두면 타입 호환을 얻으면서, 부모의 동작은
// `super(false, ...)` 로 비활성화해 우회한다. 모든 실제 동작은 v2 자체 메서드가
// 처리한다. v1 코드를 수정하지 않으면서 OpenAIClient를 v2에서도 그대로 쓰기 위함.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DebugLogger } from "../logger.js";
import type { LogEventKind } from "../types.js";

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

export class V2Logger extends DebugLogger {
  private v2Enabled: boolean;
  private v2FilePath: string;
  private v2Agents: Map<string, AgentNode> = new Map();

  constructor(enabled: boolean, logDir = ".") {
    // 부모는 enabled=false로 둬 모든 v1 동작(stderr, JSONL 저장)을 무력화.
    super(false, logDir);
    this.v2Enabled = enabled;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.v2FilePath = path.join(logDir, `researcher-${timestamp}.jsonl`);
  }

  async init(): Promise<void> {
    if (!this.v2Enabled) return;
    await mkdir(path.dirname(this.v2FilePath), { recursive: true });
    console.log(`Researcher monitor started`);
    console.log(`JSONL: ${this.v2FilePath}`);
  }

  startAgent(agentId: string, parentAgentId: string | null): void {
    if (!this.v2Enabled) return;
    const parentDepth = parentAgentId ? (this.v2Agents.get(parentAgentId)?.depth ?? -1) : -1;
    this.v2Agents.set(agentId, {
      agentId,
      parentAgentId,
      depth: parentDepth + 1,
      startedAt: new Date().toISOString(),
      events: [],
    });
  }

  async log(kind: LogEventKind, agentId: string, payload: unknown): Promise<void> {
    if (!this.v2Enabled) return;
    this.printV2Status(kind, agentId, payload);
    const agent = this.v2Agents.get(agentId);
    if (agent) {
      agent.events.push({ timestamp: new Date().toISOString(), kind, payload });
    }
  }

  async finalize(): Promise<void> {
    if (!this.v2Enabled || this.v2Agents.size === 0) return;
    try {
      const lines = this.buildFlatLogV2();
      await writeFile(this.v2FilePath, lines.join("\n") + "\n");
      process.stderr.write(`\nmonitor saved: ${this.v2FilePath}\n`);
    } catch (err) {
      process.stderr.write(`[logger] JSONL 파일 저장 실패: ${err}\n`);
    }
  }

  private buildFlatLogV2(): string[] {
    const entries: { timestamp: string; agentId: string; depth: number; kind: LogEventKind; payload: unknown }[] = [];
    for (const agent of this.v2Agents.values()) {
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

  // v2 페이로드에 맞춘 사람이 읽는 stderr 출력.
  private printV2Status(kind: LogEventKind, agentId: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;
    const tag = this.formatTag(agentId);
    switch (kind) {
      case "mission_brief": {
        const brief = p["brief"] as Record<string, unknown>;
        const startUrl = brief["startUrl"];
        const goal = brief["goal"];
        if (typeof startUrl === "string" && startUrl) {
          process.stderr.write(`${tag} START page  ${formatUrl(startUrl)}\n`);
        } else if (brief["parentAgentId"] === null) {
          process.stderr.write(`${tag} START root  goal="${truncate(String(goal ?? ""), 90)}"\n`);
        } else {
          process.stderr.write(`${tag} START task  goal="${truncate(String(goal ?? ""), 90)}"\n`);
        }
        break;
      }
      case "page_markdown": {
        const md = (p["markdown"] as string) ?? "";
        process.stderr.write(`${tag} PAGE  ${formatUrl(String(p["url"] ?? ""))}  chars=${formatNumber(md.length)}\n`);
        break;
      }
      case "page_sections": {
        process.stderr.write(
          `${tag} INDEX sections=${p["sectionCount"] ?? "?"}  chars=${formatNumber(Number(p["totalChars"] ?? 0))}  ${formatUrl(String(p["url"] ?? ""))}\n`
        );
        break;
      }
      case "page_section_selection": {
        const selected = Array.isArray(p["selectedIds"]) ? p["selectedIds"].join(", ") : "";
        const status = p["error"] ? `error="${truncate(String(p["error"]), 100)}"` : `selected=[${selected || "fallback"}]`;
        process.stderr.write(`${tag} READ  ${status}  chars=${formatNumber(Number(p["selectedChars"] ?? 0))}\n`);
        break;
      }
      case "llm_request": {
        const msgs = (p["messages"] as unknown[]) ?? [];
        const schemaName = p["responseSchemaName"];
        const schema = typeof schemaName === "string" && schemaName ? schemaName : "text";
        const effort = p["reasoningEffort"] ? `  effort=${p["reasoningEffort"]}` : "";
        process.stderr.write(`${tag} LLM   schema=${schema}  msgs=${msgs.length}${effort}\n`);
        break;
      }
      case "llm_response": {
        const usage = (p["tokenUsage"] as Record<string, number>) ?? {};
        process.stderr.write(
          `${tag} TOKENS in=${formatNumber(usage["promptTokens"] ?? 0)}  out=${formatNumber(usage["completionTokens"] ?? 0)}  total=${formatNumber(usage["totalTokens"] ?? 0)}\n`
        );
        break;
      }
      case "orchestrator_plan": {
        const round = p["round"] as number;
        const action = p["action"];
        const roundLabel = round >= 0 ? `r${round}` : "forced";
        if (action === "done") {
          const forced = p["forced"] ? " forced" : "";
          process.stderr.write(`${tag} ACTION ${roundLabel} done${forced}\n`);
        } else if (action === "search") {
          process.stderr.write(`${tag} ACTION ${roundLabel} search  ${p["engine"]} p${p["page"]}  "${truncate(String(p["query"] ?? ""), 120)}"\n`);
          this.printReason(agentId, p);
        } else if (action === "paginate") {
          process.stderr.write(`${tag} ACTION ${roundLabel} page    ${p["engine"]} p${p["page"]}  "${truncate(String(p["query"] ?? ""), 120)}"\n`);
          this.printReason(agentId, p);
        } else if (action === "delegate_parallel") {
          const branches = (p["branches"] as Array<Record<string, unknown>>) ?? [];
          process.stderr.write(`${tag} ACTION ${roundLabel} fanout  branches=${branches.length}\n`);
          for (const b of branches) {
            const target = b["url"] ? formatUrl(String(b["url"])) : "task-only";
            const id = b["targetId"] ?? b["linkId"];
            process.stderr.write(`${this.indentFor(agentId)}      - ${id ? `${id} ` : ""}${target}\n`);
          }
          this.printReason(agentId, p);
        } else if (action === "delegate") {
          const target = p["url"] ? formatUrl(String(p["url"])) : "task-only";
          const id = p["targetId"] ?? p["linkId"];
          process.stderr.write(`${tag} ACTION ${roundLabel} delegate ${id ? `${id} ` : ""}${target}\n`);
          this.printReason(agentId, p);
        } else if (action === "read_sections") {
          const sectionIds = Array.isArray(p["sectionIds"]) ? p["sectionIds"].join(", ") : "";
          process.stderr.write(`${tag} ACTION ${roundLabel} read   [${sectionIds}]  ${formatUrl(String(p["url"] ?? ""))}\n`);
          this.printReason(agentId, p);
        } else if (action === "rejected") {
          process.stderr.write(
            `${tag} BLOCK  ${roundLabel} ${String(p["requestedAction"] ?? "?")}  ${truncate(String(p["reason"] ?? ""), 180)}\n`
          );
        } else {
          process.stderr.write(`${tag} ACTION ${roundLabel} ${String(action)}\n`);
        }
        break;
      }
      case "exploration_report": {
        const report = p["report"] as Record<string, unknown>;
        const answer = String(report["answer"] ?? "");
        if (!answer.trim()) {
          process.stderr.write(`${tag} REPORT empty\n`);
        } else {
          const firstNonEmpty = previewAnswerLine(answer);
          process.stderr.write(`${tag} REPORT ${truncate(firstNonEmpty.trim(), 140)}\n`);
        }
        break;
      }
    }
  }

  private formatTag(agentId: string): string {
    const agent = this.v2Agents.get(agentId);
    const depth = agent?.depth ?? 0;
    return `${this.indentFor(agentId)}${shortAgentId(agentId).padEnd(22)} |`;
  }

  private indentFor(agentId: string): string {
    const agent = this.v2Agents.get(agentId);
    return "  ".repeat(agent?.depth ?? 0);
  }

  private printReason(agentId: string, payload: Record<string, unknown>): void {
    if (!payload["rationale"]) return;
    process.stderr.write(`${this.indentFor(agentId)}      reason: ${truncate(String(payload["rationale"]), 180)}\n`);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function formatNumber(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat("en-US").format(n) : "0";
}

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    const compact = `${u.host}${u.pathname}${u.search ? `?${u.searchParams.toString()}` : ""}`;
    return truncate(compact, 120);
  } catch {
    return truncate(url, 120);
  }
}

function shortAgentId(agentId: string): string {
  return agentId.replace(/^researcher-/, "");
}

function previewAnswerLine(answer: string): string {
  const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean);
  const answerIndex = lines.findIndex((line) => /^ANSWER:?$/i.test(line));
  if (answerIndex >= 0) return lines[answerIndex + 1] ?? "ANSWER:";
  return lines.find((line) => !/^(SOURCES|COVERAGE|GAPS|NEXT_CANDIDATES):?$/i.test(line)) ?? "";
}
