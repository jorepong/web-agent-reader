import { describe, expect, it } from "vitest";
import { buildExplorerInitialPrompt, MAX_DEPTH } from "../src/search/prompts.js";

describe("buildExplorerInitialPrompt", () => {
  it("allows a max-depth explorer to return partial findings", () => {
    const messages = buildExplorerInitialPrompt({
      agentId: "explorer-1-l2-l3",
      parentAgentId: "explorer-1-l2",
      goal: "Extract complete historical roster",
      url: "https://lol.fandom.com/wiki/T1",
      parentGoal: "페이커와 함께한 역대 탑라이너",
      depth: MAX_DEPTH,
    }, "T1 page content");

    expect(messages[0]?.content).toContain("You cannot explore further links.");
    expect(messages[0]?.content).toContain('"completeness": "partial"');
    expect(messages[0]?.content).toContain('"missingInfo": ["what is missing or which verification could not be performed"]');
    expect(messages[0]?.content).not.toContain("suggestedLinks");
  });
});
