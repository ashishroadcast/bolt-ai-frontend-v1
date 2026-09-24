import { ArrowRight, Plus } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import { useAskConfig, type AskWidgetDraft } from "../config.tsx";
import { timeRangeLabel, visualizationLabel, widgetTitle } from "./dashboardCatalog.ts";
import { VisualizationIcon } from "./VisualizationIcon.tsx";
import {
  claimAutoInsert,
  submitWidgetDraft,
  useWidgetDraftState,
  type WidgetDraftState,
} from "./widgetDraftStore.ts";
import styles from "./WidgetDraft.module.css";

/**
 * The contract's `AskWidgetDraft`, plus one fact that is not on the wire:
 * whether this card is rendering a part this session watched stream in.
 *
 * `live` is set by `wireParts.toUIPart` from where the part CAME from — the
 * run stream in `useChat`, never history — and never read from the payload,
 * so a persisted part cannot claim to be live and re-insert itself.
 */
export type WidgetDraftProps = AskWidgetDraft & { live?: boolean };

/** The host's rejection codes, in the reader's words. */
const REJECTION_TEXT: Record<string, string> = {
  not_in_builder: "Open the dashboard builder to add this widget",
};

function rejectionText(reason: string | undefined): string {
  if (reason !== undefined && Object.hasOwn(REJECTION_TEXT, reason)) return REJECTION_TEXT[reason]!;
  return "Couldn't add this widget to your view";
}

function statusText(state: WidgetDraftState): string {
  if (state.status === "pending") return "Adding to your view…";
  if (state.status === "rejected") return rejectionText(state.reason);
  return state.status === "added"
    ? "Added to your view — not saved yet"
    : "Updated in your view — not saved yet";
}

/** The contract shape, without the render-only `live` flag. */
function handoff({ draftId, replaceWidgetId, widget }: WidgetDraftProps): AskWidgetDraft {
  return {
    draftId,
    ...(replaceWidgetId === undefined ? {} : { replaceWidgetId }),
    widget,
  };
}

/**
 * One widget the agent drafted for the dashboard builder this panel is docked
 * beside (Figma F13/F14).
 *
 * **Live, it inserts itself.** The builder's canvas is unsaved, so putting the
 * widget there persists nothing and is one undo away — which is why this card,
 * unlike `FormDraft` and `DashboardDraft`, acts without a click. Exactly once
 * per `draftId` (`widgetDraftStore.ts`), and only on the live stream.
 *
 * **Reopened from history, it never does.** A thread from last week must not
 * silently re-add its widgets to whatever canvas happens to be open now, so a
 * reloaded card offers "Add to view" and waits.
 *
 * The status line says "not saved yet" in so many words: the widget appearing
 * on the canvas looks exactly like a saved one.
 */
export function WidgetDraft(props: WidgetDraftProps): ReactElement {
  const { draftId, replaceWidgetId, widget, live = false } = props;
  const { onWidgetDraft, onEditWidget } = useAskConfig();
  const state = useWidgetDraftState(draftId);
  const usable = draftId !== "" && widget.metricKey !== "";

  useEffect(() => {
    if (!live || !usable || onWidgetDraft === undefined) return;
    if (!claimAutoInsert(draftId)) return;
    void submitWidgetDraft(handoff(props), onWidgetDraft);
    // `props` is read once, at the moment of the claim; a later render of
    // the same draft must not re-trigger anything, which the claim enforces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, usable, draftId, onWidgetDraft]);

  const title = widgetTitle(widget);
  const range = timeRangeLabel(widget);
  const acknowledged =
    state !== null && (state.status === "added" || state.status === "replaced") ? state : null;
  const canAdd =
    onWidgetDraft !== undefined && usable && (state === null || state.status === "rejected");
  const showsEdit = onEditWidget !== undefined && state !== null && state.status !== "rejected";

  return (
    <section className={styles.draft} aria-label={`Drafted widget: ${title}`}>
      <header className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <VisualizationIcon visualization={widget.visualization} />
        </span>
        <div className={styles.heading}>
          <h3 className={styles.title}>{title}</h3>
          <p className={styles.sub}>
            {visualizationLabel(widget.visualization)}
            {range !== null && ` · ${range}`}
            {replaceWidgetId !== undefined && " · Replaces the selected widget"}
          </p>
        </div>
      </header>

      {onWidgetDraft !== undefined && usable && (
        <div className={styles.foot}>
          {state !== null && (
            <p className={styles.status} role="status" data-status={state.status}>
              {statusText(state)}
            </p>
          )}
          <div className={styles.actions}>
            {showsEdit && (
              <button
                type="button"
                className={styles.edit}
                // Disabled until the host says where the widget went (F13 →
                // F14): there is nothing to edit before it has an id.
                disabled={acknowledged?.widgetId === undefined}
                onClick={() => {
                  if (acknowledged?.widgetId !== undefined) onEditWidget(acknowledged.widgetId);
                }}
              >
                <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
                Edit Widget
              </button>
            )}
            {canAdd && (
              <button
                type="button"
                className={styles.add}
                onClick={() => void submitWidgetDraft(handoff(props), onWidgetDraft)}
              >
                <Plus size={14} strokeWidth={2.25} aria-hidden="true" />
                Add to view
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
