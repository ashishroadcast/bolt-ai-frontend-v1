import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunDebug } from "./RunDebug.tsx";
import { EMPTY_TRACE, type RunTrace } from "./runTrace.ts";

const TRACE: RunTrace = {
  ...EMPTY_TRACE,
  tools: [
    { callId: "call_1", name: "find_schema", input: { query: "rpt_daily_sales" }, output: "Table-name convention…" },
    { callId: "call_2", name: "run_sql", input: { sql: "SELECT 1" }, output: "store_id | net_sales" },
  ],
  executedSql: "SELECT r.store_id FROM public.rpt_daily_sales AS r",
  executedSqlParams: { tenant_id: 3 },
  score: 0.82,
  reasoning: "Every figure in the answer appears in the evidence rows.",
};

describe("RunDebug", () => {
  it("shows the SQL that actually ran, separately from the one the model drafted", () => {
    render(<RunDebug trace={TRACE} />);

    expect(screen.getByText("SELECT 1")).toBeInTheDocument();
    expect(screen.getByText("SELECT r.store_id FROM public.rpt_daily_sales AS r")).toBeInTheDocument();
  });

  it("keeps a tool's result collapsed until it is asked for", () => {
    render(<RunDebug trace={TRACE} />);

    expect(screen.queryByText("store_id | net_sales")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Result" })[1]!);
    expect(screen.getByText("store_id | net_sales")).toBeInTheDocument();
  });

  it("renders a non-SQL tool argument as its own text, not as a JSON blob", () => {
    render(<RunDebug trace={TRACE} />);
    expect(screen.getByText("rpt_daily_sales")).toBeInTheDocument();
  });

  it("gives the judge's verdict in words and its reasoning in full", () => {
    render(<RunDebug trace={TRACE} />);

    expect(screen.getByText(/passed · 0\.82/)).toBeInTheDocument();
    expect(screen.getByText("Every figure in the answer appears in the evidence rows.")).toBeInTheDocument();
  });

  it("calls a below-bar score below bar, against the same 0.7 the service gates on", () => {
    render(<RunDebug trace={{ ...TRACE, score: 0.42 }} />);
    expect(screen.getByText(/below bar · 0\.42/)).toBeInTheDocument();
  });

  it("says plainly that the plan never reaches the console, rather than omitting the section", () => {
    render(<RunDebug trace={TRACE} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/plan steps never reach the console/)).toBeInTheDocument();
  });

  it("renders no validation or SQL section for a run that produced neither", () => {
    render(<RunDebug trace={EMPTY_TRACE} />);

    expect(screen.queryByText("Validation")).not.toBeInTheDocument();
    expect(screen.queryByText("SQL as run")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool calls")).not.toBeInTheDocument();
  });
});
