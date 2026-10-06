import {
  AlertCircle,
  ChevronRight,
  KeyRound,
  Lock,
  Plus,
  Power,
  PowerOff,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
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
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import {
  createLlmConfig,
  deleteLlmConfig,
  listLlmConfigs,
  listModelCatalogue,
  previewModels,
  updateLlmConfig,
  type CatalogueModel,
  type LLMConfig,
  type LLMConfigKind,
} from "./llmConfigsApi.ts";
import {
  fetchSettings,
  updateAskDisclosure,
  type AskDisclosure,
  type CodeExecutionCapability,
  type SettingsSnapshot,
} from "./settingsApi.ts";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

/** NativeSelect's wrapper is `w-fit`; in a form column the select should
 * span the column like the inputs beside it. */
const FULL_WIDTH_SELECT = "[&>[data-slot=native-select-wrapper]]:w-full";

/** One Ask display option: the whole row is the checkbox's label, so the
 * title and its explanation are both the click target and its accessible
 * name. Tinted when on, dimmed when a parent organisation has locked it. */
const TOGGLE_CLASS =
  "cursor-pointer items-start gap-3 rounded-lg border p-4 leading-normal font-normal select-auto has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70 has-[[data-state=checked]]:border-primary/40 has-[[data-state=checked]]:bg-primary/5";

const FACT_CLASS = "rounded-lg border bg-muted/30 p-4";
const FACT_VALUE_CLASS = "mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tabular-nums";

/**
 * OpenRouter quotes USD *per token*, which lands on screen as 0.00000027
 * — a number nobody can compare at a glance. Every provider publishes per
 * million instead, so that is what the picker shows.
 */
function pricePerMillion(perToken: string | undefined): string | null {
  if (perToken === undefined) return null;
  const value = Number(perToken);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return "Free";
  return `$${(value * 1_000_000).toFixed(2)}`;
}

/** 200000 -> "200K", 1000000 -> "1M". A context window is compared by
 *  order of magnitude, not read digit by digit. */
function formatContext(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

const CATALOGUE_SUGGESTION_LIMIT = 8;

/** How long to let the operator finish typing a base URL or key before
 * asking a live provider for its models — the same debounce a search box
 * would use, chosen so a single paste doesn't fire one request per
 * character. */
const LIVE_FETCH_DEBOUNCE_MS = 400;

/** Sentinel for "Custom Endpoint" — not a real `provider` value, just what
 * the picker shows while the actual string is typed into the field beside
 * it. Never sent to the server; `form.provider` always is. */
const CUSTOM_PROVIDER = "__custom__";

interface ProviderOption {
  value: string;
  label: string;
  /** Whether this provider exposes an OpenAI-compatible `GET {base_url}/
   * models` this form can call for live suggestions
   * (`app.api.llm_configs.preview_models`'s own generic branch). Anthropic,
   * Azure, Google and xAI each have their own distinct, non-OpenAI-shaped
   * API for this — out of scope here; picking one of those still means
   * typing the model id by hand, exactly like every provider did before
   * this picker existed. */
  liveFetch: boolean;
}

/**
 * The known providers this console offers a name for — not an exhaustive
 * list of every string `LLMConfig.provider` could ever hold (an operator
 * can still type anything via "Custom Endpoint"), just the ones worth a
 * proper label instead of a blank text box. OpenRouter's own catalogue
 * stays keyless and public (`listModelCatalogue`); OmniRoute is the
 * provider this task's own investigation confirmed answers `GET {base_url}
 * /models` with its FULL live model list (1734 entries against 11
 * previously hand-registered rows, verified live 2026-09-26) rather than
 * only whichever rows happened to be pre-saved.
 */
const KNOWN_PROVIDERS: ProviderOption[] = [
  { value: "anthropic", label: "Anthropic", liveFetch: false },
  { value: "azure", label: "Azure", liveFetch: false },
  { value: "google", label: "Google", liveFetch: false },
  { value: "omniroute", label: "OmniRoute", liveFetch: true },
  { value: "openai", label: "OpenAI", liveFetch: true },
  { value: "openrouter", label: "OpenRouter", liveFetch: true },
  { value: "xai", label: "xAI", liveFetch: false },
];

/** Which picker option a stored `provider` string corresponds to — any
 * value not in `KNOWN_PROVIDERS` reads as "Custom Endpoint", so an existing
 * row with an unusual provider string is never silently relabelled as one
 * of the known ones. */
function providerChoiceFor(provider: string): string {
  return KNOWN_PROVIDERS.some((option) => option.value === provider) ? provider : CUSTOM_PROVIDER;
}

/** Whether `providerChoice` should live-fetch — "Custom Endpoint" always
 * does (that is the whole point of typing a `base_url` by hand), a known
 * provider defers to its own `liveFetch` flag. */
function liveFetchFor(providerChoice: string): boolean {
  if (providerChoice === CUSTOM_PROVIDER) return true;
  return KNOWN_PROVIDERS.find((option) => option.value === providerChoice)?.liveFetch ?? false;
}

/**
 * Above this many rows, a provider whose shelf is entirely `is_active:
 * false` (OpenRouter's ~266-row catalogue while its account is out of
 * credits — see `scripts/seed_model_configs.py`) starts collapsed rather
 * than dumping every dead row on screen before the one or two providers an
 * operator can actually bind an agent to. A small shelf, or one with
 * anything usable in it, always opens — there is nothing to protect
 * against there.
 */
const LARGE_GROUP_ROW_THRESHOLD = 15;

interface ProviderGroup {
  provider: string;
  configs: LLMConfig[];
  activeCount: number;
}

/**
 * "First setup providers, then models" (task brief) — the 260-odd rows this
 * screen renders are all one flat table today, `provider` a string column
 * with nothing grouping same-provider rows together on screen. This is the
 * grouping, done in the browser: no backend change, because `provider` here
 * is genuinely just a string on each row and there is no separate Provider
 * entity to fetch instead (see `app.agent.models.LLMConfig` — one row IS one
 * model, keyed or borrowing the tenant default's key, nothing above it).
 */
function groupByProvider(rows: LLMConfig[]): ProviderGroup[] {
  const byProvider = new Map<string, LLMConfig[]>();
  for (const config of rows) {
    const list = byProvider.get(config.provider);
    if (list === undefined) byProvider.set(config.provider, [config]);
    else list.push(config);
  }
  const groups: ProviderGroup[] = Array.from(byProvider.entries()).map(([provider, configs]) => ({
    provider,
    // Active first, then name — the rows worth reading are the ones this
    // list should reach without scrolling past the dead ones first.
    configs: [...configs].sort((a, b) =>
      a.is_active === b.is_active ? a.name.localeCompare(b.name) : a.is_active ? -1 : 1,
    ),
    activeCount: configs.filter((config) => config.is_active).length,
  }));
  // A provider with something usable floats to the top, ahead of one that
  // is alphabetically first but entirely dead right now.
  groups.sort((a, b) => b.activeCount - a.activeCount || a.provider.localeCompare(b.provider));
  return groups;
}

function defaultOpenFor(group: ProviderGroup): boolean {
  return !(group.configs.length > LARGE_GROUP_ROW_THRESHOLD && group.activeCount === 0);
}

const CODE_EXECUTION_TONE: Record<CodeExecutionCapability, StatusPillTone> = {
  none: "neutral",
  interpreter: "amber",
  code: "critical",
};

const CODE_EXECUTION_LABEL: Record<CodeExecutionCapability, string> = {
  none: "None",
  interpreter: "Interpreter",
  code: "Code",
};

interface CreateFormState {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  kind: LLMConfigKind;
  isDefault: boolean;
}

const BLANK_FORM: CreateFormState = {
  name: "",
  provider: "openrouter",
  model: "",
  baseUrl: "",
  apiKey: "",
  kind: "chat",
  isDefault: false,
};

/**
 * The "Add a model" form. `apiKey` never survives past the moment
 * `handleSubmit` reads it into the outgoing payload — it is captured into
 * a local `const` and the field is cleared (`setApiKey("")`) in the same
 * synchronous tick, before the request is even sent, so neither a slow
 * network nor a failed submit can leave the key sitting in this
 * component's state waiting to be re-rendered (task brief: "not left in
 * component state after submit"). See `SettingsRoute.test.tsx` for the
 * DOM-level proof.
 */
function CreateLlmConfigForm({
  onCreated,
  onCancel,
}: {
  onCreated: (config: LLMConfig) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CreateFormState>(BLANK_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueModel[]>([]);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(false);

  const providerChoice = providerChoiceFor(form.provider);
  const providerLiveFetch = liveFetchFor(providerChoice);
  const baseUrl = form.baseUrl.trim();

  // Every provider's model suggestions are fetched the same way this form
  // asks for anything else about a not-yet-saved config: OpenRouter's own
  // public catalogue once (no key, no base_url, cached server-side), any
  // other live-fetch provider debounced on its base_url/key
  // (`previewModels`, the "Add a model" form's own gap this closes — see
  // that endpoint's docstring), and a provider with neither is left to
  // free-text typing exactly as it always was.
  useEffect(() => {
    let cancelled = false;
    setCatalogueError(null);

    if (providerChoice === "openrouter") {
      setCatalogueLoading(true);
      listModelCatalogue()
        .then((models) => {
          if (!cancelled) setCatalogue(models);
        })
        .catch(() => {
          if (!cancelled) setCatalogueError("Couldn't load the model catalogue.");
        })
        .finally(() => {
          if (!cancelled) setCatalogueLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    if (!providerLiveFetch || baseUrl === "") {
      setCatalogue([]);
      setCatalogueLoading(false);
      return;
    }

    setCatalogueLoading(true);
    const timer = setTimeout(() => {
      previewModels({
        provider: form.provider.trim(),
        base_url: baseUrl,
        api_key: form.apiKey.trim() === "" ? undefined : form.apiKey.trim(),
      })
        .then((models) => {
          if (!cancelled) setCatalogue(models);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setCatalogue([]);
            setCatalogueError(errorMessage(err));
          }
        })
        .finally(() => {
          if (!cancelled) setCatalogueLoading(false);
        });
    }, LIVE_FETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [providerChoice, providerLiveFetch, baseUrl, form.provider, form.apiKey]);

  const query = form.model.trim().toLowerCase();
  const chosen = useMemo(
    () => catalogue.find((model) => model.id === form.model.trim()) ?? null,
    [catalogue, form.model],
  );
  // A live-fetched (non-OpenRouter) model reports none of these three —
  // see `_parse_generic_models`'s own docstring — so the summary line
  // below only renders when there is at least one fact to actually show;
  // otherwise it would be a bare "per 1M tokens" floating with nothing
  // beside it.
  const chosenContext = chosen === null ? null : formatContext(chosen.context_length);
  const chosenIn = chosen === null ? null : pricePerMillion(chosen.pricing?.prompt);
  const chosenOut = chosen === null ? null : pricePerMillion(chosen.pricing?.completion);
  // Suggestions disappear once the value *is* a catalogue id — at that
  // point the list would only offer the row already chosen, and the
  // summary line under the field carries the same two numbers.
  const suggestions = useMemo(() => {
    if (query === "" || chosen !== null) return [];
    return catalogue
      .filter(
        (model) =>
          model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
      )
      .slice(0, CATALOGUE_SUGGESTION_LIMIT);
  }, [catalogue, chosen, query]);

  function patch(fields: Partial<CreateFormState>) {
    setForm((prev) => ({ ...prev, ...fields }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = form.name.trim();
    const model = form.model.trim();
    if (name === "" || model === "") {
      setFormError("Name and model are both required.");
      return;
    }

    const apiKey = form.apiKey.trim();
    // Cleared immediately, win or lose — see this component's own
    // docstring.
    setForm((prev) => ({ ...prev, apiKey: "" }));

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createLlmConfig({
        name,
        provider: form.provider.trim() || "openrouter",
        model,
        base_url: form.baseUrl.trim() === "" ? undefined : form.baseUrl.trim(),
        api_key: apiKey === "" ? undefined : apiKey,
        kind: form.kind,
        is_default: form.isDefault,
      });
      onCreated(created);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
      {formError !== null && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="llm-name">Name</Label>
          <Input
            id="llm-name"
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={submitting}
            required
          />
        </div>

        <div className={cn("grid content-start gap-2", FULL_WIDTH_SELECT)}>
          <Label htmlFor="llm-provider">Provider</Label>
          <NativeSelect
            id="llm-provider"
            value={providerChoice}
            onChange={(event) => {
              const next = event.target.value;
              // Custom Endpoint clears the field rather than keeping
              // whatever known value was picked before — an operator who
              // switches to it is about to type their own name, and a
              // stale "openrouter" left sitting underneath would silently
              // get sent if they typed nothing.
              patch({ provider: next === CUSTOM_PROVIDER ? "" : next });
            }}
            disabled={submitting}
          >
            {KNOWN_PROVIDERS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value={CUSTOM_PROVIDER}>Custom Endpoint</NativeSelectOption>
          </NativeSelect>
          {providerChoice === CUSTOM_PROVIDER && (
            <Input
              placeholder="Provider name"
              aria-label="Custom provider name"
              value={form.provider}
              onChange={(event) => patch({ provider: event.target.value })}
              disabled={submitting}
            />
          )}
        </div>

        <div className="grid content-start gap-2">
          <Label htmlFor="llm-model">Model</Label>
          <Input
            id="llm-model"
            className="font-mono"
            placeholder="anthropic/claude-sonnet-4.5"
            value={form.model}
            onChange={(event) => patch({ model: event.target.value })}
            disabled={submitting}
            required
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="llm-model-catalogue"
          />
          {chosen !== null && (chosenContext !== null || chosenIn !== null || chosenOut !== null) && (
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              {chosenContext === null ? null : `${chosenContext} context`}
              {chosenIn === null ? null : ` · ${chosenIn} in`}
              {chosenOut === null ? null : ` · ${chosenOut} out`}
              {" per 1M tokens"}
            </p>
          )}
          {catalogueLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" className="size-3.5" />
              Finding models…
            </p>
          )}
          {catalogueError === null ? null : (
            <p className="text-sm text-warning">
              {catalogueError}{" "}
              {providerChoice === "openrouter"
                ? "You can still type a model id by hand."
                : "You can still type a model id by hand, or check the base URL and key."}
            </p>
          )}
          {suggestions.length === 0 ? null : (
            <ul
              className="max-h-64 divide-y overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
              id="llm-model-catalogue"
              role="listbox"
              aria-label="Model catalogue"
            >
              {suggestions.map((model) => {
                const context = formatContext(model.context_length);
                const inPrice = pricePerMillion(model.pricing?.prompt);
                const outPrice = pricePerMillion(model.pricing?.completion);
                return (
                  <li key={model.id}>
                    {/* A grid, not a flex row: the price column has to line up
                        down the list or the comparison the picker exists for
                        does not happen. */}
                    <button
                      type="button"
                      role="option"
                      aria-selected={model.id === form.model}
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-default disabled:opacity-60"
                      onClick={() => patch({ model: model.id })}
                      disabled={submitting}
                    >
                      <span className="col-start-1 row-start-1 truncate text-sm">{model.name}</span>
                      <span className="col-start-1 row-start-2 truncate font-mono text-xs text-muted-foreground">
                        {model.id}
                      </span>
                      <span className="col-start-2 row-span-2 row-start-1 self-center font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {context === null ? "—" : context}
                        {inPrice === null ? "" : ` · ${inPrice} in`}
                        {outPrice === null ? "" : ` / ${outPrice} out`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="grid content-start gap-2">
          <Label htmlFor="llm-base-url">Base URL</Label>
          <Input
            id="llm-base-url"
            className="font-mono"
            placeholder={providerChoice === "openrouter" ? "Provider default" : "https://…/v1"}
            value={form.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            disabled={submitting}
          />
          {providerLiveFetch && providerChoice !== "openrouter" && baseUrl !== "" && (
            <p className="text-sm text-muted-foreground">Model suggestions below come live from this endpoint.</p>
          )}
        </div>

        <div className="grid content-start gap-2">
          <Label htmlFor="llm-api-key">API key</Label>
          <Input
            id="llm-api-key"
            type="password"
            autoComplete="off"
            placeholder="Write-only — never shown again"
            value={form.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
            disabled={submitting}
          />
        </div>

        <div className={cn("grid content-start gap-2", FULL_WIDTH_SELECT)}>
          <Label htmlFor="llm-kind">Kind</Label>
          <NativeSelect
            id="llm-kind"
            value={form.kind}
            onChange={(event) => patch({ kind: event.target.value as LLMConfigKind })}
            disabled={submitting}
          >
            <NativeSelectOption value="chat">Chat</NativeSelectOption>
            <NativeSelectOption value="embedding">Embedding</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="llm-is-default"
          checked={form.isDefault}
          onCheckedChange={(checked) => patch({ isDefault: checked === true })}
          disabled={submitting}
        />
        <Label htmlFor="llm-is-default" className="font-normal">
          Make this the tenant's default model
        </Label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting && <Spinner aria-hidden="true" />}
          {submitting ? "Adding…" : "Add model"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface RowState {
  busy: boolean;
  error: string | null;
  confirmingDelete: boolean;
}

const BLANK_ROW_STATE: RowState = { busy: false, error: null, confirmingDelete: false };

/**
 * Models & keys, per-agent code execution, and the effective sandbox
 * limits — the three things Gap 2 named as real (this task's report has
 * the full verification). "Fallback model" and "skills" are not here on
 * purpose: neither exists in this service (see the report).
 */
export function SettingsRoute() {
  const [configs, setConfigs] = useState<LLMConfig[] | null>(null);
  const [configsError, setConfigsError] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [creating, setCreating] = useState(false);
  // Whether each provider's `<details>` is open. Computed once per provider
  // the first time it's seen (`defaultOpenFor`), then left entirely to
  // `onToggle` — never recomputed from `configs` on every render, which
  // would silently snap a manually-opened group shut the next time
  // anything else on this page re-renders (the key field above updates
  // this same component's state on every keystroke).
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});

  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [askSaving, setAskSaving] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  async function refreshConfigs() {
    try {
      setConfigs(await listLlmConfigs());
      setConfigsError(null);
    } catch (err) {
      setConfigsError(errorMessage(err));
    }
  }

  useEffect(() => {
    void refreshConfigs();
    fetchSettings()
      .then(setSettings)
      .catch((err: unknown) => setSettingsError(errorMessage(err)));
  }, []);

  // Fills in a default for any provider not already in `openProviders` —
  // on first load, and again for a provider a later refresh introduces
  // (a model just added under a brand new provider string). Never
  // touches a provider already keyed here, which is what leaves a manual
  // toggle alone.
  useEffect(() => {
    if (configs === null) return;
    setOpenProviders((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const group of groupByProvider(configs)) {
        if (group.provider in next) continue;
        next[group.provider] = defaultOpenFor(group);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [configs]);

  /**
   * Writes one flag, then keeps the checkbox in step with what the server
   * actually stored — not with what was clicked. The two differ exactly when
   * the write fails, which is the moment a checkbox showing the new value
   * would be lying about the state of the tenant.
   */
  async function saveAsk(patch: Partial<AskDisclosure>) {
    setAskSaving(true);
    setAskError(null);
    try {
      const saved = await updateAskDisclosure(patch);
      setSettings((prev) => (prev === null ? prev : { ...prev, ask: saved }));
    } catch (err) {
      setAskError(errorMessage(err));
    } finally {
      setAskSaving(false);
    }
  }

  function rowState(id: number): RowState {
    return rowStates[id] ?? BLANK_ROW_STATE;
  }

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK_ROW_STATE), ...patch } }));
  }

  async function handleSetDefault(config: LLMConfig) {
    patchRow(config.id, { busy: true, error: null });
    try {
      await updateLlmConfig(config.id, { is_default: true });
      await refreshConfigs();
    } catch (err) {
      patchRow(config.id, { error: errorMessage(err) });
    } finally {
      patchRow(config.id, { busy: false });
    }
  }

  /**
   * The control this table never had: a way to make one of the ~260
   * pre-seeded catalogue rows selectable for an agent (or take one out of
   * rotation) without also making it the tenant's one default. "Set
   * default" answers a different question — which config's key every
   * keyless row borrows — and conflating the two would force marking a
   * model default just to make it choosable in `ConfigTab`'s phase picker.
   */
  async function handleToggleActive(config: LLMConfig) {
    patchRow(config.id, { busy: true, error: null });
    try {
      await updateLlmConfig(config.id, { is_active: !config.is_active });
      await refreshConfigs();
    } catch (err) {
      patchRow(config.id, { error: errorMessage(err) });
    } finally {
      patchRow(config.id, { busy: false });
    }
  }

  async function handleDelete(id: number) {
    patchRow(id, { busy: true, error: null });
    try {
      await deleteLlmConfig(id);
      await refreshConfigs();
      setRowStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      patchRow(id, { busy: false, error: errorMessage(err), confirmingDelete: false });
    }
  }

  const rows = configs ?? [];
  // The tenant's one key physically lives on whichever config is `is_default`
  // — that is where `app.agent.lm.build_lm` looks for the fallback every
  // keyless config borrows. The panel below presents it as what it actually
  // is, one credential for the tenant, rather than a per-model field on a
  // catalogue of 260-odd rows.
  const defaultConfig = rows.find((config) => config.is_default) ?? null;
  const tenantKeySet = defaultConfig?.has_api_key ?? false;

  async function handleSaveKey() {
    if (defaultConfig === null) return;
    setKeyBusy(true);
    setKeyError(null);
    setKeySaved(false);
    try {
      await updateLlmConfig(defaultConfig.id, { api_key: keyDraft.trim() });
      // Cleared immediately: the key is never held in component state past
      // the request that carried it, and never re-read from the server —
      // the API reports has_api_key and never the value itself.
      setKeyDraft("");
      setKeySaved(true);
      await refreshConfigs();
    } catch (err) {
      setKeyError(errorMessage(err));
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        kicker="Configure"
        title="Settings"
        description="Models and keys this tenant runs on, which agents may execute code, and the sandbox limits every run shares."
      />
      <div className="flex flex-col gap-6">
        <section aria-labelledby="settings-key-title">
          <Card>
            <CardHeader>
              <CardTitle>
                <h3 id="settings-key-title">OpenRouter key</h3>
              </CardTitle>
              <CardDescription>
                One key for the whole tenant. Every model below runs on it — a model only needs its
                own key if it should bill somewhere else.
              </CardDescription>
              <CardAction>
                <StatusPill
                  tone={tenantKeySet ? "good" : "amber"}
                  label={tenantKeySet ? "Set" : "Not set"}
                />
              </CardAction>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              {defaultConfig === null ? (
                <Alert className="border-warning/30 bg-warning-soft text-warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertDescription className="text-warning">
                    No default model is set, so there is nowhere to store the key. Mark one of the
                    models below as the default first.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="flex max-w-2xl flex-col gap-2">
                  <Label htmlFor="tenant-openrouter-key">
                    {tenantKeySet ? "Replace the key" : "API key"}
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Input
                      id="tenant-openrouter-key"
                      className="font-mono sm:max-w-md"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="sk-or-..."
                      value={keyDraft}
                      disabled={keyBusy}
                      onChange={(event) => {
                        setKeyDraft(event.target.value);
                        setKeySaved(false);
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        disabled={keyBusy || keyDraft.trim() === ""}
                        onClick={() => void handleSaveKey()}
                      >
                        {keyBusy ? <Spinner aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
                        {keyBusy ? "Saving…" : "Save key"}
                      </Button>
                      {keySaved && <StatusPill tone="good" label="Saved" />}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {/* Never rendered back — the API reports only whether one is stored. */}
                    Write-only. Stored encrypted; it is never shown again.
                  </p>
                </div>
              )}

              {keyError !== null && (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{keyError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="settings-models-title">
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <CardTitle>
                <h3 id="settings-models-title">Models &amp; keys</h3>
              </CardTitle>
              {configs !== null && configsError === null && (
                <CardDescription className="tabular-nums">
                  {rows.length} {rows.length === 1 ? "model" : "models"}
                </CardDescription>
              )}
              {!creating && (
                <CardAction>
                  <Button type="button" size="sm" onClick={() => setCreating(true)}>
                    <Plus aria-hidden="true" />
                    Add a model
                  </Button>
                </CardAction>
              )}
            </CardHeader>

            {creating && (
              <div className="border-b bg-muted/30 px-6 py-5">
                <h4 className="mb-4 text-sm font-medium">New model</h4>
                <CreateLlmConfigForm
                  onCreated={(created) => {
                    setConfigs([...(configs ?? []), created]);
                    setCreating(false);
                  }}
                  onCancel={() => setCreating(false)}
                />
              </div>
            )}

            {configs === null && configsError === null && (
              <p className="flex items-center gap-2 px-6 py-5 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" />
                Loading models…
              </p>
            )}
            {configsError !== null && (
              <div className="px-6 py-5">
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{configsError}</AlertDescription>
                </Alert>
              </div>
            )}
            {configs !== null && configsError === null && rows.length === 0 && (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                No models configured yet. Add one with a tenant OpenRouter key to let agents run.
              </p>
            )}
            {rows.length > 0 && (
              <div className="divide-y">
                {groupByProvider(rows).map((group) => (
                  <details
                    key={group.provider}
                    className="group/provider"
                    open={openProviders[group.provider] ?? defaultOpenFor(group)}
                    onToggle={(event) => {
                      const isOpen = event.currentTarget.open;
                      setOpenProviders((prev) => ({ ...prev, [group.provider]: isOpen }));
                    }}
                  >
                    {/* list-none + the webkit marker rule: the browser's own
                        disclosure triangle is replaced by the chevron below, so
                        the two never show up twice. */}
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-3 select-none hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 text-muted-foreground transition-transform group-open/provider:rotate-90"
                      />
                      <span className="text-sm font-medium capitalize">{group.provider}</span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
                        {group.configs.length} {group.configs.length === 1 ? "model" : "models"}
                        {" · "}
                        {group.activeCount} active
                      </span>
                    </summary>
                    <div className="border-t">
                      <Table>
                        <TableHeader className="bg-muted/50">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="pl-6">Name</TableHead>
                            <TableHead>Model</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="pr-6 text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.configs.map((config) => {
                            const state = rowState(config.id);
                            return (
                              <TableRow key={config.id}>
                                <TableCell className="pl-6 font-medium">{config.name}</TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">
                                  {config.model}
                                </TableCell>
                                <TableCell className="text-muted-foreground">{config.kind}</TableCell>
                                <TableCell>
                                  {/* "Missing" was a lie for the ~260 catalogue rows: a config with
                                      no key of its own borrows the tenant's at run time and works
                                      perfectly. It is only missing when the tenant has none either. */}
                                  {config.has_api_key ? (
                                    <StatusPill tone="good" label="Own key" />
                                  ) : tenantKeySet ? (
                                    <StatusPill tone="neutral" label="Tenant key" />
                                  ) : (
                                    <StatusPill tone="amber" label="Missing" />
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1.5">
                                    {config.is_default && <StatusPill tone="good" label="Default" />}
                                    <StatusPill
                                      tone={config.is_active ? "neutral" : "amber"}
                                      label={config.is_active ? "Active" : "Inactive"}
                                    />
                                  </div>
                                </TableCell>
                                <TableCell className="pr-6">
                                  <div className="flex items-center justify-end gap-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={state.busy}
                                      onClick={() => void handleToggleActive(config)}
                                    >
                                      {config.is_active ? (
                                        <PowerOff aria-hidden="true" />
                                      ) : (
                                        <Power aria-hidden="true" />
                                      )}
                                      {config.is_active ? "Deactivate" : "Activate"}
                                    </Button>
                                    {!config.is_default && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={state.busy}
                                        onClick={() => void handleSetDefault(config)}
                                      >
                                        <Star aria-hidden="true" />
                                        Set default
                                      </Button>
                                    )}
                                    {!state.confirmingDelete && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                        disabled={state.busy}
                                        onClick={() => patchRow(config.id, { confirmingDelete: true })}
                                      >
                                        <Trash2 aria-hidden="true" />
                                        Remove
                                      </Button>
                                    )}
                                    {state.confirmingDelete && (
                                      <>
                                        <Button
                                          type="button"
                                          variant="destructive"
                                          size="sm"
                                          disabled={state.busy}
                                          onClick={() => void handleDelete(config.id)}
                                        >
                                          {state.busy && <Spinner aria-hidden="true" />}
                                          {state.busy ? "Removing…" : "Confirm"}
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          disabled={state.busy}
                                          onClick={() => patchRow(config.id, { confirmingDelete: false })}
                                        >
                                          Cancel
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                  {state.error !== null && (
                                    <p className="mt-1 text-right text-xs whitespace-normal text-destructive">
                                      {state.error}
                                    </p>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </section>

        <section aria-labelledby="settings-ask-title">
          <Card>
            <CardHeader>
              <CardTitle>
                <h3 id="settings-ask-title">Ask — what readers see</h3>
              </CardTitle>
              <CardDescription>
                {settings?.ask.set_by_ancestor === true
                  ? "Set for every organisation by your parent organisation"
                  : "Applies to this organisation and every one under it"}
              </CardDescription>
              {settings?.ask.set_by_ancestor === true && (
                <CardAction>
                  <Badge variant="outline">
                    <Lock aria-hidden="true" />
                    Locked
                  </Badge>
                </CardAction>
              )}
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              <p className="max-w-3xl text-sm text-muted-foreground">
                Ask answers in one or two sentences. These add the working behind it — useful
                while you are building an agent, noise for everyone else, so both are off by
                default.
              </p>

              {settingsError === null && settings === null && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  Loading…
                </p>
              )}
              {askError !== null && (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{askError}</AlertDescription>
                </Alert>
              )}
              {settings?.ask.set_by_ancestor === true && (
                // A standing explanation, not an event — role="note" rather
                // than the Alert's default role="alert", which would be
                // announced as if something had just gone wrong.
                <Alert role="note" className="bg-muted/50">
                  <Lock aria-hidden="true" />
                  <AlertDescription>
                    Your parent organisation decides what readers see here, for every organisation
                    under it. Ask an admin there to change it.
                  </AlertDescription>
                </Alert>
              )}
              {settings !== null && (
                <div className="grid gap-3 lg:grid-cols-2">
                  <Label className={TOGGLE_CLASS}>
                    <Checkbox
                      className="mt-0.5"
                      checked={settings.ask.show_reasoning}
                      disabled={askSaving || settings.ask.set_by_ancestor === true}
                      onCheckedChange={(checked) => void saveAsk({ show_reasoning: checked === true })}
                    />
                    <span className="grid gap-1">
                      <span className="font-medium">Reasoning steps</span>
                      <span className="text-muted-foreground">
                        The phase-by-phase card, live as the run happens. Off, readers see a single
                        line saying it is thinking and how long it has been.
                      </span>
                    </span>
                  </Label>
                  <Label className={TOGGLE_CLASS}>
                    <Checkbox
                      className="mt-0.5"
                      checked={settings.ask.show_query_results}
                      disabled={askSaving || settings.ask.set_by_ancestor === true}
                      onCheckedChange={(checked) => void saveAsk({ show_query_results: checked === true })}
                    />
                    <span className="grid gap-1">
                      <span className="font-medium">Query result tables</span>
                      <span className="text-muted-foreground">
                        The raw rows a query returned, shown with the answer. A fleet-wide read is
                        hundreds of rows, which is why this is off by default. Charts, stats and
                        summaries are the answer and always show; whether an agent draws them is its
                        own Generative UI setting.
                      </span>
                    </span>
                  </Label>
                  <Label className={TOGGLE_CLASS}>
                    <Switch
                      className="mt-0.5"
                      checked={settings.ask.page_actions_enabled === true}
                      disabled={askSaving || settings.ask.set_by_ancestor === true}
                      onCheckedChange={(checked) => void saveAsk({ page_actions_enabled: checked })}
                    />
                    <span className="grid gap-1">
                      <span className="font-medium">Page actions</span>
                      <span className="text-muted-foreground">
                        Lets the /do agent click and type on the bolt-v2 screen a person has open.
                        Saves and deletes always ask first.
                      </span>
                    </span>
                  </Label>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="settings-agents-title">
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="border-b py-4 [.border-b]:pb-4">
              <CardTitle>
                <h3 id="settings-agents-title">Agents — code execution</h3>
              </CardTitle>
              {settings !== null && (
                <CardDescription className="tabular-nums">
                  {settings.agents.length} {settings.agents.length === 1 ? "agent" : "agents"}
                </CardDescription>
              )}
            </CardHeader>

            {settingsError !== null && (
              <div className="px-6 py-5">
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{settingsError}</AlertDescription>
                </Alert>
              </div>
            )}
            {settingsError === null && settings === null && (
              <p className="flex items-center gap-2 px-6 py-5 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" />
                Loading agents…
              </p>
            )}
            {settingsError === null && settings !== null && settings.agents.length === 0 && (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                No agents exist for this tenant yet.
              </p>
            )}
            {settingsError === null && settings !== null && settings.agents.length > 0 && (
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Agent</TableHead>
                    <TableHead className="pr-6">Code execution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settings.agents.map((agent) => (
                    <TableRow key={agent.id}>
                      <TableCell className="pl-6 font-medium">{agent.name}</TableCell>
                      <TableCell className="pr-6">
                        <StatusPill
                          tone={CODE_EXECUTION_TONE[agent.code_execution]}
                          label={CODE_EXECUTION_LABEL[agent.code_execution]}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </section>

        <section aria-labelledby="settings-sandbox-title">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <h3 id="settings-sandbox-title">Sandbox limits</h3>
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  Effective, read-only
                </Badge>
              </CardTitle>
              <CardDescription>
                Set once for the whole service (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                  app/config.py
                </code>
                ), not per tenant — shown here as fact, not as something this screen can change.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {settingsError === null && settings === null && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  Loading sandbox limits…
                </p>
              )}
              {settingsError === null && settings !== null && (
                <dl className="grid gap-4 sm:grid-cols-3">
                  <div className={FACT_CLASS}>
                    <dt className="text-sm text-muted-foreground">Max executions per run</dt>
                    <dd className={FACT_VALUE_CLASS}>{settings.sandbox.max_executions_per_run}</dd>
                  </div>
                  <div className={FACT_CLASS}>
                    <dt className="text-sm text-muted-foreground">Max concurrent executions per user</dt>
                    <dd className={FACT_VALUE_CLASS}>
                      {settings.sandbox.max_concurrent_executions_per_user}
                      {!settings.sandbox.concurrency_configured && (
                        <StatusPill tone="amber" label="Not configured" />
                      )}
                    </dd>
                  </div>
                  <div className={FACT_CLASS}>
                    <dt className="text-sm text-muted-foreground">Execution slot TTL</dt>
                    <dd className={FACT_VALUE_CLASS}>{settings.sandbox.concurrent_slot_ttl_seconds}s</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
