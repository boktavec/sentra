"""List recent ingestion runs per source (read-only).

    python -m crawler.runs_cli [--source osv] [--status failed] [--limit 10]     (or `task crawler:runs`)

--limit is per source + ecosystem. Connects as CRAWLER_DATABASE_URL (or SCHEDULER_DATABASE_URL), read-only.
"""

import argparse
import os
import sys
from datetime import datetime

import psycopg

COLUMNS = ("source", "ecosystem", "run_id", "trigger", "status", "started", "duration", "failure", "error")

_QUERY = """
SELECT source, ecosystem, run_id::text, trigger, status, started_at, completed_at, failure_kind, error
FROM (
  SELECT *, row_number() OVER (PARTITION BY source, ecosystem ORDER BY created_at DESC) AS rn
  FROM ingestion_runs
  WHERE (%(source)s::text IS NULL OR source = %(source)s) AND (%(status)s::text IS NULL OR status = %(status)s)
) r
WHERE rn <= %(limit)s
ORDER BY source, ecosystem, created_at DESC
"""


def _duration(started: datetime | None, completed: datetime | None) -> str:
    if started is None or completed is None:
        return "-"
    return f"{round((completed - started).total_seconds())}s"


def format_runs(rows: list[tuple]) -> str:
    """A plain-text table, one run per line, newest first within each source + ecosystem."""
    lines: list[tuple[str, ...]] = [COLUMNS]
    for source, ecosystem, run_id, trigger, status, started, completed, failure, error in rows:
        lines.append(
            (
                source,
                ecosystem,
                run_id,
                trigger,
                status,
                started.strftime("%Y-%m-%d %H:%M:%S") if started else "-",
                _duration(started, completed),
                failure or "-",
                (error or "-")[:80],
            )
        )
    widths = [max(len(line[i]) for line in lines) for i in range(len(COLUMNS))]
    return "\n".join("  ".join(cell.ljust(w) for cell, w in zip(line, widths, strict=True)).rstrip() for line in lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source")
    parser.add_argument("--status", choices=["requested", "fetching", "stored", "published", "unchanged", "failed"])
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args(argv)
    url = os.environ.get("CRAWLER_DATABASE_URL") or os.environ.get("SCHEDULER_DATABASE_URL")
    if not url:
        print("CRAWLER_DATABASE_URL is required", file=sys.stderr)
        return 2
    with psycopg.connect(url, autocommit=True, options="-c default_transaction_read_only=on") as conn:
        rows = conn.execute(_QUERY, {"source": args.source, "status": args.status, "limit": args.limit}).fetchall()
    print(format_runs(rows) if rows else "no runs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
