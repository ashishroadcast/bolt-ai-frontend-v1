import { describe, expect, it } from "vitest";
import { buildRunTrace, formatCost, formatDuration, modelsFromUsage, type TraceEvent } from "./runTrace.ts";

/**
 * The fixture is a real `/agent/run` stream, captured 2026-08-28 from the
 * Sales-Analyst agent answering "Top 5 stores by net sales in the last 30
 * days" — trimmed to the fields, not invented. Testing against a
 * hand-written idea of the protocol is how the previous rail ended up
 * asserting `{phase, state}` while the wire had been sending SQL, scores
 * and judge reasoning the whole time.
 */
const CAPTURED: TraceEvent[] = [
  { kind: "phase", at: 10, data: { phase: "research", state: "done", duration_ms: 24.45 } },
  { kind: "phase", at: 20, data: { phase: "plan", state: "cached", duration_ms: 9958.55 } },
  { kind: "tool-input", at: 30, callId: "call_1", name: "find_schema", input: { query: "rpt_daily_sales" } },
  { kind: "tool-output", at: 31, callId: "call_1", output: "Table-name convention: ..." },
  { kind: "tool-input", at: 40, callId: "call_2", name: "run_sql", input: { sql: "SELECT 1" } },
  { kind: "tool-output", at: 41, callId: "call_2", output: "store_id | net_sales" },
  {
    kind: "phase",
    at: 50,
    data: {
      phase: "execute",
      state: "done",
      duration_ms: 65393.74,
      sql: "SELECT r.store_id FROM public.rpt_daily_sales AS r",
      sql_params: {},
    },
  },
  {
    kind: "phase",
    at: 60,
    data: {
      phase: "validate",
      state: "done",
      duration_ms: 14375.18,
      score: 0.0,
      reasoning: "None of those figures appear in the supplied evidence.",
    },
  },
];

describe("buildRunTrace", () => {
  it("reads one step per phase and per tool call, in the order they happened", () => {
    const trace = buildRunTrace(CAPTURED);

    expect(trace.steps.map((step) => step.label)).toEqual([
      "Researched the question",
      "Reused the cached plan",
      "Called find_schema",
      "Called run_sql",
      "Ran the plan",
      "Validated the answer",
    ]);
  });

  it("keeps the SQL the service actually ran, not only the one the model drafted", () => {
    const trace = buildRunTrace(CAPTURED);

    // The run_sql tool argument and the execute phase's own `sql` are two
    // different strings — the second is the scoped, clamped one that
    // touched the database.
    expect(trace.tools[1]!.input.sql).toBe("SELECT 1");
    expect(trace.executedSql).toBe("SELECT r.store_id FROM public.rpt_daily_sales AS r");
  });

  it("keeps the judge's score and its own prose", () => {
    const trace = buildRunTrace(CAPTURED);
    expect(trace.score).toBe(0);
    expect(trace.reasoning).toBe("None of those figures appear in the supplied evidence.");
  });

  it("pairs a tool result with its own call, never with whichever call is newest", () => {
    const interleaved: TraceEvent[] = [
      { kind: "tool-input", at: 1, callId: "call_1", name: "find_schema", input: {} },
      { kind: "tool-input", at: 2, callId: "call_2", name: "run_sql", input: {} },
      { kind: "tool-output", at: 3, callId: "call_1", output: "schema text" },
    ];
    const trace = buildRunTrace(interleaved);

    expect(trace.tools[0]!.output).toBe("schema text");
    expect(trace.tools[1]!.output).toBeNull();
  });

  it("marks a cached plan by form and word, not only by colour", () => {
    const [, cachedPlan] = buildRunTrace(CAPTURED).steps;
    expect(cachedPlan!.chip).toBe("cached");
    expect(cachedPlan!.icon).toBe("cached");
    expect(cachedPlan!.tone).toBe("cached");
  });

  it("calls a below-bar score weak and a passing one good, against the service's own 0.7", () => {
    const weak = buildRunTrace([{ kind: "phase", at: 1, data: { phase: "validate", score: 0.69 } }]).steps[0]!;
    const good = buildRunTrace([{ kind: "phase", at: 1, data: { phase: "validate", score: 0.7 } }]).steps[0]!;

    expect(weak.tone).toBe("weak");
    expect(weak.chip).toBe("score 0.69");
    expect(good.tone).toBe("good");
  });

  it("drops a phase part with no phase name rather than inventing one", () => {
    const trace = buildRunTrace([
      { kind: "phase", at: 1, data: { state: "done", duration_ms: 5 } },
      { kind: "phase", at: 2, data: { phase: "research", state: "done" } },
    ]);
    expect(trace.steps).toHaveLength(1);
    expect(trace.phases.map((phase) => phase.phase)).toEqual(["research"]);
  });

  it("reports no measure for a phase that sent no duration, rather than 0.0s", () => {
    const step = buildRunTrace([{ kind: "phase", at: 1, data: { phase: "research", state: "done" } }]).steps[0]!;
    expect(step.measure).toBeNull();
  });
});

describe("modelsFromUsage", () => {
  it("names the models a run billed, without LiteLLM's routing prefix, deduplicated", () => {
    const models = modelsFromUsage({
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      cost_usd: 0.1,
      duration_ms: 10,
      calls: [
        { model: "openrouter/openai/gpt-5-mini", input_tokens: 1, output_tokens: 1, cost_usd: 0.05, priced: true },
        { model: "openrouter/openai/gpt-5-mini", input_tokens: 0, output_tokens: 0, cost_usd: 0.05, priced: true },
        { model: "openrouter/anthropic/claude", input_tokens: 0, output_tokens: 0, cost_usd: 0, priced: true },
      ],
    });

    expect(models).toEqual(["openai/gpt-5-mini", "anthropic/claude"]);
  });

  it("names nothing when the run reported no calls — never a placeholder model", () => {
    expect(modelsFromUsage(null)).toEqual([]);
    expect(
      modelsFromUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, duration_ms: 0 }),
    ).toEqual([]);
  });
});

describe("formatting", () => {
  it("reads a sub-minute run in seconds and a longer one in minutes", () => {
    expect(formatDuration(400)).toBe("0.4s");
    // Zero-padded, the way the live counter writes it.
    expect(formatDuration(65_393)).toBe("1m 05s");
    expect(formatDuration(59_960)).toBe("1m 00s");
    expect(formatDuration(59_940)).toBe("59.9s");
  });

  it("never prints a real cost as free", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.021631)).toBe("$0.0216");
    // Rounds to $0.0000 at four places — saying so beats saying "free".
    expect(formatCost(0.00002)).toBe("<$0.0001");
  });
});
