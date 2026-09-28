import { useState, type ReactElement } from "react";
import a11y from "../a11y.module.css";
import { useAskStrings } from "../i18n/AskLocale.tsx";
import { useChatContext } from "./ChatContext.tsx";
import type { ChatMessage } from "./types.ts";

/**
 * Tells a screen reader that the answer it has been waiting for is there.
 *
 * **Why this is needed.** A sighted reader sees the answer arrive. A
 * screen-reader user asked a question, heard "Working on your question"
 * (`WaitAnnouncement`), and then nothing: the answer is ordinary text
 * appearing further down the page, and nothing about it says "done". The
 * choice was to keep checking, or to make the answer itself a live region
 * and have it read out token by token as it streams. This says one thing,
 * once, when the run ends.
 *
 * **On the streaming-to-idle edge only.** Not on mount, and not when a
 * conversation is opened from history: those turns were not waited for, so
 * announcing them would be news about nothing. The text is cleared when the
 * next run starts, so a second "Answer ready." is a change the screen
 * reader will actually announce, rather than the same text set again.
 *
 * Visually hidden, and always in the tree while the thread is: a live
 * region has to exist before its text changes for the change to be heard.
 */
export function AnswerAnnouncer(): ReactElement {
  const { status, messages } = useChatContext();
  const strings = useAskStrings();
  const [seenStatus, setSeenStatus] = useState(status);
  const [announcement, setAnnouncement] = useState("");

  // Set during render rather than in an effect: this is state derived from
  // a change in `status`, which React applies before the commit instead of
  // painting a frame with the stale announcement first.
  if (status !== seenStatus) {
    setSeenStatus(status);
    setAnnouncement(
      status === "streaming" ? "" : runFailed(messages) ? strings.answerFailed : strings.answerReady,
    );
  }

  return (
    <div className={a11y.visuallyHidden} role="status" aria-live="polite">
      {announcement}
    </div>
  );
}

/**
 * Whether the run that just ended failed. `useChat` appends the finished
 * turn before it sets `status` back to idle, a failed run included, so the
 * last message is always that run's.
 */
function runFailed(messages: ChatMessage[]): boolean {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return last?.role === "assistant" && last.runSummary?.status === "error";
}
