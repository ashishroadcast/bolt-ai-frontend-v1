import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TestCaseList } from "./TestCaseList.tsx";
import type { AgentTestCase } from "./types.ts";

function testCase(overrides: Partial<AgentTestCase>): AgentTestCase {
  return {
    id: 1,
    agent_id: 1,
    phase: "execute",
    question: "top items last week at Bandra",
    expected: "Chicken Biryani leads, sourced from fact_order_items",
    is_active: true,
    last_score: null,
    last_verdict: null,
    last_actual: null,
    last_reasoning: null,
    last_ran_at: null,
    last_prompt_version: null,
    last_tools_used: null,
    last_duration_ms: null,
    last_usage: null,
    trace_id: null,
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    ...overrides,
  };
}

describe("TestCaseList", () => {
  // The correctness bar this test exists to prove: a case the judge failed
  // still shows *why* — the reasoning is the only defence against a judge
  // that passes a fabrication (Phase 7's own calibration found exactly
  // that), so it must be reachable on the failing case, not only the
  // passing one, and not hidden behind a click.
  it("surfaces last_reasoning on a failing case, unprompted", () => {
    const failing = testCase({
      id: 7,
      last_verdict: "fail",
      last_score: 0.15,
      last_reasoning:
        "[judged by openrouter/z-ai/glm-5.2] The answer invents a store closure that never appears in the returned rows.",
    });

    render(
      <TestCaseList
        title="execute"
        subLabel="1 case"
        cases={[failing]}
        onRun={() => {}}
        onDelete={() => {}}
        runningId={null}
        runErrors={{}}
      />,
    );

    expect(screen.getByText("FAIL")).toBeInTheDocument();
    expect(
      screen.getByText(/invents a store closure that never appears in the returned rows/),
    ).toBeInTheDocument();
  });

  it("labels a never-run case distinctly from a graded one", () => {
    render(
      <TestCaseList
        title="execute"
        subLabel="1 case"
        cases={[testCase({ id: 9 })]}
        onRun={() => {}}
        onDelete={() => {}}
        runningId={null}
        runErrors={{}}
      />,
    );

    expect(screen.getByText("Never run.")).toBeInTheDocument();
    expect(screen.queryByText("FAIL")).not.toBeInTheDocument();
    expect(screen.queryByText("PASS")).not.toBeInTheDocument();
  });

  it("calls onRun with the case id when Run is clicked", () => {
    const onRun = vi.fn();
    render(
      <TestCaseList
        title="execute"
        subLabel="1 case"
        cases={[testCase({ id: 42 })]}
        onRun={onRun}
        onDelete={() => {}}
        runningId={null}
        runErrors={{}}
      />,
    );

    screen.getByRole("button", { name: "Run" }).click();
    expect(onRun).toHaveBeenCalledWith(42);
  });

  it("shows a run-time config error distinctly from a graded fail", () => {
    render(
      <TestCaseList
        title="execute"
        subLabel="1 case"
        cases={[testCase({ id: 5 })]}
        onRun={() => {}}
        onDelete={() => {}}
        runningId={null}
        runErrors={{ 5: "judge model 'openrouter/x' is the same as the answer model" }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("judge model");
    // A config-defect error is not a graded verdict — no pill either way.
    expect(screen.queryByText("FAIL")).not.toBeInTheDocument();
  });

  it("renders an honest empty state for a phase with no cases", () => {
    render(
      <TestCaseList
        title="guardrail"
        subLabel="0 cases"
        cases={[]}
        onRun={() => {}}
        onDelete={() => {}}
        runningId={null}
        runErrors={{}}
      />,
    );

    expect(screen.getByText("No cases yet for this phase.")).toBeInTheDocument();
  });
});
