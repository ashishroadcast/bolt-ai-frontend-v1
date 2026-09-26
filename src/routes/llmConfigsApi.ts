import { gatewayClient } from "../api/client.ts";

/**
 * Wire types for `GET/POST /agent/llm-configs`, `PATCH`/`DELETE /agent/
 * llm-configs/{id}` (`agent-service/app/api/llm_configs.py`). Field names
 * match the FastAPI response verbatim (snake_case), the same convention
 * `./datasourcesApi.ts` already uses for its own wire shape.
 *
 * `LLMConfig` never carries the api key, encrypted or otherwise — only
 * `has_api_key`, a boolean the server derives from whether the row's own
 * `api_key_encrypted` is set (see that module's own docstring, "reports
 * has_api_key, never the key itself"). There is no field on this type a
 * component could accidentally render the credential from.
 */
export type LLMConfigKind = "chat" | "embedding";

export interface LLMConfig {
  id: number;
  name: string;
  provider: string;
  model: string;
  base_url: string | null;
  params: Record<string, unknown>;
  kind: LLMConfigKind;
  is_default: boolean;
  is_active: boolean;
  has_api_key: boolean;
}

/**
 * `api_key` is only ever read from a form field, put straight into this
 * object, handed to `createLlmConfig`, and discarded — no caller of this
 * module stores one past that call, the same discipline `./datasourcesApi.
 * ts`'s `DataSourceCreatePayload.dsn` documents for its own credential
 * field. See `SettingsRoute.tsx` for where the form state itself is
 * cleared the same instant the request resolves, win or lose.
 */
export interface LLMConfigCreatePayload {
  name: string;
  provider: string;
  model: string;
  base_url?: string | null;
  api_key?: string | null;
  kind?: LLMConfigKind;
  is_default?: boolean;
  is_active?: boolean;
}

/**
 * Every field optional — mirrors `app.api.llm_configs.LLMConfigPatch`'s own
 * partial-update contract. `api_key`, when sent, replaces the stored
 * credential the same write-once way `LLMConfigCreatePayload.api_key` does;
 * omit it entirely to leave the existing key untouched.
 */
export interface LLMConfigPatchPayload {
  name?: string;
  provider?: string;
  model?: string;
  base_url?: string | null;
  api_key?: string | null;
  kind?: LLMConfigKind;
  is_default?: boolean;
  is_active?: boolean;
}

export function listLlmConfigs(): Promise<LLMConfig[]> {
  return gatewayClient.agentFetch<LLMConfig[]>("/agent/llm-configs");
}

export function createLlmConfig(payload: LLMConfigCreatePayload): Promise<LLMConfig> {
  return gatewayClient.agentFetch<LLMConfig>("/agent/llm-configs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateLlmConfig(id: number, payload: LLMConfigPatchPayload): Promise<LLMConfig> {
  return gatewayClient.agentFetch<LLMConfig>(`/agent/llm-configs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteLlmConfig(id: number): Promise<void> {
  return gatewayClient.agentFetch<void>(`/agent/llm-configs/${id}`, { method: "DELETE" });
}

/**
 * One entry from `GET /agent/llm-configs/catalogue` — every model
 * OpenRouter routes to, with the two facts an operator actually chooses
 * on. `pricing` is OpenRouter's own map of USD *per token* as decimal
 * strings (`{"prompt": "0.000015", …}`), kept as strings deliberately:
 * these are values like 2.7e-7 that a float round-trip would render as
 * exponent notation in a table cell.
 */
export interface CatalogueModel {
  id: string;
  name: string;
  context_length?: number | null;
  pricing?: Record<string, string> | null;
}

/**
 * Needs no key and no saved config — the picker on the "add a model" form
 * runs before either exists, which is why that field was free text.
 */
export function listModelCatalogue(): Promise<CatalogueModel[]> {
  return gatewayClient
    .agentFetch<{ models: CatalogueModel[] }>("/agent/llm-configs/catalogue")
    .then((result) => result.models);
}

/**
 * `POST /agent/llm-configs/preview-models` — a provider's own live model
 * list, for the "Add a model" form's picker, before any row exists to run
 * `GET /agent/llm-configs/{id}/models` against. `provider === "openrouter"`
 * needs neither `base_url` nor `api_key` (that catalogue is public); any
 * other provider needs `base_url`, and an omitted `api_key` borrows the
 * tenant's default model's key server-side — the same fallback a freshly
 * saved keyless config gets at run time.
 */
export interface PreviewModelsPayload {
  provider: string;
  base_url?: string;
  api_key?: string;
}

export function previewModels(payload: PreviewModelsPayload): Promise<CatalogueModel[]> {
  return gatewayClient
    .agentFetch<{ models: CatalogueModel[] }>("/agent/llm-configs/preview-models", {
      method: "POST",
      body: JSON.stringify(payload),
    })
    .then((result) => result.models);
}
