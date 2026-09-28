import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./auth/AuthContext.tsx";
import { setSession } from "./auth/session.ts";
import App from "./App.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Prompts and Test suites moved off the top level onto the agent detail
 * page (task brief). The old `/prompts` and `/test-suites` URLs may still
 * be bookmarked or linked from outside the app, so they must land
 * somewhere real (Agents) — not 404, and not silently fall through to the
 * generic "*" catch-all's /ask, which would look like a working link that
 * quietly goes to the wrong place.
 */
describe("App — legacy /prompts and /test-suites URLs", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse([])),
    );
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("redirects /prompts to /agents", async () => {
    render(
      <MemoryRouter initialEntries={["/prompts"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // AgentsRoute renders "Agents" twice — the page's own h2 (PageHeader)
      // and the sheet's own h3 title — so this scopes to the page-level
      // heading specifically rather than either being ambiguous.
      expect(screen.getByRole("heading", { name: "Agents", level: 2 })).toBeInTheDocument();
    });
  });

  it("redirects /test-suites to /agents", async () => {
    render(
      <MemoryRouter initialEntries={["/test-suites"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // AgentsRoute renders "Agents" twice — the page's own h2 (PageHeader)
      // and the sheet's own h3 title — so this scopes to the page-level
      // heading specifically rather than either being ambiguous.
      expect(screen.getByRole("heading", { name: "Agents", level: 2 })).toBeInTheDocument();
    });
  });
});

/**
 * `/mcp-servers` (this task): `app.api.mcp_servers` was mounted with no
 * screen ever calling it — the last Connections surface that was planned
 * and never built (Saurabh's own "where can i see mcp server list?").
 * Proves the route is actually wired into `App.tsx`, not just linked from
 * `Rail.tsx` — `Rail.test.tsx` covers the link's own href, this covers
 * where that href actually lands.
 */
describe("App — /mcp-servers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("renders the MCP servers screen", async () => {
    render(
      <MemoryRouter initialEntries={["/mcp-servers"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "MCP servers", level: 2 })).toBeInTheDocument();
    });
  });
});
