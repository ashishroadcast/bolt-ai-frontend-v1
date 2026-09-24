import {
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartLine,
  ChartPie,
  Gauge,
  Hash,
  Table2,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

/** One glyph per graph style, so a widget list scans by shape before words. */
const ICONS: Record<string, LucideIcon> = {
  kpi: Hash,
  gauge: Gauge,
  line: ChartLine,
  area: ChartArea,
  bar: ChartColumn,
  hbar: ChartBar,
  pie: ChartPie,
  donut: ChartPie,
  table: Table2,
};

export function VisualizationIcon({
  visualization,
  size = 13,
}: {
  visualization: string;
  size?: number;
}): ReactElement {
  // An unknown style still gets a chart glyph rather than a gap in the column.
  const Icon = ICONS[visualization] ?? ChartColumn;
  return <Icon size={size} strokeWidth={2.25} aria-hidden="true" />;
}
