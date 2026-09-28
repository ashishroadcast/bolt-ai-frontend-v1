import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import type { UIPart } from "./catalog.tsx";
import { Sheet } from "./Sheet.tsx";
// UnknownIntent's own paragraph style, read rather than copied: the two
// sheets say the same kind of thing ("this one part could not be shown")
// and should look like one convention, not two.
import styles from "./UnknownIntent.module.css";

/**
 * What a part that threw renders instead. Same sheet, same quiet paragraph
 * as `UnknownIntent`, because to a reader the two are the same situation:
 * one attachment is missing and the rest of the answer is still there.
 */
function PartFailed({ intent }: { intent: string }): ReactElement {
  return (
    <Sheet title="Unreadable response" subLabel={intent} icon={TriangleAlert}>
      <p className={styles.message}>
        Couldn&apos;t display this part of the answer. The rest of the answer is unaffected.
      </p>
    </Sheet>
  );
}

interface PartBoundaryProps {
  part: UIPart;
  children: ReactNode;
}

interface PartBoundaryState {
  failed: boolean;
}

/**
 * Catches a part that throws while rendering, so it costs one sheet rather
 * than the whole Ask screen.
 *
 * **Why every part gets one.** React unmounts the entire tree above an
 * uncaught render error, and Ask had no boundary at all: a scatter chart
 * with fewer than two series, or a chart point missing its `values`,
 * blanked the thread, the composer and every earlier answer with it. The
 * adapters in `wireParts.ts` refuse most malformed payloads, but they are
 * a guess at what can go wrong, and this is the backstop for the rest.
 *
 * A class because error boundaries still have no hook form. It forgets the
 * failure when it is handed a different part — a live run re-arranges its
 * parts as they arrive, so the boundary at one position can come to hold a
 * part that renders perfectly well.
 */
export class PartBoundary extends Component<PartBoundaryProps, PartBoundaryState> {
  state: PartBoundaryState = { failed: false };

  static getDerivedStateFromError(): PartBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The reader gets the sheet; whoever debugs this gets the part's intent
    // and the stack, which the sheet deliberately does not show.
    console.error(`Ask could not render a "${this.props.part.intent}" part.`, error, info.componentStack);
  }

  componentDidUpdate(previous: PartBoundaryProps): void {
    if (this.state.failed && previous.part !== this.props.part) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) return <PartFailed intent={this.props.part.intent} />;
    return this.props.children;
  }
}
