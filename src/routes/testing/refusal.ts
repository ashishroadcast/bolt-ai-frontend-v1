/**
 * Classifies `GateVerdict.reason` (`agent-service/app/learning/gate.py`,
 * `gate_promotion`) into the four refusal shapes that function can
 * actually produce. "A single 'Promotion blocked' is a failure of this
 * screen" (task brief) — so this exists specifically to let RefusalPanel
 * render four different headings/next-actions instead of one generic one.
 *
 * Matched on a stable substring from each reason's fixed portion, never
 * the whole message (which always carries dynamic content — an agent id,
 * a phase, a case count, a list of case ids) and never the case-count
 * threshold itself (gate.py's own `_MINIMUM_SUITE_SIZE` could move without
 * this classifier caring what number it currently is):
 *
 *   - "nothing to evaluate"        -> zero active cases at all
 *   - "below the minimum of"       -> 1..(_MINIMUM_SUITE_SIZE - 1) active cases
 *   - "produced no usable signal"  -> baseline suite ran but every case errored
 *   - "case(s) regressed"          -> a real baseline-vs-candidate comparison ran
 *                                      and at least one case flipped pass -> fail
 *
 * `"unknown-refusal"` is the fallback for a reason string that matches
 * none of the four — a safety net for a wording change upstream, never
 * the thing an operator is meant to actually see in normal operation (the
 * four `classifyGateReason` tests below assert against gate.py's own
 * strings verbatim, so a real drift fails a test here first).
 */
export type GateRefusalKind = "empty-suite" | "thin-suite" | "judge-broken" | "regressed" | "unknown-refusal";

export function classifyGateReason(reason: string): GateRefusalKind {
  if (reason.includes("nothing to evaluate")) return "empty-suite";
  if (reason.includes("below the minimum of")) return "thin-suite";
  if (reason.includes("produced no usable signal")) return "judge-broken";
  if (reason.includes("case(s) regressed")) return "regressed";
  return "unknown-refusal";
}
