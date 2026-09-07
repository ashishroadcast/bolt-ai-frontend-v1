import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { PhaseSegment } from "../chat/phaseTimeline.ts";

/*
 * The inspector opens on a phase or a result (design plan, "Layout"). Task 1
 * shipped the open/close mechanism with nothing to select yet; task 3 (the
 * run rail) is the first caller, so `selection` is a phase specifically —
 * "or a result" (a table/chart clicked open) is a later task's addition to
 * this same shape, not a reason to invent a wider union nothing populates
 * yet (house rule: no abstraction for a hypothetical second case).
 *
 * A phase is only ever selectable while its run rail is live — task brief:
 * "Clicking a phase opens the inspector with that phase's detail." Once a
 * run collapses to its summary line (useChat.ts's ActiveRun -> ChatMessage
 * transition), there is nothing left in the DOM to click, so `selectPhase`
 * needs no "is this still valid" guard of its own — the caller simply stops
 * existing.
 */
interface InspectorState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  selection: PhaseSegment | null;
  selectPhase: (segment: PhaseSegment) => void;
}

const InspectorContext = createContext<InspectorState | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selection, setSelection] = useState<PhaseSegment | null>(null);

  const value = useMemo<InspectorState>(
    () => ({
      isOpen,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen((current) => !current),
      selection,
      selectPhase: (segment: PhaseSegment) => {
        setSelection(segment);
        setIsOpen(true);
      },
    }),
    [isOpen, selection],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorState {
  const ctx = useContext(InspectorContext);
  if (!ctx) {
    throw new Error("useInspector must be called within InspectorProvider");
  }
  return ctx;
}
