import { useEffect, useState, type ReactElement } from "react";
import { LiveThought } from "./LiveThought.tsx";
import { currentStepLabel, formatElapsed } from "./runStatus.ts";
import type { RunTrace } from "./runTrace.ts";
import styles from "./RunWaiting.module.css";
import { WaitAnnouncement } from "./WaitAnnouncement.tsx";

/**
 * What the agent is doing, and how long it has been doing it.
 *
 * **Why a run needs this at all.** A question here takes forty to eighty
 * seconds, and for most of that the only thing on screen was a rail of
 * finished steps — which says what has already happened and nothing about
 * whether anything still is. Two people watching an identical run cannot
 * tell a slow query from a hung one, and the honest fix is not to make the
 * run faster (it is as fast as the models are) but to say plainly that it
 * is still going, what it is on, and for how long.
 *
 * **Non-interfering, deliberately.** It sits below the reasoning card in
 * the console's quietest type, and it is gone the instant the first answer
 * token lands — a status line still counting beside a finished answer is
 * worse than none. Nothing here moves except one number per second and the
 * caret, because a busy indicator next to text a reader is trying to read
 * is a cost, not a reassurance.
 *
 * **Quiet for screen readers too.** The status line used to be a live
 * region with the clock inside it, so a screen reader read the whole line
 * again every second. The line is now plain text a reader can find, and
 * `WaitAnnouncement` speaks the state instead, once when the wait begins
 * and once if it runs long.
 */
export function RunWaiting({
  trace,
  startedAt,
  thought,
}: {
  trace: RunTrace;
  startedAt: number;
  thought: string;
}): ReactElement {
  const elapsed = useElapsed(startedAt);

  return (
    <div className={styles.waiting}>
      <p className={styles.status}>
        <span className={styles.pulse} aria-hidden="true" />
        <span className={styles.step}>{currentStepLabel(trace)}</span>
        {/* The clock is the half that says "still working" rather than
            "stuck", so it is the one thing here allowed to change. */}
        <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
      </p>
      <WaitAnnouncement elapsedMs={elapsed} />
      <LiveThought text={thought} />
    </div>
  );
}

/**
 * Milliseconds since `startedAt`, refreshed once a second.
 *
 * Ticks on an interval rather than an animation frame: this renders a
 * whole-second counter, so sixty updates a second would be fifty-nine
 * renders that change nothing. The first value is computed at mount rather
 * than starting from zero — a run whose component remounts mid-flight
 * (opening the Inspector is enough) must not appear to restart.
 */
function useElapsed(startedAt: number): number {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    setElapsed(Date.now() - startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}
