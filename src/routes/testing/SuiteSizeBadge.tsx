import { Pill } from "./Pill.tsx";
import { isThinSuite, MIN_SUITE_SIZE } from "./suite.ts";

interface SuiteSizeBadgeProps {
  activeCount: number;
}

/**
 * Suite size, legible at a glance, everywhere a suite is shown — not only
 * at the moment a promotion is refused (task brief: "the screen should
 * make suite size legible at a glance rather than only at the moment a
 * promotion is refused"). Amber below the gate's own floor
 * (`app.learning.gate._MINIMUM_SUITE_SIZE`), neutral at or above it — the
 * same colour role the mockup's "held"/"neutral" pills already carry, read
 * here as "needs attention" vs "informational" rather than the mockup's
 * own "candidate not yet promoted" meaning for "held".
 */
export function SuiteSizeBadge({ activeCount }: SuiteSizeBadgeProps) {
  const thin = isThinSuite(activeCount);
  return (
    <Pill tone={thin ? "held" : "neutral"}>
      {activeCount} active{thin ? ` · below ${MIN_SUITE_SIZE}` : ""}
    </Pill>
  );
}
