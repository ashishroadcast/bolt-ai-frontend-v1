import type { AskHostContext } from "../config.tsx";
import { GatewayError } from "../http/errors.ts";
import {
  AgentApiError,
  stringDetailMessage,
  type GatewayClient,
} from "../http/gatewayClient.ts";

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
  /** The host's screen (CONTRACT §7). Omitted when the host supplies none. */
  host_context?: AskHostContext;
  /** The page the host has open, from a host that can act on it
   *  (PAGE_ACTIONS_CONTRACT §2). Omitted everywhere else. */
  page?: RunPage;
}

export interface RunPage {
  route: string;
  title: string;
}

/**
 * Goes through `GatewayClient.agentStream`, which exists precisely for this
 * call: `agentFetch` closes with `await response.json()`, correct for every
 * other endpoint and wrong for this one, whose body is an unbounded SSE
 * stream that must be read incrementally (`protocol.readDataStream`).
 *
 * This function used to open a bare `fetch` and hand-roll its headers,
 * because the task that wrote it could not touch `gatewayClient.ts` — and it
 * said so, naming `agentStream` as the right home. Extracting Ask made that
 * debt load-bearing: once a HOST supplies the credential, the acting
 * organisation and the client type, they cannot also live in a second
 * hand-rolled copy here, or a question gets asked as one organisation while
 * the rest of the screen reads another. One client, one contract.
 */
export async function postAgentRun(
  client: GatewayClient,
  request: RunRequest,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  // Missing credential, refused credential, the `Organisation` header and
  // `X-Client` are all `agentStream`'s job now — including calling the host's
  // `onUnauthorized`, which the console wires to its sign-out and another
  // host may wire to something else entirely.
  const response = await client.agentStream("/agent/run", {
    method: "POST",
    body: JSON.stringify(request),
    signal: options.signal,
  });

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

/**
 * `POST /agent/run`'s refusal of a `session_id` this caller cannot continue:
 * `app.api.run._load_conversation`'s "no conversation N for this user",
 * mapped to a 404.
 *
 * A conversation can be perfectly readable and still land here — one deleted
 * from another tab after it was opened, or a channel transcript, which is
 * listed in History but was never this user's own run. `useChat` answers it
 * by starting a new conversation with the same question rather than failing a
 * follow-up the reader had every reason to expect would work.
 *
 * Read off FastAPI's `detail`, because the status alone is shared with the
 * unknown-agent refusal below, and the two need opposite recoveries.
 */
export function isMissingConversationError(error: unknown): boolean {
  return (
    error instanceof AgentApiError &&
    error.status === 404 &&
    /\bconversation\b/i.test(error.message) &&
    !isUnknownAgentError(error)
  );
}

/** The other 404 `POST /agent/run` sends: `_load_agent`'s "no active agent
 * named … available to this tenant", for an agent deleted or switched off
 * since its name was last seen. Checked first by the server, so it is the
 * one a request carrying both a stale agent and a stale conversation gets. */
export function isUnknownAgentError(error: unknown): boolean {
  return error instanceof AgentApiError && error.status === 404 && /\bno active agent\b/i.test(error.message);
}
