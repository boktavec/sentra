# Logging contract

Services write one JSON object per line to stdout.

| Field | Required | Notes |
| --- | --- | --- |
| `timestamp` | yes | ISO 8601 UTC |
| `level` | yes | `debug`, `info`, `warn`, `error` |
| `service` | yes | e.g. `api`, `web`, `crawler` |
| `message` | yes | Short event name, e.g. `auth_failure` |
| `correlationId` | in request/job scope | Accepted from `x-correlation-id` if it matches `^[A-Za-z0-9._-]{1,128}$`, otherwise generated |
| `userId` | when known | Sentra internal user UUID |
| `tenantId` | when known | Added with SENTRA-2 |

Never log: `authorization`, `cookie`, `password`, access/refresh/ID tokens, or raw sensitive payloads. Redaction is applied by default in the shared logger.

TypeScript implementation: `packages/ts-platform` (`createLogger`). Other languages implement this shape independently.
