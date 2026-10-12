import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SeverityLevel } from "@/lib/badge-status";

// Full class names so Tailwind can see them.
const LEVEL_CLASSES: Record<SeverityLevel, string> = {
  critical: "bg-severity-critical text-severity-critical-foreground",
  high: "bg-severity-high text-severity-high-foreground",
  medium: "bg-severity-medium text-severity-medium-foreground",
  low: "bg-severity-low text-severity-low-foreground",
  info: "bg-severity-info text-severity-info-foreground",
};

const LEVEL_LABELS: Record<SeverityLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** Always shows the level as text; the color is a secondary signal. */
export function SeverityBadge({ level, className }: { level: SeverityLevel; className?: string }) {
  return (
    <Badge data-severity={level} className={cn(LEVEL_CLASSES[level], className)}>
      {LEVEL_LABELS[level]}
    </Badge>
  );
}
