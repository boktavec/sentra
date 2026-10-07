"""Checks for destructive-action and partial-creation failure modes."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from youtrack_client import YouTrackClient, YouTrackError, segment
from youtrack_service import YouTrackService


class FakeClient:
    def __init__(self):
        self.calls = []

    def request(self, method, path, *, params=None, body=None):
        self.calls.append((method, path, params, body))
        if path == "/api/admin/projects/SENTRA":
            return {"id": "0-2", "name": "Sentra", "shortName": "SENTRA"}
        if path == "/api/agiles/201-3":
            return {"id": "201-3", "name": "Sentra MVP"}
        if path == "/api/issues/SENTRA-1":
            return {"id": "2-1", "idReadable": "SENTRA-1", "summary": "Story one"}
        if path == "/api/issues" and method == "POST":
            return {"id": "2-99", "idReadable": "SENTRA-99", "summary": body["summary"]}
        if path == "/api/commands":
            raise YouTrackError("Type Feature does not exist")
        return None


class SafetyTests(unittest.TestCase):
    def test_nonlocal_http_url_rejected(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            YouTrackClient("http://example.com", "secret")

    def test_path_segment_cannot_escape_resource(self):
        self.assertEqual(segment("A/B"), "A%2FB")

    def test_project_delete_requires_current_name(self):
        client = FakeClient()
        with self.assertRaisesRegex(ValueError, "exact confirmation"):
            YouTrackService(client).delete_project("SENTRA", "wrong name")
        self.assertFalse(any(call[0] == "DELETE" for call in client.calls))

    def test_story_delete_requires_current_summary(self):
        client = FakeClient()
        with self.assertRaisesRegex(ValueError, "exact confirmation"):
            YouTrackService(client).delete_story("SENTRA-1", "wrong summary")
        self.assertFalse(any(call[0] == "DELETE" for call in client.calls))

    def test_story_creation_reports_partial_success(self):
        client = FakeClient()
        result = YouTrackService(client).create_story(
            "SENTRA", "New story", "Details", "Feature"
        )
        self.assertTrue(result["created"])
        self.assertEqual(result["story"]["idReadable"], "SENTRA-99")
        self.assertIn("type_update_error", result)


if __name__ == "__main__":
    unittest.main()
