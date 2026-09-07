import type { ReactNode } from "react";
import styles from "./Pill.module.css";

export type PillTone = "pass" | "held" | "fail" | "neutral";

interface PillProps {
  tone: PillTone;
  children: ReactNode;
}

/** The mockup's dot-plus-word state chip — see Pill.module.css for why the
 * dot exists at all. Shared by every pass/fail/held/count marker across
 * both screens rather than each one styling its own span. */
export function Pill({ tone, children }: PillProps) {
  return <span className={`${styles.pill} ${styles[tone]}`}>{children}</span>;
}
