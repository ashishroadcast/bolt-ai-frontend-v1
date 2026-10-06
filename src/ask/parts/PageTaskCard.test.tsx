import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageTaskRequest, PageTaskResult } from "../config.tsx";
import { testAskClient } from "../testing.tsx";
import { toUIPart } from "../chat/wireParts.ts";
import { renderUIPart } from "./catalog.tsx";
import { PageTaskCard, type PageTaskCardProps } from "./PageTaskCard.tsx";
import {
  abortPageTasks,
  handlePageTaskKey,
  resetPageTasksForTests,
  startPageTask,
} from "./pageTaskStore.ts";

const TASK_ID = "0123456789abcdef0123456789abcdef";

function props(overrides: Partial<PageTaskCardProps> = {}): PageTaskCardProps {
  return { taskId: TASK_ID, task: "Rename vehicle KA01 to Truck 7", status: "pending", steps: [], ...overrides };
}

/** A host whose task runs until the test settles it. */
function controllableHost() {
  let request: PageTaskRequest | null = null;
  let settle: { resolve: (r: PageTaskResult) => void; reject: (e: unknown) => void } | null = null;
  const onPageTask = vi.fn(
    (req: PageTaskRequest) =>
      new Promise<PageTaskResult>((resolve, reject) => {
        request = req;
        settle = { resolve, reject };
      }),
  );
  return {
    onPageTask,
    get request() {
      return request!;
    },
    get settle() {
      return settle!;
    },
  };
}

/** The JSON bodies posted to `/result`, in order. */
async function postedResults(fetchMock: ReturnType<typeof vi.fn>): Promise<unknown[]> {
  const posts = fetchMock.mock.calls
    .map(([input]) => input as Request)
    .filter((request) => request.url.endsWith("/result"));
  return Promise.all(posts.map(async (request) => JSON.parse(await request.clone().text()) as unknown));
}

describe("PageTaskCard and the page task runner", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetPageTasksForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps the wire part through the catalog, keeping `live` off the payload", () => {
    const part = toUIPart("data-page-task", { taskId: TASK_ID, task: "Do it", status: "pending", live: true });
    expect(part).toEqual({
      intent: "data-page-task",
      data: { taskId: TASK_ID, task: "Do it", status: "pending", steps: [], live: false },
    });
    render(renderUIPart(part!));
    expect(screen.getByRole("status")).toHaveTextContent("Interrupted");
  });

  it("renders a pending part from history as Interrupted, with no Stop and nothing run", () => {
    render(<PageTaskCard {...props({ live: false })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Interrupted");
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a final part's outcome and steps", () => {
    render(
      <PageTaskCard
        {...props({
          status: "done",
          summary: "Renamed it.",
          steps: [
            { n: 1, action: "Clicked Edit", ok: true },
            { n: 2, action: "Typed name", detail: "Truck 7", ok: false },
          ],
        })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Done");
    expect(screen.getByText("Renamed it.")).toBeInTheDocument();
    expect(screen.getByText("Clicked Edit")).toBeInTheDocument();
    expect(screen.getByText(/— Truck 7/)).toBeInTheDocument();
    expect(screen.getByText(/(failed)/)).toBeInTheDocument();
  });

  it("shows a live run's steps, an Allow/Deny prompt and a question box, then the result", async () => {
    const host = controllableHost();
    startPageTask({ taskId: TASK_ID, task: "Rename", client: testAskClient(), onPageTask: host.onPageTask });
    render(<PageTaskCard {...props({ live: true })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Working on the page");
    expect(host.request.llm.baseURL).toBe(`http://ask.test/agent/page-tasks/${TASK_ID}`);
    expect(host.request.llm.model).toBe("bolt-page-agent");

    act(() => host.request.onStep({ n: 1, action: "Opened the vehicle", ok: true }));
    expect(screen.getByText("Opened the vehicle")).toBeInTheDocument();

    let confirmed: Promise<boolean>;
    act(() => {
      confirmed = host.request.confirm("Click Save?");
    });
    expect(screen.getByText("Click Save?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await expect(confirmed!).resolves.toBe(true);
    expect(screen.queryByText("Click Save?")).not.toBeInTheDocument();

    let denied: Promise<boolean>;
    act(() => {
      denied = host.request.confirm("Delete it?");
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await expect(denied!).resolves.toBe(false);

    let answered: Promise<string>;
    act(() => {
      answered = host.request.askUser("Which depot?");
    });
    fireEvent.change(screen.getByLabelText("Which depot?"), { target: { value: "North" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await expect(answered!).resolves.toBe("North");

    await act(async () => {
      host.settle.resolve({ status: "done", summary: "Renamed.", steps: [{ n: 1, action: "Saved", ok: true }] });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Done");
    expect(screen.getByText("Renamed.")).toBeInTheDocument();
    expect(await postedResults(fetchMock)).toEqual([
      { status: "done", summary: "Renamed.", steps: [{ n: 1, action: "Saved", ok: true }] },
    ]);
  });

  it("calls the host once per task id however often it is started", async () => {
    const host = controllableHost();
    const client = testAskClient();
    startPageTask({ taskId: TASK_ID, task: "Rename", client, onPageTask: host.onPageTask });
    startPageTask({ taskId: TASK_ID, task: "Rename", client, onPageTask: host.onPageTask });
    expect(host.onPageTask).toHaveBeenCalledTimes(1);
  });

  it("Stop aborts the signal, settles open prompts, and posts cancelled with the steps so far", async () => {
    const host = controllableHost();
    startPageTask({ taskId: TASK_ID, task: "Rename", client: testAskClient(), onPageTask: host.onPageTask });
    render(<PageTaskCard {...props({ live: true })} />);
    act(() => host.request.onStep({ n: 1, action: "Opened", ok: true }));
    let question: Promise<string>;
    act(() => {
      question = host.request.askUser("Which?");
    });
    const rejected = expect(question!).rejects.toMatchObject({ name: "AbortError" });

    fireEvent.click(screen.getByRole("button", { name: /stop the page task/i }));

    expect(host.request.signal.aborted).toBe(true);
    await rejected;
    await expect(host.request.confirm("Late?")).resolves.toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent("Stopped");
    // The host winding down afterwards changes nothing.
    await act(async () => host.settle.resolve({ status: "done", summary: "x", steps: [] }));
    await waitFor(async () =>
      expect(await postedResults(fetchMock)).toEqual([
        { status: "cancelled", summary: "Stopped before it finished.", steps: [{ n: 1, action: "Opened", ok: true }] },
      ]),
    );
  });

  it("Escape (a trusted key only) stops a running task", async () => {
    const host = controllableHost();
    startPageTask({ taskId: TASK_ID, task: "Rename", client: testAskClient(), onPageTask: host.onPageTask });

    handlePageTaskKey({ key: "Escape", isTrusted: false });
    expect(host.request.signal.aborted).toBe(false);
    handlePageTaskKey({ key: "Enter", isTrusted: true });
    expect(host.request.signal.aborted).toBe(false);
    handlePageTaskKey({ key: "Escape", isTrusted: true });
    expect(host.request.signal.aborted).toBe(true);
    await waitFor(async () =>
      expect(await postedResults(fetchMock)).toEqual([expect.objectContaining({ status: "cancelled" })]),
    );
  });

  it("aborts only the tasks of the client being torn down", async () => {
    const mine = controllableHost();
    const theirs = controllableHost();
    const client = testAskClient();
    startPageTask({ taskId: "a".repeat(32), task: "A", client, onPageTask: mine.onPageTask });
    startPageTask({ taskId: "b".repeat(32), task: "B", client: testAskClient(), onPageTask: theirs.onPageTask });

    abortPageTasks(client);

    expect(mine.request.signal.aborted).toBe(true);
    expect(theirs.request.signal.aborted).toBe(false);
  });

  it("posts failed with the error and the steps seen when the host rejects", async () => {
    const host = controllableHost();
    startPageTask({ taskId: TASK_ID, task: "Rename", client: testAskClient(), onPageTask: host.onPageTask });
    host.request.onStep({ n: 1, action: "Opened", ok: true });
    await act(async () => host.settle.reject(new Error("Couldn't find the Save button")));
    await waitFor(async () =>
      expect(await postedResults(fetchMock)).toEqual([
        { status: "failed", summary: "Couldn't find the Save button", steps: [{ n: 1, action: "Opened", ok: true }] },
      ]),
    );
  });

  it("posts failed straight away when the host has no handler", async () => {
    startPageTask({ taskId: TASK_ID, task: "Rename", client: testAskClient() });
    render(<PageTaskCard {...props({ live: true })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't finish");
    await waitFor(async () =>
      expect(await postedResults(fetchMock)).toEqual([
        { status: "failed", summary: "This screen can't run page actions.", steps: [] },
      ]),
    );
  });
});
