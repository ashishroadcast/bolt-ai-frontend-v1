import { useEffect, useState } from "react";
import { GatewayError } from "../ask/http/errors.ts";
import { listAgents } from "./api.ts";
import type { AgentSummary } from "./types.ts";

export interface UseAgentsResult {
  agents: AgentSummary[];
  loading: boolean;
  error: string | null;
}

/**
 * `GET /agent/agents`, loaded once and shared in shape (not in a cache —
 * each call site gets its own request) by every screen that needs to know
 * which agents exist: the Agents list itself, an agent's own detail page,
 * and the Orchestrators screen (to resolve `member_agent_ids` to names and
 * to populate the membership picker). Third real occurrence is what earns
 * this its own file rather than three copies of the same effect.
 */
export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAgents()
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
  }, []);

  return { agents, loading, error };
}
