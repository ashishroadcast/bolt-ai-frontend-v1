import { FileArchive } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../agents/PageHeader.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { getArtifactDownload, listArtifacts, type ArtifactDownload, type ArtifactSummary } from "./artifactsApi.ts";
import styles from "./ArtifactsRoute.module.css";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Number(kb.toFixed(kb < 10 ? 1 : 0))} KB`;
  const mb = kb / 1024;
  return `${Number(mb.toFixed(mb < 10 ? 1 : 0))} MB`;
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

interface RowState {
  resolving: boolean;
  download: ArtifactDownload | null;
  error: string | null;
}

const BLANK_ROW_STATE: RowState = { resolving: false, download: null, error: null };

/**
 * `GET /agent/artifacts` (list, added by this task — see `app.api.
 * artifacts`'s own docstring for why) and `GET /agent/artifacts/{id}`
 * (the pre-existing single-artifact route) — generated code's own output
 * (a chart, a CSV) that had no screen at all before this one.
 *
 * **Download is exactly the two-step flow the backend already offers, not
 * a new one.** `handleDownload` calls `getArtifactDownload` — the same
 * `GET /agent/artifacts/{id}` route that has always resolved one known id
 * to a *freshly minted*, short-lived presigned URL (`app.sandbox.
 * artifacts.presigned_artifact_url`, called at request time, "no `r2_url`
 * is ever stored"). This screen shows that URL, and its expiry, right in
 * the row rather than silently opening a new tab — the signed-URL step is
 * real and worth being visible, not a mechanism to hide behind a single
 * click.
 *
 * **No create action.** An artifact is a byproduct of a code execution
 * during a chat run — there is no `POST /agent/artifacts` to build a form
 * against (same reasoning `AgentsRoute.tsx` gives for having none: "do not
 * invent a contract"). The empty state instead points at the one real
 * place that produces one: Ask.
 */
export function ArtifactsRoute() {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listArtifacts()
      .then((rows) => {
        if (!cancelled) setArtifacts(rows);
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

  function rowState(id: string): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  async function handleDownload(id: string) {
    patchRow(id, { resolving: true, error: null });
    try {
      const download = await getArtifactDownload(id);
      patchRow(id, { resolving: false, download });
      window.open(download.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      patchRow(id, { resolving: false, error: errorMessage(err) });
    }
  }

  const rows = artifacts ?? [];

  return (
    <>
      <PageHeader
        kicker="Work"
        title="Artifacts"
        description="Charts and CSVs an agent's code produced while answering a question — what made each one, and when."
      />
      <div className={styles.body}>
        {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

        {!loading && loadError === null && rows.length === 0 && (
          <EmptyState
            icon={FileArchive}
            title="No artifacts yet"
            body="An agent's code produces during a run — a chart, a CSV export — and it lands here with what made it and when. Ask a question in Ask that needs one to see it appear."
            actionLabel="Go to Ask"
            onAction={() => navigate("/ask")}
          />
        )}

        {rows.length > 0 && (
          <section className={styles.sheet}>
            <header className={styles.sheetHead}>
              <h3>Artifacts</h3>
              <span className={styles.sub}>
                {rows.length} {rows.length === 1 ? "artifact" : "artifacts"}
              </span>
            </header>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Produced by</th>
                    <th>When</th>
                    <th className={styles.num}>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((artifact) => {
                    const state = rowState(artifact.id);
                    const agentName = agentNameById.get(artifact.agent_id) ?? `Agent #${artifact.agent_id}`;
                    return (
                      <tr key={artifact.id}>
                        <td>
                          <div className={styles.filename} data-testid="artifact-filename" title={artifact.filename}>
                            {artifact.filename}
                          </div>
                          <div className={styles.contentType}>{artifact.content_type}</div>
                        </td>
                        <td>
                          <Link to={`/agents/${artifact.agent_id}`} className={styles.agentLink}>
                            {agentName}
                          </Link>
                        </td>
                        <td className={styles.when}>{formatWhen(artifact.created_at)}</td>
                        <td className={styles.num}>{formatBytes(artifact.size_bytes)}</td>
                        <td>
                          <button
                            type="button"
                            className={styles.actionBtn}
                            disabled={state.resolving}
                            onClick={() => void handleDownload(artifact.id)}
                          >
                            {state.resolving ? "Resolving…" : "Download"}
                          </button>
                          {state.download !== null && (
                            <div className={styles.downloadPanel}>
                              <code className={styles.downloadUrl}>{state.download.url}</code>
                              <p className={styles.downloadNote}>
                                Expires in {Math.round(state.download.expires_in / 60)} min —{" "}
                                <a href={state.download.url} target="_blank" rel="noopener noreferrer">
                                  open again
                                </a>
                              </p>
                            </div>
                          )}
                          {state.error !== null && (
                            <p className={`${styles.rowNote} ${styles.critical}`}>{state.error}</p>
                          )}
                        </td>
                      </tr>
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
