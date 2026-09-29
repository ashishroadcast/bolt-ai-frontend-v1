import { AlertCircle, ChevronDown, Terminal } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  getCodeExecution,
  listCodeExecutions,
  type CodeExecutionDetail,
  type CodeExecutionOutcome,
  type CodeExecutionSummary,
} from "./codeExecutionsApi.ts";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Every outcome the server can label, with the tone it deserves and the
 * sentence an operator needs. `ok` and `error` are the two that happen on a
 * normal day; the rest each mean the program never got to finish, and
 * saying which one is the whole reason the API returns a label rather than
 * leaving a bare `-3` on screen.
 */
const OUTCOMES: Record<CodeExecutionOutcome, { tone: StatusPillTone; label: string; note: string }> =
  {
    ok: { tone: "good", label: "ok", note: "The program ran and exited cleanly." },
    error: {
      tone: "critical",
      label: "error",
      note: "The program ran and exited nonzero — see stderr.",
    },
    timeout: {
      tone: "amber",
      label: "timeout",
      note: "Killed for exceeding the sandbox's wall-clock budget.",
    },
    killed: {
      tone: "critical",
      label: "killed",
      note: "Killed by the sandbox — out of memory, or stopped by a signal.",
    },
    unreachable: {
      tone: "critical",
      label: "unreachable",
      note: "sandbox-runner could not be reached; the program never ran.",
    },
    pending: {
      tone: "amber",
      label: "pending",
      note: "Recorded before the run finished, and never updated.",
    },
    refused: {
      tone: "amber",
      label: "refused",
      note: "An execution cap stopped this before the sandbox was asked.",
    },
    breaker_open: {
      tone: "amber",
      label: "breaker open",
      note: "The sandbox circuit breaker was open; the program never ran.",
    },
  };

const UNKNOWN_OUTCOME = {
  tone: "neutral" as StatusPillTone,
  label: "unknown",
  note: "The service returned an outcome this console does not know about.",
};

function describe(outcome: CodeExecutionOutcome) {
  return OUTCOMES[outcome] ?? UNKNOWN_OUTCOME;
}

/** One labelled box in an expanded row — the program, its two streams, and
 * what it wrote. */
function Pane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  );
}

/* Model-written code is unbounded and its lines are long. It scrolls inside
   its own box — both axes — rather than widening the table or the page. */
const PRE_CLASS =
  "m-0 max-h-80 overflow-auto rounded-md border bg-card px-3 py-2 font-mono text-xs leading-relaxed text-foreground [tab-size:4]";

interface RowState {
  loading: boolean;
  detail: CodeExecutionDetail | null;
  error: string | null;
}

const BLANK_ROW_STATE: RowState = { loading: false, detail: null, error: null };

/**
 * `GET /agent/code-executions` (list) and `GET /agent/code-executions/{id}`
 * (detail) — the answer to "where can I see if the agent did any code
 * execution", which had no screen at all: `code_executions` has had a
 * writer since Phase 4 and no reader anywhere, so a run that computed
 * something without also writing a file left nothing to look at.
 *
 * **Two calls, deliberately, and the second is on demand.** The list route
 * carries no `code`, `stdout` or `stderr` (`app.api.code_executions`'s own
 * docstring: output is truncated at 4000 characters *each* and `code` is
 * unbounded, so a full page would be megabytes nothing shows at once).
 * Expanding a row is what fetches them — the same two-step shape
 * `ArtifactsRoute` already uses to resolve a signed download.
 *
 * **No create, no delete.** An execution is a byproduct of a chat run and,
 * per `app.api.code_executions`, a security record — there is no write
 * route here to build a form against, and one that a caller could edit
 * would not be a record. The empty state points at Ask, the one place that
 * produces a row.
 */
export function CodeExecutionsRoute() {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const [executions, setExecutions] = useState<CodeExecutionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listCodeExecutions()
      .then((rows) => {
        if (!cancelled) setExecutions(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  async function handleToggle(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    // Fetched once per row and kept: the row is immutable — a finished
    // execution never changes — so re-fetching on every expand would be a
    // request that can only ever return the same bytes.
    if (rowState(id).detail !== null) return;
    patchRow(id, { loading: true, error: null });
    try {
      const detail = await getCodeExecution(id);
      patchRow(id, { loading: false, detail });
    } catch (err) {
      patchRow(id, { loading: false, error: errorMessage(err) });
    }
  }

  const rows = executions ?? [];

  return (
    <>
      <PageHeader
        kicker="Work"
        title="Code executions"
        description="Every program an agent ran in the sandbox to compute or reshape an answer — what it ran, what came back, and how long it took."
      />
      <div className="flex flex-col gap-6">
        {loadError !== null && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {loading && loadError === null && rows.length === 0 && (
          <Card aria-busy="true">
            <CardContent className="flex flex-col gap-3">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} aria-hidden="true" className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        )}

        {!loading && loadError === null && rows.length === 0 && (
          <EmptyState
            icon={Terminal}
            title="No code has run yet"
            body="When an agent with code execution turned on needs real arithmetic — a share, a rank, a week-over-week delta — it writes a small program and runs it in the sandbox. Every run lands here."
            actionLabel="Go to Ask"
            onAction={() => navigate("/ask")}
          />
        )}

        {rows.length > 0 && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <CardTitle>
                <h3>Code executions</h3>
              </CardTitle>
              <CardDescription className="tabular-nums">
                {rows.length} {rows.length === 1 ? "run" : "runs"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Outcome</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Conversation</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Took</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="pr-6">
                      <span className="sr-only">Details</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((execution) => {
                    const state = rowState(execution.id);
                    const isOpen = expanded === execution.id;
                    const outcome = describe(execution.outcome);
                    const agentName =
                      agentNameById.get(execution.agent_id) ?? `Agent #${execution.agent_id}`;
                    return (
                      <Fragment key={execution.id}>
                        <TableRow className={cn(isOpen && "border-b-0 bg-muted/50")}>
                          <TableCell className="py-3 pl-6 align-top">
                            <StatusPill tone={outcome.tone} label={outcome.label} />
                            {/* The raw exit code under the pill: the label is what an
                                operator reads, the number is what they quote in a bug
                                report. Both, never one. */}
                            <div className="mt-1 font-mono text-xs text-muted-foreground tabular-nums">
                              exit {execution.exit_status}
                            </div>
                          </TableCell>
                          <TableCell className="py-3 align-top">
                            <Link
                              to={`/agents/${execution.agent_id}`}
                              className="font-medium text-primary underline-offset-4 hover:underline"
                            >
                              {agentName}
                            </Link>
                          </TableCell>
                          <TableCell className="py-3 align-top font-mono text-muted-foreground tabular-nums">
                            #{execution.conversation_id}
                          </TableCell>
                          <TableCell className="py-3 align-top font-mono text-muted-foreground">
                            {execution.mode}
                          </TableCell>
                          <TableCell className="py-3 text-right align-top font-mono tabular-nums">
                            {formatDuration(execution.duration_ms)}
                          </TableCell>
                          <TableCell className="py-3 text-right align-top font-mono tabular-nums">
                            {execution.artifact_count}
                          </TableCell>
                          <TableCell className="py-3 align-top text-muted-foreground">
                            {formatWhen(execution.created_at)}
                          </TableCell>
                          <TableCell className="py-2 pr-6 text-right align-top">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-expanded={isOpen}
                              onClick={() => void handleToggle(execution.id)}
                            >
                              {isOpen ? "Hide code" : "Show code"}
                              <ChevronDown
                                aria-hidden="true"
                                className={cn("transition-transform", isOpen && "rotate-180")}
                              />
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/50 hover:bg-muted/50">
                            <TableCell colSpan={8} className="px-6 pt-1 pb-5 whitespace-normal">
                              {/* width 0 / min-width 100%: the panes fill the row but
                                  add nothing to the table's own width, so a long line
                                  of code scrolls inside its box instead of stretching
                                  every column above it. */}
                              <div className="flex w-0 min-w-full flex-col gap-3">
                                <p className="text-sm text-muted-foreground">{outcome.note}</p>
                                {state.loading && (
                                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Spinner aria-hidden="true" />
                                    Loading…
                                  </p>
                                )}
                                {state.error !== null && (
                                  <p className="text-sm text-destructive">{state.error}</p>
                                )}
                                {state.detail !== null && (
                                  // Two columns on a wide screen, one on a narrow one: code
                                  // and its output are read together, and stacking them on
                                  // a laptop would put the answer a scroll away from the
                                  // program that produced it.
                                  <div className="grid gap-4 lg:grid-cols-2">
                                    <Pane title="Code">
                                      <pre className={cn(PRE_CLASS, "whitespace-pre")} data-testid="execution-code">
                                        {state.detail.code}
                                      </pre>
                                    </Pane>
                                    <Pane title="stdout">
                                      <pre className={cn(PRE_CLASS, "break-words whitespace-pre-wrap")}>
                                        {state.detail.stdout ?? "(nothing written)"}
                                      </pre>
                                    </Pane>
                                    <Pane title="stderr">
                                      <pre
                                        className={cn(
                                          PRE_CLASS,
                                          "break-words whitespace-pre-wrap",
                                          state.detail.stderr !== null &&
                                            "border-destructive/30 bg-destructive/5 text-destructive",
                                        )}
                                      >
                                        {state.detail.stderr ?? "(nothing written)"}
                                      </pre>
                                    </Pane>
                                    <Pane title="Files produced">
                                      {state.detail.artifacts.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                          None — this run printed its answer rather than writing a
                                          file.
                                        </p>
                                      ) : (
                                        <ul className="flex flex-col gap-1.5 text-sm">
                                          {state.detail.artifacts.map((artifact) => (
                                            <li key={artifact.id} className="flex flex-wrap items-baseline gap-x-2">
                                              <Link
                                                to="/artifacts"
                                                className="font-medium text-primary underline-offset-4 hover:underline"
                                              >
                                                {artifact.filename}
                                              </Link>
                                              <span className="font-mono text-xs text-muted-foreground">
                                                {artifact.content_type}
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </Pane>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
