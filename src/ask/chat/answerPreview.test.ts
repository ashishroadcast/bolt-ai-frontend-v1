import { describe, expect, it } from "vitest";
import { answerPreview } from "./answerPreview.ts";

describe("answerPreview", () => {
  it("turns a pipe-delimited table dump into something a row can actually be read as", () => {
    const dump = [
      "| store_id | store_name | net_sales |",
      "|---------:|:-----------|----------:|",
      "| 280 | The Bombay Canteen | 29082789.84 |",
    ].join("\n");

    expect(answerPreview(dump)).toBe(
      "store_id · store_name · net_sales · 280 · The Bombay Canteen · 29082789.84",
    );
  });

  it("drops the separator row, which is scaffolding and never content", () => {
    expect(answerPreview("a | b\n---|---\n1 | 2")).not.toContain("---");
  });

  it("leaves ordinary prose alone apart from collapsing its line breaks", () => {
    expect(answerPreview("Top store: The Bombay Canteen.\nFifth: Naturals Now Juhu.")).toBe(
      "Top store: The Bombay Canteen. · Fifth: Naturals Now Juhu.",
    );
  });

  it("strips markdown that has no renderer in a one-line row", () => {
    expect(answerPreview("## Summary\n**Bandra** led on `net_sales`")).toBe("Summary · Bandra led on net_sales");
  });

  it("cuts to a readable length with an ellipsis rather than handing the CSS a paragraph", () => {
    const long = "word ".repeat(80);
    const preview = answerPreview(long)!;

    expect(preview.length).toBeLessThanOrEqual(141);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns null — never an empty or invented string — when there is nothing to show", () => {
    expect(answerPreview("")).toBeNull();
    expect(answerPreview(null)).toBeNull();
    expect(answerPreview("   \n |---| \n  ")).toBeNull();
  });
});
