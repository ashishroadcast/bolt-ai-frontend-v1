import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { CodeExecutionsRoute } from "./CodeExecutionsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const AGENTS = [{ id: 5, name: "Sales-Analyst", description: null, is_active: true }];

const EXECUTION = {
  id: 1,
  agent_id: 5,
  conversation_id: 20048,
  message_id: 400126,
  mode: "interpreter",
  exit_status: 0,
  outcome: "ok",
  duration_ms: 1251,
  artifact_count: 1,
  created_at: "2026-08-28T05:46:13Z",
};

const DETAIL = {
  ...EXECUTION,
  code: "import pandas as pd\nprint(pd.DataFrame(rows).sum())",
  stdout: "mean_share_pct = 0.3704 %",
  stderr: null,
  trace_id: "tr-42",
  tool_calls: [],
  artifacts: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      filename: "shares.png",
      content_type: "image/png",
      size_bytes: 2048,
    },
  ],
};

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/code-executions"]}>
      <CodeExecutionsRoute />
    </MemoryRouter>,
  );
}

function mockReads(
  fetchMock: ReturnType<typeof vi.fn>,
  executions: unknown[] = [EXECUTION],
  detail: unknown = DETAIL,
) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
    if (request.url.endsWith("/agent/code-executions")) {
      return Promise.resolve(jsonResponse(executions));
    }
    if (request.url.endsWith("/agent/code-executions/1")) {
      return Promise.resolve(jsonResponse(detail));
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("CodeExecutionsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({
      kind: "apiKey", credential: "tok",
      user: { id: "1", email: "a@b.com", name: "A" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSession(null);
  });

  it("lists a real run: outcome, producing agent, conversation and duration", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /sales-analyst/i })).toBeInTheDocument();
    expect(screen.getByText("#20048")).toBeInTheDocument();
    expect(screen.getByText("1.25 s")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("does not fetch the code until a row is expanded", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());

    const detailCalls = () =>
      fetchMock.mock.calls.filter((call) =>
        (call[0] as Request).url.endsWith("/agent/code-executions/1"),
      );
    expect(detailCalls()).toHaveLength(0);
    expect(screen.queryByTestId("execution-code")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show code/i }));

    await waitFor(() => expect(detailCalls()).toHaveLength(1));
    expect(screen.getByTestId("execution-code")).toHaveTextContent("import pandas as pd");
    expect(screen.getByText(/mean_share_pct/)).toBeInTheDocument();
  });

  it("names an artifact the run produced", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /show code/i }));

    await waitFor(() => expect(screen.getByText("shares.png")).toBeInTheDocument());
    expect(screen.getByText("image/png")).toBeInTheDocument();
  });

  it("says what a refused run means rather than showing a bare -3", async () => {
    mockReads(fetchMock, [{ ...EXECUTION, exit_status: -3, outcome: "refused" }]);

    renderRoute();

    await waitFor(() => expect(screen.getByText("refused")).toBeInTheDocument());
    expect(screen.getByText("exit -3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show code/i }));
    await waitFor(() =>
      expect(screen.getByText(/execution cap stopped this/i)).toBeInTheDocument(),
    );
  });

  it("shows a failed run's stderr rather than hiding the failure", async () => {
    mockReads(
      fetchMock,
      [{ ...EXECUTION, exit_status: 1, outcome: "error", artifact_count: 0 }],
      {
        ...DETAIL,
        exit_status: 1,
        outcome: "error",
        stdout: null,
        stderr: "ZeroDivisionError: division by zero",
        artifacts: [],
      },
    );

    renderRoute();
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /show code/i }));

    await waitFor(() =>
      expect(screen.getByText(/ZeroDivisionError: division by zero/)).toBeInTheDocument(),
    );
  });

  it("empty state explains what a code execution is, not 'No data'", async () => {
    mockReads(fetchMock, []);

    renderRoute();

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    expect(screen.getByText(/writes a small program and runs it in the sandbox/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go to ask/i })).toBeInTheDocument();
  });

  it("links the producing agent to its own detail page", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /sales-analyst/i })).toHaveAttribute(
      "href",
      "/agents/5",
    );
  });

  it("surfaces a failed detail fetch in the row rather than silently showing nothing", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
      if (request.url.endsWith("/agent/code-executions")) {
        return Promise.resolve(jsonResponse([EXECUTION]));
      }
      return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /show code/i }));

    await waitFor(() => expect(screen.queryByTestId("execution-code")).not.toBeInTheDocument());
    expect(screen.getByText(/boom|couldn't reach/i)).toBeInTheDocument();
  });
});
