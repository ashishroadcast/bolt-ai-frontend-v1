import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { installRadixPolyfills } from "../test/radix.ts";
import { DatabasesRoute } from "./DatabasesRoute.tsx";
import type { DataSource } from "./datasourcesApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function datasource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: 1,
    name: "Warehouse",
    type: "postgres",
    database_name: "reporting",
    isolation_mode: "connection",
    tenant_column: null,
    key_patterns: null,
    table_patterns: null,
    redis_cluster: false,
    redis_address_map: null,
    allowed_key_ids: null,
    sample_values_enabled: true,
    schema_mode: "unscanned",
    status: "created",
    total_tables: 0,
    total_columns: 0,
    is_active: true,
    last_scan_error: null,
    ...overrides,
  };
}

/** Routes a mocked Request to a canned response by method + pathname, so
 * each test only has to describe the handful of calls it actually cares
 * about instead of relying on call ordering. */
function routeFetch(handlers: Record<string, (request: Request) => Response | Promise<Response>>) {
  return vi.fn(async (input: Request) => {
    const request = input;
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unhandled request: ${key}`);
    return handler(request);
  });
}

function renderDatabasesRoute() {
  return render(<DatabasesRoute />);
}

describe("DatabasesRoute", () => {
  beforeEach(() => {
    // The connect form's and the table picker's checkboxes are Radix
    // Checkboxes, which measure themselves with ResizeObserver.
    installRadixPolyfills();
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("invites connecting a database when none exist yet", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ "GET /agent/datasources": () => jsonResponse([]) }),
    );
    renderDatabasesRoute();

    expect(await screen.findByRole("button", { name: /connect a database/i })).toBeInTheDocument();
  });

  it("lists existing databases, excluding knowledge-type corpora", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () =>
          jsonResponse([
            datasource({ id: 1, name: "Warehouse" }),
            datasource({ id: 2, name: "Docs corpus", type: "knowledge", database_name: "Docs corpus" }),
          ]),
      }),
    );
    renderDatabasesRoute();

    expect(await screen.findByText("Warehouse")).toBeInTheDocument();
    expect(screen.queryByText("Docs corpus")).not.toBeInTheDocument();
  });

  /* This screen used to draw its own page header. It uses the shared
     `PageHeader` now, so this pins what that swap had to keep: the same
     breadcrumb and title as every other screen, and an action that steps
     out of the way while the form it opens is on screen. */
  it("carries the shared page header, whose action yields to the form it opens", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ "GET /agent/datasources": () => jsonResponse([datasource({ id: 1 })]) }),
    );
    renderDatabasesRoute();

    expect(await screen.findByRole("heading", { name: "Databases" })).toBeInTheDocument();
    expect(screen.getByText("Connections")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect a database" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Connect a database" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("connects a database and leaves the DSN with no trace once it succeeds", async () => {
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources": async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          name: "Warehouse",
          type: "postgres",
          database_name: "reporting",
          dsn: "postgres://u:s3cr3t-pass@host/db",
          isolation_mode: "connection",
        });
        return jsonResponse(datasource({ id: 9, name: "Warehouse" }), 201);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    fireEvent.click(await screen.findByRole("button", { name: /connect a database/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Warehouse" } });
    fireEvent.change(screen.getByLabelText(/database name/i), { target: { value: "reporting" } });
    fireEvent.change(screen.getByLabelText(/connection string/i), {
      target: { value: "postgres://u:s3cr3t-pass@host/db" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(screen.getByText("Warehouse")).toBeInTheDocument());

    // The form (and its DSN field) is gone entirely, not merely cleared —
    // an unmounted field can't be read back out of the DOM.
    expect(screen.queryByLabelText(/connection string/i)).not.toBeInTheDocument();
    // The credential never appears anywhere in the rendered page, e.g. in
    // a "just connected" summary that echoed it back.
    expect(document.body.textContent).not.toContain("s3cr3t-pass");
  });

  it("surfaces two distinct classified test-connection failures", async () => {
    const rows = [datasource({ id: 1, name: "Reachable-but-wrong-user" }), datasource({ id: 2, name: "Unreachable" })];
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse(rows),
        "POST /agent/datasources/1/test": () =>
          jsonResponse({ success: false, reason: "authentication rejected: password authentication failed" }),
        "POST /agent/datasources/2/test": () =>
          jsonResponse({ success: false, reason: "could not reach host: [Errno 61] Connection refused" }),
      }),
    );
    renderDatabasesRoute();
    await screen.findByText("Reachable-but-wrong-user");

    const row1 = screen.getByText("Reachable-but-wrong-user").closest("tr")!;
    const row2 = screen.getByText("Unreachable").closest("tr")!;
    fireEvent.click(within(row1).getByRole("button", { name: /test connection/i }));
    fireEvent.click(within(row2).getByRole("button", { name: /test connection/i }));

    await within(row1).findByText(/authentication rejected: password authentication failed/i);
    await within(row2).findByText(/could not reach host: \[Errno 61\] Connection refused/i);
  });

  it("shows a successful test connection distinctly from a failure", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([datasource({ id: 1, name: "Warehouse" })]),
        "POST /agent/datasources/1/test": () => jsonResponse({ success: true, reason: null }),
      }),
    );
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /test connection/i }));

    await within(row).findByText(/connected/i);
  });

  it("removes a database on delete", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([datasource({ id: 1, name: "Warehouse" })]),
        "DELETE /agent/datasources/1": () => jsonResponse(null, 204),
      }),
    );
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(screen.queryByText("Warehouse")).not.toBeInTheDocument());
  });

  it("renders a 409 delete conflict as an explanation, and keeps the row", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([datasource({ id: 1, name: "Warehouse" })]),
        "DELETE /agent/datasources/1": () =>
          jsonResponse({ detail: "datasource has scanned tables or documents; remove them first" }, 409),
      }),
    );
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));

    await within(row).findByText(/scanned tables or documents; remove them first/i);
    // Not removed — the conflict means it's still there, and the row
    // itself said so.
    expect(screen.getByText("Warehouse")).toBeInTheDocument();
  });

  it("requires a tenant column before submitting a column-isolated connection, without calling the server", async () => {
    const fetchMock = routeFetch({ "GET /agent/datasources": () => jsonResponse([]) });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    fireEvent.click(await screen.findByRole("button", { name: /connect a database/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Warehouse" } });
    fireEvent.change(screen.getByLabelText(/database name/i), { target: { value: "reporting" } });
    fireEvent.change(screen.getByLabelText(/connection string/i), { target: { value: "postgres://x" } });
    fireEvent.change(screen.getByLabelText(/tenant scoping/i), { target: { value: "column" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/tenant column/i);
    const methodsCalled = fetchMock.mock.calls.map(([request]: [Request]) => request.method);
    expect(methodsCalled).not.toContain("POST");
  });

  // --- form-level "Test connection" ---------------------------------------

  async function openFormAndFillConnection(dsn: string) {
    fireEvent.click(await screen.findByRole("button", { name: /connect a database/i }));
    fireEvent.change(screen.getByLabelText(/database name/i), { target: { value: "reporting" } });
    fireEvent.change(screen.getByLabelText(/connection string/i), { target: { value: dsn } });
  }

  it("tests the form's own fields and renders the server's specific reason, not a generic one", async () => {
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources/test": async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toEqual({
          type: "postgres",
          database_name: "reporting",
          dsn: "postgres://u:s3cr3t-pass@host/db",
        });
        return jsonResponse({
          success: false,
          reason: "authentication rejected: password authentication failed",
        });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    await openFormAndFillConnection("postgres://u:s3cr3t-pass@host/db");
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    await screen.findByText(/authentication rejected: password authentication failed/i);
    // Not the generic fallback errorMessage() falls back to for a non-
    // AgentApiError — a deleted _classify_connection_error call on the
    // server, or a component that swallowed `result.reason` in favour of a
    // fixed string, would both still show *something*, just not this.
    expect(screen.queryByText(/couldn't reach the gateway/i)).not.toBeInTheDocument();
  });

  it("clicking the form's Test connection sends no create request", async () => {
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources/test": () => jsonResponse({ success: true, reason: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    await openFormAndFillConnection("postgres://u:s3cr3t-pass@host/db");
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    await screen.findByText(/connected/i);

    // The mount-time GET to this same path is expected — createDatasource
    // is what must never have been called, i.e. no POST to it.
    const posts = fetchMock.mock.calls
      .map(([request]: [Request]) => request)
      .filter((request: Request) => request.method === "POST")
      .map((request: Request) => new URL(request.url).pathname);
    expect(posts).not.toContain("/agent/datasources");
  });

  it("leaves the DSN out of the DOM after a form test connection, success or failure", async () => {
    const secretDsn = "postgres://u:s3cr3t-pass@host/db";
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources/test": () =>
        jsonResponse({ success: false, reason: "could not reach host: [Errno 61] Connection refused" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    await openFormAndFillConnection(secretDsn);
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    await screen.findByText(/could not reach host/i);

    // The server's own reason is rendered, but the raw DSN the operator
    // typed never leaks into it, and the masked input never exposes its
    // value as text content either way.
    expect(document.body.textContent).not.toContain("s3cr3t-pass");
  });

  it("shows a successful form test connection distinctly, without saving", async () => {
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources/test": () => jsonResponse({ success: true, reason: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    await openFormAndFillConnection("postgres://u:s3cr3t-pass@host/db");
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    await screen.findByText(/^connected\.$/i);
    // The form is still open and usable — Test connection never saves.
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeInTheDocument();
  });

  it("says Testing… and disables the button while a form test connection is in flight", async () => {
    let resolveTest!: (response: Response) => void;
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources/test": () => new Promise<Response>((resolve) => (resolveTest = resolve)),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    await openFormAndFillConnection("postgres://u:s3cr3t-pass@host/db");
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    const button = await screen.findByRole("button", { name: /testing…/i });
    expect(button).toBeDisabled();

    resolveTest(jsonResponse({ success: true, reason: null }));
    await screen.findByText(/^connected\.$/i);
  });

  it("requires a connection string before testing, without calling the server", async () => {
    const fetchMock = routeFetch({ "GET /agent/datasources": () => jsonResponse([]) });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();

    fireEvent.click(await screen.findByRole("button", { name: /connect a database/i }));
    fireEvent.click(screen.getByRole("button", { name: /^test connection$/i }));

    await screen.findByText(/connection string is required/i);
    const methodsCalled = fetchMock.mock.calls.map(([request]: [Request]) => request.method);
    expect(methodsCalled).not.toContain("POST");
  });

  // --- autocomplete: the browser must not read this as a login form ------

  it("marks every form field as autoComplete=off, so a saved login is never offered into it", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /agent/datasources": () => jsonResponse([]) }));
    renderDatabasesRoute();

    fireEvent.click(await screen.findByRole("button", { name: /connect a database/i }));

    expect(screen.getByLabelText(/^name$/i)).toHaveAttribute("autocomplete", "off");
    expect(screen.getByLabelText(/database name/i)).toHaveAttribute("autocomplete", "off");
    const dsnInput = screen.getByLabelText(/connection string/i);
    expect(dsnInput).toHaveAttribute("autocomplete", "off");
    // The DSN field in particular must never be offered to a password
    // manager for saving — still masked (type=password) for shoulder-
    // surfing, but "off" rather than a token like "new-password" that
    // would invite a save-this-password prompt.
    expect(dsnInput).toHaveAttribute("type", "password");
  });

  // --- scan --------------------------------------------------------------

  it("scanning a database dispatches the scan request and shows it indexing immediately", async () => {
    const rows = [datasource({ id: 1, status: "created", total_tables: 0, total_columns: 0 })];
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse(rows),
      "POST /agent/datasources/1/scan": () =>
        jsonResponse(datasource({ id: 1, status: "indexing", total_tables: 0, total_columns: 0 }), 202),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: /^scan$/i }));

    await within(row).findByText("indexing");
  });

  it("polls until a background scan finishes and shows the resulting table/column counts", async () => {
    // shouldAdvanceTime: real wall-clock time keeps passing alongside the
    // fake clock, so Testing Library's own internal setTimeout-based
    // findBy*/waitFor polling keeps working — only the explicit
    // advanceTimersByTimeAsync call below fast-forwards the poll interval.
    // Plain useFakeTimers() here hangs both this test and (via a leaked
    // timer state) whichever test runs after it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const rows = [datasource({ id: 1, status: "created", total_tables: 0, total_columns: 0 })];
      let finished = false;
      const fetchMock = routeFetch({
        "GET /agent/datasources": () =>
          jsonResponse(
            finished
              ? [datasource({ id: 1, status: "ready", total_tables: 6, total_columns: 41 })]
              : rows,
          ),
        "POST /agent/datasources/1/scan": () => {
          finished = true;
          return jsonResponse(
            datasource({ id: 1, status: "indexing", total_tables: 0, total_columns: 0 }),
            202,
          );
        },
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<DatabasesRoute />);
      const row = (await screen.findByText("Warehouse")).closest("tr")!;

      fireEvent.click(within(row).getByRole("button", { name: /^scan$/i }));
      await within(row).findByText("indexing");

      await vi.advanceTimersByTimeAsync(3000);

      await within(row).findByText("ready");
      expect(within(row).getByText("6")).toBeInTheDocument();
      expect(within(row).getByText("41")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a failed scan's own reason on the row, distinct from a generic failure", async () => {
    const rows = [
      datasource({
        id: 1,
        status: "error",
        last_scan_error: "could not reach host: [Errno 61] Connection refused",
      }),
    ];
    vi.stubGlobal(
      "fetch",
      routeFetch({ "GET /agent/datasources": () => jsonResponse(rows) }),
    );
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    await within(row).findByText(/could not reach host: \[Errno 61\] Connection refused/i);
  });

  // --- choose tables ------------------------------------------------------------
  // A database over the scan bounds can never be scanned to find out what it
  // holds, so the picker reads the live catalog and writes table_patterns.

  const CATALOG = {
    tables: [
      { table: "devices", columns: 29 },
      { table: "sessions", columns: 22 },
      { table: "trip_halt_points", columns: 20 },
      { table: "trips", columns: 49 },
    ],
    max_tables: 100,
    max_columns: 1000,
  };

  function pickerFetch(rows: DataSource[], catalog: unknown = CATALOG) {
    const patches: unknown[] = [];
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse(rows),
      "GET /agent/datasources/1/catalog": () => jsonResponse(catalog),
      "PATCH /agent/datasources/1": async (request) => {
        const body = (await request.json()) as { table_patterns: string[] | null };
        patches.push(body);
        return jsonResponse({ ...rows[0], table_patterns: body.table_patterns });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    return patches;
  }

  it("saves the ticked tables as the datasource's table patterns", async () => {
    const patches = pickerFetch([datasource()]);
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: "Choose tables" }));
    await screen.findByText("devices");
    // Every table is ticked to start with: none were chosen, and all four fit.
    expect(screen.getByRole("status")).toHaveTextContent("4 of 100 tables · 120 of 1000 columns");

    fireEvent.click(screen.getByRole("button", { name: "Untick all" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^devices/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^trips/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save 2 tables" }));

    await screen.findByText(/Saved. Run Scan/);
    expect(patches).toEqual([{ table_patterns: ["devices", "trips"] }]);
    expect(within(row).getByText("Scans 2 chosen tables")).toBeInTheDocument();
  });

  it("pre-ticks what the current patterns match, globs included", async () => {
    pickerFetch([datasource({ table_patterns: ["trip*"] })]);
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: "Choose tables" }));
    await screen.findByText("devices");

    expect(screen.getByRole("checkbox", { name: /^trips/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^trip_halt_points/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^devices/ })).not.toBeChecked();
    expect(screen.getByText(/replaces the patterns trip\*/)).toBeInTheDocument();
  });

  it("will not save a selection the scan would refuse", async () => {
    pickerFetch([datasource()], { ...CATALOG, max_tables: 1 });
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: "Choose tables" }));
    await screen.findByText("devices");
    // Four tables over a one-table bound: nothing is pre-ticked...
    expect(screen.getByRole("status")).toHaveTextContent("0 of 1 tables");
    // ...and ticking two puts it over, which disables Save.
    fireEvent.click(screen.getByRole("checkbox", { name: /^devices/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^trips/ }));

    expect(screen.getByRole("status")).toHaveTextContent("over the scan limit");
    expect(screen.getByRole("button", { name: "Save 2 tables" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Scan every table" })).toBeDisabled();
  });

  it("offers the picker straight from a scan refused for size", async () => {
    pickerFetch([
      datasource({
        status: "error",
        last_scan_error:
          "datasource has 255 tables and 3691 columns, over the 100-table / 1000-column scan limit",
      }),
    ]);
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: "Choose which tables to scan" }));

    expect(await screen.findByText("devices")).toBeInTheDocument();
  });

  it("offers no table picker for a Redis datasource", async () => {
    pickerFetch([datasource({ type: "redis", key_patterns: ["device:*"] })]);
    renderDatabasesRoute();
    const row = (await screen.findByText("Warehouse")).closest("tr")!;

    expect(within(row).queryByRole("button", { name: "Choose tables" })).not.toBeInTheDocument();
  });
});
