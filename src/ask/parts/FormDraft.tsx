import { ArrowUpRight, ClipboardList } from "lucide-react";
import { useState, type ReactElement } from "react";
import {
  useAskConfig,
  type FormDraftHandoff,
  type FormDraftHandoffField,
} from "../config.tsx";
import { DraftNotAllowed, draftBlock } from "./DraftNotAllowed.tsx";
import styles from "./FormDraft.module.css";

/**
 * The card's props ARE the handoff shape, aliased rather than restated.
 *
 * Two declarations of the same object would drift, and the direction they
 * would drift in is the damaging one: this component is what the reader sees,
 * and `FormDraftHandoff` is what the host acts on, so a field present in one
 * and missing from the other means a form that was reviewed and a different
 * form that got built. `app/agent/formdraft.py` is the far end of the same
 * contract.
 */
export type FormDraftField = FormDraftHandoffField;
export type FormDraftProps = FormDraftHandoff;

/**
 * The words the create palette itself uses (`form-create.component.ts`).
 *
 * Deliberately not prettified versions of the wire names: the reader is
 * about to open this in that builder and pick these same types out of that
 * same dropdown, and a card that calls something "Single line" while the
 * builder calls it "Text" makes them check whether the two agree.
 */
const TYPE_LABELS: Record<string, string> = {
  text: "Single line",
  textarea: "Paragraph",
  radio: "Multiple choice",
  select: "Drop down",
  url: "URL",
  number: "Number",
  email: "Email",
  date: "Date",
  file: "File upload",
  currency: "Currency",
};

/**
 * When a workflow form appears, as a sentence.
 *
 * Keyed on the PAIR rather than composed from a module word and an event
 * word, because the two do not compose into English: "a ETA trip starts",
 * "an attendance checkout happens". There are four pairs in total — the
 * builder's own dropdowns offer no others — so the table is the whole
 * vocabulary rather than a sample of it.
 */
const TRIGGER_LINES: Record<string, string> = {
  "eta_trip:start": "Appears when a trip starts",
  "eta_trip:end": "Appears when a trip ends",
  "attendance:checkin": "Appears at attendance check-in",
  "attendance:checkout": "Appears at attendance check-out",
};

/**
 * How many fields show before the rest fold away.
 *
 * Eight because the panel this renders in is 420px wide and a real form runs
 * to a dozen or more: past eight rows the card stops being something the eye
 * takes in and becomes a page to scroll, which buries the one control that
 * matters. Folded, never dropped — the reader is deciding whether to open
 * this, and a card that hides half the form is asking them to decide blind.
 */
const FIELDS_BEFORE_FOLD = 8;

function triggerLine(module: string | undefined, event: string | undefined): string | null {
  if (module === undefined || event === undefined) return null;
  // A pair this bundle predates still says something true, if less fluent,
  // rather than leaving the reader with no idea when the form will fire.
  return (
    TRIGGER_LINES[`${module}:${event}`] ??
    `Appears on ${module.replace(/_/g, " ")} ${event.replace(/_/g, " ")}`
  );
}

function FieldRow({ field }: { field: FormDraftField }): ReactElement {
  const typeLabel = TYPE_LABELS[field.type] ?? field.type;
  return (
    <li className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{field.label}</span>
        {field.required && (
          <span className={styles.required} title="Required">
            Required
          </span>
        )}
      </div>
      <div className={styles.fieldMeta}>
        <span className={styles.type}>{typeLabel}</span>
        {field.options !== undefined && field.options.length > 0 && (
          // The choices are most of what makes a choice field right or wrong,
          // and they are the thing the reader is most likely to want changed.
          <span className={styles.options}>{field.options.join(" · ")}</span>
        )}
      </div>
    </li>
  );
}

/**
 * A form the agent has drafted, for the reader to review and then open in
 * bolt-v2's Form Manager.
 *
 * **Nothing here has been created.** The card is a proposal: the run wrote
 * it, the reader reads it, and publishing happens in the builder under their
 * own session. That is why the primary action says "Open in builder" and not
 * "Create" — and why this component has no error state, no saving state and
 * no success state, because it does not write.
 *
 * `onFormDraft` comes from the host, not the wire. A host with no form
 * manager to open — the Bolty console, or any other embed — supplies none,
 * and the card then renders as a read-only summary rather than offering a
 * button that goes nowhere.
 */
export function FormDraft({
  name,
  description,
  category,
  formType,
  triggerModule,
  triggerEvent,
  fields,
}: FormDraftProps): ReactElement {
  const { onFormDraft, draftAccess } = useAskConfig();
  const [expanded, setExpanded] = useState(false);

  const ordered = [...fields].sort((first, second) => first.order - second.order);
  const folds = !expanded && ordered.length > FIELDS_BEFORE_FOLD + 1;
  const shown = folds ? ordered.slice(0, FIELDS_BEFORE_FOLD) : ordered;
  const hidden = ordered.length - shown.length;

  const trigger = triggerLine(triggerModule, triggerEvent);
  const count = `${ordered.length} field${ordered.length === 1 ? "" : "s"}`;

  // After the hooks above, which must run on every render either way.
  const block = draftBlock("form", draftAccess);
  if (block !== null) return <DraftNotAllowed block={block} />;

  return (
    <section className={styles.draft} aria-label={`Draft form: ${name}`}>
      <header className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <ClipboardList size={13} strokeWidth={2.25} />
        </span>
        <div className={styles.heading}>
          <h3 className={styles.title}>{name}</h3>
          <p className={styles.sub}>
            {count} · {formType === "workflow" ? "Workflow" : "Standalone"} · {category}
          </p>
        </div>
      </header>

      <div className={styles.body}>
        <p className={styles.description}>{description}</p>
        {trigger !== null && <p className={styles.trigger}>{trigger}</p>}

        <ol className={styles.fields}>
          {shown.map((field) => (
            <FieldRow key={`${field.order}-${field.label}`} field={field} />
          ))}
        </ol>

        {folds && (
          <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
            Show {hidden} more
          </button>
        )}
      </div>

      {onFormDraft !== undefined && (
        <footer className={styles.foot}>
          <button
            type="button"
            className={styles.open}
            onClick={() =>
              onFormDraft({
                name,
                description,
                category,
                formType,
                triggerModule,
                triggerEvent,
                fields: ordered,
              })
            }
          >
            Open in builder
            <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
          </button>
          {/* Said plainly, because the button leaves this panel and lands on a
              builder that looks finished. Nothing has been saved yet, and a
              reader who assumes otherwise will close the tab. */}
          <span className={styles.note}>Nothing is saved until you publish it there.</span>
        </footer>
      )}
    </section>
  );
}
