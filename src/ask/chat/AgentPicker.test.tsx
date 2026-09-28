import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestAskProvider } from "../testing.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { ChatProvider } from "./ChatContext.tsx";
import { AskAgentsProvider, type AskAgent } from "./useAskAgents.ts";

const AGENTS: AskAgent[] = [
  { id: 1, name: "Sales Analyst", is_active: true, slash_command: null },
  { id: 2, name: "Form-Builder", is_active: true, slash_command: "form" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mount() {
  return render(
    <TestAskProvider>
      <ChatProvider>
        <AskAgentsProvider>
          <AgentPicker />
        </AskAgentsProvider>
      </ChatProvider>
    </TestAskProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentPicker error bar", () => {
  it("says what went wrong in words and offers Try again, which reloads the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>Bad Gateway</html>", { status: 502 }))
      .mockResolvedValue(json(AGENTS));
    vi.stubGlobal("fetch", fetchMock);
    mount();

    expect(await screen.findByText("The assistant is temporarily unavailable.")).toBeInTheDocument();
    // Not the old "Request to /agent/agents failed (502)."
    expect(screen.queryByText(/\/agent\/agents/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByText("The assistant is temporarily unavailable.")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers no Try again for a missing permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "missing permission agent.chat.use" }, 403)));
    mount();

    expect(
      await screen.findByText("You don't have permission to use the assistant. Ask an admin for access."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
