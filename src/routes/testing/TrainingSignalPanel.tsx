import { useEffect, useState } from "react";
import { apiErrorMessage, listFeedback, recordFeedbackReason } from "./api.ts";
import type { FeedbackItem, FeedbackList } from "./types.ts";
import styles from "./TrainingSignalPanel.module.css";

/**
 * What tuning will actually learn from, and the ratings that are not
 * reaching it yet.
 *
 * **Why this sits on the Prompts tab.** `POST /agent/admin/tune` reads
 * exactly two stores — promoted exemplars and corrections — and turns them
 * into a new prompt version. Both are written by `POST /agent/feedback`,
 * and until this panel there was nowhere to see either: an operator
 * pressing Tune could not tell whether they were about to compile from a
 * hundred corrections or from none, and a 422 saying "no training signal"
 * was the first and only feedback they got.
 *
 * **The actionable row is a thumbs-down with no comment.** §9.1's write
 * policy turns a bare 👎 into a plan-cache invalidation and stops there;
 * only a 👎 *with* a comment becomes a correction, and only corrections
 * reach the tuner (as "mistakes to avoid", verbatim, in
 * `PromptTuningSignature`). So a bare down-vote is a rating that never
 * influences a prompt. This lists them and offers to record the reason,
 * which posts an ordinary `POST /agent/feedback` — the same door the
 * rating came through, not a second write path (see `recordFeedbackReason`
 * in `api.ts`).
 *
 * A 👍 is shown but never actionable here: it either promoted an exemplar
 * at rating time or it did not, and nothing an operator can type afterwards
 * changes that.
 */
export function TrainingSignalPanel({ agentId }: { agentId: number }) {
  const [signal, setSignal] = useState<FeedbackList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSignal(null);
    setLoadError(null);
    listFeedback(agentId)
      .then((loaded) => {
        if (!cancelled) setSignal(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, reload]);

  return (
    <section className={styles.panel} aria-label="Training signal">
      <header className={styles.head}>
        <h3 className={styles.title}>Training signal</h3>
        {signal !== null && (
          <span className={styles.counts}>
            <span className={styles.count}>
              <strong>{signal.exemplars}</strong> exemplar{signal.exemplars === 1 ? "" : "s"}
            </span>
            <span className={styles.count}>
              <strong>{signal.corrections}</strong> correction
              {signal.corrections === 1 ? "" : "s"}
            </span>
          </span>
        )}
      </header>

      <p className={styles.body}>
        Tune reads these two stores and nothing else. A thumbs-up on an answer whose plan was cached
        becomes an exemplar; a thumbs-down becomes a correction only once someone records why.
      </p>

      {signal === null && loadError === null && <p className={styles.status}>Reading ratings…</p>}

      {loadError !== null && (
        <p className={styles.status} role="alert">
          Couldn&apos;t read the ratings — {loadError}
        </p>
      )}

      {signal !== null && signal.items.length === 0 && (
        <p className={styles.status}>
          No one has rated an answer from this agent yet. Ratings are the thumbs on each answer in
          Ask.
        </p>
      )}

      {signal !== null && signal.items.length > 0 && (
        <ul className={styles.list}>
          {signal.items.map((item) => (
            <RatingRow key={item.feedback_id} item={item} onRecorded={() => setReload((n) => n + 1)} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RatingRowProps {
  item: FeedbackItem;
  onRecorded: () => void;
}

function RatingRow({ item, onRecorded }: RatingRowProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDown = item.rating === "down";
  const needsReason = isDown && item.comment === null;

  async function record() {
    setSaving(true);
    setError(null);
    try {
      await recordFeedbackReason(item.message_id, reason.trim());
      setOpen(false);
      setReason("");
      // Re-reads the list rather than patching it in place: the server is
      // what decides whether a correction was actually written (a turn with
      // no resolvable question records the reason and no correction), and
      // guessing that client-side would show a count that never moved.
      onRecorded();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className={styles.row} data-rating={item.rating}>
      <div className={styles.rowHead}>
        <span className={styles.mark} aria-label={isDown ? "Rated unhelpful" : "Rated helpful"}>
          {isDown ? "Unhelpful" : "Helpful"}
        </span>
        <span className={styles.question}>{item.question ?? "(no question recorded)"}</span>
        {needsReason && !open && (
          <button type="button" className={styles.reasonBtn} onClick={() => setOpen(true)}>
            Record the reason
          </button>
        )}
      </div>

      <p className={styles.answer}>{item.answer || "(no answer recorded)"}</p>

      {item.comment !== null && <p className={styles.comment}>Correction: {item.comment}</p>}

      {needsReason && !open && (
        <p className={styles.warn}>
          No reason recorded, so this rating never reached prompt tuning.
        </p>
      )}

      {open && (
        <div className={styles.reasonBox}>
          <label htmlFor={`reason-${item.feedback_id}`}>What was wrong with this answer?</label>
          <textarea
            id={`reason-${item.feedback_id}`}
            className={styles.reasonInput}
            value={reason}
            placeholder="e.g. counted cancelled lines as sales"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className={styles.reasonActions}>
            <button
              type="button"
              className={styles.recordBtn}
              onClick={() => void record()}
              disabled={saving || reason.trim() === ""}
            >
              {saving ? "Recording…" : "Record"}
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
          {error !== null && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
