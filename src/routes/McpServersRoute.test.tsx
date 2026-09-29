import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { McpServersRoute } from "./McpServersRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Real prose off `reporting-mcp/reporting_mcp/tools.py`'s own `rank_stores`
// ToolSpec — long enough, and specific enough, that a test asserting it is
// present proves the full description rendered rather than merely that
// *some* text near a tool's name did.
const RANK_STORES_DESCRIPTION =
  "Ranks stores over a date window by net sales, order count, or kilograms sold, best or " +
  "worst performers first, each row carrying its growth percentage against the preceding " +
  "equal-length window. Use this to answer 'which stores are our top/bottom performers'.";

const LIST_REPORTS_DESCRIPTION =
  "Lists every report the caller's tenant can run on the POS reporting service: each " +
  "entry's id, display name, description, UI group, and whether it needs a date range.";

const CANCEL_ORDER_DESCRIPTION =
  "Cancels an order that has not yet been dispatched, refunding any captured payment.";

const GET_ORDER_DESCRIPTION =
  "Looks up ONE order belonging to a specific customer and returns its full detail: " +
  "status, items, prices, taxes, discounts, payments, delivery info, and status timeline.";

const REPORTING_SERVER = {
  id: 1,
  name: "reporting",
  base_url: "http://127.0.0.1:8088/mcp",
  auth_type: "none",
  discovered_tools: [
    {
      name: "rank_stores",
      description: RANK_STORES_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { tenant_id: { type: "integer" }, store_id: { type: "integer" } },
      },
      readOnlyHint: true,
    },
    {
      name: "list_reports",
      description: LIST_REPORTS_DESCRIPTION,
      inputSchema: { type: "object", properties: { tenant_id: { type: "integer" } } },
      readOnlyHint: true,
    },
  ],
  code_mode_tools: [],
  last_discovery_at: "2026-08-20T10:00:00Z",
  is_active: true,
};

const ORDERS_SERVER = {
  id: 2,
  name: "orders",
  base_url: "http://127.0.0.1:8089/mcp",
  auth_type: "bearer",
  discovered_tools: [
    {
      name: "get_order",
      description: GET_ORDER_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { tenant_id: { type: "integer" }, store_id: { type: "integer" } },
      },
      readOnlyHint: true,
    },
    // Declared not read-only: the one case no operator approval can
    // override (§6.5), so its card must offer no control at all.
    {
      name: "cancel_order",
      description: CANCEL_ORDER_DESCRIPTION,
      inputSchema: { type: "object", properties: { tenant_id: { type: "integer" } } },
      readOnlyHint: false,
    },
  ],
  code_mode_tools: [],
  last_discovery_at: null,
  is_active: true,
};

const SERVERS = [REPORTING_SERVER, ORDERS_SERVER];

const AGENTS = [{ id: 5, name: "Front desk", description: null, is_active: true }];

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/mcp-servers"]}>
      <McpServersRoute />
    </MemoryRouter>,
  );
}

/** Same "read the method off the real Request object" shape
 * ChannelsRoute.test.tsx documents — GatewayClient.agentFetch always calls
 * fetch with a single already-built Request. `agentDetails` maps an agent
 * id to its `mcp_server_ids` — defaults to "Front desk" bound to the
 * reporting server (id 1), nothing bound to orders (id 2). */
function mockReads(
  fetchMock: ReturnType<typeof vi.fn>,
  options: {
    servers?: unknown[];
    agents?: unknown[];
    agentDetails?: Record<number, number[]>;
  } = {},
) {
  const servers = options.servers ?? SERVERS;
  const agents = options.agents ?? AGENTS;
  const agentDetails = options.agentDetails ?? { 5: [1] };

  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.endsWith("/agent/mcp-servers") && request.method === "GET") {
      return Promise.resolve(jsonResponse(servers));
    }
    if (request.url.endsWith("/agent/agents") && request.method === "GET") {
      return Promise.resolve(jsonResponse(agents));
    }
    const detailMatch = /\/agent\/agents\/(\d+)$/.exec(request.url);
    if (detailMatch && request.method === "GET") {
      const agentId = Number(detailMatch[1]);
      const agent = agents.find((a) => (a as { id: number }).id === agentId) as
        | { id: number; name: string }
        | undefined;
      return Promise.resolve(
        jsonResponse({
          id: agentId,
          name: agent?.name ?? `agent-${agentId}`,
          mcp_server_ids: agentDetails[agentId] ?? [],
        }),
      );
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("McpServersRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("renders a real server: base URL, auth type, and tool count", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    expect(screen.getByText("http://127.0.0.1:8088/mcp")).toBeInTheDocument();
    // Scoped to the card: both fixtures carry two tools now (orders gained
    // a deliberately not-read-only one), so an unscoped /2 tools/ would
    // match either card and prove nothing about this one.
    const card = screen.getByText("reporting").closest("section") as HTMLElement;
    expect(within(card).getByText(/2 tools/i)).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText(/bearer/i)).toBeInTheDocument();
  });

  // The list is an overview: a server's tools — the long part — are one
  // action away, so the screen can be scanned for what servers exist.
  it("keeps tool descriptions out of the list until View tools is pressed", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    // The overview is complete without them: name, URL, auth, count.
    const overviewCard = screen.getByText("reporting").closest("section") as HTMLElement;
    expect(within(overviewCard).getByText(/2 tools/i)).toBeInTheDocument();
    expect(screen.queryByText("rank_stores")).not.toBeInTheDocument();
    expect(screen.queryByText(RANK_STORES_DESCRIPTION)).not.toBeInTheDocument();

    const reportingCard = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(reportingCard).getByRole("button", { name: "View tools" }));

    // The whole sentence, verbatim — the detail view still never truncates
    // a description, which is the tool's own interface.
    expect(within(reportingCard).getByText(RANK_STORES_DESCRIPTION)).toBeInTheDocument();
    expect(within(reportingCard).getByText(LIST_REPORTS_DESCRIPTION)).toBeInTheDocument();
  });

  // Two servers' full tool descriptions on screen at once is the wall the
  // rebuild removed, so opening one has to close the other.
  it("opens one server's tools at a time", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());

    const reportingCard = screen.getByText("reporting").closest("section") as HTMLElement;
    const ordersCard = screen.getByText("orders").closest("section") as HTMLElement;

    fireEvent.click(within(reportingCard).getByRole("button", { name: "View tools" }));
    expect(within(reportingCard).getByText("rank_stores")).toBeInTheDocument();

    fireEvent.click(within(ordersCard).getByRole("button", { name: "View tools" }));
    expect(within(reportingCard).queryByText("rank_stores")).not.toBeInTheDocument();

    // And the action is a real toggle, not one-way.
    fireEvent.click(within(ordersCard).getByRole("button", { name: "Hide tools" }));
    expect(within(ordersCard).queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("shows which agents are bound to a server, and says when none are", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    // Server 1 (reporting) is bound to "Front desk" per agentDetails above.
    await waitFor(() => expect(screen.getByText(/Front desk/)).toBeInTheDocument());
    // Server 2 (orders) has no agent bound to it.
    expect(screen.getByText(/not bound to any agent/i)).toBeInTheDocument();
  });

  it("search narrows a server's tool list to matching names or descriptions", async () => {
    mockReads(fetchMock);

    renderRoute();

    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    const reportingCard = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(reportingCard).getByRole("button", { name: "View tools" }));

    expect(screen.getByText("rank_stores")).toBeInTheDocument();
    expect(screen.getByText("list_reports")).toBeInTheDocument();

    fireEvent.change(within(reportingCard).getByPlaceholderText(/search tools/i), {
      target: { value: "rank" },
    });

    expect(screen.getByText("rank_stores")).toBeInTheDocument();
    expect(screen.queryByText("list_reports")).not.toBeInTheDocument();
  });

  it("empty state explains what an MCP server is for and how to add one", async () => {
    mockReads(fetchMock, { servers: [] });

    renderRoute();

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    // Phrasing unique to the empty state's own body, not the page header
    // (which also mentions MCP servers) — same disambiguation
    // ChannelsRoute.test.tsx uses for its own empty-state assertion.
    expect(
      screen.getByText(/register one so an agent can call its tools/i),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /register a server/i }).length).toBeGreaterThan(0);
  });

  it("registering a server never leaves the bearer token in the DOM after submit", async () => {
    mockReads(fetchMock, { servers: [] });
    const secretToken = "sk-live-mcp-shh-do-not-log-me";

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/mcp-servers") && request.method === "GET") {
        return Promise.resolve(jsonResponse([]));
      }
      if (request.url.endsWith("/agent/agents") && request.method === "GET") {
        return Promise.resolve(jsonResponse([]));
      }
      if (request.url.endsWith("/agent/mcp-servers") && request.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: 3,
              name: "billing",
              base_url: "https://billing.example.com/mcp",
              auth_type: "bearer",
              discovered_tools: [],
              last_discovery_at: null,
              is_active: true,
            },
            201,
          ),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText(/register a server/i)).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: /register a server/i })[0]!);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "billing" } });
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://billing.example.com/mcp" },
    });
    fireEvent.change(screen.getByLabelText(/^auth type$/i), { target: { value: "bearer" } });
    fireEvent.change(screen.getByLabelText(/^token$/i), { target: { value: secretToken } });
    fireEvent.click(screen.getByRole("button", { name: /^register$/i }));

    // The credential was actually sent — otherwise this test would pass
    // trivially because nothing was ever rendered with it in the first place.
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => (call[0] as Request).method === "POST");
      expect(postCall).toBeDefined();
    });
    // agentFetch calls `fetch` with a single already-built Request (same
    // shape every other test file in this directory documents) — the body
    // is read off that Request, not a second `init` argument.
    const postRequest = fetchMock.mock.calls.find(
      (call) => (call[0] as Request).method === "POST",
    )![0] as Request;
    const sentBody = (await postRequest.clone().json()) as { auth_config: { token: string } };
    expect(sentBody.auth_config.token).toBe(secretToken);

    await waitFor(() => expect(screen.getByText("billing")).toBeInTheDocument());

    // Proof, not assumption: search the whole rendered DOM.
    expect(document.body.textContent).not.toContain(secretToken);
    expect(document.body.innerHTML).not.toContain(secretToken);
    // The field itself is gone (form closed) — nowhere left an old value
    // could be sitting in an unmounted-but-cached input either.
    expect(screen.queryByLabelText(/^token$/i)).not.toBeInTheDocument();
  });

  it("removing a server requires confirmation — one click sends no request", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());

    const ordersCard = screen.getByText("orders").closest("section") as HTMLElement;
    fireEvent.click(within(ordersCard).getByRole("button", { name: /^remove$/i }));

    expect(
      fetchMock.mock.calls.some((call) => (call[0] as Request).method === "DELETE"),
    ).toBe(false);
    // The confirm step is now showing, in place of a request having fired.
    expect(within(ordersCard).getByRole("button", { name: /confirm remove/i })).toBeInTheDocument();
  });

  it("removing a server bound to an agent shows the 409's own reason, not a generic failure", async () => {
    mockReads(fetchMock);
    const conflictMessage = "mcp server is bound to an agent; detach it from every agent first";

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/mcp-servers") && request.method === "GET") {
        return Promise.resolve(jsonResponse(SERVERS));
      }
      if (request.url.endsWith("/agent/agents") && request.method === "GET") {
        return Promise.resolve(jsonResponse(AGENTS));
      }
      if (/\/agent\/agents\/\d+$/.test(request.url) && request.method === "GET") {
        return Promise.resolve(jsonResponse({ id: 5, name: "Front desk", mcp_server_ids: [1] }));
      }
      if (request.url.endsWith("/agent/mcp-servers/1") && request.method === "DELETE") {
        return Promise.resolve(jsonResponse({ detail: conflictMessage }, 409));
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());

    const reportingCard = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(reportingCard).getByRole("button", { name: /^remove$/i }));
    fireEvent.click(within(reportingCard).getByRole("button", { name: /confirm remove/i }));

    await waitFor(() => {
      expect(within(reportingCard).getByText(new RegExp(conflictMessage))).toBeInTheDocument();
    });
    // Distinct from the generic fallback this same catch block would show
    // for an unparseable/network failure.
    expect(
      within(reportingCard).queryByText(/couldn't reach the agent service/i),
    ).not.toBeInTheDocument();
  });

  it("discovering re-queries a server and shows that (and when) it refreshed", async () => {
    mockReads(fetchMock);

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/mcp-servers") && request.method === "GET") {
        return Promise.resolve(jsonResponse(SERVERS));
      }
      if (request.url.endsWith("/agent/agents") && request.method === "GET") {
        return Promise.resolve(jsonResponse(AGENTS));
      }
      if (/\/agent\/agents\/\d+$/.test(request.url) && request.method === "GET") {
        return Promise.resolve(jsonResponse({ id: 5, name: "Front desk", mcp_server_ids: [1] }));
      }
      if (request.url.endsWith("/agent/mcp-servers/1/discover") && request.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            ...REPORTING_SERVER,
            discovered_tools: [
              ...REPORTING_SERVER.discovered_tools,
              {
                name: "get_dashboard_overview",
                description: "Headline network KPIs for a date window.",
                inputSchema: { type: "object", properties: {} },
                readOnlyHint: true,
              },
            ],
            last_discovery_at: "2026-08-28T12:00:00Z",
          }),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());

    const reportingCard = screen.getByText("reporting").closest("section") as HTMLElement;
    expect(within(reportingCard).getByText(/2 tools/i)).toBeInTheDocument();

    fireEvent.click(within(reportingCard).getByRole("button", { name: /^discover$/i }));

    await waitFor(() => {
      expect(within(reportingCard).getByText(/refreshed just now/i)).toBeInTheDocument();
    });
    fireEvent.click(within(reportingCard).getByRole("button", { name: "View tools" }));
    expect(within(reportingCard).getByText("get_dashboard_overview")).toBeInTheDocument();
    // "3 tools" now appears twice (the meta row's own count, and the
    // discover note explaining what changed) — proof both updated, not
    // just one string somewhere on the card.
    expect(within(reportingCard).getAllByText(/3 tools/i).length).toBe(2);
    expect(within(reportingCard).getByText(/refreshed just now/i)).toBeInTheDocument();
  });

  // --- the code-mode allow-list ------------------------------------------
  //
  // `code_mode_tools` had no HTTP surface at all until this endpoint
  // landed: the column could be stored and neither read nor set, so this
  // panel carried a sentence naming the gap where a control belongs.

  it("a tool the server declares writes offers no allow-list control", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    const ordersCard = screen.getByText("orders").closest("section") as HTMLElement;
    fireEvent.click(within(ordersCard).getByRole("button", { name: "View tools" }));

    const cancelCard = within(ordersCard).getByText("cancel_order").closest("article") as HTMLElement;
    expect(within(cancelCard).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(ordersCard).getByText(/declares the tool writes/i)).toBeInTheDocument();
    // The read-only sibling on the same card still gets one.
    const getOrderCard = within(ordersCard).getByText("get_order").closest("article") as HTMLElement;
    expect(within(getOrderCard).getByRole("checkbox")).toBeInTheDocument();
  });

  it("approving a tool sends the whole list with the chosen scope arguments", async () => {
    mockReads(fetchMock);
    const base = fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
    ) => Promise<Response>;
    const sent: unknown[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/mcp-servers/1") && request.method === "PATCH") {
        const body = (await request.json()) as { code_mode_tools: unknown[] };
        sent.push(body.code_mode_tools);
        return jsonResponse({
          ...REPORTING_SERVER,
          code_mode_tools: [
            {
              name: "rank_stores",
              tenant_field: "tenant_id",
              store_field: "store_id",
              approved_by: 1,
              approved_at: "2026-08-28T12:00:00Z",
              schema: REPORTING_SERVER.discovered_tools[0]!.inputSchema,
            },
          ],
        });
      }
      return base(input);
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    const card = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "View tools" }));

    // Nothing to save until the draft actually differs from what is stored.
    expect(within(card).getByRole("button", { name: /save allow-list/i })).toBeDisabled();

    const rankCard = within(card).getByText("rank_stores").closest("article") as HTMLElement;
    fireEvent.click(within(rankCard).getByRole("checkbox"));
    fireEvent.change(within(rankCard).getByLabelText(/store argument/i), {
      target: { value: "store_id" },
    });
    fireEvent.click(within(card).getByRole("button", { name: /save allow-list/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      { name: "rank_stores", tenant_field: "tenant_id", store_field: "store_id" },
    ]);
    await waitFor(() =>
      expect(within(card).getByText(/saved — 1 tool allow-listed/i)).toBeInTheDocument(),
    );
  });

  it("a rejected entry shows the server's own reason and leaves the row alone", async () => {
    mockReads(fetchMock);
    const base = fetchMock.getMockImplementation() as (
      input: RequestInfo | URL,
    ) => Promise<Response>;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/mcp-servers/1") && request.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({ detail: "'rank_stores': tenant_field 'store_id' is not a declared argument" }, 400),
        );
      }
      return base(input);
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    const card = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "View tools" }));
    const rankCard = within(card).getByText("rank_stores").closest("article") as HTMLElement;
    fireEvent.click(within(rankCard).getByRole("checkbox"));
    fireEvent.click(within(card).getByRole("button", { name: /save allow-list/i }));

    await waitFor(() =>
      expect(within(card).getByText(/is not a declared argument/i)).toBeInTheDocument(),
    );
    expect(within(card).getByText(/1 tool allow-listed of 2 discovered/i)).toBeInTheDocument();
  });

  it("reopening the panel abandons an unsaved draft", async () => {
    mockReads(fetchMock);

    renderRoute();
    await waitFor(() => expect(screen.getByText("reporting")).toBeInTheDocument());
    const card = screen.getByText("reporting").closest("section") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "View tools" }));
    const rankCard = within(card).getByText("rank_stores").closest("article") as HTMLElement;
    fireEvent.click(within(rankCard).getByRole("checkbox"));
    expect(within(card).getByRole("button", { name: /save allow-list/i })).toBeEnabled();

    fireEvent.click(within(card).getByRole("button", { name: "Hide tools" }));
    fireEvent.click(within(card).getByRole("button", { name: "View tools" }));

    const reopened = within(card).getByText("rank_stores").closest("article") as HTMLElement;
    expect(within(reopened).getByRole("checkbox")).not.toBeChecked();
    expect(within(card).getByRole("button", { name: /save allow-list/i })).toBeDisabled();
  });

  // The field rules formAffordance.test.ts used to read off this screen's
  // .module.css, asserted on the markup now that every field is shadcn's
  // own Input or NativeSelect — every auth type's credential fields
  // included. The theme half (that --input is darker than the row
  // hairline) stays in formAffordance.test.ts.
  it("gives every register-form field a visible edge, its own focus mark and a distinct disabled look", async () => {
    mockReads(fetchMock, { servers: [] });

    renderRoute();
    await waitFor(() => expect(screen.getByText(/register a server/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /register a server/i })[0]!);

    const form = screen.getByLabelText(/^name$/i).closest("form") as HTMLFormElement;
    const seen = new Set<string>();
    for (const authType of ["none", "bearer", "api_key", "oauth2_cc"]) {
      fireEvent.change(screen.getByLabelText(/^auth type$/i), { target: { value: authType } });
      for (const control of Array.from(form.querySelectorAll("input, select, textarea"))) {
        seen.add(control.getAttribute("type") ?? control.tagName.toLowerCase());
        const slot = control.getAttribute("data-slot");
        expect(["input", "native-select"]).toContain(slot);
        expect(control.className).toMatch(/(^|\s)border-input(\s|$)/);
        expect(control.className).toMatch(/focus-visible:border-ring/);
        // A select's disabled fade sits on NativeSelect's wrapper.
        const disabledLook = slot === "input" ? control.className : control.parentElement!.className;
        expect(disabledLook).toMatch(/disabled\]?:opacity-50/);
      }
    }
    expect([...seen]).toEqual(expect.arrayContaining(["text", "password", "select"]));
  });

  it("the credential field set changes with the chosen auth type", async () => {
    mockReads(fetchMock, { servers: [] });

    renderRoute();
    await waitFor(() => expect(screen.getByText(/register a server/i)).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /register a server/i })[0]!);

    expect(screen.queryByLabelText(/^token$/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^auth type$/i), { target: { value: "bearer" } });
    expect(screen.getByLabelText(/^token$/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^auth type$/i), { target: { value: "api_key" } });
    expect(screen.queryByLabelText(/^token$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/header name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^key$/i)).toBeInTheDocument();
  });
});
