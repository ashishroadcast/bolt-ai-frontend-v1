import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useAgents } from "../agents/useAgents.ts";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import type { AgentSummary } from "../agents/types.ts";
import { useChatContext } from "../chat/ChatContext.tsx";
import styles from "./AgentDetailRoute.module.css";

/** What every tab reads via `useOutletContext<AgentDetailContext>()`. */
export interface AgentDetailContext {
  agent: AgentSummary;
}

const TABS = [
  { to: "config", label: "Configuration" },
  { to: "prompts", label: "Prompts & tuning" },
  { to: "tests", label: "Test suites" },
  { to: "learning", label: "Self-learning" },
];

/**
 * An agent's own detail page: header + four tabs + `<Outlet/>`.
 *
 * **There is no Run tab, and its absence is the fix.** It was one text
 * input and an Ask button alone on a full-height page ("run tab extremely
 * poor too much space wastage", Saurabh) whose submit handler navigated
 * straight to /ask — a launcher, not a workspace, and a strictly worse one
 * than the screen it launched: /ask has the same composer plus the agent
 * picker, the thread, the run's own trace and history. Running an agent is
 * now the header's Ask action, which points /ask at this agent and goes
 * there. `/agents/:id/run` still resolves (App.tsx redirects it) because
 * the URL may be bookmarked.
 */
export function AgentDetailRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const { agents, loading, error } = useAgents();
  const { setSelectedAgent } = useChatContext();
  const navigate = useNavigate();

  if (loading) {
    return <p className={styles.loading}>Loading agent…</p>;
  }
  if (error !== null) {
    return (
      <p role="alert" className={styles.error}>
        {error}
      </p>
    );
  }

  const numericId = Number(agentId);
  const agent = agents.find((candidate) => candidate.id === numericId);

  if (agent === undefined) {
    return <p className={styles.notFound}>No agent with id {agentId} in this tenant.</p>;
  }

  return (
    <>
      <PageHeader
        kicker="Build · Agents"
        title={agent.name}
        titleAdornment={
          agent.is_active ? (
            <StatusPill tone="good" label="Active" />
          ) : (
            <StatusPill tone="neutral" label="Inactive" />
          )
        }
        description={agent.description ?? "No description set."}
        actionLabel={`Ask ${agent.name}`}
        onAction={() => {
          // `selectedAgent` is what Composer sends as `RunIn.agent`, so
          // setting it here is what makes /ask arrive already pointed at
          // this agent rather than whichever the picker defaulted to.
          setSelectedAgent(agent.name);
          navigate("/ask");
        }}
      />

      <nav className={styles.tabs} aria-label={`${agent.name} sections`}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabOn : ""}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className={styles.body}>
        <Outlet context={{ agent } satisfies AgentDetailContext} />
      </div>
    </>
  );
}
