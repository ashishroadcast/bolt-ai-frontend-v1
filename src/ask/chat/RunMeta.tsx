import { Check, Copy, RotateCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { CopyButton } from "./CopyButton.tsx";
import { messageRowId, submitFeedback, type FeedbackRating } from "./feedbackApi.ts";
import type { UsageMetadata } from "./protocol.ts";
import { formatCost, formatCount, formatDuration, modelsFromUsage, PASS_SCORE } from "./runTrace.ts";
import styles from "./RunMeta.module.css";
import { useAskClient } from "../config.tsx";

// How long Rerun reads "Rerunning…" before reverting to its own name — a
// run itself can take much longer, but the button's job is only to confirm
// the click landed, not to track the whole run's lifetime (the reasoning
// card's live pill already does that).
const RERUN_FEEDBACK_MS = 1500;

interface RerunButtonProps {
  onRerun: () => void;
  disabled: boolean;
}

/**
 * Re-asks the exact question this turn started from — never edits the
 * message already in `messages` ("it asks again, it does not edit
 * history"). `Thread`'s own `rerun` closure is what actually calls
 * `sendMessage`; this component only owns its own transient "I was just
 * clicked" label, the same local-feedback pattern `CopyButton.tsx` uses.
 */
export function RerunButton({ onRerun, disabled }: RerunButtonProps): ReactElement {
  const [justClicked, setJustClicked] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  function handleClick() {
    onRerun();
    setJustClicked(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setJustClicked(false), RERUN_FEEDBACK_MS);
  }

  return (
    <button
      type="button"
      className={styles.action}
      onClick={handleClick}
      disabled={disabled}
      aria-label="Rerun this question"
    >
      <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
      <span>{justClicked ? "Rerunning…" : "Rerun"}</span>
    </button>
  );
}

type RatingState = { rating: FeedbackRating } | { failed: true } | null;

/**
 * Thumbs up / thumbs down, wired to the real `POST /agent/feedback` — an
 * up-vote can promote this turn to an exemplar, a down-vote can invalidate
 * the plan it cached (`app.learning.policy.apply_feedback`). Rendered only
 * when this message has a real server row id to rate: a run that died
 * before the `start` chunk landed still carries `useChat.ts`'s local
 * placeholder id, and offering a control that can only 404 is exactly the
 * decorative-button problem this pass exists to remove.
 *
 * A recorded rating stays visibly recorded (filled icon plus the word) so
 * the click has a durable result, not a flash. A failure says so in place
 * rather than silently reverting, which would read as "the click did
 * nothing".
 */
function RatingButtons({ messageId }: { messageId: number }): ReactElement {
  const client = useAskClient();
  const [state, setState] = useState<RatingState>(null);

  async function rate(rating: FeedbackRating) {
    // Optimistically showing the vote and then rolling it back on failure
    // would flicker; this stays neutral until the server has actually
    // recorded it.
    try {
      await submitFeedback(client, messageId, rating);
      setState({ rating });
    } catch {
      setState({ failed: true });
    }
  }

  const recorded = state !== null && "rating" in state ? state.rating : null;

  return (
    <>
      <span className={styles.ratingPrompt}>Was this helpful?</span>
      <button
        type="button"
        className={`${styles.action} ${recorded === "up" ? styles.rated : ""}`}
        onClick={() => void rate("up")}
        aria-label="Rate this answer helpful"
        aria-pressed={recorded === "up"}
      >
        <ThumbsUp size={13} strokeWidth={2} aria-hidden="true" />
        {recorded === "up" && <span>Helpful</span>}
      </button>
      <button
        type="button"
        className={`${styles.action} ${recorded === "down" ? styles.rated : ""}`}
        onClick={() => void rate("down")}
        aria-label="Rate this answer unhelpful"
        aria-pressed={recorded === "down"}
      >
        <ThumbsDown size={13} strokeWidth={2} aria-hidden="true" />
        {recorded === "down" && <span>Noted</span>}
      </button>
      {state !== null && "failed" in state && (
        <span role="alert" className={styles.ratingError}>
          Rating didn&apos;t save
        </span>
      )}
    </>
  );
}

export interface RunMetaProps {
  /** `ChatMessage.id` — a real row id enables the rating controls. */
  messageId: string;
  /** The answer text a Copy click writes, or `""` for an answer that
   * produced none (an errored run). */
  answerText: string;
  agentName: string | null;
  toolCount: number | null;
  score: number | null;
  usage: UsageMetadata | null;
  /** Wall clock this client measured for the whole run. `usage.duration_ms`
   * is not an end-to-end measurement, so it is not shown as run duration. */
  observedMs: number | null;
  onRerun?: () => void;
  /** Forget the cached plan behind this answer and run it fresh. Passed
   * only when the answer WAS served from the plan cache — there is
   * nothing to forget otherwise. */
  onRetryFresh?: () => void;
  rerunDisabled: boolean;
  /** Omitted when the run carried nothing to debug — a reopened message
   * has no trace, so it gets no toggle rather than one that opens an
   * empty drawer. */
  isDebugOpen?: boolean;
  onToggleDebug?: () => void;
  /**
   * Whether the tenant lets this reader see how the run worked
   * (`AskDisclosure.showReasoning`). Off, the strip keeps what any reader
   * can use — Copy, Rerun, the rating, who answered and how long it took —
   * and drops the tool count, the judge's score, the model ids, the dollar
   * cost, the tokens and the debug toggle. Those are the same machinery the
   * setting hides from the reasoning card, and leaving them here meant a
   * reader the tenant chose to spare it could still open the SQL.
   *
   * Required rather than defaulted, so a new caller has to decide.
   */
  showRunDetails: boolean;
}

/**
 * The one dense line under an answer: what to do with it, then what it
 * cost to produce. Everything after the actions is read straight off the
 * stream — the agent named on the request, the tool calls the run made,
 * the judge's score, the models `usage.calls[]` billed, this session's
 * client-measured elapsed time and the dollar cost.
 *
 * **Fields are omitted, never zero-filled — and a zero counts as absent.**
 * Two different things produce a zero here and only one of them is a
 * measurement. `usage.total_tokens` and `usage.cost_usd` are roll-ups over
 * `usage.calls[]`, and a real captured run shows a call arriving as
 * `{input_tokens: 0, output_tokens: 0, cost_usd: 0.00524, priced: true}`
 * — the provider reported the money but not the token counts. A run that
 * produced an answer cannot have spent zero tokens, so `0 tok` is not the
 * count being zero, it is the count being missing; the same holds for an
 * unpriced call's `$0`. Both are therefore dropped rather than printed,
 * which is what "0 tokens" on the old summary line always actually meant.
 */
export function RunMeta({
  messageId,
  answerText,
  agentName,
  toolCount,
  score,
  usage,
  observedMs,
  onRerun,
  onRetryFresh,
  rerunDisabled,
  isDebugOpen,
  onToggleDebug,
  showRunDetails,
}: RunMetaProps): ReactElement {
  const rowId = messageRowId(messageId);
  const models = modelsFromUsage(usage);
  const durationMs = observedMs;

  return (
    <div className={styles.strip}>
      {answerText !== "" && (
        <CopyButton text={answerText} icon={Copy} idleLabel="Copy" ariaLabel="Copy answer" />
      )}
      {onRerun && <RerunButton onRerun={onRerun} disabled={rerunDisabled} />}
      {onRetryFresh && (
        <button
          type="button"
          className={styles.retryFresh}
          onClick={onRetryFresh}
          disabled={rerunDisabled}
          title="This answer reused a cached plan. Forget it and work the question out fresh."
        >
          <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
          <span>Retry without cache</span>
        </button>
      )}
      {rowId !== null && <RatingButtons messageId={rowId} />}

      <span className={styles.facts}>
        {agentName !== null && (
          <span className={styles.fact}>
            <Check size={11} strokeWidth={2.5} aria-hidden="true" />
            {agentName}
          </span>
        )}
        {showRunDetails && toolCount !== null && (
          <span className={styles.fact}>
            {toolCount} tool{toolCount === 1 ? "" : "s"}
          </span>
        )}
        {showRunDetails && score !== null && (
          <span className={styles.fact} data-tone={score >= PASS_SCORE ? "good" : "weak"}>
            score {score.toFixed(2)}
          </span>
        )}
        {showRunDetails && models.map((model) => (
          <span key={model} className={styles.fact} title={model}>
            {model}
          </span>
        ))}
        {durationMs !== null && durationMs !== undefined && (
          <span
            className={styles.fact}
            title="Total elapsed time from submitting the question to receiving the answer"
          >
            {formatDuration(durationMs)}
          </span>
        )}
        {showRunDetails && usage !== null && usage.cost_usd > 0 && (
          <span className={styles.fact}>{formatCost(usage.cost_usd)}</span>
        )}
        {showRunDetails && usage !== null && usage.total_tokens > 0 && (
          <span className={styles.fact}>{formatCount(usage.total_tokens)} tok</span>
        )}
      </span>

      {showRunDetails && onToggleDebug && (
        <button type="button" className={styles.debugToggle} onClick={onToggleDebug} aria-expanded={isDebugOpen}>
          {isDebugOpen ? "Hide debug" : "Show debug"}
        </button>
      )}
    </div>
  );
}
