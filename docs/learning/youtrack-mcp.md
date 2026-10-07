# YouTrack MCP adapter: engineering notes

## What was built

A local stdio MCP server exposes project, agile board, and issue lifecycle tools for YouTrack. A small service layer maps the tools to the REST API and a transport layer handles authentication, encoding, timeouts, and errors.

## Why this shape

The official YouTrack MCP endpoint supplies useful issue tools, but Sentra agents need one discoverable interface for project, board, and story creation, updates, and deletion. A local stdio process avoids opening a network listener or maintaining another deployed service. The MCP SDK owns protocol details; the rest of the code stays ordinary Python.

## Alternatives and tradeoffs

We considered the built-in endpoint, community servers, and ad hoc REST scripts. A focused adapter adds code to maintain, while giving the agents stable tool names, typed arguments, and consistent deletion checks. The server deliberately leaves complex project field provisioning and board automation to future work tied to actual usage.

## Scaling and failure behavior

Each MCP client starts its own process. YouTrack remains the source of truth and handles concurrent writes. Requests have a 20-second timeout, and mutating requests are not automatically retried because a timeout after a successful write could create duplicates. Story creation followed by a Type update is a two-step operation; on a Type failure, the created issue ID is returned for recovery.

## Security considerations

The token stays in local environment configuration and is never committed. Non-local HTTP URLs are rejected to avoid sending it over an unencrypted connection. Resource IDs are encoded as URL path segments. Delete tools read the current entity and require its exact current name or summary. YouTrack permissions remain the final authorization boundary.

## Concepts to understand

- MCP stdio transports JSON-RPC messages between a client and a locally launched server.
- YouTrack uses `POST` for many updates, and explicit `fields` query parameters control returned data.
- Human-readable issue IDs differ from internal database IDs; the adapter accepts either where YouTrack supports them.
- A successful create followed by a failed second step is a partial success, not a failed create.
