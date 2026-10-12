import { AppError } from "./errors.ts";

/** RFC 9457 problem body. Contract: packages/contracts/error-response.md */
export interface Problem {
  type: string;
  title: string;
  status: number;
  correlationId: string;
}

export interface ErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: Problem;
}

/** The only place errors become responses. Unknown errors never leak details. */
export function toErrorResponse(err: Error, correlationId: string): ErrorResponse {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  const code = known ? err.code : "internal_error";
  const title = known ? err.message : "Internal server error";
  const headers = new Map([["content-type", "application/problem+json"]]);

  if (known && err.options.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(err.options.retryAfterSeconds));
  }

  return {
    status,
    headers: Object.fromEntries(headers),
    body: { type: `urn:sentra:error:${code}`, title, status, correlationId },
  };
}
