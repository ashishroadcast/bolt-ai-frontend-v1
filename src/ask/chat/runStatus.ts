import { formatMinutes, type RunTrace } from "./runTrace.ts";

/**
 * What the agent is doing right now, in words, for the wait indicator.
 *
 * The reasoning card's own labels are past tense — "Researched the
 * question", "Ran the plan" — because they describe steps that have
 * finished. A run in flight needs the opposite: the thing that has NOT
 * finished, which is exactly the information the stream does not send.
 * A `data-phase` part arrives when a phase ENDS, so the phase currently
 * running is always the one after the last part received.
 */

/** The order `app.agent.pipeline.PHASES` walks, which is what makes "the
 * next one" meaningful at all. */
const ORDER = ["research", "plan", "execute", "validate"] as const;

const RUNNING_LABELS: Record<string, string> = {
  research: "Reading the schema",
  plan: "Planning the approach",
  execute: "Running the query",
  validate: "Checking the answer",
};

/**
 * A tool's own name is the most specific thing that can be said while it
 * runs, and it is more useful than the phase containing it — "Running the
 * query" for forty seconds says less than "run_sql" then "show_comparison".
 */
const TOOL_LABELS: Record<string, string> = {
  run_sql: "Querying the warehouse",
  find_schema: "Looking up the schema",
  show_chart: "Drawing the chart",
  show_stats: "Working out the figures",
  show_comparison: "Laying out the comparison",
  run_python: "Running code",
  run_code: "Running code",
};

export function currentStepLabel(trace: RunTrace): string {
  // A tool with no output yet is the most specific answer available, and
  // it beats the phase around it: the phase is what the run is doing in
  // general, the tool is what it is waiting on right now.
  const inFlight = trace.tools.find((tool) => tool.output === null);
  if (inFlight !== undefined) {
    return TOOL_LABELS[inFlight.name] ?? `Running ${inFlight.name}`;
  }

  const done = new Set(trace.phases.map((phase) => phase.phase));
  const next = ORDER.find((phase) => !done.has(phase));
  // Every phase has reported and no tool is out: the answer is being
  // written, which is the one stretch with no event of its own.
  return next === undefined ? "Writing the answer" : RUNNING_LABELS[next];
}

/**
 * Whole seconds since `startedAt`, as `"12s"` under a minute and `"1m 04s"`
 * beyond it — the same `formatMinutes` the finished answer's duration
 * uses, so the figure does not change shape the moment the run ends.
 *
 * Seconds only — no tenths. A counter flickering ten times a second reads
 * as agitation, and nobody waiting on a forty-second run needs to know
 * which tenth they are in.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return formatMinutes(total);
}
