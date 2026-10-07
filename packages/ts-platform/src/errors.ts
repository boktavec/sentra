/**
 * Typed application errors. `message` is safe to show clients; `reason` and
 * `cause` are for logs and metrics only and must never reach a response body.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly options: { reason?: string; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
  }

  get reason(): string | undefined {
    return this.options.reason;
  }
}

export const unauthenticated = (reason: string, cause?: unknown) =>
  new AppError("unauthenticated", 401, "Authentication required", { reason, cause });

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError("rate_limited", 429, "Too many requests", {
    reason: "rate_limited",
    retryAfterSeconds,
  });

export const unavailable = (reason: string, cause?: unknown) =>
  new AppError("unavailable", 503, "Service temporarily unavailable", { reason, cause });
