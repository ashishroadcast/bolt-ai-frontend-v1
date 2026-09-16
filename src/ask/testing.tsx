import type { ReactNode } from "react";
import { AskProvider, type AskConfig } from "./config.tsx";
import { GatewayClient } from "./http/gatewayClient.ts";

/**
 * Test fixtures for the Ask package.
 *
 * Shipped as part of the package rather than kept in a test-only folder,
 * because a HOST needs them too: bolt-v2's frontend will want to render Ask
 * in its own tests without standing up a credential store, and this is the
 * two-line way to do it.
 *
 * It also replaces something worse. Before the extraction, every test that
 * touched Ask called the console's `setSession({...})` to plant a credential
 * in a module-level store — so a component test's outcome depended on global
 * state set by a helper three directories away, and forgetting to clear it
 * leaked into the next file. The credential is an input now, and these are
 * the test's copy of it.
 */

/** A config that talks to a stubbed origin with a fixed credential. */
export const testAskConfig: AskConfig = {
  // Absolute, and deliberately not localhost: `new Request()` needs an
  // origin, and a recognisable host makes a stray un-mocked fetch obvious in
  // a failure message instead of looking like it hit the dev server.
  baseUrl: "http://ask.test",
  auth: {
    getCredential: () => "boltai_test-credential",
    getOrganisationId: () => null,
  },
  setupAgentsHref: "/agents",
  // PINNED, so a test about rendering a reasoning card or a result table
  // mounts one without also having to stub `/agent/settings/ask`. The
  // product default is the opposite — both off — and the tests that care
  // about THAT override this deliberately (see Thread.test.tsx).
  disclosure: { showReasoning: true, showQueryResults: true },
};

/** A client on `testAskConfig`, for the plain functions that take one. */
export function testAskClient(): GatewayClient {
  return new GatewayClient({
    baseUrl: testAskConfig.baseUrl,
    getToken: () => "boltai_test-credential",
    getOrganisationId: () => null,
    onUnauthorized: () => {},
  });
}

/**
 * Wraps a tree in the Ask config so its components can mount.
 *
 * `config` overrides let a test say what it is actually about — a different
 * credential, an `onUnauthorized` spy — without restating the whole object.
 */
export function TestAskProvider({
  children,
  config,
}: {
  children: ReactNode;
  config?: Partial<AskConfig>;
}) {
  return (
    <AskProvider
      config={{
        ...testAskConfig,
        ...config,
        auth: { ...testAskConfig.auth, ...config?.auth },
      }}
    >
      {children}
    </AskProvider>
  );
}
