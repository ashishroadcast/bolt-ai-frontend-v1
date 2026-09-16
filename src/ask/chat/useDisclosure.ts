import { useEffect, useState } from "react";
import { useAskClient, useAskConfig } from "../config.tsx";

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
 * Resolves the disclosure, preferring whatever the host pinned.
 *
 * **Starts hidden and stays hidden if the fetch fails.** The alternative —
 * assume "show" until told otherwise — flashes the reasoning panel on every
 * cold load and leaves it up permanently whenever agent-service is
 * unreachable, which is the one state where a reader least wants a wall of
 * machinery. Failing to the quiet default is the safe direction here.
 *
 * Fetched once per mount rather than per run: it is tenant configuration, it
 * changes about never, and re-reading it between turns would put a request on
 * the path of every question to answer a question nobody asked.
 */
export function useAskDisclosure(): AskDisclosure {
  const client = useAskClient();
  const { disclosure } = useAskConfig();
  const pinned = disclosure !== undefined;
  const [resolved, setResolved] = useState<AskDisclosure>(disclosure ?? HIDDEN);

  useEffect(() => {
    // A host that passed one has already decided; asking anyway would let the
    // server quietly overrule an explicit choice.
    if (pinned) return;

    let cancelled = false;
    void (async () => {
      try {
        const body = await client.agentFetch<DisclosureResponse>("/agent/settings/ask");
        if (cancelled) return;
        setResolved({
          showReasoning: body.show_reasoning === true,
          showQueryResults: body.show_query_results === true,
        });
      } catch {
        // Deliberately silent, and deliberately no retry. This decides how
        // much chrome to draw, not whether the product works — a reader whose
        // settings call failed still gets their answer, just without the
        // machinery around it.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, pinned]);

  return pinned ? (disclosure as AskDisclosure) : resolved;
}
