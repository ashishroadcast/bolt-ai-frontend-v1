import { ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { listAuditEntries, type ConfigAuditAction, type ConfigAuditEntry } from "./auditApi.ts";
import styles from "./AuditRoute.module.css";

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
      <div className={styles.body}>
        {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

        <div className={styles.filterRow}>
          <label htmlFor="audit-entity-type">Entity type</label>
          <select
            id="audit-entity-type"
            value={entityTypeFilter}
            onChange={(e) => setEntityTypeFilter(e.target.value)}
          >
            <option value="">All</option>
            {knownEntityTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        {!loading && loadError === null && rows.length === 0 && (
          <EmptyState
            icon={ScrollText}
            title="No configuration writes yet"
            body="Who changed what, when — every channel, connector, orchestrator and prompt-promotion write this tenant makes lands here. Nothing has been written yet."
          />
        )}

        {rows.length > 0 && (
          <section className={styles.sheet}>
            <header className={styles.sheetHead}>
              <h3>Audit log</h3>
              <span className={styles.sub}>
                {rows.length} {rows.length === 1 ? "entry" : "entries"}
              </span>
            </header>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>When</th>
                    <th>Changed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr key={entry.id}>
                      <td className={styles.entity}>
                        {entry.entity_type} #{entry.entity_id}
                      </td>
                      <td>
                        <StatusPill tone={ACTION_TONE[entry.action]} label={entry.action} />
                      </td>
                      <td className={styles.actor}>User #{entry.actor_user_id}</td>
                      <td className={styles.when}>{formatWhen(entry.created_at)}</td>
                      <td>
                        <pre className={styles.payload} data-testid="audit-payload">
                          {JSON.stringify(entry.changed_fields, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
