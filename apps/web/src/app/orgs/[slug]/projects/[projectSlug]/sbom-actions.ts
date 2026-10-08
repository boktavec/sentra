"use server";

import { apiGet, apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";
import { sbomsPath, type SbomPage } from "@/lib/sbom";
import { apiErrorMessage, type SbomImport } from "@/lib/sbom-format";

export interface UploadTicket {
  id: string;
  upload: { url: string; fields: Record<string, string> };
}

type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

const fail = (r: { status: number; correlationId: string; code?: string }) => ({
  ok: false as const,
  error:
    apiErrorMessage(r.status, r.code) ??
    `The service is temporarily unavailable. Reference: ${r.correlationId}`,
});

/** Step 1: the API picks the storage key and signs the upload; only filename and size come from the user. */
export async function startUpload(
  orgId: string,
  projectSlug: string,
  filename: string,
  sizeBytes: number,
): Promise<Outcome<UploadTicket>> {
  const r = await callApi((token) =>
    apiPost<UploadTicket>(sbomsPath(orgId, projectSlug), token, {
      filename,
      size_bytes: sizeBytes,
    }),
  );
  return r.ok ? { ok: true, data: r.data } : fail(r);
}

/** Step 3: tell the API the file is in storage so processing can begin. */
export async function completeUpload(
  orgId: string,
  projectSlug: string,
  importId: string,
): Promise<Outcome<SbomImport>> {
  const r = await callApi((token) =>
    apiPost<SbomImport>(
      `${sbomsPath(orgId, projectSlug)}/${encodeURIComponent(importId)}/complete`,
      token,
      undefined,
    ),
  );
  return r.ok ? { ok: true, data: r.data } : fail(r);
}

/** Used by the list while any import is still in progress. */
export async function refreshImports(
  orgId: string,
  projectSlug: string,
): Promise<Outcome<SbomImport[]>> {
  const r = await callApi((token) =>
    apiGet<SbomPage>(`${sbomsPath(orgId, projectSlug)}?limit=20`, token),
  );
  return r.ok ? { ok: true, data: r.data.items } : fail(r);
}
