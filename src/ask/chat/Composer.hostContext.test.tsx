import { useEffect } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { Composer } from "./Composer.tsx";
import { useChat } from "./useChat.ts";
import { AskAgentsProvider } from "./useAskAgents.ts";
import { TestAskProvider } from "../testing.tsx";
import type { AskHostContext } from "../config.tsx";

/**
 * `host_context` (CONTRACT §7) rides every run, and the composer's context
 * chip (Figma F13 "Operation Widget ×") decides whether `selectedWidgetId`
 * rides with it.
 */

function finishedRun(): Response {
  const text = [
    `data: {"type":"start","messageId":"m"}`,
    `data: {"type":"finish","messageMetadata":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"cost_usd":0,"duration_ms":1}}}`,
    `data: [DONE]`,
  ]
    .map((frame) => `${frame}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function routed(): ReturnType<typeof vi.fn> {
  return vi.fn((request: Request) => {
    if (new URL(request.url).pathname === "/agent/agents") {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 1, name: "Dashboard-Builder", is_active: true }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(finishedRun());
  });
}

async function runBodies(fetchMock: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>[]> {
  const runs = fetchMock.mock.calls
    .map((call) => call[0] as Request)
    .filter((request) => new URL(request.url).pathname === "/agent/run");
  return Promise.all(runs.map(async (request) => (await request.clone().json()) as Record<string, unknown>));
}

const CONTEXT: AskHostContext = {
  surface: "dashboard_builder",
  dashboard: {
    name: "Untitled View",
    widgets: [
      { id: "w-1", metricKey: "fleet.active_device_groups", visualization: "kpi", title: "Operation Widget" },
    ],
  },
  selectedWidgetId: "w-1",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = routed();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("useChat — host_context", () => {
  function hook(hostContextProvider?: () => AskHostContext | null) {
    return renderHook(() => useChat(), {
      wrapper: ({ children }) => (
        <TestAskProvider config={hostContextProvider === undefined ? {} : { hostContextProvider }}>
          {children}
        </TestAskProvider>
      ),
    });
  }

  it("sends the host's context with the run", async () => {
    const { result } = hook(() => CONTEXT);
    act(() => result.current.sendMessage("make it a bar chart", { agent: "Dashboard-Builder" }));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    const [body] = await runBodies(fetchMock);
    expect(body).toMatchObject({ message: "make it a bar chart", host_context: CONTEXT });
  });

  it("reads the provider per run, not once", async () => {
    let selected = "w-1";
    const { result } = hook(() => ({ ...CONTEXT, selectedWidgetId: selected }));
    act(() => result.current.sendMessage("one"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    selected = "w-2";
    act(() => result.current.sendMessage("two"));
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    const bodies = await runBodies(fetchMock);
    expect((bodies[0]!.host_context as AskHostContext).selectedWidgetId).toBe("w-1");
    expect((bodies[1]!.host_context as AskHostContext).selectedWidgetId).toBe("w-2");
  });

  it("omits the key entirely when there is no provider, a null answer, or a provider that throws", async () => {
    for (const provider of [
      undefined,
      () => null,
      () => {
        throw new Error("host bug");
      },
    ]) {
      fetchMock.mockClear();
      const { result, unmount } = hook(provider);
      act(() => result.current.sendMessage("hello"));
      await waitFor(() => expect(result.current.status).toBe("idle"));
      const [body] = await runBodies(fetchMock);
      expect(Object.hasOwn(body!, "host_context")).toBe(false);
      unmount();
    }
  });

  it("drops only selectedWidgetId when asked to", async () => {
    const { result } = hook(() => CONTEXT);
    act(() => result.current.sendMessage("something else", { omitSelectedWidget: true }));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    const [body] = await runBodies(fetchMock);
    const sent = body!.host_context as AskHostContext;
    expect(Object.hasOwn(sent, "selectedWidgetId")).toBe(false);
    expect(sent.dashboard).toEqual(CONTEXT.dashboard);
  });
});

describe("Composer — context chip", () => {
  function SelectAgent() {
    const { setSelectedAgent } = useChatContext();
    useEffect(() => setSelectedAgent("Dashboard-Builder"), [setSelectedAgent]);
    return null;
  }

  function mount(provider: () => AskHostContext | null) {
    render(
      <TestAskProvider config={{ hostContextProvider: provider }}>
        <ChatProvider>
          <AskAgentsProvider>
            <SelectAgent />
            <Composer />
          </AskAgentsProvider>
        </ChatProvider>
      </TestAskProvider>,
    );
  }

  const field = () => screen.getByLabelText("Ask a question") as HTMLTextAreaElement;

  async function ask(text: string) {
    await waitFor(() => expect(field()).toBeEnabled());
    fireEvent.change(field(), { target: { value: text } });
    fireEvent.submit(field().closest("form")!);
    // The box stays enabled through a run now (typing is never blocked, only
    // sending), so the run's end is read off Ask coming back in Stop's place.
    await screen.findByRole("button", { name: "Ask" });
  }

  it("shows the selected widget's title and asks what to change", async () => {
    mount(() => CONTEXT);
    expect(await screen.findByText("Operation Widget")).toBeInTheDocument();
    expect(field()).toHaveAttribute("placeholder", "Please specify what you want to change");
  });

  it("shows no chip without a selection", async () => {
    mount(() => ({ surface: "dashboard_builder" }));
    await waitFor(() => expect(field()).toBeEnabled());
    expect(screen.queryByRole("button", { name: /Don't ask about/ })).not.toBeInTheDocument();
    expect(field().placeholder).not.toBe("Please specify what you want to change");
  });

  it("× drops selectedWidgetId from the NEXT message only", async () => {
    mount(() => CONTEXT);
    fireEvent.click(await screen.findByRole("button", { name: "Don't ask about Operation Widget" }));
    expect(screen.queryByText("Operation Widget")).not.toBeInTheDocument();
    expect(field().placeholder).not.toBe("Please specify what you want to change");

    await ask("show me something else");
    // Back for the message after — the builder still has it selected.
    expect(await screen.findByText("Operation Widget")).toBeInTheDocument();
    await ask("now make it a bar chart");

    const bodies = await runBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(Object.hasOwn(bodies[0]!.host_context as object, "selectedWidgetId")).toBe(false);
    expect((bodies[1]!.host_context as AskHostContext).selectedWidgetId).toBe("w-1");
  });

  it("follows the host's selection without being told", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let context: AskHostContext = { surface: "dashboard_builder" };
      mount(() => context);
      await waitFor(() => expect(field()).toBeEnabled());
      context = CONTEXT;
      await act(async () => {
        vi.advanceTimersByTime(1_100);
      });
      expect(screen.getByText("Operation Widget")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
