import { readFile } from "node:fs/promises";
import path from "node:path";
import { option } from "../cli-utils.js";
import { DebugLogger } from "./logger.js";
import { OpenAIClient } from "./openai-client.js";
import { runSearch } from "./orchestrator.js";
import { loadSearchConfig, resolveCliVersion, SEARCH_CONFIG_FILE, type SearchVersion } from "./config.js";
import { V2Logger } from "./v2/logger.js";
import { research } from "./v2/researcher.js";

// .env 파일을 파싱해 process.env에 주입한다.
// 이미 설정된 환경 변수는 덮어쓰지 않는다 — 시스템 환경 변수가 .env보다 우선.
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

export function detectForcedVersionFromBin(binPath = process.argv[1] ?? ""): SearchVersion | undefined {
  const bin = path.basename(binPath);
  if (bin.includes("v1")) return "v1";
  if (bin.includes("v2")) return "v2";
  return undefined;
}

export async function runSearchCli(forcedVersion?: SearchVersion): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const logDir = option(args, "--log-dir") ?? ".";
  const configPath = option(args, "--config") ?? path.join(process.cwd(), SEARCH_CONFIG_FILE);

  let logger: DebugLogger = new DebugLogger(debug, logDir);

  try {
    const envFile = option(args, "--env") ?? path.join(process.cwd(), ".env");
    await loadEnvFile(envFile);

    const config = await loadSearchConfig(configPath);
    const version = resolveCliVersion(args, config, forcedVersion);

    const query = option(args, "--query");
    if (!query) {
      console.log(usageText(version));
      process.exitCode = query === undefined ? 0 : 1;
      return;
    }

    const model = option(args, "--model") ?? "gpt-5.4-mini";

    if (version === "v2") {
      logger = new V2Logger(debug, logDir);
      await logger.init();
      const client = new OpenAIClient(model, logger);
      const answer = await research(query, { model, debug, logDir, budget: config.limits.v2 }, client, logger as V2Logger);
      await logger.finalize();
      console.log(answer);
      return;
    }

    logger = new DebugLogger(debug, logDir);
    await logger.init();
    const client = new OpenAIClient(model, logger);
    const answer = await runSearch({ query, model, debug, logDir, limits: config.limits.v1 }, client, logger);
    await logger.finalize();
    console.log(answer);
  } catch (error) {
    await logger.finalize();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function usageText(defaultVersion: SearchVersion): string {
  return `llm-search

Usage:
  llm-search --query "<question>" [--v1 | --v2 | --version v1|v2] [--config ${SEARCH_CONFIG_FILE}] [--model gpt-5.4-mini] [--debug] [--log-dir .] [--env .env]
  llm-search-v1 --query "<question>" [--config ${SEARCH_CONFIG_FILE}] [options]
  llm-search-v2 --query "<natural-language goal>" [--config ${SEARCH_CONFIG_FILE}] [options]

Default version from config: ${defaultVersion}
`;
}
