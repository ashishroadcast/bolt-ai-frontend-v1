import type { UsageMetadata } from "./protocol.ts";

/**
 * One run's trace, derived from what the stream actually said — the data
 * behind the reasoning card, the metadata strip and the debug panel.
 *
 * **Every field here was read off a real captured `/agent/run` stream**
 * (Sales-Analyst, "Top 5 stores by net sales in the last 30 days",
 * 2026-08-28), not from the type definitions, because the two disagree in
 * both directions. What a `data-phase` part really carries:
 *
 *   {"phase":"research","state":"done","duration_ms":24.45}
 *   {"phase":"plan","state":"cached","duration_ms":9958.55}
 *   {"phase":"execute","state":"done","duration_ms":65393.75,
 *    "sql":"WITH params AS (...)","sql_params":{}}
 *   {"phase":"validate","state":"done","duration_ms":14375.18,
 *    "score":0.0,"reasoning":"The provided answer gives ..."}
 *
 * So the executed SQL and the judge's own prose **do** reach the client,
 * on the `execute`/`validate` phase parts — `agent-service/app/agent/
 * pipeline.py`'s `_phase_event` puts them there. `phaseTimeline.ts`'s
 * module docstring, and `shell/Inspector.tsx`'s "aren't wired up yet"
 * note, both predate that and are stale about it.
 *
 * **What is genuinely absent**, and therefore has no representation here
 * rather than a plausible-looking placeholder: the plan's own steps, the
 * research findings, and the judge's `verdict`/`issues`. All three are
 * emitted by their phase modules but dropped one layer later —
 * `app.api.run._PHASE_DOMAIN_EVENT_TYPES` discards the `research`/`plan`/
 * `validation` domain events wholesale, so nothing carrying them is ever
 * framed as a part. A UI cannot show what was never sent, and inventing a
 * plausible plan is worse than an honest gap.
 */

/**
 * At or above this a judge score reads as a pass. Not a number picked for
 * this component: it is the same 0.7 the service itself gates on
 * (`app.learning.plan_cache.RECACHE_SCORE_THRESHOLD` /
 * `FIRST_TIME_CACHE_SCORE_THRESHOLD`, `app.learning.optimize.
 * _METRIC_THRESHOLD`), so a run this card calls weak is a run the backend
 * would also decline to learn from.
 */
export const PASS_SCORE = 0.7;

/**
 * One timestamped thing `useChat.ts` saw on the wire. Kept as a raw event
 * log, with the derivation below run over it, for the same reason
 * `phaseTimeline.ts` does it that way: the whole trace can then be
 * rebuilt from scratch on every chunk, so a live trace and a finished
 * one can never be two subtly different code paths.
 */
export type TraceEvent =
  | { kind: "phase"; at: number; data: Record<string, unknown> }
  | { kind: "tool-input"; at: number; callId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool-output"; at: number; callId: string; output: string };

export interface TracePhase {
  phase: string;
  /** `"done"`, or `"cached"` for a plan served from the plan cache. */
  state: string;
  durationMs: number | null;
  /** `validate` only — every other phase omits the key rather than
   * sending a meaningless 0.0 (`phase_intent`'s own contract). */
  score: number | null;
  /** `validate` only: the judge's own prose. */
  reasoning: string | null;
  /** `execute` only: the SQL as actually scoped and run, which is not the
   * same string the model drafted into `run_sql`'s arguments. */
  sql: string | null;
  sqlParams: Record<string, unknown> | null;
  planGate: unknown[] | null;
  /** `plan` only: the steps the planner wrote, and why. Both null when the
   * planner never ran (a direct lookup, or a single-model agent). */
  plan: string[] | null;
  rationale: string | null;
}

export interface TraceTool {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** `null` until the paired `tool-output-available` lands. */
  output: string | null;
}

export type StepIcon = "research" | "plan" | "cached" | "execute" | "validate" | "tool" | "sql";

/** Colour is never the only channel (tokens.css rule 2) — every tone also
 * changes the row's icon and its chip text. */
export type StepTone = "neutral" | "cached" | "good" | "weak";

export interface RunStep {
  key: string;
  icon: StepIcon;
  /** A short sentence about what happened, not a phase name. */
  label: string;
  /** The one fact that changes how this step reads, or `null`. */
  chip: string | null;
  tone: StepTone;
  /** Right-aligned wall clock, or `null` for a step with no duration of
   * its own (a tool call is timed inside its phase, not separately). */
  measure: string | null;
  /** Set only for a step built from a `data-phase` part — what
   * `Thread.tsx` hands the inspector when this row is clicked. */
  phase: string | null;
}

export interface RunTrace {
  steps: RunStep[];
  phases: TracePhase[];
  tools: TraceTool[];
  /** The judge's score, or `null` when validate never ran. */
  score: number | null;
  reasoning: string | null;
  executedSql: string | null;
  executedSqlParams: Record<string, unknown> | null;
}

export const EMPTY_TRACE: RunTrace = {
  steps: [],
  phases: [],
  tools: [],
  score: null,
  reasoning: null,
  executedSql: null,
  executedSqlParams: null,
};

function readString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = data[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readArray(data: Record<string, unknown>, key: string): unknown[] | null {
  const value = data[key];
  return Array.isArray(value) ? value : null;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Dollars, at the precision a single run actually costs. A run that spent
 * real money but rounds to zero at four places says so as `<$0.0001`
 * rather than `$0.0000`, which would read as free.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

/**
 * The distinct model ids a run actually billed, off `usage.calls[].model`
 * — which is really on the wire (`dataclasses.asdict(result.usage)`
 * carries `Usage.calls`), even though `messages.meta.usage`'s documented
 * §4.1 shape doesn't mention it. LiteLLM's `openrouter/` routing prefix
 * is stripped: it names how the call was routed, not which model answered.
 *
 * A run resolves one `dspy.LM` per phase and they are usually the same
 * instance, so this is normally a single id; a two-model agent (Zomato
 * Complaint binds Mini for execute and Large for plan) honestly reports
 * both rather than picking one to call "the model".
 */
export function modelsFromUsage(usage: UsageMetadata | null): string[] {
  const calls = usage?.calls;
  if (!Array.isArray(calls)) return [];
  const seen = new Set<string>();
  for (const call of calls) {
    const model = typeof call?.model === "string" ? call.model.replace(/^openrouter\//, "") : "";
    if (model !== "") seen.add(model);
  }
  return [...seen];
}

const PHASE_LABELS: Record<string, string> = {
  research: "Researched the question",
  plan: "Planned the approach",
  execute: "Ran the plan",
  validate: "Validated the answer",
  guardrail: "Checked the guardrails",
  agent: "Reviewed the run",
};

function phaseStep(phase: TracePhase, index: number): RunStep {
  const cached = phase.state === "cached";
  const label = cached && phase.phase === "plan" ? "Reused the cached plan" : (PHASE_LABELS[phase.phase] ?? `Ran ${phase.phase}`);

  let chip: string | null = cached ? "cached" : null;
  let tone: StepTone = cached ? "cached" : "neutral";
  if (phase.score !== null) {
    chip = `score ${phase.score.toFixed(2)}`;
    tone = phase.score >= PASS_SCORE ? "good" : "weak";
  }

  return {
    key: `phase-${index}-${phase.phase}`,
    icon: cached ? "cached" : isStepIcon(phase.phase) ? phase.phase : "plan",
    label,
    chip,
    tone,
    measure: phase.durationMs === null ? null : formatDuration(phase.durationMs),
    phase: phase.phase,
  };
}

const STEP_ICONS: ReadonlySet<string> = new Set(["research", "plan", "execute", "validate"]);
function isStepIcon(name: string): name is StepIcon {
  return STEP_ICONS.has(name);
}

function toolStep(tool: TraceTool, index: number): RunStep {
  return {
    key: `tool-${index}-${tool.callId}`,
    icon: tool.name === "run_sql" ? "sql" : "tool",
    label: `Called ${tool.name}`,
    chip: null,
    tone: "neutral",
    measure: null,
    phase: null,
  };
}

function toPhase(data: Record<string, unknown>): TracePhase | null {
  const phase = readString(data, "phase");
  if (phase === null) return null;
  return {
    phase,
    state: readString(data, "state") ?? "done",
    durationMs: readNumber(data, "duration_ms"),
    score: readNumber(data, "score"),
    reasoning: readString(data, "reasoning"),
    sql: readString(data, "sql"),
    sqlParams: readRecord(data, "sql_params"),
    planGate: readArray(data, "plan_gate"),
    plan: readArray(data, "plan")?.map(String) ?? null,
    rationale: readString(data, "rationale"),
  };
}

/**
 * The whole trace, rebuilt from the event log. Events are read in arrival
 * order rather than sorted into a canonical phase order, because arrival
 * order *is* the story the card tells: the tool calls a run made land
 * between the phase that opened them and the phase event that closes it,
 * which is exactly how the reasoning reads back ("planned … called
 * find_schema … called run_sql … ran the plan").
 */
export function buildRunTrace(events: readonly TraceEvent[]): RunTrace {
  const steps: RunStep[] = [];
  const phases: TracePhase[] = [];
  const tools: TraceTool[] = [];
  const openCalls = new Map<string, TraceTool>();

  for (const event of events) {
    if (event.kind === "phase") {
      const phase = toPhase(event.data);
      // A phase part with no `phase` name is not something to guess at —
      // dropped, the same forward-compatible discard `protocol.parseChunk`
      // makes for a chunk type this bundle predates.
      if (phase === null) continue;
      phases.push(phase);
      steps.push(phaseStep(phase, phases.length - 1));
      continue;
    }

    if (event.kind === "tool-input") {
      const tool: TraceTool = { callId: event.callId, name: event.name, input: event.input, output: null };
      tools.push(tool);
      openCalls.set(event.callId, tool);
      steps.push(toolStep(tool, tools.length - 1));
      continue;
    }

    const open = openCalls.get(event.callId);
    if (open !== undefined) open.output = event.output;
  }

  const validate = phases.findLast((phase) => phase.score !== null || phase.reasoning !== null);
  const execute = phases.findLast((phase) => phase.sql !== null);

  return {
    steps,
    phases,
    tools,
    score: validate?.score ?? null,
    reasoning: validate?.reasoning ?? null,
    executedSql: execute?.sql ?? null,
    executedSqlParams: execute?.sqlParams ?? null,
  };
}
