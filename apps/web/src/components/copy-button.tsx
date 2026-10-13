"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type CopyStatus = "idle" | "copied" | "failed";

const STATUS_TEXT: Record<CopyStatus, string> = {
  idle: "",
  copied: "Copied",
  failed: "Copy failed, select the link instead",
};

/** Copies `text` on an explicit click and announces the result in a live region. */
export function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      // Denied, or unavailable on an insecure origin; the text stays selectable.
      setStatus("failed");
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {label}
      </Button>
      <span aria-live="polite" className="text-sm text-muted-foreground">
        {STATUS_TEXT[status]}
      </span>
    </div>
  );
}
