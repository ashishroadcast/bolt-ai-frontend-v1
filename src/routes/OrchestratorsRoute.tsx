import { useState } from "react";
import { CircleAlert, LoaderCircle, Network, Pencil, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "../components/EmptyState.tsx";
import { createOrchestrator, deleteOrchestrator, updateOrchestrator } from "../agents/api.ts";
import { OrchestratorForm, toCreateInput, type OrchestratorFormValues } from "../agents/OrchestratorForm.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { explainOrchestratorMode } from "../agents/orchestratorMode.ts";
import type { Orchestrator } from "../agents/types.ts";
import { useAgents } from "../agents/useAgents.ts";
import { selectableChatConfigs, useLlmConfigs } from "../agents/useLlmConfigs.ts";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import { GatewayError } from "../ask/http/errors.ts";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/** Name · Members · Mode · actions. */
const COLUMN_COUNT = 4;

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
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell colSpan={COLUMN_COUNT} className="p-0 whitespace-normal">
          {/* Pinned to the visible width of the card (`cqw`, against the
              card's container) so a table that scrolls sideways on a phone
              never scrolls the form out of view with it. */}
          <div className="sticky left-0 w-[100cqw] p-4 sm:p-6">
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
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      <TableRow>
        <TableCell className="min-w-44 py-3 pl-6 align-top whitespace-normal">
          <div className="font-medium">{orchestrator.name}</div>
          {orchestrator.description !== null && orchestrator.description !== "" && (
            <div className="mt-0.5 text-sm text-muted-foreground">{orchestrator.description}</div>
          )}
        </TableCell>
        <TableCell className="min-w-40 py-3 align-top whitespace-normal text-muted-foreground">
          {memberNames.length > 0 ? memberNames.join(", ") : "No members"}
        </TableCell>
        <TableCell className="min-w-56 py-3 align-top whitespace-normal">
          <div className="flex items-start gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <explanation.icon className="size-4" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <b className="text-sm font-medium">{explanation.label}</b>
              <span className="text-sm text-muted-foreground">{explanation.detail}</span>
            </span>
          </div>
        </TableCell>
        <TableCell className="py-3 pr-6 text-right align-top">
          <div className="flex justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
              <Pencil />
              Edit
            </Button>
            {/* Delete asks a second, explicit time before anything is sent
                — the dialog is that confirmation, not an extra step. */}
            <AlertDialog
              open={confirmingDelete}
              onOpenChange={(open) => {
                if (!deleting) setConfirmingDelete(open);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {orchestrator.name}?</AlertDialogTitle>
                  <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  {/* A plain button, not AlertDialogAction: that one closes
                      the dialog on click, before the DELETE has answered. */}
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void handleConfirmDelete()}
                    disabled={deleting}
                  >
                    {deleting && <LoaderCircle className="animate-spin" />}
                    {deleting ? "Deleting…" : "Confirm delete"}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </TableCell>
      </TableRow>
      {deleteError !== null && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COLUMN_COUNT} className="px-6 pt-0 pb-3 whitespace-normal">
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <CircleAlert className="size-4 shrink-0" />
              {deleteError}
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
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

  const isEmpty = !loading && error === null && orchestrators.length === 0;

  return (
    <>
      <PageHeader
        kicker="Build"
        title="Orchestrators"
        description="Single routes a question to one best-fit agent. Coordinate runs several and synthesises one answer from what they find."
        actionLabel={creating ? undefined : "New orchestrator"}
        onAction={() => setCreating(true)}
      />
      <div className="flex flex-col gap-6">
        {creating && (
          <Card>
            <CardHeader>
              <h3 className="leading-none font-semibold">New orchestrator</h3>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        )}

        {isEmpty ? (
          <EmptyState
            icon={Network}
            title="No orchestrators yet"
            body="Create one to route questions to a best-fit agent, or run several agents and synthesise one answer."
          />
        ) : (
          <Card className="@container gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <h3 className="leading-none font-semibold">Orchestrators</h3>
              {!loading && error === null && (
                <CardAction>
                  <Badge variant="secondary" className="tabular-nums">
                    {orchestrators.length} {orchestrators.length === 1 ? "orchestrator" : "orchestrators"}
                  </Badge>
                </CardAction>
              )}
            </CardHeader>

            {loading && (
              <div className="grid gap-3 p-6" aria-busy="true">
                <span className="sr-only">Loading orchestrators…</span>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-4/5" />
              </div>
            )}
            {!loading && error !== null && (
              <div className="p-6">
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}
            {!loading && error === null && orchestrators.length > 0 && (
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6 text-muted-foreground">Name</TableHead>
                    <TableHead className="text-muted-foreground">Members</TableHead>
                    <TableHead className="text-muted-foreground">Mode</TableHead>
                    <TableHead className="pr-6 text-right text-muted-foreground">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
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
                </TableBody>
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
