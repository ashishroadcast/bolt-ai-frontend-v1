import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { useAskClient, useAskConfig } from "../config.tsx";
import type { GatewayClient } from "../http/gatewayClient.ts";

/**
 * How much of a run this reader should see.
 *
 * Ask used to show everything: every reasoning step as it streamed, and every
 * tool result as a table. For whoever built the agent that is the product —
 * it is how you see which phase was slow and which rows an answer came from.
 * For the operator the agent was built FOR it is machinery in front of the
 * one sentence they asked for, and a 762-row table between the question and
 * the answer reads as the product being broken rather than being transparent.
 *
 * So both are OFF unless the tenant turned them on, and the tenant says so in
 * agent-service (`/agent/settings/ask`), not here — the same answer has to
 * hold in bolt-v2's Ask panel and in this console, and a flag living in one
 * frontend could not.
 */
export interface AskDisclosure {
  showReasoning: boolean;
  showQueryResults: boolean;
}

export const HIDDEN: AskDisclosure = { showReasoning: false, showQueryResults: false };

interface DisclosureResponse {
  show_reasoning?: boolean;
  show_query_results?: boolean;
}

/**
 * The last answer each client got, so a provider that mounts again — the
 * thread is swapped for the empty state and back whenever a conversation is
 * cleared — starts from what the tenant said rather than from hidden, and
 * does not flash the reasoning and tables off and on again while it asks.
 * Keyed by client because two Ask instances on one page can belong to two
 * tenants, and a module-wide value would hand one the other's setting.
 */
const lastKnown = new WeakMap<GatewayClient, AskDisclosure>();

/**
 * Resolves the disclosure, preferring whatever the host pinned. `active`
 * false skips the request, for a caller that already has a provider above
 * it and only calls this because hooks cannot be called conditionally.
 *
 * **Starts hidden and stays hidden if the fetch fails.** The alternative —
 * assume "show" until told otherwise — flashes the reasoning panel on every
 * cold load and leaves it up permanently whenever agent-service is
 * unreachable, which is the one state where a reader least wants a wall of
 * machinery. Failing to the quiet default is the safe direction here. A
 * value this client already resolved once is better than either, so that
 * is where it starts when there is one.
 */
function useResolvedDisclosure(active: boolean): AskDisclosure {
  const client = useAskClient();
  const { disclosure } = useAskConfig();
  const pinned = disclosure !== undefined;
  const [resolved, setResolved] = useState<AskDisclosure>(() => lastKnown.get(client) ?? HIDDEN);

  useEffect(() => {
    // A host that passed one has already decided; asking anyway would let the
    // server quietly overrule an explicit choice.
    if (pinned || !active) return;

    let cancelled = false;
    void (async () => {
      try {
        const body = await client.agentFetch<DisclosureResponse>("/agent/settings/ask");
        const next: AskDisclosure = {
          showReasoning: body.show_reasoning === true,
          showQueryResults: body.show_query_results === true,
        };
        lastKnown.set(client, next);
        if (cancelled) return;
        setResolved(next);
      } catch {
        // Deliberately silent, and deliberately no retry. This decides how
        // much chrome to draw, not whether the product works — a reader whose
        // settings call failed still gets their answer, just without the
        // machinery around it. Whatever was last known stays in force.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, pinned, active]);

  return pinned ? (disclosure as AskDisclosure) : resolved;
}

const AskDisclosureContext = createContext<AskDisclosure | null>(null);

/**
 * Resolves the disclosure once for everything under it.
 *
 * **Why a provider.** `useAskDisclosure` used to fetch on every mount, and
 * every answer on screen mounted one: a 30-turn thread made 31 requests for
 * one tenant setting, and each new answer started hidden until its own
 * request came back, so reasoning and tables vanished and popped back the
 * moment a run finished. `Thread` mounts this around the whole list, so the
 * answer that replaces a live run reads the same value the run was shown
 * with.
 *
 * Fetched once per mount rather than per run: it is tenant configuration, it
 * changes about never, and re-reading it between turns would put a request on
 * the path of every question to answer a question nobody asked.
 */
export function AskDisclosureProvider({ children }: { children: ReactNode }) {
  const value = useResolvedDisclosure(true);
  return createElement(AskDisclosureContext.Provider, { value }, children);
}

/**
 * The disclosure for this reader: the nearest `AskDisclosureProvider`'s, or
 * — outside one — resolved by this call itself, which is how it behaved
 * before the provider existed.
 */
export function useAskDisclosure(): AskDisclosure {
  const shared = useContext(AskDisclosureContext);
  const own = useResolvedDisclosure(shared === null);
  return shared ?? own;
}
