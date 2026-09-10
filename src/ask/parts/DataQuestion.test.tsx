import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataQuestion } from "./DataQuestion.tsx";

// The run is BLOCKED inside its ask_user tool for sixty seconds while this
// is on screen, so every choice here is about answering fast — and about
// what happens when someone doesn't.

const base = {
  questionId: "q1",
  question: "By which measure?",
  options: ["Net sales", "Order count"],
  allowMultiple: false,
  allowOther: false,
};

describe("answering a question the run is waiting on", () => {
  it("sends a single choice on one click", async () => {
    // Making someone click an option and then a button spends part of the
    // window they do not need to spend.
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<DataQuestion {...base} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByLabelText("Net sales"));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("q1", "Net sales"));
  });

  it("waits for the button when several answers are allowed", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<DataQuestion {...base} allowMultiple onAnswer={onAnswer} />);

    fireEvent.click(screen.getByLabelText("Net sales"));
    fireEvent.click(screen.getByLabelText("Order count"));
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("q1", "Net sales, Order count"));
  });

  it("lets someone answer outside the options", async () => {
    // A fixed list nobody can escape turns a clarification into an
    // obstacle.
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<DataQuestion {...base} allowOther onAnswer={onAnswer} />);

    fireEvent.change(screen.getByLabelText("Something else"), {
      target: { value: "By gross margin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith("q1", "By gross margin"));
  });

  it("keeps the question on screen after it is answered", async () => {
    // A thread showing an answer without the question it answered reads as
    // a non-sequitur when it is reopened later.
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<DataQuestion {...base} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByLabelText("Net sales"));

    await waitFor(() => expect(screen.getByText("Net sales")).toBeInTheDocument());
    expect(screen.getByText("By which measure?")).toBeInTheDocument();
  });

  it("says the run moved on rather than failing silently", async () => {
    // The expected failure: a 404 because the run gave up after sixty
    // seconds. Someone who answers slowly must be told, not left watching
    // a form that never resolves.
    const onAnswer = vi.fn().mockRejectedValue(new Error("that question is no longer waiting"));
    render(<DataQuestion {...base} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByLabelText("Net sales"));

    await waitFor(() =>
      expect(screen.getByText(/no longer waiting/)).toBeInTheDocument(),
    );
  });

  it("cannot be answered when re-read from history", async () => {
    // No onAnswer: that run ended long ago, so a working form would be a
    // control that cannot do anything.
    render(<DataQuestion {...base} />);

    expect(screen.getByText(/went with its best reading/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("closes itself when the run's five-minute window runs out", async () => {
    // The screen this fixes: two full question forms stranded under a
    // finished answer, still offering options that could only 404.
    vi.useFakeTimers();
    try {
      const onAnswer = vi.fn().mockResolvedValue(undefined);
      render(<DataQuestion {...base} onAnswer={onAnswer} />);
      expect(screen.getByLabelText("Net sales")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(300_000);
      });

      expect(screen.queryByLabelText("Net sales")).not.toBeInTheDocument();
      expect(screen.getByText(/went with its best reading/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays open for the whole five minutes", async () => {
    vi.useFakeTimers();
    try {
      const onAnswer = vi.fn().mockResolvedValue(undefined);
      render(<DataQuestion {...base} onAnswer={onAnswer} />);

      act(() => {
        vi.advanceTimersByTime(299_000);
      });

      expect(screen.getByLabelText("Net sales")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing when there is nothing to send", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<DataQuestion {...base} options={[]} allowOther onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    expect(onAnswer).not.toHaveBeenCalled();
  });
});
