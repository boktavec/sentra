"""Backfill derived CVSS scores: python -m pipeline.normalize.backfill_cvss [--batch-size 500].

Run after migration 013, as sentra_normalizer. Each batch commits independently. Row locks
serialize with live normalization so an old vector can never overwrite a newer score.
"""

import argparse
import os

import psycopg

from .cvss_score import score


def backfill(conn: psycopg.Connection, batch_size: int = 500) -> int:
    total = 0
    while True:
        with conn.transaction():
            rows = conn.execute(
                "SELECT id, severity FROM vulnerabilities WHERE cvss_calculated_at IS NULL "
                "ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED",
                (batch_size,),
            ).fetchall()
            if not rows:
                break
            values = [(score(severity), vulnerability_id) for vulnerability_id, severity in rows]
            with conn.cursor() as cur:
                cur.executemany(
                    "UPDATE vulnerabilities SET cvss_score = %s, cvss_version = %s, "
                    "cvss_calculated_at = now() WHERE id = %s AND cvss_calculated_at IS NULL",
                    [(result[0], result[1], vulnerability_id) for result, vulnerability_id in values],
                )
            total += len(rows)
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 5000:
        parser.error("batch size must be 1..5000")
    database_url = os.environ.get("NORMALIZER_DATABASE_URL")
    if not database_url:
        parser.error("NORMALIZER_DATABASE_URL is required")
    with psycopg.connect(database_url, autocommit=True) as conn:
        print(f"CVSS backfill processed {backfill(conn, args.batch_size)} advisories")


if __name__ == "__main__":
    main()
