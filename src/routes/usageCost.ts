import type { ModelUsage } from "./usageApi.ts";

/**
 * The arithmetic behind the Usage screen's cost columns, kept out of the
 * component so it can be tested without mounting one — the same split as
 * `ModelsRoute.pricing.ts`.
 *
 * **Why rates are entered here at all.** The agent service records a cost only
 * when the provider priced the call, and the Claude models prod runs on
 * (through the omniroute gateway) come back unpriced — recorded cost is $0 for
 * most runs. Costing needs a rate per model; the root organisation's admin
 * enters it once (`PUT /agent/usage/rates`) and everyone's estimate follows.
 */

/** USD per 1,000,000 tokens. */
export interface Rate {
  input: number;
  output: number;
}

export type Rates = Record<string, Rate>;

/** Where rates lived before they were shared on the server; read once, to carry them over. */
const RATES_KEY = "bolty.usage.rates.v1";

/** Rates this browser saved before they moved to the server, or `{}`. */
export function loadLocalRates(): Rates {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Rates = {};
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rate = value as Partial<Rate> | null;
      if (rate && Number.isFinite(rate.input) && Number.isFinite(rate.output)) {
        out[model] = { input: Number(rate.input), output: Number(rate.output) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Forgets the browser copy once the server holds the rates. */
export function clearLocalRates(): void {
  try {
    localStorage.removeItem(RATES_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** A saved rate, else the service's own list price for the model, else none. */
export function rateFor(model: string, rates: Rates, known: Record<string, [number, number]>): Rate | null {
  const saved = rates[model];
  if (saved) return saved;
  const price = known[model];
  return price ? { input: price[0], output: price[1] } : null;
}

export interface Estimate {
  usd: number;
  /** Tokens of calls with no rate and no provider price — the estimate leaves them out. */
  unratedTokens: number;
}

/**
 * A rate, when there is one, prices all of a model's tokens — the operator's
 * number wins over a partial provider price. Without one, whatever the provider
 * priced is counted and the unpriced calls' tokens are reported as unrated.
 */
export function estimate(models: ModelUsage[], rates: Rates, known: Record<string, [number, number]>): Estimate {
  let usd = 0;
  let unratedTokens = 0;
  for (const model of models) {
    const rate = rateFor(model.model, rates, known);
    if (rate && (rate.input > 0 || rate.output > 0)) {
      usd += (model.input_tokens * rate.input + model.output_tokens * rate.output) / 1_000_000;
      continue;
    }
    usd += model.cost_usd;
    if (model.unpriced_calls > 0) unratedTokens += model.input_tokens + model.output_tokens;
  }
  return { usd, unratedTokens };
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd)}`;
}

/** Runs, calls, organisations — plain counts, grouped the Indian way. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

/**
 * Tokens as k (thousands) and M (millions): 866.2k, 10.7M. One decimal, dropped
 * when it is zero; a value that would round up to 1000k is shown as 1M.
 */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const short = (value: number, unit: string) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}${unit}`;
  if (abs < 1000) return String(n);
  if (abs < 999_950) return short(n / 1000, "k");
  return short(n / 1_000_000, "M");
}

/** The exact figure, for a tooltip beside a shortened one. */
export function exactTokens(n: number): string {
  return `${new Intl.NumberFormat("en-IN").format(n)} tokens`;
}
