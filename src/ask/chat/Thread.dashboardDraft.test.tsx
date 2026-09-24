import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Thread } from "./Thread.tsx";
import type { UseChatResult } from "./useChat.ts";
import { TestAskProvider } from "../testing.tsx";
import type { AskConfig, WidgetDraftAck } from "../config.tsx";
import { resetWidgetDraftsForTests } from "../parts/widgetDraftStore.ts";

/**
 * The `/form` regression, pre-empted for dashboards: `showQueryResults`
 * defaults OFF for a tenant, and a drafted View or widget must survive it
 * (Thread.formDraft.test.tsx has the story). Plus the auto-insert rule, end
 * to end: a live widget draft inserts exactly once even though the card
 * remounts when the run finishes, and the same part reopened from history
 * never inserts by itself.
 */

function sseResponse(frames: string[]): Response {
  const text = frames.map((frame) => `${frame}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const DASHBOARD = {
  draftId: "dash-1",
  name: "Operations Overview",
  widgets: [{ metricKey: "eta.trips_completed", visualization: "kpi", size: "small" }],
};

const WIDGET = {
  draftId: "widget-1",
  widget: { metricKey: "eta.trips_completed_daily", visualization: "line", title: "Trips per day" },
};

const FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  // Evidence alongside, so the test proves the split rather than "everything renders".
  `data: {"type":"data-table","data":{"columns":["item"],"rows":[["Existing widget"]]}}`,
  `data: {"type":"data-dashboard-draft","data":${JSON.stringify(DASHBOARD)}}`,
  `data: {"type":"data-widget-draft","data":${JSON.stringify(WIDGET)}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"Drafted."}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"cost_usd":0,"duration_ms":10}}}`,
  `data: [DONE]`,
];

const CONVERSATION = {
  id: 7,
  title: null,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
  messages: [
    {
      id: 1,
      role: "user",
      content: "trips per day",
      agent_id: null,
      trace_id: null,
      meta: null,
      created_at: "2026-09-20T10:00:00Z",
    },
    {
      id: 2,
      role: "assistant",
      content: "Drafted.",
      agent_id: null,
      trace_id: null,
      meta: { ui_parts: [{ type: "data-widget-draft", data: { ...WIDGET, draftId: "widget-old" } }] },
      created_at: "2026-09-20T10:00:01Z",
    },
  ],
};

function routeFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/agent/agents")) return Promise.resolve(json([]));
    if (url.includes("/agent/conversations/7")) return Promise.resolve(json(CONVERSATION));
    return Promise.resolve(sseResponse(FRAMES));
  });
}

function renderThread(config: Partial<AskConfig>) {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }
  render(
    <TestAskProvider config={config}>
      <ChatProvider>
        <Capture />
        <Thread />
      </ChatProvider>
    </TestAskProvider>,
  );
  return chatRef;
}

describe("Thread — drafted dashboards and widgets", () => {
  beforeEach(() => vi.stubGlobal("fetch", routeFetch()));
  afterEach(() => {
    vi.unstubAllGlobals();
    resetWidgetDraftsForTests();
  });

  it("renders both drafts with query results switched OFF, and keeps the evidence hidden", async () => {
    const chatRef = renderThread({ disclosure: { showReasoning: false, showQueryResults: false } });
    await waitFor(() => expect(chatRef.current).not.toBeNull());
    await act(async () => {
      await chatRef.current!.sendMessage("an operations overview");
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Operations Overview" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Trips per day" })).toBeInTheDocument();
    expect(screen.queryByText("Existing widget")).not.toBeInTheDocument();
  });

  it("inserts a live widget draft exactly once across the run finishing", async () => {
    const onWidgetDraft = vi.fn(() => Promise.resolve<WidgetDraftAck>({ status: "added", widgetId: "w-1" }));
    const chatRef = renderThread({
      disclosure: { showReasoning: false, showQueryResults: false },
      onWidgetDraft,
    });
    await waitFor(() => expect(chatRef.current).not.toBeNull());
    await act(async () => {
      await chatRef.current!.sendMessage("trips per day as a line chart");
    });

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));
    expect(await screen.findByText("Added to your view — not saved yet")).toBeInTheDocument();
    expect(onWidgetDraft).toHaveBeenCalledTimes(1);
    expect(onWidgetDraft).toHaveBeenCalledWith({ draftId: "widget-1", widget: WIDGET.widget });
  });

  it("never inserts a widget draft reopened from history — it offers Add to view", async () => {
    const onWidgetDraft = vi.fn(() => Promise.resolve<WidgetDraftAck>({ status: "added", widgetId: "w-1" }));
    const chatRef = renderThread({ onWidgetDraft });
    await waitFor(() => expect(chatRef.current).not.toBeNull());
    await act(async () => {
      await chatRef.current!.loadConversation(7);
    });

    expect(await screen.findByRole("button", { name: /Add to view/ })).toBeInTheDocument();
    expect(onWidgetDraft).not.toHaveBeenCalled();
  });
});
