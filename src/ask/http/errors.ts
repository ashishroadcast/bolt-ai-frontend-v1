/**
 * One error shape for everything the gateway client throws, so a caller
 * can catch `GatewayError` once and get a message fit to show an operator
 * — never a raw fetch/JSON exception leaking through.
 */
export class GatewayError extends Error {
  readonly status?: number;
  readonly graphQLErrors?: readonly string[];

  constructor(message: string, options?: { status?: number; graphQLErrors?: readonly string[] }) {
    super(message);
    this.name = "GatewayError";
    this.status = options?.status;
    this.graphQLErrors = options?.graphQLErrors;
  }
}

/**
 * A 401/403 from the gateway or agent-service. Distinct from GatewayError
 * so call sites that care specifically about "the session ended" (the
 * sign-in redirect) can `instanceof` for it instead of string-matching a
 * message.
 */
export class UnauthorizedError extends GatewayError {
  constructor(status: number) {
    super("Your session ended. Sign in again.", { status });
    this.name = "UnauthorizedError";
  }
}
