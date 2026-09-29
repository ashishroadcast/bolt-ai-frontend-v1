import type { ReactNode } from "react";
import { ChartPie, CircleDashed, CircleHelp, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { classifyGateReason } from "./refusal.ts";
import { MIN_SUITE_SIZE } from "./suite.ts";
import type { RegressedCaseDetail } from "./types.ts";

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
 * family (empty vs. thin) but still get their own heading, icon and
 * body copy, because "no cases exist" and "N cases exist but that's not
 * enough" call for slightly different next actions.
 *
 * Colour is never the only channel a kind is told apart by (house rule:
 * "semantic state is carried by form as well as colour") — each kind has
 * its own icon, and the heading text differs per kind too, so even a
 * plain-text screen reader announcement of the heading alone already
 * distinguishes all four.
 */
export function RefusalPanel({ reason, regressedCases, onOverride, overriding }: RefusalPanelProps) {
  const kind = classifyGateReason(reason);

  switch (kind) {
    case "empty-suite":
      return (
        <Panel tone="warning" icon={CircleDashed} heading="No cases to evaluate" reason={reason}>
          <NextAction>
            This phase has no active test cases at all. Write at least {MIN_SUITE_SIZE} before
            attempting a promotion — the gate has nothing to compare the candidate against.
          </NextAction>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "thin-suite":
      return (
        <Panel tone="warning" icon={ChartPie} heading="Write more test cases" reason={reason}>
          <NextAction>
            Fewer than {MIN_SUITE_SIZE} active cases flake on judge non-determinism — a single
            fabrication or one noisy re-run can decide the whole verdict. Add more cases for this
            phase, or override with a reason if you're accepting that risk.
          </NextAction>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "judge-broken":
      return (
        <Panel tone="critical" icon={TriangleAlert} heading="Your judge is broken" reason={reason}>
          <NextAction>
            Every baseline case errored — this isn't evidence the candidate is safe, it's evidence
            nothing was graded. Check the judge model binding (
            <code className="rounded bg-background/70 px-1 py-0.5 font-mono text-xs text-foreground">
              agent.llm_bindings[&quot;judge&quot;]
            </code>
            ) or the tenant&apos;s LLM configuration before retrying.
          </NextAction>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    case "regressed":
      return (
        <Panel tone="critical" icon={CircleX} heading="This candidate is worse" reason={reason}>
          {regressedCases.length > 0 && (
            <ul className="divide-y divide-destructive/10 overflow-hidden rounded-md border border-destructive/15 bg-background/70">
              {regressedCases.map((change) => (
                <li key={change.test_case_id} className="flex items-baseline gap-2 px-3 py-1.5 text-sm text-foreground">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    #{change.test_case_id}
                  </span>
                  <span className="min-w-0 break-words">{change.question}</span>
                </li>
              ))}
            </ul>
          )}
          <NextAction>
            These cases passed at the current production version and failed at the candidate.
            Fix the prompt and re-tune, or override with a reason to promote anyway.
          </NextAction>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
    default:
      // Fallback for a reason string this classifier doesn't recognise —
      // see refusal.ts's own comment. Still names the exact reason rather
      // than hiding it behind "Promotion blocked".
      return (
        <Panel tone="critical" icon={CircleHelp} heading="Promotion blocked" reason={reason}>
          <OverrideButton onOverride={onOverride} overriding={overriding} />
        </Panel>
      );
  }
}

function NextAction({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function OverrideButton({ onOverride, overriding }: { onOverride?: () => void; overriding?: boolean }) {
  if (onOverride === undefined) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-fit border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
      onClick={onOverride}
      disabled={overriding}
    >
      {overriding && <LoaderCircle className="animate-spin" />}
      {overriding ? "Overriding…" : "Override and promote anyway"}
    </Button>
  );
}

interface PanelProps {
  tone: "warning" | "critical";
  icon: LucideIcon;
  heading: string;
  reason: string;
  children?: ReactNode;
}

function Panel({ tone, icon: Icon, heading, reason, children }: PanelProps) {
  return (
    // The Alert's own text colour is the tone, so its icon (which Alert
    // paints `currentColor`) carries it; the copy inside resets to the
    // readable foreground/muted colours.
    <Alert
      data-tone={tone}
      className={cn(
        tone === "warning"
          ? "border-warning/30 bg-warning-soft text-warning"
          : "border-destructive/30 bg-destructive/5 text-destructive",
      )}
    >
      <Icon />
      <div className="col-start-2 grid min-w-0 gap-2">
        {/* The heading is this panel's first <p> on purpose — it is what
            distinguishes the four kinds (see RefusalPanel.test.tsx). */}
        <p className="font-medium text-foreground">{heading}</p>
        <p className="font-mono text-xs leading-relaxed break-words text-muted-foreground">{reason}</p>
        {children}
      </div>
    </Alert>
  );
}
