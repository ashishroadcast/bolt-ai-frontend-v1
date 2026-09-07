import { describe, expect, it } from "vitest";
import {
  formatContext,
  formatPerMillion,
  perMillionNumber,
  perMillionPrice,
  providerOf,
  shiftDecimalRight,
} from "./ModelsRoute.pricing.ts";

describe("shiftDecimalRight", () => {
  it("shifts a plain decimal exactly", () => {
    expect(shiftDecimalRight("0.00000027", 6)).toBe("0.27");
    expect(shiftDecimalRight("0.000000075", 6)).toBe("0.075");
    expect(shiftDecimalRight("0.00015", 6)).toBe("150");
    expect(shiftDecimalRight("0", 6)).toBe("0");
  });

  it("carries no trailing zeros the source happened to write", () => {
    expect(shiftDecimalRight("0.00000110", 6)).toBe("1.1");
    expect(shiftDecimalRight("1.500", 0)).toBe("1.5");
  });

  it("reads exponent notation on the way in and never writes it on the way out", () => {
    // 2.7e-7 USD per token is 0.27 per million — and OpenRouter is free to
    // send it in this form, since `pricing` is a JSON string field.
    expect(shiftDecimalRight("2.7e-7", 6)).toBe("0.27");
    expect(shiftDecimalRight("1e-13", 6)).toBe("0.0000001");
    expect(shiftDecimalRight("1E-13", 6)).toBe("0.0000001");
    // Small enough that the careless version writes an exponent into the
    // price column instead of a price.
    expect((Number("1e-13") * 1_000_000).toString()).toBe("1.0000000000000001e-7");
  });

  it("keeps a value exact where a float multiply would not", () => {
    expect(shiftDecimalRight("0.000000000005", 6)).toBe("0.000005");
    // What the careless version renders in the cell instead.
    expect((Number("0.000000000005") * 1_000_000).toString()).toBe("0.0000049999999999999996");
  });

  it("carries a sign, but not a signed zero", () => {
    expect(shiftDecimalRight("-1", 6)).toBe("-1000000");
    expect(shiftDecimalRight("-0.0", 6)).toBe("0");
  });

  it("rejects anything that is not a number", () => {
    expect(shiftDecimalRight("", 6)).toBeNull();
    expect(shiftDecimalRight("free", 6)).toBeNull();
    expect(shiftDecimalRight(".", 6)).toBeNull();
  });
});

describe("perMillionPrice", () => {
  it("is the per-token string shifted six places", () => {
    expect(perMillionPrice("0.000001")).toBe("1");
    expect(perMillionPrice("0.00001")).toBe("10");
  });

  it("has nothing to show for an absent price", () => {
    expect(perMillionPrice(null)).toBeNull();
    expect(perMillionPrice(undefined)).toBeNull();
    expect(perMillionPrice("  ")).toBeNull();
  });

  it("has nothing to show for OpenRouter's -1 'depends on the route' sentinel", () => {
    // openrouter/auto prices at "-1"; -1000000 per million is not cheap.
    expect(perMillionPrice("-1")).toBeNull();
  });
});

describe("formatPerMillion", () => {
  it("pads to two decimals so a column reads as money", () => {
    expect(formatPerMillion("0.00015")).toBe("150.00");
    expect(formatPerMillion("0.0000375")).toBe("37.50");
    expect(formatPerMillion("0")).toBe("0.00");
  });

  it("keeps three decimals without padding further", () => {
    expect(formatPerMillion("0.000000075")).toBe("0.075");
    expect(formatPerMillion("0.000000017")).toBe("0.017");
  });

  it("rounds anything longer to three decimals", () => {
    expect(formatPerMillion("0.000000088606")).toBe("0.089");
    expect(formatPerMillion("0.00000004815")).toBe("0.048");
  });

  it("shows a price too small to round rather than a row of zeros", () => {
    // 0.0000001 per million would round to "0.000" and read as free.
    expect(formatPerMillion("1e-13")).toBe("0.0000001");
  });

  it("has no cell to fill when there is no price", () => {
    expect(formatPerMillion(undefined)).toBeNull();
    expect(formatPerMillion("-1")).toBeNull();
  });
});

describe("perMillionNumber", () => {
  it("orders cheap below expensive", () => {
    expect(perMillionNumber("0.000000075")).toBeLessThan(perMillionNumber("0.00001")!);
  });

  it("refuses to rank a price it does not have", () => {
    expect(perMillionNumber("-1")).toBeNull();
    expect(perMillionNumber(null)).toBeNull();
  });
});

describe("providerOf", () => {
  it("is the half of the id before the slash", () => {
    expect(providerOf("anthropic/claude-opus-5-fast")).toBe("anthropic");
    expect(providerOf("z-ai/glm-5.3-flash")).toBe("z-ai");
  });

  it("files an alias id under the provider it belongs to", () => {
    expect(providerOf("~anthropic/claude-haiku-latest")).toBe("anthropic");
  });

  it("copes with an id that has no slash at all", () => {
    expect(providerOf("some-model")).toBe("some-model");
  });
});

describe("formatContext", () => {
  it("reads a window by order of magnitude", () => {
    expect(formatContext(1_048_576)).toBe("1.05M");
    expect(formatContext(2_000_000)).toBe("2M");
    expect(formatContext(262_144)).toBe("262K");
    expect(formatContext(8_192)).toBe("8K");
    expect(formatContext(512)).toBe("512");
  });

  it("has nothing to show for a missing window", () => {
    expect(formatContext(null)).toBeNull();
    expect(formatContext(undefined)).toBeNull();
    expect(formatContext(0)).toBeNull();
  });
});
