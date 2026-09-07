import { useEffect, useState, type FormEvent } from "react";
import { explainOrchestratorMode } from "./orchestratorMode.ts";
import type { LLMConfig } from "../routes/llmConfigsApi.ts";
import type { AgentSummary, Orchestrator, OrchestratorCreateInput, OrchestratorMode } from "./types.ts";
import styles from "./OrchestratorForm.module.css";

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
    <form className={styles.form} onSubmit={handleSubmit}>
      {formError !== null && (
        <p role="alert" className={styles.formError}>
          {formError}
        </p>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="orch-name">
          Name
        </label>
        <input
          id="orch-name"
          className={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={submitting}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="orch-description">
          Description
        </label>
        <input
          id="orch-description"
          className={styles.input}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={submitting}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Mode</span>
        <div className={styles.modeGroup} role="radiogroup" aria-label="Orchestrator mode">
          {MODES.map((candidate) => {
            const explanation = explainOrchestratorMode(candidate, memberAgentIds.length);
            const isOn = mode === candidate;
            return (
              <label
                key={candidate}
                className={`${styles.modeOption} ${isOn ? styles.modeOptionOn : ""}`}
              >
                <input
                  type="radio"
                  name="orch-mode"
                  value={candidate}
                  checked={isOn}
                  onChange={() => setMode(candidate)}
                  disabled={submitting}
                />
                <span className={styles.modeGlyph} aria-hidden="true">
                  <explanation.icon size={14} strokeWidth={2.25} />
                </span>
                <span className={styles.modeText}>
                  <b>{explanation.label}</b>
                  <span>{explanation.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Member agents</span>
        <div className={styles.memberList}>
          {agents.length === 0 && <p className={styles.helpText}>No agents exist to add yet.</p>}
          {agents.map((agent) => (
            <label
              key={agent.id}
              className={`${styles.memberOption} ${agent.is_active ? "" : styles.inactive}`}
            >
              <input
                type="checkbox"
                checked={memberAgentIds.includes(agent.id)}
                onChange={() => toggleMember(agent.id)}
                disabled={submitting}
              />
              {agent.name}
              {!agent.is_active && " (inactive)"}
            </label>
          ))}
        </div>
        <p className={styles.helpText}>At least one agent is required.</p>
      </div>

      {editing === undefined && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="orch-llm-config">
            Model
          </label>
          {/* A picker, not a number to guess.
              This field used to be a bare numeric input under help text
              reading "no endpoint lists LLM configs, so this has to be
              typed" — which was not true when it was written: the agent
              fleet already reads the same `listLlmConfigs` this form now
              does. An operator was being asked to know a database id. */}
          {llmConfigs === null ? (
            <p className={styles.helpText}>Loading models…</p>
          ) : llmConfigs.length === 0 ? (
            <p className={styles.helpText}>
              No chat models are set up yet. Add one on the Models screen, then come back — an
              orchestrator needs a model to route and synthesise with.
            </p>
          ) : (
            <>
              <select
                id="orch-llm-config"
                className={styles.select}
                value={llmConfigId}
                onChange={(event) => setLlmConfigId(event.target.value)}
                required
                disabled={submitting}
              >
                {llmConfigs.map((config) => (
                  <option key={config.id} value={String(config.id)}>
                    {config.name} — {config.model}
                    {config.is_default ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <p className={styles.helpText}>
                What this orchestrator uses to pick an agent, and to write the combined answer in
                coordinate mode. Its member agents keep their own models.
              </p>
            </>
          )}
        </div>
      )}

      {editing !== undefined && (
        <div className={styles.field}>
          <span className={styles.label}>LLM config id</span>
          <p className={styles.helpText}>
            {editing.llm_config_id} — can't be changed after creation; the update endpoint doesn't
            accept this field.
          </p>
        </div>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
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
