/** Pure helpers shared by the upload form and its tests. The API stays authoritative for every rule. */

export const MAX_SBOM_BYTES = 10 * 1024 * 1024;

export type SbomStatus = "pending_upload" | "uploaded" | "validated" | "rejected" | "expired";

export interface SbomImport {
  id: string;
  filename: string;
  status: SbomStatus;
  reasonCode: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export const STATUS_LABELS: Record<SbomStatus, string> = {
  pending_upload: "Uploading",
  uploaded: "Validating",
  validated: "Validated",
  rejected: "Rejected",
  expired: "Expired",
};

const REASONS: Record<string, string> = {
  size: "The file is empty or larger than 10 MiB.",
  not_json: "The file is not valid JSON.",
  not_cyclonedx: "The file is JSON but not a CycloneDX SBOM.",
  unsupported_version: "This CycloneDX version is not supported yet.",
  processing_failed: "Sentra could not process the file. Upload it again.",
};

export const reasonMessage = (code: string | null) =>
  code ? (REASONS[code] ?? "The file was rejected.") : "";

/** Imports still moving through the pipeline; the list keeps refreshing while any exist. */
export const isActive = (status: SbomStatus) =>
  status === "pending_upload" || status === "uploaded";

/** A message for a file the browser should not even send, or null when it looks fine. */
export function checkFile(name: string, size: number): string | null {
  if (!name.toLowerCase().endsWith(".json")) {
    return "Choose a CycloneDX JSON file (.json).";
  }
  if (size === 0) return "That file is empty.";
  if (size > MAX_SBOM_BYTES) return "That file is larger than 10 MiB.";
  return null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** What the user sees when the API refuses a step of the upload. */
export function apiErrorMessage(status: number, code?: string): string | null {
  if (status === 429)
    return "This project already has the maximum number of uploads in progress. Wait a few minutes and try again.";
  if (status === 404) return "That project was not found.";
  if (status === 400) return "That file cannot be uploaded. Check the name and size.";
  if (status === 409) {
    if (code === "expired") return "The upload took too long and expired. Start again.";
    if (code === "upload_missing") return "The file did not reach storage. Try uploading again.";
    if (code === "upload_invalid") return "The uploaded file was empty or too large.";
  }
  return null;
}
