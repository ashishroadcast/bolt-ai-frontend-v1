import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../auth/session.ts";
import { ArtifactsRoute } from "./ArtifactsRoute.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AGENTS = [{ id: 5, name: "Analytics", description: null, is_active: true }];

const ARTIFACTS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    filename: "revenue.csv",
    content_type: "text/csv",
    size_bytes: 2048,
    created_at: "2026-08-20T10:00:00Z",
    code_execution_id: 7,
    agent_id: 5,
  },
];

function renderArtifacts() {
  return render(
    <MemoryRouter initialEntries={["/artifacts"]}>
      <ArtifactsRoute />
    </MemoryRouter>,
  );
}

function mockReads(fetchMock: ReturnType<typeof vi.fn>, artifacts: unknown[] = ARTIFACTS) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const request = input as Request;
    if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
    if (request.url.endsWith("/agent/artifacts") && request.method === "GET") {
      return Promise.resolve(jsonResponse(artifacts));
    }
    return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
  });
}

describe("ArtifactsRoute", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "open").mockImplementation(() => null);
    setSession({ kind: "apiKey", credential: "tok", user: { id: "1", email: "a@b.com", name: "A" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setSession(null);
  });

  it("renders a real artifact: filename, size, and the producing agent", async () => {
    mockReads(fetchMock);

    renderArtifacts();

    await waitFor(() => expect(screen.getByText("revenue.csv")).toBeInTheDocument());
    expect(screen.getByText(/analytics/i)).toBeInTheDocument();
    expect(screen.getByText(/2(\.0)? ?kb|2048/i)).toBeInTheDocument();
  });

  it("empty state explains what an artifact is, not 'No data'", async () => {
    mockReads(fetchMock, []);

    renderArtifacts();

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    expect(screen.getByText(/code produces during a run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /go to ask/i })).toBeInTheDocument();
  });

  it("download resolves a fresh signed URL through the real endpoint and never invents one", async () => {
    mockReads(fetchMock);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.url.endsWith("/agent/agents")) return Promise.resolve(jsonResponse(AGENTS));
      if (request.url.endsWith("/agent/artifacts") && request.method === "GET") {
        return Promise.resolve(jsonResponse(ARTIFACTS));
      }
      if (request.url.endsWith(`/agent/artifacts/${ARTIFACTS[0]!.id}`)) {
        return Promise.resolve(
          jsonResponse({
            id: ARTIFACTS[0]!.id,
            filename: "revenue.csv",
            content_type: "text/csv",
            size_bytes: 2048,
            url: "https://r2.example.com/agent/7/executions/7/revenue.csv?signed=1",
            expires_in: 300,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ detail: "unhandled in test" }, 500));
    });

    renderArtifacts();
    await waitFor(() => expect(screen.getByText("revenue.csv")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    await waitFor(() => {
      const resolveCall = fetchMock.mock.calls.find((call) =>
        (call[0] as Request).url.endsWith(`/agent/artifacts/${ARTIFACTS[0]!.id}`),
      );
      expect(resolveCall).toBeDefined();
    });

    await waitFor(() => {
      expect(screen.getByText(/r2\.example\.com\/agent\/7\/executions\/7\/revenue\.csv/)).toBeInTheDocument();
    });
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("r2.example.com"),
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("links the producing agent to its own detail page", async () => {
    mockReads(fetchMock);

    renderArtifacts();
    await waitFor(() => expect(screen.getByText("revenue.csv")).toBeInTheDocument());

    const link = screen.getByRole("link", { name: /analytics/i });
    expect(link).toHaveAttribute("href", "/agents/5");
  });

  it("a long filename scrolls inside its own cell rather than the page", async () => {
    const longName = "quarterly-revenue-breakdown-by-store-and-channel-and-partner".repeat(3) + ".csv";
    mockReads(fetchMock, [{ ...ARTIFACTS[0], filename: longName }]);

    renderArtifacts();

    await waitFor(() => expect(screen.getByTestId("artifact-filename")).toBeInTheDocument());
    const cell = screen.getByTestId("artifact-filename");
    expect(within(cell).getByText(longName)).toBeInTheDocument();
  });
});
