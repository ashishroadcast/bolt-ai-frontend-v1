import { Bot, X } from "lucide-react";
import { useEffect } from "react";
import { useAskConfig, useAskReconnecting } from "../config.tsx";
import { useAgents } from "./useAskAgents.ts";
import { useChatContext } from "./ChatContext.tsx";
import styles from "./AgentPicker.module.css";

/**
 * "When we chat who are we chatting with — not clear" (Saurabh) used to
 * mean a manual selector here: every question ran against whichever name
 * this bar's `<select>` was showing, defaulted to `agents[0]` on load.
 *
 * Not anymore — an omitted `RunIn.agent` now routes itself
 * (`app.api.run._choose_agent`, picked from the question's own wording),
 * which is the explicit ask this replaced the picker for: auto-select,
 * "without letting user manually select." So this bar no longer offers a
 * choice; it only ever has something to *say*:
 *
 * - still loading, or failed to load (`useAgents`). A failure offers "Try
 *   again" when a retry could help — never for a missing permission — and
 *   `useAgents` also retries by itself with backoff, so one bad moment no
 *   longer leaves the panel dead until a reload.
 * - nothing configured for this tenant at all
 * - a slash command has explicitly armed one name for the rest of this
 *   conversation (`Composer.tsx`'s `choose()`, via `ChatContext.
 *   selectedAgent`) — shown so the operator can see who a follow-up will
 *   keep reaching, with a × to let go of it. That used to be missing, on
 *   the theory that a fresh unarmed question changes it back; it does not
 *   — the arming lasts the conversation — so the only way out was starting
 *   a new conversation and losing the thread.
 *
 * Otherwise (agents loaded, nothing armed) this renders nothing: the
 * common case is now silent by design.
 */
export function AgentPicker() {
  const { setupAgentsHref } = useAskConfig();
  const { agents, loading, error, canRetry, retrying, retry } = useAgents();
  const { selectedAgent, setSelectedAgent } = useChatContext();
  const reconnecting = useAskReconnecting();

  // An armed agent that is no longer in the list — deactivated or deleted
  // since it was armed, or armed in a conversation the list has since been
  // reloaded under — is let go of. Keeping it would send every follow-up to
  // a name the run can only refuse. Only against a list that actually
  // loaded: a failed load says nothing about which agents exist.
  useEffect(() => {
    if (selectedAgent === null || loading || error !== null) return;
    const stillThere = agents.some((agent) => agent.is_active && agent.name === selectedAgent);
    if (!stillThere) setSelectedAgent(null);
  }, [agents, loading, error, selectedAgent, setSelectedAgent]);

  // The host's credential provider came back empty and Ask is giving it a
  // second to recover — usually a token refresh in flight. Said here because
  // this bar is where a stalled first load would otherwise sit on "Finding
  // agents…" with no explanation.
  if (reconnecting) {
    return (
      <div className={styles.bar} role="status">
        <span className={styles.loading}>Reconnecting to your account…</span>
      </div>
    );
  }

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
        {/* The message alone: every one the client produces is already a
            sentence ("Couldn't reach the assistant. It may be restarting…"),
            and a "Couldn't load agents —" in front of it made two. */}
        <span className={styles.warning}>{error}</span>
        {canRetry && (
          <button type="button" className={styles.retry} onClick={retry} disabled={retrying}>
            {retrying ? "Trying again…" : "Try again"}
          </button>
        )}
      </div>
    );
  }

  // "If no agent exists yet, say so and link to Agents rather than
  // silently running against nothing" (dispatch) — a 0-length list means
  // there is nothing this screen can run against at all, so Composer stays
  // disabled (it reads `agents.length` too) and this says why.
  if (agents.length === 0) {
    return (
      <div className={styles.bar}>
        <span className={styles.iconTile} aria-hidden="true">
          <Bot size={14} strokeWidth={2} />
        </span>
        <span className={styles.warning}>
          {/* A plain anchor to a host-supplied href, not a router link. The
              package cannot import the console's router without becoming
              unusable in Angular's — and a host with nowhere to send anyone
              gets a sentence without the link rather than a dead one (it
              used to get "No agents are set up yet. before asking…").

              A new tab, because inside bolt-v2 this href is the admin
              console: following it in place replaced the tab the operator
              was working in. In the console itself it is a full page load
              either way, and a new tab at least keeps the conversation. */}
          {setupAgentsHref === undefined || setupAgentsHref === "" ? (
            "No agents are set up yet. Ask an admin to set one up."
          ) : (
            <>
              No agents are set up yet.{" "}
              <a href={setupAgentsHref} target="_blank" rel="noopener noreferrer">
                Set one up
              </a>{" "}
              before asking a question.
            </>
          )}
        </span>
      </div>
    );
  }

  // The common case: agents are loaded, nothing has explicitly armed one,
  // and every question from here routes itself. Nothing to say.
  if (selectedAgent === null) return null;

  return (
    <div className={styles.bar}>
      <span className={styles.iconTile} aria-hidden="true">
        <Bot size={14} strokeWidth={2} />
      </span>
      <span className={styles.label}>Chatting with</span>
      <span className={styles.armedChip}>
        <span className={styles.armedName}>{selectedAgent}</span>
        <button
          type="button"
          className={styles.disarm}
          onClick={() => setSelectedAgent(null)}
          aria-label={`Stop chatting with ${selectedAgent}`}
          title="Stop chatting with this agent"
        >
          <X size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
