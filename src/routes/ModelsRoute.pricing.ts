/**
 * Turning OpenRouter's per-token prices into the per-million figure every
 * model comparison is actually quoted in.
 *
 * Kept out of `ModelsRoute.tsx` for the same reason `agents/
 * orchestratorMode.ts` and `shell/serviceWindow.ts` are separate from
 * their consumers: this is the one piece of real arithmetic on the screen,
 * and it is worth testing without mounting a component.
 */

/** USD per token -> USD per 1,000,000 tokens. */
const PER_MILLION_PLACES = 6;

/** Beyond this, a per-million price is rounded for display. */
const DISPLAY_DECIMALS = 3;

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Moves a decimal string's point `places` to the right, exactly, and
 * always returns plain notation. `null` when `value` is not a number.
 *
 * String arithmetic rather than `Number(value) * 1e6` because both ends of
 * that round-trip are lossy in ways that matter here. `pricing.prompt`
 * arrives as a decimal string precisely so it can carry a value like
 * `2.7e-7` intact, and `Number(x).toString()` hands back exponent notation
 * for anything below 1e-6 — so a genuinely cheap model would render in a
 * price column as "1e-7", which is not a price anyone reads. Shifting the
 * digits sidesteps binary floating point altogether: no representation
 * error, no exponent, and `"0.0000001"` stays `"0.1"`.
 */
export function shiftDecimalRight(value: string, places: number): string | null {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (match === null) return null;

  const [, sign, intPart, fracPart, expPart] = match;
  const whole = intPart ?? "";
  const fraction = fracPart ?? "";
  // Every group in the pattern is optional, so "", "  " and "." all reach
  // here having matched. This is the only rejection of a blank price.
  if (whole === "" && fraction === "") return null;

  let digits = whole + fraction;
  // Where the point lands in `digits` once shifted. An exponent in the
  // input is just more shift.
  let pointIndex = whole.length + places + (expPart === undefined ? 0 : Number(expPart));

  if (pointIndex < 1) {
    digits = "0".repeat(1 - pointIndex) + digits;
    pointIndex = 1;
  }
  if (pointIndex > digits.length) {
    digits += "0".repeat(pointIndex - digits.length);
  }

  const intOut = digits.slice(0, pointIndex).replace(/^0+(?=\d)/, "");
  const fracOut = digits.slice(pointIndex).replace(/0+$/, "");
  const magnitude = fracOut === "" ? intOut : `${intOut}.${fracOut}`;
  // "-0" is a price nobody quotes.
  if (sign === "-" && Number(magnitude) !== 0) return `-${magnitude}`;
  return magnitude;
}

/**
 * The exact per-million price as a decimal string, or `null` when there
 * isn't one to show.
 *
 * `null` covers two real cases the catalogue contains. A model may simply
 * omit the key. And `openrouter/auto` and friends price at `"-1"`, which
 * is OpenRouter's sentinel for "depends on whichever model this routes to"
 * — a negative price is not a cheaper price, so it must never sort to the
 * top of the column.
 */
export function perMillionPrice(perToken: string | null | undefined): string | null {
  if (perToken === null || perToken === undefined) return null;
  const shifted = shiftDecimalRight(perToken, PER_MILLION_PLACES);
  if (shifted === null || shifted.startsWith("-")) return null;
  return shifted;
}

/**
 * The per-million price as a table cell: at least two decimals so a column
 * of them reads as money, at most three so 380 rows stay scannable.
 *
 * The one exception is a price too small to survive that rounding. Showing
 * "0.000" for a model that does cost something would read as free, so a
 * value below the rounding floor keeps its exact digits instead — the
 * column is a little ragged there, and correct.
 */
export function formatPerMillion(perToken: string | null | undefined): string | null {
  const exact = perMillionPrice(perToken);
  if (exact === null) return null;

  const dot = exact.indexOf(".");
  const decimals = dot === -1 ? 0 : exact.length - dot - 1;
  if (decimals === 0) return `${exact}.00`;
  if (decimals === 1) return `${exact}0`;
  if (decimals <= DISPLAY_DECIMALS) return exact;

  const rounded = Number(exact).toFixed(DISPLAY_DECIMALS);
  return Number(rounded) === 0 ? exact : rounded;
}

/**
 * The sort key for a price column. `null` prices — absent, or the `-1`
 * sentinel — have no place on the scale and are ordered last by the
 * caller regardless of direction, rather than being silently treated as
 * free.
 */
export function perMillionNumber(perToken: string | null | undefined): number | null {
  const exact = perMillionPrice(perToken);
  return exact === null ? null : Number(exact);
}

/**
 * The provider half of an OpenRouter model id — `"anthropic"` from
 * `"anthropic/claude-opus-5-fast"`.
 *
 * The leading `~` on the alias ids OpenRouter publishes alongside the
 * pinned ones (`~anthropic/claude-haiku-latest`) is dropped, so filtering
 * by Anthropic returns Anthropic's aliases too. The id itself is shown in
 * full in the row, tilde included, so nothing is hidden by this.
 */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  const provider = slash === -1 ? modelId : modelId.slice(0, slash);
  return provider.startsWith("~") ? provider.slice(1) : provider;
}

/** e.g. 1048576 -> "1M", 262144 -> "262K". A context window is compared by
 * order of magnitude, not by its exact digits. */
export function formatContext(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return null;
  }
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(millions < 10 ? 2 : 0))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
