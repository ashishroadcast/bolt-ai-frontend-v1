/**
 * Turns an ordered list of widget sizes into non-overlapping grid rectangles.
 *
 * A port of the dashboard builder's `packLayout()` (bolt-v2's
 * `layout-packer.ts`, DYNAMIC_DASHBOARDS_PLAN §0.5): the AI only ever says
 * ORDER and SIZE, and the host turns that into `{x, y, w, h}`. The card here
 * uses it for its thumbnail, so the preview is the layout the builder will
 * actually open with — two packers that disagree would show one arrangement
 * in the panel and another on the canvas.
 *
 * The algorithm is first-fit with top-left gravity: each widget, in order,
 * takes the first free cell scanning rows top to bottom and, within a row,
 * columns left to right. Pure and deterministic — the same input always packs
 * the same way, which is what makes it testable and what keeps the thumbnail
 * from reshuffling on a re-render.
 */

export interface GridSize {
  w: number;
  h: number;
}

export interface GridRect extends GridSize {
  x: number;
  y: number;
}

/** The dashboard grid's width (CONTRACT §2). */
export const GRID_COLUMNS = 12;

function overlaps(a: GridRect, b: GridRect): boolean {
  // Touching edges is fine (CONTRACT §2), so strict inequalities.
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function normalised(size: GridSize, columns: number): GridSize {
  const w = Number.isFinite(size.w) ? Math.round(size.w) : 1;
  const h = Number.isFinite(size.h) ? Math.round(size.h) : 1;
  return { w: Math.min(Math.max(w, 1), columns), h: Math.max(h, 1) };
}

/**
 * Packs `sizes` in order. `existing` rectangles (widgets already on a canvas)
 * are kept where they are and packed around; they are not returned.
 */
export function packLayout(
  sizes: readonly GridSize[],
  options: { columns?: number; existing?: readonly GridRect[] } = {},
): GridRect[] {
  const columns = Math.max(1, Math.round(options.columns ?? GRID_COLUMNS));
  const placed: GridRect[] = [...(options.existing ?? [])];
  const packed: GridRect[] = [];

  for (const size of sizes) {
    const { w, h } = normalised(size, columns);
    // Terminates: at y = the lowest bottom edge so far, the whole row band is
    // empty, so x = 0 always fits there.
    for (let y = 0; ; y += 1) {
      let slot: GridRect | null = null;
      for (let x = 0; x + w <= columns; x += 1) {
        const candidate = { x, y, w, h };
        if (!placed.some((rect) => overlaps(rect, candidate))) {
          slot = candidate;
          break;
        }
      }
      if (slot !== null) {
        placed.push(slot);
        packed.push(slot);
        break;
      }
    }
  }

  return packed;
}

/** How many rows a packed layout occupies. */
export function layoutHeight(rects: readonly GridRect[]): number {
  return rects.reduce((bottom, rect) => Math.max(bottom, rect.y + rect.h), 0);
}
