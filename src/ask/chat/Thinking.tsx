import { Bot } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import type { RunStep } from "./runTrace.ts";
import styles from "./Thinking.module.css";

export interface ThinkingProps {
  /** The run's steps so far. Only the last one is shown — see below. */
  steps: RunStep[];
  /** When the run started, for the elapsed counter. */
  startedAt: number | null;
}

/**
 * What a reader sees while a run is in flight when the reasoning card is off.
 *
 * **Why anything at all.** Hiding the machinery cannot mean hiding that there
 * IS machinery: these runs take tens of seconds, and an empty panel for that
 * long reads as broken. The honest minimum is that something is happening,
 * roughly what, and for how long.
 *
 * **The LAST step, not the list.** The reasoning card's job is the whole
 * trajectory; this one's is the current state. Showing every step as it
 * arrives would rebuild the card badly — a growing list nobody asked for,
 * which is the thing being turned off. One line that changes says the same
 * thing and stays one line.
 *
 * **Elapsed, because the absence of a number is what makes waiting feel
 * broken.** A reader who can see 40s tick past knows it is working; the same
 * 40s with no counter feels like a hang.
 *
 * Visually, this is Figma's "Thinking response" tile: a bordered card
 * rather than a bare line, an orb ring standing in for the agent's own
 * avatar, and a gradient label — matching the rest of the redesigned
 * conversation surface (Thread.module.css's `.failure`/`.networkLost` use
 * the same card shape).
 */
export function Thinking({ steps, startedAt }: ThinkingProps): ReactElement {
  const current = steps.length > 0 ? steps[steps.length - 1] : null;
  const elapsed = useElapsed(startedAt);

  return (
    <div className={styles.thinking} role="status" aria-live="polite">
      <span className={styles.ring} aria-hidden="true">
        <Bot size={14} strokeWidth={2} />
      </span>
      {/* Keyed on the label so React remounts it and the crossfade replays;
          without the key the text swaps in place with no transition at all. */}
      <span className={styles.label} key={current?.label ?? "thinking"}>
        {current?.label ?? "Thinking..."}
      </span>
      <span className={styles.dots} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </span>
      {elapsed !== null && <span className={styles.elapsed}>{elapsed}</span>}
    </div>
  );
}

/**
 * Whole seconds since `startedAt`, or `null` before a run has one.
 *
 * Ticks on a one-second interval rather than an animation frame: this is a
 * counter a person reads, not something that needs to be smooth, and a
 * per-frame timer behind a "less machinery" setting would be its own joke.
 */
function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return null;
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 1) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
