#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { option } from "../cli-utils.js";
import { DebugLogger } from "./logger.js";
import { OpenAIClient } from "./openai-client.js";
import { runSearch } from "./orchestrator.js";

async function loadEnvFile(envPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const logDir = option(args, "--log-dir") ?? ".";
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
    await logger.finalize();
    console.log(answer);
  } catch (error) {
    await logger.finalize();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
