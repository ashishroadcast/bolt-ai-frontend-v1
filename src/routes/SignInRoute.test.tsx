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

/** `resolveOrganisations`/`signInWithPassword`/`verifyAndSetSession` are
 * three separate fetches in sequence — a test's mock answers them in call
 * order, matching how a real submit actually unfolds. */
function fetchSequence(...responses: Response[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  return mock;
}

function organisationsResponse(organisations: { id: string; name: string }[]): Response {
  return jsonResponse({ data: { EmailOrMobileBasedOrganisations: organisations } });
}

function passwordLoginResponse(
  overrides: Partial<{ token: string | null; refreshToken: string | null; deviceLimitExceeded: boolean }> = {},
): Response {
  return jsonResponse({
    data: {
      PasswordLogin: {
        token: "issued-jwt",
        refreshToken: "issued-refresh",
        deviceLimitExceeded: false,
        ...overrides,
      },
    },
  });
}

function agentMeResponse(): Response {
  return jsonResponse({ user_id: "1", username: "ada", email: "a@b.com", permissions: [] });
}

async function fillCredentials() {
  fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "a@b.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
}

async function submit() {
  await fillCredentials();
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

  it("shows the server's error message and keeps the form usable on invalid credentials", async () => {
    // A single organisation, so the flow goes straight to PasswordLogin —
    // which is where bolt-v2 reports "password invalid".
    fetchMock = fetchSequence(
      organisationsResponse([{ id: "org-1", name: "Roadcast" }]),
      jsonResponse({ data: null, errors: [{ message: "password invalid" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("password invalid");
    });
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
    expect(getSession()).toBeNull();
  });

  it("shows a usable message when bolt-v2 itself is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).not.toBe("");
  });

  it("signs straight in with no picker when the account has exactly one organisation", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([{ id: "org-1", name: "Roadcast" }]),
      passwordLoginResponse(),
      agentMeResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(getSession()?.token).toBe("issued-jwt");
    });
    expect(screen.queryByLabelText("Organisation")).not.toBeInTheDocument();

    // PasswordLogin (the second call) carries the chosen organisation and
    // never a bearer — there is no session yet to send one from.
    const loginRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    const loginBody = JSON.parse(loginRequest.body as string) as { variables: { organisationId: string } };
    expect(loginBody.variables.organisationId).toBe("org-1");
    const headers = new Headers(loginRequest.headers);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("shows a picker when the account belongs to more than one organisation, and waits for a choice", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([
        { id: "org-1", name: "Roadcast" },
        { id: "org-2", name: "Genpact" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByLabelText("Organisation")).toBeInTheDocument();
    });
    // Nothing past the org lookup has fired yet — the picker step really
    // waits for a second submit rather than guessing the first result.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it("signs in with the picked organisation on the second submit", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([
        { id: "org-1", name: "Roadcast" },
        { id: "org-2", name: "Genpact" },
      ]),
      passwordLoginResponse(),
      agentMeResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Organisation")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Organisation"), { target: { value: "org-2" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(getSession()?.token).toBe("issued-jwt");
    });
    const loginRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    const loginBody = JSON.parse(loginRequest.body as string) as { variables: { organisationId: string } };
    expect(loginBody.variables.organisationId).toBe("org-2");
  });

  it("re-resolves organisations and drops a stale picker when the email changes", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([
        { id: "org-1", name: "Roadcast" },
        { id: "org-2", name: "Genpact" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Organisation")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "different@b.com" } });

    expect(screen.queryByLabelText("Organisation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  it("reports deviceLimitExceeded as a named failure rather than signing in with the pre-auth token", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([{ id: "org-1", name: "Roadcast" }]),
      passwordLoginResponse({ token: "pre-auth-token", refreshToken: null, deviceLimitExceeded: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too many devices/i);
    });
    expect(getSession()).toBeNull();
    // Never reached agent-service with the pre-auth token — the check
    // short-circuits before verifyAndSetSession's own fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a token agent-service does not accept, and offers the token panel", async () => {
    fetchMock = fetchSequence(
      organisationsResponse([{ id: "org-1", name: "Roadcast" }]),
      passwordLoginResponse(),
      jsonResponse({}, 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    await submit();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/rejected this token/i);
    });
    expect(getSession()).toBeNull();
  });

  it("switches to the token-paste panel and verifies a pasted token directly against agent-service", async () => {
    fetchMock.mockResolvedValue(agentMeResponse());

    renderSignIn();
    fireEvent.click(screen.getByRole("button", { name: /paste a bolt-v2 access token/i }));

    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "pasted-jwt" } });
    fireEvent.click(screen.getByRole("button", { name: /verify and continue/i }));

    await waitFor(() => {
      expect(getSession()?.token).toBe("pasted-jwt");
    });
  });
});
