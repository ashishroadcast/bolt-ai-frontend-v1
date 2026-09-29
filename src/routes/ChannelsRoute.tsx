import {
  CircleAlert,
  CircleCheck,
  Copy,
  PlugZap,
  Power,
  PowerOff,
  Trash2,
  Webhook,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import { GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannel,
  type ChannelBinding,
  type ChannelTestResult,
} from "./channelsApi.ts";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/** `POST /hooks/chatwoot/{token}` (`app.api.hooks`) is forwarded by the
 * gateway at its own origin, not `/agent/*` — `gateway/main.go` registers
 * `/hooks/*` as a second, separate forward to agent-service (this task's
 * own reading of that file). So the URL an operator pastes into Chatwoot
 * is built from `GATEWAY_URL`, the same origin every other call in this
 * console already talks to, not a second configured host. */
function webhookUrl(token: string): string {
  return `${GATEWAY_URL}/hooks/chatwoot/${token}`;
}

interface CreateFormState {
  baseUrl: string;
  accountId: string;
  inboxId: string;
  apiAccessToken: string;
  targetId: string;
  handoffTeamId: string;
  scoreThreshold: string;
}

const BLANK_FORM: CreateFormState = {
  baseUrl: "",
  accountId: "",
  inboxId: "",
  apiAccessToken: "",
  targetId: "",
  handoffTeamId: "",
  scoreThreshold: "0.5",
};

interface RowState {
  testing: boolean;
  testResult: ChannelTestResult | null;
  testError: string | null;
  toggling: boolean;
  toggleError: string | null;
  removing: boolean;
  removeError: string | null;
}

const BLANK_ROW_STATE: RowState = {
  testing: false,
  testResult: null,
  testError: null,
  toggling: false,
  toggleError: null,
  removing: false,
  removeError: null,
};

/** Table cells sit on the card header's own inset at either edge, so a
 * column and the title above it share one vertical line. */
const CELL_X = "px-4 first:pl-6 last:pr-6";

/** One line of per-row feedback under a row's actions — a test result, or
 * why a toggle or delete failed. Wraps (the table cells around it don't),
 * so a long server message never widens the table. */
function RowNote({ tone, children }: { tone: "good" | "critical"; children: ReactNode }) {
  const Icon = tone === "good" ? CircleCheck : CircleAlert;
  return (
    <p
      className={cn(
        "mt-2 ml-auto flex max-w-80 items-start justify-end gap-1.5 text-right text-sm whitespace-normal",
        tone === "good" ? "text-success" : "text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * `GET`/`POST /agent/channels`, `PATCH`/`DELETE /agent/channels/{id}`,
 * `POST /agent/channels/{id}/test` (`app.api.channels`) — mounted on
 * `app.main` already, but no screen ever called it before this task.
 *
 * **No `name` field to show.** `ChannelBinding` has none (see
 * `channelsApi.ts`'s own docstring) — the reference console Saurabh shared
 * lists one, but the real model identifies a binding by its Chatwoot
 * account/inbox instead, so that is what this table's first column shows.
 *
 * **The webhook URL is a "shown once" value, not a column.** `GET /agent/
 * channels` (`ChannelBindingOut`) never carries `webhook_token` — only the
 * literal `POST` response does (`ChannelBindingCreated`), on purpose (that
 * module's own docstring: "the same 'shown once' contract a cloud
 * provider's own API key creation flow uses"). A "webhook URL" column the
 * reference console shows would have to either re-mint a token this
 * backend never offers a re-mint endpoint for, or silently break the
 * shown-once contract by caching the value client-side — so this screen
 * shows the URL exactly once, right after `handleCreate` resolves, and
 * never reconstructs it for an existing row afterward.
 *
 * **The bot token (`api_access_token`) is write-only everywhere.** The
 * create form's own `apiAccessToken` field is cleared the instant the
 * `POST` resolves (`resetForm`, folded into the same state update as
 * closing the form and showing the webhook panel) — the same discipline
 * `DatabasesRoute.tsx` documents for a DSN. The server never echoes it
 * back on any response (`channelsApi.ts`'s own docstring), so there is no
 * code path in this component that ever holds it past that one submit.
 */
/**
 * How one binding should read in the table, by provider.
 *
 * Not every binding is a Chatwoot inbox any more. A `complaint` binding is
 * how a partner complaint reaches an agent, and it uses the same row for
 * different things: `account_id`/`inbox_id` are unused (written as 0), and
 * `base_url` is where the *verdict is posted back*, not a Chatwoot install.
 * Rendered through the Chatwoot template it came out as "Account 0 · Inbox
 * 0" over an api.restrologic.com URL — three facts on screen, none of them
 * true of this row.
 *
 * `testable` is false for anything but Chatwoot because `test_channel`
 * builds a `ChatwootClient` unconditionally: on a complaint binding it
 * would present the verdict callback secret as a bot token to an endpoint
 * that is not Chatwoot, and report the guaranteed failure as if the
 * binding were broken.
 */
function describeChannel(channel: ChannelBinding): {
  kind: string;
  identity: string;
  detail: string;
  detailLabel: string;
  testable: boolean;
} {
  if (channel.provider === "complaint") {
    return {
      kind: "Complaints",
      identity: "Partner complaints",
      detail: channel.base_url,
      detailLabel: "Verdicts posted to",
      testable: false,
    };
  }
  if (channel.provider === "chatwoot") {
    return {
      kind: "Chatwoot",
      identity: `Account ${channel.account_id} · Inbox ${channel.inbox_id}`,
      detail: channel.base_url,
      detailLabel: "",
      testable: true,
    };
  }
  // An unknown provider is shown by its own name rather than dressed as a
  // Chatwoot inbox — the row is still real, we just have no template for it.
  return {
    kind: channel.provider,
    identity: channel.provider,
    detail: channel.base_url,
    detailLabel: "",
    testable: false,
  };
}

export function ChannelsRoute() {
  const { orchestrators } = useOrchestrators();
  const [channels, setChannels] = useState<ChannelBinding[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The one place the fresh webhook_token/URL ever lives, and only until
  // the operator dismisses this panel — never persisted, never re-derived
  // from a saved row afterward. See this component's own docstring.
  const [justCreatedWebhookUrl, setJustCreatedWebhookUrl] = useState<string | null>(null);

  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    listChannels()
      .then((rows) => {
        if (!cancelled) setChannels(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const orchestratorNameById = new Map(orchestrators.map((o) => [o.id, o.name]));

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  function openForm() {
    setSubmitError(null);
    setJustCreatedWebhookUrl(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setForm(BLANK_FORM);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    const baseUrl = form.baseUrl.trim();
    const apiAccessToken = form.apiAccessToken.trim();
    const accountId = Number(form.accountId);
    const inboxId = Number(form.inboxId);
    const targetId = Number(form.targetId);

    if (baseUrl === "") {
      setSubmitError("The Chatwoot base URL is required.");
      return;
    }
    if (apiAccessToken === "") {
      setSubmitError("A bot token is required to reply through Chatwoot.");
      return;
    }
    if (!Number.isFinite(accountId) || !Number.isFinite(inboxId)) {
      setSubmitError("Account id and inbox id must be numbers.");
      return;
    }
    if (form.targetId === "" || !Number.isFinite(targetId)) {
      setSubmitError("Choose which orchestrator answers this channel.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createChannel({
        base_url: baseUrl,
        account_id: accountId,
        inbox_id: inboxId,
        api_access_token: apiAccessToken,
        target_id: targetId,
        handoff_team_id: form.handoffTeamId.trim() === "" ? null : Number(form.handoffTeamId),
        score_threshold:
          form.scoreThreshold.trim() === "" ? undefined : Number(form.scoreThreshold),
      });
      setChannels((prev) => [...(prev ?? []), created]);
      // Drops every field, the bot token included, in the same update that
      // closes the form and reveals the one-time webhook panel — see this
      // component's own docstring.
      setFormOpen(false);
      setForm(BLANK_FORM);
      setJustCreatedWebhookUrl(webhookUrl(created.webhook_token));
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTest(id: number) {
    patchRow(id, { testing: true, testResult: null, testError: null });
    try {
      const result = await testChannel(id);
      patchRow(id, { testing: false, testResult: result });
    } catch (err) {
      patchRow(id, { testing: false, testError: errorMessage(err) });
    }
  }

  async function handleToggleActive(channel: ChannelBinding) {
    patchRow(channel.id, { toggling: true, toggleError: null });
    try {
      const updated = await updateChannel(channel.id, { is_active: !channel.is_active });
      setChannels((prev) => (prev ?? []).map((c) => (c.id === updated.id ? updated : c)));
      patchRow(channel.id, { toggling: false });
    } catch (err) {
      patchRow(channel.id, { toggling: false, toggleError: errorMessage(err) });
    }
  }

  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

  async function handleConfirmDelete(id: number) {
    patchRow(id, { removing: true, removeError: null });
    try {
      await deleteChannel(id);
      setChannels((prev) => (prev ?? []).filter((c) => c.id !== id));
      setConfirmingDeleteId(null);
    } catch (err) {
      patchRow(id, { removing: false, removeError: errorMessage(err) });
    }
  }

  function copyWebhookUrl(url: string) {
    // jsdom (this route's own test suite) has no Clipboard implementation
    // by default — guarded rather than assumed, same reasoning
    // DatabasesRoute.tsx gives for treating a browser API as optional.
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success("Webhook URL copied"))
      .catch(() => {});
  }

  const rows = channels ?? [];

  return (
    <>
      <PageHeader
        kicker="Connections"
        title="Channels"
        description="Wire a Chatwoot inbox to an orchestrator so a customer message reaches the bot, with a confidence-based handoff to a human team."
        actionLabel={formOpen ? undefined : "Connect a channel"}
        onAction={openForm}
      />

      <div className="flex flex-col gap-6">
        {loadError !== null && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Couldn't load channels</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {justCreatedWebhookUrl !== null && (
          <Card role="status" className="gap-4 border-primary/30 bg-primary/5 shadow-none">
            <CardHeader>
              <p className="flex items-center gap-2 leading-snug font-semibold">
                <CircleCheck className="size-4 shrink-0 text-primary" />
                Paste this into Chatwoot's webhook settings now
              </p>
              <CardDescription>
                This URL is shown once. It won't appear again on this screen — if you lose it, delete
                this channel and connect it again.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              {/* The URL can run long (a 32-byte urlsafe token), so it
                  scrolls inside its own box, never the page. */}
              <code
                className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-sm whitespace-nowrap"
                data-testid="webhook-url-box"
              >
                {justCreatedWebhookUrl}
              </code>
              <Button type="button" onClick={() => copyWebhookUrl(justCreatedWebhookUrl)}>
                <Copy />
                Copy
              </Button>
            </CardContent>
            <CardFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setJustCreatedWebhookUrl(null)}
              >
                Done
              </Button>
            </CardFooter>
          </Card>
        )}

        {formOpen && (
          <Card>
            <CardHeader>
              <h3 className="leading-none font-semibold">Connect a channel</h3>
              <CardDescription>
                The webhook URL Chatwoot needs is shown once, right after you connect.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-6"
                onSubmit={(event) => void handleSubmit(event)}
                autoComplete="off"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field className="gap-2 sm:col-span-2">
                    <FieldLabel htmlFor="channel-base-url">Chatwoot base URL</FieldLabel>
                    <Input
                      id="channel-base-url"
                      type="text"
                      autoComplete="off"
                      placeholder="https://chat.example.com"
                      value={form.baseUrl}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    />
                  </Field>

                  <Field className="gap-2">
                    <FieldLabel htmlFor="channel-account-id">Account id</FieldLabel>
                    <Input
                      id="channel-account-id"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      className="font-mono tabular-nums"
                      value={form.accountId}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, accountId: e.target.value }))}
                    />
                  </Field>

                  <Field className="gap-2">
                    <FieldLabel htmlFor="channel-inbox-id">Inbox id</FieldLabel>
                    <Input
                      id="channel-inbox-id"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      className="font-mono tabular-nums"
                      value={form.inboxId}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, inboxId: e.target.value }))}
                    />
                  </Field>

                  <Field className="gap-2 sm:col-span-2">
                    <FieldLabel htmlFor="channel-token">Bot token</FieldLabel>
                    <Input
                      id="channel-token"
                      type="password"
                      // "off", never "new-password" — the same reasoning
                      // DatabasesRoute.tsx gives for its DSN field: this is a
                      // live credential, not a value to invite a save-password
                      // prompt for.
                      autoComplete="off"
                      aria-describedby="channel-token-help"
                      value={form.apiAccessToken}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, apiAccessToken: e.target.value }))
                      }
                    />
                    <FieldDescription id="channel-token-help">
                      Write-only — it is never shown again after you connect.
                    </FieldDescription>
                  </Field>

                  <Field className="gap-2 sm:col-span-2">
                    <FieldLabel htmlFor="channel-target">Answers via</FieldLabel>
                    <NativeSelect
                      id="channel-target"
                      value={form.targetId}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, targetId: e.target.value }))}
                    >
                      <NativeSelectOption value="">Choose an orchestrator…</NativeSelectOption>
                      {orchestrators.map((o) => (
                        <NativeSelectOption key={o.id} value={o.id}>
                          {o.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>

                  <Field className="gap-2">
                    <FieldLabel htmlFor="channel-handoff-team">Handoff team id (optional)</FieldLabel>
                    <Input
                      id="channel-handoff-team"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      className="font-mono tabular-nums"
                      value={form.handoffTeamId}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, handoffTeamId: e.target.value }))
                      }
                    />
                  </Field>

                  <Field className="gap-2">
                    <FieldLabel htmlFor="channel-score-threshold">
                      Handoff confidence threshold
                    </FieldLabel>
                    <Input
                      id="channel-score-threshold"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className="font-mono tabular-nums"
                      value={form.scoreThreshold}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, scoreThreshold: e.target.value }))
                      }
                    />
                  </Field>
                </div>

                {submitError !== null && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t pt-6">
                  <Button type="submit" disabled={submitting}>
                    {submitting && <Spinner aria-hidden="true" />}
                    {submitting ? "Connecting…" : "Connect"}
                  </Button>
                  <Button type="button" variant="outline" disabled={submitting} onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {loading && (
          <Card className="gap-0 overflow-hidden py-0" aria-busy="true">
            <span className="sr-only">Loading channels…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0">
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-48 max-w-full" />
                  <Skeleton className="h-3 w-32 max-w-full" />
                </div>
                <Skeleton className="hidden h-4 w-24 sm:block" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </Card>
        )}

        {!loading && loadError === null && rows.length === 0 && !formOpen && (
          <EmptyState
            icon={Webhook}
            title="Connect a channel"
            body="A channel binding wires one Chatwoot inbox to an orchestrator, so a customer message on that inbox reaches the bot — with a confidence-based handoff to a human team when it's unsure."
            actionLabel="Connect a channel"
            onAction={openForm}
          />
        )}

        {rows.length > 0 && (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="py-4">
              <h3 className="leading-none font-semibold">Channels</h3>
              <CardDescription className="tabular-nums">
                {rows.length} {rows.length === 1 ? "channel" : "channels"}
              </CardDescription>
            </CardHeader>
            <CardContent className="border-t px-0">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={cn(CELL_X, "text-muted-foreground")}>Channel</TableHead>
                    <TableHead className={cn(CELL_X, "text-muted-foreground")}>Answers via</TableHead>
                    <TableHead className={cn(CELL_X, "text-muted-foreground")}>Status</TableHead>
                    <TableHead className={cn(CELL_X, "text-right text-muted-foreground")}>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((channel) => {
                    const state = rowState(channel.id);
                    const targetName = orchestratorNameById.get(channel.target_id) ?? `#${channel.target_id}`;
                    const described = describeChannel(channel);
                    const detail =
                      described.detailLabel === ""
                        ? described.detail
                        : `${described.detailLabel}: ${described.detail}`;
                    return (
                      <TableRow key={channel.id}>
                        <TableCell className={cn(CELL_X, "py-3 align-top")}>
                          {/* The provider sits on each row: with more than
                              one kind of binding in the list, the column
                              header can no longer carry it. */}
                          <div className="flex items-center gap-2 font-medium">
                            <Badge variant="secondary">{described.kind}</Badge>
                            {described.identity}
                          </div>
                          <div
                            className="mt-1 max-w-[32ch] truncate text-xs text-muted-foreground"
                            title={detail}
                          >
                            {detail}
                          </div>
                        </TableCell>
                        <TableCell className={cn(CELL_X, "py-3 align-top")}>{targetName}</TableCell>
                        <TableCell className={cn(CELL_X, "py-3 align-top")}>
                          {channel.is_active ? (
                            <StatusPill tone="good" label="Active" />
                          ) : (
                            <StatusPill tone="neutral" label="Inactive" />
                          )}
                        </TableCell>
                        <TableCell className={cn(CELL_X, "py-2 align-top")}>
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {/* Test reaches Chatwoot's API and nothing else
                                (`test_channel` builds a ChatwootClient
                                whatever the provider), so on any other
                                binding it can only fail — and would read as
                                that binding being broken. */}
                            {described.testable && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={state.testing}
                                onClick={() => void handleTest(channel.id)}
                              >
                                {state.testing ? <Spinner aria-hidden="true" /> : <PlugZap />}
                                {state.testing ? "Testing…" : "Test"}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={state.toggling}
                              onClick={() => void handleToggleActive(channel)}
                            >
                              {state.toggling ? (
                                <Spinner aria-hidden="true" />
                              ) : channel.is_active ? (
                                <PowerOff />
                              ) : (
                                <Power />
                              )}
                              {state.toggling
                                ? "Saving…"
                                : channel.is_active
                                  ? "Deactivate"
                                  : "Activate"}
                            </Button>
                            {confirmingDeleteId !== channel.id && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setConfirmingDeleteId(channel.id)}
                              >
                                <Trash2 />
                                Delete
                              </Button>
                            )}
                          </div>

                          {confirmingDeleteId === channel.id && (
                            <div className="mt-2 ml-auto flex w-fit flex-wrap items-center justify-end gap-2 rounded-md border border-destructive/20 bg-destructive/5 py-1.5 pr-1.5 pl-3">
                              <span className="text-sm text-destructive">Delete this channel?</span>
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={state.removing}
                                onClick={() => void handleConfirmDelete(channel.id)}
                              >
                                {state.removing && <Spinner aria-hidden="true" />}
                                {state.removing ? "Deleting…" : "Confirm delete"}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={state.removing}
                                onClick={() => setConfirmingDeleteId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          )}

                          {state.testResult !== null && (
                            <RowNote tone={state.testResult.ok ? "good" : "critical"}>
                              {state.testResult.ok ? "Connected." : "Couldn't reach Chatwoot with the stored token."}
                            </RowNote>
                          )}
                          {state.testError !== null && (
                            <RowNote tone="critical">{state.testError}</RowNote>
                          )}
                          {state.toggleError !== null && (
                            <RowNote tone="critical">{state.toggleError}</RowNote>
                          )}
                          {state.removeError !== null && (
                            <RowNote tone="critical">Can't remove — {state.removeError}</RowNote>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
