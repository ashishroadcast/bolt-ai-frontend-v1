import { useEffect, useState } from "react";
import { useAskClient } from "../config.tsx";
import { GatewayError } from "../http/errors.ts";

/**
 * The agents Ask can run a question against.
 *
 * Only three fields, and that is the whole reason this exists separately
 * from the console's `useAgents`. That hook returns `AgentSummary` for
 * admin screens — the Agents list, an agent's detail page, the
 * Orchestrators membership picker — and lives in the console alongside
 * `getAgent`, `AgentDetail`, model bindings and mcp bindings, none of which
 * a chat widget has any business knowing about.
 *
 * Ask needs a dropdown: which agents exist, what are they called, is this
 * one still on. Fetching that itself keeps the widget drop-in — a host
 * embedding Ask should not have to fetch and hand over an agent list — and
 * keeps the package from importing the console's agents module, which is
 * what "separate Ask from admin" actually means.
 *
 * The endpoint is gated on `agent.chat.use`, the same permission asking a
 * question needs, so a caller who can use Ask can always populate its
 * picker. (The console's richer `GET /agent/agents/{id}` is gated on
 * `agent.agents` instead, which is why that one stays out here.)
 */
export interface AskAgent {
  id: number;
  name: string;
  is_active: boolean;
}

export interface UseAskAgentsResult {
  agents: AskAgent[];
  loading: boolean;
  error: string | null;
}

export function useAskAgents(): UseAskAgentsResult {
  const client = useAskClient();
  const [agents, setAgents] = useState<AskAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .agentFetch<AskAgent[]>("/agent/agents")
      .then((result) => {
        if (!cancelled) setAgents(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof GatewayError ? err.message : "Couldn't reach the agent service.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { agents, loading, error };
}

/**
 * The console's hook name, kept as an alias so the components that moved
 * into this package read the same as before the move.
 *
 * Not a compatibility shim for outside callers — nothing outside `src/ask/`
 * imports this. It exists so `AgentPicker` and `Thread` did not have to be
 * re-read line by line during the extraction, which is how a mechanical
 * move turns into a behavioural change nobody meant.
 */
export { useAskAgents as useAgents };
