import { ChevronDown, ChevronRight, Database, ListChecks, Play, ScrollText, Search, ShieldCheck, Wrench } from "lucide-react";
import { useId, useState, type ReactElement } from "react";
import type { RunStep, StepIcon } from "./runTrace.ts";
import styles from "./ReasoningCard.module.css";

const STEP_ICONS: Record<StepIcon, typeof Search> = {
  research: Search,
  plan: ListChecks,
  cached: ScrollText,
  execute: Play,
  validate: ShieldCheck,
  sql: Database,
  tool: Wrench,
};

/**
 * A run's own trace, read as part of the answer — the single biggest
 * difference between this console's answer surface and the one Saurabh
 * compared it against. It sits inline, above the answer, and not in a
 * margin: the reasoning is what makes an analytics answer trustworthy,
 * and a fact stranded in a 150px side column reads as decoration.
 *
 * Every row is one thing the run actually did, in the order it did it.
 * Nothing here is derived, inferred or averaged — `runTrace.ts` builds
 * these steps from `data-phase` and tool parts verbatim, so a row can
 * only ever say something the stream said.
 *
 * **Collapsed vs expanded, and why it opens by default while streaming.**
 * A live run's steps *are* the progress indicator — collapsing them would
 * leave a spinner and nothing else — so a run in flight opens expanded;
 * a finished one still opens expanded, because the whole complaint being
 * answered here is that the reasoning was invisible. The toggle exists so
 * a long thread can be read as prose once the reasoning has been checked.
 *
 * Semantic state is carried by form as well as colour (tokens.css rule
 * 2): a cached step gets its own icon and the literal word "cached", and
 * a judged step's chip spells out `score 0.72` rather than only turning
 * green or amber.
 */
export interface ReasoningCardProps {
  steps: RunStep[];
  /** Who answered. Named on the card because the card is the first thing
   * in the answer — "when we chat who are we chatting with". `null` when
   * the run's own record does not name one; the pill is then omitted
   * rather than filled from whichever agent is selected right now. */
  agentName: string | null;
  /** True while the run is still streaming: adds the live pill and keeps
   * the last row reading as in-progress rather than complete. */
  isStreaming?: boolean;
  /** Opens the shell inspector on a phase row. Omitted for a finished run
   * whose phase segments are no longer selectable. */
  onSelectPhase?: (phase: string) => void;
  selectedPhase?: string | null;
}

export function ReasoningCard({
  steps,
  agentName,
  isStreaming = false,
  onSelectPhase,
  selectedPhase,
}: ReasoningCardProps): ReactElement | null {
  const [isOpen, setIsOpen] = useState(true);
  const bodyId = useId();

  // Nothing observed yet — an empty bordered box would read as a broken
  // card rather than as "no steps", so there is simply no card until the
  // first phase or tool part lands.
  if (steps.length === 0) return null;

  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={bodyId}
      >
        {isOpen ? (
          <ChevronDown size={13} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} strokeWidth={2.25} aria-hidden="true" />
        )}
        <span className={styles.headLabel}>
          Reasoning · {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        {agentName !== null && <span className={styles.agent}>{agentName}</span>}
        {isStreaming && (
          <span className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            running
          </span>
        )}
      </button>

      {isOpen && (
        <ol id={bodyId} className={styles.list} aria-label="Reasoning steps">
          {steps.map((step) => {
            const Icon = STEP_ICONS[step.icon];
            const isSelected = step.phase !== null && step.phase === selectedPhase;
            const isSelectable = step.phase !== null && onSelectPhase !== undefined;
            return (
              <li key={step.key}>
                <div
                  className={`${styles.step} ${isSelected ? styles.selected : ""}`}
                  // A phase row opens the inspector; a tool row has
                  // nothing behind it to inspect, so it stays inert
                  // rather than offering a click that does nothing.
                  role={isSelectable ? "button" : undefined}
                  tabIndex={isSelectable ? 0 : undefined}
                  onClick={isSelectable ? () => onSelectPhase(step.phase!) : undefined}
                  onKeyDown={
                    isSelectable
                      ? (event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          onSelectPhase(step.phase!);
                        }
                      : undefined
                  }
                >
                  <span className={styles.icon} data-tone={step.tone} aria-hidden="true">
                    <Icon size={12} strokeWidth={2.25} />
                  </span>
                  <span className={styles.label}>{step.label}</span>
                  {step.chip !== null && (
                    <span className={styles.chip} data-tone={step.tone}>
                      {step.chip}
                    </span>
                  )}
                  {step.measure !== null && <span className={styles.measure}>{step.measure}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
