from prometheus_client import Counter, Histogram

# SENTRA-23 owns the metrics stack; these are the pipeline's own signals. Consumer lag is read from
# the broker (`rpk group describe pipeline-sbom`), not exported here.
VALIDATIONS = Counter(
    "sbom_validation_total",
    "Handled sbom.uploaded events by outcome",
    ["outcome"],
)
VALIDATION_SECONDS = Histogram(
    "sbom_validation_duration_seconds",
    "Time to validate one SBOM, including retries",
    buckets=(0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60),
)
RETRIES = Counter("sbom_validation_retries_total", "Retries after a transient storage or database failure")
WORKER_ERRORS = Counter("pipeline_worker_errors_total", "Events left uncommitted for redelivery after an error")
