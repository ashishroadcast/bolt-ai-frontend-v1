import { CircleAlert, LoaderCircle, Play, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "./Pill.tsx";
import { SuiteSizeBadge } from "./SuiteSizeBadge.tsx";
import { activeCases } from "./suite.ts";
import type { AgentTestCase } from "./types.ts";

interface TestCaseListProps {
  title: string;
  subLabel: string;
  cases: AgentTestCase[];
  onRun: (id: number) => void;
  onDelete: (id: number) => void;
  runningId: number | null;
  /** A run that hit a 422 config defect (JudgeModelNotDistinctError,
   * NoDefaultLLMConfig) rather than producing a graded row — see
   * TestsTab's own comment for why that's kept separate from
   * last_verdict/last_reasoning instead of overwriting them. */
  runErrors: Record<number, string>;
}

function verdictPill(testCase: AgentTestCase) {
  if (testCase.last_verdict === null) return null;
  return <Pill tone={testCase.last_verdict === "pass" ? "pass" : "fail"}>{testCase.last_verdict.toUpperCase()}</Pill>;
}

/** The small uppercase run-in label ("Expected", "Judge") that leads a
 * case's secondary lines. */
const RUN_IN_LABEL = "mr-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase";

/**
 * One phase's authored cases, as a card whose header carries the phase's
 * suite size (`SuiteSizeBadge`, counted from these same cases) so it is
 * legible up front, not only at the moment a promotion is refused.
 *
 * Every case that has been graded shows its judge reasoning inline, never
 * behind an extra click — a passing verdict is evidence, not proof, and
 * the reasoning is the only way an operator actually checks it (task
 * brief: "last_reasoning exists so a person can read why the judge passed
 * something, and it should be reachable, not buried").
 */
export function TestCaseList({ title, subLabel, cases, onRun, onDelete, runningId, runErrors }: TestCaseListProps) {
  return (
    <section className="min-w-0">
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4 [.border-b]:pb-4">
          <h3 className="leading-none font-semibold capitalize">{title}</h3>
          <CardDescription>{subLabel}</CardDescription>
          <CardAction>
            <SuiteSizeBadge activeCount={activeCases(cases).length} />
          </CardAction>
        </CardHeader>

        {cases.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted-foreground">No cases yet for this phase.</p>
        ) : (
          <ul className="divide-y">
            {cases.map((testCase) => {
              const running = runningId === testCase.id;
              return (
                <li key={testCase.id} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start sm:gap-6">
                  <div className="grid min-w-0 flex-1 gap-2">
                    <span
                      className={cn(
                        "text-sm font-medium break-words",
                        !testCase.is_active && "text-muted-foreground line-through",
                      )}
                    >
                      {testCase.question}
                    </span>

                    <p className="text-sm break-words text-muted-foreground">
                      <b className={RUN_IN_LABEL}>Expected</b> {testCase.expected}
                    </p>

                    {testCase.last_reasoning !== null ? (
                      <p className="rounded-md bg-muted px-3 py-2 text-sm leading-relaxed break-words">
                        <b className={RUN_IN_LABEL}>Judge</b>
                        {testCase.last_reasoning}
                      </p>
                    ) : (
                      <span className="text-xs text-muted-foreground">Never run.</span>
                    )}

                    {runErrors[testCase.id] !== undefined && (
                      <Alert variant="destructive" className="py-2">
                        <CircleAlert />
                        <AlertDescription>{runErrors[testCase.id]}</AlertDescription>
                      </Alert>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                    {(testCase.last_score !== null || testCase.last_verdict !== null) && (
                      <span className="flex items-center gap-2">
                        {testCase.last_score !== null && (
                          <span className="font-mono text-xs text-muted-foreground tabular-nums">
                            {testCase.last_score.toFixed(2)}
                          </span>
                        )}
                        {verdictPill(testCase)}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRun(testCase.id)}
                        disabled={running}
                      >
                        {running ? <LoaderCircle className="animate-spin" /> : <Play />}
                        {running ? "Running…" : "Run"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDelete(testCase.id)}
                      >
                        <Trash2 />
                        Delete
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}
