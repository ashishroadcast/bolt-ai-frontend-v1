import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Thinking } from "./Thinking.tsx";
import { SLOW_RUN_MS } from "./WaitAnnouncement.tsx";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T20:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the quiet wait line, for a screen reader", () => {
  it("still shows the step and the clock", () => {
    render(<Thinking steps={[]} startedAt={Date.now() - 12_000} />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();
  });

  it("keeps the ticking clock out of every live region", () => {
    // A clock inside a live region is read aloud once a second for the
    // whole run.
    render(<Thinking steps={[]} startedAt={Date.now() - 12_000} />);

    const clock = screen.getByText("12s");
    expect(clock.closest("[aria-live='polite'], [aria-live='assertive'], [role='status']")).toBeNull();
  });

  it("announces that it is working, and not again as the seconds pass", () => {
    render(<Thinking steps={[]} startedAt={Date.now()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Working on your question");

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(status).toHaveTextContent("Working on your question");
    expect(status).not.toHaveTextContent(/\d/);
  });

  it("says so once a run is taking longer than usual", () => {
    render(<Thinking steps={[]} startedAt={Date.now()} />);

    act(() => {
      vi.advanceTimersByTime(SLOW_RUN_MS);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Still working, this is taking longer than usual",
    );
  });
});
