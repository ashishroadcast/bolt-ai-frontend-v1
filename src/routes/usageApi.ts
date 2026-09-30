import { gatewayClient } from "../api/client.ts";

/** `app.api.usage.ModelUsage`. */
export interface ModelUsage {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
}

/** `app.api.usage.OrganisationUsage` — one organisation's agent runs in the period. */
export interface OrganisationUsage {
  organisation_id: string;
  name: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
  document_cost_usd: number;
  last_run_at: string | null;
  models: ModelUsage[];
}

export interface UsageTotals {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
  document_cost_usd: number;
}

/** `app.api.usage.UsageReport` — `GET /agent/usage`. */
export interface UsageReport {
  since: string;
  until: string;
  organisations: OrganisationUsage[];
  totals: UsageTotals;
  /** USD per 1,000,000 [input, output] tokens, for models the service has a list price for. */
  known_prices: Record<string, [number, number]>;
  /** The organisation tree's shared rates, USD per 1,000,000 tokens. */
  rates: Record<string, { input: number; output: number }>;
  rates_updated_at: string | null;
  /** Only someone acting as the root organisation changes the shared rates. */
  can_edit_rates: boolean;
}

/** `PUT /agent/usage/rates` — replaces the tree's whole set of rates. */
export function saveUsageRates(
  rates: Record<string, { input: number; output: number }>,
): Promise<{ rates: Record<string, { input: number; output: number }>; updated_at: string | null }> {
  return gatewayClient.agentFetch(`/agent/usage/rates`, { method: "PUT", body: JSON.stringify({ rates }) });
}

/** `GET /agent/usage?from=…&to=…` — `[from, to)`, in the caller's own subtree. */
export function getUsage(from: Date, to: Date): Promise<UsageReport> {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return gatewayClient.agentFetch<UsageReport>(`/agent/usage?${query.toString()}`);
}
