import { afterEach, describe, expect, it, vi } from "vitest";
import { findOrganisations, friendlyMessage, passwordLogin } from "./boltv2.ts";

function graphql(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("bolt-v2 sign-in calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rewords bolt-v2's terse resolver errors, and passes others through as sentences", () => {
    expect(friendlyMessage("user not found")).toMatch(/couldn't find a Bolt account/);
    expect(friendlyMessage("password invalid")).toMatch(/password isn't right/);
    expect(friendlyMessage("otp is invalid or expired")).toMatch(/code isn't right/);
    expect(friendlyMessage("user is suspended. Please contact support")).toMatch(/switched off/);
    expect(friendlyMessage("organisation is suspended. Please contact support")).toMatch(/switched off/);
    expect(friendlyMessage("something new happened")).toBe("Something new happened.");
  });

  it("sends the console's own origin as webDomain, which bolt-v2 requires to be non-empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      graphql({ data: { EmailOrMobileBasedOrganisations: [{ id: "o", name: " Acme ", isActive: true }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(findOrganisations("a@b.com")).resolves.toEqual([{ id: "o", name: "Acme" }]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body)).variables.webDomain).toBe(window.location.origin);
    expect((init.headers as Record<string, string>)["X-Client"]).toBe("web");
  });

  it("reads a device limit reported as an error, Go-map devices and all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        graphql({
          data: null,
          errors: [
            {
              message:
                "device limit exceeded: [map[device_id:dev-1 device_name:Chrome on Windows login_time:2026-09-28T10:00:00Z last_active_at:2026-09-29T08:00:00Z]]",
            },
          ],
        }),
      ),
    );

    const result = await passwordLogin({ email: "a@b.com", password: "pw", organisationId: "o" });
    expect(result).toEqual({
      kind: "device-limit",
      devices: [
        {
          id: "dev-1",
          name: "Chrome on Windows",
          loginTime: "2026-09-28T10:00:00Z",
          lastActiveAt: "2026-09-29T08:00:00Z",
        },
      ],
      preAuthToken: null,
    });
  });

  it("says bolt-v2 could not be reached, as something worth retrying", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(findOrganisations("a@b.com")).rejects.toMatchObject({
      message: expect.stringMatching(/couldn't reach Bolt/i),
      retryable: true,
    });
  });
});
