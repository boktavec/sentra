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

Error codes used by the organization APIs (`type` is `urn:sentra:error:<code>`):

| Code | Status | Meaning |
| --- | --- | --- |
| `not_found` | 404 | Missing resource, or an organization the caller does not belong to. The two are indistinguishable. |
| `forbidden` | 403 | The caller belongs to the organization but their role does not allow the operation. Never returned to non-members. |
| `last_admin` | 409 | The change would leave the organization with no admin. |
| `org_limit_reached` | 403 | The caller is at the per-user organization cap. |
| `slug_taken` | 409 | The organization slug is already in use. |
| `invalid_input` | 400 | Malformed or out-of-range input. |
