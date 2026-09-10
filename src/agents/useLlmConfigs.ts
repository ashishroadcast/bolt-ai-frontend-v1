import { useEffect, useState } from "react";
import { GatewayError } from "../ask/http/errors.ts";
import { listLlmConfigs, type LLMConfig } from "../routes/llmConfigsApi.ts";

/**
 * The models this tenant has registered, for anywhere one has to be
 * chosen.
 *
 * `listLlmConfigs` has existed and been mounted the whole time — the agent
 * fleet already reads it to label which model each phase runs on. The
 * orchestrator form did not, and asked an operator to type the numeric id
 * instead, under help text that said "no endpoint lists LLM configs, so
 * this has to be typed". That was not true when it was written; the
 * endpoint is in the same file the fleet imports from.
 *
 * Shaped exactly like `useAgents` next door, deliberately: a second
 * fetch-once-and-report hook that behaves differently from the one beside
 * it is a thing every future reader has to check.
 */
export interface UseLlmConfigsResult {
  llmConfigs: LLMConfig[];
  loading: boolean;
  error: string | null;
}

export function useLlmConfigs(): UseLlmConfigsResult {
  const [llmConfigs, setLlmConfigs] = useState<LLMConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listLlmConfigs()
      .then((result) => {
        if (!cancelled) setLlmConfigs(result);
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

  return { llmConfigs, loading, error };
}

/**
 * The configs an orchestrator may actually be bound to, best first.
 *
 * An orchestrator routes or synthesises with a chat model, so an
 * embedding config is not a candidate — offering one would produce a
 * binding that fails at the first call. An inactive one is not either.
 * The tenant default sorts first so the common case is already selected
 * when the form opens.
 */
export function selectableChatConfigs(configs: LLMConfig[]): LLMConfig[] {
  return configs
    .filter((config) => config.kind === "chat" && config.is_active)
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
