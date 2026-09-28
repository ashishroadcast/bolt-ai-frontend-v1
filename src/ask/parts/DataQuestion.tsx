import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from "react";
import { recordAnswer, recordedAnswer, subscribeToAnswers } from "../chat/questionAnswers.ts";
import { useAskStrings } from "../i18n/AskLocale.tsx";
import styles from "./DataQuestion.module.css";

/**
 * How long the run actually waits (`ANSWER_TIMEOUT_SECONDS` in
 * `app/agent/answers.py`). The form closes itself when the window passes,
 * because a control that still looks live after the run stopped listening
 * is worse than no control: it invites an answer that can only 404.
 */
const ANSWER_WINDOW_MS = 300_000;

export interface DataQuestionProps {
  questionId: string;
  question: string;
  /** Concrete choices. Empty means free text only. */
  options: string[];
  allowMultiple: boolean;
  allowOther: boolean;
  /** Sends the answer. Absent once the question has been answered, or when
      re-rendering a past conversation where the run is long gone. */
  onAnswer?: (questionId: string, answer: string) => Promise<void>;
  /** What the reader answered, as the backend persists it on the saved
      part. Snake case because `adaptQuestion` passes the stored part
      through verbatim. `null` or absent when nobody answered, and on every
      part saved before the backend started writing it. */
  answer?: string | null;
  /** True only when the run stopped waiting and went on without an answer. */
  timed_out?: boolean;
}

/**
 * Where a question stands, which decides everything it renders.
 *
 * - `open`: the run is waiting, and this screen can still answer it.
 * - `answered`: someone answered, and here is what they said.
 * - `timedOut`: the run gave up waiting and picked its own reading.
 * - `asked`: a reopened question with no record either way.
 */
type Outcome =
  | { kind: "open" }
  | { kind: "answered"; answer: string }
  | { kind: "timedOut" }
  | { kind: "asked" };

/**
 * Settles a question from the most authoritative record down.
 *
 * The saved part comes first. Once the backend persists `answer` and
 * `timed_out` it is the record, and the only one that survives a reload.
 * This page's own record (`questionAnswers.ts`) comes next: it is what
 * survives the live turn being replaced by the saved message, which
 * remounts this component without `onAnswer` or any of its state. This
 * instance's state comes last, and is all a malformed part with no id has.
 *
 * "Timed out" needs evidence: the saved part says so, or this screen
 * watched the window close. A reopened question with neither is `asked`,
 * not `timedOut`. Assuming a time-out there told readers who HAD answered
 * that the run had answered for them.
 */
function settle({
  partAnswer,
  partTimedOut,
  recorded,
  sent,
  live,
  expired,
}: {
  partAnswer: string | null | undefined;
  partTimedOut: boolean;
  recorded: string | undefined;
  sent: string | null;
  live: boolean;
  expired: boolean;
}): Outcome {
  if (typeof partAnswer === "string" && partAnswer.trim() !== "") {
    return { kind: "answered", answer: partAnswer };
  }
  if (partTimedOut) return { kind: "timedOut" };
  const known = recorded ?? sent;
  if (known !== undefined && known !== null) return { kind: "answered", answer: known };
  if (live && !expired) return { kind: "open" };
  return expired ? { kind: "timedOut" } : { kind: "asked" };
}

/**
 * A question the agent is waiting on.
 *
 * **This is a live control with a deadline.** The run is blocked inside its
 * `ask_user` tool for sixty seconds while this is on screen, so the design
 * is about answering fast: the options are the primary path, they submit
 * on one click when only one may be chosen, and "Something else" is there
 * because a fixed list nobody can escape turns a clarification into an
 * obstacle.
 *
 * It persists in the conversation rather than vanishing when answered — a
 * thread that shows an answer without the question it answered reads as a
 * non-sequitur when it is reopened later. What it says once closed comes
 * from `settle`, above.
 */
export function DataQuestion({
  questionId,
  question,
  options,
  allowMultiple,
  allowOther,
  onAnswer,
  // Renamed on the way in: `send` below takes an `answer` of its own.
  answer: savedAnswer,
  timed_out: savedTimedOut,
}: DataQuestionProps): ReactElement {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const recorded = useSyncExternalStore(subscribeToAnswers, () => recordedAnswer(questionId));
  const strings = useAskStrings();

  // Counts from the moment the question reaches the screen, which is as
  // close to the run's own deadline as this side can get.
  useEffect(() => {
    if (onAnswer === undefined) return;
    const timer = setTimeout(() => setExpired(true), ANSWER_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [onAnswer]);

  const outcome = settle({
    partAnswer: savedAnswer,
    partTimedOut: savedTimedOut === true,
    recorded,
    sent,
    live: onAnswer !== undefined,
    expired,
  });
  const answered = outcome.kind !== "open";

  async function send(answer: string) {
    if (answer.trim() === "" || onAnswer === undefined) return;
    setSending(true);
    setFailed(null);
    try {
      await onAnswer(questionId, answer);
      recordAnswer(questionId, answer);
      setSent(answer);
    } catch (err: unknown) {
      // The commonest failure is a 404 because the run gave up waiting, so
      // the message says that rather than "something went wrong".
      setFailed(
        err instanceof Error && err.message !== ""
          ? err.message
          : "That answer didn't reach the run — it may have moved on.",
      );
    } finally {
      setSending(false);
    }
  }

  function toggle(option: string) {
    if (allowMultiple) {
      setPicked((current) =>
        current.includes(option) ? current.filter((o) => o !== option) : [...current, option],
      );
      return;
    }
    // One choice and nothing else to fill in: the click IS the answer, and
    // making someone click again to confirm wastes part of a minute they
    // do not have.
    setPicked([option]);
    if (!allowOther) void send(option);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parts = [...picked, other.trim()].filter((part) => part !== "");
    void send(parts.join(", "));
  }

  // The answer keeps the live form's ground whether it was given a second
  // ago or last week: the same question should not change its look the
  // moment the run finishes and the saved message replaces the live turn.
  if (outcome.kind === "answered") {
    return (
      <section className={styles.question} aria-label={strings.questionAnsweredLabel}>
        <p className={styles.prompt}>{question}</p>
        <p className={styles.sent}>
          <span className={styles.sentLabel}>{strings.questionYouAnswered}</span> {outcome.answer}
        </p>
      </section>
    );
  }

  // Nothing to answer with: the options and the text field would be a form
  // that can only fail. What is left is the record of what was asked, and
  // only as much about its fate as is actually known.
  if (answered) {
    const timedOut = outcome.kind === "timedOut";
    return (
      <section
        className={styles.closed}
        aria-label={timedOut ? strings.questionTimedOutLabel : strings.questionEarlierLabel}
      >
        <p className={styles.closedPrompt}>{question}</p>
        <p className={styles.closedNote}>
          {timedOut ? strings.questionTimedOut : strings.questionAskedDuringRun}
        </p>
      </section>
    );
  }

  return (
    <section className={styles.question}>
      <form onSubmit={onSubmit}>
        <fieldset className={styles.fieldset} disabled={sending || answered}>
          <legend className={styles.prompt}>{question}</legend>

          {options.length > 0 && (
            <div className={styles.options}>
              {options.map((option) => (
                <label key={option} className={styles.option}>
                  <input
                    type={allowMultiple ? "checkbox" : "radio"}
                    name={`q-${questionId}`}
                    checked={picked.includes(option)}
                    onChange={() => toggle(option)}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          )}

          {allowOther && (
            <label className={styles.other}>
              <span className={styles.otherLabel}>
                {options.length > 0 ? strings.questionSomethingElse : strings.questionYourAnswer}
              </span>
              <input
                type="text"
                className={styles.otherInput}
                value={other}
                onChange={(event) => setOther(event.target.value)}
                placeholder={
                  options.length > 0 ? strings.questionOrTypeAnswer : strings.questionTypeAnswer
                }
              />
            </label>
          )}

          {(allowOther || allowMultiple) && (
            <button type="submit" className={styles.submit}>
              {sending ? strings.questionSending : strings.questionSubmit}
            </button>
          )}
        </fieldset>
      </form>

      {failed !== null && <p className={styles.failed}>{failed}</p>}
    </section>
  );
}
