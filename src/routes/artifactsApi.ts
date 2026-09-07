import { gatewayClient } from "../api/client.ts";

/** `app.api.artifacts.ArtifactSummary` — `GET /agent/artifacts` (list).
 * Carries no `url`: a list route never presigns (that module's own
 * docstring), so a caller wanting to download row `id` makes a second
 * call, `getArtifactDownload` below. */
export interface ArtifactSummary {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  code_execution_id: number;
  agent_id: number;
}

/** `app.api.artifacts.ArtifactOut` — `GET /agent/artifacts/{id}`. A fresh,
 * short-lived presigned URL, minted on this one call only — never cached
 * past it, never reused after `expires_in` seconds. */
export interface ArtifactDownload {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url: string;
  expires_in: number;
}

/** `GET /agent/artifacts` — every artifact the caller's own tenant has
 * produced, newest first. */
export function listArtifacts(): Promise<ArtifactSummary[]> {
  return gatewayClient.agentFetch<ArtifactSummary[]>("/agent/artifacts");
}

/** `GET /agent/artifacts/{id}` — resolves one known artifact to a fresh
 * presigned URL. This is the one and only download step this backend
 * offers (`app.api.artifacts`'s own docstring: "No `r2_url`/presigned URL
 * is ever stored ... signs a fresh, short-lived URL ... on every
 * request") — there is no separate "get a download link" endpoint to
 * invent on top of it. */
export function getArtifactDownload(id: string): Promise<ArtifactDownload> {
  return gatewayClient.agentFetch<ArtifactDownload>(`/agent/artifacts/${id}`);
}
