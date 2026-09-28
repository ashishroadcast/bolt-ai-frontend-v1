import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { useAgentFleet, type AgentFleetRow } from "../agents/useAgentFleet.ts";
import { useChatContext } from "../ask/chat/ChatContext.tsx";
import styles from "./AgentsRoute.module.css";

/**
 * The fleet, one card per agent — replacing a four-column table whose only
 * interaction was clicking the name ("agent screen should be cards with
 * action buttons to edit update etc", Saurabh).
 *
 * **The actions are exactly the ones the API has.** `PATCH /agent/agents/
 * {id}` backs Activate/Deactivate here and every control on the
 * Configuration tab; `POST /agent/run` backs Ask. There is still no
 * `POST` or `DELETE /agent/agents`, so this screen draws no New agent and
 * no Delete — a button that can only ever fail is worse than an absent
 * one, and the honest empty state says where agents come from instead.
 *
 * **Editing lives on the Configuration tab, not in a dialog here.** Every
 * field worth editing (datasource, per-phase model, code execution, tool
 * servers) already has a working control one click away, and duplicating
 * them into a modal would be a second write path to keep in step with the
 * first. The card shows that wiring and links straight into it, so "what
 * is this wired to" and "change it" are one gesture apart.
 */
export function AgentsRoute() {
  const { rows, loading, error, wiringError, setActive } = useAgentFleet();
  const { setSelectedAgent } = useChatContext();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  async function toggleActive(row: AgentFleetRow) {
    const id = row.agent.id;
    setBusyId(id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const failure = await setActive(id, !row.agent.is_active);
    if (failure !== null) setRowError((prev) => ({ ...prev, [id]: failure }));
    setBusyId(null);
  }

  /** Ask is the Ask screen, pointed at this agent — not a second, lesser
   * chat. `selectedAgent` is what `Composer` sends `POST /agent/run`, so
   * setting it here means the picker on /ask already reads this agent's
   * name when the screen arrives. */
  function ask(row: AgentFleetRow) {
    setSelectedAgent(row.agent.name);
    navigate("/ask");
  }

  return (
    <>
      <PageHeader
        kicker="Build"
        title="Agents"
        description="Every agent this tenant can run, what each is wired to, and which are serving traffic."
      />
      <div className={styles.body}>
        {loading && <p className={styles.loading}>Loading agents…</p>}

        {!loading && error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        {!loading && error === null && wiringError !== null && (
          <p className={styles.notice}>
            Showing names and status only — couldn&apos;t read what these agents are wired to:{" "}
            {wiringError}
          </p>
        )}

        {!loading && error === null && rows.length === 0 && (
          <p className={styles.empty}>
            No agents exist for this tenant yet. Agents are seeded by the platform — none has run
            here.
          </p>
        )}

        {!loading && error === null && rows.length > 0 && (
          <>
            <p className={styles.count}>
              {rows.length} {rows.length === 1 ? "agent" : "agents"}
            </p>
            <div className={styles.grid}>
              {rows.map((row) => (
                <AgentCard
                  key={row.agent.id}
                  row={row}
                  busy={busyId === row.agent.id}
                  error={rowError[row.agent.id] ?? null}
                  onToggleActive={() => void toggleActive(row)}
                  onAsk={() => ask(row)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

interface AgentCardProps {
  row: AgentFleetRow;
  busy: boolean;
  error: string | null;
  onToggleActive: () => void;
  onAsk: () => void;
}

function AgentCard({ row, busy, error, onToggleActive, onAsk }: AgentCardProps) {
  const { agent, wiring } = row;
  const shared = agent.owned === false;

  return (
    <article className={`${styles.card} ${agent.is_active ? "" : styles.cardIdle}`}>
      <header className={styles.cardHead}>
        <h3 className={styles.name}>
          {shared ? agent.name : <Link to={`/agents/${agent.id}`}>{agent.name}</Link>}
        </h3>
        {shared && <StatusPill tone="neutral" label="Shared" />}
        {agent.is_active ? (
          <StatusPill tone="good" label="Active" />
        ) : (
          <StatusPill tone="neutral" label="Inactive" />
        )}
      </header>

      {/* Full text, wrapped. The table this replaced clipped it to one
          line because four three-line descriptions made a wall; a card has
          the room the table never did. */}
      <p className={styles.description}>{agent.description ?? "No description set."}</p>

      {wiring !== null && (
        <dl className={styles.wiring}>
          <div>
            <dt>Reads</dt>
            <dd>{wiring.datasourceName ?? <span className={styles.unset}>No datasource</span>}</dd>
          </div>
          <div>
            <dt>Models</dt>
            <dd>
              {wiring.pinnedPhaseCount === 0 ? (
                <span className={styles.unset}>Tenant default, all {wiring.phaseCount} phases</span>
              ) : (
                <>
                  {wiring.modelNames.join(", ")}
                  <span className={styles.qualifier}>
                    {" "}
                    · {wiring.pinnedPhaseCount}/{wiring.phaseCount} phases pinned
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>
              {wiring.mcpServerNames.length === 0 ? (
                <span className={styles.unset}>No tool servers</span>
              ) : (
                wiring.mcpServerNames.join(", ")
              )}
            </dd>
          </div>
          <div>
            <dt>Code</dt>
            <dd>{wiring.codeExecution}</dd>
          </div>
        </dl>
      )}

      {shared && (
        <p className={styles.sharedNote}>
          Shared by a parent organisation. You can ask it; only its owner can change it.
        </p>
      )}

      {error !== null && (
        <p role="alert" className={styles.cardError}>
          {error}
        </p>
      )}

      <footer className={styles.actions}>
        {!shared && (
          <Link className={styles.primaryAction} to={`/agents/${agent.id}/config`}>
            Configure
          </Link>
        )}
        <button type="button" className={shared ? styles.primaryAction : styles.action} onClick={onAsk}>
          Ask
        </button>
        {!shared && (
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={onToggleActive}
            // The label is the verb, the pill above is the state — a button
            // reading "Active" would be ambiguous about which of the two it
            // is saying.
            aria-label={`${agent.is_active ? "Deactivate" : "Activate"} ${agent.name}`}
          >
            {busy ? "Saving…" : agent.is_active ? "Deactivate" : "Activate"}
          </button>
        )}
      </footer>
    </article>
  );
}
