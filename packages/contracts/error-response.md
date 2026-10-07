# Error response contract

All Sentra HTTP services return failures as RFC 9457 `application/problem+json`.

```json
{
  "type": "urn:sentra:error:<code>",
  "title": "<generic, client-safe message>",
  "status": 401,
  "correlationId": "<request correlation ID>"
}
```

Rules:

- `title` is generic and never contains tokens, internal reasons, stack traces, or other tenants' data.
- The specific failure reason (e.g. `expired`, `invalid_signature`) is logged and counted, never returned.
- `429` responses include `Retry-After` (seconds).
- Unexpected errors return `500` with `urn:sentra:error:internal_error`.
- The correlation ID is also returned in the `x-correlation-id` response header.

TypeScript implementation: `packages/ts-platform` (`toErrorResponse`). Other languages implement this shape independently.
