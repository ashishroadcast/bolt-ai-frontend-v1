import { Terminal } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import styles from "./CodeExecutionsRoute.module.css";

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
      <div className={styles.body}>
        {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

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
          <section className={styles.sheet}>
            <header className={styles.sheetHead}>
              <h3>Code executions</h3>
              <span className={styles.sub}>
                {rows.length} {rows.length === 1 ? "run" : "runs"}
              </span>
            </header>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Agent</th>
                    <th>Conversation</th>
                    <th>Mode</th>
                    <th className={styles.num}>Took</th>
                    <th className={styles.num}>Files</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((execution) => {
                    const state = rowState(execution.id);
                    const isOpen = expanded === execution.id;
                    const outcome = describe(execution.outcome);
                    const agentName =
                      agentNameById.get(execution.agent_id) ?? `Agent #${execution.agent_id}`;
                    return (
                      <Fragment key={execution.id}>
                        <tr>
                          <td>
                            <StatusPill tone={outcome.tone} label={outcome.label} />
                            <div className={styles.exitCode}>exit {execution.exit_status}</div>
                          </td>
                          <td>
                            <Link to={`/agents/${execution.agent_id}`} className={styles.agentLink}>
                              {agentName}
                            </Link>
                          </td>
                          <td className={styles.mono}>#{execution.conversation_id}</td>
                          <td className={styles.mono}>{execution.mode}</td>
                          <td className={styles.num}>{formatDuration(execution.duration_ms)}</td>
                          <td className={styles.num}>{execution.artifact_count}</td>
                          <td className={styles.when}>{formatWhen(execution.created_at)}</td>
                          <td>
                            <button
                              type="button"
                              className={styles.actionBtn}
                              aria-expanded={isOpen}
                              onClick={() => void handleToggle(execution.id)}
                            >
                              {isOpen ? "Hide code" : "Show code"}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className={styles.detailRow}>
                            <td colSpan={8}>
                              <p className={styles.outcomeNote}>{outcome.note}</p>
                              {state.loading && <p className={styles.rowNote}>Loading…</p>}
                              {state.error !== null && (
                                <p className={`${styles.rowNote} ${styles.critical}`}>
                                  {state.error}
                                </p>
                              )}
                              {state.detail !== null && (
                                <div className={styles.detail}>
                                  <div className={styles.pane}>
                                    <h4>Code</h4>
                                    <pre className={styles.code} data-testid="execution-code">
                                      {state.detail.code}
                                    </pre>
                                  </div>
                                  <div className={styles.pane}>
                                    <h4>stdout</h4>
                                    <pre className={styles.output}>
                                      {state.detail.stdout ?? "(nothing written)"}
                                    </pre>
                                  </div>
                                  <div className={styles.pane}>
                                    <h4>stderr</h4>
                                    <pre className={`${styles.output} ${styles.errOutput}`}>
                                      {state.detail.stderr ?? "(nothing written)"}
                                    </pre>
                                  </div>
                                  <div className={styles.pane}>
                                    <h4>Files produced</h4>
                                    {state.detail.artifacts.length === 0 ? (
                                      <p className={styles.rowNote}>
                                        None — this run printed its answer rather than writing a
                                        file.
                                      </p>
                                    ) : (
                                      <ul className={styles.artifacts}>
                                        {state.detail.artifacts.map((artifact) => (
                                          <li key={artifact.id}>
                                            <Link to="/artifacts" className={styles.agentLink}>
                                              {artifact.filename}
                                            </Link>
                                            <span className={styles.contentType}>
                                              {artifact.content_type}
                                            </span>
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
