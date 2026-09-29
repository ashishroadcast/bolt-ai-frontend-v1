import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageHeaderProps {
  /** e.g. "Build" — the nav group this screen belongs to. */
  kicker: string;
  title: string;
  /** Rendered after the title, inline — a status pill on a detail page. */
  titleAdornment?: ReactNode;
  /** Optional: a screen whose content is self-evident should omit this
   *  rather than write filler to fill the slot. */
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

/**
 * The one header pattern, on every screen: breadcrumb and title on one
 * line, a quiet description beside them, the primary action right.
 *
 * It used to stack an eyebrow, a 28px title and a paragraph vertically —
 * roughly 180px of chrome above tables of four rows, which was most of
 * what "too much space waste" was pointing at. Everything here is one row
 * now, and `description` is optional so a self-evident screen can simply
 * not have one.
 *
 * The action is optional too — the Agents list has none, because creating
 * an agent isn't something this console can do yet (no backend endpoint;
 * see AgentsRoute's own docstring rather than a disabled button that
 * implies one exists).
 */
export function PageHeader({
  kicker,
  title,
  titleAdornment,
  description,
  actionLabel,
  onAction,
  actionDisabled,
}: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b pb-5">
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{kicker}</p>
        <h2 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {title}
          {titleAdornment}
        </h2>
        {description !== undefined && description !== "" && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actionLabel !== undefined && (
        <Button type="button" onClick={onAction} disabled={actionDisabled}>
          <Plus aria-hidden="true" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
