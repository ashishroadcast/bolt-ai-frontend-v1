import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Composer } from "./Composer.tsx";
import { TestAskProvider } from "../testing.tsx";

/** A stream that never closes — stands in for a run genuinely in flight,
 * the same helper shape useChat.test.tsx uses for its own concurrency
 * tests. */
function openEndedResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"type":"start","messageId":"pending"}\n\n`));
    },
  });
  return new Response(body, { status: 200 });
}

/** Stands in for `AgentPicker` setting `ChatContext.selectedAgent` —
 * Composer itself never resolves an agent, only reads whichever name is
 * already selected (see Composer.tsx's own docstring). */
function SelectAgent({ name }: { name: string }) {
  const { setSelectedAgent } = useChatContext();
  useEffect(() => setSelectedAgent(name), [name, setSelectedAgent]);
  return null;
}

function renderComposer(agent: string | null = "Sales Analyst") {
  return render(<TestAskProvider>
      <ChatProvider>
      {agent !== null && <SelectAgent name={agent} />}
      <Composer />
    </ChatProvider>
    </TestAskProvider>,
  );
}

describe("Composer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the typed question against the selected agent and clears the field", async () => {
    fetchMock.mockResolvedValue(openEndedResponse());
    renderComposer("Sales Analyst");

    const field = screen.getByLabelText("Ask a question");
    fireEvent.change(field, { target: { value: "top items last week" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    // Awaited, not synchronous: sending now resolves a fresh token before
    // it opens the request (see chat/runStream.ts), so the fetch lands a
    // microtask after the click rather than during it.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Off the Request: `agentStream` calls `fetch(new Request(...))`, the
    // same single-argument shape `agentFetch` has always used.
    const body = await (fetchMock.mock.calls[0]![0] as Request).json();
    // The agent travels as a *name* on the wire (RunIn.agent), matching
    // whatever AgentPicker put into ChatContext.selectedAgent — never an id.
    expect(body).toMatchObject({ message: "top items last week", agent: "Sales Analyst" });
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("keeps the action's name through the flow: Ask becomes Asking while a run streams, and both the field and button disable", async () => {
    fetchMock.mockResolvedValue(openEndedResponse());
    renderComposer("Sales Analyst");

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Asking" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Asking" })).toBeDisabled();
    expect(screen.getByLabelText("Ask a question")).toBeDisabled();
  });

  it("does nothing for an empty or whitespace-only question", () => {
    fetchMock.mockResolvedValue(openEndedResponse());
    renderComposer("Sales Analyst");

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays disabled with no agent selected, so a run can never fire with none named on the wire", () => {
    fetchMock.mockResolvedValue(openEndedResponse());
    renderComposer(null);

    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByLabelText("Ask a question")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
