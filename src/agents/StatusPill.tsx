import { Badge } from "@/components/ui/badge";

export type StatusPillTone = "good" | "amber" | "critical" | "neutral";

const BADGE_VARIANT = {
  good: "success",
  amber: "warning",
  critical: "danger",
  neutral: "secondary",
} as const satisfies Record<StatusPillTone, string>;

interface StatusPillProps {
  tone: StatusPillTone;
  label: string;
}

/** A dot plus a word — never colour alone (task brief: "semantic state
 * carries form as well as colour"). Reused everywhere this console shows
 * an active/inactive, pass/fail or held state. */
export function StatusPill({ tone, label }: StatusPillProps) {
  return (
    <Badge variant={BADGE_VARIANT[tone]} data-tone={tone}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
