import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  Check,
  Database,
  Loader2,
  Lock,
  Plus,
  Unlink,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { attachMcpServer, detachMcpServer, getAgent, updateAgent } from "../../agents/api.ts";
import type { AgentDetail, AgentPatchInput, CodeExecutionCapability } from "../../agents/types.ts";
import { StatusPill } from "../../agents/StatusPill.tsx";
import { GatewayError } from "../../ask/http/errors.ts";
import { listDatasources, type DataSource } from "../datasourcesApi.ts";
import { listLlmConfigs, type LLMConfig } from "../llmConfigsApi.ts";
import { listMcpServers, type McpServer } from "../mcpServersApi.ts";
import type { AgentDetailContext } from "../AgentDetailRoute.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

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
 * The phase picker used to be one flat list of every `llm_configs` row this
 * tenant has — 260-odd options with no structure, `provider` sitting
 * unread in a field nothing here grouped on. `<optgroup>` costs nothing
 * beyond this and needs no change on the server: `provider` was already a
 * plain string on every row (see `SettingsRoute.tsx`'s own grouping, done
 * for the same reason).
 */
function groupLlmConfigsByProvider(configs: LLMConfig[]): Array<[string, LLMConfig[]]> {
  const byProvider = new Map<string, LLMConfig[]>();
  for (const config of configs) {
    const key = config.provider || "Other";
    const list = byProvider.get(key);
    if (list === undefined) byProvider.set(key, [config]);
    else list.push(config);
  }
  return Array.from(byProvider.entries()).sort(([a], [b]) => a.localeCompare(b));
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
  {
    // Not in CAPABILITY_DEFAULTS: the server reads it in `app/agent/jev.py`'s
    // `enabled_for`, with the same rule — only a real `false` turns it off.
    key: "jev",
    label: "Jev decisions",
    fallback: true,
    help: "Typed checks in ~0.4s: topic guard, plain-lookup routing, refusal check.",
    effect: "Each check falls back to a model when Jev is unconfigured or unreachable",
    offEffect: "Off: every check runs on a model, and a single-model answer goes unchecked",
  },
];

type RunMode = "phased" | "single";

/**
 * How a run walks its phases — `PIPELINE_MODES` in `app/agent/tools.py`.
 * The help text names the cost, because that cost is why the switch exists:
 * the phased walk waits on a model call per phase.
 */
const RUN_MODES: Array<{ value: RunMode; label: string; help: string }> = [
  {
    value: "phased",
    label: "Phased",
    help: "Research, plan, execute and validate, each its own model call. Most thorough.",
  },
  {
    value: "single",
    label: "Single model",
    help: "One model answers. Jev checks scope and whether it answered. Fastest.",
  },
];

/** Anything but "single" runs phased, matching the server's `pipeline_mode`. */
function runMode(config: Record<string, unknown>): RunMode {
  return config.pipeline_mode === "single" ? "single" : "phased";
}

/**
 * What a phase does in single-model mode, for every phase but execute —
 * execute keeps its controls, since its model is the one that answers.
 * Stated on the row rather than hiding the row: the bindings are kept, and
 * switching back to phased puts them straight back into use.
 */
function singleModelRole(phase: string, jevOn: boolean): { value: string; because: string } | null {
  switch (phase) {
    case "research":
      return { value: "Retrieval only", because: "searches on the question as asked · no model call" };
    case "plan":
      return { value: "Skipped", because: "execute plans its own tool calls" };
    case "validate":
      return jevOn
        ? { value: "Jev only", because: "flags a refusal · no LLM judge" }
        : { value: "Unchecked", because: "Jev is off, and there is no LLM judge" };
    case "guardrail":
      return { value: "Execute model", because: "topic guard asks Jev first, then the execute model" };
    default:
      return null;
  }
}

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
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Couldn&apos;t load this agent&apos;s configuration</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  if (detail === null) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <span className="sr-only">Loading configuration…</span>
        <Skeleton className="h-4 w-full max-w-lg" aria-hidden="true" />
        <Skeleton className="h-64 w-full rounded-xl" aria-hidden="true" />
        <Skeleton className="h-80 w-full rounded-xl" aria-hidden="true" />
      </div>
    );
  }

  const boundIds = new Set(detail.mcp_server_ids);
  // Undefined when nothing is connected, or when the connected row is one
  // this tenant's `listDatasources` did not return — in either case the
  // second picker offers everything and lets the server be the judge, rather
  // than filtering against a type it does not actually know.
  const primaryDatasourceType = datasources.find(
    (entry) => entry.id === detail.datasource_id,
  )?.type;
  const compiledPhases = Object.keys(detail.compiled_programs).sort(
    (a, b) => PHASES.indexOf(a as (typeof PHASES)[number]) - PHASES.indexOf(b as (typeof PHASES)[number]),
  );
  const boundCount = PHASES.filter((phase) => detail.llm_bindings[phase] !== undefined).length;
  const mode = runMode(detail.pipeline_config);
  const jevOn = hasCapability(detail.pipeline_config, CAPABILITIES.find((c) => c.key === "jev")!);

  function statusFor(field: string) {
    if (savingField === field) {
      return (
        <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          Saving…
        </span>
      );
    }
    if (savedField === field && saveError === null) {
      return (
        <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-success">
          <Check aria-hidden="true" className="size-3" />
          Saved
        </span>
      );
    }
    return null;
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <p className="max-w-prose text-sm text-muted-foreground">
        What {agent.name} reads from, which model answers each phase, and which tools it can
        call. Saves as you go.
      </p>

      {saveError !== null && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <SectionHeader icon={Database} title="Data & execution" />
        <CardContent className="grid gap-x-8 gap-y-6 p-4 sm:p-6 md:grid-cols-2 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-2">
            <FieldLabel htmlFor="config-datasource" status={statusFor("datasource")}>
              Datasource
            </FieldLabel>
            <FieldSelect
              id="config-datasource"
              value={detail.datasource_id === null ? "" : String(detail.datasource_id)}
              disabled={savingField === "datasource"}
              onChange={(event) => {
                const raw = event.target.value;
                void save("datasource", { datasource_id: raw === "" ? null : Number(raw) });
              }}
            >
              <NativeSelectOption value="">Not connected</NativeSelectOption>
              {datasources.map((datasource) => (
                <NativeSelectOption key={datasource.id} value={datasource.id}>
                  {/* The type is a qualifier, not part of the name — a row
                      that arrives without one must read as "Reporting
                      warehouse", never "Reporting warehouse (undefined)". */}
                  {datasource.type ? `${datasource.name} (${datasource.type})` : datasource.name}
                </NativeSelectOption>
              ))}
            </FieldSelect>
            <p className="text-sm text-muted-foreground">What this agent queries and cites.</p>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <FieldLabel
              htmlFor="config-secondary-datasource"
              status={statusFor("secondary-datasource")}
            >
              Second datasource
            </FieldLabel>
            <FieldSelect
              id="config-secondary-datasource"
              value={
                detail.secondary_datasource_id === null
                  ? ""
                  : String(detail.secondary_datasource_id)
              }
              disabled={savingField === "secondary-datasource"}
              onChange={(event) => {
                const raw = event.target.value;
                void save("secondary-datasource", {
                  secondary_datasource_id: raw === "" ? null : Number(raw),
                });
              }}
            >
              <NativeSelectOption value="">None</NativeSelectOption>
              {/* The one already chosen above is filtered out, and so is
                  anything of its kind: each tool resolves its connector by
                  TYPE, so a second datasource of the same type is not a
                  choice between two — it is one that runs and one that
                  never does. The server refuses the pair (422); offering
                  it here would just be a form that fails on submit. */}
              {datasources
                .filter(
                  (datasource) =>
                    datasource.id !== detail.datasource_id &&
                    (primaryDatasourceType === undefined ||
                      datasource.type !== primaryDatasourceType),
                )
                .map((datasource) => (
                  <NativeSelectOption key={datasource.id} value={datasource.id}>
                    {datasource.type ? `${datasource.name} (${datasource.type})` : datasource.name}
                  </NativeSelectOption>
                ))}
            </FieldSelect>
            <p className="text-sm text-muted-foreground">
              A second store of a different kind, queried in the same run — a SQL warehouse
              for who and what, a Redis store for current state, joined on the id they share.
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <FieldLabel htmlFor="config-code-execution" status={statusFor("code_execution")}>
              Code execution
            </FieldLabel>
            <FieldSelect
              id="config-code-execution"
              value={detail.code_execution}
              disabled={savingField === "code_execution"}
              onChange={(event) => {
                void save("code_execution", {
                  code_execution: event.target.value as CodeExecutionCapability,
                });
              }}
            >
              {CODE_EXECUTION_OPTIONS.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </FieldSelect>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {CODE_EXECUTION_OPTIONS.find((o) => o.value === detail.code_execution)?.help}{" "}
              <StatusPill tone={CODE_EXECUTION_TONE[detail.code_execution]} label={detail.code_execution} />
            </p>
          </div>
        </CardContent>

        {/* Capabilities are on or off, not chosen from a list. Their own band
            rather than more cells in the field grid above, where they read
            as fields that happen to look different. */}
        <div className="border-t bg-muted/40 px-4 sm:px-6 py-5">
          <h4 className="mb-3 text-sm font-medium">Capabilities</h4>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CAPABILITIES.map((capability) => {
              const on = hasCapability(detail.pipeline_config, capability);
              const consequence = on ? capability.effect : (capability.offEffect ?? "");
              const id = `config-capability-${capability.key}`;
              return (
                <div
                  key={capability.key}
                  className={cn(
                    "flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 shadow-xs transition-colors",
                    on && "border-primary/30",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Switch
                      id={id}
                      className="mt-0.5"
                      checked={on}
                      aria-label={capability.label}
                      disabled={savingField === capability.key}
                      onCheckedChange={() => {
                        // The whole object, not a merge on the server: PATCH
                        // replaces pipeline_config wholesale, so sending only
                        // the changed key would silently drop every other
                        // capability this agent has.
                        void save(capability.key, {
                          pipeline_config: { ...detail.pipeline_config, [capability.key]: !on },
                        });
                      }}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label htmlFor={id} className="cursor-pointer">
                          {capability.label}
                        </Label>
                        {statusFor(capability.key)}
                      </div>
                      <p className="text-sm text-muted-foreground">{capability.help}</p>
                    </div>
                  </div>
                  {/* A live fact about this agent, not prose — it appears
                      only while the capability is in the state it
                      describes, so four of them cannot crowd out the
                      controls they annotate. */}
                  {consequence !== "" && (
                    <p className="ml-11 border-l-2 border-primary/30 pl-2 text-xs leading-relaxed text-muted-foreground">
                      {consequence}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <SectionHeader
          icon={Workflow}
          title="Phases"
          meta={
            <Badge variant="secondary" className="tabular-nums">
              {mode === "single" ? "single model" : `${boundCount} of ${PHASES.length} models pinned`}
            </Badge>
          }
        />
        <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
          {/* A choice between two, both always visible: which one is on, and
              what the other would cost, are the whole decision. */}
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Run mode">
            {RUN_MODES.map((option) => {
              const checked = mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={savingField === "pipeline_mode"}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                    checked
                      ? "cursor-default border-primary bg-primary/5"
                      : "cursor-pointer hover:border-foreground/20 hover:bg-accent/60",
                  )}
                  onClick={() => {
                    if (mode === option.value) return;
                    // pipeline_config replaces wholesale, so every capability
                    // and reasoning choice rides along unchanged.
                    void save("pipeline_mode", {
                      pipeline_config: { ...detail.pipeline_config, pipeline_mode: option.value },
                    });
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border shadow-xs",
                      checked ? "border-primary" : "border-input bg-background",
                    )}
                  >
                    {checked && <span className="size-2 rounded-full bg-primary" />}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="text-sm text-muted-foreground">{option.help}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {mode === "single"
              ? "Every model call in a run goes to the execute model below."
              : "Reasoning is per phase, and it is where a run spends its time."}{" "}
            {statusFor("pipeline_mode")}
          </p>
        </CardContent>

        {/* A rail, not a table: the numbers are the run's actual order — the
            single most useful thing to know about these five rows, and what a
            four-column table of identical dropdowns said nothing about.

            The digits are drawn by a CSS counter (counter-reset here,
            counter() on each marker) rather than rendered as text: the <ol>
            already carries the ordinal for assistive tech, and a bare "2" in
            the markup collides with any getByText("2") elsewhere on the
            page, which is exactly how it broke a tool-servers test the first
            time. The connector line is drawn on each step, so it cannot fall
            out of alignment with the markers. */}
        <ol className="border-t px-4 sm:px-6 py-2 [counter-reset:step]">
          {PHASES.map((phase) => {
            const bound = detail.llm_bindings[phase];
            const lock = phaseLock(
              phase,
              detail.pipeline_config,
              datasources.find((entry) => entry.id === detail.datasource_id),
            );
            const field = `binding-${phase}`;
            const singleRole = mode === "single" ? singleModelRole(phase, jevOn) : null;
            // A phase single-model mode does not call a model for: still
            // listed, so the order stays legible, but receded behind the one
            // that answers.
            const idle = singleRole !== null;
            return (
              <li
                key={phase}
                data-idle={idle}
                className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4 py-4 not-first:border-t before:absolute before:inset-y-0 before:left-3.5 before:w-px before:bg-border first:before:top-7.5 last:before:bottom-[calc(100%-1.875rem)]"
              >
                {/* A phase with a model explicitly pinned is a decision
                    someone made; the filled marker is what makes "2 of 5
                    pinned" visible in the rail itself rather than only in
                    the header badge. */}
                <span
                  aria-hidden="true"
                  data-pinned={bound !== undefined}
                  className={cn(
                    "relative z-10 grid size-7 place-items-center rounded-full border font-mono text-xs font-semibold tabular-nums before:content-[counter(step)] before:[counter-increment:step]",
                    bound !== undefined
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-primary/30 bg-accent text-primary",
                    idle && "opacity-60",
                  )}
                />

                <div
                  className={cn(
                    "flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 pt-1",
                    idle && "opacity-60",
                  )}
                >
                  <span className="text-sm font-medium capitalize">{phase}</span>
                  {PHASE_REASONING[phase] !== undefined && (
                    <span className="min-w-0 flex-[1_1_24ch] text-sm text-muted-foreground">
                      {PHASE_REASONING[phase]!.what}
                    </span>
                  )}
                </div>

                {/* Always in the content column — never under the marker,
                    which would break the rail's vertical line. */}
                <div className="col-start-2 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {singleRole !== null ? (
                    // The phase's own model and reasoning are not in play, so
                    // no control for them — only what the phase does instead.
                    <Locked value={singleRole.value} because={singleRole.because} />
                  ) : (
                    <>
                      <FieldSelect
                        wrapperClassName="w-full max-w-sm flex-[1_1_17rem]"
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
                        <NativeSelectOption value="">Tenant default</NativeSelectOption>
                        {groupLlmConfigsByProvider(llmConfigs).map(([provider, configs]) => (
                          <NativeSelectOptGroup key={provider} label={provider}>
                            {configs.map((config) => (
                              <NativeSelectOption key={config.id} value={config.id}>
                                {config.name} · {config.model}
                              </NativeSelectOption>
                            ))}
                          </NativeSelectOptGroup>
                        ))}
                      </FieldSelect>

                      {bound !== undefined && llmConfigs.every((config) => config.id !== bound) && (
                        <Badge variant="warning" className="font-mono">
                          {llmConfigLabel(bound, llmConfigs)}
                        </Badge>
                      )}

                      {PHASE_REASONING[phase] === undefined ? (
                        // The guardrail phase runs fixed checks, not a model
                        // reasoning about anything.
                        <span className="text-sm text-muted-foreground">no reasoning step</span>
                      ) : lock !== null ? (
                        // Not a disabled dropdown: a disabled control still
                        // reads as "your setting", and this is not the
                        // operator's setting — it is a consequence of one
                        // they made elsewhere. Showing the value with the
                        // cause beside it says which control to go and change.
                        <Locked
                          locked
                          value={REASONING_MODULES[lock.module]?.short ?? lock.module}
                          because={`Required by ${lock.because}`}
                        />
                      ) : (
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground">Reasoning</span>
                          <FieldSelect
                            wrapperClassName="w-44"
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
                              <NativeSelectOption key={value} value={value}>
                                {REASONING_MODULES[value]?.short ?? value}
                              </NativeSelectOption>
                            ))}
                          </FieldSelect>
                        </div>
                      )}

                      <span className="flex items-center gap-2">
                        {statusFor(field)}
                        {statusFor(`reasoning-${phase}`)}
                      </span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {compiledPhases.length > 0 && (
          <p className="border-t px-4 sm:px-6 py-4 text-sm text-muted-foreground">
            Compiled programs from the learning loop: {compiledPhases.join(", ")}.
          </p>
        )}
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <SectionHeader
          icon={Wrench}
          title="Tool servers"
          meta={
            <Badge variant="secondary" className="tabular-nums">
              {boundIds.size} of {mcpServers.length} bound
            </Badge>
          }
        />
        {mcpServers.length === 0 ? (
          <CardContent className="p-4 sm:p-6">
            <p className="text-sm text-muted-foreground">
              This tenant has no MCP servers yet. Add one under Connections → MCP servers, then bind
              it here.
            </p>
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 sm:pl-6">Server</TableHead>
                <TableHead>Tools</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 sm:pr-6">
                  <span className="sr-only">Binding</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mcpServers.map((server) => {
                const isBound = boundIds.has(server.id);
                const field = `mcp-${server.id}`;
                return (
                  <TableRow key={server.id}>
                    <TableCell className="pl-4 sm:pl-6 font-medium">{server.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground tabular-nums">
                      {server.discovered_tools.length}
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        tone={server.is_active ? "good" : "neutral"}
                        label={server.is_active ? "Active" : "Inactive"}
                      />
                    </TableCell>
                    <TableCell className="pr-4 sm:pr-6 text-right">
                      {statusFor(field) ?? (
                        <Button
                          type="button"
                          size="sm"
                          variant={isBound ? "ghost" : "outline"}
                          disabled={savingField === field}
                          onClick={() => void toggleMcpServer(server, !isBound)}
                        >
                          {isBound ? <Unlink aria-hidden="true" /> : <Plus aria-hidden="true" />}
                          {isBound ? "Detach" : "Attach"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** A section's title band: a top edge that reads at a glance when several
 * cards are stacked, with the section's count on the right. */
function SectionHeader({
  icon: Icon,
  title,
  meta,
}: {
  icon: LucideIcon;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <CardHeader className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-4 sm:px-6 [.border-b]:pb-4">
      <h3 className="flex items-center gap-2 leading-none font-semibold">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        {title}
      </h3>
      {meta !== undefined && <CardAction className="self-center">{meta}</CardAction>}
    </CardHeader>
  );
}

function FieldLabel({
  htmlFor,
  status,
  children,
}: {
  htmlFor: string;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-4 items-center justify-between gap-2">
      <Label htmlFor={htmlFor}>{children}</Label>
      {status}
    </div>
  );
}

/**
 * A `NativeSelect` that fills its column up to a cap. The shadcn wrapper is
 * `w-fit`, which would size every select to its longest option — 260-odd
 * model names make that the width of the page. Capped rather than stretched
 * all the same: a control is never much wider than its longest plausible
 * value, and five full-width dropdowns are what made every phase row look
 * identical.
 */
function FieldSelect({
  wrapperClassName,
  className,
  ...props
}: ComponentProps<typeof NativeSelect> & { wrapperClassName?: string }) {
  return (
    <div
      className={cn(
        "w-full max-w-md min-w-0 [&>[data-slot=native-select-wrapper]]:w-full",
        wrapperClassName,
      )}
    >
      <NativeSelect className={cn("bg-background", className)} {...props} />
    </div>
  );
}

/**
 * A value that is not the operator's to pick here, and why. Deliberately
 * NOT a disabled select — a disabled control still reads as "your setting",
 * and this is a consequence of a choice made elsewhere. The badge states
 * the value; the line beside it names the cause.
 */
function Locked({
  value,
  because,
  locked = false,
}: {
  value: string;
  because: string;
  locked?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant="outline" className="bg-muted/60 text-muted-foreground">
        {locked && <Lock aria-hidden="true" />}
        {value}
      </Badge>
      <span className="min-w-0 text-xs text-muted-foreground">{because}</span>
    </div>
  );
}
