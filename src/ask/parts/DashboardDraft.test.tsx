import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardDraft, type DashboardDraftProps } from "./DashboardDraft.tsx";
import { TestAskProvider } from "../testing.tsx";
import type { AskDashboardDraft } from "../config.tsx";

function draft(overrides: Partial<DashboardDraftProps> = {}): DashboardDraftProps {
  return {
    draftId: "d-1",
    name: "Operations Overview",
    description: "The fleet at a glance.",
    widgets: [
      {
        metricKey: "fleet.active_device_groups",
        visualization: "kpi",
        title: "Active Vehicles",
        size: "small",
        params: { timeRange: { preset: "last_7d" } },
      },
      { metricKey: "eta.trips_completed_daily", visualization: "line", size: "wide" },
      { metricKey: "fleet.device_status_breakdown", visualization: "donut" },
    ],
    ...overrides,
  };
}

function show(props: DashboardDraftProps, onDashboardDraft?: (d: AskDashboardDraft) => void) {
  return render(
    <TestAskProvider config={onDashboardDraft === undefined ? {} : { onDashboardDraft }}>
      <DashboardDraft {...props} />
    </TestAskProvider>,
  );
}

describe("DashboardDraft", () => {
  it("says the reader may not create dashboards instead of drawing a draft they cannot open", () => {
    render(
      <TestAskProvider config={{ draftAccess: { dashboard: false }, onDashboardDraft: vi.fn() }}>
        <DashboardDraft {...draft()} />
      </TestAskProvider>,
    );
    expect(screen.getByText("You can't create dashboards")).toBeInTheDocument();
    expect(screen.getByText(/doesn't include permission to create dashboards/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operations Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open in builder/ })).not.toBeInTheDocument();
  });

  it("shows the view's name, size and description", () => {
    show(draft());
    expect(screen.getByRole("heading", { name: "Operations Overview" })).toBeInTheDocument();
    expect(screen.getByText(/3 widgets/)).toBeInTheDocument();
    expect(screen.getByText("The fleet at a glance.")).toBeInTheDocument();
  });

  it("lists every widget with its style, time range and size", () => {
    show(draft());
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Active Vehicles");
    expect(rows[0]).toHaveTextContent("KPI · Last 7 days");
    expect(rows[0]).toHaveTextContent("Small");
    // No title from the AI: the catalog's name for the metric, and its
    // default time range, because absent means "the default".
    expect(rows[1]).toHaveTextContent("Trip Trend");
    expect(rows[1]).toHaveTextContent("Line chart · Last 30 days");
    expect(rows[1]).toHaveTextContent("Wide");
    // A live breakdown has no time range; no size hint → the metric default.
    expect(rows[2]).toHaveTextContent("Device Group Status");
    expect(rows[2]).toHaveTextContent("Doughnut chart");
    expect(rows[2]).toHaveTextContent("Default size");
  });

  it("draws the packed layout as a thumbnail, one cell per widget", () => {
    show(draft());
    const thumb = screen.getByRole("img", { name: /Layout preview: 3 widgets/ });
    const cells = thumb.querySelectorAll("span");
    expect(cells).toHaveLength(3);
    // small at (0,0) 3×2; wide beside it at (3,0), widened into the spare column;
    // the doughnut under both, alone in its row, widened to the full grid.
    expect((cells[0] as HTMLElement).style.gridColumn).toBe("1 / span 3");
    expect((cells[1] as HTMLElement).style.gridColumn).toBe("4 / span 9");
    expect((cells[2] as HTMLElement).style.gridRow).toBe("5 / span 4");
    expect((cells[2] as HTMLElement).style.gridColumn).toBe("1 / span 12");
  });

  it("draws no invented figures in the layout preview", () => {
    // The same 1,428 on every KPI tile read as the fleet's real total.
    show(draft());
    expect(screen.queryByText("1,428")).not.toBeInTheDocument();
    expect(screen.queryByText("+8.4%")).not.toBeInTheDocument();
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument();
  });

  it("renders read-only in a host with no dashboard builder", () => {
    show(draft());
    expect(screen.queryByRole("button", { name: /Open in builder/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Operations Overview" })).toBeInTheDocument();
  });

  it("hands the contract shape to the host when opened in the builder", () => {
    const onDashboardDraft = vi.fn();
    show(draft(), onDashboardDraft);

    fireEvent.click(screen.getByRole("button", { name: /Open in builder/ }));

    expect(onDashboardDraft).toHaveBeenCalledTimes(1);
    expect(onDashboardDraft).toHaveBeenCalledWith(draft());
    expect(screen.getByText("Nothing is saved until you save the view there.")).toBeInTheDocument();
  });

  it("leaves an absent description out of the handoff rather than sending an empty one", () => {
    const onDashboardDraft = vi.fn();
    show(draft({ description: undefined }), onDashboardDraft);
    fireEvent.click(screen.getByRole("button", { name: /Open in builder/ }));
    expect(Object.hasOwn(onDashboardDraft.mock.calls[0]![0] as object, "description")).toBe(false);
  });

  it("offers no builder for a draft with no readable widgets", () => {
    show(draft({ widgets: [] }), vi.fn());
    const card = screen.getByRole("region", { name: "Draft view: Operations Overview" });
    expect(within(card).getByText(/no widgets the assistant could read/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open in builder/ })).not.toBeInTheDocument();
  });
});
