from datetime import UTC, datetime, timedelta

from crawler.runs_cli import format_runs

START = datetime(2026, 10, 9, 12, 0, 0, tzinfo=UTC)


def test_runs_are_listed_with_duration_failure_and_a_bounded_error():
    rows = [
        ("osv", "npm", "run-1", "schedule", "published", START, START + timedelta(seconds=42), None, None),
        ("osv", "npm", "run-2", "retry", "failed", START, START + timedelta(seconds=3), "transient", "x" * 500),
        ("cisa-kev", "none", "run-3", "schedule", "requested", None, None, None, None),
    ]
    lines = format_runs(rows).splitlines()
    assert lines[0].split() == [
        "source",
        "ecosystem",
        "run_id",
        "trigger",
        "status",
        "started",
        "duration",
        "failure",
        "error",
    ]
    assert "published" in lines[1] and "42s" in lines[1] and "2026-10-09 12:00:00" in lines[1]
    assert "transient" in lines[2] and "x" * 80 in lines[2] and "x" * 81 not in lines[2]
    assert lines[3].split() == ["cisa-kev", "none", "run-3", "schedule", "requested", "-", "-", "-", "-"]
