import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetDraft, type WidgetDraftProps } from "./WidgetDraft.tsx";
import { resetWidgetDraftsForTests } from "./widgetDraftStore.ts";
import { TestAskProvider } from "../testing.tsx";
import type { AskConfig, AskWidgetDraft, WidgetDraftAck } from "../config.tsx";

let counter = 0;
function draft(overrides: Partial<WidgetDraftProps> = {}): WidgetDraftProps {
  counter += 1;
  return {
    draftId: `draft-${counter}`,
    widget: {
      metricKey: "eta.trips_completed_daily",
      visualization: "line",
      title: "Trips Completed — daily",
      size: "wide",
      params: { timeRange: { preset: "last_30d" } },
    },
    ...overrides,
  };
}

/** A promise the test settles by hand, to observe the pending state. */
function deferred() {
  let resolve!: (ack: WidgetDraftAck) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WidgetDraftAck>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tree(props: WidgetDraftProps, config: Partial<AskConfig>) {
  return (
    <TestAskProvider config={config}>
      <WidgetDraft {...props} />
    </TestAskProvider>
  );
}

afterEach(() => resetWidgetDraftsForTests());

describe("WidgetDraft", () => {
  it("shows the widget's title, graph style and time range", () => {
    render(tree(draft(), {}));
    expect(screen.getByRole("heading", { name: "Trips Completed — daily" })).toBeInTheDocument();
    expect(screen.getByText("Line chart · Last 30 days")).toBeInTheDocument();
  });

  it("falls back to the catalog's title when the AI gave none", () => {
    render(tree(draft({ widget: { metricKey: "eta.trips_completed", visualization: "kpi" } }), {}));
    expect(screen.getByRole("heading", { name: "Trips Completed" })).toBeInTheDocument();
  });

  it("is read-only in a host with no builder — no insert, no buttons", () => {
    render(tree(draft({ live: true }), {}));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("inserts itself on the live stream exactly once, through StrictMode, re-renders and a remount", async () => {
    const onWidgetDraft = vi.fn((_draft: AskWidgetDraft) =>
      Promise.resolve<WidgetDraftAck>({ status: "added", widgetId: "w-1" }),
    );
    const props = draft({ live: true });
    const view = render(<StrictMode>{tree(props, { onWidgetDraft })}</StrictMode>);
    view.rerender(<StrictMode>{tree(props, { onWidgetDraft })}</StrictMode>);
    // A fresh callback identity, as the custom element produces on every render.
    view.rerender(<StrictMode>{tree(props, { onWidgetDraft: (d) => onWidgetDraft(d) })}</StrictMode>);
    view.unmount();
    // The LiveTurn → AnsweredTurn hand-off mounts a brand-new card.
    render(tree(props, { onWidgetDraft }));

    await waitFor(() => expect(screen.getByText("Added to your view — not saved yet")).toBeInTheDocument());
    expect(onWidgetDraft).toHaveBeenCalledTimes(1);
    const handed = onWidgetDraft.mock.calls[0]![0];
    // The contract shape, without the render-only flag.
    expect(handed).toEqual({ draftId: props.draftId, widget: props.widget });
  });

  it("goes pending → added, and only then enables Edit Widget", async () => {
    const pending = deferred();
    const onWidgetDraft = vi.fn(() => pending.promise);
    const onEditWidget = vi.fn();
    render(tree(draft({ live: true }), { onWidgetDraft, onEditWidget }));

    expect(await screen.findByText("Adding to your view…")).toBeInTheDocument();
    const edit = screen.getByRole("button", { name: /Edit Widget/ });
    expect(edit).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Add to view/ })).not.toBeInTheDocument();

    await act(async () => pending.resolve({ status: "added", widgetId: "w-42" }));

    expect(screen.getByText("Added to your view — not saved yet")).toBeInTheDocument();
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    expect(onEditWidget).toHaveBeenCalledWith("w-42");
  });

  it("says 'Updated' for a replacement", async () => {
    const onWidgetDraft = vi.fn(() => Promise.resolve<WidgetDraftAck>({ status: "replaced", widgetId: "w-1" }));
    render(tree(draft({ live: true, replaceWidgetId: "w-1" }), { onWidgetDraft }));
    expect(await screen.findByText("Updated in your view — not saved yet")).toBeInTheDocument();
    expect(onWidgetDraft.mock.calls[0]).toEqual([
      expect.objectContaining({ replaceWidgetId: "w-1" }),
    ]);
  });

  it("hides Edit Widget when the host has no editor", async () => {
    const onWidgetDraft = vi.fn(() => Promise.resolve<WidgetDraftAck>({ status: "added", widgetId: "w-1" }));
    render(tree(draft({ live: true }), { onWidgetDraft }));
    await screen.findByText("Added to your view — not saved yet");
    expect(screen.queryByRole("button", { name: /Edit Widget/ })).not.toBeInTheDocument();
  });

  it("explains a rejection and offers a retry", async () => {
    const onWidgetDraft = vi
      .fn<(d: AskWidgetDraft) => Promise<WidgetDraftAck>>()
      .mockResolvedValueOnce({ status: "rejected", reason: "not_in_builder" })
      .mockResolvedValueOnce({ status: "added", widgetId: "w-9" });
    render(tree(draft({ live: true }), { onWidgetDraft, onEditWidget: vi.fn() }));

    expect(await screen.findByText("Open the dashboard builder to add this widget")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit Widget/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add to view/ }));
    expect(await screen.findByText("Added to your view — not saved yet")).toBeInTheDocument();
    expect(onWidgetDraft).toHaveBeenCalledTimes(2);
  });

  it("treats a host that throws or rejects as a rejection, not a spinner", async () => {
    const onWidgetDraft = vi.fn(() => Promise.reject(new Error("boom")));
    render(tree(draft({ live: true }), { onWidgetDraft }));
    expect(await screen.findByText("Couldn't add this widget to your view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add to view/ })).toBeInTheDocument();
  });

  it("reopened from history, never inserts by itself — it offers Add to view", async () => {
    const onWidgetDraft = vi.fn(() => Promise.resolve<WidgetDraftAck>({ status: "added", widgetId: "w-1" }));
    render(tree(draft(), { onWidgetDraft }));

    // Give any effect every chance to fire.
    await act(async () => {});
    expect(onWidgetDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add to view/ }));
    expect(await screen.findByText("Added to your view — not saved yet")).toBeInTheDocument();
    expect(onWidgetDraft).toHaveBeenCalledTimes(1);
  });

  it("never acts on an unusable part", async () => {
    const onWidgetDraft = vi.fn();
    render(tree(draft({ draftId: "", live: true }), { onWidgetDraft }));
    await act(async () => {});
    expect(onWidgetDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
