import { gatewayClient } from "../api/client.ts";

/**
 * `POST /agent/feedback` (`agent-service/app/api/feedback.py`) — a real,
 * mounted, permission-gated endpoint, not a decorative thumbs pair. It
 * takes the assistant `Message` row's own id and a rating, and feeds
 * `app.learning.policy.apply_feedback`: an up-vote can promote the turn to
 * an exemplar, a down-vote can invalidate a cached plan. Verified live
 * against the running service (201, `agent.feedback.create` present on the
 * signed-in principal) before this module was written, because a rating
 * button that silently 404s is worse than no rating button.
 *
 * **`comment` is what decides whether a thumbs-down reaches prompt
 * tuning.** `app.learning.policy.apply_feedback` turns a bare 👎 into a
 * plan-cache invalidation and stops; only a 👎 carrying a comment writes a
 * `CorrectionMeta` row, and only those rows are read by `POST /agent/admin/
 * tune` (as "mistakes to avoid"). The thumbs in the answer strip do not ask
 * for one — a modal between a click and a rating is how a rating stops
 * being left at all — so the reason is recorded afterwards, from the
 * agent's Prompts tab, through this same function. Optional, and omitted
 * entirely from the body when absent so the wire shape for a plain rating
 * is byte-identical to what it was.
 *
 * `message_id` is an int server-side. `ChatMessage.id` is a string that is
 * only *sometimes* a real row id: a run that fails before the `start`
 * chunk arrives keeps `useChat.ts`'s local `run-N` placeholder instead.
 * `messageRowId` is the guard — callers hide the control entirely rather
 * than sending a rating the server would reject.
 */
export type FeedbackRating = "up" | "down";

export interface FeedbackResult {
  feedback_id: number;
  exemplars_promoted: number;
  invalidated: number;
  corrections_added: number;
  assessment_logged: boolean;
}

/** The numeric row id behind a `ChatMessage.id`, or `null` when that id is
 * one of `useChat.ts`'s local placeholders. */
export function messageRowId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function submitFeedback(
  messageId: number,
  rating: FeedbackRating,
  comment?: string,
): Promise<FeedbackResult> {
  return gatewayClient.agentFetch<FeedbackResult>("/agent/feedback", {
    method: "POST",
    // `JSON.stringify` drops an `undefined` value entirely, so a plain
    // rating serialises to exactly the two-key body it always did — no
    // `comment: null` reaching `FeedbackIn`, which would otherwise read as
    // "a comment was considered and there wasn't one".
    body: JSON.stringify({ message_id: messageId, rating, comment }),
  });
}


/**
 * Hands an answer to the run waiting on it.
 *
 * A 404 is the expected failure, not an exceptional one: the run gives up
 * after sixty seconds, and someone who answers slowly should be told the
 * run moved on rather than watching a form that never resolves.
 */
export async function answerQuestion(questionId: string, answer: string): Promise<void> {
  await gatewayClient.agentFetch(`/agent/questions/${questionId}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

/**
 * Forgets the cached plan for a question, so the next ask of it runs the
 * full pipeline fresh.
 *
 * A cached plan is reused on question similarity and never re-checked for
 * whether its answer still helps — so a weak answer can be served again
 * and again. This is the reader's escape hatch: when the answer did not
 * help, retire the plan behind it. `forgotten: false` is not an error, only
 * "there was nothing cached for this".
 */
export async function forgetCachedPlan(
  agent: string | null,
  message: string,
): Promise<{ forgotten: boolean }> {
  return gatewayClient.agentFetch<{ forgotten: boolean }>("/agent/plan-cache/forget", {
    method: "POST",
    body: JSON.stringify({ agent: agent ?? undefined, message }),
  });
}
