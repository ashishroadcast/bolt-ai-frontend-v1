import { Bot, ChartColumn, FileSpreadsheet, FileText, Sparkles, type LucideIcon } from "lucide-react";
import type { ReactElement } from "react";
import { useChatContext } from "./chat/ChatContext.tsx";
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

/** Figma's four starter cards (ai-agent-welcome-panel: card-summarize-report,
 * card-compare-metrics, card-generate-insights, card-export-data). Fixed
 * rather than configurable — nothing has asked for a host override yet,
 * and inventing one on spec would be the premature-abstraction this
 * codebase's own house rule warns against. */
const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: FileText,
    title: "Summarize Report",
    body: "Get a quick overview of any workspace report",
    prompt: "Summarize the key trends in this month's reports.",
  },
  {
    icon: ChartColumn,
    title: "Compare Metrics",
    body: "Analyze performance trends side-by-side",
    prompt: "Compare performance trends across the last two periods.",
  },
  {
    icon: Sparkles,
    title: "Generate Insights",
    body: "AI-powered structural data analysis",
    prompt: "Generate insights from the current workspace data.",
  },
  {
    icon: FileSpreadsheet,
    title: "Create Forms",
    body: "Generate a ready-to-use form from a simple prompt",
    prompt: "Create a form for collecting daily sales figures.",
  },
];

export interface EmptyStateProps {
  title: string;
  body: string;
}

export function EmptyState({ title, body }: EmptyStateProps): ReactElement {
  const { status, sendMessage, selectedAgent } = useChatContext();
  const canSend = selectedAgent !== null && status !== "streaming";

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
            <Bot size={32} strokeWidth={1.75} />
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
