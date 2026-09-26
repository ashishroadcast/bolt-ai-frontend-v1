import type { ComponentType, ReactElement } from "react";
import { DataTable, type DataTableProps } from "./DataTable.tsx";
import { DataChart, type DataChartProps } from "./DataChart.tsx";
import { DataStats, type DataStatsProps } from "./DataStats.tsx";
import { DataComparison, type DataComparisonProps } from "./DataComparison.tsx";
import { DataQuestion, type DataQuestionProps } from "./DataQuestion.tsx";
import { DataSummary, type DataSummaryProps } from "./DataSummary.tsx";
import { Citations, type CitationsProps } from "./Citations.tsx";
import { FormDraft, type FormDraftProps } from "./FormDraft.tsx";
import { DashboardDraft, type DashboardDraftProps } from "./DashboardDraft.tsx";
import { WidgetDraft, type WidgetDraftProps } from "./WidgetDraft.tsx";
import { UnknownIntent } from "./UnknownIntent.tsx";

/*
 * The server streams semantic intents ("a comparison table of these
 * rows"), never markup — the intent-to-component mapping lives here, in
 * the console, so a future A2UI renderer for the Angular apps can consume
 * the same intents against its own map (design plan §10.1). That only
 * holds if this stays one obvious, swappable structure: a single Record
 * from intent name to component. To add a new intent, add one entry here.
 * To swap what renders "data-table", change one line. Nothing about the
 * mapping mechanism should ever need to grow past this Record — per-case
 * logic belongs inside the component it names, not here.
 */
export type UIPartIntent =
  | "data-table"
  | "data-chart"
  | "data-stats"
  | "data-comparison"
  | "data-summary"
  | "data-question"
  | "data-form-draft"
  | "data-dashboard-draft"
  | "data-widget-draft"
  | "citations";

export interface UIPartDataByIntent {
  "data-table": DataTableProps;
  "data-chart": DataChartProps;
  "data-stats": DataStatsProps;
  "data-comparison": DataComparisonProps;
  "data-summary": DataSummaryProps;
  "data-question": DataQuestionProps;
  "data-form-draft": FormDraftProps;
  "data-dashboard-draft": DashboardDraftProps;
  "data-widget-draft": WidgetDraftProps;
  citations: CitationsProps;
}

/**
 * A `ui_part` as it arrives off the wire (`messages.meta.ui_parts`, or a
 * persisted part re-rendered on reopen): an intent name plus its payload.
 * `data` is `unknown` here on purpose — the payload is only as trustworthy
 * as whatever produced it, and the catalog is the single point where it
 * gets treated as one specific component's props.
 */
export interface UIPart {
  intent: string;
  data: unknown;
}

// The swappable map itself. `ComponentType<any>` is confined to this one
// line: a Record can't express "the value type depends on the key" without
// value-level type gymnastics that would outweigh what this catalog is for
// (see UIPartDataByIntent for what each entry's data actually shapes as).
const componentCatalog: Record<UIPartIntent, ComponentType<any>> = {
  "data-table": DataTable,
  "data-chart": DataChart,
  "data-stats": DataStats,
  "data-comparison": DataComparison,
  "data-summary": DataSummary,
  "data-question": DataQuestion,
  "data-form-draft": FormDraft,
  "data-dashboard-draft": DashboardDraft,
  "data-widget-draft": WidgetDraft,
  citations: Citations,
};

function isKnownIntent(intent: string): intent is UIPartIntent {
  return Object.hasOwn(componentCatalog, intent);
}

/**
 * Renders one `ui_part`. Required, not defensive padding: the agent will
 * one day emit an intent this bundle predates, and that must render as
 * something honest and legible — UnknownIntent — rather than throw and
 * take the rest of the thread down with it, or drop the answer silently.
 */
export function renderUIPart(part: UIPart): ReactElement {
  if (!isKnownIntent(part.intent)) {
    return <UnknownIntent intent={part.intent} />;
  }
  const Component = componentCatalog[part.intent];
  return <Component {...(part.data as object)} />;
}
