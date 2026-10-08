import { AppError } from "@sentra/ts-platform";

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });

/** Metadata only: the filename is shown back to users and never becomes part of the object key. */
export function validateNewSbom(
  body: unknown,
  maxBytes: number,
): { filename: string; sizeBytes: number } {
  const { filename, size_bytes: sizeBytes } = (body ?? {}) as Record<string, unknown>;
  if (typeof filename !== "string") throw invalid("filename");
  const trimmed = filename.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(trimmed) ||
    !trimmed.toLowerCase().endsWith(".json")
  ) {
    throw invalid("filename");
  }
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw invalid("size_bytes");
  }
  if (sizeBytes > maxBytes) throw invalid("too_large");
  return { filename: trimmed, sizeBytes };
}
