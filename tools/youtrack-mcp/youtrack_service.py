"""Project, board, and story operations backed by documented YouTrack REST endpoints."""

from __future__ import annotations

import re
from typing import Any

from youtrack_client import YouTrackClient, YouTrackError, segment

PROJECT_FIELDS = "id,name,shortName,description,leader(id,login,name)"
BOARD_FIELDS = "id,name,projects(id,name,shortName),hideOrphansSwimlane,orphansAtTheTop"
STORY_FIELDS = "id,idReadable,summary,description,project(id,name,shortName),customFields(name,value(name))"


class YouTrackService:
    def __init__(self, client: YouTrackClient) -> None:
        self.client = client

    @staticmethod
    def _page(limit: int, skip: int) -> dict[str, int]:
        if not 1 <= limit <= 100 or skip < 0:
            raise ValueError("limit must be 1–100 and skip must be nonnegative")
        return {"$top": limit, "$skip": skip}

    @staticmethod
    def _confirm(actual: str, expected: str, kind: str) -> None:
        if actual != expected:
            raise ValueError(f"{kind} deletion requires exact confirmation: {actual!r}")

    def list_projects(self, limit: int = 50, skip: int = 0) -> list[dict[str, Any]]:
        return self.client.request(
            "GET",
            "/api/admin/projects",
            params={"fields": PROJECT_FIELDS, **self._page(limit, skip)},
        )

    def get_project(self, project_id: str) -> dict[str, Any]:
        return self.client.request(
            "GET",
            f"/api/admin/projects/{segment(project_id)}",
            params={"fields": PROJECT_FIELDS},
        )

    def create_project(
        self, name: str, short_name: str, description: str = ""
    ) -> dict[str, Any]:
        if not name.strip() or not short_name.strip():
            raise ValueError("name and short_name are required")
        user = self.client.request(
            "GET", "/api/users/me", params={"fields": "id,login"}
        )
        return self.client.request(
            "POST",
            "/api/admin/projects",
            params={"fields": PROJECT_FIELDS},
            body={
                "name": name,
                "shortName": short_name,
                "description": description,
                "leader": {"id": user["id"]},
            },
        )

    def update_project(
        self,
        project_id: str,
        name: str | None = None,
        short_name: str | None = None,
        description: str | None = None,
        leader_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if short_name is not None:
            body["shortName"] = short_name
        if description is not None:
            body["description"] = description
        if leader_id is not None:
            body["leader"] = {"id": leader_id}
        if not body:
            raise ValueError("Specify at least one project change")
        return self.client.request(
            "POST",
            f"/api/admin/projects/{segment(project_id)}",
            params={"fields": PROJECT_FIELDS},
            body=body,
        )

    def delete_project(self, project_id: str, confirm_name: str) -> dict[str, str]:
        project = self.get_project(project_id)
        self._confirm(project["name"], confirm_name, "Project")
        self.client.request("DELETE", f"/api/admin/projects/{segment(project['id'])}")
        return {"deleted_project_id": project["id"], "name": project["name"]}

    def list_boards(self, limit: int = 50, skip: int = 0) -> list[dict[str, Any]]:
        return self.client.request(
            "GET",
            "/api/agiles",
            params={"fields": BOARD_FIELDS, **self._page(limit, skip)},
        )

    def get_board(self, board_id: str) -> dict[str, Any]:
        return self.client.request(
            "GET", f"/api/agiles/{segment(board_id)}", params={"fields": BOARD_FIELDS}
        )

    def _project_refs(self, project_ids: list[str]) -> list[dict[str, str]]:
        if not project_ids:
            raise ValueError("At least one project is required")
        return [
            {"id": self.get_project(project_id)["id"]} for project_id in project_ids
        ]

    def create_board(
        self, name: str, project_ids: list[str], template: str = "kanban"
    ) -> dict[str, Any]:
        if not name.strip():
            raise ValueError("Board name is required")
        if template not in {"kanban", "scrum", "version", "custom", "personal"}:
            raise ValueError("Unsupported board template")
        return self.client.request(
            "POST",
            "/api/agiles",
            params={"template": template, "fields": BOARD_FIELDS},
            body={"name": name, "projects": self._project_refs(project_ids)},
        )

    def update_board(
        self,
        board_id: str,
        name: str | None = None,
        project_ids: list[str] | None = None,
        hide_orphans_swimlane: bool | None = None,
        orphans_at_top: bool | None = None,
        column_settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if project_ids is not None:
            body["projects"] = self._project_refs(project_ids)
        if hide_orphans_swimlane is not None:
            body["hideOrphansSwimlane"] = hide_orphans_swimlane
        if orphans_at_top is not None:
            body["orphansAtTheTop"] = orphans_at_top
        if column_settings is not None:
            body["columnSettings"] = column_settings
        if not body:
            raise ValueError("Specify at least one board change")
        return self.client.request(
            "POST",
            f"/api/agiles/{segment(board_id)}",
            params={"fields": BOARD_FIELDS},
            body=body,
        )

    def delete_board(self, board_id: str, confirm_name: str) -> dict[str, str]:
        board = self.get_board(board_id)
        self._confirm(board["name"], confirm_name, "Board")
        self.client.request("DELETE", f"/api/agiles/{segment(board['id'])}")
        return {"deleted_board_id": board["id"], "name": board["name"]}

    def list_stories(
        self, project_id: str, limit: int = 50, skip: int = 0
    ) -> list[dict[str, Any]]:
        project = self.get_project(project_id)
        return self.client.request(
            "GET",
            "/api/issues",
            params={
                "query": f"project: {project['shortName']}",
                "fields": STORY_FIELDS,
                **self._page(limit, skip),
            },
        )

    def get_story(self, issue_id: str) -> dict[str, Any]:
        return self.client.request(
            "GET", f"/api/issues/{segment(issue_id)}", params={"fields": STORY_FIELDS}
        )

    def create_story(
        self,
        project_id: str,
        summary: str,
        description: str,
        type_name: str | None = None,
    ) -> dict[str, Any]:
        if not summary.strip():
            raise ValueError("Story summary is required")
        project = self.get_project(project_id)
        issue = self.client.request(
            "POST",
            "/api/issues",
            params={"fields": STORY_FIELDS},
            body={
                "project": {"id": project["id"]},
                "summary": summary,
                "description": description,
            },
        )
        if type_name is not None:
            try:
                self.set_story_type(issue["idReadable"], type_name)
            except (YouTrackError, ValueError) as error:
                return {
                    "story": issue,
                    "type_update_error": str(error),
                    "created": True,
                }
            issue = self.get_story(issue["idReadable"])
        return issue

    def update_story(
        self,
        issue_id: str,
        summary: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, str] = {}
        if summary is not None:
            body["summary"] = summary
        if description is not None:
            body["description"] = description
        if not body:
            raise ValueError("Specify at least one story change")
        return self.client.request(
            "POST",
            f"/api/issues/{segment(issue_id)}",
            params={"fields": STORY_FIELDS},
            body=body,
        )

    def set_story_type(self, issue_id: str, type_name: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9 _-]{0,63}", type_name):
            raise ValueError("Invalid story type")
        return self.client.request(
            "POST",
            "/api/commands",
            body={"query": f"Type {type_name}", "issues": [{"idReadable": issue_id}]},
        ) or {"updated_issue": issue_id, "type": type_name}

    def delete_story(self, issue_id: str, confirm_summary: str) -> dict[str, str]:
        issue = self.get_story(issue_id)
        self._confirm(issue["summary"], confirm_summary, "Story")
        self.client.request("DELETE", f"/api/issues/{segment(issue['id'])}")
        return {"deleted_issue_id": issue["idReadable"], "summary": issue["summary"]}
