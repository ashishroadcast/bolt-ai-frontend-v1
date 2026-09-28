import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { getSession, setSession } from "../auth/session.ts";
import { OrganisationPicker } from "./OrganisationPicker.tsx";

// Ask's run state lives in the chat provider, which the top bar cannot see;
// the picker reads it through useChat's module-level flag, stubbed here so a
// test can say "a run is in flight" without streaming one.
const askRun = vi.hoisted(() => ({ inFlight: false, unloadConfirmed: vi.fn() }));
vi.mock("../ask/chat/useChat.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ask/chat/useChat.ts")>()),
  isAskRunInFlight: () => askRun.inFlight,
  confirmUnloadDuringAskRun: askRun.unloadConfirmed,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `GET /agent/organisations`' shape — agent-service's, not bolt-v2's. The
 * console used to ask bolt-v2's `myOrganisations` with the user's own token;
 * it holds an API key now, which is not a bolt-v2 credential, so the question
 * moved to the service that had already resolved the same subtree.
 */
function organisationsResponse(
  rows: Array<{ id: string; name: string; parent?: string; current?: boolean }>,
) {
  return jsonResponse(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      parent_id: row.parent ?? null,
      current: row.current ?? false,
    })),
  );
}

function renderPicker() {
  return render(
    <AuthProvider>
      <OrganisationPicker />
    </AuthProvider>,
  );
}

const user = { id: "1", email: "a@b.com", name: "A" };

describe("OrganisationPicker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // jsdom's location.reload is not implemented; the picker calls it after a
    // switch because every screen on display is showing the old organisation.
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    setSession({ kind: "apiKey", credential: "boltai_test", user, organisationId: "root" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSession(null);
    askRun.inFlight = false;
    askRun.unloadConfirmed.mockClear();
  });

  it("renders nothing at all when signed out", () => {
    setSession(null);
    const { container } = renderPicker();
    expect(container).toBeEmptyDOMElement();
  });

  it("does not fetch anything until it is opened", () => {
    // A root key's subtree is over a thousand organisations. Spending that
    // round trip on every page load, for a control most sessions never
    // touch, is the reason this is lazy.
    renderPicker();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the tree on first open and labels each organisation by its path", async () => {
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([
        { id: "root", name: "Root", current: true },
        { id: "child", name: "Depot", parent: "root" },
      ]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button"));

    // Names repeat across a tree, so the path is what makes a choice possible.
    expect(await screen.findByText("Root › Depot")).toBeInTheDocument();
  });

  it("sends the session's credential as a bearer, and no Organisation header", async () => {
    fetchMock.mockResolvedValueOnce(organisationsResponse([{ id: "root", name: "Root" }]));

    renderPicker();
    fireEvent.click(screen.getByRole("button"));
    await screen.findByRole("option", { name: /Root/ });

    const [url, init] = fetchMock.mock.calls[0]! as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toContain("/agent/organisations");
    expect(init.headers.Authorization).toBe("Bearer boltai_test");
    // The list is the subtree of the organisation SIGNED IN to; naming the
    // current choice would narrow it and leave no way back up.
    expect(init.headers.Organisation).toBeUndefined();
  });

  it("reuses the loaded list instead of refetching on every open", async () => {
    fetchMock.mockResolvedValueOnce(organisationsResponse([{ id: "root", name: "Root" }]));

    renderPicker();
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    // By role, not by text: once the list is in hand the trigger's own label
    // is the current organisation's name too, so "Root" matches twice.
    await screen.findByRole("option", { name: /Root/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("switches the acting organisation, which is what the Organisation header carries", async () => {
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([
        { id: "root", name: "Root", current: true },
        { id: "child", name: "Depot", parent: "root" },
      ]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /organisation|root/i }));
    fireEvent.click(await screen.findByRole("option", { name: /Depot/ }));

    expect(getSession()?.organisationId).toBe("child");
    // The credential is untouched — switching is local, and agent-service
    // re-validates the header against the key's own subtree anyway.
    expect(getSession()?.credential).toBe("boltai_test");
    expect(reload).toHaveBeenCalled();
  });

  it("asks before switching while Ask is still writing an answer, and stays put on No", async () => {
    askRun.inFlight = true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([
        { id: "root", name: "Root", current: true },
        { id: "child", name: "Depot", parent: "root" },
      ]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /organisation|root/i }));
    fireEvent.click(await screen.findByRole("option", { name: /Depot/ }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toMatch(/still being written/);
    // Nothing changed: the bar and the data still agree.
    expect(getSession()?.organisationId).toBe("root");
    expect(reload).not.toHaveBeenCalled();
  });

  it("switches mid-run on Yes, without the browser asking a second time on the reload", async () => {
    askRun.inFlight = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([
        { id: "root", name: "Root", current: true },
        { id: "child", name: "Depot", parent: "root" },
      ]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /organisation|root/i }));
    fireEvent.click(await screen.findByRole("option", { name: /Depot/ }));

    expect(askRun.unloadConfirmed).toHaveBeenCalledOnce();
    expect(getSession()?.organisationId).toBe("child");
    expect(reload).toHaveBeenCalled();
  });

  it("does not ask when no run is in flight", async () => {
    const confirm = vi.spyOn(window, "confirm");
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([
        { id: "root", name: "Root", current: true },
        { id: "child", name: "Depot", parent: "root" },
      ]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /organisation|root/i }));
    fireEvent.click(await screen.findByRole("option", { name: /Depot/ }));

    expect(confirm).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("does not reload when the chosen organisation is already the current one", async () => {
    fetchMock.mockResolvedValueOnce(
      organisationsResponse([{ id: "root", name: "Root", current: true }]),
    );

    renderPicker();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(await screen.findByRole("option", { name: /Root/ }));

    expect(reload).not.toHaveBeenCalled();
  });

  it("reports a failure rather than rendering an empty picker", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not authenticated" }, 401));

    renderPicker();
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("401");
    });
  });
});
