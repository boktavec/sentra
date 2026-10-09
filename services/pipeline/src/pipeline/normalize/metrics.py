from prometheus_client import Counter, Histogram

# SENTRA-23 owns the metrics stack; these are the normalizer's own signals. Consumer lag is read from
# the broker (`rpk group describe normalizer-artifacts`), not exported here.
ARTIFACTS = Counter(
    "normalize_artifacts_total",
    "Handled artifact.ingested events by outcome (published, failed, skipped_duplicate, dropped_invalid, ...)",
    ["outcome"],
)
RECORDS = Counter(
    "normalize_records_total",
    "Records by outcome (upserted, unchanged, quarantined, kev_upserted, kev_tombstoned)",
    ["outcome"],
)
RUN_SECONDS = Histogram(
    "normalize_run_duration_seconds",
    "Time to normalize one artifact, including retries",
    buckets=(1, 5, 15, 30, 60, 120, 300, 900),
)
RETRIES = Counter("normalize_retries_total", "Retries after an unexpected failure while processing an artifact")
WORKER_ERRORS = Counter("normalizer_worker_errors_total", "Events left uncommitted for redelivery after an error")
