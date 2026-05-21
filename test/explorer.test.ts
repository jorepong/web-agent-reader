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
    // 스키마가 "complete"/"partial"/"none"를 강제하지만 프롬프트도 partial 선택을
    // 명시적으로 가능한 옵션으로 다룸을 검증.
    expect(messages[0]?.content).toContain("partial");
    expect(messages[0]?.content).toContain("missingInfo");
    expect(messages[0]?.content).not.toContain("suggestedLinks");
  });
});
