import { ArrowUpRight, LayoutDashboard } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import { useAskConfig, type AskDashboardDraft, type AskDashboardDraftWidget } from "../config.tsx";
import {
  sizeLabel,
  timeRangeLabel,
  visualizationLabel,
  widgetGridSize,
  widgetTitle,
} from "./dashboardCatalog.ts";
import { GRID_COLUMNS, layoutHeight, packLayout } from "./packLayout.ts";
import { VisualizationIcon } from "./VisualizationIcon.tsx";
import styles from "./DashboardDraft.module.css";

/**
 * The card's props ARE the handoff shape (CONTRACT §6), aliased rather than
 * restated, for the reason `FormDraftProps` is: a field shown here and missing
 * from what the host receives is a View that was reviewed and a different one
 * that got built.
 */
export type DashboardDraftProps = AskDashboardDraft;

/**
 * The layout the builder will open with, in miniature.
 *
 * Packed with the builder's own algorithm (`packLayout.ts`), so this is not an
 * impression of a layout but the layout — the reader can see the KPI row, the
 * trend under it and the breakdowns beside each other before deciding to open
 * it. Decorative for assistive tech beyond its label: the widget list below
 * says the same thing in words.
 */
function LayoutThumbnail({ widgets }: { widgets: AskDashboardDraftWidget[] }): ReactElement {
  const rects = packLayout(widgets.map(widgetGridSize));
  const rows = layoutHeight(rects);
  return (
    <div
      className={styles.thumb}
      role="img"
      aria-label={`Layout preview: ${widgets.length} widget${widgets.length === 1 ? "" : "s"} on a ${GRID_COLUMNS}-column grid`}
      style={{ gridTemplateRows: `repeat(${rows}, var(--thumb-row))` } as CSSProperties}
    >
      {rects.map((rect, index) => (
        <span
          // Positional: the thumbnail is the list, in order, and has no ids.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={styles.cell}
          data-viz={widgets[index]!.visualization}
          style={{
            gridColumn: `${rect.x + 1} / span ${rect.w}`,
            gridRow: `${rect.y + 1} / span ${rect.h}`,
          }}
        />
      ))}
    </div>
  );
}

function WidgetRow({ widget }: { widget: AskDashboardDraftWidget }): ReactElement {
  const range = timeRangeLabel(widget);
  return (
    <li className={styles.widget}>
      <span className={styles.widgetIcon}>
        <VisualizationIcon visualization={widget.visualization} />
      </span>
      <div className={styles.widgetText}>
        <span className={styles.widgetTitle}>{widgetTitle(widget)}</span>
        <span className={styles.widgetMeta}>
          {visualizationLabel(widget.visualization)}
          {range !== null && ` · ${range}`}
        </span>
      </div>
      <span className={styles.widgetSize}>{sizeLabel(widget)}</span>
    </li>
  );
}

/** Drops keys the host never asked for, so it receives the contract shape. */
function handoff({ draftId, name, description, widgets }: DashboardDraftProps): AskDashboardDraft {
  return {
    draftId,
    name,
    ...(description === undefined || description === "" ? {} : { description }),
    widgets,
  };
}

/**
 * A dashboard (a bolt-v2 "View") the agent drafted, for the reader to review
 * and then open in the host's dashboard builder.
 *
 * **Nothing has been saved.** Same contract as `FormDraft`: the builder lays
 * it out, shows live numbers and saves it under the reader's own session. So
 * the action says "Open in builder", and a host with no builder — anything but
 * bolt-v2 — gets a read-only summary instead of a button that goes nowhere.
 */
export function DashboardDraft(props: DashboardDraftProps): ReactElement {
  const { name, description, widgets } = props;
  const { onDashboardDraft } = useAskConfig();
  const count = `${widgets.length} widget${widgets.length === 1 ? "" : "s"}`;

  return (
    <section className={styles.draft} aria-label={`Draft view: ${name}`}>
      <header className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <LayoutDashboard size={13} strokeWidth={2.25} />
        </span>
        <div className={styles.heading}>
          <h3 className={styles.title}>{name}</h3>
          <p className={styles.sub}>{count} · Draft view</p>
        </div>
      </header>

      <div className={styles.body}>
        {description !== undefined && description !== "" && (
          <p className={styles.description}>{description}</p>
        )}
        {widgets.length > 0 ? (
          <>
            <LayoutThumbnail widgets={widgets} />
            <ol className={styles.widgets}>
              {widgets.map((widget, index) => (
                // eslint-disable-next-line react/no-array-index-key
                <WidgetRow key={`${index}-${widget.metricKey}`} widget={widget} />
              ))}
            </ol>
          </>
        ) : (
          <p className={styles.empty}>This draft has no widgets the assistant could read.</p>
        )}
      </div>

      {onDashboardDraft !== undefined && widgets.length > 0 && (
        <footer className={styles.foot}>
          <button type="button" className={styles.open} onClick={() => onDashboardDraft(handoff(props))}>
            Open in builder
            <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
          </button>
          {/* The builder it opens looks finished. It is not saved. */}
          <span className={styles.note}>Nothing is saved until you save the view there.</span>
        </footer>
      )}
    </section>
  );
}
