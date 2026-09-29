import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth, type ActingOrganisation } from "../auth/AuthContext.tsx";
import { confirmUnloadDuringAskRun, isAskRunInFlight } from "../ask/chat/useChat.ts";
import { GatewayError } from "../ask/http/errors.ts";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Which organisation the console is reading.
 *
 * bolt-v2's organisations are a tree and a user's membership can reach a
 * long way down it, so "whose data am I looking at" is a real question with
 * a real answer that changes — and agent-service has always accepted an
 * `Organisation` header to answer it. Nothing sent one until now, so every
 * operator was pinned to the organisation their token happened to be minted
 * against, with no way to look at a child depot without signing in again.
 *
 * **The list is loaded lazily, on first open.** A root-organisation account
 * can see over a thousand organisations, which is up to 24 paginated round
 * trips to bolt-v2 — not something to spend on every page load for a control
 * most sessions never touch.
 *
 * **Switching is local and instant.** No re-authentication, no new token:
 * `actAsOrganisation` changes one field on the session and every subsequent
 * request carries the new header. agent-service re-validates it against the
 * caller's real access and refuses anything outside their subtree, so a bad
 * choice here fails closed. The reload afterwards is a data concern, not an
 * auth one — every screen already on display is showing the previous
 * organisation's rows.
 */
export function OrganisationPicker() {
  const { session, loadActingOrganisations, actAsOrganisation } = useAuth();
  const [open, setOpen] = useState(false);
  const [organisations, setOrganisations] = useState<ActingOrganisation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. A dropdown that traps the page is
  // worse than no dropdown, and this one can be a thousand rows tall.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOrganisations(await loadActingOrganisations());
    } catch (err) {
      // bolt-v2's own resolver text is already operator-facing, so it is
      // shown rather than replaced. Anything else gets a plain fallback.
      setError(
        err instanceof GatewayError ? err.message : "Couldn't load organisations.",
      );
    } finally {
      setLoading(false);
    }
  }, [loadActingOrganisations]);

  const toggle = useCallback(() => {
    // The fetch is fired HERE, not inside the `setOpen` updater. A state
    // updater must be pure: React double-invokes it in development to surface
    // exactly this, and the side effect inside it sent two identical requests
    // for 1355 organisations on every first open. Caught by watching the
    // network panel, not by a test — a duplicate GET is invisible in the UI.
    //
    // Load on the opening edge only, and only once per session: reopening a
    // list that is already in hand should cost nothing.
    if (!open && organisations === null && !loading) void load();
    setOpen(!open);
  }, [load, loading, open, organisations]);

  const choose = useCallback(
    (organisationId: string) => {
      setOpen(false);
      if (organisationId === session?.organisationId) return;
      // The reload below would cut off an answer Ask is still writing — the
      // run is cancelled the moment its connection closes, and nothing of it
      // is saved. Asked here, before the switch, rather than left to the
      // browser's "Leave site?": by then `actAsOrganisation` has already
      // run, and cancelling that prompt would leave the bar naming one
      // organisation over another's data.
      if (isAskRunInFlight()) {
        const proceed = window.confirm(
          "An answer is still being written. Switching organisation reloads the console and stops it. Switch anyway?",
        );
        if (!proceed) return;
        confirmUnloadDuringAskRun();
      }
      actAsOrganisation(organisationId);
      // Every screen currently rendered is showing the old organisation's
      // rows, and there is no store-wide invalidation to fire instead. A
      // reload is blunt but honest: the alternative is a console that says
      // one organisation in the bar and shows another's data underneath.
      window.location.reload();
    },
    [actAsOrganisation, session?.organisationId],
  );

  if (session === null) return null;

  const current =
    organisations?.find((organisation) => organisation.id === session.organisationId) ?? null;
  // Before the list has loaded, a user session already knows the name of the
  // organisation it signed in to — better than a generic word in the bar.
  const signedIn =
    session.signedInOrganisation?.id === session.organisationId ? session.signedInOrganisation : undefined;
  const label = current?.name ?? signedIn?.name ?? "Organisation";

  const needle = filter.trim().toLowerCase();
  const shown =
    organisations === null
      ? []
      : needle === ""
        ? organisations
        : organisations.filter((organisation) =>
            organisation.path.toLowerCase().includes(needle),
          );

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-w-[16rem] gap-2"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.path ?? "Choose the organisation to read"}
      >
        <Building2 className="text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="ml-auto text-muted-foreground" aria-hidden="true" />
      </Button>

      {open ? (
        <div
          className="absolute top-full right-0 z-50 mt-1.5 flex max-h-[min(24rem,70vh)] w-80 flex-col overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
          role="listbox"
          aria-label="Organisation"
        >
          {/* Shown whenever the list is big enough that scanning it is not
              the fastest way to a specific depot. */}
          {organisations !== null && organisations.length > 8 ? (
            <Input
              className="mb-1 h-8 shrink-0"
              type="search"
              placeholder="Filter organisations"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              // The control the operator came here to use; focusing it saves
              // a click in the case the filter exists for.
              autoFocus
            />
          ) : null}

          {loading ? <div className="px-2 py-3 text-sm text-muted-foreground">Loading organisations…</div> : null}
          {error !== null ? (
            <div className="px-2 py-3 text-sm text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          {!loading && error === null && organisations !== null && shown.length === 0 ? (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              {organisations.length === 0 ? "No organisations." : "Nothing matches."}
            </div>
          ) : null}

          <div className="min-h-0 overflow-y-auto">
            {shown.map((organisation) => {
              const selected = organisation.id === session.organisationId;
              return (
                <button
                  key={organisation.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none select-none",
                    "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent",
                    selected && "font-medium",
                  )}
                  onClick={() => choose(organisation.id)}
                >
                  <Check className={cn("size-4 shrink-0", selected ? "text-primary" : "invisible")} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{organisation.path}</span>
                  {/* Was a device count, from bolt-v2's `myOrganisations`. The
                      list comes from agent-service now, which resolves the
                      organisation TREE and does not count fleet — so the number
                      is dropped rather than faked. "Current" is the one marker
                      the picker actually needs. */}
                  {organisation.current ? (
                    <span className="shrink-0 text-xs text-muted-foreground">current</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
