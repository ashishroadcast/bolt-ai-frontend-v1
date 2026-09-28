import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { endSession, getSession, setSession } from "../auth/session.ts";
import { maskMobile, SignInRoute, toE164 } from "./SignInRoute.tsx";

const connect = vi.hoisted(() => ({ connectWithBolt: vi.fn() }));
vi.mock("../auth/boltConnect.ts", () => connect);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const keyPrincipal = {
  user_id: "961741e5-82ce-4d24-83e4-e7db1475931a",
  username: "bolt-v2 production",
  email: "",
  tenant_id: "ca304db7-7e68-4c20-be14-fc019b1ca266",
  permissions: [
    { name: "agent.chat.use", can_read: true },
    { name: "agent.audit", can_read: false },
  ],
};

const userPrincipal = {
  user_id: "5b0c1c9e-0000-4000-8000-000000000001",
  username: "Pehla User",
  email: "pehla.user@roadcast.in",
  tenant_id: "org-a",
  permissions: [{ name: "agent.chat.use", can_read: true }],
};

/** A JWT-shaped token whose payload carries an `exp` an hour out. */
const ACCESS_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${btoa(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
).replace(/=+$/, "")}.sig`;

type Handler = (body: { query: string; variables: Record<string, unknown> }) => unknown;

/**
 * Answers bolt-v2's GraphQL by operation and agent-service's `/agent/me` by
 * path, so a test states the conversation rather than the call order.
 */
function backend(handlers: Record<string, Handler>, me: () => Response = () => jsonResponse(userPrincipal)) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/agent/me")) return me();
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = Object.keys(handlers).find((name) => body.query.includes(`${name}(`));
    if (op === undefined) throw new Error(`unexpected request: ${body.query.slice(0, 80)}`);
    return jsonResponse(handlers[op]!(body));
  });
}

function signedIn(extra: Record<string, unknown> = {}) {
  return {
    token: ACCESS_TOKEN,
    refreshToken: "refresh-1",
    deviceLimitExceeded: false,
    activeDevice: null,
    organisationUser: { organisationID: "org-a", user: { id: "u1", firstName: "Pehla", lastName: "User", email: "pehla.user@roadcast.in" } },
    ...extra,
  };
}

function renderSignIn(from?: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/sign-in", state: from ? { from: { pathname: from } } : null }]}>
      <AuthProvider>
        <Routes>
          <Route path="/sign-in" element={<SignInRoute />} />
          <Route path="*" element={<p>landed</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("SignInRoute — Bolt account", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
    connect.connectWithBolt.mockReset();
  });

  it("signs in with email and password, straight to the password when there is one organisation", async () => {
    const fetchMock = backend({
      EmailOrMobileBasedOrganisations: () => ({
        data: { EmailOrMobileBasedOrganisations: [{ id: "org-a", name: "Acme Logistics", isActive: true }] },
      }),
      PasswordLogin: () => ({ data: { PasswordLogin: signedIn() } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn("/agents");
    // bolt-v2 stores email lower-case and matches it exactly.
    typeEmail("  Pehla.User@Roadcast.in ");

    expect(await screen.findByRole("heading", { name: "Enter your password" })).toBeInTheDocument();
    expect(screen.getByText("Acme Logistics")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("landed")).toBeInTheDocument();
    const session = getSession()!;
    expect(session).toMatchObject({
      kind: "user",
      credential: ACCESS_TOKEN,
      refreshToken: "refresh-1",
      via: "password",
      organisationId: "org-a",
      signedInOrganisation: { id: "org-a", name: "Acme Logistics" },
      user: { name: "Pehla User", email: "pehla.user@roadcast.in" },
      permissions: ["agent.chat.use"],
    });
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    const bodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/agent/me"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).variables);
    expect(bodies[0]).toMatchObject({ emailOrMobile: "pehla.user@roadcast.in" });
    expect(bodies[1]).toMatchObject({ email: "pehla.user@roadcast.in", password: "s3cret", organisationId: "org-a" });
    // Each browser is one device to bolt-v2, named so a person can tell it
    // apart in Settings › Security.
    expect(bodies[1].platformUniqueId).toEqual(expect.any(String));
    expect(bodies[1].platformFriendlyName).toMatch(/^Bolty console/);

    // The token is checked with agent-service before it is kept.
    const me = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/me"))!;
    expect((me[1] as RequestInit).headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
  });

  it("asks which organisation when the account belongs to several", async () => {
    vi.stubGlobal(
      "fetch",
      backend({
        EmailOrMobileBasedOrganisations: () => ({
          data: {
            EmailOrMobileBasedOrganisations: [
              { id: "org-b", name: "Zeta Freight", isActive: true },
              { id: "org-a", name: "Acme Logistics", isActive: true },
              { id: "org-x", name: "Closed Depot", isActive: false },
            ],
          },
        }),
        PasswordLogin: ({ variables }) => ({ data: { PasswordLogin: signedIn({ organisationUser: { organisationID: variables.organisationId } }) } }),
      }, () => jsonResponse({ ...userPrincipal, tenant_id: "org-b" })),
    );

    renderSignIn();
    typeEmail("pehla.user@roadcast.in");

    expect(await screen.findByRole("heading", { name: "Choose an organisation" })).toBeInTheDocument();
    // Only the active ones, sorted by name.
    const choices = screen.getAllByRole("button").filter((b) => /Freight|Logistics|Depot/.test(b.textContent ?? ""));
    expect(choices.map((b) => b.textContent)).toEqual([expect.stringContaining("Acme"), expect.stringContaining("Zeta")]);

    fireEvent.click(screen.getByRole("button", { name: /Zeta Freight/ }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(getSession()?.organisationId).toBe("org-b"));
  });

  it("explains an unknown account in plain words", async () => {
    vi.stubGlobal(
      "fetch",
      backend({ EmailOrMobileBasedOrganisations: () => ({ errors: [{ message: "user not found" }], data: null }) }),
    );

    renderSignIn();
    typeEmail("nobody@example.com");

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't find a Bolt account/i);
    expect(getSession()).toBeNull();
  });

  it("checks the email's shape before asking bolt-v2 anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    typeEmail("not-an-email");

    expect(await screen.findByRole("alert")).toHaveTextContent(/name@company.com/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says a wrong password is wrong, and lets the person try again", async () => {
    vi.stubGlobal(
      "fetch",
      backend({
        EmailOrMobileBasedOrganisations: () => ({
          data: { EmailOrMobileBasedOrganisations: [{ id: "org-a", name: "Acme", isActive: true }] },
        }),
        PasswordLogin: () => ({ errors: [{ message: "password invalid" }], data: null }),
      }),
    );

    renderSignIn();
    typeEmail("a@b.com");
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/password isn't right/i);
    expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled();
    expect(screen.getByLabelText("Password")).not.toBeDisabled();
  });

  it("offers the account's other devices to sign out at the device limit, then finishes signing in", async () => {
    let attempts = 0;
    const fetchMock = backend({
      EmailOrMobileBasedOrganisations: () => ({
        data: { EmailOrMobileBasedOrganisations: [{ id: "org-a", name: "Acme", isActive: true }] },
      }),
      PasswordLogin: () => {
        attempts += 1;
        return attempts === 1
          ? {
              data: {
                PasswordLogin: {
                  token: "pre-auth",
                  refreshToken: "",
                  deviceLimitExceeded: true,
                  activeDevice: [
                    { platformUniqueId: "dev-1", deviceName: "Chrome on Windows", loginTime: null, lastActiveAt: new Date().toISOString() },
                    { platformUniqueId: "dev-2", deviceName: "Android phone", loginTime: null, lastActiveAt: null },
                  ],
                },
              },
            }
          : { data: { PasswordLogin: signedIn() } };
      },
      LogoutDevice: () => ({ data: { LogoutDevice: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    typeEmail("a@b.com");
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: /too many devices/i })).toBeInTheDocument();
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Android phone")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[1]!);

    expect(await screen.findByText("landed")).toBeInTheDocument();
    const logout = fetchMock.mock.calls.find(([, init]) => String((init as RequestInit)?.body).includes("LogoutDevice"))!;
    const init = logout[1] as RequestInit;
    expect(JSON.parse(String(init.body)).variables).toEqual({ deviceId: "dev-2" });
    // Signed out with the pre-auth token bolt-v2 handed back for exactly this.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pre-auth");
    expect(getSession()?.credential).toBe(ACCESS_TOKEN);
  });

  it("signs in with a mobile number and a texted code", async () => {
    const fetchMock = backend({
      EmailOrMobileBasedOrganisations: () => ({
        data: { EmailOrMobileBasedOrganisations: [{ id: "org-a", name: "Acme", isActive: true }] },
      }),
      SendOtp: () => ({ data: { SendOtp: true } }),
      OtpLogin: () => ({ data: { OtpLogin: signedIn() } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSignIn();
    fireEvent.click(screen.getByRole("radio", { name: /mobile number/i }));
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "098765 43210" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(await screen.findByRole("button", { name: /text me a code/i }));
    expect(await screen.findByRole("heading", { name: /enter the code/i })).toBeInTheDocument();
    expect(screen.getByText("+91 ••••••3210")).toBeInTheDocument();

    // A paste fills every box, and the sixth digit submits by itself.
    fireEvent.paste(screen.getByLabelText("Digit 1"), { clipboardData: { getData: () => "123 456" } });

    expect(await screen.findByText("landed")).toBeInTheDocument();
    const bodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/agent/me"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).variables);
    // The leading 0 of a national number is dropped; bolt-v2 stores +<country><number>.
    expect(bodies[0]).toMatchObject({ emailOrMobile: "+919876543210" });
    expect(bodies[1]).toEqual({ mobileNumber: "+919876543210", organisationId: "org-a" });
    expect(bodies[2]).toMatchObject({ mobileNumber: "+919876543210", otp: "123456", organisationId: "org-a" });
    expect(getSession()?.via).toBe("code");
  });

  it("continues with the Bolt tab's sign-in, without a refresh token of its own", async () => {
    connect.connectWithBolt.mockResolvedValueOnce({ token: ACCESS_TOKEN });
    vi.stubGlobal("fetch", backend({}));

    renderSignIn();
    fireEvent.click(screen.getByRole("button", { name: /continue with bolt/i }));

    expect(await screen.findByText("landed")).toBeInTheDocument();
    expect(getSession()).toMatchObject({ kind: "user", credential: ACCESS_TOKEN, refreshToken: null, via: "bolt" });
  });

  it("says what happened when the Bolt window is closed", async () => {
    const { GatewayError } = await import("../ask/http/errors.ts");
    connect.connectWithBolt.mockRejectedValueOnce(
      new GatewayError("The Bolt window was closed before you finished signing in."),
    );

    renderSignIn();
    fireEvent.click(screen.getByRole("button", { name: /continue with bolt/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/window was closed/i);
    expect(screen.getByRole("button", { name: /continue with bolt/i })).not.toBeDisabled();
  });

  it("explains a return to sign-in after the session ended", () => {
    setSession({ kind: "user", credential: "t", user: { id: "1", email: "", name: "A" } });
    endSession("expired");

    renderSignIn();
    expect(screen.getByRole("status")).toHaveTextContent(/session ended/i);
  });

  it("goes straight through when a session already exists (signed in from another tab)", () => {
    setSession({ kind: "user", credential: "t", user: { id: "1", email: "", name: "A" } });
    renderSignIn("/agents");
    expect(screen.getByText("landed")).toBeInTheDocument();
  });
});

describe("SignInRoute — API key", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  function openKeyForm() {
    renderSignIn();
    fireEvent.click(screen.getByRole("button", { name: /use an api key/i }));
  }

  it("verifies the key against /agent/me and stores the session", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(keyPrincipal));

    openKeyForm();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "boltai_abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(getSession()).not.toBeNull());
    const session = getSession()!;
    expect(session.kind).toBe("apiKey");
    expect(session.credential).toBe("boltai_abc123");
    // The label, not a person — a key has nobody behind it.
    expect(session.user.name).toBe("bolt-v2 production");
    expect(session.organisationId).toBe(keyPrincipal.tenant_id);
    // Only the READABLE names are kept.
    expect(session.permissions).toEqual(["agent.chat.use"]);

    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
    expect(url).toContain("/agent/me");
    expect(init.headers.Authorization).toBe("Bearer boltai_abc123");
  });

  it("tolerates a key pasted with a Bearer prefix or stray whitespace", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(keyPrincipal));

    openKeyForm();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "  Bearer boltai_abc123  " } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(getSession()).not.toBeNull());
    expect(getSession()!.credential).toBe("boltai_abc123");
  });

  it("refuses to submit an empty field without a round trip", async () => {
    openKeyForm();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/paste an api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points at the service log when the key is refused, and stays usable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not authenticated" }, 401));

    openKeyForm();
    const field = screen.getByLabelText("API key");
    fireEvent.change(field, { target: { value: "boltai_wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/log names the exact reason/i);
    expect(getSession()).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" })).not.toBeDisabled();
    expect(field).not.toBeDisabled();
  });

  it("keeps the key off the screen and out of the password manager", () => {
    openKeyForm();
    const field = screen.getByLabelText("API key");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
  });
});

describe("mobile number helpers", () => {
  it("builds +<country><number>, dropping a national 0 and any spacing", () => {
    expect(toE164("91", "098765 43210")).toBe("+919876543210");
    expect(toE164("971", "50-123-4567")).toBe("+971501234567");
  });

  it("lets a number typed with its own + win over the country picker", () => {
    expect(toE164("91", "+84 912 345 678")).toBe("+84912345678");
  });

  it("refuses something too short to be a number", () => {
    expect(toE164("91", "123")).toBeNull();
  });

  it("masks all but the country and the last four digits", () => {
    expect(maskMobile("+919876543210")).toBe("+91 ••••••3210");
  });
});
