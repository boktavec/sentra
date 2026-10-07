"""Stdio MCP server for Sentra's YouTrack project management workflows."""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP
from youtrack_client import YouTrackClient
from youtrack_service import YouTrackService

mcp = FastMCP("sentra-youtrack")


def service() -> YouTrackService:
    return YouTrackService(YouTrackClient.from_environment())


@mcp.tool()
def list_projects(limit: int = 50, skip: int = 0) -> list[dict[str, Any]]:
    """List accessible YouTrack projects with their IDs and short names."""
    return service().list_projects(limit, skip)


@mcp.tool()
def get_project(project_id: str) -> dict[str, Any]:
    """Read a project by database ID or short name before changing it."""
    return service().get_project(project_id)


@mcp.tool()
def create_project(name: str, short_name: str, description: str = "") -> dict[str, Any]:
    """Create a project, using the authenticated YouTrack user as its leader."""
    return service().create_project(name, short_name, description)


@mcp.tool()
def update_project(
    project_id: str,
    name: str | None = None,
    short_name: str | None = None,
    description: str | None = None,
    leader_id: str | None = None,
) -> dict[str, Any]:
    """Update a project's name, short name, description, or leader."""
    return service().update_project(
        project_id, name, short_name, description, leader_id
    )


@mcp.tool()
def delete_project(project_id: str, confirm_name: str) -> dict[str, str]:
    """Permanently delete a project and its issues; confirm_name must match its current name exactly."""
    return service().delete_project(project_id, confirm_name)


@mcp.tool()
def list_boards(limit: int = 50, skip: int = 0) -> list[dict[str, Any]]:
    """List accessible agile boards and their associated projects."""
    return service().list_boards(limit, skip)


@mcp.tool()
def get_board(board_id: str) -> dict[str, Any]:
    """Read an agile board by database ID before changing it."""
    return service().get_board(board_id)


@mcp.tool()
def create_board(
    name: str, project_ids: list[str], template: str = "kanban"
) -> dict[str, Any]:
    """Create a board for one or more projects; template is kanban, scrum, version, custom, or personal."""
    return service().create_board(name, project_ids, template)


@mcp.tool()
def update_board(
    board_id: str,
    name: str | None = None,
    project_ids: list[str] | None = None,
    hide_orphans_swimlane: bool | None = None,
    orphans_at_top: bool | None = None,
    column_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Update board name, projects, swimlane placement, or YouTrack columnSettings JSON."""
    return service().update_board(
        board_id,
        name,
        project_ids,
        hide_orphans_swimlane,
        orphans_at_top,
        column_settings,
    )


@mcp.tool()
def delete_board(board_id: str, confirm_name: str) -> dict[str, str]:
    """Permanently delete a board, leaving its issues intact; confirm_name must match exactly."""
    return service().delete_board(board_id, confirm_name)


@mcp.tool()
def list_stories(
    project_id: str, limit: int = 50, skip: int = 0
) -> list[dict[str, Any]]:
    """List issues in a project; user stories are YouTrack issues with a configured Type field."""
    return service().list_stories(project_id, limit, skip)


@mcp.tool()
def get_story(issue_id: str) -> dict[str, Any]:
    """Read an issue/user story by readable ID such as SENTRA-1 or database ID."""
    return service().get_story(issue_id)


@mcp.tool()
def create_story(
    project_id: str,
    summary: str,
    description: str,
    type_name: str | None = None,
) -> dict[str, Any]:
    """Create a user story as an issue. Put narrative and acceptance criteria in Markdown description; optionally set its Type."""
    return service().create_story(project_id, summary, description, type_name)


@mcp.tool()
def update_story(
    issue_id: str,
    summary: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Update a story's summary or Markdown description, including acceptance criteria."""
    return service().update_story(issue_id, summary, description)


@mcp.tool()
def set_story_type(issue_id: str, type_name: str) -> dict[str, Any]:
    """Set a story's configured Type field, for example Feature or User Story."""
    return service().set_story_type(issue_id, type_name)


@mcp.tool()
def delete_story(issue_id: str, confirm_summary: str) -> dict[str, str]:
    """Permanently delete a story; confirm_summary must match its current summary exactly."""
    return service().delete_story(issue_id, confirm_summary)


if __name__ == "__main__":
    mcp.run(transport="stdio")
