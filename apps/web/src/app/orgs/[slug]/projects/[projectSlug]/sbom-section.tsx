"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkFile,
  dependencySummary,
  formatBytes,
  isActive,
  reasonMessage,
  STATUS_LABELS,
  type SbomImport,
} from "@/lib/sbom-format";
import { completeUpload, refreshImports, startUpload } from "./sbom-actions";

const POLL_MS = 3000;

/** The browser sends the bytes straight to object storage; the API never sees them. Returns an error message, or null. */
async function sendToStorage(
  upload: { url: string; fields: Record<string, string> },
  file: File,
): Promise<string | null> {
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append("file", file); // storage requires the file to be the last field
  try {
    const stored = await fetch(upload.url, { method: "POST", body: form });
    return stored.ok ? null : "Storage refused the file. It may be larger than 10 MiB. Try again.";
  } catch {
    return "The file could not be sent to storage. Check your connection and try again.";
  }
}

/** The three-step flow: reserve an import, send the file to storage, then complete it. Returns an error message, or null. */
async function runUpload(
  orgId: string,
  projectSlug: string,
  file: File,
  onReserved: () => Promise<void>,
): Promise<string | null> {
  const ticket = await startUpload(orgId, projectSlug, file.name, file.size);
  if (!ticket.ok) return ticket.error;
  await onReserved(); // show the pending import while the file is on its way
  const refused = await sendToStorage(ticket.data.upload, file);
  if (refused) return refused;
  const done = await completeUpload(orgId, projectSlug, ticket.data.id);
  return done.ok ? null : done.error;
}

function ImportsTable({ imports }: { imports: SbomImport[] }) {
  return (
    <table data-testid="sbom-list">
      <thead>
        <tr>
          <th>File</th>
          <th>Size</th>
          <th>Status</th>
          <th>Uploaded</th>
        </tr>
      </thead>
      <tbody>
        {imports.map((item) => (
          <tr key={item.id} data-testid="sbom-row">
            <td>{item.filename}</td>
            <td>{formatBytes(item.sizeBytes)}</td>
            <td>
              <strong data-testid="sbom-status">{STATUS_LABELS[item.status]}</strong>
              {item.status === "parsed" && (
                <>
                  {" "}
                  <span data-testid="sbom-dependencies">{dependencySummary(item)}</span>
                </>
              )}
              {item.status === "rejected" && (
                <>
                  {" "}
                  <span data-testid="sbom-reason">{reasonMessage(item.reasonCode)}</span>
                </>
              )}
            </td>
            <td>{new Date(item.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SbomSection({
  orgId,
  projectSlug,
  initial,
}: {
  orgId: string;
  projectSlug: string;
  initial: SbomImport[];
}) {
  const [imports, setImports] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const result = await refreshImports(orgId, projectSlug);
    if (result.ok) setImports(result.data);
  }, [orgId, projectSlug]);

  const active = imports.some((i) => isActive(i.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function upload(file: File) {
    const problem = checkFile(file.name, file.size);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      setError(await runUpload(orgId, projectSlug, file, refresh));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      await refresh();
    }
  }

  return (
    <section>
      <h2>SBOM uploads</h2>
      <p>
        <label>
          Upload a CycloneDX JSON SBOM (up to 10 MiB) <br />
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            disabled={busy}
            data-testid="sbom-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </p>
      {error && (
        <p role="alert" data-testid="sbom-error">
          {error}
        </p>
      )}
      {imports.length === 0 ? (
        <p data-testid="no-sboms">No SBOMs uploaded yet.</p>
      ) : (
        <ImportsTable imports={imports} />
      )}
    </section>
  );
}
