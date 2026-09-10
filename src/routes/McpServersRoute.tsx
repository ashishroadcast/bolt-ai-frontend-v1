import { Plug } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../agents/PageHeader.tsx";
import { StatusPill } from "../agents/StatusPill.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  createMcpServer,
  deleteMcpServer,
  discoverMcpServer,
  listMcpServerBindings,
  listMcpServers,
  setMcpCodeModeTools,
  type McpAuthType,
  type McpCodeModeToolInput,
  type McpDiscoveredTool,
  type McpServer,
} from "./mcpServersApi.ts";
import styles from "./McpServersRoute.module.css";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const AUTH_TYPE_LABEL: Record<McpAuthType, string> = {
  none: "No auth",
  bearer: "Bearer token",
  api_key: "API key",
  oauth2_cc: "OAuth2 client credentials",
};

function lastDiscoveredLabel(iso: string | null): string {
  if (iso === null) return "Never discovered";
  return `Last discovered ${new Date(iso).toLocaleString()}`;
}

function matchesToolSearch(tool: McpDiscoveredTool, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  return (
    tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)
  );
}

interface CreateFormState {
  name: string;
  baseUrl: string;
  authType: McpAuthType;
  bearerToken: string;
  apiKeyHeader: string;
  apiKeyValue: string;
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
}

const BLANK_FORM: CreateFormState = {
  name: "",
  baseUrl: "",
  authType: "none",
  bearerToken: "",
  apiKeyHeader: "",
  apiKeyValue: "",
  oauthTokenUrl: "",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScope: "",
};

/** Builds `POST /agent/mcp-servers`'s `auth_config` from whichever
 * credential fields the chosen `authType` actually shows — see
 * `mcpServersApi.ts`'s own docstring for the exact shape each type needs
 * (`app.mcp.auth.build_headers` is what reads it back out server-side). */
function buildAuthConfig(form: CreateFormState): Record<string, unknown> | null {
  switch (form.authType) {
    case "none":
      return null;
    case "bearer":
      return { token: form.bearerToken.trim() };
    case "api_key":
      return { header: form.apiKeyHeader.trim(), key: form.apiKeyValue.trim() };
    case "oauth2_cc": {
      const config: Record<string, unknown> = {
        token_url: form.oauthTokenUrl.trim(),
        client_id: form.oauthClientId.trim(),
        client_secret: form.oauthClientSecret.trim(),
      };
      if (form.oauthScope.trim() !== "") config.scope = form.oauthScope.trim();
      return config;
    }
  }
}

/** Which credential fields are required for the chosen `authType`, and the
 * message to show when one is blank — mirrors `app.mcp.auth._require_str`'s
 * own per-type field list, checked here only so an operator finds out a
 * credential is incomplete at register time rather than at the next
 * Discover or agent run. */
function missingCredentialField(form: CreateFormState): string | null {
  switch (form.authType) {
    case "none":
      return null;
    case "bearer":
      return form.bearerToken.trim() === "" ? "A bearer token is required for this auth type." : null;
    case "api_key":
      if (form.apiKeyHeader.trim() === "") return "A header name is required for this auth type.";
      if (form.apiKeyValue.trim() === "") return "A key is required for this auth type.";
      return null;
    case "oauth2_cc":
      if (form.oauthTokenUrl.trim() === "") return "A token URL is required for this auth type.";
      if (form.oauthClientId.trim() === "") return "A client id is required for this auth type.";
      if (form.oauthClientSecret.trim() === "")
        return "A client secret is required for this auth type.";
      return null;
  }
}

/** The screen's working copy of one server's allow-list while the operator
 * edits it, keyed by tool name. `storeField` is `""` for "no store
 * binding" rather than null — a `<select>`'s value is always a string, and
 * one representation across the whole draft beats converting at every read.
 * Only `allowListEntries` below, at the point of the write, turns it back
 * into the API's `string | null`. */
interface CodeModeDraftEntry {
  tenantField: string;
  storeField: string;
}

type CodeModeDraft = Record<string, CodeModeDraftEntry>;

/** The draft a freshly-opened panel starts from: whatever the server
 * already has approved. Seeded from the server row, never from a previous
 * edit — reopening the panel is how an operator abandons unsaved changes. */
function draftFromServer(server: McpServer): CodeModeDraft {
  const draft: CodeModeDraft = {};
  for (const entry of server.code_mode_tools) {
    draft[entry.name] = { tenantField: entry.tenant_field, storeField: entry.store_field ?? "" };
  }
  return draft;
}

/** The draft as the API wants it. Sorted by name so two saves of the same
 * set produce the same stored order — the column is replaced wholesale, so
 * an unstable order would show up as a spurious change in the audit row. */
function allowListEntries(draft: CodeModeDraft): McpCodeModeToolInput[] {
  return Object.entries(draft)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      tenant_field: entry.tenantField,
      store_field: entry.storeField === "" ? null : entry.storeField,
    }));
}

/** The argument names a tool declares — what a tenant/store binding has to
 * name, and what the server re-checks at write time
 * (`app.mcp.policy._resolve_binding`). Checking it here too is not a second
 * source of truth: it is what lets the control offer a picker instead of a
 * free-text box an operator can only get wrong. */
function toolArgumentNames(tool: McpDiscoveredTool): string[] {
  return Object.keys(tool.inputSchema.properties ?? {});
}

function draftsEqual(a: CodeModeDraft, b: CodeModeDraft): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) return false;
    if (left.tenantField !== right.tenantField || left.storeField !== right.storeField) return false;
  }
  return true;
}

interface RowState {
  discovering: boolean;
  discoverNote: string | null;
  discoverError: string | null;
  removing: boolean;
  removeError: string | null;
}

const BLANK_ROW_STATE: RowState = {
  discovering: false,
  discoverNote: null,
  discoverError: null,
  removing: false,
  removeError: null,
};

/**
 * The MCP servers screen — Saurabh's own question, verbatim: "where can i
 * see mcp server list? and its config and what functions are available
 * what they do." `app.api.mcp_servers` (`GET`/`POST /agent/mcp-servers`,
 * `DELETE .../{id}`, `POST .../{id}/discover`) was mounted with no screen
 * ever calling it — the last Connections surface that was planned and
 * never built.
 *
 * **The config is write-only, not read-back.** `McpServer` (`mcpServersApi.ts`)
 * has no `auth_config` field at all — the server never echoes a credential
 * on any response, including the create it was just typed into — so the
 * register form's own credential fields (`bearerToken`, `apiKeyValue`,
 * `oauthClientSecret`, …) are dropped from `form` state the instant
 * `handleSubmit` resolves, the same discipline `DatabasesRoute.tsx`
 * documents for a DSN and `ChannelsRoute.tsx` documents for a bot token.
 *
 * **The list is an overview; the tools are the detail behind an action.**
 * A tool's `description` is its interface, so it is still rendered in full
 * prose and never truncated — but rendering every tool of every server
 * inline made the list a wall of paragraphs with no way to see what
 * servers exist ("should be card or list. brief overview then button to
 * view in detail or edit or delete etc", Saurabh). Each card now answers
 * "what is this, is it working, who uses it" at a glance and holds its
 * tools behind View tools, where the per-server search box narrows a long
 * list without hiding anything.
 *
 * **The allow-list is edited in place, on the same cards.** `code_mode_
 * tools` — which of the discovered tools a code-mode sandbox may actually
 * call — used to be absent from this screen because it was absent from the
 * API: `McpServerOut` never reported it and nothing called
 * `app.mcp.policy.validate_code_mode_tools` to write it, so the panel
 * carried an explanatory line instead of a control. Both endpoints exist
 * now, and the control lives on each tool's own card rather than in a
 * separate list, because the question it answers is per-tool ("may
 * generated code call THIS one, and scoped by which argument") and a
 * second list would put the answer somewhere other than the tool it is
 * about.
 *
 * The scope fields are `<select>`s over the tool's own declared arguments,
 * never free text: the server rejects a binding naming an argument the
 * tool does not declare (`app.mcp.policy._resolve_binding`), so a text box
 * would be an invitation to type a 400. A tool the server declares is not
 * read-only offers no control at all — that is the one direction §6.5
 * trusts a server's own claim, and no operator approval overrides it.
 *
 * **Save writes the whole list, and reopening the panel discards a draft.**
 * The endpoint replaces `code_mode_tools` wholesale (a merge could not
 * express a revoke), so the draft below is always the complete intended
 * set, and Save is disabled until it differs from what is stored.
 *
 * **Bound agents come from `GET /agent/agents/{id}` per agent, not a
 * single call** — see `listMcpServerBindings`'s own docstring in
 * `mcpServersApi.ts` for why no endpoint returns this in bulk. A failure
 * fetching bindings is shown once, above the server list, and never blocks
 * the servers themselves from rendering — the two loads are independent.
 */
export function McpServersRoute() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [bindings, setBindings] = useState<Map<number, string[]>>(new Map());
  const [bindingsError, setBindingsError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<CreateFormState>(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [toolSearch, setToolSearch] = useState<Record<number, string>>({});
  /** Which server's tools are open. One at a time: two servers' full tool
   * descriptions on screen together is the wall this screen was rebuilt to
   * stop being. */
  const [openToolsId, setOpenToolsId] = useState<number | null>(null);
  /** The open panel's working copy of its allow-list, plus the save's own
   * in-flight/error state. Only ever one panel is open, so this is a single
   * draft rather than a per-server map — and closing the panel drops it,
   * which is what makes "reopen to abandon changes" true rather than a
   * convention. */
  const [codeModeDraft, setCodeModeDraft] = useState<CodeModeDraft>({});
  const [savingAllowList, setSavingAllowList] = useState(false);
  const [allowListError, setAllowListError] = useState<string | null>(null);
  const [allowListNote, setAllowListNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcpServers()
      .then((rows) => {
        if (!cancelled) setServers(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listMcpServerBindings()
      .then((map) => {
        if (!cancelled) setBindings(map);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBindingsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  function openForm() {
    setSubmitError(null);
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

    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();

    if (name === "") {
      setSubmitError("Name is required.");
      return;
    }
    if (baseUrl === "") {
      setSubmitError("A base URL is required to reach the server.");
      return;
    }
    const missing = missingCredentialField(form);
    if (missing !== null) {
      setSubmitError(missing);
      return;
    }

    setSubmitting(true);
    try {
      const created = await createMcpServer({
        name,
        base_url: baseUrl,
        auth_type: form.authType,
        auth_config: buildAuthConfig(form),
      });
      setServers((prev) => [...(prev ?? []), created]);
      // Closes the form and drops every field, every credential field
      // included, in the same state update the success is handled in —
      // see this component's own docstring.
      closeForm();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscover(server: McpServer) {
    patchRow(server.id, { discovering: true, discoverError: null });
    const previousCount = server.discovered_tools.length;
    try {
      const updated = await discoverMcpServer(server.id);
      setServers((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
      const delta = updated.discovered_tools.length - previousCount;
      const countPhrase = plural(updated.discovered_tools.length, "tool");
      const note =
        delta === 0
          ? `Refreshed just now — still ${countPhrase}.`
          : delta > 0
            ? `Refreshed just now — ${countPhrase}, ${delta} more than before.`
            : `Refreshed just now — ${countPhrase}, ${-delta} fewer than before.`;
      patchRow(server.id, { discovering: false, discoverNote: note });
    } catch (err) {
      patchRow(server.id, { discovering: false, discoverError: errorMessage(err) });
    }
  }

  async function handleConfirmRemove(id: number) {
    patchRow(id, { removing: true, removeError: null });
    try {
      await deleteMcpServer(id);
      setServers((prev) => (prev ?? []).filter((row) => row.id !== id));
      setConfirmingDeleteId(null);
    } catch (err) {
      patchRow(id, { removing: false, removeError: errorMessage(err) });
    }
  }

  /** Opening a panel seeds the draft from what is stored; closing it drops
   * the draft entirely — see this component's docstring on why that is the
   * abandon-changes gesture. */
  function toggleTools(server: McpServer) {
    const closing = openToolsId === server.id;
    setOpenToolsId(closing ? null : server.id);
    setCodeModeDraft(closing ? {} : draftFromServer(server));
    setAllowListError(null);
    setAllowListNote(null);
  }

  /** Approving a tool has to pick a scope argument immediately: a binding
   * with no tenant field is exactly what the server rejects, so the first
   * declared argument is offered as the starting point rather than an
   * empty select the operator has to notice is empty. */
  function toggleAllowed(tool: McpDiscoveredTool) {
    setAllowListNote(null);
    setCodeModeDraft((prev) => {
      if (prev[tool.name] !== undefined) {
        const { [tool.name]: _removed, ...rest } = prev;
        return rest;
      }
      const [first = ""] = toolArgumentNames(tool);
      return { ...prev, [tool.name]: { tenantField: first, storeField: "" } };
    });
  }

  function setBindingField(name: string, field: "tenantField" | "storeField", value: string) {
    setAllowListNote(null);
    setCodeModeDraft((prev) => {
      const entry = prev[name];
      if (entry === undefined) return prev;
      return { ...prev, [name]: { ...entry, [field]: value } };
    });
  }

  async function handleSaveAllowList(server: McpServer) {
    setSavingAllowList(true);
    setAllowListError(null);
    setAllowListNote(null);
    try {
      const updated = await setMcpCodeModeTools(server.id, allowListEntries(codeModeDraft));
      setServers((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
      // Reseeded from the response, not from the draft that was sent: the
      // server fills in approved_by/approved_at/schema, and a draft that
      // kept claiming to be current without them would drift from the row
      // rendered right beside it.
      setCodeModeDraft(draftFromServer(updated));
      setAllowListNote(
        updated.code_mode_tools.length === 0
          ? "Code mode is off for this server — no tool is allow-listed."
          : `Saved — ${plural(updated.code_mode_tools.length, "tool")} allow-listed.`,
      );
    } catch (err) {
      setAllowListError(errorMessage(err));
    } finally {
      setSavingAllowList(false);
    }
  }

  function searchFor(id: number): string {
    return toolSearch[id] ?? "";
  }

  const rows = servers ?? [];

  return (
    <>
      <PageHeader
        kicker="Connections"
        title="MCP servers"
        description="Register an MCP server and see, in one place, its config, its live tool count, and every tool it offers with the description an agent actually reads."
        actionLabel={formOpen ? undefined : "Register a server"}
        onAction={openForm}
      />

      <div className={styles.body}>
        {loadError !== null && <p className={styles.loadError}>{loadError}</p>}
        {bindingsError !== null && (
          <p className={styles.loadError}>Couldn't load which agents use these servers — {bindingsError}</p>
        )}

        {formOpen && (
          <form className={styles.form} onSubmit={(event) => void handleSubmit(event)} autoComplete="off">
            <h3 className={styles.formTitle}>Register a server</h3>

            <div className={styles.field}>
              <label htmlFor="mcp-name">Name</label>
              <input
                id="mcp-name"
                type="text"
                autoComplete="off"
                value={form.name}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="mcp-base-url">Base URL</label>
              <input
                id="mcp-base-url"
                type="text"
                autoComplete="off"
                value={form.baseUrl}
                disabled={submitting}
                onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="mcp-auth-type">Auth type</label>
              <select
                id="mcp-auth-type"
                value={form.authType}
                disabled={submitting}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, authType: e.target.value as McpAuthType }))
                }
              >
                <option value="none">No auth</option>
                <option value="bearer">Bearer token</option>
                <option value="api_key">API key</option>
                <option value="oauth2_cc">OAuth2 client credentials</option>
              </select>
            </div>

            {form.authType === "bearer" && (
              <div className={`${styles.field} ${styles.wide}`}>
                <label htmlFor="mcp-bearer-token">Token</label>
                <input
                  id="mcp-bearer-token"
                  type="password"
                  // "off", never "new-password" — a live credential, not a
                  // value to invite a save-password prompt for (same
                  // reasoning DatabasesRoute.tsx gives for its DSN field).
                  autoComplete="off"
                  value={form.bearerToken}
                  disabled={submitting}
                  onChange={(e) => setForm((prev) => ({ ...prev, bearerToken: e.target.value }))}
                />
              </div>
            )}

            {form.authType === "api_key" && (
              <>
                <div className={styles.field}>
                  <label htmlFor="mcp-api-key-header">Header name</label>
                  <input
                    id="mcp-api-key-header"
                    type="text"
                    autoComplete="off"
                    placeholder="X-API-Key"
                    value={form.apiKeyHeader}
                    disabled={submitting}
                    onChange={(e) => setForm((prev) => ({ ...prev, apiKeyHeader: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="mcp-api-key-value">Key</label>
                  <input
                    id="mcp-api-key-value"
                    type="password"
                    autoComplete="off"
                    value={form.apiKeyValue}
                    disabled={submitting}
                    onChange={(e) => setForm((prev) => ({ ...prev, apiKeyValue: e.target.value }))}
                  />
                </div>
              </>
            )}

            {form.authType === "oauth2_cc" && (
              <>
                <div className={styles.field}>
                  <label htmlFor="mcp-oauth-token-url">Token URL</label>
                  <input
                    id="mcp-oauth-token-url"
                    type="text"
                    autoComplete="off"
                    value={form.oauthTokenUrl}
                    disabled={submitting}
                    onChange={(e) => setForm((prev) => ({ ...prev, oauthTokenUrl: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="mcp-oauth-client-id">Client id</label>
                  <input
                    id="mcp-oauth-client-id"
                    type="text"
                    autoComplete="off"
                    value={form.oauthClientId}
                    disabled={submitting}
                    onChange={(e) => setForm((prev) => ({ ...prev, oauthClientId: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="mcp-oauth-client-secret">Client secret</label>
                  <input
                    id="mcp-oauth-client-secret"
                    type="password"
                    autoComplete="off"
                    value={form.oauthClientSecret}
                    disabled={submitting}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, oauthClientSecret: e.target.value }))
                    }
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor="mcp-oauth-scope">Scope (optional)</label>
                  <input
                    id="mcp-oauth-scope"
                    type="text"
                    autoComplete="off"
                    value={form.oauthScope}
                    disabled={submitting}
                    onChange={(e) => setForm((prev) => ({ ...prev, oauthScope: e.target.value }))}
                  />
                </div>
              </>
            )}

            {submitError !== null && (
              <p role="alert" className={styles.formError}>
                {submitError}
              </p>
            )}

            <div className={styles.formActions}>
              <button type="submit" className={styles.submit} disabled={submitting}>
                {submitting ? "Registering…" : "Register"}
              </button>
              <button type="button" className={styles.cancel} disabled={submitting} onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {servers !== null && rows.length === 0 && !formOpen && (
          <EmptyState
            icon={Plug}
            title="Register a server"
            body="An MCP server is a live tool provider — register one so an agent can call its tools, with every tool's own description right here: what it does, what it takes, and whether it only reads."
            actionLabel="Register a server"
            onAction={openForm}
          />
        )}

        {rows.map((server) => {
          const state = rowState(server.id);
          const boundAgents = bindings.get(server.id) ?? [];
          const search = searchFor(server.id);
          const filteredTools = server.discovered_tools.filter((tool) =>
            matchesToolSearch(tool, search),
          );
          const toolsOpen = openToolsId === server.id;

          return (
            <section className={styles.card} key={server.id}>
              <div className={styles.cardHead}>
                <div>
                  <h3 className={styles.serverName}>{server.name}</h3>
                  <code className={styles.baseUrl}>{server.base_url}</code>
                </div>
                <div className={styles.cardHeadRight}>
                  <span className={styles.authChip}>{AUTH_TYPE_LABEL[server.auth_type]}</span>
                  {server.is_active ? (
                    <StatusPill tone="good" label="Active" />
                  ) : (
                    <StatusPill tone="neutral" label="Inactive" />
                  )}
                </div>
              </div>

              <div className={styles.metaRow}>
                <span className={styles.metaItem}>{plural(server.discovered_tools.length, "tool")}</span>
                <span className={styles.metaItem}>{lastDiscoveredLabel(server.last_discovery_at)}</span>
                <span className={styles.metaItem}>
                  {boundAgents.length === 0
                    ? "Not bound to any agent"
                    : `Used by ${boundAgents.join(", ")}`}
                </span>
              </div>

              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  aria-expanded={toolsOpen}
                  onClick={() => toggleTools(server)}
                >
                  {toolsOpen ? "Hide tools" : "View tools"}
                </button>
                <button
                  type="button"
                  className={styles.actionBtn}
                  disabled={state.discovering}
                  onClick={() => void handleDiscover(server)}
                >
                  {state.discovering ? "Discovering…" : "Discover"}
                </button>
                {confirmingDeleteId !== server.id && (
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${styles.danger}`}
                    onClick={() => setConfirmingDeleteId(server.id)}
                  >
                    Remove
                  </button>
                )}
              </div>

              {confirmingDeleteId === server.id && (
                <div className={styles.confirmRow}>
                  <span className={styles.confirmText}>Remove {server.name}? This can't be undone.</span>
                  <button
                    type="button"
                    className={styles.confirmBtn}
                    disabled={state.removing}
                    onClick={() => void handleConfirmRemove(server.id)}
                  >
                    {state.removing ? "Removing…" : "Confirm remove"}
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

              {state.discoverNote !== null && (
                <p className={`${styles.rowNote} ${styles.good}`}>{state.discoverNote}</p>
              )}
              {state.discoverError !== null && (
                <p className={`${styles.rowNote} ${styles.critical}`}>{state.discoverError}</p>
              )}
              {state.removeError !== null && (
                <p className={`${styles.rowNote} ${styles.critical}`}>
                  Can't remove — {state.removeError}
                </p>
              )}

              {toolsOpen && (
              <div className={styles.toolsSection}>
                <div className={styles.toolsHead}>
                  <h4>Tools</h4>
                  <input
                    type="search"
                    className={styles.toolsSearch}
                    placeholder="Search tools…"
                    value={search}
                    onChange={(e) =>
                      setToolSearch((prev) => ({ ...prev, [server.id]: e.target.value }))
                    }
                  />
                </div>
                <p className={styles.toolsNote}>
                  Every tool this server discovered. Allow-list the ones generated code may call
                  in code mode, and name the argument each one is scoped by.
                </p>

                {filteredTools.length === 0 && (
                  <p className={styles.toolsEmpty}>
                    {server.discovered_tools.length === 0
                      ? "Not discovered yet — run Discover to fetch its tools."
                      : `No tools match "${search}".`}
                  </p>
                )}

                <div className={styles.toolList}>
                  {filteredTools.map((tool) => {
                    const entry = codeModeDraft[tool.name];
                    const args = toolArgumentNames(tool);
                    return (
                    // <article>, not <div>: each tool is now a small
                    // self-contained unit with its own controls, and the
                    // element is what lets a test (and a screen reader)
                    // address one tool's card rather than whichever
                    // anonymous wrapper happens to enclose its name.
                    <article className={styles.toolCard} key={tool.name}>
                      <div className={styles.toolCardHead}>
                        <code className={styles.toolName}>{tool.name}</code>
                        {tool.readOnlyHint && <span className={styles.readOnlyChip}>read-only</span>}
                      </div>
                      <p className={styles.toolDescription}>{tool.description}</p>

                      {!tool.readOnlyHint ? (
                        <p className={styles.codeModeBlocked}>
                          This server declares the tool writes, so it can't be allow-listed for
                          code mode.
                        </p>
                      ) : args.length === 0 ? (
                        <p className={styles.codeModeBlocked}>
                          The tool declares no arguments, so there is nothing to scope a
                          code-mode call by.
                        </p>
                      ) : (
                        <div className={styles.codeModeRow}>
                          <label className={styles.codeModeToggle}>
                            <input
                              type="checkbox"
                              checked={entry !== undefined}
                              onChange={() => toggleAllowed(tool)}
                            />
                            Allow in code mode
                          </label>

                          {entry !== undefined && (
                            <>
                              <label className={styles.codeModeField}>
                                Tenant argument
                                <select
                                  value={entry.tenantField}
                                  onChange={(e) =>
                                    setBindingField(tool.name, "tenantField", e.target.value)
                                  }
                                >
                                  {args.map((arg) => (
                                    <option key={arg} value={arg}>
                                      {arg}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className={styles.codeModeField}>
                                Store argument
                                <select
                                  value={entry.storeField}
                                  onChange={(e) =>
                                    setBindingField(tool.name, "storeField", e.target.value)
                                  }
                                >
                                  <option value="">None</option>
                                  {args.map((arg) => (
                                    <option key={arg} value={arg}>
                                      {arg}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                    );
                  })}
                </div>

                {server.discovered_tools.length > 0 && (
                  <div className={styles.allowListActions}>
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      disabled={savingAllowList || draftsEqual(codeModeDraft, draftFromServer(server))}
                      onClick={() => void handleSaveAllowList(server)}
                    >
                      {savingAllowList ? "Saving…" : "Save allow-list"}
                    </button>
                    <span className={styles.allowListCount}>
                      {plural(Object.keys(codeModeDraft).length, "tool")} allow-listed of{" "}
                      {plural(server.discovered_tools.length, "discovered")}
                    </span>
                  </div>
                )}

                {allowListNote !== null && (
                  <p className={`${styles.rowNote} ${styles.good}`}>{allowListNote}</p>
                )}
                {allowListError !== null && (
                  <p className={`${styles.rowNote} ${styles.critical}`}>
                    Can't save the allow-list — {allowListError}
                  </p>
                )}
              </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
