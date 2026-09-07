import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayClient } from "../api/client.ts";
import { setSession } from "./session.ts";
import { AuthProvider } from "./AuthContext.tsx";
import { RequireAuth } from "./RequireAuth.tsx";

function renderProtectedApp() {
  return render(
    <MemoryRouter initialEntries={["/ask"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<div>SIGN IN SCREEN</div>} />
          <Route
            path="/ask"
            element={
              <RequireAuth>
                <div>PROTECTED CONTENT</div>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects a signed-out operator to /sign-in", () => {
    renderProtectedApp();
    expect(screen.getByText("SIGN IN SCREEN")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED CONTENT")).not.toBeInTheDocument();
  });

  it("renders the protected route once signed in", () => {
    act(() => {
      setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
    });
    renderProtectedApp();
    expect(screen.getByText("PROTECTED CONTENT")).toBeInTheDocument();
  });

  // Requirement 4: "401/403 handling that returns the user to sign-in
  // without losing where they were." This exercises the real path: a
  // /agent/* call 401s through the actual gatewayClient singleton, which
  // clears session.ts, which RequireAuth is subscribed to via
  // useSyncExternalStore — no mocking of the auth wiring itself.
  it("routes back to sign-in once a live session's token is rejected with 401", async () => {
    act(() => {
      setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
    });
    renderProtectedApp();
    expect(screen.getByText("PROTECTED CONTENT")).toBeInTheDocument();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    await act(async () => {
      await expect(gatewayClient.agentFetch("/agent/me")).rejects.toThrow();
    });

    expect(screen.getByText("SIGN IN SCREEN")).toBeInTheDocument();
    expect(screen.queryByText("PROTECTED CONTENT")).not.toBeInTheDocument();
  });
});
