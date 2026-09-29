import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";

interface EmptyStateProps {
  /** A lucide icon component, not a unicode glyph — the glyphs this
   * console shipped with (▸ ▤ ◇ ◈ ⚑) read as broken placeholder characters
   * rather than icons (redesign brief). Rendered in a tinted tile
   * (--signal-soft behind a --signal icon) so an empty screen still carries
   * the accent instead of reading as bare grey. */
  icon: LucideIcon;
  title: string;
  /** One line, maybe two — an empty screen is an invitation to act, not a
   * paragraph to read (redesign brief: "tighten to a line or two"). */
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon: Icon, title, body, actionLabel, onAction }: EmptyStateProps) {
  return (
    <Empty className="border bg-card">
      <EmptyHeader>
        <EmptyMedia variant="icon" aria-hidden="true">
          <Icon />
        </EmptyMedia>
        {/* An h2 (EmptyTitle is a div): screen readers navigate an empty
            screen by its heading. */}
        <h2 data-slot="empty-title" className="text-lg font-medium tracking-tight">
          {title}
        </h2>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {actionLabel !== undefined && (
        <EmptyContent>
          <Button type="button" onClick={onAction}>
            {actionLabel}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
}
