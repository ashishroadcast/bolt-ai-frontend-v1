import { FileSpreadsheet, LayoutDashboard, Radio, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { AgentIcon } from "./AgentIcon.tsx";
import { useChatContext } from "./chat/ChatContext.tsx";
import { useAskAgents } from "./chat/useAskAgents.ts";
import { useOnlineStatus } from "./chat/useOnlineStatus.ts";
import styles from "./EmptyState.module.css";

interface QuickAction {
  icon: LucideIcon;
  title: string;
  body: string;
  /** What actually gets sent when the card is clicked — the card's own
   * copy is a label ("Summarize Report"), not necessarily a well-formed
  * question, so the two are kept separate. */
  prompt: string;
}

/** The four starter cards, first drafted from Figma's ai-agent-welcome-panel
 * and since re-prioritised by product for the fleet tenant: a dashboard
 * action first, forms second, the two original survivors kept in place.
 * Fixed rather than configurable — nothing has asked for a host override yet,
 * and inventing one on spec would be the premature-abstraction this
 * codebase's own house rule warns against. */
const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: LayoutDashboard,
    title: "Create Dashboard",
    body: "Daily vehicle usage, drafted for you",
    prompt: "Create a dashboard to show daily usage of vehicles.",
  },
  {
    icon: FileSpreadsheet,
    title: "Create Forms",
    body: "Generate a ready-to-use form from a simple prompt",
    prompt: "Create a form for collecting daily sales figures.",
  },
  {
    icon: Sparkles,
    title: "Generate Insights",
    body: "AI-powered structural data analysis",
    prompt: "Generate insights from the current workspace data.",
  },
  {
    icon: Radio,
    title: "Live Fleet Data",
    body: "Motion, speed, address and more, as it happens",
    prompt: "Show live fleet data like motion, speed, and current address.",
  },
];

export interface EmptyStateProps {
  title: string;
  body: string;
}

export function EmptyState({ title, body }: EmptyStateProps): ReactElement {
  const { status, sendMessage, selectedAgent } = useChatContext();
  const { agents } = useAskAgents();
  const isOnline = useOnlineStatus();
  // Not `selectedAgent !== null` — matches Composer.tsx's own gate (see
  // its docstring): a question with no agent armed is the ordinary case
  // now, routed automatically once it reaches the server
  // (`app.api.run._choose_agent`). Requiring a selection here left these
  // cards permanently disabled the moment the manual picker's own
  // agents[0] default went away, since nothing else ever set
  // `selectedAgent` at all.
  //
  // And offline, like the composer beside them: a card clicked with no
  // connection went straight to a "Failed to fetch" turn, which says less
  // than a card that simply cannot be pressed yet.
  const canSend = agents.length > 0 && status !== "streaming" && isOnline;

  function runQuickAction(action: QuickAction) {
    if (!canSend) return;
    sendMessage(action.prompt, { agent: selectedAgent ?? undefined });
  }

  return (
    <>
      <div className={styles.hero}>
        <div className={styles.orb} aria-hidden="true">
          <span className={styles.orbRingOuter} />
          <span className={styles.orbRingInner} />
          <span className={styles.orbCore}>
            <AgentIcon size={34} />
          </span>
        </div>

        <div className={styles.heroText}>
          <p className={styles.heroTitle}>{title}</p>
          <p className={styles.heroBody}>{body}</p>
        </div>
      </div>

      <div className={styles.suggestions}>
        <p className={styles.suggestionsLabel}>Suggested Quick Actions</p>
        <div className={styles.grid}>
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.title}
              type="button"
              className={styles.card}
              onClick={() => runQuickAction(action)}
              disabled={!canSend}
            >
              <span className={styles.cardIcon} aria-hidden="true">
                <action.icon size={16} strokeWidth={2} />
              </span>
              <span className={styles.cardTitle}>{action.title}</span>
              <span className={styles.cardBody}>{action.body}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
