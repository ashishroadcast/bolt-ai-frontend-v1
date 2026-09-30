import { afterEach, describe, expect, it } from "vitest";
import type { ModelUsage } from "./usageApi.ts";
import { estimate, formatUsd, loadRates, rateFor, saveRates } from "./usageCost.ts";

const sonnet: ModelUsage = { model: "cc/claude-sonnet-4-6", calls: 3, input_tokens: 2_000_000, output_tokens: 500_000, cost_usd: 0, unpriced_calls: 3 };
const qwen: ModelUsage = { model: "qwen/qwen3-coder", calls: 1, input_tokens: 1_000_000, output_tokens: 1_000_000, cost_usd: 0.5, unpriced_calls: 0 };

describe("usage cost", () => {
  afterEach(() => localStorage.clear());

  it("prices a model's tokens at the operator's rate", () => {
    const result = estimate([sonnet], { [sonnet.model]: { input: 3, output: 15 } }, {});
    expect(result.usd).toBeCloseTo(2 * 3 + 0.5 * 15);
    expect(result.unratedTokens).toBe(0);
  });

  it("counts what the provider priced, and reports unpriced tokens with no rate", () => {
    const result = estimate([sonnet, qwen], {}, {});
    expect(result.usd).toBeCloseTo(0.5);
    expect(result.unratedTokens).toBe(2_500_000);
  });

  it("falls back to the service's list price, and a saved rate beats it", () => {
    const known = { [qwen.model]: [0.3, 1] as [number, number] };
    expect(rateFor(qwen.model, {}, known)).toEqual({ input: 0.3, output: 1 });
    expect(estimate([qwen], {}, known).usd).toBeCloseTo(1.3);
    expect(estimate([qwen], { [qwen.model]: { input: 1, output: 1 } }, known).usd).toBeCloseTo(2);
  });

  it("keeps rates across visits and ignores anything malformed", () => {
    saveRates({ a: { input: 1, output: 2 } });
    expect(loadRates()).toEqual({ a: { input: 1, output: 2 } });
    localStorage.setItem("bolty.usage.rates.v1", JSON.stringify({ a: { input: "x" }, b: null }));
    expect(loadRates()).toEqual({});
  });

  it("shows small amounts to four places", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});
