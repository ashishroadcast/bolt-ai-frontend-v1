import { useEffect } from "react";
import { useAskConfig } from "../config.tsx";
import { useChatContext } from "./ChatContext.tsx";
import { useAskAgents } from "./useAskAgents.ts";

/**
 * Arming an agent from OUTSIDE the React tree — `element.selectAgent('dashboard')`.
 *
 * A host's "Create with AI" button opens the panel and wants the Dashboard
 * Builder armed, exactly as if the reader had typed `/dashboard` and picked it
 * from the composer's menu. The host has no way into `ChatContext`, so it gets
 * this channel instead: the element owns one, hands it down through
 * `AskConfig.agentSelection`, and `AgentSelectionBridge` (mounted beside the
 * agent picker) answers it.
 *
 * **The agents may not have loaded yet** — the host typically calls this in
 * the same tick it opens the panel, before `GET /agent/agents` has answered,
 * or before the element has even been given its `baseUrl`. So a request that
 * cannot be decided yet is REMEMBERED, and applied the moment the list lands:
 *
 * - list loaded, an active agent has that command → armed now, `true`.
 * - list loaded, no such agent (or the list failed to load) → `false`, and
 *   nothing is remembered.
 * - list not loaded yet → remembered, `true`: it will be applied when the list
 *   loads, provided the tenant turns out to have that agent. If it does not,
 *   the request is dropped with a console warning — a `true` here means
 *   "accepted", because "available" cannot be known yet.
 *
 * Only the latest request is remembered; a second call replaces the first.
 */
export type AgentSelectionOutcome = "armed" | "unavailable" | "pending";

type Resolver = (command: string) => AgentSelectionOutcome;

/** `/Dashboard ` and `dashboard` are the same command. */
function normalise(command: string): string {
  return command.trim().replace(/^\/+/, "").toLowerCase();
}

export class AgentSelectionChannel {
  private pending: string | null = null;
  private resolver: Resolver | null = null;

  /** See the module docstring for what the boolean means. */
  request(slashCommand: string): boolean {
    const command = normalise(slashCommand);
    if (command === "") return false;
    const outcome = this.resolver?.(command) ?? "pending";
    this.pending = outcome === "pending" ? command : null;
    return outcome !== "unavailable";
  }

  /** The request still waiting on the agent list, if any. */
  get pendingCommand(): string | null {
    return this.pending;
  }

  /** Forgets a request still waiting on the list — the element's
   * `clearAgent()`, which must not be undone a moment later by a
   * `selectAgent()` that had not landed yet. */
  cancel(): void {
    this.pending = null;
  }

  /**
   * Attaches the thing that can actually arm an agent, and applies a waiting
   * request through it. Returns the detach function (an effect cleanup).
   */
  connect(resolver: Resolver): () => void {
    this.resolver = resolver;
    if (this.pending !== null) {
      const command = this.pending;
      const outcome = resolver(command);
      if (outcome !== "pending") this.pending = null;
      if (outcome === "unavailable") {
        console.warn(
          `<bolt-ai-ask> selectAgent('${command}') was dropped: no active agent has that slash command.`,
        );
      }
    }
    return () => {
      if (this.resolver === resolver) this.resolver = null;
    };
  }
}

/**
 * Answers the channel from inside the tree. Renders nothing.
 *
 * Mounted AFTER `AgentPicker` in `Ask.tsx` — no longer load-bearing the way
 * it once was (the picker set no default of its own to race against once
 * question-routing stopped requiring a manual pick), but still the
 * sensible order: this is the more specific request, and it should be the
 * one namable in the picker's own "Chatting with" line once it resolves.
 */
export function AgentSelectionBridge(): null {
  const { agentSelection } = useAskConfig();
  const { agents, loading, error } = useAskAgents();
  const { setSelectedAgent } = useChatContext();

  useEffect(() => {
    if (agentSelection === undefined) return;
    return agentSelection.connect((command) => {
      if (loading) return "pending";
      if (error !== null) return "unavailable";
      const agent = agents.find(
        (candidate) =>
          candidate.is_active &&
          typeof candidate.slash_command === "string" &&
          normalise(candidate.slash_command) === command,
      );
      if (agent === undefined) return "unavailable";
      setSelectedAgent(agent.name);
      return "armed";
    });
  }, [agentSelection, agents, loading, error, setSelectedAgent]);

  return null;
}
