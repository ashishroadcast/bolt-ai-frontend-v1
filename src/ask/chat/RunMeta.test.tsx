import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageMetadata } from "./protocol.ts";
import { RunMeta, type RunMetaProps } from "./RunMeta.tsx";
import { TestAskProvider } from "../testing.tsx";

const USAGE: UsageMetadata = {
  input_tokens: 31_872,
  output_tokens: 5378,
  total_tokens: 37_250,
  cost_usd: 0.021631,
  duration_ms: 98_590,
  calls: [
    { model: "openrouter/openai/gpt-5-mini", input_tokens: 1540, output_tokens: 744, cost_usd: 0.001873, priced: true },
  ],
};

function renderStrip(overrides: Partial<RunMetaProps> = {}) {
  const props: RunMetaProps = {
    messageId: "400084",
    answerText: "Top store: The Bombay Canteen.",
    agentName: "Sales-Analyst",
    toolCount: 2,
    score: 0.82,
    usage: USAGE,
    observedMs: 99_000,
    rerunDisabled: false,
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

  it("reports the agent, tool count, score, model, latency, cost and tokens the run really had", () => {
    renderStrip();

    expect(screen.getByText("Sales-Analyst")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeInTheDocument();
    expect(screen.getByText("score 0.82")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-5-mini")).toBeInTheDocument();
    expect(screen.getByText("1m 39s")).toBeInTheDocument();
    expect(screen.getByText("$0.0216")).toBeInTheDocument();
    expect(screen.getByText("37,250 tok")).toBeInTheDocument();
  });

  it("omits cost, tokens and model entirely when the run reported no usage — never a zero", () => {
    renderStrip({ usage: null });

    expect(screen.queryByText(/tok$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
    expect(screen.queryByText("openai/gpt-5-mini")).not.toBeInTheDocument();
    // The wall clock this client measured is a real observation, so it
    // stays even with no usage.
    expect(screen.getByText("1m 39s")).toBeInTheDocument();
  });

  it("omits a zero token count, which means unreported rather than free", () => {
    // A real captured call comes back {input_tokens: 0, output_tokens: 0,
    // cost_usd: 0.00524, priced: true} — the provider billed but did not
    // report counts. A run that produced an answer did not spend 0 tokens.
    renderStrip({ usage: { ...USAGE, total_tokens: 0 } });

    expect(screen.queryByText(/tok$/)).not.toBeInTheDocument();
    // The cost is a separate, independently-real measurement and stays.
    expect(screen.getByText("$0.0216")).toBeInTheDocument();
  });

  it("omits a zero cost for the same reason, while keeping a real token count", () => {
    renderStrip({ usage: { ...USAGE, cost_usd: 0 } });

    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
    expect(screen.getByText("37,250 tok")).toBeInTheDocument();
  });

  it("names no agent at all when the run's own record does not name one", () => {
    renderStrip({ agentName: null });
    expect(screen.queryByText("Sales-Analyst")).not.toBeInTheDocument();
  });

  it("omits the score when no judge ran, rather than showing 0.00", () => {
    renderStrip({ score: null });
    expect(screen.queryByText(/^score /)).not.toBeInTheDocument();
  });

  it("says one tool, not 1 tools", () => {
    renderStrip({ toolCount: 1 });
    expect(screen.getByText("1 tool")).toBeInTheDocument();
  });

  it("offers a debug toggle only when there is something behind it", () => {
    const { rerender } = renderStrip({ onToggleDebug: undefined });
    expect(screen.queryByRole("button", { name: /debug/i })).not.toBeInTheDocument();

    const onToggleDebug = vi.fn();
    rerender(<RunMeta
        messageId="400084"
        answerText="a"
        agentName="A"
        toolCount={1}
        score={null}
        usage={null}
        observedMs={1000}
        rerunDisabled={false}
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
          toolCount={2}
          score={0.1}
          usage={USAGE}
          observedMs={99_000}
          rerunDisabled={false}
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
