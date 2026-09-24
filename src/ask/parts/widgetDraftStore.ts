import { useSyncExternalStore } from "react";
import type { AskWidgetDraft, WidgetDraftAck } from "../config.tsx";

/**
 * What happened to each drafted widget, by `draftId` — kept OUTSIDE React.
 *
 * Two reasons it cannot be component state:
 *
 * 1. **The card remounts mid-flight.** A live part renders inside the run's
 *    `LiveTurn`; the instant the run finishes, the same part re-renders inside
 *    the finished message's `AnsweredTurn` — a different subtree, so a fresh
 *    component. The host's promise may still be pending across that hand-off,
 *    and the answer has to land on the card that is on screen when it arrives.
 * 2. **Exactly once.** `onWidgetDraft` inserts into the builder's canvas
 *    without a click. StrictMode runs effects twice, the hand-off above mounts
 *    the card twice, and a re-render re-runs the effect — any one of those
 *    doubling the call puts two copies of the widget on the canvas. The claim
 *    set below is what makes it once per `draftId` for the life of the page.
 *
 * Module-level rather than per `AskProvider` because a draft id is a UUID: two
 * Ask instances on one page sharing it can only ever agree, and an insert
 * claimed by one must not be repeated by the other. A page reload clears it,
 * which is correct — a reloaded thread's parts are history, and never
 * auto-insert anyway (see `WidgetDraft`).
 */
export type WidgetDraftState =
  | { status: "pending" }
  | { status: "added" | "replaced"; widgetId?: string }
  | { status: "rejected"; reason?: string };

const states = new Map<string, WidgetDraftState>();
const claimed = new Set<string>();
const listeners = new Set<() => void>();

function publish(draftId: string, state: WidgetDraftState): void {
  states.set(draftId, state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True the first time it is asked about a `draftId`, false ever after. The
 * automatic insert calls this and only proceeds on true.
 */
export function claimAutoInsert(draftId: string): boolean {
  if (claimed.has(draftId)) return false;
  claimed.add(draftId);
  return true;
}

function toState(ack: unknown): WidgetDraftState {
  if (ack === null || typeof ack !== "object") return { status: "rejected", reason: "no_answer" };
  const { status, widgetId, reason } = ack as Partial<WidgetDraftAck>;
  if (status === "added" || status === "replaced") {
    return typeof widgetId === "string" && widgetId !== ""
      ? { status, widgetId }
      : { status };
  }
  if (status === "rejected") {
    return typeof reason === "string" && reason !== "" ? { status, reason } : { status };
  }
  return { status: "rejected", reason: "no_answer" };
}

/**
 * Hands a draft to the host and records its answer. A host that throws, rejects
 * or answers with something unreadable lands as `rejected` — the card then
 * offers a retry rather than spinning forever on "Adding…".
 */
export function submitWidgetDraft(
  draft: AskWidgetDraft,
  onWidgetDraft: (draft: AskWidgetDraft) => Promise<WidgetDraftAck>,
): Promise<void> {
  const { draftId } = draft;
  publish(draftId, { status: "pending" });
  let answer: Promise<unknown>;
  try {
    answer = Promise.resolve(onWidgetDraft(draft));
  } catch {
    answer = Promise.reject(new Error("onWidgetDraft threw"));
  }
  return answer.then(
    (ack) => publish(draftId, toState(ack)),
    () => publish(draftId, { status: "rejected", reason: "error" }),
  );
}

/** The recorded state for a draft, or null when nothing has been tried. */
export function useWidgetDraftState(draftId: string): WidgetDraftState | null {
  return useSyncExternalStore(
    subscribe,
    () => states.get(draftId) ?? null,
    () => null,
  );
}

/** Forgets everything. Tests only — a page never needs to. */
export function resetWidgetDraftsForTests(): void {
  states.clear();
  claimed.clear();
  for (const listener of listeners) listener();
}
