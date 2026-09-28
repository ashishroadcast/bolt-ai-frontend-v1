import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestAskProvider } from "../testing.tsx";
import { AgentPicker } from "./AgentPicker.tsx";
import { ChatProvider, useChatContext } from "./ChatContext.tsx";
import { AskAgentsProvider, type AskAgent } from "./useAskAgents.ts";

const AGENTS: AskAgent[] = [
  { id: 1, name: "Sales Analyst", is_active: true, slash_command: null },
  { id: 2, name: "Form-Builder", is_active: true, slash_command: "form" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Hands the test `setSelectedAgent`, the way the composer's `/` menu or
 * the element's `selectAgent()` would arm one. */
let arm: (name: string | null) => void = () => {};
let armed: string | null = null;
function ArmFromOutside() {
  const chat = useChatContext();
  arm = chat.setSelectedAgent;
  armed = chat.selectedAgent;
  return null;
}

function mount() {
  return render(
    <TestAskProvider>
      <ChatProvider>
        <AskAgentsProvider>
          <ArmFromOutside />
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

describe("AgentPicker armed chip", () => {
  it("lets go of an armed agent from its own ×, without starting a new conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(AGENTS)));
    mount();
    await waitFor(() => expect(screen.queryByText("Finding agents…")).toBeNull());

    act(() => arm("Form-Builder"));
    expect(screen.getByText("Form-Builder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop chatting with Form-Builder" }));

    expect(screen.queryByText("Form-Builder")).not.toBeInTheDocument();
    expect(screen.queryByText("Chatting with")).not.toBeInTheDocument();
  });

  it("disarms by itself an agent that is no longer in the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json([...AGENTS, { id: 3, name: "Old", is_active: false, slash_command: "old" }])),
    );
    mount();
    // Armed before the list has answered — nothing to check it against yet,
    // so it is left alone until the list lands.
    act(() => arm("Retired-Agent"));
    expect(armed).toBe("Retired-Agent");

    // Waited for itself, not for the list: the disarm is an effect, and it
    // runs a beat after the render that took "Finding agents…" away.
    await waitFor(() => expect(armed).toBeNull());
    expect(screen.queryByText("Finding agents…")).toBeNull();

    // Present but deactivated counts as gone too.
    act(() => arm("Old"));
    expect(armed).toBeNull();

    act(() => arm("Sales Analyst"));
    expect(armed).toBe("Sales Analyst");
    expect(screen.getByText("Sales Analyst")).toBeInTheDocument();
  });
});

describe("AgentPicker with no agents", () => {
  it("opens the setup link in a new tab, so an embedding host keeps its own", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    mount();

    const link = await screen.findByRole("link", { name: "Set one up" });
    expect(link).toHaveAttribute("href", "/agents");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says a whole sentence, with no link, when the host gave nowhere to send anyone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(
      <TestAskProvider config={{ setupAgentsHref: undefined }}>
        <ChatProvider>
          <AskAgentsProvider>
            <AgentPicker />
          </AskAgentsProvider>
        </ChatProvider>
      </TestAskProvider>,
    );

    expect(await screen.findByText("No agents are set up yet. Ask an admin to set one up.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
