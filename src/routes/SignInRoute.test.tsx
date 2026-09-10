import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { getSession, setSession } from "../auth/session.ts";
import { SignInRoute } from "./SignInRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const principal = {
  user_id: "961741e5-82ce-4d24-83e4-e7db1475931a",
  username: "bolt-v2 production",
  email: "",
  tenant_id: "ca304db7-7e68-4c20-be14-fc019b1ca266",
  permissions: [
    { name: "agent.chat.use", can_read: true },
    { name: "agent.audit", can_read: false },
  ],
};

function renderSignIn() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SignInRoute />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/**
 * One credential, one field.
 *
 * This screen used to carry an email/password form posting bolt-v2's
 * `PasswordLogin`, an organisation `<select>` for the `organisationId` that
 * call requires, a Turnstile captcha, and a second panel for pasting a
 * bolt-v2 access token. All four are gone: agent-service issues and verifies
 * its own API keys, so nothing a bolt-v2 password could produce is a
 * credential here any more.
 *
 * `test_no_password_or_organisation_field_remains` is the one that would
 * catch a revert.
 */
describe("SignInRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("verifies the key against /agent/me and stores the session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(principal));

    renderSignIn();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "boltai_abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(getSession()).not.toBeNull());
    const session = getSession()!;
    expect(session.apiKey).toBe("boltai_abc123");
    // The label, not a person — a key has nobody behind it.
    expect(session.user.name).toBe("bolt-v2 production");
    // The organisation the key resolved to, so the very first request carries
    // the same one `/agent/me` just reported rather than no header at all.
    expect(session.organisationId).toBe(principal.tenant_id);
    // Only the READABLE names are kept: the question every reader asks is
    // "should I bother fetching this?", so the narrowing happens once.
    expect(session.permissions).toEqual(["agent.chat.use"]);

    const [url, init] = fetchMock.mock.calls[0]! as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain("/agent/me");
    expect(init.headers["X-Api-Key"]).toBe("boltai_abc123");
  });

  it("tolerates a key pasted with a Bearer prefix or stray whitespace", async () => {
    // The two places an operator is most likely to have copied one from: a
    // devtools header view, and a terminal.
    fetchMock.mockResolvedValueOnce(jsonResponse(principal));

    renderSignIn();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "  Bearer boltai_abc123  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(getSession()).not.toBeNull());
    expect(getSession()!.apiKey).toBe("boltai_abc123");
  });

  it("refuses to submit an empty field without a round trip", async () => {
    renderSignIn();
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/paste an api key/i);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });

  it("points at the service log when the key is refused", async () => {
    // agent-service answers every auth failure with one status and one body
    // on purpose, so the console cannot say WHICH — but the service does name
    // the reason in its own log, and saying so beats guessing between causes
    // the response cannot support.
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not authenticated" }, 401));

    renderSignIn();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "boltai_wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/rejected this key/i);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/log names the exact reason/i);
    expect(getSession()).toBeNull();
  });

  it("says so when agent-service cannot be reached at all", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    renderSignIn();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "boltai_abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn't reach agent-service/i);
    });
  });

  it("leaves the form usable after a failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not authenticated" }, 401));

    renderSignIn();
    const field = screen.getByLabelText("API key");
    fireEvent.change(field, { target: { value: "boltai_wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    // Not stuck on "Verifying…": a form that disables itself forever after
    // one bad paste is indistinguishable from a hung request.
    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
    expect(field).not.toBeDisabled();
  });

  it("no password or organisation field remains", () => {
    renderSignIn();

    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByLabelText(/email or username/i)).toBeNull();
    expect(screen.queryByLabelText(/^organisation$/i)).toBeNull();
    // And no second way in — the token-paste panel went with the rest.
    expect(screen.queryByRole("button", { name: /token/i })).toBeNull();
    // One field, one button.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps the key off the screen", () => {
    // Not `current-password` on autocomplete either: a browser offering a
    // saved website password for a service credential is a wrong suggestion.
    renderSignIn();
    const field = screen.getByLabelText("API key");

    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
  });
});
