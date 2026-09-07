import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { AuditRoute } from "./AuditRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ENTRIES = [
  {
    id: 1,
    tenant_id: 7,
    actor_user_id: 42,
    entity_type: "channel_binding",
    entity_id: "4",
    action: "update",
    changed_fields: { is_active: false },
    created_at: "2026-08-20T10:00:00Z",
  },
  {
    id: 2,
    tenant_id: 7,
    actor_user_id: 43,
    entity_type: "mcp_server",
    entity_id: "9",
    action: "create",
    changed_fields: { name: "search" },
    created_at: "2026-08-21T11:00:00Z",
  },
];

function renderAudit() {
  return render(
    <MemoryRouter initialEntries={["/audit"]}>
      <AuditRoute />
    </MemoryRouter>,
  );
}

function mockReads(fetchMock: ReturnType<typeof vi.fn>, entries: unknown[] = ENTRIES) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.includes("/agent/audit") && request.method === "GET") {
      const url = new URL(request.url);
      const entityType = url.searchParams.get("entity_type");
      const filtered =
        entityType === null
          ? entries
          : (entries as Array<{ entity_type: string }>).filter((e) => e.entity_type === entityType);
      return Promise.resolve(jsonResponse(filtered));
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("AuditRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ token: "tok", user: { id: "1", email: "a@b.com", name: "A" }, expiresAt: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("renders who changed what, when — real rows, not placeholders", async () => {
    mockReads(fetchMock);

    renderAudit();

    await waitFor(() => expect(screen.getByText("channel_binding #4")).toBeInTheDocument());
    expect(screen.getByText("User #42")).toBeInTheDocument();
    expect(screen.getByText("update")).toBeInTheDocument();
    expect(screen.getByText("mcp_server #9")).toBeInTheDocument();
    expect(screen.getByText("User #43")).toBeInTheDocument();
    expect(screen.getByText("create")).toBeInTheDocument();
  });

  it("empty state explains what this screen is for, not 'No data'", async () => {
    mockReads(fetchMock, []);

    renderAudit();

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    // Phrasing unique to the empty state's own body — the page header
    // describes the screen too, so a bare /who changed what/i match would
    // be ambiguous between the two (both open with that phrase).
    expect(screen.getByText(/nothing has been written yet/i)).toBeInTheDocument();
  });

  it("filters by entity type through the real query parameter", async () => {
    mockReads(fetchMock);

    renderAudit();
    await waitFor(() => expect(screen.getByText("channel_binding #4")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/entity type/i), { target: { value: "channel_binding" } });

    await waitFor(() => {
      const filteredCall = fetchMock.mock.calls.find((call) =>
        (call[0] as Request).url.includes("entity_type=channel_binding"),
      );
      expect(filteredCall).toBeDefined();
    });

    await waitFor(() => expect(screen.queryByText("mcp_server #9")).not.toBeInTheDocument());
    expect(screen.getByText("channel_binding #4")).toBeInTheDocument();
  });

  it("a long changed-fields payload scrolls inside its own container, not the page", async () => {
    const bigPayload = { note: "x".repeat(500) };
    mockReads(fetchMock, [{ ...ENTRIES[0], changed_fields: bigPayload }]);

    renderAudit();

    await waitFor(() => expect(screen.getByTestId("audit-payload")).toBeInTheDocument());
    const box = screen.getByTestId("audit-payload");
    expect(within(box).getByText(/x{20,}/)).toBeInTheDocument();
  });
});
