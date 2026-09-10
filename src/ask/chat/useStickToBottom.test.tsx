import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCROLL_REGION_ATTR, useStickToBottom } from "./useStickToBottom.ts";

/**
 * jsdom lays nothing out, so `scrollHeight`/`clientHeight` are 0 and
 * `ResizeObserver` does not exist. Both are stubbed: the geometry becomes
 * something a test can set deliberately, and the observer becomes a
 * handle a test can fire, which is the only way to assert "the thread
 * grew and the view followed" without a real layout engine.
 */
let fireResize: (() => void) | undefined;

beforeEach(() => {
  // The hook coalesces its scroll writes into one animation frame, so a
  // test that fires a resize and asserts immediately would assert before
  // the write. Run the callback synchronously instead of reaching for
  // fake timers: it keeps every assertion below reading as cause-effect.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        fireResize = callback;
      }
      observe() {}
      disconnect() {
        fireResize = undefined;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  fireResize = undefined;
});

function Harness() {
  const ref = useStickToBottom<HTMLDivElement>();
  return (
    <main data-testid="scroller" {...{ [SCROLL_REGION_ATTR]: "" }}>
      <div ref={ref} data-testid="content" />
    </main>
  );
}

/** jsdom reports every box as zero, so the scroller's geometry is defined
 * here instead — `scrollTop` stays a real, writable property. */
function sizeScroller(el: HTMLElement, { scrollHeight = 1000, clientHeight = 400 } = {}) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
}

describe("following the thread's tail", () => {
  it("scrolls to the bottom when the thread grows", () => {
    const { getByTestId } = render(<Harness />);
    const scroller = getByTestId("scroller");
    sizeScroller(scroller);
    scroller.scrollTop = 600; // exactly at the bottom: 1000 - 600 - 400 = 0

    act(() => fireResize?.());

    expect(scroller.scrollTop).toBe(1000);
  });

  it("leaves a reader who has scrolled up exactly where they are", () => {
    // The behaviour people actively hate in a streaming chat: being yanked
    // back to the bottom mid-sentence because another token arrived.
    const { getByTestId } = render(<Harness />);
    const scroller = getByTestId("scroller");
    sizeScroller(scroller);

    scroller.scrollTop = 100; // 1000 - 100 - 400 = 500px from the bottom
    act(() => scroller.dispatchEvent(new Event("scroll")));
    act(() => fireResize?.());

    expect(scroller.scrollTop).toBe(100);
  });

  it("picks the reader back up when they scroll near the bottom again", () => {
    const { getByTestId } = render(<Harness />);
    const scroller = getByTestId("scroller");
    sizeScroller(scroller);

    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event("scroll")));
    scroller.scrollTop = 580; // 20px from the bottom — still following
    act(() => scroller.dispatchEvent(new Event("scroll")));
    act(() => fireResize?.());

    expect(scroller.scrollTop).toBe(1000);
  });

  it("counts a few pixels short of the bottom as still following", () => {
    // A rubber-band bounce or a sub-pixel row height leaves a small gap,
    // and treating that as "they scrolled away" strands a reader one line
    // above the text they are watching arrive.
    const { getByTestId } = render(<Harness />);
    const scroller = getByTestId("scroller");
    sizeScroller(scroller);

    scroller.scrollTop = 540; // 60px from the bottom, inside the threshold
    act(() => scroller.dispatchEvent(new Event("scroll")));
    act(() => fireResize?.());

    expect(scroller.scrollTop).toBe(1000);
  });

  it("does nothing at all when there is no scroll region above it", () => {
    // A thread rendered outside the shell (a test, a future embed) must
    // not throw looking for an ancestor that is not there.
    function Orphan() {
      const ref = useStickToBottom<HTMLDivElement>();
      return <div ref={ref} data-testid="content" />;
    }

    expect(() => render(<Orphan />)).not.toThrow();
  });
});
