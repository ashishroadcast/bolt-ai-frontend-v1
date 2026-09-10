import { useCallback, useEffect, useState } from "react";
import { GatewayError } from "../api/errors.ts";
import { getSession } from "../auth/session.ts";
import { listDatasources } from "../routes/datasourcesApi.ts";
import { listLlmConfigs } from "../routes/llmConfigsApi.ts";
import { listMcpServers } from "../routes/mcpServersApi.ts";
import { getAgent, listAgents, updateAgent } from "./api.ts";
import { PROMPT_PHASES, type AgentSummary, type CodeExecutionCapability } from "./types.ts";

/** What an agent is wired to, with every id already resolved to a name.
 * `null` on a row whose `GET /agent/agents/{id}` could not be read — see
 * `useAgentFleet`'s own docstring for why that is a degraded card rather
 * than a failed screen. */
export interface AgentWiring {
  datasourceName: string | null;
  /** Distinct model names actually pinned, in phase order. An agent with
   * every phase on the tenant default has none, which is a real state and
   * reads as such — never as "no model". */
  modelNames: string[];
  pinnedPhaseCount: number;
  phaseCount: number;
  mcpServerNames: string[];
  codeExecution: CodeExecutionCapability;
}

export interface AgentFleetRow {
  agent: AgentSummary;
  wiring: AgentWiring | null;
}

export interface UseAgentFleetResult {
  rows: AgentFleetRow[];
  loading: boolean;
  /** `GET /agent/agents` failed — there is no list to show at all. */
  error: string | null;
  /** The wiring reads failed but the list did not. Cards render without
   * their wiring line; this says why, once, rather than per card. */
  wiringError: string | null;
  /** `PATCH /agent/agents/{id}` `is_active`. Resolves to the write's own
   * error message, or `null` when it landed. */
  setActive: (id: number, isActive: boolean) => Promise<string | null>;
}

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/**
 * The Agents screen's whole read: the agent list, plus what each agent is
 * actually wired to, with every id resolved to the name an operator knows
 * it by.
 *
 * **Wiring costs one `GET /agent/agents/{id}` per agent, and there is no
 * bulk alternative.** `GET /agent/agents` is a picker surface gated on the
 * narrower `agent.chat.use` and deliberately carries none of it
 * (`app.api.agents`'s own docstring); `datasource_id`, `llm_bindings`,
 * `code_execution` and `mcp_server_ids` live only on the per-agent read.
 * `listMcpServerBindings` (`routes/mcpServersApi.ts`) already fans out the
 * same way for the same reason — an admin screen over a tenant's handful
 * of agents, not a hot path.
 *
 * **A wiring failure degrades a card, it does not fail the screen.** The
 * detail read is gated on `agent.agents`/`can_read` while the list is not,
 * so an operator who may run agents but not read their configuration is a
 * real, expected caller. They get the list, with `wiring: null` rows and
 * one explanation — never an empty screen implying this tenant has no
 * agents.
 */
export function useAgentFleet(): UseAgentFleetResult {
  const [rows, setRows] = useState<AgentFleetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wiringError, setWiringError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Which half of the chain below threw decides which message the
    // screen gets, and only this closure knows — by the time `.catch`
    // runs, `loading` is already stale.
    let listLanded = false;

    listAgents()
      .then(async (agents) => {
        if (cancelled) return;
        // The list lands first and on its own: the cards are already
        // useful without their wiring line, and making them wait on four
        // more round trips would trade the whole screen's time-to-content
        // for one supplementary row of text.
        setRows(agents.map((agent) => ({ agent, wiring: null })));
        setLoading(false);
        listLanded = true;

        // Do not fan out for a caller who cannot read configuration. The four
        // reads below are all gated on permissions this session does not hold,
        // so every one of them — including one `GET /agent/agents/{id}` PER
        // AGENT — is a guaranteed 403 that still pays the full auth cost on the
        // server. On the Agents screen that was nine simultaneous requests for
        // a five-agent tenant, five of them refused before they were sent.
        //
        // `permissions === undefined` means "unknown" (a session restored from
        // an older stored value, or the POS password path), and is deliberately
        // NOT treated as "no". Skipping on unknown would silently hide wiring
        // from operators who can see it; asking and getting a 403 costs one
        // round trip and degrades to the same `wiringError` it always did.
        const permitted = getSession()?.permissions;
        if (permitted !== undefined && !permitted.includes("agent.agents")) {
          setWiringError(
            "Agent wiring needs the agent.agents permission, which this account does not have.",
          );
          return;
        }

        const [details, datasources, llmConfigs, mcpServers] = await Promise.all([
          Promise.all(agents.map((agent) => getAgent(agent.id))),
          listDatasources(),
          listLlmConfigs(),
          listMcpServers(),
        ]);
        if (cancelled) return;

        const datasourceName = new Map(datasources.map((d) => [d.id, d.name]));
        const modelName = new Map(llmConfigs.map((c) => [c.id, c.name]));
        const serverName = new Map(mcpServers.map((s) => [s.id, s.name]));

        setRows(
          agents.map((agent, index) => {
            const detail = details[index]!;
            const pinned = PROMPT_PHASES.filter(
              (phase) => detail.llm_bindings[phase] !== undefined,
            );
            const names: string[] = [];
            for (const phase of pinned) {
              const id = detail.llm_bindings[phase]!;
              // A binding pointing at a config this tenant no longer has
              // still names something legible rather than vanishing — the
              // same honesty ConfigTab's own `llmConfigLabel` keeps.
              const name = modelName.get(id) ?? `Unknown model (id ${id})`;
              if (!names.includes(name)) names.push(name);
            }
            return {
              agent,
              wiring: {
                datasourceName:
                  detail.datasource_id === null
                    ? null
                    : (datasourceName.get(detail.datasource_id) ??
                      `Unknown datasource (id ${detail.datasource_id})`),
                modelNames: names,
                pinnedPhaseCount: pinned.length,
                phaseCount: PROMPT_PHASES.length,
                mcpServerNames: detail.mcp_server_ids.map(
                  (id) => serverName.get(id) ?? `Unknown server (id ${id})`,
                ),
                codeExecution: detail.code_execution,
              },
            };
          }),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Once the list has landed, a throw is the wiring fan-out's and
        // must not blank cards that are already on screen.
        if (listLanded) setWiringError(errorMessage(err));
        else setError(errorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setActive = useCallback(async (id: number, isActive: boolean) => {
    try {
      const updated = await updateAgent(id, { is_active: isActive });
      // The server's own post-write state, not the value that was sent —
      // the same rule ConfigTab documents for every control it owns.
      setRows((prev) =>
        prev.map((row) =>
          row.agent.id === id
            ? { ...row, agent: { ...row.agent, is_active: updated.is_active } }
            : row,
        ),
      );
      return null;
    } catch (err: unknown) {
      return errorMessage(err);
    }
  }, []);

  return { rows, loading, error, wiringError, setActive };
}
