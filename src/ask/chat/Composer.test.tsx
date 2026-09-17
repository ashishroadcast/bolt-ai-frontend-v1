import { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Composer } from "./Composer.tsx";
import { AskAgentsProvider, type AskAgent } from "./useAskAgents.ts";
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

/**
 * The composer makes two different calls now — the agent list, for its `/`
 * menu, and the run itself — so the mock routes by URL rather than
 * answering everything with a stream. Without this the agents request got
 * an SSE body and `agentFetch`'s `response.json()` rejected.
 */
function routed(agents: AskAgent[]): ReturnType<typeof vi.fn> {
  return vi.fn((request: Request) => {
    if (new URL(request.url).pathname === "/agent/agents") {
      return Promise.resolve(
        new Response(JSON.stringify(agents), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(openEndedResponse());
  });
}

/** Just the `/agent/run` calls — the agent list is noise to most of these. */
function runCalls(fetchMock: ReturnType<typeof vi.fn>): Request[] {
  return fetchMock.mock.calls
    .map((call) => call[0] as Request)
    .filter((request) => new URL(request.url).pathname === "/agent/run");
}

function renderComposer(agent: string | null = "Sales Analyst") {
  return render(
    <TestAskProvider>
      <ChatProvider>
        <AskAgentsProvider>
          {agent !== null && <SelectAgent name={agent} />}
          <Composer />
        </AskAgentsProvider>
      </ChatProvider>
    </TestAskProvider>,
  );
}

const SALES: AskAgent = { id: 1, name: "Sales Analyst", is_active: true, slash_command: null };
const FORMS: AskAgent = {
  id: 2,
  name: "Form-Builder",
  description: "Drafts a form for the Form Manager.",
  is_active: true,
  slash_command: "form",
};
const FLEET: AskAgent = {
  id: 3,
  name: "Fleet-Report",
  is_active: true,
  slash_command: "report",
};

describe("Composer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = routed([SALES]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the typed question against the selected agent and clears the field", async () => {
    renderComposer("Sales Analyst");

    const field = screen.getByLabelText("Ask a question");
    fireEvent.change(field, { target: { value: "top items last week" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    // Awaited, not synchronous: sending now resolves a fresh token before
    // it opens the request (see chat/runStream.ts), so the fetch lands a
    // microtask after the click rather than during it.
    await waitFor(() => expect(runCalls(fetchMock)).toHaveLength(1));
    // Off the Request: `agentStream` calls `fetch(new Request(...))`, the
    // same single-argument shape `agentFetch` has always used.
    const body = await runCalls(fetchMock)[0]!.json();
    // The agent travels as a *name* on the wire (RunIn.agent), matching
    // whatever AgentPicker put into ChatContext.selectedAgent — never an id.
    expect(body).toMatchObject({ message: "top items last week", agent: "Sales Analyst" });
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("keeps the action's name through the flow: Ask becomes Asking while a run streams, and both the field and button disable", async () => {
    renderComposer("Sales Analyst");

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Asking" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Asking" })).toBeDisabled();
    expect(screen.getByLabelText("Ask a question")).toBeDisabled();
  });

  it("does nothing for an empty or whitespace-only question", () => {
    renderComposer("Sales Analyst");

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(runCalls(fetchMock)).toHaveLength(0);
  });

  it("stays disabled with no agent selected, so a run can never fire with none named on the wire", () => {
    renderComposer(null);

    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.getByLabelText("Ask a question")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(runCalls(fetchMock)).toHaveLength(0);
  });
});

describe("Composer slash commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function mount(agents: AskAgent[]) {
    fetchMock = routed(agents);
    vi.stubGlobal("fetch", fetchMock);
    return renderComposer("Sales Analyst");
  }

  function type(value: string) {
    fireEvent.change(screen.getByLabelText("Ask a question"), { target: { value } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function typeSlash(agents: AskAgent[] = [SALES, FORMS, FLEET]) {
    mount(agents);
    // The menu is built from the agent list, so it cannot open before that
    // request has landed.
    await waitFor(() => expect(screen.getByLabelText("Show commands")).toBeInTheDocument());
    type("/");
    return screen.getByRole("listbox", { name: "Commands" });
  }

  it("opens on a leading slash and lists only agents an operator gave a command", async () => {
    const menu = await typeSlash();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // Alphabetical, not the order the API happened to return them in.
    expect(options[0]).toHaveTextContent("/form");
    expect(options[1]).toHaveTextContent("/report");
    // The one with no command configured is not a command.
    expect(menu).not.toHaveTextContent("Sales Analyst");
  });

  it("shows the agent's own description, because a name alone does not say what /form does", async () => {
    await typeSlash();
    expect(screen.getByRole("option", { name: /form/ })).toHaveTextContent(
      "Drafts a form for the Form Manager.",
    );
  });

  it("filters as the reader keeps typing", async () => {
    await typeSlash();
    type("/fo");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("/form");
  });

  it("closes once there is no command left to match, rather than showing an empty menu", async () => {
    await typeSlash();
    type("/zzz");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("does not open for a slash inside a sentence — people type URLs and units", async () => {
    await typeSlash();
    type("over 60 km/h");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("does not open once the reader has started writing the question", async () => {
    await typeSlash();
    // The space is the signal: a command has been chosen or abandoned, and
    // what follows is prose.
    type("/form create a vehicle registration form");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("arms the agent on Enter and clears the slash, so the next thing typed is the question", async () => {
    await typeSlash();
    const field = screen.getByLabelText("Ask a question");

    fireEvent.keyDown(field, { key: "Enter" });

    expect((field as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: "a vehicle registration form" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    // Enter on the menu must never submit `/form` as the question itself.
    await waitFor(() => expect(runCalls(fetchMock)).toHaveLength(1));
    const body = await runCalls(fetchMock)[0]!.json();
    expect(body).toMatchObject({ message: "a vehicle registration form", agent: "Form-Builder" });
  });

  it("moves the highlight with the arrow keys and wraps at the ends", async () => {
    await typeSlash();
    const field = screen.getByLabelText("Ask a question");

    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/form");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/report");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/form");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/report");
  });

  it("arms whichever command the arrows landed on", async () => {
    await typeSlash();
    const field = screen.getByLabelText("Ask a question");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.change(field, { target: { value: "how did we do" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(runCalls(fetchMock)).toHaveLength(1));
    expect(await runCalls(fetchMock)[0]!.json()).toMatchObject({ agent: "Fleet-Report" });
  });

  it("closes on Escape and stays closed until the reader types something else", async () => {
    await typeSlash();
    const field = screen.getByLabelText("Ask a question");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
    // The text is left alone — Escape dismisses the menu, it does not undo
    // what was typed.
    expect((field as HTMLInputElement).value).toBe("/");

    type("/f");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
  });

  it("arms on pointer down, which is before the input loses focus", async () => {
    await typeSlash();

    fireEvent.pointerDown(screen.getByRole("option", { name: /report/ }));

    const field = screen.getByLabelText("Ask a question");
    expect((field as HTMLInputElement).value).toBe("");
    fireEvent.change(field, { target: { value: "anything" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(runCalls(fetchMock)).toHaveLength(1));
    expect(await runCalls(fetchMock)[0]!.json()).toMatchObject({ agent: "Fleet-Report" });
  });

  it("offers nothing at all to a tenant whose agents have no commands", async () => {
    mount([SALES]);
    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeEnabled());

    // No affordance, because there is nothing behind it — pointing at a key
    // that does nothing is worse than saying nothing.
    expect(screen.queryByLabelText("Show commands")).not.toBeInTheDocument();
    type("/");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("ignores a command on an agent that has been deactivated", async () => {
    mount([SALES, { ...FORMS, is_active: false }]);
    await waitFor(() => expect(screen.getByLabelText("Ask a question")).toBeEnabled());

    expect(screen.queryByLabelText("Show commands")).not.toBeInTheDocument();
  });

  it("the affordance opens the menu, so the feature is findable without knowing the key", async () => {
    mount([SALES, FORMS]);
    await waitFor(() => expect(screen.getByLabelText("Show commands")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Show commands"));

    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect((screen.getByLabelText("Ask a question") as HTMLInputElement).value).toBe("/");
  });
});
