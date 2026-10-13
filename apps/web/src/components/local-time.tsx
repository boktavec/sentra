"use client";

import { useEffect, useState } from "react";
import { formatLocal, formatUtc } from "@/lib/local-time";

/**
 * Renders an instant in UTC on the server and on the first client render (so hydration matches),
 * then switches to the viewer's local time with a zone abbreviation. The exact UTC ISO is the title.
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const [local, setLocal] = useState<string>();

  useEffect(() => setLocal(formatLocal(iso)), [iso]);

  return (
    <time dateTime={iso} title={iso} className={className}>
      {local ?? formatUtc(iso)}
    </time>
  );
}
