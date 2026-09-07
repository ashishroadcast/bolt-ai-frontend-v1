import { ChevronLeft, ChevronRight, MousePointerClick } from "lucide-react";
import type { ReactNode } from "react";
import type { PhaseDetail, PhaseSegment } from "../chat/phaseTimeline.ts";
import { useInspector } from "./InspectorContext.tsx";
import styles from "./Inspector.module.css";

const BODY_ID = "inspector-body";

function formatMeasure(segment: PhaseSegment): string {
  if (segment.score !== undefined) return segment.score.toFixed(2);
  return `${(segment.durationMs / 1000).toFixed(1)}s`;
}

function formatTokenCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

/**
 * What clicking a phase in the run rail actually opens (task brief:
 * "Clicking a phase opens the inspector with that phase's detail").
 * Shows what the phase actually produced: what research found, the steps
 * plan wrote, the SQL execute really ran, and the judge's verdict and
 * objections.
 *
 * All of that used to be replaced by a note reading "the query, plan gate
 * and judge reasoning for this phase aren't wired up yet". That was true
 * when it was written and stopped being true once `pipeline._phase_event`
 * started sending them — so the panel went on claiming the data did not
 * exist while it was arriving on every run. A phase that genuinely
 * produced nothing still says so; the difference is that it is now a fact
 * about that run rather than about the console.
 */
function SelectedPhase({ segment }: { segment: PhaseSegment }) {
  return (
    <div>
      <h2 className={styles.selectionTitle}>{segment.phase}</h2>
      <dl className={styles.kv}>
        <div>
          <dt>{segment.score !== undefined ? "score" : "duration"}</dt>
          <dd className={segment.score !== undefined ? styles.good : undefined}>{formatMeasure(segment)}</dd>
        </div>
        {segment.state !== undefined && (
          <div>
            <dt>state</dt>
            <dd>{segment.state}</dd>
          </div>
        )}
        {segment.tokens !== undefined && (
          <div>
            <dt>tokens</dt>
            <dd>{formatTokenCount(segment.tokens)}</dd>
          </div>
        )}
      </dl>
      {segment.detail === undefined ? (
        <p className={styles.note}>
          {segment.inferred
            ? "Timed from the phases around it — this run has no dedicated execute event."
            : "This phase reported nothing beyond its timing."}
        </p>
      ) : (
        <PhaseDetailView detail={segment.detail} />
      )}
    </div>
  );
}

/** One labelled block. `pre` for anything the reader may want to copy
 *  verbatim — SQL especially, which must not be re-wrapped into something
 *  that no longer runs. */
function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>{label}</h3>
      {children}
    </section>
  );
}

function PhaseDetailView({ detail }: { detail: PhaseDetail }) {
  return (
    <div className={styles.detail}>
      {detail.findings !== undefined && (
        <Block label="What it found">
          <p className={styles.prose}>{detail.findings}</p>
        </Block>
      )}

      {detail.plan !== undefined && (
        <Block label="The plan">
          {/* Numbered, because a plan is a sequence — step two only makes
              sense after step one. */}
          <ol className={styles.steps}>
            {detail.plan.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </Block>
      )}

      {detail.rationale !== undefined && (
        <Block label="Why">
          <p className={styles.prose}>{detail.rationale}</p>
        </Block>
      )}

      {detail.sql !== undefined && (
        <Block label="The query that ran">
          {/* The scoped, clamped statement actually executed — not the
              model's draft. See PhaseContext.sql_run. */}
          <pre className={styles.code}>{detail.sql}</pre>
          {detail.sqlParams !== undefined && Object.keys(detail.sqlParams).length > 0 && (
            <dl className={styles.kv}>
              {Object.entries(detail.sqlParams).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </Block>
      )}

      {detail.verdict !== undefined && (
        <Block label="Verdict">
          <p className={styles.prose}>{detail.verdict}</p>
        </Block>
      )}

      {detail.reasoning !== undefined && (
        <Block label="The judge's reasoning">
          <p className={styles.prose}>{detail.reasoning}</p>
        </Block>
      )}

      {detail.issues !== undefined && (
        <Block label="Issues raised">
          {/* Amber, and labelled: an objection the judge raised is the one
              thing on this panel an operator may need to act on. */}
          <p className={styles.issues}>{detail.issues}</p>
        </Block>
      )}
    </div>
  );
}

export function Inspector() {
  const { isOpen, toggle, selection } = useInspector();

  return (
    <aside className={styles.inspector} data-state={isOpen ? "open" : "closed"} aria-label="Inspector">
      <div className={styles.header}>
        <span className={styles.title}>Inspecting</span>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={isOpen}
          aria-controls={BODY_ID}
          aria-label={isOpen ? "Close inspector" : "Open inspector"}
          onClick={toggle}
        >
          {isOpen ? <ChevronRight size={14} strokeWidth={2.25} /> : <ChevronLeft size={14} strokeWidth={2.25} />}
        </button>
      </div>
      <div id={BODY_ID} className={styles.body}>
        {selection === null ? (
          <div className={styles.invite}>
            <span className={styles.inviteIcon} aria-hidden="true">
              <MousePointerClick size={18} strokeWidth={2} />
            </span>
            <p>
              <strong>Nothing selected</strong>
              Click a phase in an answer's run rail, or a result on the page, to see its query, plan
              gate and judge verdict here.
            </p>
          </div>
        ) : (
          <SelectedPhase segment={selection} />
        )}
      </div>
    </aside>
  );
}
