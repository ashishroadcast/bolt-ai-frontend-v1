import { Outlet } from "react-router-dom";
import { InspectorProvider, useInspector } from "./InspectorContext.tsx";
import { TopBar } from "./TopBar.tsx";
import { Rail } from "./Rail.tsx";
import { Inspector } from "./Inspector.tsx";
import { SCROLL_REGION_ATTR } from "../chat/useStickToBottom.ts";
import styles from "./Shell.module.css";

/*
 * No <Composer/> here — it moved to AskRoute.tsx, which renders and sticks
 * it inside the thread column itself. Saurabh: pinning it to every screen
 * "implies you can type a question into a database list"; it belongs on
 * Ask alone (redesign brief). See Shell.module.css's own docstring for
 * what that changed about the layout grid.
 */
function ShellLayout() {
  const { isOpen } = useInspector();

  return (
    <div className={styles.console}>
      <TopBar />
      <div className={styles.layout} data-inspector={isOpen ? "open" : "closed"}>
        <Rail />
        {/* The console's one scroll region. Marked so the thread can find
            it and follow its own tail while an answer streams in — see
            chat/useStickToBottom.ts for why it is declared here rather
            than sniffed for. */}
        <main className={styles.thread} {...{ [SCROLL_REGION_ATTR]: "" }}>
          <Outlet />
        </main>
        <Inspector />
      </div>
    </div>
  );
}

export function Shell() {
  return (
    <InspectorProvider>
      <ShellLayout />
    </InspectorProvider>
  );
}
