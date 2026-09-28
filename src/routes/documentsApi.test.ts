import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { AgentApiError } from "../ask/http/gatewayClient.ts";
import { UnauthorizedError } from "../ask/http/errors.ts";
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  UNTAGGED_GROUP,
  accessLabel,
  childTags,
  chunkKindLabel,
  classifyUpload,
  groupDocuments,
  ingestPhase,
  isReingestable,
  listDocumentChunks,
  parentTag,
  tagLabel,
  uploadDocument,
  type DocumentRecord,
  type TagNode,
} from "./documentsApi.ts";

function makeFile(name: string, sizeBytes: number, content = "x"): File {
  const file = new File([content], name);
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

describe("ingestPhase", () => {
  it("buckets every in-flight pipeline stage as working", () => {
    expect(ingestPhase("pending")).toBe("working");
    expect(ingestPhase("parsing")).toBe("working");
    expect(ingestPhase("describing")).toBe("working");
    expect(ingestPhase("chunking")).toBe("working");
    expect(ingestPhase("indexing")).toBe("working");
  });

  it("distinguishes the two terminal states", () => {
    expect(ingestPhase("ready")).toBe("ready");
    expect(ingestPhase("failed")).toBe("failed");
  });
});

describe("isReingestable", () => {
  it("allows reingest only from a terminal state, matching the server's own guard", () => {
    expect(isReingestable("ready")).toBe(true);
    expect(isReingestable("failed")).toBe(true);
    expect(isReingestable("pending")).toBe(false);
    expect(isReingestable("indexing")).toBe(false);
  });
});

describe("classifyUpload", () => {
  it("accepts a file within the size cap and an accepted extension", () => {
    const file = makeFile("menu.pdf", 1024);
    expect(classifyUpload(file)).toEqual({ ok: true });
  });

  it("names the 50 MiB limit when a file exceeds it", () => {
    const file = makeFile("huge.pdf", MAX_UPLOAD_BYTES + 1);
    const result = classifyUpload(file);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/50 ?MiB/);
  });

  it("names the accepted types when the extension is unsupported", () => {
    const file = makeFile("menu.exe", 1024);
    const result = classifyUpload(file);
    expect(result.ok).toBe(false);
    for (const extension of ACCEPTED_EXTENSIONS) {
      expect(!result.ok && result.message).toContain(extension);
    }
  });
});

describe("uploadDocument", () => {
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

  // The load-bearing case: this must never set a Content-Type header
  // itself, or the browser will not attach the multipart boundary the
  // server's parser needs — see this module's own docstring for why
  // agentFetch cannot be used for this call at all.
  it("sends the file as multipart form data without forcing a Content-Type header", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 1, status: "pending" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const file = makeFile("menu.pdf", 10);
    await uploadDocument(7, file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/agent/documents");
    expect(init.body).toBeInstanceOf(FormData);
    const body = init.body as FormData;
    expect(body.get("datasource_id")).toBe("7");
    expect(body.get("file")).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("throws UnauthorizedError and clears the session on a 401", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: "nope" }), { status: 401 }));

    await expect(uploadDocument(7, makeFile("menu.pdf", 10))).rejects.toThrow(UnauthorizedError);
  });

  it("surfaces the server's classified detail on a non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "upload exceeds the 52428800-byte limit" }), { status: 413 }),
    );

    const error = await uploadDocument(7, makeFile("menu.pdf", 10)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentApiError);
    expect((error as AgentApiError).message).toBe("upload exceeds the 52428800-byte limit");
    expect((error as AgentApiError).status).toBe(413);
  });
});

describe("chunkKindLabel", () => {
  it("gives every ChunkKind a human label, not the raw wire value", () => {
    expect(chunkKindLabel("text")).toBe("Text");
    expect(chunkKindLabel("table")).toBe("Table");
    expect(chunkKindLabel("figure")).toBe("Figure");
    // The one non-obvious case: "page_image" read raw would look like a
    // rendering bug, not the deliberate "transcribed, not read off the
    // text layer" signal app.knowledge.chunk's docstring describes.
    expect(chunkKindLabel("page_image")).toBe("Page scan");
  });
});

describe("listDocumentChunks", () => {
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

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  it("requests with no query string when cursor/limit are both omitted", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [], next_cursor: null, has_more: false }));

    await listDocumentChunks(42);

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://localhost:8080/agent/documents/42/chunks");
  });

  it("carries cursor and limit as query params when given", async () => {
    fetchMock.mockResolvedValue(jsonOk({ items: [], next_cursor: null, has_more: false }));

    await listDocumentChunks(42, { cursor: 7, limit: 25 });

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe("http://localhost:8080/agent/documents/42/chunks?cursor=7&limit=25");
  });

  it("returns the page shape as-is, including has_more/next_cursor", async () => {
    const page = {
      items: [{ id: 1, ordinal: 0, text: "hi", headings: null, page_no: null, bbox: null, kind: "text" }],
      next_cursor: 0,
      has_more: true,
    };
    fetchMock.mockResolvedValue(jsonOk(page));

    await expect(listDocumentChunks(42)).resolves.toEqual(page);
  });
});

function tagged(id: number, tags: string[], filename = `doc-${id}.pdf`): DocumentRecord {
  return {
    id,
    datasource_id: 5,
    source_url: null,
    filename,
    content_type: "application/pdf",
    size_bytes: 1,
    status: "ready",
    page_count: null,
    figure_count: null,
    chunk_count: null,
    vision_cost_usd: 0,
    error: null,
    created_at: "2026-08-27T10:00:00Z",
    tags,
    required_permission: null,
  };
}

describe("tagLabel", () => {
  it("shows only the deepest level, since the tree already shows the rest", () => {
    expect(tagLabel("ops/closing/cash-handling")).toBe("Cash handling");
    expect(tagLabel("ops")).toBe("Ops");
  });
});

describe("parentTag", () => {
  it("walks one level up, and stops at a root", () => {
    expect(parentTag("ops/closing/cash-handling")).toBe("ops/closing");
    expect(parentTag("ops")).toBeNull();
  });
});

describe("childTags", () => {
  const nodes: TagNode[] = [
    { path: "ops", depth: 1, document_count: 3 },
    { path: "ops/closing", depth: 2, document_count: 2 },
    { path: "ops/closing/cash-handling", depth: 3, document_count: 1 },
    { path: "finance", depth: 1, document_count: 1 },
  ];

  it("returns the roots for null", () => {
    expect(childTags(nodes, null).map((node) => node.path)).toEqual(["ops", "finance"]);
  });

  it("returns direct children only, never grandchildren", () => {
    expect(childTags(nodes, "ops").map((node) => node.path)).toEqual(["ops/closing"]);
  });
});

describe("groupDocuments", () => {
  it("groups by top-level classification at the root, with the unfiled ones last", () => {
    const groups = groupDocuments(
      [tagged(1, ["ops/closing"]), tagged(2, ["finance/gst"]), tagged(3, [])],
      null,
    );

    expect(groups.map((group) => group.key)).toEqual(["finance", "ops", UNTAGGED_GROUP]);
  });

  it("groups one level below the selection, not by the whole path", () => {
    const groups = groupDocuments(
      [tagged(1, ["ops/closing/cash-handling"]), tagged(2, ["ops/opening"])],
      "ops",
    );

    expect(groups.map((group) => group.key)).toEqual(["ops/closing", "ops/opening"]);
  });

  it("keeps a document filed at the selected level itself in its own group", () => {
    const groups = groupDocuments([tagged(1, ["ops"]), tagged(2, ["ops/closing"])], "ops");

    expect(groups.map((group) => group.label)).toContain("Directly in Ops");
    expect(groups.map((group) => group.key)).toContain("ops/closing");
  });

  it("shows a document filed in two branches under both, matching the server's counts", () => {
    const groups = groupDocuments([tagged(1, ["ops/closing", "finance/cash"])], null);

    expect(groups.map((group) => group.key).sort()).toEqual(["finance", "ops"]);
    expect(groups.every((group) => group.documents.length === 1)).toBe(true);
  });

  it("ignores tags outside the selected branch", () => {
    const groups = groupDocuments([tagged(1, ["ops/closing", "finance/cash"])], "ops");

    expect(groups.map((group) => group.key)).toEqual(["ops/closing"]);
  });
});

describe("accessLabel", () => {
  it("names the permission code, or says everyone", () => {
    expect(accessLabel(null)).toBe("Everyone");
    expect(accessLabel("kb.finance")).toBe("kb.finance");
  });
});
