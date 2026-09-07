import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../../api/client.ts";
import { setSession } from "../../auth/session.ts";
import { TrainingSignalPanel } from "./TrainingSignalPanel.tsx";
import type { FeedbackItem } from "./types.ts";

function item(overrides: Partial<FeedbackItem>): FeedbackItem {
  return {
    feedback_id: 1,
    message_id: 400278,
    agent_id: 42,
    rating: "down",
    comment: null,
    created_at: "2026-08-28T09:00:00Z",
    question: "which stores grew last week",
    answer: "The Bombay Canteen led on net sales.",
    ...overrides,
  };
}

function mockList(signal: unknown) {
  return vi.spyOn(gatewayClient, "agentFetch").mockImplementation(async (path) => {
    if (path === "/agent/feedback?agent_id=42") {
      if (signal instanceof Error) throw signal;
      return signal as never;
    }
    throw new Error(`unexpected path ${path}`);
  });
}

describe("TrainingSignalPanel", () => {
  beforeEach(() => {
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setSession(null);
  });

  it("reports the two stores tuning actually reads", async () => {
    mockList({ exemplars: 3, corrections: 7, items: [] });

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() => expect(screen.getByText("3")).toBeInTheDocument());
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  // The finding this panel exists for: a bare thumbs-down invalidates a
  // cached plan and stops. It never becomes a correction, so it never
  // reaches `POST /agent/admin/tune`.
  it("flags a thumbs-down with no reason as not having reached tuning", async () => {
    mockList({ exemplars: 0, corrections: 0, items: [item({ comment: null })] });

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() =>
      expect(screen.getByText(/never reached prompt tuning/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Record the reason" })).toBeInTheDocument();
  });

  it("does not offer to record a reason on one that already has it", async () => {
    mockList({
      exemplars: 0,
      corrections: 1,
      items: [item({ comment: "counted cancelled lines as sales" })],
    });

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() =>
      expect(screen.getByText(/counted cancelled lines as sales/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Record the reason" })).not.toBeInTheDocument();
    expect(screen.queryByText(/never reached prompt tuning/)).not.toBeInTheDocument();
  });

  // A thumbs-up is not actionable after the fact: it promoted an exemplar
  // at rating time or it did not.
  it("offers nothing to record on a thumbs-up", async () => {
    mockList({ exemplars: 1, corrections: 0, items: [item({ rating: "up" })] });

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() => expect(screen.getByText("Helpful")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Record the reason" })).not.toBeInTheDocument();
  });

  it("records the reason against the rated message, as a down-vote with a comment", async () => {
    const agentFetch = mockList({ exemplars: 0, corrections: 0, items: [item({})] });

    render(<TrainingSignalPanel agentId={42} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record the reason" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Record the reason" }));
    fireEvent.change(screen.getByLabelText(/What was wrong/), {
      target: { value: "counted cancelled lines as sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    await waitFor(() => {
      const posted = agentFetch.mock.calls.filter(([path]) => path === "/agent/feedback");
      expect(posted).toHaveLength(1);
    });
    const [, init] = agentFetch.mock.calls.find(([path]) => path === "/agent/feedback")!;
    expect(JSON.parse(String(init?.body))).toEqual({
      message_id: 400278,
      rating: "down",
      comment: "counted cancelled lines as sales",
    });
  });

  // The server decides whether a correction was actually written — a turn
  // with no resolvable question records the reason and no correction — so
  // the counts must come back from it, never be incremented locally.
  it("re-reads the counts from the server after recording", async () => {
    let corrections = 0;
    const agentFetch = vi
      .spyOn(gatewayClient, "agentFetch")
      .mockImplementation(async (_path, init) => {
        if (init?.method === "POST") {
          corrections += 1;
          return {} as never;
        }
        return {
          exemplars: 0,
          corrections,
          items: [item({ comment: corrections > 0 ? "the reason" : null })],
        } as never;
      });

    render(<TrainingSignalPanel agentId={42} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record the reason" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Record the reason" }));
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: "the reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());
    expect(agentFetch.mock.calls.filter(([, i]) => i?.method !== "POST")).toHaveLength(2);
  });

  it("will not send an empty reason", async () => {
    mockList({ exemplars: 0, corrections: 0, items: [item({})] });

    render(<TrainingSignalPanel agentId={42} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record the reason" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record the reason" }));

    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What was wrong/), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
  });

  it("says so when nobody has rated anything, rather than showing an empty box", async () => {
    mockList({ exemplars: 0, corrections: 0, items: [] });

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() => expect(screen.getByText(/No one has rated an answer/)).toBeInTheDocument());
  });

  it("reports a failed read instead of showing zero signal", async () => {
    mockList(new Error("feedback unreachable"));

    render(<TrainingSignalPanel agentId={42} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unreachable"));
    // Zeroes here would read as "this agent has no training signal", which
    // is a different and much worse claim than "we could not check".
    expect(screen.queryByText(/exemplars?$/)).not.toBeInTheDocument();
  });
});
