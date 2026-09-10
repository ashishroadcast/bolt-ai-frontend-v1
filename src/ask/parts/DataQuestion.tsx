import { useEffect, useState, type FormEvent, type ReactElement } from "react";
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
 * non-sequitur when it is reopened later.
 */
export function DataQuestion({
  questionId,
  question,
  options,
  allowMultiple,
  allowOther,
  onAnswer,
}: DataQuestionProps): ReactElement {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // Counts from the moment the question reaches the screen, which is as
  // close to the run's own deadline as this side can get.
  useEffect(() => {
    if (onAnswer === undefined) return;
    const timer = setTimeout(() => setExpired(true), ANSWER_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [onAnswer]);

  const answered = sent !== null || onAnswer === undefined || expired;

  async function send(answer: string) {
    if (answer.trim() === "" || onAnswer === undefined) return;
    setSending(true);
    setFailed(null);
    try {
      await onAnswer(questionId, answer);
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

  if (sent !== null) {
    return (
      <section className={styles.question} aria-label="Answered">
        <p className={styles.prompt}>{question}</p>
        <p className={styles.sent}>{sent}</p>
      </section>
    );
  }

  // Nothing to answer with: the options and the text field would be a form
  // that can only fail. What is left is the record of what was asked.
  if (answered) {
    return (
      <section className={styles.closed} aria-label="Unanswered question">
        <p className={styles.closedPrompt}>{question}</p>
        <p className={styles.expired}>Answered on its own — the run went with its best reading.</p>
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
                {options.length > 0 ? "Something else" : "Your answer"}
              </span>
              <input
                type="text"
                className={styles.otherInput}
                value={other}
                onChange={(event) => setOther(event.target.value)}
                placeholder={options.length > 0 ? "Or type an answer" : "Type an answer"}
              />
            </label>
          )}

          {(allowOther || allowMultiple) && (
            <button type="submit" className={styles.submit}>
              {sending ? "Sending…" : "Answer"}
            </button>
          )}
        </fieldset>
      </form>

      {failed !== null && <p className={styles.failed}>{failed}</p>}
    </section>
  );
}
