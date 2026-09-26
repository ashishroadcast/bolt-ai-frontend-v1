import { Bot } from "lucide-react";
import { useAskConfig } from "../config.tsx";
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
 * - still loading, or failed to load (`useAgents`, same as before)
 * - nothing configured for this tenant at all
 * - a slash command has explicitly armed one name for the rest of this
 *   conversation (`Composer.tsx`'s `choose()`, via `ChatContext.
 *   selectedAgent`) — shown so the operator can see who a follow-up will
 *   keep reaching, with no control to change it back, since asking a
 *   fresh unarmed question is what changes it back.
 *
 * Otherwise (agents loaded, nothing armed) this renders nothing: the
 * common case is now silent by design.
 */
export function AgentPicker() {
  const { setupAgentsHref } = useAskConfig();
  const { agents, loading, error } = useAgents();
  const { selectedAgent } = useChatContext();

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
              gets the sentence without the link rather than a dead one. */}
          No agents are set up yet.{" "}
          {setupAgentsHref === undefined ? null : (
            <>
              <a href={setupAgentsHref}>Set one up</a>{" "}
            </>
          )}
          before asking a question.
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
      <span className={styles.armedName}>{selectedAgent}</span>
    </div>
  );
}
