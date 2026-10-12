import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type StatusName } from "@/lib/badge-status";

// Full class names so Tailwind can see them.
const STATUS_CLASSES: Record<StatusName, string> = {
  open: "bg-status-open text-status-open-foreground",
  resolved: "bg-status-resolved text-status-resolved-foreground",
  kev: "bg-status-kev text-status-kev-foreground",
  queued: "bg-status-queued text-status-queued-foreground",
  running: "bg-status-running text-status-running-foreground",
  succeeded: "bg-status-succeeded text-status-succeeded-foreground",
  failed: "bg-status-failed text-status-failed-foreground",
};

/** Always shows the status as text; the color is a secondary signal. */
export function StatusBadge({ status, className }: { status: StatusName; className?: string }) {
  return (
    <Badge data-status={status} className={cn(STATUS_CLASSES[status], className)}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
