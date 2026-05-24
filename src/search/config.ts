import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchLimits } from "./types.js";
import type { BudgetLimits } from "./v2/types.js";

export type SearchVersion = "v1" | "v2";

export interface SearchToolConfig {
  version: SearchVersion;
  limits: {
    v1: SearchLimits;
    v2: BudgetLimits;
  };
}

export const SEARCH_CONFIG_FILE = "llm-search.config.json";

export const DEFAULT_V1_LIMITS: SearchLimits = {
  maxRounds: 12,
  maxSearches: 5,
  maxExplores: 5,
  maxParallel: 3,
  maxDepth: 2,
  maxChildCallsPerAgent: 3,
};

export const DEFAULT_V2_LIMITS: BudgetLimits = {
  maxRounds: 20,
  maxSearches: 8,
  maxExplores: 10,
  maxParallel: 3,
  maxDepth: 3,
  maxChildCallsPerAgent: 3,
};

export const DEFAULT_SEARCH_CONFIG: SearchToolConfig = {
  version: "v2",
  limits: {
    v1: DEFAULT_V1_LIMITS,
    v2: DEFAULT_V2_LIMITS,
  },
};

type RawConfig = {
  version?: unknown;
  limits?: {
    v1?: Partial<Record<keyof SearchLimits, unknown>>;
    v2?: Partial<Record<keyof BudgetLimits, unknown>>;
  };
};

const LIMIT_KEYS: Array<keyof SearchLimits> = [
  "maxRounds",
  "maxSearches",
  "maxExplores",
  "maxParallel",
  "maxDepth",
  "maxChildCallsPerAgent",
];

export async function loadSearchConfig(configPath = path.join(process.cwd(), SEARCH_CONFIG_FILE)): Promise<SearchToolConfig> {
  let rawText: string;
  try {
    rawText = await readFile(configPath, "utf-8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return cloneConfig(DEFAULT_SEARCH_CONFIG);
    throw err;
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(rawText) as RawConfig;
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const version = normalizeVersion(raw.version, DEFAULT_SEARCH_CONFIG.version, `${configPath}: version`);
  return {
    version,
    limits: {
      v1: normalizeLimits(raw.limits?.v1, DEFAULT_V1_LIMITS, `${configPath}: limits.v1`),
      v2: normalizeLimits(raw.limits?.v2, DEFAULT_V2_LIMITS, `${configPath}: limits.v2`),
    },
  };
}

export function resolveCliVersion(args: string[], config: SearchToolConfig, forcedVersion?: SearchVersion): SearchVersion {
  if (forcedVersion) return forcedVersion;
  const wantsV1 = args.includes("--v1");
  const wantsV2 = args.includes("--v2");
  if (wantsV1 && wantsV2) throw new Error(`Use only one of --v1 or --v2.`);
  if (wantsV1) return "v1";
  if (wantsV2) return "v2";
  const versionFlag = valueAfter(args, "--version");
  return normalizeVersion(versionFlag, config.version, "--version");
}

function normalizeVersion(value: unknown, fallback: SearchVersion, label: string): SearchVersion {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "v1" || value === "1") return "v1";
  if (value === "v2" || value === "2") return "v2";
  throw new Error(`${label} must be "v1" or "v2".`);
}

function normalizeLimits<T extends SearchLimits | BudgetLimits>(
  rawLimits: Partial<Record<keyof T, unknown>> | undefined,
  defaults: T,
  label: string
): T {
  const merged = { ...defaults };
  if (!rawLimits) return merged;

  for (const key of LIMIT_KEYS) {
    const value = rawLimits[key as keyof T];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${label}.${key} must be a positive integer.`);
    }
    (merged as unknown as Record<string, number>)[key] = value;
  }
  return merged;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function cloneConfig(config: SearchToolConfig): SearchToolConfig {
  return {
    version: config.version,
    limits: {
      v1: { ...config.limits.v1 },
      v2: { ...config.limits.v2 },
    },
  };
}
