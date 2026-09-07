import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWaiting } from "./RunWaiting.tsx";
import { EMPTY_TRACE, type RunTrace } from "./runTrace.ts";

const trace: RunTrace = { ...EMPTY_TRACE, phases: [], tools: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-28T20:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const now = () => Date.now();

describe("telling a reader the run is still going", () => {
  it("names what it is doing and how long it has been", () => {
    render(<RunWaiting trace={trace} startedAt={now()} thought="" />);

    expect(screen.getByText("Reading the schema")).toBeInTheDocument();
    expect(screen.getByText("0s")).toBeInTheDocument();
  });

  it("counts up once a second", () => {
    render(<RunWaiting trace={trace} startedAt={now()} thought="" />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByText("3s")).toBeInTheDocument();
  });

  it("picks up a run already in flight rather than restarting at zero", () => {
    // Opening the Inspector is enough to remount this, and a clock that
    // jumps back to 0s reads as the run having restarted.
    render(<RunWaiting trace={trace} startedAt={now() - 42_000} thought="" />);

    expect(screen.getByText("42s")).toBeInTheDocument();
  });

  it("stops counting when it unmounts", () => {
    // The interval outliving the component is the classic leak here, and
    // it is invisible from the DOM: React tolerates a setState on an
    // unmounted component without throwing, so an "it did not crash"
    // assertion passes just as happily with the leak in place (verified —
    // deleting the clearInterval left such a test green). The timer queue
    // is the only place the leak is actually observable.
    const { unmount } = render(<RunWaiting trace={trace} startedAt={now()} thought="" />);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows the reasoning underneath once there is any", () => {
    render(<RunWaiting trace={trace} startedAt={now()} thought="Checking the daily rollups" />);

    expect(screen.getByText(/Checking the daily rollups/)).toBeInTheDocument();
  });

  it("shows the status line even before any reasoning has arrived", () => {
    // Reasoning starts around nine seconds in; the status line has to
    // carry the first nine on its own.
    render(<RunWaiting trace={trace} startedAt={now()} thought="" />);

    expect(screen.getByText("Reading the schema")).toBeInTheDocument();
    expect(screen.queryByLabelText("What the agent is working on")).not.toBeInTheDocument();
  });

  it("announces changes politely rather than interrupting a screen reader", () => {
    render(<RunWaiting trace={trace} startedAt={now()} thought="" />);

    expect(screen.getByText("Reading the schema").closest("p")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
