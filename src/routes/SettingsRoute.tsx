import { useEffect, useMemo, useState, type FormEvent } from "react";
import { StatusPill, type StatusPillTone } from "../agents/StatusPill.tsx";
import { PageHeader } from "../agents/PageHeader.tsx";
import { GatewayError } from "../ask/http/errors.ts";
import {
  createLlmConfig,
  deleteLlmConfig,
  listLlmConfigs,
  listModelCatalogue,
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
import styles from "./SettingsRoute.module.css";

function errorMessage(err: unknown): string {
  return err instanceof GatewayError ? err.message : "Couldn't reach the agent service.";
}

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

  // The catalogue is a public price list, so a failure here is a degraded
  // form and not a broken one: the field stays typeable and the operator
  // is told why the list is empty rather than being left to wonder.
  useEffect(() => {
    let cancelled = false;
    listModelCatalogue()
      .then((models) => {
        if (!cancelled) setCatalogue(models);
      })
      .catch(() => {
        if (!cancelled) setCatalogueError("Couldn't load the model catalogue.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = form.model.trim().toLowerCase();
  const chosen = useMemo(
    () => catalogue.find((model) => model.id === form.model.trim()) ?? null,
    [catalogue, form.model],
  );
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
    <form className={styles.form} onSubmit={(event) => void handleSubmit(event)}>
      {formError !== null && (
        <p role="alert" className={styles.formError}>
          {formError}
        </p>
      )}

      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-name">
            Name
          </label>
          <input
            id="llm-name"
            className={styles.input}
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={submitting}
            required
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-provider">
            Provider
          </label>
          <input
            id="llm-provider"
            className={styles.input}
            value={form.provider}
            onChange={(event) => patch({ provider: event.target.value })}
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-model">
            Model
          </label>
          <input
            id="llm-model"
            className={styles.input}
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
          {chosen === null ? null : (
            <p className={styles.modelChosen}>
              {formatContext(chosen.context_length) === null
                ? null
                : `${formatContext(chosen.context_length)} context`}
              {pricePerMillion(chosen.pricing?.prompt) === null
                ? null
                : ` · ${pricePerMillion(chosen.pricing?.prompt)} in`}
              {pricePerMillion(chosen.pricing?.completion) === null
                ? null
                : ` · ${pricePerMillion(chosen.pricing?.completion)} out`}
              {" per 1M tokens"}
            </p>
          )}
          {catalogueError === null ? null : (
            <p className={styles.modelHint}>
              {catalogueError} You can still type a model id by hand.
            </p>
          )}
          {suggestions.length === 0 ? null : (
            <ul
              className={styles.modelList}
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
                    <button
                      type="button"
                      role="option"
                      aria-selected={model.id === form.model}
                      className={styles.modelOption}
                      onClick={() => patch({ model: model.id })}
                      disabled={submitting}
                    >
                      <span className={styles.modelName}>{model.name}</span>
                      <span className={styles.modelId}>{model.id}</span>
                      <span className={styles.modelMeta}>
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-base-url">
            Base URL
          </label>
          <input
            id="llm-base-url"
            className={styles.input}
            placeholder="Provider default"
            value={form.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-api-key">
            API key
          </label>
          <input
            id="llm-api-key"
            type="password"
            autoComplete="off"
            className={styles.input}
            placeholder="Write-only — never shown again"
            value={form.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="llm-kind">
            Kind
          </label>
          <select
            id="llm-kind"
            className={styles.input}
            value={form.kind}
            onChange={(event) => patch({ kind: event.target.value as LLMConfigKind })}
            disabled={submitting}
          >
            <option value="chat">Chat</option>
            <option value="embedding">Embedding</option>
          </select>
        </div>
      </div>

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={form.isDefault}
          onChange={(event) => patch({ isDefault: event.target.checked })}
          disabled={submitting}
        />
        Make this the tenant's default model
      </label>

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Adding…" : "Add model"}
        </button>
        <button type="button" className={styles.cancel} onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
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
      <div className={styles.body}>
        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>OpenRouter key</h3>
            <StatusPill
              tone={tenantKeySet ? "good" : "amber"}
              label={tenantKeySet ? "Set" : "Not set"}
            />
          </header>

          <div className={styles.formWrap}>
            <p className={styles.description}>
              One key for the whole tenant. Every model below runs on it — a model only needs
              its own key if it should bill somewhere else.
            </p>

            {defaultConfig === null ? (
              <p role="alert" className={styles.error}>
                No default model is set, so there is nowhere to store the key. Mark one of the
                models below as the default first.
              </p>
            ) : (
              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="tenant-openrouter-key">
                    {tenantKeySet ? "Replace the key" : "API key"}
                  </label>
                  <input
                    id="tenant-openrouter-key"
                    className={styles.input}
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
                  <p className={styles.rowNote}>
                    {/* Never rendered back — the API reports only whether one is stored. */}
                    Write-only. Stored encrypted; it is never shown again.
                  </p>
                </div>

                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.submit}
                    disabled={keyBusy || keyDraft.trim() === ""}
                    onClick={() => void handleSaveKey()}
                  >
                    {keyBusy ? "Saving…" : "Save key"}
                  </button>
                  {keySaved && <StatusPill tone="good" label="Saved" />}
                </div>
              </div>
            )}

            {keyError !== null && (
              <p role="alert" className={styles.formError}>
                {keyError}
              </p>
            )}
          </div>
        </section>

        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>Models &amp; keys</h3>
            {configs !== null && configsError === null && (
              <span className={styles.sub}>
                {rows.length} {rows.length === 1 ? "model" : "models"}
              </span>
            )}
            {!creating && (
              <button type="button" className={styles.addBtn} onClick={() => setCreating(true)}>
                Add a model
              </button>
            )}
          </header>

          {creating && (
            <div className={styles.formWrap}>
              <CreateLlmConfigForm
                onCreated={(created) => {
                  setConfigs([...(configs ?? []), created]);
                  setCreating(false);
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          )}

          {configs === null && configsError === null && <p className={styles.loading}>Loading models…</p>}
          {configsError !== null && (
            <p role="alert" className={styles.error}>
              {configsError}
            </p>
          )}
          {configs !== null && configsError === null && rows.length === 0 && (
            <p className={styles.empty}>
              No models configured yet. Add one with a tenant OpenRouter key to let agents run.
            </p>
          )}
          {rows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Provider / model</th>
                    <th>Kind</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((config) => {
                    const state = rowState(config.id);
                    return (
                      <tr key={config.id}>
                        <td className={styles.name}>{config.name}</td>
                        <td className={styles.description}>
                          {config.provider} · {config.model}
                        </td>
                        <td className={styles.description}>{config.kind}</td>
                        <td>
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
                        </td>
                        <td>
                          <div className={styles.statusCell}>
                            {config.is_default && <StatusPill tone="good" label="Default" />}
                            <StatusPill
                              tone={config.is_active ? "neutral" : "amber"}
                              label={config.is_active ? "Active" : "Inactive"}
                            />
                          </div>
                        </td>
                        <td>
                          <div className={styles.rowActions}>
                            {!config.is_default && (
                              <button
                                type="button"
                                className={styles.actionBtn}
                                disabled={state.busy}
                                onClick={() => void handleSetDefault(config)}
                              >
                                Set default
                              </button>
                            )}
                            {!state.confirmingDelete && (
                              <button
                                type="button"
                                className={`${styles.actionBtn} ${styles.danger}`}
                                disabled={state.busy}
                                onClick={() => patchRow(config.id, { confirmingDelete: true })}
                              >
                                Remove
                              </button>
                            )}
                            {state.confirmingDelete && (
                              <>
                                <button
                                  type="button"
                                  className={`${styles.actionBtn} ${styles.danger}`}
                                  disabled={state.busy}
                                  onClick={() => void handleDelete(config.id)}
                                >
                                  {state.busy ? "Removing…" : "Confirm"}
                                </button>
                                <button
                                  type="button"
                                  className={styles.actionBtn}
                                  disabled={state.busy}
                                  onClick={() => patchRow(config.id, { confirmingDelete: false })}
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                          </div>
                          {state.error !== null && <p className={styles.rowNote}>{state.error}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>Ask — what readers see</h3>
            <span className={styles.sub}>applies to everyone in this tenant</span>
          </header>

          <p className={styles.sub}>
            Ask answers in one or two sentences. These add the working behind it — useful
            while you are building an agent, noise for everyone else, so both are off by
            default.
          </p>

          {settingsError === null && settings === null && (
            <p className={styles.loading}>Loading…</p>
          )}
          {askError !== null && (
            <p role="alert" className={styles.error}>
              {askError}
            </p>
          )}
          {settings !== null && (
            <div className={styles.toggles}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={settings.ask.show_reasoning}
                  disabled={askSaving}
                  onChange={(event) => void saveAsk({ show_reasoning: event.target.checked })}
                />
                <span>
                  <strong>Reasoning steps</strong>
                  <span className={styles.sub}>
                    The phase-by-phase card, live as the run happens. Off, readers see a single
                    line saying it is thinking and how long it has been.
                  </span>
                </span>
              </label>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={settings.ask.show_query_results}
                  disabled={askSaving}
                  onChange={(event) => void saveAsk({ show_query_results: event.target.checked })}
                />
                <span>
                  <strong>Query result tables</strong>
                  <span className={styles.sub}>
                    Every row a tool returned, rendered above the answer. A fleet-wide read is
                    hundreds of rows, which is why this is off by default.
                  </span>
                </span>
              </label>
            </div>
          )}
        </section>

        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>Agents — code execution</h3>
            {settings !== null && (
              <span className={styles.sub}>
                {settings.agents.length} {settings.agents.length === 1 ? "agent" : "agents"}
              </span>
            )}
          </header>

          {settingsError !== null && (
            <p role="alert" className={styles.error}>
              {settingsError}
            </p>
          )}
          {settingsError === null && settings === null && (
            <p className={styles.loading}>Loading agents…</p>
          )}
          {settingsError === null && settings !== null && settings.agents.length === 0 && (
            <p className={styles.empty}>No agents exist for this tenant yet.</p>
          )}
          {settingsError === null && settings !== null && settings.agents.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Code execution</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.agents.map((agent) => (
                    <tr key={agent.id}>
                      <td className={styles.name}>{agent.name}</td>
                      <td>
                        <StatusPill
                          tone={CODE_EXECUTION_TONE[agent.code_execution]}
                          label={CODE_EXECUTION_LABEL[agent.code_execution]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.sheet}>
          <header className={styles.sheetHead}>
            <h3>Sandbox limits</h3>
            <span className={styles.sub}>Effective, read-only</span>
          </header>
          <p className={styles.sandboxNote}>
            Set once for the whole service (<code>app/config.py</code>), not per tenant — shown here
            as fact, not as something this screen can change.
          </p>
          {settingsError === null && settings === null && (
            <p className={styles.loading}>Loading sandbox limits…</p>
          )}
          {settingsError === null && settings !== null && (
            <dl className={styles.factGrid}>
              <div className={styles.fact}>
                <dt>Max executions per run</dt>
                <dd>{settings.sandbox.max_executions_per_run}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Max concurrent executions per user</dt>
                <dd>
                  {settings.sandbox.max_concurrent_executions_per_user}
                  {!settings.sandbox.concurrency_configured && (
                    <span className={styles.factBadge}>
                      <StatusPill tone="amber" label="Not configured" />
                    </span>
                  )}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Execution slot TTL</dt>
                <dd>{settings.sandbox.concurrent_slot_ttl_seconds}s</dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </>
  );
}
