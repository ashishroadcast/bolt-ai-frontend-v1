import { ChevronLeft, ChevronRight, MousePointerClick } from "lucide-react";
import type { ReactNode } from "react";
import type { PhaseDetail, PhaseSegment } from "../ask/chat/phaseTimeline.ts";
import { useInspector } from "./InspectorContext.tsx";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BODY_ID = "inspector-body";

const KV =
  "font-mono text-[11px] tabular-nums [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-2.5 [&>div]:border-b [&>div]:py-1 [&>div:last-child]:border-b-0 [&_dt]:text-muted-foreground [&_dd]:m-0";
const PROSE = "m-0 text-xs leading-relaxed text-muted-foreground";

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
      <h2 className="mb-4 text-lg font-semibold tracking-tight">{segment.phase}</h2>
      <dl className={KV}>
        <div>
          <dt>{segment.score !== undefined ? "score" : "duration"}</dt>
          <dd className={segment.score !== undefined ? "font-medium text-success" : undefined}>{formatMeasure(segment)}</dd>
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
        <p className="mt-2 text-xs text-muted-foreground">
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
    <section className="min-w-0">
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</h3>
      {children}
    </section>
  );
}

function PhaseDetailView({ detail }: { detail: PhaseDetail }) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      {detail.findings !== undefined && (
        <Block label="What it found">
          <p className={PROSE}>{detail.findings}</p>
        </Block>
      )}

      {detail.plan !== undefined && (
        <Block label="The plan">
          {/* Numbered, because a plan is a sequence — step two only makes
              sense after step one. */}
          <ol className={cn(PROSE, "list-decimal space-y-1 pl-4")}>
            {detail.plan.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </Block>
      )}

      {detail.rationale !== undefined && (
        <Block label="Why">
          <p className={PROSE}>{detail.rationale}</p>
        </Block>
      )}

      {detail.sql !== undefined && (
        <Block label="The query that ran">
          {/* The scoped, clamped statement actually executed — not the
              model's draft. See PhaseContext.sql_run. */}
          <pre className="rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">{detail.sql}</pre>
          {detail.sqlParams !== undefined && Object.keys(detail.sqlParams).length > 0 && (
            <dl className={KV}>
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
          <p className={PROSE}>{detail.verdict}</p>
        </Block>
      )}

      {detail.reasoning !== undefined && (
        <Block label="The judge's reasoning">
          <p className={PROSE}>{detail.reasoning}</p>
        </Block>
      )}

      {detail.issues !== undefined && (
        <Block label="Issues raised">
          {/* Amber, and labelled: an objection the judge raised is the one
              thing on this panel an operator may need to act on. */}
          <p className="border-l-2 border-warning bg-warning-soft px-2.5 py-2 text-xs leading-relaxed text-foreground">{detail.issues}</p>
        </Block>
      )}
    </div>
  );
}

export function Inspector() {
  const { isOpen, toggle, selection } = useInspector();
  const empty = selection === null;

  return (
    <aside
      className={cn(
        "group/inspector flex min-w-0 shrink-0 flex-col overflow-hidden border-t bg-card md:border-t-0 md:border-l",
        "max-md:max-h-[40vh]",
        isOpen ? "md:w-80" : "md:w-11",
      )}
      data-state={isOpen ? "open" : "closed"}
      data-empty={empty ? "true" : undefined}
      aria-label="Inspector"
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3",
          !isOpen && "md:justify-center md:px-0",
        )}
      >
        <span
          className={cn(
            "truncate text-[11px] font-medium tracking-wider text-muted-foreground uppercase",
            !isOpen && "md:hidden",
          )}
        >
          Inspecting
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-expanded={isOpen}
          aria-controls={BODY_ID}
          aria-label={isOpen ? "Close inspector" : "Open inspector"}
          onClick={toggle}
        >
          {isOpen ? (
            <ChevronRight className="max-md:rotate-90" aria-hidden="true" />
          ) : (
            <ChevronLeft className="max-md:-rotate-90" aria-hidden="true" />
          )}
        </Button>
      </div>
      <div
        id={BODY_ID}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto p-4",
          !isOpen && "md:hidden",
          // On a phone the panel sits under the screen: until something is
          // selected it is only its header bar, not half the viewport.
          empty && "max-md:hidden",
        )}
      >
        {empty ? (
          <div className="flex max-w-[34ch] flex-col items-start gap-2 text-xs text-muted-foreground">
            <span
              className="inline-flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary"
              aria-hidden="true"
            >
              <MousePointerClick className="size-4" />
            </span>
            <p className="m-0">
              <strong className="mb-1.5 block text-sm font-semibold text-foreground">Nothing selected</strong>
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
