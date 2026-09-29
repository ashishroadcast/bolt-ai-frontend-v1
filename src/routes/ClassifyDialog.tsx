import { useState, type FormEvent } from "react";
import { CircleAlert, Lock, Unlock, X } from "lucide-react";
import { GatewayError } from "../ask/http/errors.ts";
import { setDocumentClassification, type DocumentRecord, type TagNode } from "./documentsApi.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
 *
 * The parent mounts this only while it is open, so the dialog is always
 * `open` and closing it (Cancel, the close button, Escape) is `onClose`.
 * A click outside does NOT close it: this is a form, and a stray click on
 * the scrim must not throw away a half-filed document.
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

const hintCode = "rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground";

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Named "Classify <file>" rather than by the visible title alone
          (the bare filename): `aria-labelledby` is dropped so the
          explicit label is the dialog's name, as it always was. */}
      <DialogContent
        aria-label={`Classify ${row.filename}`}
        aria-labelledby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader className="shrink-0 gap-1 border-b px-6 pt-5 pb-4 pr-12 text-left">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Classification</p>
            <DialogTitle className="text-base wrap-anywhere">{row.filename}</DialogTitle>
          </DialogHeader>

          {/* The body scrolls; the header and the Save/Cancel footer stay
              pinned, so the decision is always one click away. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="space-y-3 border-b px-6 py-5">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Filed under</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  One path per entry, deepest level last — <code className={hintCode}>ops/closing/cash-handling</code>.
                  A document can sit in more than one place. Filtering by <code className={hintCode}>ops</code> finds
                  everything below it.
                </p>
              </div>

              {tags.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <li
                      key={tag}
                      className="inline-flex items-center gap-0.5 rounded-md border border-primary/20 bg-primary/10 py-0.5 pr-0.5 pl-2 text-primary"
                    >
                      <span className="font-mono text-xs">{tag}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-5 text-primary hover:bg-primary/15 hover:text-primary"
                        onClick={() => setTags(tags.filter((each) => each !== tag))}
                        aria-label={`Remove ${tag}`}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex gap-2">
                <label className="sr-only" htmlFor="classify-tag">
                  Add a classification
                </label>
                <Input
                  id="classify-tag"
                  className="font-mono"
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
                <Button type="button" variant="outline" onClick={addDraftTag} disabled={draft.trim() === ""}>
                  Add
                </Button>
              </div>
            </section>

            <section className="space-y-3 px-6 py-5">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Who can see it</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  This decides what the agent may quote too, not just who sees the file listed here.
                </p>
              </div>

              <RadioGroup
                name="access"
                className="gap-2"
                value={restricted ? "restricted" : "everyone"}
                onValueChange={(value) => setRestricted(value === "restricted")}
              >
                <FieldLabel htmlFor="classify-access-everyone">
                  <Field orientation="horizontal">
                    <RadioGroupItem value="everyone" id="classify-access-everyone" />
                    <FieldContent>
                      <FieldTitle>
                        <Unlock className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Everyone who can read documents
                      </FieldTitle>
                    </FieldContent>
                  </Field>
                </FieldLabel>
                <FieldLabel htmlFor="classify-access-restricted">
                  <Field orientation="horizontal">
                    <RadioGroupItem value="restricted" id="classify-access-restricted" />
                    <FieldContent>
                      <FieldTitle>
                        <Lock className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Only people holding a permission
                      </FieldTitle>
                    </FieldContent>
                  </Field>
                </FieldLabel>
              </RadioGroup>

              {restricted && (
                <div>
                  <label className="sr-only" htmlFor="classify-permission">
                    Permission code
                  </label>
                  <Input
                    id="classify-permission"
                    className="font-mono"
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
                <p className="text-sm text-warning">Name the permission code, or choose “Everyone” instead.</p>
              )}
            </section>

            {error !== null && (
              <div className="px-6 pb-5">
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || blankRestriction}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
