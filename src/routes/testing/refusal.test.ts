import { describe, expect, it } from "vitest";
import { classifyGateReason } from "./refusal.ts";

// Each fixture is copied verbatim from agent-service/app/learning/gate.py's
// own reason construction (not paraphrased) so a wording drift there fails
// this test, not a live promotion attempt in production.
describe("classifyGateReason", () => {
  it("reads a zero-case suite as empty-suite, distinct from a thin one", () => {
    const reason =
      "no active test cases for agent 3 ('analytics') phase 'execute' — nothing to evaluate, refusing rather than allowing by default";
    expect(classifyGateReason(reason)).toBe("empty-suite");
  });

  it("reads a below-floor suite as thin-suite", () => {
    const reason =
      "only 3 active test case(s) for agent 3 ('analytics') phase 'execute' — below the minimum of 5, refusing rather than trusting a verdict too small to average out judge noise or catch a single fabrication (see the module docstring)";
    expect(classifyGateReason(reason)).toBe("thin-suite");
  });

  it("reads an all-errored baseline as judge-broken", () => {
    const reason =
      "baseline suite for phase 'execute' produced no usable signal (6 case(s), all errored) — refusing rather than treating an unusable baseline as evidence of no regression";
    expect(classifyGateReason(reason)).toBe("judge-broken");
  });

  it("reads a real regression as regressed", () => {
    const reason = "2 case(s) regressed: 14, 22";
    expect(classifyGateReason(reason)).toBe("regressed");
  });

  it("falls back to unknown-refusal for anything else, never misreading it as one of the four", () => {
    expect(classifyGateReason("no regressions across 6 case(s)")).toBe("unknown-refusal");
    expect(classifyGateReason("")).toBe("unknown-refusal");
  });

  it("keeps all four real reasons pairwise distinguishable", () => {
    const kinds = new Set([
      classifyGateReason("... nothing to evaluate, refusing rather than allowing by default"),
      classifyGateReason("... below the minimum of 5, refusing rather than ..."),
      classifyGateReason("... produced no usable signal (3 case(s), all errored) ..."),
      classifyGateReason("1 case(s) regressed: 9"),
    ]);
    expect(kinds.size).toBe(4);
  });
});
