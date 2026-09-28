import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskInspectorProvider } from "../config.tsx";
import { TestAskProvider } from "../testing.tsx";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Thread } from "./Thread.tsx";
import type { UseChatResult } from "./useChat.ts";

/**
 * What a reader sees when the tenant has NOT turned the machinery on.
 *
 * Ask showed every reasoning step and rendered every tool result as a table.
 * For whoever built the agent that is the point; for the operator it was
 * built for, a 762-row table between the question and the answer reads as the
 * product being broken rather than being transparent. These pin the quiet
 * default — and that turning it back on still works, because a default nobody
 * can override is not a default.
 */

const FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"data-phase","data":{"phase":"research","state":"done"},"transient":true}`,
  `data: {"type":"tool-input-available","toolCallId":"c1","toolName":"redis_read","input":{"pattern":"device:*"}}`,
  `data: {"type":"tool-output-available","toolCallId":"c1","output":"235 row(s) matched"}`,
  `data: {"type":"data-table","data":{"columns":["key"],"rows":[["device:abc"]]}}`,
  // The composed answer the table was worked into. Without one the table IS
  // the answer and stays on screen whatever the setting (see below).
  `data: {"type":"data-stats","data":{"title":"Moving vehicles","figures":[{"label":"Moving","value":"235"}]}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"235 vehicles are moving."}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{}}`,
  `data: [DONE]`,
];

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

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return input.toString();
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/agent/agents")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: 3, name: "Bolty", is_active: true }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(sseResponse(FRAMES));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderThread(disclosure: { showReasoning: boolean; showQueryResults: boolean }) {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }

  const utils = render(
    <TestAskProvider config={{ disclosure }}>
      <AskInspectorProvider inspector={{ selection: null, selectPhase: () => {} }}>
        <ChatProvider>
          <Capture />
          <Thread />
        </ChatProvider>
      </AskInspectorProvider>
    </TestAskProvider>,
  );
  return { ...utils, chatRef };
}

describe("Ask disclosure", () => {
  it("hides the result table from the finished answer by default", async () => {
    const { chatRef } = renderThread({ showReasoning: false, showQueryResults: false });

    act(() => chatRef.current!.sendMessage("how many vehicles are moving?"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    // The answer arrives…
    expect(screen.getByText(/235 vehicles are moving/)).toBeInTheDocument();
    // …without the row the table would have rendered.
    expect(screen.queryByText("device:abc")).not.toBeInTheDocument();
  });

  it("keeps the table when it is the whole answer, even by default", async () => {
    // Nothing composed an answer from these rows, so they are not working:
    // hiding them left the prose introducing a table that never arrived.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          urlOf(input).includes("/agent/agents")
            ? new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
            : sseResponse(FRAMES.filter((frame) => !frame.includes("data-stats"))),
        ),
      ),
    );
    const { chatRef } = renderThread({ showReasoning: false, showQueryResults: false });

    act(() => chatRef.current!.sendMessage("which devices are moving?"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByText("device:abc")).toBeInTheDocument();
  });

  it("shows the result table once the tenant turns it on", async () => {
    const { chatRef } = renderThread({ showReasoning: true, showQueryResults: true });

    act(() => chatRef.current!.sendMessage("how many vehicles are moving?"));
    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));

    expect(screen.getByText("device:abc")).toBeInTheDocument();
  });

  it("leaves the answer itself untouched either way", async () => {
    /* The setting governs the machinery around the answer, never the answer.
       A flag that could swallow the thing the reader asked for would be a
       far worse bug than the noise it exists to remove. */
    const hidden = renderThread({ showReasoning: false, showQueryResults: false });
    act(() => hidden.chatRef.current!.sendMessage("q"));
    await waitFor(() => expect(hidden.chatRef.current!.status).toBe("idle"));

    expect(screen.getByText(/235 vehicles are moving/)).toBeInTheDocument();
  });
});
