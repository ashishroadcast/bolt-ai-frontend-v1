import { useCallback, useEffect, useState } from "react";
import { GatewayError } from "../ask/http/errors.ts";
import { listOrchestrators } from "./api.ts";
import type { Orchestrator } from "./types.ts";

export interface UseOrchestratorsResult {
  orchestrators: Orchestrator[];
  loading: boolean;
  error: string | null;
  /** Set the list directly after a create/update/delete this component
   * already knows the outcome of, instead of a full refetch. */
  setOrchestrators: (next: Orchestrator[]) => void;
  refresh: () => void;
}

/** `GET /agent/orchestrators`, loaded on mount with a manual `refresh`. */
export function useOrchestrators(): UseOrchestratorsResult {
  const [orchestrators, setOrchestrators] = useState<Orchestrator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listOrchestrators()
      .then((result) => {
        if (!cancelled) setOrchestrators(result);
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
  }, [generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  return { orchestrators, loading, error, setOrchestrators, refresh };
}
