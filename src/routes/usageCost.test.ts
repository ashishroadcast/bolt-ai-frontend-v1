import { afterEach, describe, expect, it } from "vitest";
import type { ModelUsage } from "./usageApi.ts";
import { clearLocalRates, estimate, formatTokens, formatUsd, loadLocalRates, rateFor } from "./usageCost.ts";

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

  it("reads rates a browser saved before they were shared, and forgets them after", () => {
    localStorage.setItem("bolty.usage.rates.v1", JSON.stringify({ a: { input: 1, output: 2 }, b: { input: "x" }, c: null }));
    expect(loadLocalRates()).toEqual({ a: { input: 1, output: 2 } });
    clearLocalRates();
    expect(loadLocalRates()).toEqual({});
  });

  it("writes tokens as k and M", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(866_174)).toBe("866.2k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(10_683_800)).toBe("10.7M");
  });

  it("shows small amounts to four places", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});
