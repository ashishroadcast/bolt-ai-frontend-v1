import { Fragment, useMemo, type ReactElement } from "react";
import { countChars, parseAnswer, takeChars, type InlineSpan } from "./answerMarkup.ts";
import styles from "./AnswerText.module.css";

/**
 * One line's worth of spans. Bold is a `<strong>` rather than a styled
 * span so the emphasis the agent wrote survives a screen reader and a
 * copy-paste into anything else, not only this stylesheet.
 */
function Spans({ spans }: { spans: InlineSpan[] }): ReactElement {
  return (
    <>
      {spans.map((span, index) =>
        span.href !== undefined ? (
          // Only ever an http(s) URL (`answerMarkup`'s LINK); the label is a
          // text node like everything else here.
          // eslint-disable-next-line react/no-array-index-key
          <a key={index} className={styles.link} href={span.href} target="_blank" rel="noopener noreferrer">
            {span.text}
          </a>
        ) : span.bold ? (
          // Positional keys: these are a parse of one string, re-derived
          // whole on every render, never a reorderable list of entities —
          // the same convention Thread's own PartList uses.
          // eslint-disable-next-line react/no-array-index-key
          <strong key={index}>{span.text}</strong>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <Fragment key={index}>{span.text}</Fragment>
        ),
      )}
    </>
  );
}


/**
 * Whether a paragraph is short enough to be set as the finding.
 *
 * One line and about a sentence. The prompt asks for ten words; this is
 * the renderer refusing to amplify an answer that ignored it, because the
 * cost of guessing wrong in the other direction is a page of headline.
 */
const LEAD_MAX_CHARS = 120;

function isHeadline(block: { kind: "paragraph"; lines: InlineSpan[][] }): boolean {
  if (block.lines.length !== 1) return false;
  const length = block.lines[0]!.reduce((total, span) => total + span.text.length, 0);
  return length > 0 && length <= LEAD_MAX_CHARS;
}

export interface AnswerTextProps {
  text: string;
  /**
   * How much of the answer to show, for a reveal in progress
   * (`typewriter.ts`). Omitted means all of it — a reopened conversation,
   * an answer already read, or anyone who has asked for reduced motion.
   */
  visibleChars?: number;
}

/**
 * The agent's answer, laid out the way it was written.
 *
 * The agent is prompted to lead with one sentence and then put three or
 * more things on their own `- ` lines (`seed_agent_prompts.py`). Until
 * now every one of those reached the reader as a literal hyphen inside a
 * single pre-wrapped block, so the answer that was meant to be skimmed
 * read as a paragraph with punctuation in it.
 *
 * **Model output can never become markup here.** `parseAnswer` returns
 * plain strings and this component puts every one of them in a text node
 * — there is no `dangerouslySetInnerHTML` anywhere in the path, so an
 * answer containing `<img onerror=…>` renders as a sentence about an
 * image tag. That is the whole reason this is a small renderer rather
 * than a markdown dependency.
 *
 * The parse is memoised on the text, so a reveal ticking sixty times a
 * second cuts an existing block tree down rather than rebuilding one.
 */
export function AnswerText({ text, visibleChars }: AnswerTextProps): ReactElement | null {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  const total = useMemo(() => countChars(blocks), [blocks]);

  const isRevealing = visibleChars !== undefined && visibleChars < total;
  const shown = isRevealing ? takeChars(blocks, visibleChars) : blocks;
  if (shown.length === 0) return null;

  const lastBlock = shown.length - 1;

  return (
    <div className={styles.prose}>
      {shown.map((block, index) => {
        const runs = block.kind === "paragraph" ? block.lines : block.items;
        const lastRun = runs.length - 1;
        const caretAfter = (runIndex: number) =>
          isRevealing && index === lastBlock && runIndex === lastRun ? (
            <span className={styles.caret} aria-hidden="true" />
          ) : null;

        if (block.kind === "list") {
          const items = block.items.map((spans, itemIndex) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={itemIndex} className={styles.item}>
              <span>
                <Spans spans={spans} />
                {caretAfter(itemIndex)}
              </span>
            </li>
          ));
          return block.ordered ? (
            // eslint-disable-next-line react/no-array-index-key
            <ol key={index} className={styles.ordered}>
              {items}
            </ol>
          ) : (
            // eslint-disable-next-line react/no-array-index-key
            <ul key={index} className={styles.bullets}>
              {items}
            </ul>
          );
        }
        // The three voices in an answer, told apart by position — no
        // protocol change, because which paragraph is the headline is a
        // presentation decision and belongs here.
        //
        // The prompt asks for exactly this shape: one line carrying the
        // answer, then observations, then one line on what to look at
        // next. Rendering all three at the same size and weight is what
        // made a considered reading look like an undesigned block of grey
        // — the one thing on screen that wasn't a designed object.
        // A headline is one SHORT line. When it isn't — the model wrote a
        // nine-line paragraph with no bullets at all — this must fall back
        // to ordinary prose rather than setting the whole wall in 18px
        // display bold, which is what a styling rule doing the opposite of
        // containing a content failure looks like. Observed exactly once
        // and it was the ugliest thing this console has rendered.
        const isLead = index === 0 && block.kind === "paragraph" && isHeadline(block);
        const isClosing =
          !isLead && index === shown.length - 1 && shown.some((b) => b.kind === "list");
        return (
          // eslint-disable-next-line react/no-array-index-key
          <p
            key={index}
            className={isLead ? styles.lead : isClosing ? styles.closing : styles.paragraph}
          >
            {/* One wrapper, so the closing line's two-column grid (arrow,
                text) has exactly two items. Without it every <strong> or
                <a> in the line became its own grid item and wrapped into
                the 16px arrow column, one letter per line. */}
            <span>
              {block.lines.map((spans, lineIndex) => (
                // eslint-disable-next-line react/no-array-index-key
                <Fragment key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  <Spans spans={spans} />
                  {caretAfter(lineIndex)}
                </Fragment>
              ))}
            </span>
          </p>
        );
      })}
    </div>
  );
}
