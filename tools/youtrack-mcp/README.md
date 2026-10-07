# Sentra YouTrack MCP

A local stdio MCP server for managing YouTrack projects, agile boards, and user stories. Stories are YouTrack issues; the project's `Type` field determines whether they appear as Feature, User Story, or another configured type.

YouTrack already has a [built-in MCP endpoint](https://www.jetbrains.com/help/youtrack/server/model-context-protocol-server.html) at `/mcp`. Its predefined tools support issue creation and updates, but do not provide the full project, board, and issue deletion workflow used here. This server exposes those operations as dedicated tools over the [YouTrack REST API](https://www.jetbrains.com/help/youtrack/devportal/youtrack-rest-api.html).

## Tools

| Entity | Read | Create | Update | Delete |
| --- | --- | --- | --- | --- |
| Projects | `list_projects`, `get_project` | `create_project` | `update_project` | `delete_project` |
| Boards | `list_boards`, `get_board` | `create_board` | `update_board` | `delete_board` |
| Stories | `list_stories`, `get_story` | `create_story` | `update_story`, `set_story_type` | `delete_story` |

Deletion tools first read the current entity and require its exact name or summary in a confirmation argument. Deleting a project also deletes its issues. Creating a story with `type_name` makes two API calls: if the issue is created but setting its type fails, the tool returns the created issue ID and the type error so agents do not accidentally create a duplicate.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and Python 3.11 or later.
2. Run `uv sync --project tools/youtrack-mcp` from the Sentra repository root.
3. Supply `YOUTRACK_URL` and `YOUTRACK_TOKEN` as environment variables, or set `YOUTRACK_ENV_FILE` to an existing local file containing those two assignments. Keep tokens outside the repository. Plain HTTP is accepted only for loopback addresses; use HTTPS for remote instances.
4. Register the stdio server with your MCP client. For Codex, substitute absolute paths:

```sh
codex mcp add sentra-youtrack \
  --env YOUTRACK_ENV_FILE=/absolute/path/to/private/youtrack.env \
  -- /absolute/path/to/sentra/tools/youtrack-mcp/.venv/bin/python \
     /absolute/path/to/sentra/tools/youtrack-mcp/server.py
```

The same Python executable and `server.py` path work in any stdio MCP client. Pass either `YOUTRACK_ENV_FILE` or both `YOUTRACK_URL` and `YOUTRACK_TOKEN` in that client's environment. Restart the client after registration, then ask it to list YouTrack projects.

For Sentra, the local instance URL is `http://127.0.0.1:8080`. The server runs on your machine and does not expose a listening port.

## Development checks

```sh
uv run --project tools/youtrack-mcp python -m unittest discover -s tools/youtrack-mcp/tests -v
```

For an end-to-end check, create a temporary project through the tools, then create a board and story, update each, and delete them in story → board → project order. Use a unique project short name so the check cannot touch existing data.
