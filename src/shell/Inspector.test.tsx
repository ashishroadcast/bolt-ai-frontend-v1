import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PhaseSegment } from "../ask/chat/phaseTimeline.ts";
import { Inspector } from "./Inspector.tsx";
import { InspectorProvider, useInspector } from "./InspectorContext.tsx";

function renderInspector() {
  const inspectorRef: { current: ReturnType<typeof useInspector> | null } = { current: null };
  function Capture() {
    inspectorRef.current = useInspector();
    return null;
  }
  render(
    <InspectorProvider>
      <Capture />
      <Inspector />
    </InspectorProvider>,
  );
  return inspectorRef;
}

const executeSegment: PhaseSegment = {
  phase: "execute",
  startedAt: 1500,
  endedAt: 4900,
  durationMs: 3400,
  inferred: true,
};

const validateSegment: PhaseSegment = {
  phase: "validate",
  state: "done",
  startedAt: 4900,
  endedAt: 4900,
  durationMs: 0,
  score: 0.92,
  inferred: false,
};

describe("Inspector", () => {
  it("invites a selection when nothing has been clicked yet", () => {
    renderInspector();
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });

  it("opens on a clicked phase and shows its duration, state and an honest note for an inferred phase", () => {
    const inspectorRef = renderInspector();

    act(() => inspectorRef.current!.selectPhase(executeSegment));

    expect(screen.getByRole("heading", { name: "execute" })).toBeInTheDocument();
    expect(screen.getByText("3.4s")).toBeInTheDocument();
    expect(screen.getByText(/no dedicated execute event/)).toBeInTheDocument();
    // Opening on a selection is part of "clicking a phase opens the inspector".
    expect(screen.getByLabelText("Inspector")).toHaveAttribute("data-state", "open");
  });

  it("shows a score instead of a duration, plus state, for a judged phase", () => {
    const inspectorRef = renderInspector();

    act(() => inspectorRef.current!.selectPhase(validateSegment));

    expect(screen.getByRole("heading", { name: "validate" })).toBeInTheDocument();
    expect(screen.getByText("0.92")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.queryByText("0.0s")).not.toBeInTheDocument();
  });

  it("switches the selection when a different phase is clicked", () => {
    const inspectorRef = renderInspector();

    act(() => inspectorRef.current!.selectPhase(executeSegment));
    expect(screen.getByRole("heading", { name: "execute" })).toBeInTheDocument();

    act(() => inspectorRef.current!.selectPhase(validateSegment));
    expect(screen.getByRole("heading", { name: "validate" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "execute" })).not.toBeInTheDocument();
  });
});
