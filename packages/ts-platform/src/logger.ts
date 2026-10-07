import { randomUUID } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

/** Fields that must never be logged. Contract: packages/contracts/logging.md */
export const REDACT_PATHS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.authorization",
  "*.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.idToken",
];

export function createLogger(
  service: string,
  options: { level?: string; destination?: DestinationStream } = {},
): Logger {
  return pino(
    {
      level: options.level ?? process.env["LOG_LEVEL"] ?? "info",
      base: { service },
      messageKey: "message",
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    options.destination,
  );
}

const CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Accept a well-formed incoming ID, otherwise mint one (never trust arbitrary header content). */
export function resolveCorrelationId(incoming: string | undefined): string {
  return incoming && CORRELATION_ID.test(incoming) ? incoming : randomUUID();
}

export const requestLogger = (logger: Logger, correlationId: string, extra: object = {}) =>
  logger.child({ correlationId, ...extra });
