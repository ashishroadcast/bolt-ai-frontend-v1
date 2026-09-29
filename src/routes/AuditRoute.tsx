import { AlertCircle, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { listAuditEntries, type ConfigAuditAction, type ConfigAuditEntry } from "./auditApi.ts";

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

const ACTION_TONE: Record<ConfigAuditAction, StatusPillTone> = {
  create: "good",
  update: "amber",
  delete: "critical",
};

/**
 * `GET /agent/audit` (`app.api.audit`, this task's own new router — see
 * this task's report for why none existed) — the screen that answers "who
 * turned that on." `config_audit` has been written to on every channel,
 * MCP-server, datasource, orchestrator and prompt-promotion write since
 * each of those shipped; nothing ever read a row back before this.
 *
 * **Read-only.** There is no create/edit/delete here on purpose — this
 * router only ever exposes `can_read` (`app.api.audit`'s own docstring),
 * and a trail a console could edit through would not be one.
 *
 * **Filter options grow, never shrink.** `knownEntityTypes` accumulates
 * every `entity_type` this tenant's rows have ever shown across every
 * load — including a filtered one — rather than being derived fresh from
 * whatever the *current* (possibly filtered) result set happens to
 * contain, which would make the dropdown's own options disappear the
 * moment a filter narrowed the visible rows.
 */
export function AuditRoute() {
  const [entries, setEntries] = useState<ConfigAuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [knownEntityTypes, setKnownEntityTypes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listAuditEntries(entityTypeFilter === "" ? undefined : entityTypeFilter)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
        setKnownEntityTypes((prev) => {
          const set = new Set(prev);
          rows.forEach((row) => set.add(row.entity_type));
          return Array.from(set).sort();
        });
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
  }, [entityTypeFilter]);

  const rows = entries ?? [];

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Audit"
        description="Who changed what, when — every configuration write this tenant has made, straight from config_audit."
      />
      <div className="flex flex-col gap-6">
        {loadError !== null && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {/* Always rendered, in the same place, whatever the result — a filter
            that narrowed the log to nothing must still be there to undo. */}
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="audit-entity-type" className="text-muted-foreground">
            Entity type
          </Label>
          <NativeSelect
            id="audit-entity-type"
            size="sm"
            value={entityTypeFilter}
            onChange={(e) => setEntityTypeFilter(e.target.value)}
            className="min-w-40 bg-card"
          >
            <NativeSelectOption value="">All</NativeSelectOption>
            {knownEntityTypes.map((type) => (
              <NativeSelectOption key={type} value={type}>
                {type}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        {loading && loadError === null && entries === null && (
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
            icon={ScrollText}
            title="No configuration writes yet"
            body="Who changed what, when — every channel, connector, orchestrator and prompt-promotion write this tenant makes lands here. Nothing has been written yet."
          />
        )}

        {rows.length > 0 && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <CardTitle>
                <h3>Audit log</h3>
              </CardTitle>
              <CardDescription className="tabular-nums">
                {rows.length} {rows.length === 1 ? "entry" : "entries"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Entity</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="pr-6">Changed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="py-3 pl-6 align-top font-mono text-xs font-medium">
                        {entry.entity_type} #{entry.entity_id}
                      </TableCell>
                      <TableCell className="py-3 align-top">
                        <StatusPill tone={ACTION_TONE[entry.action]} label={entry.action} />
                      </TableCell>
                      <TableCell className="py-3 align-top font-mono text-xs text-muted-foreground">
                        User #{entry.actor_user_id}
                      </TableCell>
                      <TableCell className="py-3 align-top text-muted-foreground">
                        {formatWhen(entry.created_at)}
                      </TableCell>
                      <TableCell className="py-3 pr-6 align-top">
                        {/* A changed_fields payload is arbitrary JSON — no length
                            bound server-side — so it scrolls inside its own box in
                            both directions rather than the page (task brief: "an
                            audit payload ... scrolls inside its own container,
                            never the page body"). */}
                        <pre
                          className="m-0 max-h-[120px] max-w-[36ch] overflow-auto rounded-md border bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre"
                          data-testid="audit-payload"
                        >
                          {JSON.stringify(entry.changed_fields, null, 2)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
