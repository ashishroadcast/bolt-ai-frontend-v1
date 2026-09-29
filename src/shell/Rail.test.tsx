import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AuthProvider } from "../auth/AuthContext.tsx";
import { Rail } from "./Rail.tsx";

/**
 * Prompts and Test suites moved onto the agent detail page as tabs (task
 * brief). This proves the sidebar side of that move: no leftover links to
 * the old standalone screens, and no empty "Tuning" group heading left
 * behind now that it has no members.
 */
describe("Rail", () => {
  it("offers only Work and Build — the Tuning group is gone, not left empty", () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SidebarProvider>
            <Rail />
          </SidebarProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
    expect(screen.queryByText("Tuning")).not.toBeInTheDocument();
  });

  it("no longer links to the standalone Prompts or Test suites screens", () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SidebarProvider>
            <Rail />
          </SidebarProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Prompts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Test suites" })).not.toBeInTheDocument();
  });

  it("still links to Agents — where Prompts & tuning and Test suites now live as tabs", () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SidebarProvider>
            <Rail />
          </SidebarProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: /Agents/ })).toHaveAttribute("href", "/agents");
  });

  it("links to MCP servers under Connections — the surface that was planned and never built", () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SidebarProvider>
            <Rail />
          </SidebarProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: /MCP servers/ })).toHaveAttribute(
      "href",
      "/mcp-servers",
    );
  });
});
