import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunMeta, type RunMetaProps } from "./RunMeta.tsx";
import { TestAskProvider } from "../testing.tsx";

function renderStrip(overrides: Partial<RunMetaProps> = {}) {
  const props: RunMetaProps = {
    messageId: "400084",
    answerText: "Top store: The Bombay Canteen.",
    agentName: "Sales-Analyst",
    observedMs: 99_000,
    rerunDisabled: false,
    showRunDetails: true,
    ...overrides,
  };
  return render(<RunMeta {...props} />, { wrapper: TestAskProvider });
}

describe("RunMeta", () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says who answered and how long it took, and nothing about how it was produced", () => {
    renderStrip();

    expect(screen.getByText("Sales-Analyst")).toBeInTheDocument();
    expect(screen.getByText("Worked for 1m 39s")).toBeInTheDocument();
    // The model ids, tool count, score, tokens and cost moved to RunDebug.
    expect(screen.queryByText(/tools?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^score /)).not.toBeInTheDocument();
    expect(screen.queryByText(/tok$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("names no agent at all when the run's own record does not name one", () => {
    renderStrip({ agentName: null });
    expect(screen.queryByText("Sales-Analyst")).not.toBeInTheDocument();
  });

  it("offers a debug toggle only when there is something behind it", () => {
    const { rerender } = renderStrip({ onToggleDebug: undefined });
    expect(screen.queryByRole("button", { name: /debug/i })).not.toBeInTheDocument();

    const onToggleDebug = vi.fn();
    rerender(<RunMeta
        messageId="400084"
        answerText="a"
        agentName="A"
        observedMs={1000}
        rerunDisabled={false}
        showRunDetails
        isDebugOpen={false}
        onToggleDebug={onToggleDebug}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show debug" }));
    expect(onToggleDebug).toHaveBeenCalledTimes(1);
  });

  it("sends a real rating against the message's own row id and keeps the result visible", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            feedback_id: 1,
            exemplars_promoted: 0,
            invalidated: 0,
            corrections_added: 0,
            assessment_logged: false,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderStrip();

    fireEvent.click(screen.getByRole("button", { name: "Rate this answer helpful" }));

    await waitFor(() => expect(screen.getByText("Helpful")).toBeInTheDocument());
    // `agentFetch` calls fetch with a real Request object, so the body is
    // read back off the request rather than off an init argument.
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.url).toContain("/agent/feedback");
    expect(await request.json()).toEqual({ message_id: 400084, rating: "up" });
  });

  it("shows no rating until the server has actually recorded it", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    renderStrip();

    fireEvent.click(screen.getByRole("button", { name: "Rate this answer helpful" }));

    // In flight: the click has been sent, but nothing claims it landed.
    // Showing "Helpful" here and rolling it back on failure would tell the
    // operator their vote was recorded when it may not have been.
    await waitFor(() => expect(screen.getByRole("button", { name: "Rate this answer helpful" })).toHaveAttribute("aria-pressed", "false"));
    expect(screen.queryByText("Helpful")).not.toBeInTheDocument();

    release(new Response(JSON.stringify({ feedback_id: 1 }), { status: 201, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(screen.getByText("Helpful")).toBeInTheDocument());
  });

  it("says so in place when a rating fails, instead of silently reverting", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))));
    renderStrip();

    fireEvent.click(screen.getByRole("button", { name: "Rate this answer unhelpful" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Rating didn't save"));
  });

  it("hides the rating controls for a message with no server row to rate", () => {
    // useChat.ts's local placeholder id — a run that failed before the
    // `start` chunk ever arrived. A thumbs-up here could only 404.
    renderStrip({ messageId: "run-3" });
    expect(screen.queryByRole("button", { name: /^Rate this answer/ })).not.toBeInTheDocument();
  });

  describe("retry without the cached plan", () => {
    it("offers it only when the answer reused a cached plan", () => {
      const { rerender } = renderStrip();
      expect(screen.queryByText("Retry without cache")).not.toBeInTheDocument();

      rerender(<RunMeta
          messageId="400084"
          answerText="x"
          agentName="Sales-Analyst"
          observedMs={99_000}
          rerunDisabled={false}
          showRunDetails
          onRetryFresh={() => {}}
        />,
      );
      expect(screen.getByText("Retry without cache")).toBeInTheDocument();
    });

    it("triggers the forget-and-rerun on click", () => {
      const onRetryFresh = vi.fn();
      renderStrip({ onRetryFresh });

      fireEvent.click(screen.getByText("Retry without cache"));

      expect(onRetryFresh).toHaveBeenCalledOnce();
    });
  });
});

describe("RunMeta under the tenant's disclosure", () => {
  function strip(showRunDetails: boolean) {
    return render(
      <RunMeta
        messageId="400084"
        answerText="Top store: The Bombay Canteen."
        agentName="Sales-Analyst"
        observedMs={99_000}
        rerunDisabled={false}
        onRerun={() => {}}
        isDebugOpen={false}
        onToggleDebug={() => {}}
        showRunDetails={showRunDetails}
      />,
      { wrapper: TestAskProvider },
    );
  }

  it("offers the debug drawer only when the tenant shows reasoning", () => {
    const { unmount } = strip(false);
    expect(screen.queryByRole("button", { name: /debug/i })).not.toBeInTheDocument();
    // What any reader can use stays.
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rerun this question" })).toBeInTheDocument();
    expect(screen.getByText("Sales-Analyst")).toBeInTheDocument();
    expect(screen.getByText(/1m 39s/)).toBeInTheDocument();
    unmount();

    strip(true);
    expect(screen.getByRole("button", { name: "Show debug" })).toBeInTheDocument();
  });
});

describe("RunMeta on a turn that did not end in an answer", () => {
  it("offers no rating on a failed, cancelled, empty or unfinished run", () => {
    for (const runStatus of ["error", "cancelled", "empty", "unfinished"] as const) {
      const { unmount } = render(
        <RunMeta
          messageId="400084"
          answerText=""
          runStatus={runStatus}
          agentName={null}
          observedMs={null}
          rerunDisabled={false}
          showRunDetails
        />,
        { wrapper: TestAskProvider },
      );
      expect(screen.queryByText("Was this helpful?")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("offers no Copy for an answer that is only whitespace", () => {
    render(
      <RunMeta
        messageId="400084"
        answerText={"  \n "}
        agentName={null}
        observedMs={null}
        rerunDisabled={false}
        showRunDetails
      />,
      { wrapper: TestAskProvider },
    );

    expect(screen.queryByRole("button", { name: "Copy answer" })).not.toBeInTheDocument();
  });
});
