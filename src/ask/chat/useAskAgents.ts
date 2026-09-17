import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
  /** What the agent is for, as its operator wrote it. Shown in the composer's
   *  command menu, where a name alone does not say what `/form` will do. */
  description?: string | null;
  /**
   * The `/word` that arms this agent from the composer, when an operator has
   * configured one. Null for the ordinary case of an agent reached by picking
   * it from the list.
   *
   * It comes off this endpoint rather than a list of its own so the command
   * menu is built from the agents THIS caller can actually use. A menu from
   * anywhere else would offer `/form` to a tenant with no form-drafting agent
   * and the run would then fail on a name that does not exist there.
   *
   * Optional in the type, not just nullable: this widget is deployed as a
   * vendored tarball and can be running against an agent-service that
   * predates the field.
   */
  slash_command?: string | null;
}

export interface UseAskAgentsResult {
  agents: AskAgent[];
  loading: boolean;
  error: string | null;
}

/**
 * The one fetch, shared by every consumer on the screen.
 *
 * Two components read this list — `AgentPicker`, and `Composer` for its `/`
 * menu — and before this context each one fetched its own copy, so opening
 * the panel made the same request twice. Sharing it here rather than
 * memoising inside the hook keeps the fetch tied to a mounted subtree: a
 * module-level cache would outlive a signed-out session and hand the next
 * one the previous tenant's agent names.
 */
const AskAgentsContext = createContext<UseAskAgentsResult | null>(null);

export function AskAgentsProvider({ children }: { children: ReactNode }) {
  const agents = useFetchedAgents();
  return createElement(AskAgentsContext.Provider, { value: agents }, children);
}

export function useAskAgents(): UseAskAgentsResult {
  const shared = useContext(AskAgentsContext);
  const own = useFetchedAgents({ skip: shared !== null });
  return shared ?? own;
}

/**
 * `skip` exists because hooks cannot be called conditionally: when the
 * provider is above us its result is what we return, and firing a second
 * identical request just to throw the answer away is the very thing the
 * provider was added to stop.
 */
function useFetchedAgents({ skip = false }: { skip?: boolean } = {}): UseAskAgentsResult {
  const client = useAskClient();
  const [agents, setAgents] = useState<AskAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (skip) return;
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
  }, [client, skip]);

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
