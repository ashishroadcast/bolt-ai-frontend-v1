import { describe, expect, it } from "vitest";
import { CLOSE_HOUR, OPEN_HOUR, servicePosition } from "./serviceWindow.ts";

function at(hour: number, minute = 0): Date {
  return new Date(2026, 7, 28, hour, minute);
}

describe("servicePosition", () => {
  it("puts opening time at the start and closing time at the end", () => {
    expect(servicePosition(at(OPEN_HOUR)).progress).toBe(0);
    // 01:59 is the last trading minute of a window that opened at 10:00
    // the previous morning; 02:00 itself is already shut.
    expect(servicePosition(at(CLOSE_HOUR - 1, 59)).progress).toBeCloseTo(1, 1);
  });

  it("does not run backwards after midnight", () => {
    // The bug this guards: 01:00 is 15 hours into the service day, not
    // minus nine. A naive (hour - OPEN_HOUR) puts the late-night peak at
    // the far left of the strip, before opening.
    const lateEvening = servicePosition(at(23)).progress;
    const afterMidnight = servicePosition(at(1)).progress;

    expect(lateEvening).not.toBeNull();
    expect(afterMidnight).not.toBeNull();
    expect(afterMidnight!).toBeGreaterThan(lateEvening!);
  });

  it("reports closed between close and open, with no position", () => {
    for (const hour of [2, 6, 9]) {
      const position = servicePosition(at(hour));
      expect(position.isClosed).toBe(true);
      // Null, not 0: "shut" and "just opened" are different states and a
      // marker parked at the left edge would read as the second.
      expect(position.progress).toBeNull();
    }
  });

  it("reports open across the whole trading window", () => {
    for (const hour of [10, 15, 19, 23, 0, 1]) {
      expect(servicePosition(at(hour)).isClosed).toBe(false);
    }
  });

  it("places the dinner peak in the second half of the window", () => {
    const { peakStart, peakEnd } = servicePosition(at(15));

    expect(peakStart).toBeGreaterThan(0.5);
    expect(peakEnd).toBeGreaterThan(peakStart);
    expect(peakEnd).toBeLessThan(1);
  });
});
