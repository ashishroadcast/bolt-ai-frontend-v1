import { Fragment, useMemo, type ReactElement, type ReactNode } from "react";
import {
  countChars,
  parseAnswer,
  takeChars,
  type AnswerBlock,
  type InlineSpan,
  type ListBlock,
  type TableBlock,
} from "./answerMarkup.ts";
import styles from "./AnswerText.module.css";

/**
 * One span. Bold is a `<strong>` and italic an `<em>` rather than styled
 * spans so the emphasis the agent wrote survives a screen reader and a
 * copy-paste into anything else, not only this stylesheet.
 */
function Span({ span }: { span: InlineSpan }): ReactNode {
  let node: ReactNode = span.text;
  if (span.code === true) node = <code className={styles.code}>{node}</code>;
  if (span.href !== undefined) {
    // Only ever an http(s) URL (`answerMarkup`'s LINK); the label is a
    // text node like everything else here.
    node = (
      <a className={styles.link} href={span.href} target="_blank" rel="noopener noreferrer">
        {node}
      </a>
    );
  }
  if (span.italic === true) node = <em>{node}</em>;
  if (span.bold) node = <strong>{node}</strong>;
  return node;
}

function Spans({ spans }: { spans: InlineSpan[] }): ReactElement {
  return (
    <>
      {spans.map((span, index) => (
        // Positional keys: these are a parse of one string, re-derived
        // whole on every render, never a reorderable list of entities —
        // the same convention Thread's own PartList uses.
        // eslint-disable-next-line react/no-array-index-key
        <Fragment key={index}>
          <Span span={span} />
        </Fragment>
      ))}
    </>
  );
}

/** Where the reveal has got to. Only ever one on the page. */
function Caret(): ReactElement {
  return <span className={styles.caret} aria-hidden="true" />;
}

/** A block's lines, each break kept, with the caret after the last one
 * when the reveal is still inside this block. */
function Lines({ lines, caret }: { lines: InlineSpan[][]; caret: boolean }): ReactElement {
  return (
    <>
      {lines.map((spans, lineIndex) => (
        // eslint-disable-next-line react/no-array-index-key
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <br />}
          <Spans spans={spans} />
          {caret && lineIndex === lines.length - 1 && <Caret />}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A list, numbered from wherever the source numbered it.
 *
 * The marker is drawn from `data-marker` rather than a CSS counter. A
 * counter reset per `<ol>` is exactly what made "3." render as "1." — and
 * a list the parser had to split in two, or nest under an item, restarted
 * from one each time. The number the agent wrote is the one it meant.
 */
function List({ block, caret }: { block: ListBlock; caret: boolean }): ReactElement {
  const last = block.items.length - 1;
  const items = block.items.map((item, itemIndex) => {
    const isLast = caret && itemIndex === last;
    const lastChild = item.children.length - 1;
    return (
      <li
        // eslint-disable-next-line react/no-array-index-key
        key={itemIndex}
        className={styles.item}
        data-marker={block.ordered ? `${block.start + itemIndex}.` : undefined}
        // Per item, not per answer: an Urdu store name in an English list
        // is one right-to-left line, and only that line should flip.
        dir="auto"
      >
        {/* One wrapper, so the item's two-column grid (marker, text) has
            exactly two items whatever the text holds — a nested list
            included. */}
        <div className={styles.itemBody}>
          <Lines lines={item.lines} caret={isLast && item.children.length === 0} />
          {item.children.map((child, childIndex) => (
            // eslint-disable-next-line react/no-array-index-key
            <Block key={childIndex} block={child} caret={isLast && childIndex === lastChild} />
          ))}
        </div>
      </li>
    );
  });
  if (!block.ordered) return <ul className={styles.bullets}>{items}</ul>;
  return (
    <ol
      className={styles.ordered}
      start={block.start === 1 ? undefined : block.start}
      // How wide the number column has to be: "10." does not fit where "9."
      // did, and a marker overlapping its own text reads as a typo.
      data-digits={String(block.start + last).length}
    >
      {items}
    </ol>
  );
}

/** The last cell with any text in it yet, or -1. */
function lastFilled(cells: InlineSpan[][]): number {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]!.length > 0) return index;
  }
  return -1;
}

/**
 * A table the agent wrote in markdown, as a real one.
 *
 * It scrolls sideways inside its own wrapper rather than widening the
 * answer: a six-column table in a 420px panel otherwise pushes the whole
 * conversation off the side of it.
 */
function Table({ block, caret }: { block: TableBlock; caret: boolean }): ReactElement {
  // The caret belongs after the last cell that has anything in it yet.
  const lastRow = block.rows.length - 1;
  const caretRow = caret ? (lastRow >= 0 ? lastRow : -1) : null;
  const caretCol = caretRow === null ? -1 : lastFilled(caretRow === -1 ? block.header : block.rows[lastRow]!);
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {block.header.map((cell, col) => (
              // eslint-disable-next-line react/no-array-index-key
              <th key={col} scope="col" data-align={block.align[col] ?? undefined}>
                <Spans spans={cell} />
                {caretRow === -1 && col === caretCol && <Caret />}
              </th>
            ))}
          </tr>
        </thead>
        {block.rows.length > 0 && (
          <tbody>
            {block.rows.map((row, rowIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={rowIndex}>
                {row.map((cell, col) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <td key={col} data-align={block.align[col] ?? undefined}>
                    <Spans spans={cell} />
                    {caretRow === rowIndex && col === caretCol && <Caret />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

/**
 * Any block below the top level — inside a list item or a quote. The top
 * level is the one place position means something (the finding, the
 * closing line), so it is laid out by `AnswerText` itself.
 */
function Block({ block, caret }: { block: AnswerBlock; caret: boolean }): ReactElement {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className={block.heading === true ? styles.heading : styles.paragraph} dir="auto">
          <Lines lines={block.lines} caret={caret} />
        </p>
      );
    case "list":
      return <List block={block} caret={caret} />;
    case "table":
      return <Table block={block} caret={caret} />;
    case "code":
      // Exempt from everything else in this file: no emphasis, no links, no
      // trimming. A sample is only useful exactly as written.
      return (
        <pre className={styles.codeBlock} data-lang={block.lang === "" ? undefined : block.lang}>
          <code>
            {block.text}
            {caret && <Caret />}
          </code>
        </pre>
      );
    case "quote": {
      const last = block.blocks.length - 1;
      return (
        <blockquote className={styles.quote}>
          {block.blocks.map((inner, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <Block key={index} block={inner} caret={caret && index === last} />
          ))}
        </blockquote>
      );
    }
  }
}

/**
 * Whether a paragraph is short enough to be set as the finding.
 *
 * One line and about a sentence. The prompt asks for ten words; this is
 * the renderer refusing to amplify an answer that ignored it, because the
 * cost of guessing wrong in the other direction is a page of headline.
 */
const LEAD_MAX_CHARS = 120;

/**
 * Openings that are not a finding however short they are: an apology, or
 * the topic guard's refusal ("I can only help with questions about our
 * menu…", `agent-service`'s `_DEFAULT_REFUSAL`). Set as the headline, a
 * refusal arrived in display bold with the accent rule under it — dressed
 * as the answer to a question it had just declined.
 */
const NOT_A_FINDING =
  /^(?:sorry\b|i'm sorry|i am sorry|i apologi[sz]e|unfortunately\b|i (?:can only|cannot|can't|am unable|'m unable|am not able|'m not able|do not have|don't have)\b)/i;

function isHeadline(block: AnswerBlock | undefined): boolean {
  // A `## Heading` labels what follows it; it is not what was found.
  if (block?.kind !== "paragraph" || block.heading === true) return false;
  if (block.lines.length !== 1) return false;
  const text = block.lines[0]!.map((span) => span.text).join("").trim();
  if (text.length === 0 || text.length > LEAD_MAX_CHARS) return false;
  // A question back to the reader ("Which store do you mean?") is the
  // agent asking, not answering.
  if (text.endsWith("?")) return false;
  return !NOT_A_FINDING.test(text.replace(/\u2019/g, "'"));
}

/**
 * Which top-level blocks are the finding and the closing line — decided
 * from the WHOLE answer, never from the part the reveal has reached.
 *
 * It used to be decided per frame from the revealed slice, so the voice of
 * a block changed under the reader as it arrived: a 130-character opening
 * was set as the 18px headline for its first 120 characters and snapped to
 * body text at the 121st, and a two-line opening was a headline until its
 * second line began. Deciding once from the full parse means a block is
 * drawn in the voice it will finish in from its first character.
 */
function voicesOf(blocks: AnswerBlock[]): { lead: boolean; closing: number } {
  const lead = isHeadline(blocks[0]);
  const last = blocks.length - 1;
  const tail = blocks[last];
  const closing =
    last > 0 &&
    tail?.kind === "paragraph" &&
    tail.heading !== true &&
    blocks.some((block) => block.kind === "list")
      ? last
      : -1;
  return { lead, closing };
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
  const voices = useMemo(() => voicesOf(blocks), [blocks]);

  const isRevealing = visibleChars !== undefined && visibleChars < total;
  const shown = isRevealing ? takeChars(blocks, visibleChars) : blocks;
  if (shown.length === 0) return null;

  const lastBlock = shown.length - 1;

  return (
    <div className={styles.prose}>
      {shown.map((block, index) => {
        const caret = isRevealing && index === lastBlock;
        if (block.kind !== "paragraph" || block.heading === true) {
          // eslint-disable-next-line react/no-array-index-key
          return <Block key={index} block={block} caret={caret} />;
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
        //
        // Both from the whole answer (`voicesOf`): `shown` is a prefix of
        // `blocks`, so an index into one is the same block in the other.
        const isLead = index === 0 && voices.lead;
        const isClosing = index === voices.closing;
        return (
          // eslint-disable-next-line react/no-array-index-key
          <p
            key={index}
            className={isLead ? styles.lead : isClosing ? styles.closing : styles.paragraph}
            // Each paragraph finds its own direction from its first strong
            // character, so an answer in Arabic or Urdu aligns to the right
            // without the page having to know what language it is in.
            dir="auto"
          >
            {/* One wrapper, so the closing line's two-column grid (arrow,
                text) has exactly two items. Without it every <strong> or
                <a> in the line became its own grid item and wrapped into
                the 16px arrow column, one letter per line. */}
            <span>
              <Lines lines={block.lines} caret={caret} />
            </span>
          </p>
        );
      })}
    </div>
  );
}
