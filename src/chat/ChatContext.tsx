import { createContext, useContext, type ReactNode } from "react";
import { useChat, type UseChatResult } from "./useChat.ts";

const ChatContext = createContext<UseChatResult | null>(null);

/*
 * Scoped above the router (wired into Shell.tsx, a sibling of
 * InspectorProvider) rather than inside AskRoute — two things in this
 * console need it at once: the Composer, which is global chrome rendered
 * outside <Outlet/> (design plan's layout grid reserves its own "composer"
 * row across the whole console, not just the Ask panel — see AskRoute.tsx's
 * own docstring: "the composer at the foot of the screen already is the
 * action"), and AskRoute, which reads it to render the thread. A provider
 * scoped inside AskRoute could not reach Composer's sibling position in the
 * tree at all.
 *
 * This also settles what "a user navigates away mid-run" means here: since
 * the provider outlives route changes, leaving /ask does not abort the
 * request — the run keeps streaming and lands correctly whether or not
 * AskRoute is mounted to see it happen, matching agent-service's own
 * warning against wasting spend on a run nobody asked to cancel. The
 * request is only ever aborted when this provider itself unmounts, i.e.
 * the session ends (`useChat.ts`'s cleanup effect) — the real "closing the
 * connection" cancellation `app.api.run`'s docstring describes.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext(): UseChatResult {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChatContext must be called within ChatProvider");
  }
  return ctx;
}
