import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type PillTone = "pass" | "held" | "fail" | "neutral";

interface PillProps {
  tone: PillTone;
  children: ReactNode;
}

const BADGE_VARIANT = {
  pass: "success",
  held: "warning",
  fail: "danger",
  neutral: "secondary",
} as const satisfies Record<PillTone, string>;

/**
 * The dot-plus-word state chip, shared by every pass/fail/held/count marker
 * across both screens rather than each one styling its own span.
 *
 * The dot is the whole point: "every state carries a dot and a word, so it
 * survives a screenshot, a colour-blind reader and a printed page". Colour
 * alone never carries pass/held/fail here — the text differs too
 * (PASS/HELD/FAILED), so neither channel is load-bearing on its own. A
 * neutral count is informational, not a state, so it carries no dot.
 */
export function Pill({ tone, children }: PillProps) {
  return (
    <Badge variant={BADGE_VARIANT[tone]} data-tone={tone}>
      {tone !== "neutral" && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </Badge>
  );
}
