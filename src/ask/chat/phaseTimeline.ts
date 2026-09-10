/**
 * Turns one run's timestamped events into the run rail's segments — the
 * signature element (design plan, "Signature — the run rail"; task brief:
 * "time-proportional, not a stepper"). Pure and clock-free: every timestamp
 * is a caller-supplied `number` (ms on whatever monotonic scale the caller
 * picked — `useChat.ts` uses `Date.now()`), so this module is exhaustively
 * unit-testable without fake timers.
 *
 * **Six known phases, and why only four are ever seen on today's wire.**
 * `agent-service/app/agent/pipeline.py` walks exactly four pipeline phases
 * (`research`, `plan`, `execute`, `validate`); `guardrail` is a stored
 * instruction block with no pipeline step of its own, and `agent` names a
 * later, whole-run judge phase — see that module's own docstring for the
 * three-different-"phases"-sets history this project already tripped over
 * once. `app.stream.intents.phase_intent(phase: str, state: str)` takes a
 * plain string on purpose, not the closed `PipelinePhase` literal, so a
 * future emitter can send `"guardrail"`/`"agent"`/`"execute"` through the
 * exact same `data-phase` mechanism without a protocol change — this module
 * treats all six as first-class for that reason, even though the real
 * `_adapt_event` mapping in `app/api/run.py` today only ever sends
 * `research`/`plan`/`validate` (`_PHASE_EVENT_NAMES`). A run that never
 * reaches the rest is normal, not an error (task brief, verbatim: "a
 * refusal or an early return is normal, and the rail must show a run that
 * stopped at plan without implying failure").
 *
 * **Why "execute" is inferred rather than read off an event.** No
 * `data-phase` event named `"execute"` exists in the current backend — the
 * ReAct tool loop that *is* execute only shows up as `tool-input-available`/
 * `tool-output-available` chunks (see `protocol.ts`). This module treats
 * "plan just closed, and no validate/guardrail/agent/finish has arrived
 * yet" as the honest boundary for execute's start, using real signal
 * (elapsed wall-clock time between two real events) rather than fabricating
 * a duration. If a future backend ever does emit `data-phase{phase:
 * "execute"}` directly, that event wins outright (`inferred: false`) and
 * this module never double-counts — the explicit branch runs first and
 * marks execute closed.
 */

export const PHASE_ORDER = ["research", "plan", "execute", "validate", "guardrail", "agent"] as const;
export type PhaseName = (typeof PHASE_ORDER)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PHASE_ORDER);

export function isPhaseName(value: string): value is PhaseName {
  return PHASE_SET.has(value);
}

/**
 * One timestamped fact `useChat.ts` observed while reading the stream.
 * `"phase"` carries a raw string, not `PhaseName` — an event naming a
 * phase this module doesn't recognise is simply ignored (see
 * `buildPhaseTimeline`), the same forward-compatible discard `protocol.
 * parseChunk` applies to an unknown chunk type.
 */
export interface PhaseTimelineEvent {
  at: number;
  kind: "run-start" | "phase" | "tool" | "run-end";
  phase?: string;
  state?: string;
  /** Forward-compat: honoured verbatim if a future `data-phase` payload
   * carries it (task brief: "the phase shows its score instead of a
   * duration"); absent on every real event today. */
  score?: number;
  tokens?: number;
  /** Forward-compat override for the derived `endedAt - startedAt`. */
  durationMs?: number;
  /**
   * What the phase actually produced. These are no longer forward-compat
   * placeholders: `pipeline._phase_event` sends every one of them today,
   * and the Inspector rendered "aren't wired up yet" over live data
   * because this type predated them.
   */
  detail?: PhaseDetail;
}

/** The per-phase content a run genuinely carries, by the phase that owns
 *  it. Every field is optional because a phase only sends what it has —
 *  a knowledge agent's execute never runs SQL, and a fast-path validate
 *  never reaches the judge. */
export interface PhaseDetail {
  findings?: string;
  plan?: string[];
  rationale?: string;
  sql?: string;
  sqlParams?: Record<string, unknown>;
  reasoning?: string;
  verdict?: string;
  issues?: string;
}

export interface PhaseSegment {
  phase: PhaseName;
  state?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  score?: number;
  tokens?: number;
  detail?: PhaseDetail;
  /** True only for the synthesised execute segment — see module docstring. */
  inferred: boolean;
}

/**
 * Reads a `data-phase` payload's own content. Kept here beside the types
 * it fills so the shape and its parser cannot drift apart, which is how
 * the Inspector came to claim this data did not exist while it was on the
 * wire.
 */
export function readPhaseDetail(data: Record<string, unknown>): PhaseDetail | undefined {
  const detail: PhaseDetail = {};
  if (typeof data.findings === "string" && data.findings) detail.findings = data.findings;
  if (Array.isArray(data.plan) && data.plan.length > 0) detail.plan = data.plan.map(String);
  if (typeof data.rationale === "string" && data.rationale) detail.rationale = data.rationale;
  if (typeof data.sql === "string" && data.sql) detail.sql = data.sql;
  if (data.sql_params !== null && typeof data.sql_params === "object") {
    detail.sqlParams = data.sql_params as Record<string, unknown>;
  }
  if (typeof data.reasoning === "string" && data.reasoning) detail.reasoning = data.reasoning;
  if (typeof data.verdict === "string" && data.verdict) detail.verdict = data.verdict;
  if (typeof data.issues === "string" && data.issues) detail.issues = data.issues;
  // Undefined rather than an empty object: the Inspector renders a
  // "nothing to show" state, and {} would render an empty panel instead.
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export interface PhaseSegmentWithWidth extends PhaseSegment {
  /** 0–100, this segment's share of the run's total accounted-for time. */
  widthPercent: number;
}

export function buildPhaseTimeline(events: readonly PhaseTimelineEvent[]): PhaseSegment[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const runStart = sorted.find((event) => event.kind === "run-start")?.at ?? sorted[0]?.at ?? 0;

  const segments: PhaseSegment[] = [];
  let cursor = runStart;
  let toolSeen = false;
  let executeClosed = false;

  const closeExecute = (endAt: number) => {
    if (executeClosed || !toolSeen || endAt <= cursor) return;
    segments.push({
      phase: "execute",
      startedAt: cursor,
      endedAt: endAt,
      durationMs: endAt - cursor,
      inferred: true,
    });
    cursor = endAt;
    executeClosed = true;
  };

  for (const event of sorted) {
    if (event.kind === "run-start") continue;

    if (event.kind === "tool") {
      toolSeen = true;
      continue;
    }

    if (event.kind === "run-end") {
      closeExecute(event.at);
      continue;
    }

    // event.kind === "phase"
    const name = event.phase ?? "";
    if (!isPhaseName(name)) continue; // an intent this bundle predates — drop, don't guess

    if (name === "execute") {
      // An explicit event always wins over inference, and marks execute
      // closed so closeExecute() below never double-adds a second segment
      // for the same work.
      segments.push({
        phase: "execute",
        state: event.state,
        startedAt: cursor,
        endedAt: event.at,
        durationMs: event.durationMs ?? Math.max(0, event.at - cursor),
        score: event.score,
        tokens: event.tokens,
        detail: event.detail,
        inferred: false,
      });
      cursor = event.at;
      executeClosed = true;
      continue;
    }

    if (name === "validate" || name === "guardrail" || name === "agent") {
      closeExecute(event.at);
    }

    segments.push({
      phase: name,
      state: event.state,
      startedAt: cursor,
      endedAt: event.at,
      durationMs: event.durationMs ?? Math.max(0, event.at - cursor),
      score: event.score,
      tokens: event.tokens,
      detail: event.detail,
      inferred: false,
    });
    cursor = event.at;
  }

  return segments;
}

/**
 * Attaches each segment's proportional share of the run's own accounted-for
 * time — never a fixed/equal split, which is exactly the bug the task
 * brief warns a lazy implementation could get away with ("a rail that
 * renders six equal bars would otherwise pass"). Zero total (a
 * pathological single-instant run) falls back to 0 for every bar rather
 * than dividing by zero.
 */
export function withWidths(segments: readonly PhaseSegment[]): PhaseSegmentWithWidth[] {
  const total = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  return segments.map((segment) => ({
    ...segment,
    widthPercent: total > 0 ? (segment.durationMs / total) * 100 : 0,
  }));
}
