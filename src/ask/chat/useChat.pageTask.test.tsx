import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskConfig, PageTaskRequest, PageTaskResult } from "../config.tsx";
import { resetPageTasksForTests } from "../parts/pageTaskStore.ts";
import { TestAskProvider } from "../testing.tsx";
import { useAskAgents } from "./useAskAgents.ts";
import { useChat } from "./useChat.ts";

const TASK_ID = "0123456789abcdef0123456789abcdef";

const PENDING = `data: {"type":"data-page-task","id":"part-1","data":{"taskId":"${TASK_ID}","task":"Rename it","route":"/portal/vehicles","status":"pending"}}`;
const FINAL = `data: {"type":"data-page-task","id":"part-1","data":{"taskId":"${TASK_ID}","task":"Rename it","route":"/portal/vehicles","status":"done","summary":"Renamed.","steps":[{"n":1,"action":"Saved","ok":true}]}}`;

function sse(frames: string[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `${frame}\n\n`).join(""));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  );
}

/** A run still waiting on its page task: it never closes by itself. */
function openRun(signal: AbortSignal, frames: string[]): Response {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      controller.enqueue(
        new TextEncoder().encode(
          [`data: {"type":"start","messageId":"m1"}`, ...frames].map((frame) => `${frame}\n\n`).join(""),
        ),
      );
    },
  });
  signal.addEventListener("abort", () => ctrl.error(new DOMException("aborted", "AbortError")));
  return new Response(body);
}

function hangingHost() {
  const requests: PageTaskRequest[] = [];
  const onPageTask = vi.fn(
    (request: PageTaskRequest) =>
      new Promise<PageTaskResult>(() => {
        requests.push(request);
      }),
  );
  return { onPageTask, requests };
}

describe("useChat page actions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let runResponse: (request: Request) => Response;

  beforeEach(() => {
    runResponse = () => sse([`data: {"type":"start","messageId":"m1"}`, `data: {"type":"finish"}`]);
    fetchMock = vi.fn(async (input: Request) => {
      if (input.url.endsWith("/agent/run")) return runResponse(input);
      if (input.url.endsWith("/result")) return new Response("{}");
      throw new Error(`unexpected ${input.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/portal/trips?vehicle=X");
    document.title = "Trips | Bolt";
  });

  afterEach(() => {
    resetPageTasksForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup(config: Partial<AskConfig>) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestAskProvider config={config}>{children}</TestAskProvider>
    );
    return renderHook(() => useChat(), { wrapper });
  }

  async function runBody(): Promise<Record<string, unknown>> {
    const run = fetchMock.mock.calls.map(([r]) => r as Request).find((r) => r.url.endsWith("/agent/run"))!;
    return JSON.parse(await run.clone().text()) as Record<string, unknown>;
  }

  async function posted(): Promise<unknown[]> {
    const posts = fetchMock.mock.calls.map(([r]) => r as Request).filter((r) => r.url.endsWith("/result"));
    return Promise.all(posts.map(async (r) => JSON.parse(await r.clone().text()) as unknown));
  }

  it("sends the open page on a run when the host can act on it", async () => {
    const { result } = setup({ pageActionsAvailable: true, onPageTask: hangingHost().onPageTask });
    act(() => result.current.sendMessage("/do rename", { agent: "do" }));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await runBody()).toMatchObject({
      agent: "do",
      page: { route: "/portal/trips?vehicle=X", title: "Trips | Bolt" },
    });
  });

  it.each([
    ["no handler", { pageActionsAvailable: true }],
    ["not available", { onPageTask: hangingHost().onPageTask }],
  ])("sends no page with %s", async (_label, config) => {
    const { result } = setup(config);
    act(() => result.current.sendMessage("hello"));
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(await runBody()).not.toHaveProperty("page");
  });

  it("runs a live task once, and the re-streamed final part replaces the pending one", async () => {
    const host = hangingHost();
    runResponse = () =>
      sse([`data: {"type":"start","messageId":"m1"}`, PENDING, PENDING, FINAL, `data: {"type":"finish"}`]);
    const { result } = setup({ pageActionsAvailable: true, onPageTask: host.onPageTask });

    act(() => result.current.sendMessage("rename it", { agent: "do" }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    expect(host.onPageTask).toHaveBeenCalledTimes(1);
    expect(host.requests[0]).toMatchObject({ id: TASK_ID, task: "Rename it", route: "/portal/vehicles" });
    const parts = result.current.messages.at(-1)!.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.data).toMatchObject({ status: "done", summary: "Renamed.", live: true });
  });

  it.each([
    ["a new conversation", (chat: ReturnType<typeof useChat>) => chat.clearConversation()],
    ["Stop", (chat: ReturnType<typeof useChat>) => chat.stop()],
  ])("%s aborts the running task and posts cancelled", async (_label, act_) => {
    const host = hangingHost();
    runResponse = (request) => openRun(request.signal, [PENDING]);
    const { result } = setup({ pageActionsAvailable: true, onPageTask: host.onPageTask });

    act(() => result.current.sendMessage("rename it", { agent: "do" }));
    await waitFor(() => expect(host.onPageTask).toHaveBeenCalledTimes(1));
    act(() => act_(result.current));

    expect(host.requests[0]!.signal.aborted).toBe(true);
    await waitFor(async () =>
      expect(await posted()).toEqual([{ status: "cancelled", summary: "Stopped before it finished.", steps: [] }]),
    );
  });

  it("aborts the task when the provider goes away (organisation switch, element removed)", async () => {
    const host = hangingHost();
    runResponse = (request) => openRun(request.signal, [PENDING]);
    const { result, unmount } = setup({ pageActionsAvailable: true, onPageTask: host.onPageTask });

    act(() => result.current.sendMessage("rename it", { agent: "do" }));
    await waitFor(() => expect(host.onPageTask).toHaveBeenCalledTimes(1));
    unmount();

    expect(host.requests[0]!.signal.aborted).toBe(true);
    await waitFor(async () => expect(await posted()).toEqual([expect.objectContaining({ status: "cancelled" })]));
  });

  it("posts failed at once for a live task when the host cannot act on its page", async () => {
    runResponse = () => sse([`data: {"type":"start","messageId":"m1"}`, PENDING, `data: {"type":"finish"}`]);
    const { result } = setup({});
    act(() => result.current.sendMessage("rename it", { agent: "do" }));
    await waitFor(async () =>
      expect(await posted()).toEqual([
        { status: "failed", summary: "This screen can't run page actions.", steps: [] },
      ]),
    );
  });

  it("never runs a pending task re-read from history", async () => {
    const host = hangingHost();
    fetchMock.mockImplementation(async (input: Request) => {
      if (input.url.includes("/agent/conversations/7")) {
        return new Response(
          JSON.stringify({
            id: 7,
            title: null,
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            messages: [
              {
                id: 1,
                role: "assistant",
                content: "",
                agent_id: null,
                trace_id: null,
                created_at: "2026-10-01T00:00:00Z",
                meta: {
                  ui_parts: [
                    { type: "data-page-task", id: "part-1", data: { taskId: TASK_ID, task: "x", status: "pending" } },
                  ],
                },
              },
            ],
          }),
        );
      }
      return new Response("{}");
    });
    const { result } = setup({ pageActionsAvailable: true, onPageTask: host.onPageTask });
    await act(() => result.current.loadConversation(7));

    expect(result.current.messages.at(-1)!.parts[0]!.data).toMatchObject({ status: "pending", live: false });
    expect(host.onPageTask).not.toHaveBeenCalled();
  });
});

describe("the built-in /do agent", () => {
  const AGENTS = [
    { id: 3, name: "Fleet", is_active: true, slash_command: null },
    {
      name: "Do it on this page",
      description: "Clicks and types on the screen you have open, after asking before anything is saved.",
      slash_command: "do",
      builtin: true,
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(AGENTS))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function agentsWith(config: Partial<AskConfig>) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestAskProvider config={config}>{children}</TestAskProvider>
    );
    return renderHook(() => useAskAgents(), { wrapper });
  }

  it("is offered, runnable by its command, where the host can act on its page", async () => {
    const { result } = agentsWith({ pageActionsAvailable: true, onPageTask: vi.fn() });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const builtin = result.current.agents.find((agent) => agent.builtin === true)!;
    expect(builtin).toMatchObject({
      name: "do",
      label: "Do it on this page",
      slash_command: "do",
      is_active: true,
    });
    expect(builtin.id).toBeLessThan(0);
  });

  it("is hidden where the host can't", async () => {
    const { result } = agentsWith({});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.agents.map((agent) => agent.name)).toEqual(["Fleet"]);
  });
});
