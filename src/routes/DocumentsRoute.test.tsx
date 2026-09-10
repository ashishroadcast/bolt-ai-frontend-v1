import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { DocumentsRoute } from "./DocumentsRoute.tsx";
import type { DataSource } from "./datasourcesApi.ts";
import type { DocumentRecord, TagTree } from "./documentsApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function corpus(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: 5,
    name: "Documents",
    type: "knowledge",
    database_name: "Documents",
    isolation_mode: "connection",
    tenant_column: null,
    key_patterns: null,
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

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 1,
    datasource_id: 5,
    filename: "menu.pdf",
    content_type: "application/pdf",
    size_bytes: 2048,
    status: "pending",
    page_count: null,
    figure_count: null,
    chunk_count: null,
    vision_cost_usd: 0,
    error: null,
    created_at: "2026-08-27T10:00:00Z",
    tags: [],
    required_permission: null,
    ...overrides,
  };
}

/** What a handler gets to inspect a mocked call — deliberately not a real
 * `Request`. `agentFetch` passes one `Request` argument; `uploadDocument`
 * (documentsApi.ts's own deliberate exception — see its docstring) passes
 * a `(url, init)` pair with a `FormData` body because it has to build that
 * body outside GatewayClient. Re-wrapping that pair into `new Request(url,
 * init)` to get a uniform `.formData()` sounds tidy but doesn't work here:
 * jsdom's `File` (what `makeFile` below constructs, in this test
 * environment) fails Node's native `fetch`/`Request`'s internal webidl
 * "is this a File" brand check, since that check is against Node's own
 * `File`, not jsdom's — so parsing a `FormData` back out of a
 * freshly-built `Request` throws even though the original `FormData` is
 * perfectly valid. Reading it directly off `init.body`, as done below,
 * never goes through that re-serialization at all. */
interface FetchCtx {
  method: string;
  url: string;
  headers: Headers;
  json: () => Promise<unknown>;
  formData: () => Promise<FormData>;
}

function tagTree(overrides: Partial<TagTree> = {}): TagTree {
  return { nodes: [], untagged_count: 0, total_count: 0, ...overrides };
}

function routeFetch(handlers: Record<string, (ctx: FetchCtx) => Response | Promise<Response>>) {
  // Every render of this screen fetches the classification tree alongside
  // the document list, so a test that does not care about the tree still
  // has to answer that call — an empty tree is the default, overridable
  // per test.
  const routes: Record<string, (ctx: FetchCtx) => Response | Promise<Response>> = {
    "GET /agent/documents/tags": () => jsonResponse(tagTree()),
    ...handlers,
  };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let method: string;
    let url: string;
    let headers: Headers;
    let json: () => Promise<unknown>;
    let formData: () => Promise<FormData>;

    if (input instanceof Request) {
      method = input.method;
      url = input.url;
      headers = input.headers;
      json = () => input.json();
      formData = () => input.formData();
    } else {
      url = String(input);
      method = init?.method ?? "GET";
      headers = new Headers(init?.headers);
      const rawBody = init?.body;
      json = async () => (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody);
      formData = async () => {
        if (!(rawBody instanceof FormData)) throw new Error("request body is not FormData");
        return rawBody;
      };
    }

    const key = `${method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unhandled request: ${key}`);
    return handler({ method, url, headers, json, formData });
  });
}

function makeFile(name: string, sizeBytes: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

function renderDocumentsRoute() {
  return render(<DocumentsRoute />);
}

describe("DocumentsRoute", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("invites adding a document when there is no library yet", async () => {
    vi.stubGlobal("fetch", routeFetch({ "GET /agent/datasources": () => jsonResponse([]) }));
    renderDocumentsRoute();

    expect(await screen.findByRole("button", { name: /add a document/i })).toBeInTheDocument();
  });

  it("refuses an oversized file, naming the 50 MiB limit, without calling the server", async () => {
    const fetchMock = routeFetch({ "GET /agent/datasources": () => jsonResponse([]) });
    vi.stubGlobal("fetch", fetchMock);
    renderDocumentsRoute();

    const input = await screen.findByLabelText(/add a document/i);
    fireEvent.change(input, { target: { files: [makeFile("huge.pdf", 60 * 1024 * 1024)] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/50 ?MiB/i);
    const methods = fetchMock.mock.calls.map(([input, init]: [RequestInfo | URL, RequestInit?]) =>
      input instanceof Request ? input.method : (init?.method ?? "GET"),
    );
    expect(methods).not.toContain("POST");
  });

  it("refuses an unsupported file type, naming the accepted types, without calling the server", async () => {
    const fetchMock = routeFetch({ "GET /agent/datasources": () => jsonResponse([]) });
    vi.stubGlobal("fetch", fetchMock);
    renderDocumentsRoute();

    const input = await screen.findByLabelText(/add a document/i);
    fireEvent.change(input, { target: { files: [makeFile("menu.exe", 1024)] } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/\.pdf/i);
    const methods = fetchMock.mock.calls.map(([input, init]: [RequestInfo | URL, RequestInit?]) =>
      input instanceof Request ? input.method : (init?.method ?? "GET"),
    );
    expect(methods).not.toContain("POST");
  });

  it("creates the library on first upload and shows the new document as processing", async () => {
    const created = corpus();
    // GET /agent/documents is a stateful stand-in for the server here — it
    // must reflect the upload once it lands, or the component's own
    // refetch-after-mutation (DocumentsRoute.tsx's own docstring: id-keyed
    // local patches go stale after a reingest, so every mutation
    // refetches) would just read back nothing and this test would be
    // exercising a mock that can't observe writes, not the component.
    let documentsStore: DocumentRecord[] = [];
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([]),
      "POST /agent/datasources": async (ctx) => {
        const body = (await ctx.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ type: "knowledge" });
        expect(body.dsn).toBeUndefined();
        return jsonResponse(created, 201);
      },
      "POST /agent/documents": async (ctx) => {
        const form = await ctx.formData();
        expect(form.get("datasource_id")).toBe("5");
        expect((form.get("file") as File).name).toBe("menu.pdf");
        const newDoc = doc({ id: 42, status: "pending" });
        documentsStore = [newDoc];
        return jsonResponse(newDoc, 201);
      },
      "GET /agent/documents": () => jsonResponse(documentsStore),
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDocumentsRoute();

    const input = await screen.findByLabelText(/add a document/i);
    fireEvent.change(input, { target: { files: [makeFile("menu.pdf", 1024)] } });

    await screen.findByText("menu.pdf");
    expect(screen.getByText(/processing/i)).toBeInTheDocument();
  });

  it("distinguishes working, ready and failed documents", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([
            doc({ id: 1, filename: "still-going.pdf", status: "describing" }),
            doc({ id: 2, filename: "finished.pdf", status: "ready", chunk_count: 12 }),
            doc({ id: 3, filename: "broke.pdf", status: "failed", error: "could not parse page 4" }),
          ]),
      }),
    );
    renderDocumentsRoute();

    const workingRow = (await screen.findByText("still-going.pdf")).closest("tr")!;
    const readyRow = screen.getByText("finished.pdf").closest("tr")!;
    const failedRow = screen.getByText("broke.pdf").closest("tr")!;

    expect(within(workingRow).getByText(/processing/i)).toBeInTheDocument();
    expect(within(readyRow).getByText(/ready/i)).toBeInTheDocument();
    expect(within(readyRow).getByText(/12/)).toBeInTheDocument();
    expect(within(failedRow).getByText(/failed/i)).toBeInTheDocument();
    expect(within(failedRow).getByText(/could not parse page 4/i)).toBeInTheDocument();
  });

  it("still reads correctly after a remount mid-ingest, rather than showing a stuck spinner", async () => {
    let currentStatus: "parsing" | "ready" = "parsing";
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([doc({ id: 1, filename: "menu.pdf", status: currentStatus, chunk_count: currentStatus === "ready" ? 9 : null })]),
      }),
    );

    const { unmount } = renderDocumentsRoute();
    const firstRow = (await screen.findByText("menu.pdf")).closest("tr")!;
    expect(within(firstRow).getByText(/processing/i)).toBeInTheDocument();
    unmount();

    // The server finished the job while the page was gone — a refresh (a
    // fresh mount, a fresh GET) must show that, not repeat the stale
    // "processing" the last render happened to have.
    currentStatus = "ready";
    renderDocumentsRoute();
    const secondRow = (await screen.findByText("menu.pdf")).closest("tr")!;
    await within(secondRow).findByText(/ready/i);
    expect(within(secondRow).queryByText(/processing/i)).not.toBeInTheDocument();
  });

  it("reingests a failed document", async () => {
    // Reingest replaces the row server-side (a new id, per documents.py's
    // own docstring) — the store below models that so the component's
    // post-reingest refetch actually observes the change.
    let documentsStore: DocumentRecord[] = [doc({ id: 3, filename: "broke.pdf", status: "failed", error: "boom" })];
    const fetchMock = routeFetch({
      "GET /agent/datasources": () => jsonResponse([corpus()]),
      "GET /agent/documents": () => jsonResponse(documentsStore),
      "POST /agent/documents/3/reingest": () => {
        const newDoc = doc({ id: 4, filename: "broke.pdf", status: "pending" });
        documentsStore = [newDoc];
        return jsonResponse(newDoc, 200);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDocumentsRoute();

    const row = (await screen.findByText("broke.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /reingest/i }));

    // Reingest swaps in a new row (a new id — see the store comment
    // above), so this row's key changes and React mounts a fresh <tr>;
    // re-querying by filename rather than reusing `row` is what a real
    // refresh of the visible table looks like here.
    await waitFor(() => {
      const refreshedRow = screen.getByText("broke.pdf").closest("tr")!;
      expect(within(refreshedRow).getByText(/processing/i)).toBeInTheDocument();
    });
  });

  it("opens the Chunks view for a row and closes it again", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([doc({ id: 9, filename: "menu.pdf", status: "ready", chunk_count: 1 })]),
        "GET /agent/documents/9/chunks": () =>
          jsonResponse({
            items: [
              { id: 1, ordinal: 0, text: "how to void a bill", headings: null, page_no: null, bbox: null, kind: "text" },
            ],
            next_cursor: null,
            has_more: false,
          }),
      }),
    );
    renderDocumentsRoute();

    const row = (await screen.findByText("menu.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /^chunks$/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await screen.findByText("how to void a bill");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the classification tree with a rolled-up count per level", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () => jsonResponse([doc({ id: 1, tags: ["ops/closing/cash-handling"] })]),
        "GET /agent/documents/tags": () =>
          jsonResponse(
            tagTree({
              nodes: [
                { path: "ops", depth: 1, document_count: 7 },
                { path: "ops/closing", depth: 2, document_count: 3 },
                { path: "finance", depth: 1, document_count: 2 },
              ],
              untagged_count: 1,
              total_count: 9,
            }),
          ),
      }),
    );
    renderDocumentsRoute();

    const rail = await screen.findByRole("navigation", { name: /classification/i });
    expect(within(rail).getByRole("button", { name: /ops, 7 documents/i })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /finance, 2 documents/i })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /unclassified, 1 document/i })).toBeInTheDocument();
    // 9, not 7 + 2 + 1: a document filed under two roots is counted once
    // by the server and twice by that sum, so the console must not add up
    // the branches itself.
    expect(within(rail).getByRole("button", { name: /all documents, 9 documents/i })).toBeInTheDocument();
    // A branch nobody is standing in stays collapsed — the rail is
    // navigation, not an outline of the whole corpus.
    expect(within(rail).queryByRole("button", { name: /closing/i })).not.toBeInTheDocument();
  });

  it("filters by a branch on the server, so a parent finds what is filed below it", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": (ctx) => {
          requested.push(new URL(ctx.url).search);
          return jsonResponse([doc({ id: 1, filename: "cash.pdf", tags: ["ops/closing/cash-handling"] })]);
        },
        "GET /agent/documents/tags": () =>
          jsonResponse(tagTree({ nodes: [{ path: "ops", depth: 1, document_count: 1 }], total_count: 1 })),
      }),
    );
    renderDocumentsRoute();

    const rail = await screen.findByRole("navigation", { name: /classification/i });
    fireEvent.click(within(rail).getByRole("button", { name: /ops, 1 document/i }));

    // The server decides what "below ops" means (documents.py's own
    // descendant filter), so the console must actually ask it rather than
    // sieving the list it already has.
    await waitFor(() => expect(requested.at(-1)).toContain("tag=ops"));
    expect(await screen.findByText("cash.pdf")).toBeInTheDocument();
  });

  it("asks for only the unfiled documents when the Unclassified branch is chosen", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": (ctx) => {
          requested.push(new URL(ctx.url).search);
          return jsonResponse([doc({ id: 1, filename: "loose.pdf" })]);
        },
        "GET /agent/documents/tags": () =>
          jsonResponse(tagTree({ untagged_count: 1, total_count: 1 })),
      }),
    );
    renderDocumentsRoute();

    const rail = await screen.findByRole("navigation", { name: /classification/i });
    fireEvent.click(within(rail).getByRole("button", { name: /unclassified, 1 document/i }));

    await waitFor(() => expect(requested.at(-1)).toContain("untagged=true"));
  });

  it("groups the documents on screen one level below where the operator is standing", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([
            doc({ id: 1, filename: "cash.pdf", tags: ["ops/closing/cash-handling"] }),
            doc({ id: 2, filename: "gst.pdf", tags: ["finance/gst"] }),
            doc({ id: 3, filename: "loose.pdf" }),
          ]),
      }),
    );
    renderDocumentsRoute();

    await screen.findByText("cash.pdf");
    // Sheet headings, not table rows: the top-level branches are the
    // groups at the root, and everything unfiled falls into its own.
    expect(screen.getByRole("heading", { name: /^ops$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^finance$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^unclassified$/i })).toBeInTheDocument();
  });

  it("shows a restricted document's permission, and marks an unfiled one as unclassified", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([
            doc({ id: 1, filename: "payroll.pdf", tags: ["finance/payroll"], required_permission: "kb.finance" }),
            doc({ id: 2, filename: "loose.pdf" }),
          ]),
      }),
    );
    renderDocumentsRoute();

    const restrictedRow = (await screen.findByText("payroll.pdf")).closest("tr")!;
    expect(within(restrictedRow).getByText("kb.finance")).toBeInTheDocument();
    expect(within(restrictedRow).getByText("finance/payroll")).toBeInTheDocument();

    const looseRow = screen.getByText("loose.pdf").closest("tr")!;
    expect(within(looseRow).getByText(/unclassified/i)).toBeInTheDocument();
  });

  it("files a document and restricts it in one save", async () => {
    let documentsStore: DocumentRecord[] = [doc({ id: 1, filename: "payroll.pdf", status: "ready" })];
    let patched: unknown = null;
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () => jsonResponse(documentsStore),
        "PATCH /agent/documents/1/classification": async (ctx) => {
          patched = await ctx.json();
          const updated = doc({
            id: 1,
            filename: "payroll.pdf",
            status: "ready",
            tags: ["finance/payroll"],
            required_permission: "kb.finance",
          });
          documentsStore = [updated];
          return jsonResponse(updated);
        },
      }),
    );
    renderDocumentsRoute();

    const row = (await screen.findByText("payroll.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /classify/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/add a classification/i), {
      target: { value: "finance/payroll" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^add$/i }));
    fireEvent.click(within(dialog).getByLabelText(/only people holding a permission/i));
    fireEvent.change(within(dialog).getByLabelText(/permission code/i), {
      target: { value: "kb.finance" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(patched).toEqual({ tags: ["finance/payroll"], required_permission: "kb.finance" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const updatedRow = screen.getByText("payroll.pdf").closest("tr")!;
    expect(within(updatedRow).getByText("kb.finance")).toBeInTheDocument();
  });

  it("refuses to save a restriction with no permission code, rather than silently unrestricting", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () => jsonResponse([doc({ id: 1, filename: "payroll.pdf", status: "ready" })]),
      }),
    );
    renderDocumentsRoute();

    const row = (await screen.findByText("payroll.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /classify/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/only people holding a permission/i));

    // The server would normalise an empty code back to "everyone" — the
    // exact opposite of what the switch the operator just flipped says.
    expect(within(dialog).getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(within(dialog).getByText(/name the permission code/i)).toBeInTheDocument();
  });

  it("lifts a restriction as a deliberate choice", async () => {
    let patched: unknown = null;
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () =>
          jsonResponse([doc({ id: 1, filename: "payroll.pdf", status: "ready", required_permission: "kb.finance" })]),
        "PATCH /agent/documents/1/classification": async (ctx) => {
          patched = await ctx.json();
          return jsonResponse(doc({ id: 1, filename: "payroll.pdf", status: "ready" }));
        },
      }),
    );
    renderDocumentsRoute();

    const row = (await screen.findByText("payroll.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /classify/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText(/everyone who can read documents/i));
    fireEvent.click(within(dialog).getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patched).toEqual({ tags: [], required_permission: null }));
  });

  it("removes a document", async () => {
    let documentsStore: DocumentRecord[] = [doc({ id: 1, filename: "menu.pdf", status: "ready" })];
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus()]),
        "GET /agent/documents": () => jsonResponse(documentsStore),
        "DELETE /agent/documents/1": () => {
          documentsStore = [];
          return jsonResponse(null, 204);
        },
      }),
    );
    renderDocumentsRoute();

    const row = (await screen.findByText("menu.pdf")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(screen.queryByText("menu.pdf")).not.toBeInTheDocument());
  });
});

describe("choosing between several knowledge libraries", () => {
  beforeEach(() => {
    setSession({ apiKey: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  const twoLibraries = [
    corpus({ id: 4, name: "Complaint SOP Library" }),
    corpus({ id: 3, name: "Customer Knowledge Base" }),
  ];

  it("lists every knowledge library, not just the first one found", async () => {
    // A tenant really does have several knowledge datasources -- one per
    // agent -- and `rows.find(...)` returned the Complaint SOP Library, so
    // the page showed its empty state while the operator's menu document
    // sat in the Customer Knowledge Base, with no control to switch.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse(twoLibraries),
        "GET /agent/documents": () => jsonResponse([]),
      }),
    );
    renderDocumentsRoute();

    const picker = await screen.findByLabelText("Library");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Complaint SOP Library",
      "Customer Knowledge Base",
    ]);
  });

  it("refetches against the library the operator picks", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse(twoLibraries),
        "GET /agent/documents": (ctx) => {
          asked.push(new URL(ctx.url).searchParams.get("datasource_id") ?? "");
          return jsonResponse([]);
        },
      }),
    );
    renderDocumentsRoute();

    const picker = await screen.findByLabelText("Library");
    fireEvent.change(picker, { target: { value: "3" } });

    await waitFor(() => expect(asked).toContain("3"));
  });

  it("shows no library control when there is only one", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "GET /agent/datasources": () => jsonResponse([corpus({ id: 3 })]),
        "GET /agent/documents": () => jsonResponse([]),
      }),
    );
    renderDocumentsRoute();

    await screen.findByRole("button", { name: /add a document/i });
    expect(screen.queryByLabelText("Library")).toBeNull();
  });
});
