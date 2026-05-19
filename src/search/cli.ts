#!/usr/bin/env node
// llm-search CLI 진입점.
// 환경 변수 로드 → 인자 파싱 → 검색 실행 → 결과 stdout 출력.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { option } from "../cli-utils.js";
import { DebugLogger } from "./logger.js";
import { OpenAIClient } from "./openai-client.js";
import { runSearch } from "./orchestrator.js";

// .env 파일을 파싱해 process.env에 주입한다.
// 이미 설정된 환경 변수는 덮어쓰지 않는다 — 시스템 환경 변수가 .env보다 우선.
async function loadEnvFile(envPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(envPath, "utf-8");
  } catch {
    // .env 파일이 없으면 조용히 무시 (필수 파일이 아님)
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    // 값이 큰따옴표로 감싸인 경우 따옴표 제거 (KEY="value" → value)
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const logDir = option(args, "--log-dir") ?? ".";
  // 로거를 먼저 생성해 try/catch 양쪽에서 finalize()를 호출할 수 있도록 스코프 밖에 선언
  const logger = new DebugLogger(debug, logDir);

  try {
    const envFile = option(args, "--env") ?? path.join(process.cwd(), ".env");
    await loadEnvFile(envFile);

    const query = option(args, "--query");
    if (!query) {
      console.log(`llm-search

Usage:
  llm-search --query "<question>" [--model gpt-5.4-mini] [--debug] [--log-dir .] [--env .env]
`);
      process.exitCode = query === undefined ? 0 : 1;
      return;
    }

    const model = option(args, "--model") ?? "gpt-5.4-mini";

    await logger.init();
    const client = new OpenAIClient(model, logger);
    const answer = await runSearch({ query, model, debug, logDir }, client, logger);
    // finalize: 정상 종료 시 로그 저장. 크래시 전에 반드시 호출해야 로그가 남는다.
    await logger.finalize();
    console.log(answer);
  } catch (error) {
    // finalize: 오류 종료 시에도 로그를 저장해 디버깅에 활용
    await logger.finalize();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
