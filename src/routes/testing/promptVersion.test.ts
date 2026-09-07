import { describe, expect, it } from "vitest";
import { latestPromptVersion, versionFromUri } from "./promptVersion.ts";
import type { AgentTestCase } from "./types.ts";

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 3,
    phase: "execute",
    question: "q",
    expected: "e",
    is_active: true,
    last_score: null,
    last_verdict: null,
    last_actual: null,
    last_reasoning: null,
    last_ran_at: null,
    last_prompt_version: null,
    last_tools_used: null,
    last_duration_ms: null,
    last_usage: null,
    trace_id: null,
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    ...overrides,
  };
}

describe("latestPromptVersion", () => {
  it("returns null when no case has ever run", () => {
    expect(latestPromptVersion([testCase({})])).toBeNull();
  });

  it("picks the ref from whichever case ran most recently", () => {
    const older = testCase({
      id: 1,
      last_ran_at: "2026-08-20T10:00:00Z",
      last_prompt_version: { uri: "prompts:/analytics-execute/6", alias: "production" },
    });
    const newer = testCase({
      id: 2,
      last_ran_at: "2026-08-27T10:00:00Z",
      last_prompt_version: { uri: "prompts:/analytics-execute/7", alias: "production" },
    });

    expect(latestPromptVersion([older, newer])).toEqual({
      uri: "prompts:/analytics-execute/7",
      alias: "production",
    });
    // Order in the input shouldn't matter.
    expect(latestPromptVersion([newer, older])).toEqual({
      uri: "prompts:/analytics-execute/7",
      alias: "production",
    });
  });
});

describe("versionFromUri", () => {
  it("extracts the trailing version integer", () => {
    expect(versionFromUri("prompts:/analytics-execute/7")).toBe(7);
  });

  it("returns null for a URI with no trailing version", () => {
    expect(versionFromUri("prompts:/analytics-execute")).toBeNull();
  });
});
