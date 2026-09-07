import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewTestCaseForm } from "./NewTestCaseForm.tsx";

describe("NewTestCaseForm", () => {
  it("submits the route-resolved agent id, phase and typed fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewTestCaseForm agentId={3} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "plan" } });
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "top items last week" } });
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "Chicken Biryani leads" } });
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        agent_id: 3,
        phase: "plan",
        question: "top items last week",
        expected: "Chicken Biryani leads",
        is_active: true,
      });
    });
  });

  it("surfaces a duplicate-case rejection without losing what was typed", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("a test case for this agent, phase and question already exists"));
    render(<NewTestCaseForm agentId={3} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "top items last week" } });
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "Chicken Biryani leads" } });
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("already exists");
    });
    expect(screen.getByLabelText("Question")).toHaveValue("top items last week");
  });

  // Correctness bar for the move: this form used to carry its own agent
  // picker (a tenant with more than one agent chose explicitly). Now that
  // it only ever renders inside one agent's own Test suites tab, the
  // agent comes from the route — proving the field is gone, not merely
  // hidden or reduced to a single disabled option.
  it("has no agent field — the agent comes from the route, not a picker in this form", () => {
    render(<NewTestCaseForm agentId={3} onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /agent/i })).not.toBeInTheDocument();
  });

  it("submits with just phase and question filled in — a two-field form, not three", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewTestCaseForm agentId={7} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "q" } });
    fireEvent.change(screen.getByLabelText("Expected"), { target: { value: "e" } });
    expect(screen.getByRole("button", { name: "Add case" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 7 }));
    });
  });
});
