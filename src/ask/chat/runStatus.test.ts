import { describe, expect, it } from "vitest";
import { currentStepLabel, formatElapsed } from "./runStatus.ts";
import { EMPTY_TRACE, type RunTrace, type TracePhase, type TraceTool } from "./runTrace.ts";

function phase(name: string): TracePhase {
  return {
    phase: name,
    state: "done",
    durationMs: 1000,
    score: null,
    reasoning: null,
    sql: null,
    sqlParams: null,
    planGate: null,
    plan: null,
    rationale: null,
  };
}

function tool(name: string, output: string | null): TraceTool {
  return { callId: name, name, input: {}, output };
}

function trace(parts: Partial<RunTrace>): RunTrace {
  return { ...EMPTY_TRACE, phases: [], tools: [], ...parts };
}

// --- what is running, which is the one thing the stream does not send -----
//
// A data-phase part arrives when a phase ENDS, so the phase currently
// running is always the one after the last part received. Reading the
// labels off the finished steps would name the step that just stopped.

describe("naming the step in flight", () => {
  it("names the first phase before anything has reported", () => {
    expect(currentStepLabel(trace({}))).toBe("Reading the schema");
  });

  it("names the phase after the last one that finished", () => {
    expect(currentStepLabel(trace({ phases: [phase("research")] }))).toBe(
      "Planning the approach",
    );
    expect(currentStepLabel(trace({ phases: [phase("research"), phase("plan")] }))).toBe(
      "Running the query",
    );
  });

  it("says the answer is being written once every phase has reported", () => {
    // The one stretch of a run with no event of its own.
    const all = ["research", "plan", "execute", "validate"].map(phase);

    expect(currentStepLabel(trace({ phases: all }))).toBe("Writing the answer");
  });
});

describe("a tool in flight beats the phase around it", () => {
  it("names the tool still waiting on its result", () => {
    // "Running the query" for forty seconds says less than naming the
    // thing actually being waited on.
    const t = trace({ phases: [phase("research"), phase("plan")], tools: [tool("run_sql", null)] });

    expect(currentStepLabel(t)).toBe("Querying the warehouse");
  });

  it("falls back to the phase once every tool has returned", () => {
    const t = trace({
      phases: [phase("research"), phase("plan")],
      tools: [tool("run_sql", "4 rows")],
    });

    expect(currentStepLabel(t)).toBe("Running the query");
  });

  it("names an unknown tool by its own name rather than saying nothing", () => {
    const t = trace({ tools: [tool("some_new_tool", null)] });

    expect(currentStepLabel(t)).toBe("Running some_new_tool");
  });

  it("picks the first tool still out when several are", () => {
    const t = trace({ tools: [tool("run_sql", "ok"), tool("show_comparison", null)] });

    expect(currentStepLabel(t)).toBe("Laying out the comparison");
  });
});

// --- the clock -------------------------------------------------------------

describe("the elapsed clock", () => {
  it("counts whole seconds, never tenths", () => {
    // A counter flickering ten times a second reads as agitation, and
    // nobody waiting on a forty-second run needs to know the tenth.
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1_400)).toBe("1s");
    expect(formatElapsed(41_900)).toBe("41s");
  });

  it("switches to minutes past sixty seconds, zero-padded", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(64_000)).toBe("1m 04s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });

  it("never shows a negative clock when the clocks disagree", () => {
    expect(formatElapsed(-500)).toBe("0s");
  });
});
