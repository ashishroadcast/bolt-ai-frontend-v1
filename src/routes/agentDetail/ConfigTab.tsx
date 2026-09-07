import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { attachMcpServer, detachMcpServer, getAgent, updateAgent } from "../../agents/api.ts";
import type { AgentDetail, AgentPatchInput, CodeExecutionCapability } from "../../agents/types.ts";
import { StatusPill } from "../../agents/StatusPill.tsx";
import { GatewayError } from "../../api/errors.ts";
import { listDatasources, type DataSource } from "../datasourcesApi.ts";
import { listLlmConfigs, type LLMConfig } from "../llmConfigsApi.ts";
import { listMcpServers, type McpServer } from "../mcpServersApi.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import styles from "./ConfigTab.module.css";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/**
 * Every phase a run goes through, in the order it runs them — not the
 * subset this agent happens to have bound. An unbound phase is a real,
 * correct state ("runs on the tenant default"), and it is also the state
 * an operator most often wants to change, so it needs a row and a control
 * rather than being absent from the list entirely.
 */
const PHASES = ["research", "plan", "execute", "validate", "guardrail"] as const;

const CODE_EXECUTION_OPTIONS: Array<{ value: CodeExecutionCapability; label: string; help: string }> = [
  { value: "none", label: "None", help: "The agent cannot run code." },
  { value: "interpreter", label: "Interpreter", help: "Python over its own query results, sandboxed." },
  { value: "code", label: "Code mode", help: "Generated code may call this agent's MCP tools." },
];

const CODE_EXECUTION_TONE: Record<CodeExecutionCapability, "neutral" | "amber" | "critical"> = {
  none: "neutral",
  interpreter: "amber",
  code: "critical",
};

function llmConfigLabel(id: number, configs: LLMConfig[]): string {
  const config = configs.find((candidate) => candidate.id === id);
  // A binding pointing at a config this tenant no longer has (deleted out
  // from under it) still renders as something legible, with the id as the
  // one honest fallback — never silently dropped.
  return config !== undefined ? `${config.name} · ${config.model}` : `Unknown model (id ${id})`;
}

/**
 * What {agent} is wired to, **and where it gets rewired.**
 *
 * This tab was read-only when it first shipped: it resolved every id to a
 * name and stopped there, so the console could describe an agent it gave
 * you no way to change — the datasource, the per-phase model and the tool
 * servers were all editable through the API and through nothing else.
 * Every control below writes to an endpoint that already existed.
 *
 * **Saves on change, not behind a Save button.** Each control owns one
 * field, so there is no partially-valid intermediate state a form would be
 * protecting; a settings page that makes you press Save after a dropdown
 * mostly produces changes people think they made and didn't. The trade-off
 * is that a failure arrives after the fact, so a failed write puts the
 * control back to what the server still holds and says so, rather than
 * leaving the screen claiming a binding that was never stored.
 */

/**
 * The capabilities an agent carries in `pipeline_config`, mirroring
 * `CAPABILITY_DEFAULTS` in `agent-service/app/agent/tools.py`.
 *
 * The defaults differ on purpose and the help text says why, because
 * "Vision: Off" and "Generative UI: On" for a freshly created agent looks
 * arbitrary otherwise. Kept as data rather than two hand-written blocks so
 * a third capability is one entry, not another copy of the same JSX.
 */
interface Capability {
  key: string;
  label: string;
  /** What this agent does when the key is absent, matching the server. */
  fallback: boolean;
  help: string;
  /** What turning it ON does to the rest of the page. */
  effect: string;
  /** What leaving it OFF does, when that is the surprising half. */
  offEffect?: string;
}

/**
 * How a phase reasons. Three modules, because `ProgramOfThought` and
 * `CodeAct` are deprecated in dspy 3.4 and `Flex`, `RLM` and `ReActV2` are
 * marked "may change or be removed without warning" — an agent's
 * configuration should not be deleted by a library upgrade.
 *
 * Set per phase rather than once for the agent, because the phases do
 * genuinely different work and the cost of reasoning is the wall clock on
 * this service. Which modules a phase offers is not a policy choice: ReAct
 * is a tool loop, and only planning and execution have tools to loop over.
 * Research retrieves through a fixed pipeline and validation scores an
 * answer that already exists, so ReAct there is an empty loop that bills
 * for the privilege.
 */
const REASONING_MODULES: Record<string, { label: string; short: string }> = {
  react: { label: "ReAct — reason and use tools", short: "ReAct" },
  chain_of_thought: { label: "Chain of thought — reason, then answer", short: "Chain of thought" },
  predict: { label: "Predict — answer directly", short: "Predict" },
};

/**
 * Which modules each phase may run, and what it does when nothing is
 * pinned — mirroring `PHASE_REASONING_CHOICES` and
 * `PHASE_REASONING_DEFAULTS` in `app/agent/tools.py`. The server refuses
 * anything outside these sets, so offering a choice it would reject is
 * only a way to produce an error someone did not need to see.
 */
const PHASE_REASONING: Record<string, { choices: string[]; fallback: string; what: string }> = {
  research: {
    choices: ["predict", "chain_of_thought"],
    fallback: "predict",
    what: "Finds the tables and documents worth reading.",
  },
  plan: {
    choices: ["predict", "chain_of_thought", "react"],
    fallback: "chain_of_thought",
    what: "Decides the approach. ReAct here only to ask you something.",
  },
  execute: {
    choices: ["predict", "chain_of_thought", "react"],
    fallback: "react",
    what: "Queries, charts and writes. ReAct unless the agent reads documents.",
  },
  validate: {
    choices: ["predict", "chain_of_thought"],
    fallback: "chain_of_thought",
    what: "Scores the answer against the request.",
  },
};

/**
 * The three switches, each with the consequence it has ELSEWHERE.
 *
 * `help` says what the setting is, in one line. `effect` says what turning
 * it on does to the rest of the page, and is shown only when it is on —
 * because that is the only time it is true, and a consequence stated
 * permanently reads as part of the description rather than as a live fact
 * about this agent.
 *
 * These were `<select>`s of On/Off with a four-line paragraph each. A
 * dropdown for a boolean hides the state behind a control you have to read
 * rather than glance at, and the paragraphs made the card 60% prose.
 */
const CAPABILITIES: Capability[] = [
  {
    key: "human_in_the_loop",
    label: "Ask before answering",
    fallback: false,
    help: "Asks you to clarify an ambiguous request.",
    // Terse and delimited rather than prose: these read as live facts about
    // this agent, and four toggles' worth of paragraphs buried the controls
    // they belonged to.
    effect: "Plan and execute run as ReAct · 3 questions max · 5 min each",
  },
  {
    key: "generative_ui",
    label: "Generative UI",
    fallback: true,
    help: "Lays the answer out — charts, stat rows, written reading.",
    effect: "",
    offEffect: "Off also drops the layout tools from every model call",
  },
  {
    key: "vision",
    label: "Vision",
    fallback: false,
    help: "Reads an image and answers questions about it.",
    effect: "Needs a vision-capable execute model · bills per image",
  },
  {
    key: "web_search",
    label: "Web search",
    fallback: false,
    help: "Looks things up on the open web.",
    effect: "Never for tenant data · needs a Tavily key, else search reports unavailable",
  },
];

/**
 * Only a real boolean flips a capability; anything else is the documented
 * default. Same rule as the server's `has_capability`, and for the same
 * reason: `pipeline_config` is JSON that can hold anything, and treating a
 * stray value as truthy would show Vision as On for an agent whose config
 * says "no".
 */

/**
 * Why a phase's reasoning is not the operator's to choose right now.
 *
 * These rules are the server's (`app.agent.tools.reasoning_module` and
 * `refuse_reasoning_config`) and they were invisible here: the selector
 * offered Predict on a warehouse agent, took the click, and surfaced the
 * refusal as an error after the save. Worse for Ask before answering,
 * which SILENTLY turns planning and execution into ReAct — the page went
 * on displaying "Chain of thought" for a phase that was running ReAct.
 *
 * A setting whose consequence lands on another control has to say so ON
 * that control. Returning the reason rather than a boolean is what lets
 * the row name the thing to change.
 */
function phaseLock(
  phase: string,
  config: Record<string, unknown>,
  datasource: DataSource | undefined,
): { module: string; because: string } | null {
  // The datasource first, and only for execute. Both can apply at once,
  // and naming the wrong one is worse than naming neither: "required by
  // Ask before answering" on a warehouse agent implies that turning asking
  // off would free the control, and it would not — execute stays ReAct
  // because that is the only module that can call run_sql.
  if (phase === "execute" && datasource !== undefined && datasource.type !== "knowledge") {
    return {
      module: "react",
      because: `querying ${datasource.name} — only ReAct can call run_sql`,
    };
  }
  if ((phase === "plan" || phase === "execute") && config.human_in_the_loop === true) {
    return { module: "react", because: "Ask before answering — asking is a tool call" };
  }
  return null;
}

/**
 * What a phase will actually run, matching the server's own
 * `reasoning_module(agent, phase)` — including its read of the scalar
 * `reasoning_module` key this replaced, which only ever configured
 * execution.
 */
function phaseReasoning(config: Record<string, unknown>, phase: string): string {
  const spec = PHASE_REASONING[phase];
  if (spec === undefined) return "";
  const perPhase = config.reasoning_modules;
  let value: unknown =
    typeof perPhase === "object" && perPhase !== null
      ? (perPhase as Record<string, unknown>)[phase]
      : undefined;
  if (value === undefined && phase === "execute") value = config.reasoning_module;
  return typeof value === "string" && spec.choices.includes(value) ? value : spec.fallback;
}

function hasCapability(config: Record<string, unknown>, capability: Capability): boolean {
  const value = config[capability.key];
  return typeof value === "boolean" ? value : capability.fallback;
}

export function ConfigTab() {
  const { agent } = useOutletContext<AgentDetailContext>();

  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [datasources, setDatasources] = useState<DataSource[]>([]);
  const [llmConfigs, setLlmConfigs] = useState<LLMConfig[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAgent(agent.id), listDatasources(), listLlmConfigs(), listMcpServers()])
      .then(([loadedDetail, loadedDatasources, loadedLlmConfigs, loadedMcpServers]) => {
        if (cancelled) return;
        setDetail(loadedDetail);
        setDatasources(loadedDatasources);
        setLlmConfigs(loadedLlmConfigs);
        setMcpServers(loadedMcpServers);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  /**
   * One write, with the whole "which control is busy / did it land" story
   * in one place. `field` is what the caller is changing — it drives the
   * per-control busy state, so changing the model for `plan` never greys
   * out `execute`'s dropdown too.
   */
  async function save(field: string, patch: AgentPatchInput) {
    setSavingField(field);
    setSaveError(null);
    try {
      // The response is the agent's real post-write state, so this is what
      // the screen adopts — not the value that was just sent, which would
      // show a binding the server may have normalised or rejected.
      setDetail(await updateAgent(agent.id, patch));
      setSavedField(field);
    } catch (err: unknown) {
      setSaveError(errorMessage(err));
    } finally {
      setSavingField(null);
    }
  }

  async function toggleMcpServer(server: McpServer, shouldBind: boolean) {
    const field = `mcp-${server.id}`;
    setSavingField(field);
    setSaveError(null);
    try {
      if (shouldBind) {
        await attachMcpServer(agent.id, server.id);
      } else {
        await detachMcpServer(agent.id, server.id);
      }
      // Re-read rather than splicing the id into local state: binding is a
      // join-table write, and the agent row is the only thing that knows
      // what is actually bound afterwards.
      setDetail(await getAgent(agent.id));
      setSavedField(field);
    } catch (err: unknown) {
      setSaveError(errorMessage(err));
    } finally {
      setSavingField(null);
    }
  }

  if (loadError !== null) {
    return (
      <p role="alert" className={styles.alert}>
        {loadError}
      </p>
    );
  }

  if (detail === null) {
    return <p className={styles.status}>Loading configuration…</p>;
  }

  const boundIds = new Set(detail.mcp_server_ids);
  const compiledPhases = Object.keys(detail.compiled_programs).sort(
    (a, b) => PHASES.indexOf(a as (typeof PHASES)[number]) - PHASES.indexOf(b as (typeof PHASES)[number]),
  );
  const boundCount = PHASES.filter((phase) => detail.llm_bindings[phase] !== undefined).length;

  function statusFor(field: string) {
    if (savingField === field) return <span className={styles.saving}>Saving…</span>;
    if (savedField === field && saveError === null) return <span className={styles.saved}>Saved</span>;
    return null;
  }

  return (
    <div className={styles.page}>
      <p className={styles.body}>
        What {agent.name} reads from, which model answers each phase, and which tools it can
        call. Saves as you go.
      </p>

      {saveError !== null && (
        <p role="alert" className={styles.alert}>
          {saveError}
        </p>
      )}

      <section className={styles.sheet}>
        <header className={styles.sheetHead}>
          <h3>Data &amp; execution</h3>
        </header>
        <div className={styles.controlGrid}>
          <div className={styles.control}>
            <label className={styles.label} htmlFor="config-datasource">
              Datasource
            </label>
            <select
              id="config-datasource"
              className={styles.select}
              value={detail.datasource_id === null ? "" : String(detail.datasource_id)}
              disabled={savingField === "datasource"}
              onChange={(event) => {
                const raw = event.target.value;
                void save("datasource", { datasource_id: raw === "" ? null : Number(raw) });
              }}
            >
              <option value="">Not connected</option>
              {datasources.map((datasource) => (
                <option key={datasource.id} value={datasource.id}>
                  {/* The type is a qualifier, not part of the name — a row
                      that arrives without one must read as "Reporting
                      warehouse", never "Reporting warehouse (undefined)". */}
                  {datasource.type ? `${datasource.name} (${datasource.type})` : datasource.name}
                </option>
              ))}
            </select>
            <p className={styles.help}>What this agent queries and cites.</p>
            {statusFor("datasource")}
          </div>

          <div className={styles.control}>
            <label className={styles.label} htmlFor="config-code-execution">
              Code execution
            </label>
            <select
              id="config-code-execution"
              className={styles.select}
              value={detail.code_execution}
              disabled={savingField === "code_execution"}
              onChange={(event) => {
                void save("code_execution", {
                  code_execution: event.target.value as CodeExecutionCapability,
                });
              }}
            >
              {CODE_EXECUTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className={styles.help}>
              {CODE_EXECUTION_OPTIONS.find((o) => o.value === detail.code_execution)?.help}{" "}
              <StatusPill tone={CODE_EXECUTION_TONE[detail.code_execution]} label={detail.code_execution} />
            </p>
            {statusFor("code_execution")}
          </div>
        </div>

        {/* Capabilities are on or off, not chosen from a list. Their own band
            rather than two more cells in the field grid above, where they read
            as fields that happen to look different. */}
        <div className={styles.capabilities}>
          {CAPABILITIES.map((capability) => {
            const on = hasCapability(detail.pipeline_config, capability);
            const consequence = on ? capability.effect : (capability.offEffect ?? "");
            return (
              <div key={capability.key} className={styles.switchRow}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={capability.label}
                  className={styles.switch}
                  disabled={savingField === capability.key}
                  onClick={() => {
                    // The whole object, not a merge on the server: PATCH
                    // replaces pipeline_config wholesale, so sending only
                    // the changed key would silently drop every other
                    // capability this agent has.
                    void save(capability.key, {
                      pipeline_config: { ...detail.pipeline_config, [capability.key]: !on },
                    });
                  }}
                >
                  <span className={styles.switchTrack} data-on={on} />
                  <span className={styles.switchText}>
                    <span className={styles.switchLabel}>{capability.label}</span>
                    <span className={styles.switchHelp}>{capability.help}</span>
                  </span>
                </button>
                {consequence !== "" && <p className={styles.effect}>{consequence}</p>}
                {statusFor(capability.key)}
              </div>
            );
          })}
        </div>
      </section>

      <section className={styles.sheet}>
        <header className={styles.sheetHead}>
          <h3>Phases</h3>
          <span className={styles.sub}>
            {boundCount} of {PHASES.length} models pinned
          </span>
        </header>
        {/* "in order" is no longer worth saying — the rail shows it. */}
        <p className={styles.sheetNote}>
          Reasoning is per phase, and it is where a run spends its time.
        </p>
        {/* A rail, not a table: the numbers are the run's actual order — the
            single most useful thing to know about these five rows, and what a
            four-column table of identical dropdowns said nothing about. */}
        <ol className={styles.pipeline}>
          {PHASES.map((phase) => {
            const bound = detail.llm_bindings[phase];
            const lock = phaseLock(
              phase,
              detail.pipeline_config,
              datasources.find((entry) => entry.id === detail.datasource_id),
            );
            const field = `binding-${phase}`;
            return (
              <li key={phase} className={styles.step}>
                {/* Empty on purpose — the digit is drawn by a CSS counter (see
                    the module's own comment). The <ol> carries the ordinal for
                    assistive tech, so a text node here would be redundant to a
                    reader and ambiguous to a getByText query. */}
                <span className={styles.stepMarker} data-pinned={bound !== undefined} />

                <div className={styles.stepMain}>
                  <span className={styles.name}>{phase}</span>
                  {PHASE_REASONING[phase] !== undefined && (
                    <span className={styles.phaseWhat}>{PHASE_REASONING[phase]!.what}</span>
                  )}
                </div>

                <div className={styles.stepControls}>
                  <select
                    className={styles.select}
                    aria-label={`Model for the ${phase} phase`}
                    value={bound === undefined ? "" : String(bound)}
                    disabled={savingField === field}
                    onChange={(event) => {
                      const raw = event.target.value;
                      // llm_bindings replaces wholesale, so every other
                      // phase is sent back unchanged; a merge-shaped
                      // patch here would silently unbind the rest.
                      const next = { ...detail.llm_bindings };
                      if (raw === "") delete next[phase];
                      else next[phase] = Number(raw);
                      void save(field, { llm_bindings: next });
                    }}
                  >
                    <option value="">Tenant default</option>
                    {llmConfigs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name} · {config.model}
                      </option>
                    ))}
                  </select>

                  {bound !== undefined && llmConfigs.every((config) => config.id !== bound) && (
                    <span className={styles.dangling}>{llmConfigLabel(bound, llmConfigs)}</span>
                  )}

                  {PHASE_REASONING[phase] === undefined ? (
                    // The guardrail phase runs fixed checks, not a model
                    // reasoning about anything.
                    <span className={styles.notApplicable}>no reasoning step</span>
                  ) : lock !== null ? (
                    // Not a disabled dropdown: a disabled control still
                    // reads as "your setting", and this is not the
                    // operator's setting — it is a consequence of one
                    // they made elsewhere. Showing the value with the
                    // cause beside it says which control to go and change.
                    <div className={styles.locked}>
                      <span className={styles.lockedValue}>
                        {REASONING_MODULES[lock.module]?.short ?? lock.module}
                      </span>
                      <span className={styles.lockedWhy}>Required by {lock.because}</span>
                    </div>
                  ) : (
                    <div className={styles.reasoning}>
                      <span className={styles.bindLabel}>Reasoning</span>
                      <select
                        className={styles.select}
                        aria-label={`Reasoning for the ${phase} phase`}
                        value={phaseReasoning(detail.pipeline_config, phase)}
                        disabled={savingField === `reasoning-${phase}`}
                        onChange={(event) => {
                          // pipeline_config replaces wholesale, so the
                          // other capabilities and the other phases are
                          // all sent back with it.
                          const current = detail.pipeline_config.reasoning_modules;
                          const modules =
                            typeof current === "object" && current !== null
                              ? { ...(current as Record<string, unknown>) }
                              : {};
                          modules[phase] = event.target.value;
                          void save(`reasoning-${phase}`, {
                            pipeline_config: {
                              ...detail.pipeline_config,
                              reasoning_modules: modules,
                            },
                          });
                        }}
                      >
                        {PHASE_REASONING[phase]!.choices.map((value) => (
                          <option key={value} value={value}>
                            {REASONING_MODULES[value]?.short ?? value}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <span className={styles.statusCell}>
                    {statusFor(field)}
                    {statusFor(`reasoning-${phase}`)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
        {compiledPhases.length > 0 && (
          <p className={styles.compiledNote}>
            Compiled programs from the learning loop: {compiledPhases.join(", ")}.
          </p>
        )}
      </section>

      <section className={styles.sheet}>
        <header className={styles.sheetHead}>
          <h3>Tool servers</h3>
          <span className={styles.sub}>
            {boundIds.size} of {mcpServers.length} bound
          </span>
        </header>
        {mcpServers.length === 0 ? (
          <p className={styles.empty}>
            This tenant has no MCP servers yet. Add one under Connections → MCP servers, then bind it
            here.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Tools</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mcpServers.map((server) => {
                  const isBound = boundIds.has(server.id);
                  const field = `mcp-${server.id}`;
                  return (
                    <tr key={server.id}>
                      <td className={styles.name}>{server.name}</td>
                      <td>{server.discovered_tools.length}</td>
                      <td>
                        <StatusPill
                          tone={server.is_active ? "good" : "neutral"}
                          label={server.is_active ? "Active" : "Inactive"}
                        />
                      </td>
                      <td className={styles.statusCell}>
                        {statusFor(field) ?? (
                          <button
                            type="button"
                            className={isBound ? styles.unbind : styles.bind}
                            disabled={savingField === field}
                            onClick={() => void toggleMcpServer(server, !isBound)}
                          >
                            {isBound ? "Detach" : "Attach"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
