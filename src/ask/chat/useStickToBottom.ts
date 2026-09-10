import { useEffect, useRef } from "react";

/**
 * Keeps a growing thread pinned to its own bottom edge.
 *
 * Nothing scrolled at all before this. An answer streams in over a couple
 * of seconds and the sheets below it — a comparison panel, a chart, a
 * table — appear after that, so the thing a reader is waiting for arrives
 * *below the fold* and stays there until they scroll by hand. On a live
 * run that is the whole answer.
 *
 * **Pinned, not forced.** A reader who has scrolled up is reading
 * something, and yanking them back to the bottom every time a token
 * arrives is worse than not scrolling at all — it is the one behaviour
 * people actively hate in a streaming chat. So the pin is dropped the
 * moment they scroll away from the bottom and taken up again as soon as
 * they come back, exactly like a terminal that follows its tail.
 */

/**
 * How close to the bottom still counts as "following".
 *
 * Generous on purpose: a reader parked at the end is rarely at exactly
 * zero — a rubber-band bounce, a sub-pixel row height, or a caret blinking
 * at the end of a streamed line all leave a few pixels — and treating that
 * as "they scrolled away" would strand them one line above the text they
 * are watching arrive.
 */
const FOLLOW_THRESHOLD_PX = 72;

/**
 * The attribute Shell's scrolling `<main>` carries.
 *
 * An explicit marker rather than walking up looking for a computed
 * `overflow`: the scroll region is a decision the shell makes, so it
 * should be declared where that decision lives and greppable from here.
 * Sniffing ancestors instead would silently pick a different element the
 * day anything between grows its own scrollbar.
 */
export const SCROLL_REGION_ATTR = "data-scroll-region";

/**
 * Attach the returned ref to the content that grows. Everything else —
 * finding the scroller, watching for growth, tracking whether the reader
 * is still following — happens here.
 */
export function useStickToBottom<T extends HTMLElement>(): React.RefObject<T | null> {
  const contentRef = useRef<T | null>(null);
  // A ref, not state: this changes on every scroll event and nothing
  // renders differently because of it, so state would be sixty pointless
  // re-renders a second during a flick-scroll.
  const following = useRef(true);

  useEffect(() => {
    const content = contentRef.current;
    const scroller = content?.closest<HTMLElement>(`[${SCROLL_REGION_ATTR}]`);
    if (!content || !scroller) return;

    const atBottom = () =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_THRESHOLD_PX;

    function onScroll() {
      following.current = atBottom();
    }

    // Coalesced to one write per frame.
    //
    // ResizeObserver fires per observed box per change, and a streaming
    // answer changes several at once — the text block, the sheet that just
    // arrived, the row inside it. Writing scrollTop on each of those means
    // several writes per frame against a height that is still settling,
    // and the result is the visible judder ("working but very rudimentary").
    // One write, after the browser has finished laying the frame out, is
    // both smoother and less work.
    // `pending` is set BEFORE requesting the frame, not derived from the
    // handle: the handle is only assigned once requestAnimationFrame
    // returns, which is after its callback has run if frames are being
    // driven synchronously — leaving the guard permanently closed.
    let pending = false;
    let frame = 0;
    function toBottom() {
      if (!following.current || !scroller || pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        if (!following.current || !scroller) return;
        // Instant, never CSS-smooth. A smooth scroll restarted every frame
        // while text streams never reaches its own target — it reads as the
        // page sliding around underneath the answer.
        scroller.scrollTop = scroller.scrollHeight;
      });
    }

    scroller.addEventListener("scroll", onScroll, { passive: true });

    // ResizeObserver rather than a dependency on the message list: the
    // thread also grows when a sheet finishes laying out, when an image
    // loads, and when a `<details>` is opened — none of which is a React
    // state change this hook could depend on.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(toBottom);
    observer?.observe(content);
    toBottom();

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return contentRef;
}
