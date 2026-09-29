import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { explainOrchestratorMode } from "./orchestratorMode.ts";
import type { LLMConfig } from "../routes/llmConfigsApi.ts";
import type { AgentSummary, Orchestrator, OrchestratorCreateInput, OrchestratorMode } from "./types.ts";

export interface OrchestratorFormValues {
  name: string;
  description: string;
  mode: OrchestratorMode;
  llmConfigId: string;
  memberAgentIds: number[];
}

interface OrchestratorFormProps {
  agents: AgentSummary[];
  /**
   * Chat configs this orchestrator may bind to, best first — the tenant
   * default leads, so the common case is already chosen on open.
   *
   * `null` while they are still being fetched, and the distinction is
   * load-bearing: an empty array means "this tenant has no chat model",
   * which is a real problem an operator has to go and fix, and saying so
   * while the request is still in flight sends them to the Models screen
   * for nothing.
   */
  llmConfigs: LLMConfig[] | null;
  /** Present for an edit: pre-fills the form and hides the LLM config
   * field — `OrchestratorPatch` (the real PATCH body) has no
   * `llm_config_id` field at all, so an orchestrator's model binding
   * can't be changed through this API once created. Absent for create. */
  editing?: Orchestrator;
  submitLabel: string;
  submitting: boolean;
  formError: string | null;
  onCancel: () => void;
  onSubmit: (values: OrchestratorFormValues) => void;
}

const MODES: OrchestratorMode[] = ["single", "coordinate"];

/** The small caption above a group of controls that isn't a single input
 * (the mode choice, the member list) — styled like a `Label`, but not one,
 * since there is no one control for it to name. */
const GROUP_CAPTION = "text-sm leading-none font-medium";

const HELP_TEXT = "text-sm text-muted-foreground";

/**
 * Shared by create and edit — the same fields, the same live "what this
 * means" copy, so an operator learns the single/coordinate distinction
 * once and it applies to both flows. `explainOrchestratorMode` re-runs on
 * every membership change, so the description under each mode option
 * updates with the real selected count rather than staying static.
 */
export function OrchestratorForm({
  agents,
  llmConfigs,
  editing,
  submitLabel,
  submitting,
  formError,
  onCancel,
  onSubmit,
}: OrchestratorFormProps) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [mode, setMode] = useState<OrchestratorMode>(editing?.mode ?? "single");
  // Defaults to the first offered config, which `selectableChatConfigs`
  // has already sorted the tenant default to the front of. A select with
  // no value shows its first option while reporting "" to the form, and
  // the operator is then told to choose the thing already on screen.
  const [llmConfigId, setLlmConfigId] = useState(editing?.llm_config_id.toString() ?? "");
  // The default is chosen once the list arrives, not at mount: the form
  // opens before the fetch resolves, so an initialiser would always see
  // an empty list. A select with no value shows its first option while
  // reporting "" to the form, and the operator is then told to choose the
  // thing already on screen. Only ever fills a blank — never overrides a
  // choice already made.
  const firstConfigId = llmConfigs?.[0]?.id;
  useEffect(() => {
    if (llmConfigId === "" && firstConfigId !== undefined) {
      setLlmConfigId(String(firstConfigId));
    }
  }, [firstConfigId, llmConfigId]);
  const [memberAgentIds, setMemberAgentIds] = useState<number[]>(editing?.member_agent_ids ?? []);

  function toggleMember(agentId: number) {
    setMemberAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ name, description, mode, llmConfigId, memberAgentIds });
  }

  return (
    <form className="grid gap-6" onSubmit={handleSubmit}>
      {formError !== null && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="orch-name">Name</Label>
          <Input
            id="orch-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={submitting}
          />
        </div>

        <div className="grid content-start gap-2">
          <Label htmlFor="orch-description">Description</Label>
          <Input
            id="orch-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
          />
        </div>
      </div>

      <div className="grid gap-3">
        <span className={GROUP_CAPTION}>Mode</span>
        <RadioGroup
          className="grid gap-3 sm:grid-cols-2"
          aria-label="Orchestrator mode"
          value={mode}
          onValueChange={(value) => setMode(value as OrchestratorMode)}
          disabled={submitting}
        >
          {MODES.map((candidate) => {
            const explanation = explainOrchestratorMode(candidate, memberAgentIds.length);
            return (
              <label
                key={candidate}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-disabled:cursor-not-allowed has-disabled:opacity-60 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
              >
                <RadioGroupItem value={candidate} className="mt-1" />
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <explanation.icon className="size-4" />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <b className="text-sm font-medium">{explanation.label}</b>
                  <span className="text-sm text-muted-foreground">{explanation.detail}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
      </div>

      <div className="grid gap-3">
        <span className={GROUP_CAPTION}>Member agents</span>
        <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
          {agents.length === 0 && <p className={cn(HELP_TEXT, "px-2 py-1")}>No agents exist to add yet.</p>}
          {agents.map((agent) => (
            <label
              key={agent.id}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50",
                !agent.is_active && "text-muted-foreground",
              )}
            >
              <Checkbox
                checked={memberAgentIds.includes(agent.id)}
                onCheckedChange={() => toggleMember(agent.id)}
                disabled={submitting}
              />
              {agent.name}
              {!agent.is_active && " (inactive)"}
            </label>
          ))}
        </div>
        <p className={HELP_TEXT}>At least one agent is required.</p>
      </div>

      {editing === undefined && (
        <div className="grid gap-2">
          <Label htmlFor="orch-llm-config">Model</Label>
          {/* A picker, not a number to guess.
              This field used to be a bare numeric input under help text
              reading "no endpoint lists LLM configs, so this has to be
              typed" — which was not true when it was written: the agent
              fleet already reads the same `listLlmConfigs` this form now
              does. An operator was being asked to know a database id. */}
          {llmConfigs === null ? (
            <p className={cn(HELP_TEXT, "flex items-center gap-2")}>
              <LoaderCircle className="size-4 animate-spin" />
              Loading models…
            </p>
          ) : llmConfigs.length === 0 ? (
            <p className={HELP_TEXT}>
              No chat models are set up yet. Add one on the Models screen, then come back — an
              orchestrator needs a model to route and synthesise with.
            </p>
          ) : (
            <>
              <div className="md:max-w-md *:data-[slot=native-select-wrapper]:w-full">
                <NativeSelect
                  id="orch-llm-config"
                  value={llmConfigId}
                  onChange={(event) => setLlmConfigId(event.target.value)}
                  required
                  disabled={submitting}
                >
                  {llmConfigs.map((config) => (
                    <NativeSelectOption key={config.id} value={String(config.id)}>
                      {config.name} — {config.model}
                      {config.is_default ? " (default)" : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <p className={HELP_TEXT}>
                What this orchestrator uses to pick an agent, and to write the combined answer in
                coordinate mode. Its member agents keep their own models.
              </p>
            </>
          )}
        </div>
      )}

      {editing !== undefined && (
        <div className="grid gap-2">
          <span className={GROUP_CAPTION}>LLM config id</span>
          <p className={HELP_TEXT}>
            <span className="font-mono text-foreground tabular-nums">{editing.llm_config_id}</span> — can&apos;t be
            changed after creation; the update endpoint doesn&apos;t accept this field.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <LoaderCircle className="animate-spin" />}
          {submitting ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Turns raw form strings into the real `POST` body, or a validation
 * message an operator can act on — client-side only for the checks the
 * server would reject before ever making the request worth sending. */
export function toCreateInput(values: OrchestratorFormValues): OrchestratorCreateInput | string {
  const trimmedName = values.name.trim();
  if (trimmedName === "") return "Name is required.";
  if (values.memberAgentIds.length === 0) return "An orchestrator needs at least one member agent.";
  const llmConfigId = Number(values.llmConfigId);
  if (!Number.isInteger(llmConfigId) || llmConfigId < 1) {
    // Reachable only with no chat config to pick, so it says what to do
    // rather than describing a number nobody typed.
    return "Choose a model for this orchestrator. If the list is empty, add one on the Models screen.";
  }
  return {
    name: trimmedName,
    description: values.description.trim() === "" ? null : values.description.trim(),
    mode: values.mode,
    llm_config_id: llmConfigId,
    member_agent_ids: values.memberAgentIds,
  };
}
