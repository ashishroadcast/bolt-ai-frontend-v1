import { GatewayError, UnauthorizedError } from "../api/errors.ts";
import { AgentApiError, stringDetailMessage } from "../api/gatewayClient.ts";
import { GATEWAY_URL } from "../api/config.ts";
import { getFreshToken, refreshAccessToken } from "../api/client.ts";
import { setSession } from "../auth/session.ts";

/**
 * `POST /agent/run`'s body (`app.api.run.RunIn`, the real Pydantic model —
 * not the design spec's `conversation_id`, which the shipped API never
 * implemented; see this module's own docstring below for why that matters
 * to `useChat.ts`). `session_id` continues an existing conversation;
 * omitted, the server starts a new one.
 */
export interface RunRequest {
  message: string;
  agent?: string;
  session_id?: number;
}

/**
 * The one deliberate exception to "route every /agent/* call through
 * GatewayClient" (task brief). `GatewayClient.agentFetch` always awaits
 * `response.json()` — correct for every other endpoint, wrong for this one,
 * since `POST /agent/run`'s body is an unbounded SSE stream that must be
 * read incrementally (`protocol.readDataStream`), not buffered whole. This
 * task's concurrency boundary forbids editing `gatewayClient.ts` to add a
 * streaming-capable method, so this function reproduces exactly the same
 * auth contract `agentFetch` already enforces — the same `getToken`/
 * `setSession` primitives `../api/client.ts` wires that class to, not a
 * second, independent notion of "the current token" — rather than opening
 * a bare `fetch` with a hand-rolled header. See this task's own report for
 * why a `GatewayClient.agentStream`-shaped method belongs there instead,
 * the next time someone can touch that file.
 */
export async function postAgentRun(request: RunRequest, options: { signal?: AbortSignal } = {}): Promise<Response> {
  async function send(token: string): Promise<Response> {
    return fetch(`${GATEWAY_URL}/agent/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  }

  // getFreshToken, not getToken: this is the longest-lived request the
  // console makes, and it is the one the operator is watching. Sending a
  // token that is about to expire is how a demo ends on "please sign in"
  // halfway through an answer.
  const token = await getFreshToken();
  if (token === null) {
    setSession(null);
    throw new UnauthorizedError(401);
  }

  let response = await send(token);

  // One retry after one refresh, matching GatewayClient's reactive half
  // exactly — including that a 403 is never retried, because a permission
  // the role does not have will not be granted by a newer token. Retrying
  // the POST is safe on a 401 specifically: the request was rejected at
  // the edge, so no run was started and no message was recorded.
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    const retryToken = refreshed ? await getFreshToken() : null;
    if (retryToken !== null) {
      response = await send(retryToken);
    }
  }

  if (response.status === 401 || response.status === 403) {
    setSession(null);
    throw new UnauthorizedError(response.status);
  }
  if (!response.ok) {
    // A non-2xx here is an ordinary buffered JSON error body (RunIn
    // validation, an unknown agent name, a missing permission) — the SSE
    // body only exists on the success path this function otherwise leaves
    // unread, so awaiting .json() here is not the "buffers an unbounded
    // stream" problem this function's own docstring says agentFetch has.
    // Reuses gatewayClient.ts's own AgentApiError/stringDetailMessage
    // rather than a second, independent copy of the same extraction (the
    // task brief's own instruction: no duplicate workaround).
    const body: unknown = await response.json().catch(() => undefined);
    throw new AgentApiError(
      stringDetailMessage(body) ?? `Asking failed (${response.status}).`,
      response.status,
      body,
    );
  }
  if (response.body === null) {
    throw new GatewayError("Asking failed: the server sent no response body.");
  }
  return response;
}
