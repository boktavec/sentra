from prometheus_client import Counter, Gauge, Histogram

# SENTRA-23 owns the metrics stack; these are the correlator's own signals. Consumer lag is read from the
# broker (`rpk group describe correlator`), not exported here.
EVENTS = Counter("correlate_events_total", "Handled events by type and outcome", ["type", "outcome"])
FINDINGS = Counter(
    "correlate_findings_total",
    "Finding writes by outcome (created, updated, reopened, resolved, unchanged)",
    ["outcome"],
)
MATCHES = Counter("correlate_matches_total", "Open findings seen by quality and reason", ["quality", "reason"])
UNMATCHABLE = Counter("correlate_unmatchable_dependencies_total", "Dependencies skipped for lack of an ecosystem")
PROJECTS = Counter("correlate_projects_reconciled_total", "Projects reconciled by trigger", ["trigger"])
RECONCILE_SECONDS = Histogram(
    "correlate_reconcile_duration_seconds",
    "Time to reconcile one project, excluding lock wait",
    buckets=(0.01, 0.05, 0.1, 0.5, 1, 2, 5, 15, 60),
)
LOCK_WAIT_SECONDS = Histogram(
    "correlate_lock_wait_seconds",
    "Time spent waiting for a project's advisory lock",
    buckets=(0.001, 0.01, 0.1, 1, 5, 30),
)
SWEEP_SECONDS = Histogram(
    "correlate_sweep_duration_seconds", "Time for a full sweep", buckets=(1, 10, 60, 300, 900, 3600)
)
SWEEP_AGE = Gauge("correlate_seconds_since_last_sweep", "Seconds since the last completed sweep (-1: never)")
WORKER_ERRORS = Counter("correlator_worker_errors_total", "Events left uncommitted for redelivery after an error")
