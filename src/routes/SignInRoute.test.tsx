import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { getSession } from "../auth/session.ts";
import { SignInRoute } from "./SignInRoute.tsx";

function renderSignIn() {
  return render(
    <MemoryRouter initialEntries={["/sign-in"]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInRoute />} />
          {/* A real destination, so "did it navigate?" is answerable. With
              SignInRoute rendered alone, navigate() changes the location and
              nothing unmounts, and a test asserting the form disappeared can
              never pass — which is what the redirect bug hid behind. */}
          <Route path="/ask" element={<p>Ask screen</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function submit() {
  fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("SignInRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a real form, not a blank screen", () => {
    renderSignIn();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email or username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  // Requirement: "a failed sign-in surfaces a usable message rather than
  // a blank screen." Rejects the login mutation the way auth actually
  // does — a GraphQL error, HTTP 200 — and checks the operator sees text
  // explaining it, with the form still there to retry.
  it("shows the server's error message and keeps the form usable on invalid credentials", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: null, errors: [{ message: "invalid credentials" }] }),
    );

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("invalid credentials");
    });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
    expect(getSession()).toBeNull();
  });

  it("shows a usable message when the gateway itself is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).not.toBe("");
  });

  it("establishes a session and does not send a bearer on the login call itself", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          login: {
            accessToken: "issued-jwt",
            requiresOtp: false,
            mustChangePassword: false,
            user: { id: "1", email: "a@b.com", name: "a", displayName: "A B" },
          },
        },
      }),
    );

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(getSession()?.token).toBe("issued-jwt");
    });
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.has("Authorization")).toBe(false);
  });
});
