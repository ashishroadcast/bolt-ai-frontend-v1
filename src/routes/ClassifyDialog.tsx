import { useState, type FormEvent } from "react";
import { Lock, Unlock, X } from "lucide-react";
import { GatewayError } from "../ask/http/errors.ts";
import { setDocumentClassification, type DocumentRecord, type TagNode } from "./documentsApi.ts";
import styles from "./ClassifyDialog.module.css";

/*
 * Editing one document's filing and its access, in one place, because
 * they are one decision: an operator restricting the payroll SOP is
 * filing it under `finance/payroll` in the same breath. Splitting them
 * into two dialogs would let someone tag a document and walk away
 * believing they had also protected it.
 *
 * The tag input is a path, typed whole (`ops/closing/cash-handling`),
 * with a datalist of every path already in use. That follows the model
 * the server actually stores (`app.knowledge.classification`: the
 * hierarchy IS the path) rather than pretending to be a tree picker over
 * nodes that do not exist as rows — a picker would have to invent
 * "create this level" affordances for a level that only comes into being
 * when a document is filed under it.
 *
 * Access is a two-state radio plus a code, not a free text field that
 * happens to accept the empty string: "Everyone" has to be a thing you
 * choose, visibly, rather than the result of clearing a box.
 */

interface ClassifyDialogProps {
  document: DocumentRecord;
  /** Every path already in use in this corpus — suggestions only; the
   * operator can always type a new one. */
  knownTags: TagNode[];
  /** Codes already used as a restriction somewhere in the visible list,
   * so the second document behind a permission does not need the code
   * retyped from memory. */
  knownPermissions: string[];
  onClose: () => void;
  onSaved: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof GatewayError
    ? err.message
    : "Couldn't reach the gateway. Check your connection and try again.";
}

export function ClassifyDialog({
  document: row,
  knownTags,
  knownPermissions,
  onClose,
  onSaved,
}: ClassifyDialogProps) {
  const [tags, setTags] = useState<string[]>(row.tags);
  const [draft, setDraft] = useState("");
  const [restricted, setRestricted] = useState(row.required_permission !== null);
  const [permission, setPermission] = useState(row.required_permission ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addDraftTag() {
    const value = draft.trim();
    if (value === "") return;
    // Compared case-insensitively because the server lowercases on the way
    // in — otherwise "Ops" and "ops" would look like two chips here and
    // collapse into one after saving.
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTags([...tags, value]);
    }
    setDraft("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setDocumentClassification(row.id, {
        tags,
        // A restriction the operator switched on but left blank is a
        // document nobody can read — refused here rather than sent, since
        // the server would normalise the empty string back to "everyone"
        // and silently do the opposite of what the switch says.
        required_permission: restricted ? permission.trim() : null,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  const blankRestriction = restricted && permission.trim() === "";

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label={`Classify ${row.filename}`}>
      <form className={styles.panel} onSubmit={(event) => void handleSubmit(event)}>
        <header className={styles.head}>
          <div>
            <p className={styles.kicker}>Classification</p>
            <h2 className={styles.title}>{row.filename}</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Filed under</h3>
          <p className={styles.hint}>
            One path per entry, deepest level last — <code>ops/closing/cash-handling</code>. A document can sit in
            more than one place. Filtering by <code>ops</code> finds everything below it.
          </p>

          {tags.length > 0 && (
            <ul className={styles.chips}>
              {tags.map((tag) => (
                <li key={tag} className={styles.chip}>
                  <span className={styles.chipPath}>{tag}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => setTags(tags.filter((each) => each !== tag))}
                    aria-label={`Remove ${tag}`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={styles.addRow}>
            <label className={styles.visuallyHidden} htmlFor="classify-tag">
              Add a classification
            </label>
            <input
              id="classify-tag"
              className={styles.input}
              list="classify-tag-suggestions"
              placeholder="ops/closing/cash-handling"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Enter adds a tag; it must not submit the form, or the
                // half-typed path would be saved as nothing.
                event.preventDefault();
                addDraftTag();
              }}
            />
            <datalist id="classify-tag-suggestions">
              {knownTags.map((node) => (
                <option key={node.path} value={node.path} />
              ))}
            </datalist>
            <button type="button" className={styles.secondary} onClick={addDraftTag} disabled={draft.trim() === ""}>
              Add
            </button>
          </div>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Who can see it</h3>
          <p className={styles.hint}>
            This decides what the agent may quote too, not just who sees the file listed here.
          </p>

          <div className={styles.choices}>
            <label className={styles.choice}>
              <input
                type="radio"
                name="access"
                checked={!restricted}
                onChange={() => setRestricted(false)}
              />
              <Unlock size={13} strokeWidth={2} aria-hidden="true" />
              <span>Everyone who can read documents</span>
            </label>
            <label className={styles.choice}>
              <input
                type="radio"
                name="access"
                checked={restricted}
                onChange={() => setRestricted(true)}
              />
              <Lock size={13} strokeWidth={2} aria-hidden="true" />
              <span>Only people holding a permission</span>
            </label>
          </div>

          {restricted && (
            <div className={styles.addRow}>
              <label className={styles.visuallyHidden} htmlFor="classify-permission">
                Permission code
              </label>
              <input
                id="classify-permission"
                className={styles.input}
                list="classify-permission-suggestions"
                placeholder="finance.reports"
                value={permission}
                onChange={(event) => setPermission(event.target.value)}
              />
              <datalist id="classify-permission-suggestions">
                {knownPermissions.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
            </div>
          )}
          {blankRestriction && (
            <p className={styles.warn}>Name the permission code, or choose “Everyone” instead.</p>
          )}
        </section>

        {error !== null && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <footer className={styles.foot}>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={styles.primary} disabled={saving || blankRestriction}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
