import { describe, expect, it } from "vitest";
import {
  buildPhaseTimeline,
  readPhaseDetail,
  withWidths,
  type PhaseTimelineEvent,
} from "./phaseTimeline.ts";

// The golden fixture's own timing shape (research 0.4s, plan 1.1s, then a
// tool round-trip, then validate 0.6s later) — mirrors agent-service/tests/
// fixtures/stream/run.jsonl's event *order*, with invented-but-realistic
// gaps standing in for real wall-clock time.
function goldenEvents(): PhaseTimelineEvent[] {
  return [
    { at: 0, kind: "run-start" },
    { at: 400, kind: "phase", phase: "research", state: "done" },
    { at: 1500, kind: "phase", phase: "plan", state: "done" },
    { at: 1600, kind: "tool" }, // tool-input-available
    { at: 4300, kind: "tool" }, // tool-output-available
    { at: 4900, kind: "phase", phase: "validate", state: "done" },
    { at: 4900, kind: "run-end" },
  ];
}

describe("buildPhaseTimeline", () => {
  it("produces one segment per reached phase, in order", () => {
    const segments = buildPhaseTimeline(goldenEvents());
    expect(segments.map((s) => s.phase)).toEqual(["research", "plan", "execute", "validate"]);
  });

  it("derives each segment's duration from real elapsed time between events, not a fixed split", () => {
    const segments = buildPhaseTimeline(goldenEvents());
    const byPhase = Object.fromEntries(segments.map((s) => [s.phase, s.durationMs]));

    expect(byPhase.research).toBe(400); // 0 -> 400
    expect(byPhase.plan).toBe(1100); // 400 -> 1500
    expect(byPhase.execute).toBe(3400); // 1500 -> 4900 (closed by validate)
    expect(byPhase.validate).toBe(0); // validate and run-end land on the same tick here
  });

  it("marks execute as inferred and every explicitly-named phase as not inferred", () => {
    const segments = buildPhaseTimeline(goldenEvents());
    const byPhase = Object.fromEntries(segments.map((s) => [s.phase, s.inferred]));
    expect(byPhase.execute).toBe(true);
    expect(byPhase.research).toBe(false);
    expect(byPhase.plan).toBe(false);
    expect(byPhase.validate).toBe(false);
  });

  it("shows a run that stopped at plan as two segments, not an error state", () => {
    const segments = buildPhaseTimeline([
      { at: 0, kind: "run-start" },
      { at: 300, kind: "phase", phase: "research", state: "done" },
      { at: 900, kind: "phase", phase: "plan", state: "done" },
      { at: 950, kind: "run-end" }, // refusal / early return — no tool calls, no validate
    ]);

    expect(segments.map((s) => s.phase)).toEqual(["research", "plan"]);
    // No execute segment: no tool activity was ever observed, so there is
    // nothing honest to attribute that 50ms gap to.
    expect(segments.some((s) => s.phase === "execute")).toBe(false);
  });

  it("never double-counts execute when a future backend sends an explicit data-phase execute event", () => {
    const segments = buildPhaseTimeline([
      { at: 0, kind: "run-start" },
      { at: 200, kind: "phase", phase: "research", state: "done" },
      { at: 500, kind: "phase", phase: "plan", state: "done" },
      { at: 600, kind: "tool" },
      { at: 900, kind: "phase", phase: "execute", state: "done" },
      { at: 1000, kind: "phase", phase: "validate", state: "done" },
      { at: 1000, kind: "run-end" },
    ]);

    const executeSegments = segments.filter((s) => s.phase === "execute");
    expect(executeSegments).toHaveLength(1);
    expect(executeSegments[0]).toMatchObject({ inferred: false, durationMs: 400 }); // 500 -> 900
  });

  it("supports guardrail and agent phases when a run reaches them", () => {
    const segments = buildPhaseTimeline([
      { at: 0, kind: "run-start" },
      { at: 100, kind: "phase", phase: "research", state: "done" },
      { at: 200, kind: "phase", phase: "plan", state: "done" },
      { at: 250, kind: "tool" },
      { at: 400, kind: "phase", phase: "validate", state: "done" },
      { at: 450, kind: "phase", phase: "guardrail", state: "done" },
      { at: 500, kind: "phase", phase: "agent", score: 0.88 },
      { at: 500, kind: "run-end" },
    ]);

    expect(segments.map((s) => s.phase)).toEqual([
      "research",
      "plan",
      "execute",
      "validate",
      "guardrail",
      "agent",
    ]);
    expect(segments.find((s) => s.phase === "agent")?.score).toBe(0.88);
  });

  it("drops a phase name this bundle doesn't recognise instead of guessing", () => {
    const segments = buildPhaseTimeline([
      { at: 0, kind: "run-start" },
      { at: 100, kind: "phase", phase: "research", state: "done" },
      { at: 200, kind: "phase", phase: "some-future-phase", state: "done" },
      { at: 300, kind: "run-end" },
    ]);
    expect(segments.map((s) => s.phase)).toEqual(["research"]);
  });

  it("honours an explicit forward-compat score/duration override on a named phase", () => {
    const segments = buildPhaseTimeline([
      { at: 0, kind: "run-start" },
      { at: 100, kind: "phase", phase: "research", state: "done" },
      { at: 200, kind: "phase", phase: "validate", state: "done", score: 0.92, durationMs: 55 },
      { at: 200, kind: "run-end" },
    ]);
    const validate = segments.find((s) => s.phase === "validate");
    expect(validate).toMatchObject({ score: 0.92, durationMs: 55 });
  });
});

describe("withWidths", () => {
  it("assigns widths proportional to real durations, not an equal split", () => {
    const segments = buildPhaseTimeline(goldenEvents());
    const withPct = withWidths(segments);
    const byPhase = Object.fromEntries(withPct.map((s) => [s.phase, s.widthPercent]));

    // Total accounted-for time: 400 + 1100 + 3400 + 0 = 4900.
    expect(byPhase.research).toBeCloseTo((400 / 4900) * 100, 5);
    expect(byPhase.plan).toBeCloseTo((1100 / 4900) * 100, 5);
    expect(byPhase.execute).toBeCloseTo((3400 / 4900) * 100, 5);

    // The whole point of "time-proportional, not a stepper": these must
    // differ. A rail that rendered every bar at 100/N% would pass a test
    // that only checked "some width is set" but fail this one outright.
    const widths = withPct.map((s) => s.widthPercent);
    expect(new Set(widths).size).toBeGreaterThan(1);
    expect(byPhase.execute).toBeGreaterThan(byPhase.research);
  });

  it("sums to (approximately) 100% across all segments", () => {
    const withPct = withWidths(buildPhaseTimeline(goldenEvents()));
    const sum = withPct.reduce((acc, s) => acc + s.widthPercent, 0);
    expect(sum).toBeCloseTo(100, 5);
  });

  it("falls back to 0 width for every bar rather than dividing by zero on an empty timeline", () => {
    expect(withWidths([])).toEqual([]);
  });
});

describe("readPhaseDetail", () => {
  // The Inspector rendered "the query, plan gate and judge reasoning for
  // this phase aren't wired up yet" over live data: the note was true when
  // written and stopped being true once pipeline._phase_event started
  // sending these fields.

  it("reads what research found", () => {
    expect(readPhaseDetail({ phase: "research", findings: "Two stores, 30 days." })).toEqual({
      findings: "Two stores, 30 days.",
    });
  });

  it("reads the plan as ordered steps", () => {
    const detail = readPhaseDetail({ plan: ["Sum by store", "Rank"], rationale: "No join needed" });

    expect(detail?.plan).toEqual(["Sum by store", "Rank"]);
    expect(detail?.rationale).toBe("No join needed");
  });

  it("reads the query that actually ran, with its parameters", () => {
    const detail = readPhaseDetail({
      sql: "SELECT 1",
      sql_params: { tenant_id: 7 },
    });

    expect(detail?.sql).toBe("SELECT 1");
    expect(detail?.sqlParams).toEqual({ tenant_id: 7 });
  });

  it("reads the judge's verdict, reasoning and objections", () => {
    const detail = readPhaseDetail({
      score: 0.72,
      verdict: "pass",
      reasoning: "Matches the rows.",
      issues: "Truncates at five of twenty-six.",
    });

    expect(detail?.verdict).toBe("pass");
    expect(detail?.reasoning).toBe("Matches the rows.");
    expect(detail?.issues).toBe("Truncates at five of twenty-six.");
  });

  it("is undefined when a phase reported nothing beyond its timing", () => {
    // Undefined, not {}: the Inspector renders a "reported nothing" state,
    // and an empty object would render an empty panel instead.
    expect(readPhaseDetail({ phase: "research", state: "done" })).toBeUndefined();
  });

  it("ignores an empty string and an empty plan", () => {
    // A knowledge agent's execute never runs SQL; "" must not render as a
    // query block containing nothing.
    expect(readPhaseDetail({ findings: "", sql: "", plan: [] })).toBeUndefined();
  });
});
