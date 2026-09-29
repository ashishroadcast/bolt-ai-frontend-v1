import { Zap } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { NAV_ICONS } from "./navIcons.tsx";
import { UserMenu } from "./UserMenu.tsx";

export interface RailItem {
  to: string;
  label: string;
}

/**
 * The console's sections, in the four groups the rail has always had. Also
 * the source of the header's breadcrumb (`sectionFor`), so a screen's name
 * is spelled in exactly one place.
 *
 * Prompts and test suites are not here: they live as tabs on an agent,
 * because a prompt belongs to one agent and one phase.
 */
export const NAV_GROUPS: { label: string; items: RailItem[] }[] = [
  {
    label: "Work",
    items: [
      { to: "/", label: "Dashboard" },
      { to: "/ask", label: "Ask" },
    ],
  },
  {
    label: "Build",
    items: [
      { to: "/agents", label: "Agents" },
      { to: "/orchestrators", label: "Orchestrators" },
    ],
  },
  {
    label: "Connections",
    items: [
      { to: "/databases", label: "Databases" },
      { to: "/documents", label: "Knowledge" },
      { to: "/channels", label: "Channels" },
      { to: "/mcp-servers", label: "MCP servers" },
      { to: "/models", label: "Models" },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/artifacts", label: "Artifacts" },
      { to: "/code-executions", label: "Code runs" },
      { to: "/audit", label: "Audit" },
      { to: "/settings", label: "Settings" },
    ],
  },
];

/** The group and section a path belongs to, for the breadcrumb. */
export function sectionFor(pathname: string): { group: string; item: RailItem } | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const matches =
        item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (matches) return { group: group.label, item };
    }
  }
  return null;
}

function RailLink({ to, label }: RailItem) {
  const Icon = NAV_ICONS[to];
  const { pathname } = useLocation();
  const active = sectionFor(pathname)?.item.to === to;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <NavLink to={to} end={to === "/"}>
          {Icon !== undefined && <Icon aria-hidden="true" />}
          <span>{label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The console's navigation: shadcn's sidebar, collapsible to an icon rail
 * (⌘/Ctrl+B, or the trigger in the header) and a sheet on a phone. The
 * signed-in account sits at its foot, where sign-out lives.
 */
export function Rail() {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Bolty">
              <NavLink to="/" end aria-label="Bolty home">
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Zap className="size-4" strokeWidth={2.4} aria-hidden="true" />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">bolty</span>
                  <span className="truncate text-xs text-muted-foreground">AI console for Bolt</span>
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent role="navigation" aria-label="Console sections">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <RailLink key={item.to} {...item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
