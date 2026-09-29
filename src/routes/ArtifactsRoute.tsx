import { AlertCircle, Download, ExternalLink, FileArchive } from "lucide-react";
import { useEffect, useState } from "react";
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
import { PageHeader } from "../agents/PageHeader.tsx";
import { useAgents } from "../agents/useAgents.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { getArtifactDownload, listArtifacts, type ArtifactDownload, type ArtifactSummary } from "./artifactsApi.ts";

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
            icon={FileArchive}
            title="No artifacts yet"
            body="An agent's code produces during a run — a chart, a CSV export — and it lands here with what made it and when. Ask a question in Ask that needs one to see it appear."
            actionLabel="Go to Ask"
            onAction={() => navigate("/ask")}
          />
        )}

        {rows.length > 0 && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <CardTitle>
                <h3>Artifacts</h3>
              </CardTitle>
              <CardDescription className="tabular-nums">
                {rows.length} {rows.length === 1 ? "artifact" : "artifacts"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">File</TableHead>
                    <TableHead>Produced by</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="pr-6">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((artifact) => {
                    const state = rowState(artifact.id);
                    const agentName = agentNameById.get(artifact.agent_id) ?? `Agent #${artifact.agent_id}`;
                    return (
                      <TableRow key={artifact.id}>
                        <TableCell className="py-3 pl-6 align-top">
                          {/* A filename has no length limit server-side
                              (app.sandbox.artifacts._sanitize_filename cleans the
                              charset, not the length) — it scrolls inside its own
                              cell rather than widening the page (task brief). */}
                          <div
                            className="max-w-[32ch] overflow-x-auto font-medium whitespace-nowrap"
                            data-testid="artifact-filename"
                            title={artifact.filename}
                          >
                            {artifact.filename}
                          </div>
                          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {artifact.content_type}
                          </div>
                        </TableCell>
                        <TableCell className="py-3 align-top">
                          <Link
                            to={`/agents/${artifact.agent_id}`}
                            className="font-medium text-primary underline-offset-4 hover:underline"
                          >
                            {agentName}
                          </Link>
                        </TableCell>
                        <TableCell className="py-3 align-top text-muted-foreground">
                          {formatWhen(artifact.created_at)}
                        </TableCell>
                        <TableCell className="py-3 text-right align-top font-mono text-muted-foreground tabular-nums">
                          {formatBytes(artifact.size_bytes)}
                        </TableCell>
                        <TableCell className="py-3 pr-6 align-top whitespace-normal">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-2.5"
                            disabled={state.resolving}
                            onClick={() => void handleDownload(artifact.id)}
                          >
                            {state.resolving ? <Spinner aria-hidden="true" /> : <Download aria-hidden="true" />}
                            {state.resolving ? "Resolving…" : "Download"}
                          </Button>
                          {state.download !== null && (
                            <div className="mt-2 max-w-[34ch]">
                              <code className="block overflow-x-auto rounded-md border bg-muted px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                                {state.download.url}
                              </code>
                              <p className="mt-1.5 text-xs text-muted-foreground">
                                Expires in {Math.round(state.download.expires_in / 60)} min —{" "}
                                <a
                                  href={state.download.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-4 hover:underline"
                                >
                                  open again
                                  <ExternalLink aria-hidden="true" className="size-3" />
                                </a>
                              </p>
                            </div>
                          )}
                          {state.error !== null && (
                            <p className="mt-1.5 max-w-[34ch] text-xs text-destructive">{state.error}</p>
                          )}
                        </TableCell>
                      </TableRow>
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
