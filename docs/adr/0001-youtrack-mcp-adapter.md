# ADR 0001: Local YouTrack MCP adapter

Status: Accepted

## Context

Sentra agents need to create, read, update, and delete YouTrack projects, agile boards, and user stories. The YouTrack Server MCP endpoint is available locally, but its predefined tools do not cover that complete lifecycle. Agents could call the REST API through ad hoc scripts, but that repeats authentication, API shapes, and deletion handling in each agent.

## Decision

Keep a small stdio MCP server under `tools/youtrack-mcp`. It uses the maintained v1 Python MCP SDK for protocol handling and a narrow REST client for YouTrack operations. The server exposes named tools for the three entities, reads credentials from the local environment or a private env file, and requires an exact entity name or summary for deletion.

## Alternatives considered

- **Use only YouTrack's built-in MCP endpoint:** less code, but project and board lifecycle operations and issue deletion are missing.
- **Use a community MCP server:** broader coverage, but the checked servers did not expose the requested operations as a complete, focused set of named tools.
- **Use raw REST calls in each agent:** no new service dependency, but authentication and destructive operations become inconsistent across agents.

## Consequences

The adapter adds a small Python dependency and must track YouTrack REST API changes. It runs locally over stdio, so each agent client launches its own process and must be able to reach the local YouTrack instance. The authenticated YouTrack user's permissions still govern every action. A project deletion is irreversible and includes its issues; exact-name confirmation reduces accidental targeting but does not replace review of destructive calls.
