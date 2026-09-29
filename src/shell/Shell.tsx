import { Outlet } from "react-router-dom";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { InspectorProvider } from "./InspectorContext.tsx";
import { TopBar } from "./TopBar.tsx";
import { Rail } from "./Rail.tsx";
import { Inspector } from "./Inspector.tsx";
import { SCROLL_REGION_ATTR } from "../ask/chat/useStickToBottom.ts";

/**
 * The signed-in console: shadcn's inset sidebar on the left, and on the
 * right a header over the screen and the Inspector.
 *
 * The screen's own box is the console's one scroll region, marked so Ask's
 * thread can find it and follow its own tail while an answer streams in (see
 * chat/useStickToBottom.ts). A screen that scrolls itself (Ask's full-height
 * `screen` layout) turns that off, as before.
 */
function ShellLayout() {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Rail />
      <SidebarInset className="min-h-0 overflow-hidden">
        <TopBar />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6 has-[[class*=screen]]:overflow-y-hidden"
            {...{ [SCROLL_REGION_ATTR]: "" }}
          >
            <Outlet />
          </div>
          <Inspector />
        </div>
      </SidebarInset>
      <Toaster position="bottom-right" />
    </SidebarProvider>
  );
}

export function Shell() {
  return (
    <InspectorProvider>
      <ShellLayout />
    </InspectorProvider>
  );
}
