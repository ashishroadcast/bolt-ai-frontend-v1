import { describe, expect, it } from "vitest";
import { activeCases, casesForPhase, isThinSuite, MIN_SUITE_SIZE } from "./suite.ts";
import type { AgentTestCase } from "./types.ts";

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 1,
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

describe("activeCases", () => {
  it("keeps only cases with is_active true", () => {
    const cases = [testCase({ id: 1, is_active: true }), testCase({ id: 2, is_active: false })];
    expect(activeCases(cases).map((c) => c.id)).toEqual([1]);
  });
});

describe("casesForPhase", () => {
  it("keeps only cases matching the given phase", () => {
    const cases = [
      testCase({ id: 1, phase: "execute" }),
      testCase({ id: 2, phase: "plan" }),
      testCase({ id: 3, phase: "execute" }),
    ];
    expect(casesForPhase(cases, "execute").map((c) => c.id)).toEqual([1, 3]);
  });
});

describe("isThinSuite", () => {
  it(`is true below ${MIN_SUITE_SIZE} active cases, including zero`, () => {
    expect(isThinSuite(0)).toBe(true);
    expect(isThinSuite(MIN_SUITE_SIZE - 1)).toBe(true);
  });

  it(`is false at or above ${MIN_SUITE_SIZE} active cases`, () => {
    expect(isThinSuite(MIN_SUITE_SIZE)).toBe(false);
    expect(isThinSuite(MIN_SUITE_SIZE + 10)).toBe(false);
  });
});
