/**
 * Answers this page has sent to a run's clarifying questions, by question id.
 *
 * **Why a module-level store.** A question is answered in the LIVE turn,
 * where `Thread.tsx` hands `DataQuestion` an `onAnswer`. The moment the run
 * finishes, that turn is replaced by the saved message, and the saved
 * message's question part is a different component instance, rendered
 * without `onAnswer` and with none of the live one's state. Held in
 * component state, the answer died at that hand-off, and a question the
 * reader had just answered said it had been "answered on its own".
 *
 * The part itself is the right long-term home: the backend is starting to
 * persist `answer` and `timed_out` on the saved question part, and
 * `DataQuestion` reads those first. This covers what the part cannot yet
 * say: runs saved before that field existed, and the window between
 * answering and the run finishing, when the part on screen is still the
 * one the stream sent before anyone answered.
 *
 * Keyed by question id, which the server mints per question, so two
 * embeds on one page cannot collide. It lives as long as the page does.
 * That covers the live-to-saved hand-off and reopening a conversation in
 * the same session; after a reload the persisted part is what answers.
 */

const answers = new Map<string, string>();
const listeners = new Set<() => void>();

/** Records the answer a question was sent, once the run has accepted it. */
export function recordAnswer(questionId: string, answer: string): void {
  // An empty id is `adaptQuestion`'s fallback for a malformed part. Every
  // malformed part shares it, so recording under it would hand one
  // question's answer to all of them.
  if (questionId === "" || answers.get(questionId) === answer) return;
  answers.set(questionId, answer);
  for (const listener of listeners) listener();
}

/** The answer this page sent to `questionId`, if it sent one. */
export function recordedAnswer(questionId: string): string | undefined {
  return questionId === "" ? undefined : answers.get(questionId);
}

/** For `useSyncExternalStore`: calls `listener` whenever an answer is recorded. */
export function subscribeToAnswers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: a module-level store otherwise leaks from one test into the next. */
export function clearRecordedAnswers(): void {
  answers.clear();
}
