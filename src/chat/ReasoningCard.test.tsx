import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReasoningCard } from "./ReasoningCard.tsx";
import type { RunStep } from "./runTrace.ts";

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    key: "phase-0-research",
    icon: "research",
    label: "Researched the question",
    chip: null,
    tone: "neutral",
    measure: "0.4s",
    phase: "research",
    ...overrides,
  };
}

describe("ReasoningCard", () => {
  it("reads as sentences about what the run did, not as a list of phase names", () => {
    render(
      <ReasoningCard
        agentName="Sales-Analyst"
        steps={[
          step(),
          step({ key: "b", label: "Reused the cached plan", chip: "cached", tone: "cached", icon: "cached" }),
          step({ key: "c", label: "Called run_sql", icon: "sql", phase: null, measure: null }),
        ]}
      />,
    );

    expect(screen.getByText("Researched the question")).toBeInTheDocument();
    expect(screen.getByText("Reused the cached plan")).toBeInTheDocument();
    expect(screen.getByText("Called run_sql")).toBeInTheDocument();
    // Never the bare pipeline vocabulary the old rail showed.
    expect(screen.queryByText("research")).not.toBeInTheDocument();
  });

  it("counts its own steps in the header", () => {
    render(<ReasoningCard agentName="Sales-Analyst" steps={[step(), step({ key: "b" })]} />);
    expect(screen.getByText("Reasoning · 2 steps")).toBeInTheDocument();
  });

  it("says one step, not 1 steps", () => {
    render(<ReasoningCard agentName="Sales-Analyst" steps={[step()]} />);
    expect(screen.getByText("Reasoning · 1 step")).toBeInTheDocument();
  });

  it("names the agent on the card, so an answer says who produced it", () => {
    render(<ReasoningCard agentName="Sales-Analyst" steps={[step()]} />);
    expect(screen.getByText("Sales-Analyst")).toBeInTheDocument();
  });

  it("names no agent rather than guessing when the run does not name one", () => {
    render(<ReasoningCard agentName={null} steps={[step()]} />);
    expect(screen.getByText("Reasoning · 1 step")).toBeInTheDocument();
    expect(screen.queryByText("Sales-Analyst")).not.toBeInTheDocument();
  });

  it("opens expanded and collapses on click, keeping the header readable either way", () => {
    render(<ReasoningCard agentName="Sales-Analyst" steps={[step()]} />);

    const toggle = screen.getByRole("button", { expanded: true });
    expect(screen.getByRole("list", { name: "Reasoning steps" })).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.queryByRole("list", { name: "Reasoning steps" })).not.toBeInTheDocument();
    expect(screen.getByText("Reasoning · 1 step")).toBeInTheDocument();
  });

  it("shows a live marker only while the run is still streaming", () => {
    const { rerender } = render(<ReasoningCard agentName="A" steps={[step()]} isStreaming />);
    expect(screen.getByText("running")).toBeInTheDocument();

    rerender(<ReasoningCard agentName="A" steps={[step()]} />);
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  it("renders nothing at all before the first step lands, rather than an empty box", () => {
    const { container } = render(<ReasoningCard agentName="Sales-Analyst" steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the inspector from a phase row, and offers no click on a tool row", () => {
    const onSelectPhase = vi.fn();
    render(
      <ReasoningCard
        agentName="A"
        steps={[step(), step({ key: "tool", label: "Called run_sql", phase: null })]}
        onSelectPhase={onSelectPhase}
      />,
    );

    const clickable = screen.getAllByRole("button").filter((node) => node.textContent?.includes("Researched"));
    expect(clickable).toHaveLength(1);
    fireEvent.click(clickable[0]!);
    expect(onSelectPhase).toHaveBeenCalledWith("research");

    // The tool row has nothing behind it to inspect, so it is not a button.
    expect(screen.getAllByRole("button").some((node) => node.textContent?.includes("Called run_sql"))).toBe(false);
  });

  it("carries a judged step's state in words as well as colour", () => {
    render(
      <ReasoningCard
        agentName="A"
        steps={[step({ key: "v", label: "Validated the answer", chip: "score 0.42", tone: "weak", icon: "validate" })]}
      />,
    );
    expect(screen.getByText("score 0.42")).toBeInTheDocument();
  });
});
