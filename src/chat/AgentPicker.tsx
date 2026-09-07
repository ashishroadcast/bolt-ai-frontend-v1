import { Bot } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "../agents/useAgents.ts";
import { useChatContext } from "./ChatContext.tsx";
import styles from "./AgentPicker.module.css";

/**
 * "When we chat who are we chatting with — not clear" (Saurabh). `POST
 * /agent/run` always runs against one specific agent (`RunIn.agent`, a
 * *name* — `chat/runStream.ts`'s own note), the Ask screen just never said
 * which or offered a way to choose. This is that: a visible selector at
 * the top of Ask, backed by the same `GET /agent/agents` every other
 * screen reads (`useAgents`), writing into `ChatContext`'s
 * `selectedAgent` so `Composer` sends the run to whichever name is showing
 * here — never a silent default the operator can't see.
 *
 * Defaults to the first agent returned once the list loads and nothing is
 * selected yet, rather than leaving the screen unusable until a manual
 * pick — but the default is still visible and still changeable, not a
 * hidden fallback baked into the request.
 */
export function AgentPicker() {
  const { agents, loading, error } = useAgents();
  const { selectedAgent, setSelectedAgent } = useChatContext();

  useEffect(() => {
    if (selectedAgent !== null || agents.length === 0) return;
    setSelectedAgent(agents[0]!.name);
  }, [agents, selectedAgent, setSelectedAgent]);

  if (loading) {
    return (
      <div className={styles.bar}>
        <span className={styles.loading}>Finding agents…</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className={styles.bar}>
        <span className={styles.iconTile} aria-hidden="true">
          <Bot size={14} strokeWidth={2} />
        </span>
        <span className={styles.warning}>Couldn't load agents — {error}</span>
      </div>
    );
  }

  // "If no agent exists yet, say so and link to Agents rather than
  // silently running against nothing" (dispatch) — a 0-length list means
  // there is nothing this screen can run against at all, so Composer stays
  // disabled (it reads `selectedAgent === null` too) and this says why.
  if (agents.length === 0) {
    return (
      <div className={styles.bar}>
        <span className={styles.iconTile} aria-hidden="true">
          <Bot size={14} strokeWidth={2} />
        </span>
        <span className={styles.warning}>
          No agents are set up yet. <Link to="/agents">Set one up</Link> before asking a question.
        </span>
      </div>
    );
  }

  return (
    <div className={styles.bar}>
      <span className={styles.iconTile} aria-hidden="true">
        <Bot size={14} strokeWidth={2} />
      </span>
      <span className={styles.label}>Chatting with</span>
      <select
        className={styles.select}
        aria-label="Agent to run this question against"
        value={selectedAgent ?? ""}
        onChange={(event) => setSelectedAgent(event.target.value)}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.name}>
            {agent.name}
            {agent.is_active ? "" : " (inactive)"}
          </option>
        ))}
      </select>
    </div>
  );
}
