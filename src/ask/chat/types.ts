import type { UIPart } from "../parts/catalog.tsx";
import type { PhaseSegment } from "./phaseTimeline.ts";
import type { UsageMetadata } from "./protocol.ts";
import type { RunTrace } from "./runTrace.ts";

/**
 * One turn in the thread, in the shape both a live run and a reopened
 * conversation converge on — `useChat.ts`'s single source of truth for
 * what `Thread.tsx` renders. `parts` is always the *persisted* set: for a
 * message this session just streamed, it's `StreamWriter.persisted_parts`'
 * client-side mirror (never-transient data parts only); for a reopened
 * one, it's `messages.meta.ui_parts` read back verbatim
 * (`conversation.hydrateMessages`). Either way, a transient `data-phase`
 * part can never end up here — see `useChat.ts` for where that split is
 * actually enforced.
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: UIPart[];
  createdAt: number;
  /**
   * Set once, only for an assistant message this hook instance actually
   * streamed to completion (or failure) — never present on a message
   * hydrated from `GET /agent/conversations/{id}`, because the events it's
   * built from never survive persistence (design plan: "the design does
   * not keep what the protocol throws away"). `Thread.tsx` uses this
   * field's mere presence, not its content, to decide whether a message
   * may ever show its reasoning card at all.
   */
  runSummary?: RunSummary;
  /**
   * The run's usage roll-up — the one part of a run's metadata that
   * genuinely *does* survive a reload, because `app.api.run` persists it
   * to `messages.meta.usage` alongside `ui_parts`. Lives on the message
   * rather than inside `runSummary` for exactly that reason: a reopened
   * conversation has no trace and no segments, but it does still know
   * what the run cost and which model answered. The persisted duration is
   * provider-reported model time, not reliable end-to-end elapsed time.
   */
  usage?: UsageMetadata | null;
  /**
   * `messages.agent_id` for a reopened turn — the only record of who
   * answered that survives a reload, since `agentName` lives on
   * `runSummary` and `runSummary` does not. `Thread.tsx` resolves it
   * against the `GET /agent/agents` list the Ask screen already loads; an
   * id with no matching agent (one since deleted) resolves to nothing
   * rather than to a guess.
   */
  agentId?: number | null;
  /**
   * How a REOPENED run ended when it did not end in an answer —
   * `messages.meta.run_status`. agent-service saves the assistant row
   * before the run starts and, for a run that failed or was cancelled,
   * now records which on it; before that it recorded nothing, and the row
   * reopened as an empty answer. Absent on a row that finished, and on
   * every row older than the field. A run this session watched carries
   * the same fact on `runSummary.status` instead.
   */
  runStatus?: PersistedRunStatus;
  /** `messages.meta.error_text`, the failure a reopened errored run
   * recorded, or `null` when it recorded none. */
  errorText?: string | null;
}

export type PersistedRunStatus = "error" | "cancelled";

export interface RunSummary {
  status: "done" | "error";
  totalMs: number;
  errorText: string | null;
  /** Kept for the inspector — clicking a reasoning step must still work
   * for the run currently collapsing, not only while it's live. */
  segments: PhaseSegment[];
  /**
   * What the run actually reported about itself: its phases, its tool
   * calls, the SQL it ran and the judge's own verdict prose. Built by
   * `runTrace.buildRunTrace` from transient `data-phase` and tool parts,
   * so — like `segments` — it exists only for a run this session watched.
   */
  trace: RunTrace;
  /**
   * The agent this run actually went to (`RunIn.agent` on the wire — a
   * *name*, matching `chat/runStream.ts`'s own note that `POST /agent/run`
   * resolves an agent by name, not id), or `null` when the caller sent no
   * name and the server picked its own default.
   *
   * Nullable rather than falling back to a hardcoded default name: this
   * field previously read `options.agent ?? "Analytics"`, mirroring
   * `app.api.run._DEFAULT_AGENT_NAME`. No agent called "Analytics" exists
   * in this deployment — the seeded agents are Sales-Analyst,
   * Customer-Support, Staff-Assistant and Zomato-Complaints — so that
   * fallback would have printed a confident, checkable attribution to an
   * agent that could not have answered. An unnamed run says nothing.
   */
  agentName: string | null;
}

/**
 * Live view of the run currently streaming, or `null` between runs.
 * `text`/`parts` grow progressively as chunks arrive — the same content
 * that becomes a `ChatMessage`'s `content`/`parts` the moment the run
 * finishes, at which point `activeRun` is cleared and that `ChatMessage`
 * (carrying a `runSummary`) is what `Thread.tsx` renders from then on.
 */
export interface ActiveRun {
  messageId: string;
  status: "streaming";
  /** When this run started, for the wait indicator's elapsed clock. The
   * client's own clock, not the server's: it is measuring how long the
   * person has been waiting, which starts when they pressed Ask. */
  startedAt: number;
  segments: PhaseSegment[];
  /** Grows chunk by chunk, so the reasoning card fills in as the run goes
   * rather than appearing all at once at the end. */
  trace: RunTrace;
  text: string;
  /**
   * The model's own reasoning, while it is still writing it.
   *
   * Separate from `text` and deliberately not persisted anywhere: a
   * thought is progress, never answer. It exists because a run put NOTHING
   * on screen for the first eighty seconds and then delivered its answer
   * in under two — measured — so the reveal looked broken when it was
   * working perfectly. There was simply nothing to reveal until the end.
   */
  thought: string;
  parts: UIPart[];
  /** Same resolution rule as `RunSummary.agentName` — set once, when the
   * run starts, from the same `options.agent` the request was sent with,
   * and `null` when the caller named none. */
  agentName: string | null;
}
