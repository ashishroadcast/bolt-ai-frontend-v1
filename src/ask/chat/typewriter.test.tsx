import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { motionIsWelcome, useTypewriter } from "./typewriter.ts";

/**
 * A hand-driven animation clock. `useTypewriter` reads wall time from
 * `performance.now()` and schedules on `requestAnimationFrame`, so pinning
 * both is what makes "how fast does it reveal" a testable question rather
 * than a flaky one.
 */
function fakeClock() {
  let now = 0;
  let pending: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.push(callback);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("performance", { now: () => now });
  return {
    advance(ms: number) {
      now += ms;
      const due = pending;
      pending = [];
      act(() => {
        for (const callback of due) callback(now);
      });
    },
    get scheduled() {
      return pending.length;
    },
  };
}

/**
 * Distinct per test: the module remembers what has already been revealed,
 * on purpose, so a shared id would leak one test's progress into the next.
 * Always resolved to a constant *before* `renderHook`, never inside the
 * callback — an id that changed every render would restart the reveal on
 * every frame, which is exactly the bug the hook exists to avoid.
 */
let seq = 0;
function nextId(): string {
  seq += 1;
  return `msg-${seq}`;
}

const SHORT = "Bandra led the month at ten lakh.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("motionIsWelcome", () => {
  it("says no when the environment cannot be asked at all", () => {
    // jsdom has no matchMedia. "I cannot tell" has to mean "show it all",
    // never "animate anyway".
    expect(window.matchMedia).toBeUndefined();
    expect(motionIsWelcome()).toBe(false);
  });

  it("says no for a reader who has asked for reduced motion", () => {
    // A real browser answers both halves of the pair: for this reader
    // `reduce` matches and `no-preference` does not.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: !query.includes("no-preference") })),
    );

    expect(motionIsWelcome()).toBe(false);
  });

  it("says yes only when no-preference actually matches", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("no-preference") })),
    );

    expect(motionIsWelcome()).toBe(true);
  });
});

describe("useTypewriter", () => {
  it("shows the whole answer at once when it is not animating", () => {
    const clock = fakeClock();
    const id = nextId();
    const { result } = renderHook(() => useTypewriter(id, SHORT, false));

    expect(result.current).toBe(SHORT.length);
    // Not "it finished instantly" — it never scheduled a frame at all.
    expect(clock.scheduled).toBe(0);
  });

  it("reveals progressively, and only ever text it is already holding", () => {
    const clock = fakeClock();
    const id = nextId();
    const { result } = renderHook(() => useTypewriter(id, SHORT, true));

    expect(result.current).toBe(0);

    clock.advance(100);
    const partway = result.current;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(SHORT.length);

    clock.advance(100);
    expect(result.current).toBeGreaterThan(partway);

    clock.advance(2000);
    expect(result.current).toBe(SHORT.length);
  });

  it("speeds up for a long answer rather than crawling through it", () => {
    // A run takes seconds to think; a reveal that took twelve to play back
    // would be slower than the thing it is standing in for.
    const long = "x".repeat(4000);
    const clock = fakeClock();
    const id = nextId();
    const { result } = renderHook(() => useTypewriter(id, long, true));

    clock.advance(600);
    expect(result.current).toBeLessThan(long.length);

    clock.advance(1800);
    expect(result.current).toBe(long.length);
  });

  it("holds a floor rate, so a one-line answer is not stretched to fill the cap", () => {
    // The other half of the cap. If the rate were simply "length ÷ cap",
    // these 32 characters would take the full 2.2 seconds — a sentence
    // dribbling out one character every seventy milliseconds.
    const clock = fakeClock();
    const id = nextId();
    const { result } = renderHook(() => useTypewriter(id, SHORT, true));

    clock.advance(60);
    expect(result.current).toBeLessThan(SHORT.length);

    clock.advance(140);
    expect(result.current).toBe(SHORT.length);
  });

  it("never replays an answer that has already been revealed", () => {
    const id = nextId();
    const clock = fakeClock();
    const first = renderHook(() => useTypewriter(id, SHORT, true));
    clock.advance(3000);
    expect(first.result.current).toBe(SHORT.length);
    first.unmount();

    // Remounting is ordinary — navigating to another screen and back does
    // it — and text that types itself out again on something already read
    // is the clearest possible sign of a fake.
    const again = renderHook(() => useTypewriter(id, SHORT, true));
    expect(again.result.current).toBe(SHORT.length);
    // The load-bearing half. Reading `text.length` back is not enough on
    // its own — it is also what the very first frame of a replay would
    // report. Nothing may be scheduled at all.
    expect(clock.scheduled).toBe(0);
  });

  it("carries on from where it was when the same answer changes hands", () => {
    // The live run and the finished message share one id (`ActiveRun.
    // messageId` is `ChatMessage.id`), so the hand-off at the end of a run
    // must not rewind the reveal to zero.
    const id = nextId();
    const clock = fakeClock();
    const live = renderHook(() => useTypewriter(id, SHORT, true));
    clock.advance(80);
    const reached = live.result.current;
    expect(reached).toBeGreaterThan(0);
    live.unmount();

    const finished = renderHook(() => useTypewriter(id, SHORT, true));
    expect(finished.result.current).toBe(reached);
  });

  it("keeps each answer's progress to itself", () => {
    const clock = fakeClock();
    const read = nextId();
    const unread = nextId();
    const revealed = renderHook(() => useTypewriter(read, SHORT, true));
    clock.advance(3000);
    expect(revealed.result.current).toBe(SHORT.length);

    // A second answer of the same length must start from nothing — the
    // record is per answer, not "some answer has been read by now".
    const other = renderHook(() => useTypewriter(unread, SHORT, true));
    expect(other.result.current).toBe(0);
  });
});
