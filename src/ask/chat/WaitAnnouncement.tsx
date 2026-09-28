import { useEffect, useState, type ReactElement } from "react";
import a11y from "../a11y.module.css";

/**
 * When a wait stops being an ordinary one and starts sounding like a hang.
 *
 * A minute: past the middle of the forty to eighty seconds a run usually
 * takes, and long enough that nothing since "Working on your question"
 * starts to sound like a hang to someone who cannot see the clock.
 */
export const SLOW_RUN_MS = 60_000;

/**
 * What a screen reader hears while a run is in flight: two sentences, once
 * each.
 *
 * **Why not the visible line.** The wait indicators used to be live regions
 * themselves, and the elapsed clock was inside them, so a screen reader read
 * "Reading the schema, 12s", "Reading the schema, 13s" and so on, once a
 * second for the whole run, over whatever the reader was trying to do. The
 * clock is for eyes: it says "still going" by moving. What a listener needs
 * is the state, and the state changes twice at most.
 *
 * **Why it starts empty.** A live region announces a CHANGE to its content,
 * and several screen readers say nothing about text that was already there
 * when the region appeared. So it mounts empty and fills itself after the
 * first commit, when the region already exists to change.
 *
 * `AnswerAnnouncer.tsx` says the rest: that the answer is ready, or that it
 * failed.
 */
export function WaitAnnouncement({ elapsedMs }: { elapsedMs: number }): ReactElement {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(true);
  }, []);

  const message = !armed
    ? ""
    : elapsedMs >= SLOW_RUN_MS
      ? "Still working, this is taking longer than usual"
      : "Working on your question";

  return (
    <span className={a11y.visuallyHidden} role="status" aria-live="polite">
      {message}
    </span>
  );
}
