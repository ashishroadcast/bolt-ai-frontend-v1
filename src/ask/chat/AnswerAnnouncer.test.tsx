import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestAskProvider } from "../testing.tsx";
import { AnswerAnnouncer } from "./AnswerAnnouncer.tsx";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import type { UseChatResult } from "./useChat.ts";

// The whole chat hook runs for real here: the thing under test is an edge
// in `useChat`'s status, and a stub of that edge would only test the stub.

const ANSWER_FRAMES = [
  `data: {"type":"start","messageId":"msg-1"}`,
  `data: {"type":"text-delta","id":"answer","delta":"Chicken Biryani led the week."}`,
  `data: {"type":"finish"}`,
  `data: [DONE]`,
];

const FAILED_FRAMES = [
  `data: {"type":"start","messageId":"msg-2"}`,
  `data: {"type":"error","errorText":"The model is unavailable."}`,
  `data: [DONE]`,
];

function encode(frames: string[]): Uint8Array {
  return new TextEncoder().encode(frames.map((frame) => `${frame}\n\n`).join(""));
}

function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(frames));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** A run that stays in flight until the test says it is done. */
function heldResponse(): { response: Response; finish: () => void } {
  let release: () => void = () => {};
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(ANSWER_FRAMES.slice(0, 2)));
        release = () => {
          controller.enqueue(encode(ANSWER_FRAMES.slice(2)));
          controller.close();
        };
      },
    }),
    { status: 200 },
  );
  return { response, finish: () => release() };
}

function renderAnnouncer() {
  const chatRef: { current: UseChatResult | null } = { current: null };
  function Capture() {
    chatRef.current = useChatContext();
    return null;
  }
  render(
    <TestAskProvider>
      <ChatProvider>
        <Capture />
        <AnswerAnnouncer />
      </ChatProvider>
    </TestAskProvider>,
  );
  return chatRef;
}

describe("telling a screen reader the answer is in", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says nothing before any run has finished", () => {
    renderAnnouncer();

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces once, when the run finishes", async () => {
    fetchMock.mockResolvedValue(sseResponse(ANSWER_FRAMES));
    const chatRef = renderAnnouncer();

    act(() => chatRef.current!.sendMessage("top items last week"));

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));
    expect(screen.getByRole("status")).toHaveTextContent("Answer ready.");
  });

  it("says the answer failed when the run ends in an error", async () => {
    fetchMock.mockResolvedValue(sseResponse(FAILED_FRAMES));
    const chatRef = renderAnnouncer();

    act(() => chatRef.current!.sendMessage("top items last week"));

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));
    expect(screen.getByRole("status")).toHaveTextContent("The answer failed.");
  });

  it("says the answer failed when the run could not even start", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const chatRef = renderAnnouncer();

    act(() => chatRef.current!.sendMessage("top items last week"));

    await waitFor(() => expect(chatRef.current!.status).toBe("idle"));
    expect(screen.getByRole("status")).toHaveTextContent("The answer failed.");
  });

  it("clears while the next run is in flight, so its own announcement is heard", async () => {
    // Setting a live region to the text it already holds is not a change,
    // and a screen reader announces changes. Without the clear, every
    // answer after the first would arrive in silence.
    fetchMock.mockResolvedValueOnce(sseResponse(ANSWER_FRAMES));
    const chatRef = renderAnnouncer();
    act(() => chatRef.current!.sendMessage("top items last week"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Answer ready."));

    const second = heldResponse();
    fetchMock.mockResolvedValueOnce(second.response);
    act(() => chatRef.current!.sendMessage("and the week before?"));

    await waitFor(() => expect(chatRef.current!.status).toBe("streaming"));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    act(() => second.finish());

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Answer ready."));
  });

  it("stays quiet when a conversation is opened from history", async () => {
    // Nobody waited for those answers, so "Answer ready." would be news
    // about nothing.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 9,
          title: null,
          created_at: "2026-09-28T10:00:00Z",
          updated_at: "2026-09-28T10:00:00Z",
          messages: [
            {
              id: 1,
              role: "user",
              content: "top items",
              agent_id: null,
              trace_id: null,
              meta: null,
              created_at: "2026-09-28T10:00:00Z",
            },
            {
              id: 2,
              role: "assistant",
              content: "Chicken Biryani.",
              agent_id: null,
              trace_id: null,
              meta: null,
              created_at: "2026-09-28T10:00:05Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const chatRef = renderAnnouncer();

    await act(() => chatRef.current!.loadConversation(9));

    expect(chatRef.current!.messages).toHaveLength(2);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
