import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { AskInspectorProvider, AskScreen } from "../ask/index.ts";
import { useInspector } from "../shell/InspectorContext.tsx";

/**
 * The console's adapter onto the Ask package — and the whole of what this
 * route still is.
 *
 * It used to BE Ask: 121 lines of agent picker, thread, composer and history
 * drawer, reaching into the console's session store for a credential, its
 * HTTP singleton for a base URL, its inspector context for phase selection,
 * and react-router for a link. Ask lives in `src/ask/` now and imports none
 * of those.
 *
 * What is left here is the two things only the console can answer, and they
 * are answered at two different heights on purpose:
 *
 * * the credential and base URL, in `AskProvider` at the app root
 *   (`src/askConfig.ts`) — `ChatProvider` has to sit above the router for a
 *   run to survive navigating away from Ask, so its config does too;
 * * the inspector, HERE, because the console's panel lives inside `Shell`
 *   and this route is the only place both it and Ask are in scope.
 */
export function AskRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const inspector = useInspector();

  // The `?conversation=<id>` permalink History's Share button produces.
  // Parsed here rather than in the package: a query string is this router's
  // business, and a host without one still opens a conversation by passing a
  // number.
  const raw = searchParams.get("conversation");
  const parsed = raw === null ? Number.NaN : Number(raw);
  const initialConversationId = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;

  // Handed over once, then taken out of the URL. The thread lives above the
  // router (see `ChatProvider`), so it outlasts this route — but the query
  // string stayed in the history entry, and every return to it (Back, or a
  // remount of this route) opened the linked conversation again over
  // whatever had happened since, a run in progress included.
  //
  // After AskScreen has read it: a child's effects run before its
  // parent's, so AskScreen's own effect has already started the open by the
  // time this clears the prop it came from.
  useEffect(() => {
    if (raw === null) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("conversation");
        return next;
      },
      { replace: true },
    );
  }, [raw, setSearchParams]);

  return (
    <AskInspectorProvider
      inspector={{ selection: inspector.selection, selectPhase: inspector.selectPhase }}
    >
      <AskScreen initialConversationId={initialConversationId} />
    </AskInspectorProvider>
  );
}
