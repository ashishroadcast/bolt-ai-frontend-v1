import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Thread } from "./Thread.tsx";
import type { UseChatResult } from "./useChat.ts";
import { TestAskProvider } from "../testing.tsx";

/**
 * A drafted form is the answer, not the working — so it must survive the
 * disclosure setting that hides the working.
 *
 * This is a regression test for a bug the unit tests could not have caught
 * and a live run did: `showQueryResults` defaults OFF for a tenant, and
 * `Thread` gated EVERY part behind it. The answer read "Here is a draft of
 * the Vehicle Registration Record form" and there was no form anywhere on
 * screen, because a setting about SQL result tables had swallowed the one
 * thing the reader had asked for and the only control on the turn.
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

const DRAFT = {
  name: "Vehicle Registration",
  description: "Record a vehicle joining the fleet.",
  category: "Compliance",
  formType: "standalone",
  fields: [{ label: "Registration number", type: "text", required: true, order: 0 }],
};

const FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  // A table alongside it, so the test proves the split rather than just
  // "everything renders": the table is evidence and must stay hidden.
  `data: {"type":"data-table","data":{"columns":["item"],"rows":[["Existing form"]]}}`,
  `data: {"type":"data-form-draft","data":${JSON.stringify(DRAFT)}}`,
  `data: {"type":"text-start","id":"answer"}`,
  `data: {"type":"text-delta","id":"answer","delta":"Here is a draft."}`,
  `data: {"type":"text-end","id":"answer"}`,
  `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"cost_usd":0,"duration_ms":10}}}`,
  `data: [DONE]`,
];

function routeFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/agent/agents")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 1, name: "Form-Builder", is_active: true }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(sseResponse(FRAMES));
  });
}

function renderThread(showQueryResults: boolean) {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }
  render(
    <TestAskProvider config={{ disclosure: { showReasoning: false, showQueryResults } }}>
      <ChatProvider>
        <Capture />
        <Thread />
      </ChatProvider>
    </TestAskProvider>,
  );
  return chatRef;
}

describe("Thread — a drafted form is never hidden by disclosure", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = routeFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders the draft card with query results switched OFF", async () => {
    const chatRef = renderThread(false);
    await waitFor(() => expect(chatRef.current).not.toBeNull());
    await act(async () => {
      await chatRef.current!.sendMessage("a vehicle registration form", { agent: "Form-Builder" });
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Vehicle Registration" })).toBeInTheDocument(),
    );
    // The evidence table stays hidden, which is what the setting is for.
    expect(screen.queryByText("Existing form")).not.toBeInTheDocument();
  });

  it("still renders both with query results switched ON", async () => {
    const chatRef = renderThread(true);
    await waitFor(() => expect(chatRef.current).not.toBeNull());
    await act(async () => {
      await chatRef.current!.sendMessage("a vehicle registration form", { agent: "Form-Builder" });
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Vehicle Registration" })).toBeInTheDocument(),
    );
    expect(screen.getByText("Existing form")).toBeInTheDocument();
  });
});
