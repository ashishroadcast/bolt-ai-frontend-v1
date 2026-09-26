import { describe, expect, it } from "vitest";
import { GRID_COLUMNS, fillRowGaps, layoutHeight, packLayout, type GridRect, type GridSize } from "./packLayout.ts";
import { WIDGET_SIZES } from "./dashboardCatalog.ts";

const { small, medium, large, wide, full } = WIDGET_SIZES;

function overlaps(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A small deterministic PRNG, so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("packLayout", () => {
  it("puts a KPI row across the top, four abreast", () => {
    expect(packLayout([small, small, small, small])).toEqual([
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
      { x: 6, y: 0, w: 3, h: 2 },
      { x: 9, y: 0, w: 3, h: 2 },
    ]);
  });

  it("fills the first free cell, top-left first, in the order given", () => {
    // The F1 landing shape: KPIs, then the trend beside a doughnut, then a
    // ranked bar beside a table.
    expect(packLayout([small, small, small, small, wide, medium, large, large])).toEqual([
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
      { x: 6, y: 0, w: 3, h: 2 },
      { x: 9, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 8, h: 4 },
      { x: 8, y: 2, w: 4, h: 4 },
      { x: 0, y: 6, w: 6, h: 5 },
      { x: 6, y: 6, w: 6, h: 5 },
    ]);
  });

  it("keeps reading order: a later widget never jumps back into an earlier gap", () => {
    // Same as the builder's packer, so the thumbnail is the canvas.
    const rects = packLayout([wide, full, small]);
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 8, h: 4 });
    expect(rects[1]).toEqual({ x: 0, y: 4, w: 12, h: 5 });
    expect(rects[2]).toEqual({ x: 0, y: 9, w: 3, h: 2 });
  });

  it("packs around widgets already on the canvas, into the first free slot", () => {
    const existing: GridRect[] = [
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
    ];
    expect(packLayout([small], { existing })).toEqual([{ x: 6, y: 0, w: 3, h: 2 }]);
    expect(packLayout([wide], { existing })).toEqual([{ x: 0, y: 2, w: 8, h: 4 }]);
  });

  it("clamps a size wider than the grid and a nonsensical one to something placeable", () => {
    expect(packLayout([{ w: 20, h: 3 }])).toEqual([{ x: 0, y: 0, w: 12, h: 3 }]);
    expect(packLayout([{ w: 0, h: -2 }])).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(packLayout([{ w: Number.NaN, h: 2 }])).toEqual([{ x: 0, y: 0, w: 1, h: 2 }]);
  });

  it("returns nothing for nothing", () => {
    expect(packLayout([])).toEqual([]);
    expect(layoutHeight([])).toBe(0);
  });

  it("reports the rows a layout occupies", () => {
    // small (0,0), wide beside it (3,0), medium under both at y=4.
    expect(layoutHeight(packLayout([small, wide, medium]))).toBe(8);
  });

  it("over 200 random layouts: in bounds, no overlaps, order and sizes kept, deterministic", () => {
    const random = mulberry32(20260924);
    const choices = [small, medium, large, wide, full];
    for (let run = 0; run < 200; run += 1) {
      const count = 1 + Math.floor(random() * 30);
      const sizes: GridSize[] = Array.from({ length: count }, () => {
        // Mostly the named sizes, sometimes an arbitrary one.
        if (random() < 0.8) return choices[Math.floor(random() * choices.length)]!;
        return { w: 1 + Math.floor(random() * 12), h: 1 + Math.floor(random() * 12) };
      });

      const rects = packLayout(sizes);
      expect(rects).toHaveLength(sizes.length);
      rects.forEach((rect, index) => {
        expect(rect.w).toBe(sizes[index]!.w);
        expect(rect.h).toBe(sizes[index]!.h);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(GRID_COLUMNS);
        for (let other = 0; other < index; other += 1) {
          expect(overlaps(rect, rects[other]!)).toBe(false);
        }
        if (index > 0) {
          const previous = rects[index - 1]!;
          expect(rect.y > previous.y || (rect.y === previous.y && rect.x >= previous.x)).toBe(true);
        }
      });
      expect(packLayout(sizes)).toEqual(rects);
    }
  });
});

describe("fillRowGaps", () => {
  it("widens a lone wide chart to the full row instead of leaving 4 dead columns", () => {
    expect(fillRowGaps(packLayout([small, small, small, small, wide, wide]))).toEqual([
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 3, y: 0, w: 3, h: 2 },
      { x: 6, y: 0, w: 3, h: 2 },
      { x: 9, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 12, h: 4 },
      { x: 0, y: 6, w: 12, h: 4 },
    ]);
  });

  it("spreads the spare columns across a short row", () => {
    expect(fillRowGaps(packLayout([small, small, small]))).toEqual([
      { x: 0, y: 0, w: 4, h: 2 },
      { x: 4, y: 0, w: 4, h: 2 },
      { x: 8, y: 0, w: 4, h: 2 },
    ]);
  });

  it("leaves full rows and rows with something beside them alone", () => {
    const packed = packLayout([small, small, small, small, wide, medium, large, small, small]);
    const filled = fillRowGaps(packed);
    expect(filled.slice(0, 6)).toEqual(packed.slice(0, 6));
    // large (6x5) with two smalls beside it: the smalls' row is already full.
    expect(filled[6]).toEqual(packed[6]);
  });

  it("never widens into a widget already on the canvas", () => {
    const existing: GridRect[] = [{ x: 8, y: 0, w: 4, h: 4 }];
    expect(fillRowGaps(packLayout([wide], { existing }), { existing })).toEqual([{ x: 0, y: 0, w: 8, h: 4 }]);
  });

  it("over 200 random layouts: in bounds, no overlaps, rows and order kept, only ever wider", () => {
    const random = mulberry32(20260925);
    const choices = [small, medium, large, wide, full];
    for (let run = 0; run < 200; run += 1) {
      const count = 1 + Math.floor(random() * 20);
      const sizes = Array.from({ length: count }, () => choices[Math.floor(random() * choices.length)]!);
      const packed = packLayout(sizes);
      const filled = fillRowGaps(packed);
      filled.forEach((rect, index) => {
        const before = packed[index]!;
        expect(rect.y).toBe(before.y);
        expect(rect.h).toBe(before.h);
        expect(rect.w).toBeGreaterThanOrEqual(before.w);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(GRID_COLUMNS);
        for (let other = 0; other < index; other += 1) {
          expect(overlaps(rect, filled[other]!)).toBe(false);
        }
      });
    }
  });
});
