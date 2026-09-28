import type { ReactElement } from "react";
import styles from "./LiveThought.module.css";

/**
 * The model's reasoning, while it is still being written.
 *
 * **Why this exists at all.** Measured on a live run: the answer's 158
 * deltas all arrived inside 1.9 seconds, at the 83-second mark of an
 * 85-second run. The typewriter was working perfectly and looked broken,
 * because there was nothing to reveal until the very end — eighty seconds
 * of a static progress rail, then the whole answer at once. Streaming the
 * reasoning puts the first characters on screen at 9.4s instead, and
 * keeps text arriving for the twenty-odd seconds the planning phase
 * spends thinking.
 *
 * **It is progress, not answer, and it is styled to say so.** Quieter
 * type, and it disappears the moment the answer starts — the reader
 * should never have to work out which of two blocks of text is the thing
 * they asked for. Nothing here is persisted: reopen the conversation and
 * only the answer is there, which is correct, because a thought is how
 * the answer got made and not part of it.
 *
 * Only the tail is shown. The full reasoning across a run runs to
 * thousands of characters and is not something anyone reads top to
 * bottom; what a reader wants from it is evidence of motion and a rough
 * sense of what the agent is working on. The whole of it is still in the
 * run trace behind the Inspector for anyone who does want to read it.
 *
 * **Not a live region.** It was one, and a screen reader read out every
 * streamed chunk of the model's reasoning for the whole run: a fragment of
 * a sentence every few hundred milliseconds, over anything else the reader
 * tried to do. It is now a labelled group a reader can visit and leave;
 * `WaitAnnouncement` is what speaks while a run is in flight.
 */

/**
 * How much of the tail is kept.
 *
 * Was 240 — about one line once it wrapped, so the reasoning streamed
 * past and left a single line sitting there ("comes out too quickly and
 * then only the last line is visible"). Enough now to fill the window
 * below several times over, so text visibly travels UP through a stable
 * frame instead of replacing itself in place.
 */
const TAIL_CHARS = 900;

export function LiveThought({ text }: { text: string }): ReactElement | null {
  // trim, not trimEnd: a stream that has so far produced only whitespace
  // would otherwise render a bordered block with nothing in it, which
  // reads as something that failed to load rather than as nothing yet.
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const tail = trimmed.length > TAIL_CHARS ? trimmed.slice(-TAIL_CHARS) : trimmed;
  // Never start mid-word: sliced to a fixed length the tail begins on
  // whatever character happened to land there, which reads as corruption
  // rather than as a continuing thought.
  const fromWord = trimmed.length > TAIL_CHARS ? tail.slice(tail.indexOf(" ") + 1) : tail;

  return (
    // The window is a wrapper, not this paragraph: it holds a fixed height
    // and clips from the TOP (see the stylesheet), so the newest words are
    // always the ones on screen and the block never grows the page.
    //
    // `aria-live="off"` spelled out rather than left as the default, so a
    // live region added around this later cannot start reading the stream.
    <div
      className={styles.window}
      role="group"
      aria-label="What the agent is working on"
      aria-live="off"
    >
      <p className={styles.thought}>
        {trimmed.length > TAIL_CHARS && <span aria-hidden="true">… </span>}
        {fromWord}
        <span className={styles.caret} aria-hidden="true" />
      </p>
    </div>
  );
}
