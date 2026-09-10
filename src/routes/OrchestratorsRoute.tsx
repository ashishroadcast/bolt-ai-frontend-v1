import { useState } from "react";
import { createOrchestrator, deleteOrchestrator, updateOrchestrator } from "../agents/api.ts";
import { OrchestratorForm, toCreateInput, type OrchestratorFormValues } from "../agents/OrchestratorForm.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { explainOrchestratorMode } from "../agents/orchestratorMode.ts";
import type { Orchestrator } from "../agents/types.ts";
import { useAgents } from "../agents/useAgents.ts";
import { selectableChatConfigs, useLlmConfigs } from "../agents/useLlmConfigs.ts";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import { GatewayError } from "../ask/http/errors.ts";
import styles from "./OrchestratorsRoute.module.css";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

interface RowProps {
  orchestrator: Orchestrator;
  agentNameById: Map<number, string>;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (updated: Orchestrator) => void;
  onDeleted: (id: number) => void;
  agentsForForm: ReturnType<typeof useAgents>["agents"];
  llmConfigsForForm: ReturnType<typeof useLlmConfigs>["llmConfigs"] | null;
}

function OrchestratorRow({
  orchestrator,
  agentNameById,
  editing,
  onEdit,
  onCancelEdit,
  onSaved,
  onDeleted,
  agentsForForm,
  llmConfigsForForm,
}: RowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const explanation = explainOrchestratorMode(orchestrator.mode, orchestrator.member_agent_ids.length);
  const memberNames = orchestrator.member_agent_ids.map((id) => agentNameById.get(id) ?? `#${id}`);

  async function handleSave(values: OrchestratorFormValues) {
    const trimmedName = values.name.trim();
    if (trimmedName === "") {
      setSaveError("Name is required.");
      return;
    }
    if (values.memberAgentIds.length === 0) {
      setSaveError("An orchestrator needs at least one member agent.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateOrchestrator(orchestrator.id, {
        name: trimmedName,
        description: values.description.trim() === "" ? null : values.description.trim(),
        mode: values.mode,
        member_agent_ids: values.memberAgentIds,
      });
      onSaved(updated);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteOrchestrator(orchestrator.id);
      onDeleted(orchestrator.id);
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  if (editing) {
    return (
      <div className={styles.rowEditing}>
        <OrchestratorForm
          agents={agentsForForm}
          llmConfigs={llmConfigsForForm}
          editing={orchestrator}
          submitLabel="Save changes"
          submitting={saving}
          formError={saveError}
          onCancel={onCancelEdit}
          onSubmit={(values) => void handleSave(values)}
        />
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div>
        <div className={styles.name}>{orchestrator.name}</div>
        {orchestrator.description !== null && orchestrator.description !== "" && (
          <div className={styles.description}>{orchestrator.description}</div>
        )}
      </div>
      <div className={styles.description}>
        {memberNames.length > 0 ? memberNames.join(", ") : "No members"}
      </div>
      <div className={styles.modeCell}>
        <span className={styles.modeIcon} aria-hidden="true">
          <explanation.icon size={14} strokeWidth={2.25} />
        </span>
        <span className={styles.modeText}>
          <b>{explanation.label}</b>
          <span>{explanation.detail}</span>
        </span>
      </div>
      <div className={styles.rowActions}>
        <button type="button" className={styles.actionBtn} onClick={onEdit}>
          Edit
        </button>
        {!confirmingDelete && (
          <button type="button" className={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        )}
      </div>

      {confirmingDelete && (
        <div className={styles.confirmRow}>
          <span className={styles.confirmText}>
            Delete {orchestrator.name}? This can't be undone.
          </span>
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={() => void handleConfirmDelete()}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Confirm delete"}
          </button>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setConfirmingDelete(false)}
            disabled={deleting}
          >
            Cancel
          </button>
        </div>
      )}
      {deleteError !== null && (
        <div className={styles.confirmRow}>
          <span role="alert" className={styles.confirmText}>
            {deleteError}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * `GET`/`POST /agent/orchestrators`, `PATCH`/`DELETE /agent/orchestrators/
 * {id}` — every field on the wire is real (`app.api.orchestrators`), but
 * the router that serves them is not registered on the live FastAPI app
 * yet (`app.main.create_app`'s own comment: "Still unregistered ...
 * app.api.orchestrators (Task 9's own routers; registering someone else's
 * endpoint is that task's call to make, not this one's)"). That's a
 * one-line backend gap outside `agent-console/`, flagged in the task
 * report rather than worked around here — the contract itself is real and
 * fully specified, so there is nothing to invent by building against it.
 *
 * `single` vs `coordinate` is rendered as a glyph plus a sentence derived
 * from the orchestrator's own `mode` and its real `member_agent_ids.
 * length` (`explainOrchestratorMode`), never a static string chosen per
 * card — task brief: "make the difference legible in the UI rather than a
 * word in a badge."
 */
export function OrchestratorsRoute() {
  const { agents } = useAgents();
  const { llmConfigs, loading: llmConfigsLoading } = useLlmConfigs();
  // Chat-only, active-only, tenant default first — an embedding config
  // would produce a binding that fails at the orchestrator's first call.
  // `null` while loading, so the form can tell "none configured" (go fix
  // it) from "not known yet" (wait).
  const modelChoices = llmConfigsLoading ? null : selectableChatConfigs(llmConfigs);
  const { orchestrators, loading, error, setOrchestrators } = useOrchestrators();

  const [creating, setCreating] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));

  async function handleCreate(values: OrchestratorFormValues) {
    const input = toCreateInput(values);
    if (typeof input === "string") {
      setCreateError(input);
      return;
    }
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const created = await createOrchestrator(input);
      setOrchestrators([...orchestrators, created]);
      setCreating(false);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreateSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        kicker="Build"
        title="Orchestrators"
        description="Single routes a question to one best-fit agent. Coordinate runs several and synthesises one answer from what they find."
        actionLabel={creating ? undefined : "New orchestrator"}
        onAction={() => setCreating(true)}
      />
      <div className={styles.body}>
        {creating && (
          <OrchestratorForm
            agents={agents}
            llmConfigs={modelChoices}
            submitLabel="Create orchestrator"
            submitting={createSubmitting}
            formError={createError}
            onCancel={() => {
              setCreating(false);
              setCreateError(null);
            }}
            onSubmit={(values) => void handleCreate(values)}
          />
        )}

        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>Orchestrators</h3>
            {!loading && error === null && (
              <span className={styles.sub}>
                {orchestrators.length} {orchestrators.length === 1 ? "orchestrator" : "orchestrators"}
              </span>
            )}
          </header>

          {loading && <p className={styles.loading}>Loading orchestrators…</p>}
          {!loading && error !== null && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {!loading && error === null && orchestrators.length === 0 && (
            <p className={styles.empty}>
              No orchestrators yet. Create one to route questions to a best-fit agent, or run several
              agents and synthesise one answer.
            </p>
          )}
          {!loading && error === null && orchestrators.length > 0 && (
            <div className={styles.list}>
              {orchestrators.map((orchestrator) => (
                <OrchestratorRow
                  key={orchestrator.id}
                  orchestrator={orchestrator}
                  agentNameById={agentNameById}
                  agentsForForm={agents}
                  llmConfigsForForm={modelChoices}
                  editing={editingId === orchestrator.id}
                  onEdit={() => setEditingId(orchestrator.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaved={(updated) => {
                    setOrchestrators(
                      orchestrators.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
                    );
                    setEditingId(null);
                  }}
                  onDeleted={(id) => {
                    setOrchestrators(orchestrators.filter((candidate) => candidate.id !== id));
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
