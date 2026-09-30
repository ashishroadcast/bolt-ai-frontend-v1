import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { UsageRoute, periodRange, usageCsv } from "./UsageRoute.tsx";
import type { UsageReport } from "./usageApi.ts";

const REPORT: UsageReport = {
  since: "2026-09-01T00:00:00Z",
  until: "2026-09-30T10:00:00Z",
  organisations: [
    {
      organisation_id: "org-a",
      name: "DP World Mundra",
      runs: 4,
      input_tokens: 2_000_000,
      output_tokens: 500_000,
      total_tokens: 2_500_000,
      cost_usd: 0,
      unpriced_calls: 6,
      document_cost_usd: 0,
      last_run_at: "2026-09-30T09:00:00Z",
      models: [{ model: "cc/claude-sonnet-4-6", calls: 6, input_tokens: 2_000_000, output_tokens: 500_000, cost_usd: 0, unpriced_calls: 6 }],
    },
    {
      organisation_id: "org-b",
      name: "Dp World Tuticorin",
      runs: 1,
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      cost_usd: 0,
      unpriced_calls: 1,
      document_cost_usd: 0,
      last_run_at: "2026-09-29T09:00:00Z",
      models: [{ model: "cc/claude-sonnet-4-6", calls: 1, input_tokens: 1000, output_tokens: 200, cost_usd: 0, unpriced_calls: 1 }],
    },
  ],
  totals: { runs: 5, input_tokens: 2_001_000, output_tokens: 500_200, total_tokens: 2_501_200, cost_usd: 0, unpriced_calls: 7, document_cost_usd: 0 },
  known_prices: {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("UsageRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let urls: URL[];

  beforeEach(() => {
    urls = [];
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL((input as Request).url);
      urls.push(url);
      return Promise.resolve(url.pathname.endsWith("/agent/usage") ? jsonResponse(REPORT) : jsonResponse({ detail: "unhandled" }, 500));
    });
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  function renderUsage() {
    return render(
      <MemoryRouter initialEntries={["/usage"]}>
        <UsageRoute />
      </MemoryRouter>,
    );
  }

  it("lists organisations by name with their tokens, this month by default", async () => {
    renderUsage();
    const rows = await screen.findAllByTestId("usage-org-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("DP World Mundra")).toBeTruthy();
    expect(within(rows[0]).getByText("25,00,000")).toBeTruthy();
    const from = new Date(urls[0].searchParams.get("from")!);
    expect(from.getDate()).toBe(1);
  });

  it("opens an organisation into its models", async () => {
    renderUsage();
    const rows = await screen.findAllByTestId("usage-org-row");
    fireEvent.click(rows[0]);
    const models = screen.getAllByTestId("usage-model-row");
    expect(models).toHaveLength(1);
    expect(within(models[0]).getByText("cc/claude-sonnet-4-6")).toBeTruthy();
  });

  it("turns a rate into an estimated cost", async () => {
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    expect(screen.getByTestId("usage-estimate").textContent).toBe("$0.00");
    fireEvent.change(screen.getByLabelText("Input rate for cc/claude-sonnet-4-6"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Output rate for cc/claude-sonnet-4-6"), { target: { value: "15" } });
    // (2,001,000 × $3 + 500,200 × $15) / 1M
    await waitFor(() => expect(screen.getByTestId("usage-estimate").textContent).toBe("$13.51"));
  });

  it("filters organisations by name", async () => {
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    fireEvent.change(screen.getByLabelText("Organisation"), { target: { value: "tuticorin" } });
    expect(screen.getAllByTestId("usage-org-row")).toHaveLength(1);
  });

  it("exports one line per organisation and model", () => {
    const csv = usageCsv(REPORT, { "cc/claude-sonnet-4-6": { input: 3, output: 15 } }).split("\n");
    expect(csv[0]).toContain("Organisation,Organisation ID,Model");
    expect(csv[1]).toBe("DP World Mundra,org-a,cc/claude-sonnet-4-6,6,2000000,500000,2500000,13.5000");
  });

  it("makes a custom range end at the end of its last day", () => {
    const range = periodRange("custom", new Date(), "2026-09-01", "2026-09-15")!;
    expect(range.to.getDate()).toBe(16);
    expect(periodRange("custom", new Date(), "2026-09-15", "2026-09-01")).toBeNull();
  });
});
