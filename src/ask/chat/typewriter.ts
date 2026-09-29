import { useEffect, useState } from "react";

/**
 * The answer, revealed at reading pace instead of landing as a block.
 *
 * Saurabh: "start printing like typewriter how chatgpt does it." The
 * backend cannot yet stream tokens — the whole answer arrives as a single
 * `text-delta` once the pipeline has finished (a real capture: one delta,
 * 513 characters), and making DSPy stream it broke the tool calls
 * outright. So the cadence is produced here, on text that has already
 * arrived in full.
 *
 * **This reveals, it does not fake.** Every character shown is a character
 * this client is holding; nothing is invented, predicted or padded, and
 * when the text grows the reveal simply carries on from where it was. That
 * is the difference between a progressive reveal and a progress bar that
 * lies.
 */

/**
 * How far each answer's reveal has got, by message id.
 *
 * Two things need this and neither can own it. The reveal starts under
 * `activeRun` and finishes under the `ChatMessage` that replaces it —
 * the same id throughout (`ActiveRun.messageId` *is* `ChatMessage.id`,
 * `useChat.ts`) — so component-local state would restart the animation at
 * the exact moment the run completes. And an answer already read must
 * never replay when its component remounts (navigating to Agents and back
 * is enough), which is what an entry at full length records.
 *
 * One number per answer in one session's memory; it is not worth evicting.
 */
const revealedChars = new Map<string, number>();

/**
 * Characters per second, chosen so the reveal never outlasts its welcome.
 *
 * `BASE_RATE` is roughly the pace a fast model streams at, so a short
 * answer reads the way a streamed one does. Past about 400 characters the
 * cap takes over and the rate rises with the length instead: a 2,000
 * character answer would otherwise crawl for twelve seconds, which is
 * longer than the run that produced it took to think.
 */
const BASE_RATE = 180;
const MAX_REVEAL_MS = 2200;

function charsPerSecond(total: number): number {
  return Math.max(BASE_RATE, total / (MAX_REVEAL_MS / 1000));
}

/**
 * Whether this environment has affirmatively said motion is fine.
 *
 * Phrased as "no-preference matches" rather than "reduce does not",
 * because those differ exactly where it matters: somewhere with no media
 * query support at all (a test renderer, a server render) answers *no* to
 * both, and the safe reading of "I cannot tell" is to show the whole
 * answer at once rather than to animate.
 */
export function motionIsWelcome(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches === true;
}

/**
 * Whether the page is out of sight — a background tab, a minimised window,
 * a hidden panel. Browsers stop `requestAnimationFrame` there, so a reveal
 * started while hidden never advances: the answer had arrived, and was
 * saved, but read as blank until the reader came back and then made them
 * watch it type. A run takes the better part of a minute, and switching tab
 * while it thinks is the normal thing to do.
 */
function pageIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * How many characters of `text` may be shown right now.
 *
 * Returns `text.length` immediately — no animation frame, no flash of
 * empty answer — whenever `animate` is false, the page is hidden, or this
 * answer has already been revealed once. A conversation reopened from
 * history takes that path for every message in it.
 */
export function useTypewriter(messageId: string, text: string, animate: boolean): number {
  const [shown, setShown] = useState(() => revealedChars.get(messageId) ?? 0);
  // Derived during render rather than pushed into state by an effect: an
  // answer that has nothing left to reveal must be complete on its very
  // first paint, and a state update to say so would show an empty answer
  // for one frame first.
  const hidden = animate && pageIsHidden();
  const isComplete = !animate || hidden || (revealedChars.get(messageId) ?? 0) >= text.length;

  useEffect(() => {
    if (hidden) {
      // Nobody saw it arrive, so there is nothing to reveal: recorded as
      // read, the answer is whole when the reader comes back rather than
      // starting to type then.
      revealedChars.set(messageId, text.length);
      return;
    }
    if (isComplete) return;

    let frame = 0;
    const already = revealedChars.get(messageId) ?? 0;
    const startedAt = performance.now();
    const rate = charsPerSecond(text.length);

    function step(now: number) {
      const next = Math.min(text.length, already + Math.floor(((now - startedAt) / 1000) * rate));
      revealedChars.set(messageId, next);
      setShown(next);
      if (next < text.length) frame = requestAnimationFrame(step);
    }

    // Hidden part-way through: the paused frames would leave the rest
    // unrevealed until the reader returns, so it is shown whole now.
    function onVisibilityChange() {
      if (!pageIsHidden()) return;
      cancelAnimationFrame(frame);
      revealedChars.set(messageId, text.length);
      setShown(text.length);
    }

    frame = requestAnimationFrame(step);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [messageId, text, isComplete, hidden]);

  return isComplete ? text.length : Math.min(shown, text.length);
}
