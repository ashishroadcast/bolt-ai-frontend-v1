import { Webhook } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { useOrchestrators } from "../agents/useOrchestrators.ts";
import { GATEWAY_URL } from "../api/config.ts";
import { GatewayError } from "../api/errors.ts";
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
import styles from "./ChannelsRoute.module.css";

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
    navigator.clipboard?.writeText(url).catch(() => {});
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

      <div className={styles.body}>
        {loadError !== null && <p className={styles.loadError}>{loadError}</p>}

        {justCreatedWebhookUrl !== null && (
          <div className={styles.webhookPanel} role="status">
            <p className={styles.webhookTitle}>Paste this into Chatwoot's webhook settings now</p>
            <p className={styles.webhookNote}>
              This URL is shown once. It won't appear again on this screen — if you lose it, delete
              this channel and connect it again.
            </p>
            <div className={styles.webhookRow}>
              <code className={styles.webhookUrl} data-testid="webhook-url-box">
                {justCreatedWebhookUrl}
              </code>
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => copyWebhookUrl(justCreatedWebhookUrl)}
              >
                Copy
              </button>
            </div>
            <button
              type="button"
              className={styles.doneBtn}
              onClick={() => setJustCreatedWebhookUrl(null)}
            >
              Done
            </button>
          </div>
        )}

        {formOpen && (
          <form className={styles.form} onSubmit={(event) => void handleSubmit(event)} autoComplete="off">
            <h3 className={styles.formTitle}>Connect a channel</h3>

            <div className={styles.field}>
              <label htmlFor="channel-base-url">Chatwoot base URL</label>
              <input
                id="channel-base-url"
                type="text"
                autoComplete="off"
                value={form.baseUrl}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="channel-account-id">Account id</label>
              <input
                id="channel-account-id"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.accountId}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, accountId: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="channel-inbox-id">Inbox id</label>
              <input
                id="channel-inbox-id"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.inboxId}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, inboxId: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="channel-target">Answers via</label>
              <select
                id="channel-target"
                value={form.targetId}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, targetId: e.target.value }))}
              >
                <option value="">Choose an orchestrator…</option>
                {orchestrators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>

            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor="channel-token">Bot token</label>
              <input
                id="channel-token"
                type="password"
                // "off", never "new-password" — the same reasoning
                // DatabasesRoute.tsx gives for its DSN field: this is a
                // live credential, not a value to invite a save-password
                // prompt for.
                autoComplete="off"
                value={form.apiAccessToken}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, apiAccessToken: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="channel-handoff-team">Handoff team id (optional)</label>
              <input
                id="channel-handoff-team"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.handoffTeamId}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, handoffTeamId: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="channel-score-threshold">Handoff confidence threshold</label>
              <input
                id="channel-score-threshold"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.scoreThreshold}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, scoreThreshold: e.target.value }))}
              />
            </div>

            {submitError !== null && (
              <p role="alert" className={styles.formError}>
                {submitError}
              </p>
            )}

            <div className={styles.formActions}>
              <button type="submit" className={styles.submit} disabled={submitting}>
                {submitting ? "Connecting…" : "Connect"}
              </button>
              <button type="button" className={styles.cancel} disabled={submitting} onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
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
          <section className={styles.sheet}>
            <header className={styles.sheetHead}>
              <h3>Channels</h3>
              <span className={styles.sub}>
                {rows.length} {rows.length === 1 ? "channel" : "channels"}
              </span>
            </header>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Answers via</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((channel) => {
                    const state = rowState(channel.id);
                    const targetName = orchestratorNameById.get(channel.target_id) ?? `#${channel.target_id}`;
                    const described = describeChannel(channel);
                    return (
                      <tr key={channel.id}>
                        <td>
                          <div className={styles.chatwoot}>
                            <span className={styles.kindTag}>{described.kind}</span>
                            {described.identity}
                          </div>
                          <div className={styles.baseUrl}>
                            {described.detailLabel === "" ? described.detail : `${described.detailLabel}: ${described.detail}`}
                          </div>
                        </td>
                        <td>{targetName}</td>
                        <td>
                          {channel.is_active ? (
                            <StatusPill tone="good" label="Active" />
                          ) : (
                            <StatusPill tone="neutral" label="Inactive" />
                          )}
                        </td>
                        <td>
                          <div className={styles.rowActions}>
                            {/* Test reaches Chatwoot's API and nothing else
                                (`test_channel` builds a ChatwootClient
                                whatever the provider), so on any other
                                binding it can only fail — and would read as
                                that binding being broken. */}
                            {described.testable && (
                              <button
                                type="button"
                                className={styles.actionBtn}
                                disabled={state.testing}
                                onClick={() => void handleTest(channel.id)}
                              >
                                {state.testing ? "Testing…" : "Test"}
                              </button>
                            )}
                            <button
                              type="button"
                              className={styles.actionBtn}
                              disabled={state.toggling}
                              onClick={() => void handleToggleActive(channel)}
                            >
                              {state.toggling
                                ? "Saving…"
                                : channel.is_active
                                  ? "Deactivate"
                                  : "Activate"}
                            </button>
                            {confirmingDeleteId !== channel.id && (
                              <button
                                type="button"
                                className={`${styles.actionBtn} ${styles.danger}`}
                                onClick={() => setConfirmingDeleteId(channel.id)}
                              >
                                Delete
                              </button>
                            )}
                          </div>

                          {confirmingDeleteId === channel.id && (
                            <div className={styles.confirmRow}>
                              <span className={styles.confirmText}>Delete this channel?</span>
                              <button
                                type="button"
                                className={styles.confirmBtn}
                                disabled={state.removing}
                                onClick={() => void handleConfirmDelete(channel.id)}
                              >
                                {state.removing ? "Deleting…" : "Confirm delete"}
                              </button>
                              <button
                                type="button"
                                className={styles.actionBtn}
                                disabled={state.removing}
                                onClick={() => setConfirmingDeleteId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {state.testResult !== null && (
                            <p
                              className={`${styles.rowNote} ${state.testResult.ok ? styles.good : styles.critical}`}
                            >
                              {state.testResult.ok ? "Connected." : "Couldn't reach Chatwoot with the stored token."}
                            </p>
                          )}
                          {state.testError !== null && (
                            <p className={`${styles.rowNote} ${styles.critical}`}>{state.testError}</p>
                          )}
                          {state.toggleError !== null && (
                            <p className={`${styles.rowNote} ${styles.critical}`}>{state.toggleError}</p>
                          )}
                          {state.removeError !== null && (
                            <p className={`${styles.rowNote} ${styles.critical}`}>
                              Can't remove — {state.removeError}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
