import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  /** The first load, before any answer. A retry after a failure is not
   * "loading": the failure stays on screen until something replaces it. */
  loading: boolean;
  /** Why the list could not be loaded, as a sentence to show as it is. */
  error: string | null;
  /** Whether trying again could help. False for a missing permission (403):
   * the same request is refused the same way until an admin acts. */
  canRetry: boolean;
  /** A retry is in flight right now. */
  retrying: boolean;
  /** Fetches the list again now, restarting the automatic backoff. */
  retry: () => void;
}

/**
 * The waits before each automatic retry of a failed list, then it stops.
 *
 * Retried at all because one failed load used to leave the panel dead until
 * the page was reloaded: with no agents the composer stays disabled, and
 * nothing ever fetched again. Stopped after three because a service still
 * down after twenty-odd seconds is not restarting, and polling it forever
 * only adds noise to its logs. Past that, "Try again", coming back online
 * and returning to the tab each start it again.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

interface AgentsState {
  agents: AskAgent[];
  loading: boolean;
  error: string | null;
  canRetry: boolean;
  retrying: boolean;
}

const INITIAL_STATE: AgentsState = {
  agents: [],
  loading: true,
  error: null,
  canRetry: false,
  retrying: false,
};

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
  const [state, setState] = useState<AgentsState>(INITIAL_STATE);
  // Bumped to fetch again: by a scheduled retry, by "Try again", or by the
  // browser coming back online or the tab coming back into view.
  const [attempt, setAttempt] = useState(0);
  // How many automatic retries this run of failures has used.
  const failuresRef = useRef(0);
  // The last attempt failed in a way a retry could fix. What the `online`
  // and `visibilitychange` listeners check, so a healthy list is never
  // refetched just because someone switched tabs.
  const recoverableRef = useRef(false);
  const inFlightRef = useRef(false);
  const clientRef = useRef(client);

  useEffect(() => {
    if (skip) return;
    // A different client is a different backend: neither its list nor its
    // failures carry over.
    const newClient = clientRef.current !== client;
    clientRef.current = client;
    if (newClient) failuresRef.current = 0;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    inFlightRef.current = true;
    setState((prev) => {
      if (newClient) return INITIAL_STATE;
      // A retry keeps the failure on screen, marked as being retried, rather
      // than going back to "Finding agents…" — flipping between the two every
      // few seconds reads as flicker, not progress.
      return prev.error === null ? { ...prev, loading: true } : { ...prev, retrying: true };
    });

    client
      .agentFetch<AskAgent[]>("/agent/agents")
      .then((agents) => {
        if (cancelled) return;
        failuresRef.current = 0;
        recoverableRef.current = false;
        setState({ agents, loading: false, error: null, canRetry: false, retrying: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Never a 403, a spent usage limit or any other refusal the server
        // would only repeat — see `GatewayError.retryable`.
        const canRetry = !(err instanceof GatewayError) || err.retryable;
        recoverableRef.current = canRetry;
        setState((prev) => ({
          agents: prev.agents,
          loading: false,
          error:
            err instanceof GatewayError
              ? err.message
              : "Couldn't load the assistant's agents. Try again in a moment.",
          canRetry,
          retrying: false,
        }));
        const delay = RETRY_DELAYS_MS[failuresRef.current];
        if (canRetry && delay !== undefined) {
          failuresRef.current += 1;
          timer = setTimeout(() => setAttempt((n) => n + 1), delay);
        }
      })
      .finally(() => {
        if (!cancelled) inFlightRef.current = false;
      });

    return () => {
      cancelled = true;
      inFlightRef.current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, skip, attempt]);

  const retry = useCallback(() => {
    if (inFlightRef.current) return;
    failuresRef.current = 0;
    setAttempt((n) => n + 1);
  }, []);

  // Two moments a failed list is worth another try without anyone asking:
  // the browser says it is back online, or the reader comes back to the tab
  // (a laptop reopened after the service restarted). Only after a failure a
  // retry could fix — never to refresh a list that loaded.
  useEffect(() => {
    if (skip) return;
    function wake() {
      if (document.visibilityState === "hidden") return;
      if (recoverableRef.current) retry();
    }
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [skip, retry]);

  return { ...state, retry };
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
