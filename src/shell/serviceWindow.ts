/**
 * Where "now" sits inside a restaurant's service day.
 *
 * A store's business day is not midnight to midnight — it runs from till
 * open to till close, regularly past 02:00, and every report in this
 * estate is bounded by that window rather than by the calendar. It is the
 * single most load-bearing fact in the domain and the console rendered it
 * as the words "Business day 28 Aug". This module is the arithmetic behind
 * making it a real object on screen.
 *
 * **This is a schedule, not a measurement.** The window and the peak below
 * are when this business trades, the same way a clock face is a fact about
 * time rather than a reading of anything. Nothing here is derived from
 * order volume, and the strip must never be captioned as if it were —
 * there is no traffic endpoint, and drawing a fake one would be worse than
 * drawing nothing.
 */

/** Service opens at 10:00 and runs to 02:00 the following morning. */
export const OPEN_HOUR = 10;
export const CLOSE_HOUR = 2;

/** The dinner peak, shaded on the strip. */
export const PEAK_START_HOUR = 19;
export const PEAK_END_HOUR = 22;

/** Hours from open to close, crossing midnight. */
const WINDOW_HOURS = 24 - OPEN_HOUR + CLOSE_HOUR;

export interface ServicePosition {
  /** 0–1 across the window, or null when the tills are shut. */
  progress: number | null;
  /** Peak band, as fractions of the window. */
  peakStart: number;
  peakEnd: number;
  /** True between close and open — the hours nobody is trading. */
  isClosed: boolean;
}

function fractionOf(hour: number, minute: number): number {
  // Hours after open, wrapping past midnight: 23:30 is 13.5h into a day
  // that opened at 10:00, and 01:00 is 15h in — not -9h.
  const hoursIn = (hour - OPEN_HOUR + 24) % 24 + minute / 60;
  return hoursIn / WINDOW_HOURS;
}

/**
 * `date` is passed in rather than read from the clock here so this stays
 * a pure function — the component owns "what time is it", this owns "what
 * does that time mean".
 */
export function servicePosition(date: Date): ServicePosition {
  const hour = date.getHours();
  const minute = date.getMinutes();

  // Closed is the gap between close and open: 02:00 up to 10:00.
  const isClosed = hour >= CLOSE_HOUR && hour < OPEN_HOUR;

  return {
    progress: isClosed ? null : Math.min(1, Math.max(0, fractionOf(hour, minute))),
    peakStart: fractionOf(PEAK_START_HOUR, 0),
    peakEnd: fractionOf(PEAK_END_HOUR, 0),
    isClosed,
  };
}
