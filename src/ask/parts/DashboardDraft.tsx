import { ArrowUpRight, LayoutDashboard } from "lucide-react";
import { useId, type CSSProperties, type ReactElement } from "react";
import { useAskConfig, type AskDashboardDraft, type AskDashboardDraftWidget } from "../config.tsx";
import {
  sizeLabel,
  timeRangeLabel,
  visualizationLabel,
  widgetGridSize,
  widgetTitle,
} from "./dashboardCatalog.ts";
import { GRID_COLUMNS, fillRowGaps, layoutHeight, packLayout } from "./packLayout.ts";
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
function CellGraphic({ viz, height }: { viz: string; height: number }): ReactElement {
  const rawId = useId();
  const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `draft-grad-${cleanId}`;
  const lineGradId = `draft-line-${cleanId}`;

  switch (viz) {
    case "kpi":
      return (
        <div className={styles.miniKpi}>
          {/* A dash, not a figure: the draft has no data yet, and the same
              invented number on every tile read as the fleet's real total. */}
          <div className={styles.miniKpiValue}>—</div>
        </div>
      );
    case "gauge":
      return (
        <div className={styles.miniGauge}>
          <svg viewBox="0 0 54 30" className={styles.miniSvgGauge} aria-hidden="true">
            <path
              d="M 6 26 A 21 21 0 0 1 48 26"
              fill="none"
              stroke="var(--rule-soft, #e2e8f0)"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="M 6 26 A 21 21 0 0 1 39 10"
              fill="none"
              stroke="#2563eb"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <circle cx="27" cy="25" r="3" fill="var(--fg, #1e293b)" />
            <line x1="27" y1="25" x2="36" y2="14" stroke="var(--fg, #1e293b)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className={styles.miniGaugeVal}>74%</div>
        </div>
      );
    case "line":
    case "area": {
      const mainCurve =
        "M 0 44 C 4.0 43.0, 16.0 38.3, 24 38 C 32.0 37.7, 40.0 43.0, 48 42 C 56.0 41.0, 64.0 33.0, 72 32 C 80.0 31.0, 88.0 37.3, 96 36 C 104.0 34.7, 112.0 25.0, 120 24 C 128.0 23.0, 136.0 31.0, 144 30 C 152.0 29.0, 160.0 19.2, 168 18 C 176.0 16.8, 184.0 23.7, 192 23 C 200.0 22.3, 208.0 14.7, 216 14 C 224.0 13.3, 232.0 19.5, 240 19 C 248.0 18.5, 256.0 11.7, 264 11 C 272.0 10.3, 279.7 15.7, 288 15 C 296.3 14.3, 309.7 8.3, 314 7";

      const prevCurve =
        "M 0 48 C 5.8 47.7, 23.3 45.8, 35 46 C 46.7 46.2, 57.5 50.0, 70 49 C 82.5 48.0, 96.7 41.0, 110 40 C 123.3 39.0, 136.7 44.0, 150 43 C 163.3 42.0, 176.7 35.2, 190 34 C 203.3 32.8, 216.7 37.3, 230 36 C 243.3 34.7, 256.0 28.3, 270 26 C 284.0 23.7, 306.7 22.7, 314 22";

      return (
        <div className={styles.miniChart}>
          <svg
            viewBox="0 0 320 60"
            preserveAspectRatio="none"
            className={styles.miniSvg}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.28" />
                <stop offset="65%" stopColor="#3b82f6" stopOpacity="0.06" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
              </linearGradient>
              <linearGradient id={lineGradId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#60a5fa" />
                <stop offset="60%" stopColor="#2563eb" />
                <stop offset="100%" stopColor="#1d4ed8" />
              </linearGradient>
            </defs>

            {/* Horizontal dashed reference lines */}
            <line
              x1="0"
              y1="14"
              x2="320"
              y2="14"
              stroke="#64748b"
              strokeOpacity="0.1"
              strokeDasharray="3 3"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="0"
              y1="34"
              x2="320"
              y2="34"
              stroke="#64748b"
              strokeOpacity="0.1"
              strokeDasharray="3 3"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="0"
              y1="54"
              x2="320"
              y2="54"
              stroke="#64748b"
              strokeOpacity="0.18"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />

            {/* Comparison period line (dashed) */}
            <path
              d={prevCurve}
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1.2"
              strokeDasharray="2 3"
              strokeOpacity="0.55"
              vectorEffect="non-scaling-stroke"
            />

            {/* Gradient area under main line */}
            <path
              d={`${mainCurve} L 314 54 L 0 54 Z`}
              fill={`url(#${gradId})`}
            />

            {/* Primary trend curve */}
            <path
              d={mainCurve}
              fill="none"
              stroke={`url(#${lineGradId})`}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />

            {/* Endpoint pulse dot */}
            <circle cx="314" cy="7" r="5" fill="#3b82f6" fillOpacity="0.25" />
            <circle cx="314" cy="7" r="2.5" fill="#2563eb" stroke="#ffffff" strokeWidth="1.2" />
          </svg>
          {height > 2 && (
            <div className={styles.chartFoot}>
              <div>30d ago</div>
              <div>15d</div>
              <div>Today</div>
            </div>
          )}
        </div>
      );
    }
    case "bar":
    case "column":
      return (
        <div className={styles.miniBars}>
          <div className={styles.bar} style={{ height: "40%" }} />
          <div className={styles.bar} style={{ height: "65%" }} />
          <div className={styles.bar} style={{ height: "85%" }} />
          <div className={styles.bar} style={{ height: "55%" }} />
          <div className={`${styles.bar} ${styles.barActive}`} style={{ height: "95%" }} />
          <div className={styles.bar} style={{ height: "70%" }} />
          <div className={styles.bar} style={{ height: "45%" }} />
          <div className={styles.bar} style={{ height: "80%" }} />
          <div className={styles.bar} style={{ height: "60%" }} />
        </div>
      );
    // Horizontal bars, not vertical ones with the name changed: the reader
    // should recognise the chart shape they will open, and an hbar drawn as
    // columns is a different chart.
    case "hbar":
      return (
        <div className={styles.miniHbar}>
          <div className={`${styles.hbar} ${styles.hbarActive}`} style={{ width: "86%" }} />
          <div className={styles.hbar} style={{ width: "62%" }} />
          <div className={styles.hbar} style={{ width: "74%" }} />
          <div className={styles.hbar} style={{ width: "40%" }} />
          {height > 2 && <div className={styles.hbar} style={{ width: "52%" }} />}
        </div>
      );
    case "donut":
    case "pie":
      return (
        <div className={styles.miniDonut}>
          <svg viewBox="0 0 36 36" className={styles.miniSvgDonut} aria-hidden="true">
            <circle cx="18" cy="18" r="13" fill="none" stroke="var(--rule-soft, #f1f5f9)" strokeWidth="4.5" />
            <circle
              cx="18"
              cy="18"
              r="13"
              fill="none"
              stroke="#2563eb"
              strokeWidth="4.5"
              strokeDasharray="48 34"
              strokeDashoffset="20"
              strokeLinecap="round"
            />
            <circle
              cx="18"
              cy="18"
              r="13"
              fill="none"
              stroke="#10b981"
              strokeWidth="4.5"
              strokeDasharray="20 62"
              strokeDashoffset="-28"
              strokeLinecap="round"
            />
            <circle
              cx="18"
              cy="18"
              r="13"
              fill="none"
              stroke="#f59e0b"
              strokeWidth="4.5"
              strokeDasharray="12 70"
              strokeDashoffset="-48"
              strokeLinecap="round"
            />
          </svg>
          <div className={styles.miniDonutLegend}>
            <div className={styles.legendRow}><div className={styles.dotBlue} /> 58%</div>
            <div className={styles.legendRow}><div className={styles.dotGreen} /> 28%</div>
            <div className={styles.legendRow}><div className={styles.dotAmber} /> 14%</div>
          </div>
        </div>
      );
    case "table":
      return (
        <div className={styles.miniTable}>
          <div className={styles.tableRowHead}>
            <div className={styles.tableColHead} style={{ width: "40%" }} />
            <div className={styles.tableColHead} style={{ width: "30%" }} />
            <div className={styles.tableColHead} style={{ width: "20%" }} />
          </div>
          <div className={styles.tableRow}>
            <div className={styles.tableCol} style={{ width: "45%" }} />
            <div className={styles.tableCol} style={{ width: "25%" }} />
            <div className={styles.tableCol} style={{ width: "18%" }} />
          </div>
          <div className={styles.tableRow}>
            <div className={styles.tableCol} style={{ width: "38%" }} />
            <div className={styles.tableCol} style={{ width: "32%" }} />
            <div className={styles.tableCol} style={{ width: "22%" }} />
          </div>
          {height > 2 && (
            <div className={styles.tableRow}>
              <div className={styles.tableCol} style={{ width: "50%" }} />
              <div className={styles.tableCol} style={{ width: "20%" }} />
              <div className={styles.tableCol} style={{ width: "15%" }} />
            </div>
          )}
        </div>
      );
    default:
      return (
        <div className={styles.miniBars}>
          <div className={styles.bar} style={{ height: "50%" }} />
          <div className={styles.bar} style={{ height: "85%" }} />
          <div className={styles.bar} style={{ height: "65%" }} />
        </div>
      );
  }
}

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
  const rects = fillRowGaps(packLayout(widgets.map(widgetGridSize)));
  const rows = layoutHeight(rects);
  return (
    <div className={styles.thumbWrapper}>
      <div className={styles.thumbHeader}>
        <div className={styles.thumbDots} aria-hidden="true">
          <div className={styles.dot} />
          <div className={styles.dot} />
          <div className={styles.dot} />
        </div>
        <div className={styles.thumbTitle}>Layout preview · no data yet</div>
      </div>
      <div
        className={styles.thumb}
        role="img"
        aria-label={`Layout preview: ${widgets.length} widget${widgets.length === 1 ? "" : "s"} on a ${GRID_COLUMNS}-column grid`}
        style={{ gridTemplateRows: `repeat(${rows}, var(--thumb-row))` } as CSSProperties}
      >
        {rects.map((rect, index) => {
          const widget = widgets[index];
          if (!widget) return null;
          const title = widgetTitle(widget);
          return (
            <span
              // Positional: the thumbnail is the list, in order, and has no ids.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className={styles.cell}
              data-viz={widget.visualization}
              title={`${title} (${visualizationLabel(widget.visualization)})`}
              style={{
                gridColumn: `${rect.x + 1} / span ${rect.w}`,
                gridRow: `${rect.y + 1} / span ${rect.h}`,
              }}
            >
              <div className={styles.cellHead}>
                <div className={styles.cellIcon}>
                  <VisualizationIcon visualization={widget.visualization} size={11} />
                </div>
                <div className={styles.cellTitle}>{title}</div>
                {(widget.visualization === "bar" || widget.visualization === "column" || widget.visualization === "hbar") && (
                  <div className={styles.cellBadgeNeutral}>Top 8</div>
                )}
              </div>
              <div className={styles.cellBody}>
                <CellGraphic viz={widget.visualization} height={rect.h} />
              </div>
            </span>
          );
        })}
      </div>
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
