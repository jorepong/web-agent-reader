import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_CONFIG,
  loadSearchConfig,
  resolveCliVersion,
} from "../src/search/config.js";

describe("search config", () => {
  it("loads defaults when the config file is missing", async () => {
    const config = await loadSearchConfig(path.join(tmpdir(), "missing-llm-search-config.json"));

    expect(config).toEqual(DEFAULT_SEARCH_CONFIG);
  });

  it("merges configured version and limits with defaults", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-search-config-"));
    const configPath = path.join(dir, "llm-search.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "v1",
        limits: {
          v1: { maxRounds: 7 },
          v2: { maxExplores: 4, maxDepth: 2 },
        },
      })
    );

    const config = await loadSearchConfig(configPath);

    expect(config.version).toBe("v1");
    expect(config.limits.v1.maxRounds).toBe(7);
    expect(config.limits.v1.maxSearches).toBe(DEFAULT_SEARCH_CONFIG.limits.v1.maxSearches);
    expect(config.limits.v2.maxExplores).toBe(4);
    expect(config.limits.v2.maxDepth).toBe(2);
    expect(config.limits.v2.maxSearches).toBe(DEFAULT_SEARCH_CONFIG.limits.v2.maxSearches);
  });

  it("lets CLI version flags override the config default", () => {
    expect(resolveCliVersion(["--v1"], DEFAULT_SEARCH_CONFIG)).toBe("v1");
    expect(resolveCliVersion(["--version", "v2"], { ...DEFAULT_SEARCH_CONFIG, version: "v1" })).toBe("v2");
    expect(resolveCliVersion([], { ...DEFAULT_SEARCH_CONFIG, version: "v1" })).toBe("v1");
  });
});
