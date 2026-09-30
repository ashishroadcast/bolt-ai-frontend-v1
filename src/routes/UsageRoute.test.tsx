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
  rates: {},
  rates_updated_at: null,
  can_edit_rates: true,
  inr_per_usd: 96,
  inr_per_usd_saved: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("UsageRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let urls: URL[];
  let report: UsageReport;
  let puts: { rates: unknown; inr_per_usd?: number }[];

  beforeEach(() => {
    urls = [];
    puts = [];
    report = REPORT;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = new URL(request.url);
      urls.push(url);
      if (url.pathname.endsWith("/agent/usage/rates") && request.method === "PUT") {
        const body = (await request.json()) as { rates: unknown; inr_per_usd?: number };
        puts.push(body);
        const fx = body.inr_per_usd ?? report.inr_per_usd;
        return jsonResponse({ rates: body.rates, updated_at: "2026-09-30T12:00:00Z", inr_per_usd: fx, inr_per_usd_saved: body.inr_per_usd !== undefined });
      }
      return url.pathname.endsWith("/agent/usage") ? jsonResponse(report) : jsonResponse({ detail: "unhandled" }, 500);
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
    expect(within(rows[0]).getByText("2.5M")).toBeTruthy();
    expect(within(rows[0]).getByTitle("25,00,000 tokens")).toBeTruthy();
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

  it("turns a rupee rate into an estimated cost in rupees", async () => {
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    expect(screen.getByTestId("usage-estimate").textContent).toBe("₹0.00");
    fireEvent.change(screen.getByLabelText("Input rate for cc/claude-sonnet-4-6"), { target: { value: "288" } });
    fireEvent.change(screen.getByLabelText("Output rate for cc/claude-sonnet-4-6"), { target: { value: "1440" } });
    // (2,001,000 × ₹288 + 500,200 × ₹1,440) / 1M
    await waitFor(() => expect(screen.getByTestId("usage-estimate").textContent).toBe("₹1,296.58"));
  });

  it("prices a model at its list price, converted, until a rate is saved", async () => {
    report = { ...REPORT, known_prices: { "cc/claude-sonnet-4-6": [3, 15] } };
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    expect((screen.getByLabelText("Input rate for cc/claude-sonnet-4-6") as HTMLInputElement).value).toBe("288");
    expect(screen.getByText("List price $3.00 in · $15.00 out")).toBeTruthy();
    expect(screen.getByTestId("usage-estimate").textContent).toBe("₹1,296.58");
    expect(screen.getByTestId("usage-fx-note").textContent).toContain("the service's default");
  });

  it("re-prices everything at a new exchange rate and saves it with the rates", async () => {
    report = { ...REPORT, rates: { "cc/claude-sonnet-4-6": { input: 3, output: 15 } } };
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    fireEvent.change(screen.getByLabelText("Rupees per US dollar"), { target: { value: "100" } });
    expect((screen.getByLabelText("Input rate for cc/claude-sonnet-4-6") as HTMLInputElement).value).toBe("300");
    expect(screen.getByTestId("usage-estimate").textContent).toBe("₹1,350.60");
    fireEvent.click(screen.getByTestId("usage-save-rates"));
    await waitFor(() => expect(puts).toEqual([{ rates: { "cc/claude-sonnet-4-6": { input: 3, output: 15 } }, inr_per_usd: 100 }]));
    expect(await screen.findByText(/Everyone in your organisation now sees these rates/)).toBeTruthy();
    expect(screen.getByTestId("usage-fx-note").textContent).not.toContain("default");
  });

  it("saves rates to the server for everyone", async () => {
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    const save = screen.getByTestId("usage-save-rates") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Input rate for cc/claude-sonnet-4-6"), { target: { value: "288" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    // Kept in dollars, and the unchanged default exchange rate is not saved as the tree's own.
    await waitFor(() => expect(puts).toEqual([{ rates: { "cc/claude-sonnet-4-6": { input: 3, output: 0 } } }]));
    expect(await screen.findByText(/Everyone in your organisation now sees these rates/)).toBeTruthy();
    expect(save.disabled).toBe(true);
  });

  it("shows shared rates read-only to someone who cannot change them", async () => {
    report = { ...REPORT, rates: { "cc/claude-sonnet-4-6": { input: 3, output: 15 } }, can_edit_rates: false };
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    const input = screen.getByLabelText("Input rate for cc/claude-sonnet-4-6") as HTMLInputElement;
    expect(input.value).toBe("288");
    expect(input.readOnly).toBe(true);
    expect((screen.getByLabelText("Rupees per US dollar") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByTestId("usage-save-rates")).toBeNull();
    expect(screen.getByTestId("usage-estimate").textContent).toBe("₹1,296.58");
  });

  it("offers rates this browser saved before, when the server has none", async () => {
    localStorage.setItem("bolty.usage.rates.v1", JSON.stringify({ "cc/claude-sonnet-4-6": { input: 3, output: 15 } }));
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    expect(screen.getByText(/saved in this browser before rates were shared/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("usage-save-rates"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(localStorage.getItem("bolty.usage.rates.v1")).toBeNull();
  });

  it("filters organisations by name", async () => {
    renderUsage();
    await screen.findAllByTestId("usage-org-row");
    fireEvent.change(screen.getByLabelText("Organisation"), { target: { value: "tuticorin" } });
    expect(screen.getAllByTestId("usage-org-row")).toHaveLength(1);
  });

  it("exports one line per organisation and model, in rupees and dollars", () => {
    const csv = usageCsv(REPORT, { "cc/claude-sonnet-4-6": { input: 3, output: 15 } }, 96).split("\n");
    expect(csv[0]).toContain("Organisation,Organisation ID,Model");
    expect(csv[0]).toContain("Estimated cost (INR),Estimated cost (USD)");
    expect(csv[1]).toBe("DP World Mundra,org-a,cc/claude-sonnet-4-6,6,2000000,500000,2500000,1296.00,13.5000");
  });

  it("makes a custom range end at the end of its last day", () => {
    const range = periodRange("custom", new Date(), "2026-09-01", "2026-09-15")!;
    expect(range.to.getDate()).toBe(16);
    expect(periodRange("custom", new Date(), "2026-09-15", "2026-09-01")).toBeNull();
  });
});
