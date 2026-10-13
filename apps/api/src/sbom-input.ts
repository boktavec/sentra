import { AppError } from "@sentra/ts-platform";
import { fieldsOf, isNumber, isString, type Json } from "./json.ts";

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });

/** Metadata only: the filename is shown back to users and never becomes part of the object key. */
export function validateNewSbom(body: Json | undefined, maxBytes: number) {
  const { filename, size_bytes: sizeBytes } = fieldsOf(body);

  if (!isString(filename)) throw invalid("filename");
  const trimmed = filename.trim();

  if (
    trimmed.length < 1 ||
    trimmed.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(trimmed) ||
    !trimmed.toLowerCase().endsWith(".json")
  ) {
    throw invalid("filename");
  }

  if (!isNumber(sizeBytes) || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw invalid("size_bytes");
  }

  if (sizeBytes > maxBytes) throw invalid("too_large");

  return { filename: trimmed, sizeBytes };
}
