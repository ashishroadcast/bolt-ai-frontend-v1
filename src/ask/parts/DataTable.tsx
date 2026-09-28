import { ChevronLeft, ChevronRight, Table2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Sheet } from "./Sheet.tsx";
import styles from "./DataTable.module.css";

export type DataTableColumnType = "text" | "number" | "currency" | "percent" | "share";

export interface DataTableColumn {
  /**
   * Row key this column reads, unique within the table. Not the column's
   * name: a join selects two columns called `name`, and keyed by name the
   * second overwrote the first. `wireParts.adaptTable` keys by position.
   */
  key: string;
  /** Header label — what the column is, not how it's typed. */
  header: string;
  /** Defaults to "text". Only "share" draws the magnitude bar. */
  type?: DataTableColumnType;
}

export type DataTableCellValue = string | number;

export interface DataTableRow {
  [columnKey: string]: DataTableCellValue;
}

export interface DataTableProps {
  title: string;
  subLabel?: string;
  columns: DataTableColumn[];
  rows: DataTableRow[];
  /** Shown in place of the body when there are no rows for the window asked. */
  emptyMessage?: string;
}

/**
 * How many rows a reader gets before the table starts paging.
 *
 * Saurabh, on a run that returned 267 rows and another that returned
 * 1000: "tables anything more than 10 should be paginated, i am doing
 * endless scrolling". Ten because a top-ten ranking — the longest table
 * routinely read straight through — must still fit on one page, so paging
 * never appears on an answer that had no reason to page.
 */
const ROWS_PER_PAGE = 10;

const NUMERIC_TYPES = new Set<DataTableColumnType>(["number", "currency", "percent", "share"]);

function isNumeric(type: DataTableColumnType): boolean {
  return NUMERIC_TYPES.has(type);
}

function formatCell(value: DataTableCellValue, type: DataTableColumnType): string {
  if (typeof value !== "number") return value;
  switch (type) {
    case "currency":
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
      }).format(value);
    case "percent":
    case "share":
      return `${value.toFixed(1)}%`;
    default:
      return new Intl.NumberFormat("en-IN").format(value);
  }
}

// The share bar reads relative to the largest value in its own column, not
// an absolute scale — a full bar means "the leader", same as the mockup.
// Deliberately measured over every row rather than the visible page: a bar
// that rescales as you page would say a different thing about the same
// number on page 2 than it did on page 1.
function shareColumnMax(rows: DataTableRow[], key: string): number {
  let max = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "number" && value > max) max = value;
  }
  return max > 0 ? max : 1;
}

const COUNT = new Intl.NumberFormat("en-IN");

/**
 * A row count, grouped the way the pager writes it. Exported so the
 * "12,345 rows" a table's header carries (`wireParts.adaptTable`) cannot
 * drift from the "of 12,345" under it.
 */
export function formatRowCount(count: number): string {
  return COUNT.format(count);
}

interface PagerProps {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}

/**
 * The page controls, and the count they move through.
 *
 * The range reads "11–20 of 267" rather than only a page number: the
 * question a reader has at the foot of a result is how much of it they
 * have seen, and "page 2 of 27" answers that only after arithmetic. It is
 * a live region because the rows above it change without anything moving
 * focus, so a screen reader would otherwise get no notice at all.
 */
function Pager({ page, pageCount, total, onPage }: PagerProps): ReactElement {
  const first = page * ROWS_PER_PAGE + 1;
  const last = Math.min((page + 1) * ROWS_PER_PAGE, total);

  return (
    <div className={styles.pager}>
      <span className={styles.range} aria-live="polite">
        {COUNT.format(first)}–{COUNT.format(last)} of {COUNT.format(total)}
      </span>
      <div className={styles.pageControls}>
        <button
          type="button"
          className={styles.pageBtn}
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          aria-label="Previous page"
        >
          <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" />
          <span>Prev</span>
        </button>
        <span className={styles.pageOf}>
          {COUNT.format(page + 1)} / {COUNT.format(pageCount)}
        </span>
        <button
          type="button"
          className={styles.pageBtn}
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount - 1}
          aria-label="Next page"
        >
          <span>Next</span>
          <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/**
 * The first mockup sheet: columns, alignment, tabular figures, the share
 * bar. Renders from plain data only — no render props, no functions in
 * props — because this sits at the wire boundary: a future intent payload
 * is JSON, and a component that needs a callback to render itself can't be
 * driven by that.
 *
 * **Paged past ten rows** (`ROWS_PER_PAGE`). This is a different rule from
 * `chat/partLayout.ts`'s: that one decides whether a big table is folded
 * away behind its row count at all, and this one decides what you get once
 * you open it. Both were needed — folding a 267-row table behind a
 * disclosure and then unfolding all 267 rows is still endless scrolling.
 */
export function DataTable({
  title,
  subLabel,
  columns,
  rows,
  emptyMessage = "No rows for this window.",
}: DataTableProps): ReactElement {
  const [requestedPage, setRequestedPage] = useState(0);

  const shareColumn = columns.find((column) => column.type === "share");
  const shareMax = shareColumn ? shareColumnMax(rows, shareColumn.key) : 0;

  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  // Clamped on render rather than reset in an effect: a streaming run
  // appends rows to a table already on screen, and the page someone is
  // reading only becomes invalid if the table shrinks under them.
  const page = Math.min(requestedPage, pageCount - 1);
  const isPaged = rows.length > ROWS_PER_PAGE;
  const visibleRows = isPaged ? rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE) : rows;

  return (
    <Sheet title={title} subLabel={subLabel} icon={Table2}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={isNumeric(column.type ?? "text") ? styles.num : undefined}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          {rows.length === 0 ? (
            <tbody>
              <tr>
                <td className={styles.emptyCell} colSpan={columns.length || 1}>
                  {emptyMessage}
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                // Rows are a data snapshot for one render, not a reorderable
                // list, and carry no guaranteed unique field to key on.
                // eslint-disable-next-line react/no-array-index-key
                <tr key={rowIndex}>
                  {columns.map((column) => {
                    const type = column.type ?? "text";
                    const value = row[column.key];
                    if (type === "share" && typeof value === "number") {
                      const width = (value / shareMax) * 100;
                      return (
                        <td key={column.key} className={styles.num}>
                          <span className={styles.share}>
                            <span className={styles.sparkbar}>
                              <span className={styles.sparkbarFill} style={{ width: `${width}%` }} />
                            </span>
                            {formatCell(value, type)}
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={column.key} className={isNumeric(type) ? styles.num : undefined}>
                        {value === undefined ? "" : formatCell(value, type)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {isPaged && (
        <Pager page={page} pageCount={pageCount} total={rows.length} onPage={setRequestedPage} />
      )}
    </Sheet>
  );
}
