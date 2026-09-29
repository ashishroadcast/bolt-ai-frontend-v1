import {
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  KeyRound,
  Lock,
  Plug,
  RefreshCw,
  Search,
  Server,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
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

/** One line of feedback on a server card — a refresh, a save, or why one
 * of them failed. */
function Note({ tone, children }: { tone: "good" | "critical"; children: ReactNode }) {
  const Icon = tone === "good" ? CircleCheck : CircleAlert;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-sm",
        tone === "good" ? "text-success" : "text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

interface ToolCardProps {
  serverId: number;
  tool: McpDiscoveredTool;
  /** This tool's entry in the open panel's draft, or `undefined` when it is
   * not allow-listed. */
  entry: CodeModeDraftEntry | undefined;
  onToggleAllowed: () => void;
  onBindingChange: (field: "tenantField" | "storeField", value: string) => void;
}

/** One discovered tool: its name, its description in full (a tool's
 * description is its interface, so it is never truncated), and — where the
 * server allows it — the code-mode allow-list control for it.
 *
 * The control lives here, on the tool's own card, rather than in a separate
 * list, because the question it answers is per-tool ("may generated code
 * call THIS one, and scoped by which argument"). A tool the server declares
 * writes gets a sentence instead of a disabled checkbox: there is no state
 * an operator could move it to (§6.5: a server's "this writes" is trusted in
 * the direction that denies). */
function ToolCard({ serverId, tool, entry, onToggleAllowed, onBindingChange }: ToolCardProps) {
  const args = toolArgumentNames(tool);
  const idBase = `mcp-${serverId}-tool-${tool.name}`;
  return (
    // <article>, not <div>: each tool is a small self-contained unit with
    // its own controls, and the element is what lets a test (and a screen
    // reader) address one tool's card rather than whichever anonymous
    // wrapper happens to enclose its name.
    <article className="rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-semibold break-all">{tool.name}</code>
        {tool.readOnlyHint && <Badge variant="success">read-only</Badge>}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{tool.description}</p>

      {!tool.readOnlyHint ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-px size-3.5 shrink-0" />
          This server declares the tool writes, so it can't be allow-listed for code mode.
        </p>
      ) : args.length === 0 ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-px size-3.5 shrink-0" />
          The tool declares no arguments, so there is nothing to scope a code-mode call by.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3 border-t pt-3">
          <div className="flex h-8 items-center gap-2">
            <Checkbox
              id={`${idBase}-allow`}
              checked={entry !== undefined}
              onCheckedChange={onToggleAllowed}
            />
            <Label htmlFor={`${idBase}-allow`}>Allow in code mode</Label>
          </div>

          {entry !== undefined && (
            <>
              <div className="grid gap-1.5">
                <Label
                  htmlFor={`${idBase}-tenant`}
                  className="text-xs font-normal text-muted-foreground"
                >
                  Tenant argument
                </Label>
                <NativeSelect
                  id={`${idBase}-tenant`}
                  size="sm"
                  className="min-w-36 bg-background font-mono text-xs"
                  value={entry.tenantField}
                  onChange={(e) => onBindingChange("tenantField", e.target.value)}
                >
                  {args.map((arg) => (
                    <NativeSelectOption key={arg} value={arg}>
                      {arg}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label
                  htmlFor={`${idBase}-store`}
                  className="text-xs font-normal text-muted-foreground"
                >
                  Store argument
                </Label>
                <NativeSelect
                  id={`${idBase}-store`}
                  size="sm"
                  className="min-w-36 bg-background font-mono text-xs"
                  value={entry.storeField}
                  onChange={(e) => onBindingChange("storeField", e.target.value)}
                >
                  <NativeSelectOption value="">None</NativeSelectOption>
                  {args.map((arg) => (
                    <NativeSelectOption key={arg} value={arg}>
                      {arg}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

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
 * tools behind View tools — the card's one lead action, so it is the
 * filled button — where the per-server search box narrows a long list
 * without hiding anything.
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

      <div className="flex flex-col gap-6">
        {loadError !== null && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Couldn't load MCP servers</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {bindingsError !== null && (
          <Alert className="border-warning/30 bg-warning-soft text-warning">
            <TriangleAlert />
            <AlertTitle>Couldn't load which agents use these servers</AlertTitle>
            <AlertDescription>{bindingsError}</AlertDescription>
          </Alert>
        )}

        {formOpen && (
          <Card>
            <CardHeader>
              <h3 className="leading-none font-semibold">Register a server</h3>
              <CardDescription>
                Credentials are write-only: the server never sends them back, on this screen or
                any other.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-6"
                onSubmit={(event) => void handleSubmit(event)}
                autoComplete="off"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field className="gap-2">
                    <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
                    <Input
                      id="mcp-name"
                      type="text"
                      autoComplete="off"
                      value={form.name}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    />
                  </Field>

                  <Field className="gap-2">
                    <FieldLabel htmlFor="mcp-base-url">Base URL</FieldLabel>
                    <Input
                      id="mcp-base-url"
                      type="text"
                      autoComplete="off"
                      placeholder="https://tools.example.com/mcp"
                      value={form.baseUrl}
                      disabled={submitting}
                      onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    />
                  </Field>
                </div>

                <div className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
                  <Field className="gap-2 sm:col-span-2 sm:max-w-sm">
                    <FieldLabel htmlFor="mcp-auth-type">Auth type</FieldLabel>
                    <NativeSelect
                      id="mcp-auth-type"
                      className="bg-background"
                      value={form.authType}
                      disabled={submitting}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, authType: e.target.value as McpAuthType }))
                      }
                    >
                      <NativeSelectOption value="none">No auth</NativeSelectOption>
                      <NativeSelectOption value="bearer">Bearer token</NativeSelectOption>
                      <NativeSelectOption value="api_key">API key</NativeSelectOption>
                      <NativeSelectOption value="oauth2_cc">OAuth2 client credentials</NativeSelectOption>
                    </NativeSelect>
                    {form.authType === "none" && (
                      <FieldDescription>Requests go to the server without credentials.</FieldDescription>
                    )}
                  </Field>

                  {form.authType === "bearer" && (
                    <Field className="gap-2 sm:col-span-2">
                      <FieldLabel htmlFor="mcp-bearer-token">Token</FieldLabel>
                      <Input
                        id="mcp-bearer-token"
                        type="password"
                        // "off", never "new-password" — a live credential, not a
                        // value to invite a save-password prompt for (same
                        // reasoning DatabasesRoute.tsx gives for its DSN field).
                        autoComplete="off"
                        className="bg-background"
                        value={form.bearerToken}
                        disabled={submitting}
                        onChange={(e) => setForm((prev) => ({ ...prev, bearerToken: e.target.value }))}
                      />
                    </Field>
                  )}

                  {form.authType === "api_key" && (
                    <>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-api-key-header">Header name</FieldLabel>
                        <Input
                          id="mcp-api-key-header"
                          type="text"
                          autoComplete="off"
                          placeholder="X-API-Key"
                          className="bg-background font-mono"
                          value={form.apiKeyHeader}
                          disabled={submitting}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, apiKeyHeader: e.target.value }))
                          }
                        />
                      </Field>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-api-key-value">Key</FieldLabel>
                        <Input
                          id="mcp-api-key-value"
                          type="password"
                          autoComplete="off"
                          className="bg-background"
                          value={form.apiKeyValue}
                          disabled={submitting}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, apiKeyValue: e.target.value }))
                          }
                        />
                      </Field>
                    </>
                  )}

                  {form.authType === "oauth2_cc" && (
                    <>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-oauth-token-url">Token URL</FieldLabel>
                        <Input
                          id="mcp-oauth-token-url"
                          type="text"
                          autoComplete="off"
                          className="bg-background"
                          value={form.oauthTokenUrl}
                          disabled={submitting}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, oauthTokenUrl: e.target.value }))
                          }
                        />
                      </Field>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-oauth-client-id">Client id</FieldLabel>
                        <Input
                          id="mcp-oauth-client-id"
                          type="text"
                          autoComplete="off"
                          className="bg-background font-mono"
                          value={form.oauthClientId}
                          disabled={submitting}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, oauthClientId: e.target.value }))
                          }
                        />
                      </Field>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-oauth-client-secret">Client secret</FieldLabel>
                        <Input
                          id="mcp-oauth-client-secret"
                          type="password"
                          autoComplete="off"
                          className="bg-background"
                          value={form.oauthClientSecret}
                          disabled={submitting}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, oauthClientSecret: e.target.value }))
                          }
                        />
                      </Field>
                      <Field className="gap-2">
                        <FieldLabel htmlFor="mcp-oauth-scope">Scope (optional)</FieldLabel>
                        <Input
                          id="mcp-oauth-scope"
                          type="text"
                          autoComplete="off"
                          className="bg-background"
                          value={form.oauthScope}
                          disabled={submitting}
                          onChange={(e) => setForm((prev) => ({ ...prev, oauthScope: e.target.value }))}
                        />
                      </Field>
                    </>
                  )}
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
                    {submitting ? "Registering…" : "Register"}
                  </Button>
                  <Button type="button" variant="outline" disabled={submitting} onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {servers === null && loadError === null && (
          <div className="flex flex-col gap-4" aria-busy="true">
            <span className="sr-only">Loading MCP servers…</span>
            {[0, 1].map((i) => (
              <Card key={i} className="gap-4">
                <CardHeader>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <Skeleton className="h-3 w-72 max-w-full" />
                  <div className="flex gap-2">
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-8 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
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

        {rows.length > 0 && (
          <div className="flex flex-col gap-4">
            {rows.map((server) => {
              const state = rowState(server.id);
              const boundAgents = bindings.get(server.id) ?? [];
              const search = searchFor(server.id);
              const filteredTools = server.discovered_tools.filter((tool) =>
                matchesToolSearch(tool, search),
              );
              const toolsOpen = openToolsId === server.id;
              const headingId = `mcp-server-${server.id}-name`;

              return (
                <section key={server.id} aria-labelledby={headingId}>
                  <Card className="gap-4">
                    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1.5">
                        <h3 id={headingId} className="flex items-center gap-2 leading-none font-semibold">
                          <Server className="size-4 shrink-0 text-muted-foreground" />
                          {server.name}
                        </h3>
                        <code className="block font-mono text-xs break-all text-muted-foreground">
                          {server.base_url}
                        </code>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          <KeyRound />
                          {AUTH_TYPE_LABEL[server.auth_type]}
                        </Badge>
                        {server.is_active ? (
                          <StatusPill tone="good" label="Active" />
                        ) : (
                          <StatusPill tone="neutral" label="Inactive" />
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1.5 tabular-nums">
                          <Wrench className="size-3.5 shrink-0" />
                          {plural(server.discovered_tools.length, "tool")}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock className="size-3.5 shrink-0" />
                          {lastDiscoveredLabel(server.last_discovery_at)}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Bot className="size-3.5 shrink-0" />
                          {boundAgents.length === 0
                            ? "Not bound to any agent"
                            : `Used by ${boundAgents.join(", ")}`}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          aria-expanded={toolsOpen}
                          onClick={() => toggleTools(server)}
                        >
                          {toolsOpen ? <ChevronUp /> : <ChevronDown />}
                          {toolsOpen ? "Hide tools" : "View tools"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={state.discovering}
                          onClick={() => void handleDiscover(server)}
                        >
                          {state.discovering ? <Spinner aria-hidden="true" /> : <RefreshCw />}
                          {state.discovering ? "Discovering…" : "Discover"}
                        </Button>
                        {confirmingDeleteId !== server.id && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setConfirmingDeleteId(server.id)}
                          >
                            <Trash2 />
                            Remove
                          </Button>
                        )}
                      </div>

                      {confirmingDeleteId === server.id && (
                        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 py-1.5 pr-1.5 pl-3">
                          <span className="mr-auto text-sm text-destructive">
                            Remove {server.name}? This can't be undone.
                          </span>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={state.removing}
                            onClick={() => void handleConfirmRemove(server.id)}
                          >
                            {state.removing && <Spinner aria-hidden="true" />}
                            {state.removing ? "Removing…" : "Confirm remove"}
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

                      {state.discoverNote !== null && <Note tone="good">{state.discoverNote}</Note>}
                      {state.discoverError !== null && (
                        <Note tone="critical">{state.discoverError}</Note>
                      )}
                      {state.removeError !== null && (
                        <Note tone="critical">Can't remove — {state.removeError}</Note>
                      )}

                      {toolsOpen && (
                        <div className="flex flex-col gap-4 border-t pt-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="space-y-1">
                              <h4 className="text-sm font-semibold">Tools</h4>
                              <p className="max-w-prose text-sm text-muted-foreground">
                                Every tool this server discovered. Allow-list the ones generated
                                code may call in code mode, and name the argument each one is
                                scoped by.
                              </p>
                            </div>
                            <InputGroup className="sm:w-64 sm:shrink-0">
                              <InputGroupAddon>
                                <Search />
                              </InputGroupAddon>
                              <InputGroupInput
                                type="search"
                                placeholder="Search tools…"
                                aria-label="Search tools"
                                value={search}
                                onChange={(e) =>
                                  setToolSearch((prev) => ({ ...prev, [server.id]: e.target.value }))
                                }
                              />
                            </InputGroup>
                          </div>

                          {filteredTools.length === 0 && (
                            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                              {server.discovered_tools.length === 0
                                ? "Not discovered yet — run Discover to fetch its tools."
                                : `No tools match "${search}".`}
                            </p>
                          )}

                          {filteredTools.length > 0 && (
                            <div className="flex flex-col gap-3">
                              {filteredTools.map((tool) => (
                                <ToolCard
                                  key={tool.name}
                                  serverId={server.id}
                                  tool={tool}
                                  entry={codeModeDraft[tool.name]}
                                  onToggleAllowed={() => toggleAllowed(tool)}
                                  onBindingChange={(field, value) =>
                                    setBindingField(tool.name, field, value)
                                  }
                                />
                              ))}
                            </div>
                          )}

                          {server.discovered_tools.length > 0 && (
                            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                              <Button
                                type="button"
                                size="sm"
                                disabled={
                                  savingAllowList ||
                                  draftsEqual(codeModeDraft, draftFromServer(server))
                                }
                                onClick={() => void handleSaveAllowList(server)}
                              >
                                {savingAllowList && <Spinner aria-hidden="true" />}
                                {savingAllowList ? "Saving…" : "Save allow-list"}
                              </Button>
                              <span className="text-sm text-muted-foreground tabular-nums">
                                {plural(Object.keys(codeModeDraft).length, "tool")} allow-listed of{" "}
                                {server.discovered_tools.length} discovered
                              </span>
                            </div>
                          )}

                          {allowListNote !== null && <Note tone="good">{allowListNote}</Note>}
                          {allowListError !== null && (
                            <Note tone="critical">Can't save the allow-list — {allowListError}</Note>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
