# SENTRA-30: Harden the OSV crawler against poison messages and dependency failures

- Status: Implemented
- YouTrack: SENTRA-30 (http://localhost:8080/issue/SENTRA-30)
- Owner: Sentra operator / project owner

## Problem and outcome

- A code review of the merged SENTRA-7 crawler found inputs and failures that stop ingestion: a hostile or malformed `crawl.requested` can block the Kafka partition forever, and a rebalance or database restart can kill or wedge the worker.
- Done means each finding was reproduced by a test that failed on the old code, fixed at its root cause, and now passes, with the rest of the suite green.

## Scope

- In scope:
  - Lone-surrogate string in a request (`UnicodeEncodeError` while verifying the signature).
  - `RecursionError` from pathologically nested JSON, and the lack of any bound on retrying deterministic errors.
  - `commit()` and `seek()` errors killing the worker.
  - The single Postgres connection never recovering.
  - Lease and `max.poll.interval.ms` shorter than the worst-case run, because `total_timeout` applied per attempt.
  - Importing `crawler.__main__` starting the service; the hard-wired metrics bind address and unvalidated runtime config.
- Out of scope (follow-ups): metrics accuracy (bytes from failed attempts, double counting on redelivery), stuck-run sweep, retention, alerting (SENTRA-23), topic ACLs, lease fencing.
- Dependencies and related stories: SENTRA-7 (the code being hardened); SENTRA-10 (scheduling will rely on this behaviour).

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Poison vs outage | Classify exceptions: dependency errors (`OSError`, Kafka, psycopg operational, botocore) retry for as long as the outage lasts; anything else is retried 3 times, then abandoned | One global retry cap; never give up | A global cap would drop real requests during a long outage; never giving up lets one bug wedge the partition. Cost: a new dependency error type that is not in the list is treated as a bug after 3 attempts. |
| Abandoning a request | Commit the offset, count `dropped_poison`, and only if the message is a validly signed request fail its run and publish `crawl.failed` | Always record; never record | An unsigned message must not be able to fail another run. Cost: abandoned unverified messages leave only a log and a metric. |
| Unencodable strings | Treat as an invalid signature (`verify` returns False) | Escape non-ASCII in the canonical form | Keeps the documented canonical JSON (UTF-8) so other languages can sign it. |
| Time budget | `total_timeout` is one deadline for all attempts and backoff; `claim_lease_seconds = total + 10 min`; `max.poll.interval.ms = lease + 5 min` | Keep per-attempt and raise the lease to 75 min | One number to reason about, and the lease and poll interval cannot drift below the worst case. Cost: a very slow but progressing download is cut off at 15 min. |
| Postgres connection | Replace a dead connection on its next use; the failed call is retried by the worker | Blind in-call retry; connection pool | A blind retry of `claim` can strand a run behind its own lease when the reply was lost; the existing lease release handles that case. A pool is a new dependency for one connection. |
| Commit/seek | Up to 3 attempts, log and continue | Let the worker die and rely on the supervisor | Redelivery is idempotent, so a missed commit is harmless; dying drops in-flight state for no benefit. |

## Architecture and contracts

- Affected: `services/crawler` only (`signing`, `fetch`, `config`, `runs`, `ingest`, `worker`, `__main__`). No event or table contract changes.
- New settings: `CRAWLER_KAFKA_BOOTSTRAP`, `CRAWLER_METRICS_HOST`, `CRAWLER_METRICS_PORT` are now validated in `config.load()`. New metric outcome: `crawler_requests_total{outcome="dropped_poison"}`.

## Workload and targets

No capacity change. `Limits` defaults are unchanged (10 s connect, 60 s read, 15 min total, 5 attempts); only their meaning for `total_timeout` changed. Resulting lease 25 min, poll interval 30 min.

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Lone-surrogate string in a request | Dropped as an invalid signature; the next request is processed | `test_signing`, worker integration test |
| 900,000-deep JSON `[` | Dropped as invalid, not retried | worker integration test |
| Deterministic exception while handling a signed request | 3 attempts, then run `failed`, `crawl.failed` published, offset committed | worker integration test |
| Same, but the message is unsigned or unparseable | Abandoned with a log and metric; no run is touched | `test_abandoning_an_unverified_message...` |
| Dependency outage longer than the poison bound | Retried until it recovers, never abandoned | worker integration test (6 failures, then success) |
| `commit()` / `seek()` raises | Retried, worker stays alive, message processed once | worker integration tests with a proxy consumer |
| Postgres connection killed server-side | Next request succeeds on a fresh connection | worker integration test using `pg_terminate_backend` |
| Slow attempts consuming the budget | Fetch fails after `total_timeout`, not after 5x | unit test |

## Security, observability, and rollout

- Authorization: abandoning never records a failure for an unverified request.
- Observability: `dropped_poison` outcome, existing `crawler_worker_errors_total`, and error logs with the reason (truncated to 300 chars, no payload or signature).
- Rollout: restart the worker; no migration. Rollback is redeploying the previous image.

## Acceptance criteria

- [x] Each finding reproduced by a test that fails on the old code and passes after the fix.
- [x] A message that can never succeed is committed after a bounded number of attempts and is observable.
- [x] A broker or database blip never kills the worker, and ingestion resumes by itself.
- [x] The whole fetch is bounded by one deadline; lease and poll interval derive from it.

## Verification

- Old code: 5 unit and 6 integration tests fail (2 further new tests are intentional guards that pass on both). Fixed code: 23 unit and 39 integration tests pass (measured with `task crawler:test` and `task crawler:test:integration`).
- Mutation-checked: removing the `UnicodeEncodeError` guard, counting outages as poison, removing reconnection, and removing the signature check in the abandon path each make the matching test fail.
- Fakes: a proxy around the Kafka consumer raises on `commit`/`seek` (a real rebalance cannot be triggered on demand); it leaves actual rebalance behaviour unverified.

## Open questions and assumptions to validate

- The `TRANSIENT` list is judgement: validate against the first real incident. Unknown error types are treated as bugs after 3 attempts.
- The 10 minute lease allowance for upload and database time is an assumption; the 208 MiB npm upload measured well under a minute locally.
