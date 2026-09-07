import type { ReactNode } from "react";
import { classifyGateReason } from "./refusal.ts";
import { MIN_SUITE_SIZE } from "./suite.ts";
import type { RegressedCaseDetail } from "./types.ts";
import styles from "./RefusalPanel.module.css";

interface RefusalPanelProps {
  reason: string;
  regressedCases: RegressedCaseDetail[];
  onOverride?: () => void;
  overriding?: boolean;
}

/**
 * Renders `gate_promotion`'s refusal as one of four distinguishable
 * states — "'write more test cases', 'your judge is broken' and 'this
 * candidate is worse' are three different problems with three different
 * next actions. A single 'Promotion blocked' is a failure of this
 * screen" (task brief). Two of the four share the "write more cases"
 * family (empty vs. thin) but still get their own heading, glyph and
 * body copy, because "no cases exist" and "N cases exist but that's not
 * enough" call for slightly different next actions.
 */
export function RefusalPanel({ reason, regressedCases, onOverride, overriding }: RefusalPanelProps) {
  const kind = classifyGateReason(reason);

  switch (kind) {
    case "empty-suite":
      return (
        <Panel tone="warning" glyph="○" heading="No cases to evaluate" reason={reason}>
          <p className={styles.nextAction}>
            This phase has no active test cases at all. Write at least {MIN_SUITE_SIZE} before
            attempting a promotion — the gate has nothing to compare the candidate against.
          </p>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "thin-suite":
      return (
        <Panel tone="warning" glyph="◐" heading="Write more test cases" reason={reason}>
          <p className={styles.nextAction}>
            Fewer than {MIN_SUITE_SIZE} active cases flake on judge non-determinism — a single
            fabrication or one noisy re-run can decide the whole verdict. Add more cases for this
            phase, or override with a reason if you're accepting that risk.
          </p>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "judge-broken":
      return (
        <Panel tone="critical" glyph="⚠" heading="Your judge is broken" reason={reason}>
          <p className={styles.nextAction}>
            Every baseline case errored — this isn't evidence the candidate is safe, it's evidence
            nothing was graded. Check the judge model binding
            (<code>agent.llm_bindings[&quot;judge&quot;]</code>) or the tenant&apos;s LLM
            configuration before retrying.
          </p>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "regressed":
      return (
        <Panel tone="critical" glyph="✕" heading="This candidate is worse" reason={reason}>
          {regressedCases.length > 0 && (
            <ul className={styles.regressedList}>
              {regressedCases.map((change) => (
                <li key={change.test_case_id} className={styles.regressedItem}>
                  <span className={styles.regressedId}>#{change.test_case_id}</span>
                  <span>{change.question}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.nextAction}>
            These cases passed at the current production version and failed at the candidate.
            Fix the prompt and re-tune, or override with a reason to promote anyway.
          </p>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    default:
      // Fallback for a reason string this classifier doesn't recognise —
      // see refusal.ts's own comment. Still names the exact reason rather
      // than hiding it behind "Promotion blocked".
      return (
        <Panel tone="critical" glyph="?" heading="Promotion blocked" reason={reason}>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
  }
}

function OverrideButton({ onOverride, overriding }: { onOverride?: () => void; overriding?: boolean }) {
  if (onOverride === undefined) return null;
  return (
    <button type="button" className={styles.override} onClick={onOverride} disabled={overriding}>
      {overriding ? "Overriding…" : "Override and promote anyway"}
    </button>
  );
}

interface PanelProps {
  tone: "warning" | "critical";
  glyph: string;
  heading: string;
  reason: string;
  children?: ReactNode;
}

function Panel({ tone, glyph, heading, reason, children }: PanelProps) {
  return (
    <div className={styles.panel} data-tone={tone} role="alert">
      <span className={styles.glyph} aria-hidden="true">
        {glyph}
      </span>
      <div className={styles.body}>
        <p className={styles.heading}>{heading}</p>
        <p className={styles.reason}>{reason}</p>
        {children}
      </div>
    </div>
  );
}
