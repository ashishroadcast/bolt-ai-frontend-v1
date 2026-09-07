import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../api/errors.ts";
import { ChunksPanel } from "./ChunksPanel.tsx";
import * as documentsApi from "./documentsApi.ts";
import type { DocumentChunk, DocumentChunkPage, DocumentRecord } from "./documentsApi.ts";

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 1,
    datasource_id: 5,
    filename: "menu.pdf",
    content_type: "application/pdf",
    size_bytes: 2048,
    status: "ready",
    page_count: 4,
    figure_count: 0,
    chunk_count: 3,
    vision_cost_usd: 0,
    error: null,
    created_at: "2026-08-27T10:00:00Z",
    tags: [],
    required_permission: null,
    ...overrides,
  };
}

function chunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    id: 1,
    ordinal: 0,
    text: "plain chunk text",
    headings: null,
    page_no: null,
    bbox: null,
    kind: "text",
    ...overrides,
  };
}

function page(overrides: Partial<DocumentChunkPage> = {}): DocumentChunkPage {
  return { items: [], next_cursor: null, has_more: false, ...overrides };
}

describe("ChunksPanel", () => {
  let listSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listSpy = vi.spyOn(documentsApi, "listDocumentChunks");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a distinct still-processing state for a working document", async () => {
    listSpy.mockResolvedValue(page());

    render(<ChunksPanel document={doc({ status: "chunking" })} onClose={() => {}} />);

    expect(await screen.findByText(/still processing/i)).toBeInTheDocument();
    expect(screen.getByText(/chunking/i)).toBeInTheDocument();
    expect(screen.queryByText(/ingestion failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no chunks were recorded/i)).not.toBeInTheDocument();
  });

  it("shows the document's own error for a failed document, distinct from the other states", async () => {
    listSpy.mockResolvedValue(page());

    render(
      <ChunksPanel
        document={doc({ status: "failed", error: "could not parse page 4" })}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/ingestion failed/i)).toBeInTheDocument();
    expect(screen.getByText(/could not parse page 4/i)).toBeInTheDocument();
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no chunks were recorded/i)).not.toBeInTheDocument();
  });

  it("shows a genuinely-empty message for a ready document with zero chunks, distinct from working/failed", async () => {
    listSpy.mockResolvedValue(page());

    render(<ChunksPanel document={doc({ status: "ready", chunk_count: 0 })} onClose={() => {}} />);

    expect(await screen.findByText(/no chunks were recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/still processing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ingestion failed/i)).not.toBeInTheDocument();
  });

  it("renders chunks in order with the metadata the chunker recorded", async () => {
    listSpy.mockResolvedValue(
      page({
        items: [
          chunk({ id: 10, ordinal: 0, text: "first chunk", kind: "text" }),
          chunk({
            id: 11,
            ordinal: 1,
            text: "| Item | Price |\n| Dosa | 80 |",
            kind: "table",
            page_no: 3,
            headings: ["Menu", "South Indian"],
          }),
        ],
      }),
    );

    render(<ChunksPanel document={doc()} onClose={() => {}} />);

    const rows = await screen.findAllByTestId("chunk-card");
    expect(rows).toHaveLength(2);
    // Order preserved as returned (already ordinal-sorted by the server).
    expect(within(rows[0]!).getByText("first chunk")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Dosa/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/table/i)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/page 3/i)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Menu/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/South Indian/)).toBeInTheDocument();
  });

  it("filters the loaded chunks by a search term across text and headings", async () => {
    listSpy.mockResolvedValue(
      page({
        items: [
          chunk({ id: 1, ordinal: 0, text: "how to void a bill" }),
          chunk({ id: 2, ordinal: 1, text: "refund policy for dine-in", headings: ["Refunds"] }),
        ],
      }),
    );

    render(<ChunksPanel document={doc()} onClose={() => {}} />);
    await screen.findAllByTestId("chunk-card");

    fireEvent.change(screen.getByLabelText(/search chunks/i), { target: { value: "refund" } });

    const visible = screen.getAllByTestId("chunk-card");
    expect(visible).toHaveLength(1);
    expect(within(visible[0]!).getByText(/refund policy/i)).toBeInTheDocument();
  });

  it("loads the next page on demand and appends it, hiding Load more once exhausted", async () => {
    listSpy
      .mockResolvedValueOnce(
        page({ items: [chunk({ id: 1, ordinal: 0, text: "page one chunk" })], next_cursor: 0, has_more: true }),
      )
      .mockResolvedValueOnce(
        page({ items: [chunk({ id: 2, ordinal: 1, text: "page two chunk" })], next_cursor: null, has_more: false }),
      );

    render(<ChunksPanel document={doc()} onClose={() => {}} />);
    await screen.findByText("page one chunk");

    const loadMore = screen.getByRole("button", { name: /load more/i });
    fireEvent.click(loadMore);

    await screen.findByText("page two chunk");
    expect(screen.getByText("page one chunk")).toBeInTheDocument();
    expect(listSpy).toHaveBeenLastCalledWith(1, { cursor: 0, limit: expect.any(Number) });
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("shows a retryable error when the chunks request itself fails", async () => {
    listSpy
      .mockRejectedValueOnce(new GatewayError("network blip"))
      .mockResolvedValueOnce(page({ items: [chunk({ text: "recovered chunk" })] }));

    render(<ChunksPanel document={doc()} onClose={() => {}} />);

    expect(await screen.findByText(/network blip/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await screen.findByText("recovered chunk");
  });

  it("contains long or wide chunk content inside its own scroll region, never the page body", () => {
    // A class assertion alone can't prove the rule still exists — read the
    // actual stylesheet so this fails if the scroll containment is ever
    // dropped from `.text` (one chunk's own body, which can be far wider
    // than the panel when it's a transcribed markdown table) or from
    // `.body` (the panel's own scroll region for a long chunk list).
    const css = readFileSync(join(import.meta.dirname, "ChunksPanel.module.css"), "utf8");

    const textRule = css.slice(css.indexOf(".text {"), css.indexOf(".text {") + 400);
    expect(textRule).toContain("overflow: auto");
    expect(textRule).toContain("max-height");

    const bodyRule = css.slice(css.indexOf(".body {"), css.indexOf(".body {") + 300);
    expect(bodyRule).toContain("overflow-y: auto");
  });

  it("calls onClose from the close control", async () => {
    listSpy.mockResolvedValue(page());
    const onClose = vi.fn();

    render(<ChunksPanel document={doc()} onClose={onClose} />);
    await screen.findByText(/no chunks were recorded/i);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
