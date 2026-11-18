/**
 * How the element writes numbers, money and times — Whitelight (WFM) build.
 *
 * Upstream (bolt-v2) is India-first: `en-IN` grouping (12,34,567), rupees, and
 * every timestamp converted to IST. WFM users are in Oman, KSA and Jordan, so:
 *
 * - Numbers use Western grouping with Latin digits (`en-GB`: 1,234,567), which
 *   is also what WFM's own screens show, in English and in Arabic.
 * - Money carries no symbol. The backend does not say which currency a column
 *   is in (OMR, SAR and JOD differ by deployment), and no symbol is less wrong
 *   than the wrong one.
 * - Timestamps that carry an offset are shown in the reader's own zone (the
 *   browser's), labelled with its offset, e.g. "2026-11-18 09:00 GMT+4".
 *
 * Kept in one module so an upstream merge conflicts here and not at every call
 * site that formats a figure.
 */

export const DISPLAY_LOCALE = "en-GB";

export function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return new Intl.NumberFormat(DISPLAY_LOCALE, options);
}

const LOCAL_FORMATTER = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "shortOffset",
});

/** An offset-carrying timestamp in the reader's zone: "2026-11-18 09:00 GMT+4". */
export function formatLocalTimestamp(date: Date): string {
  const parts = LOCAL_FORMATTER.formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const zone = get("timeZoneName");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${zone ? ` ${zone}` : ""}`;
}
