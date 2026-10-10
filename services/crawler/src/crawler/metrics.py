from prometheus_client import Counter, Gauge, Histogram

# SENTRA-23 owns the metrics stack; these are the crawler's own signals. Consumer lag is read from
# the broker (`rpk group describe sentra-crawler`), not exported here.
REQUESTS = Counter("crawler_requests_total", "Handled crawl requests by outcome", ["outcome"])
RUN_SECONDS = Histogram(
    "crawler_request_seconds",
    "Time to handle one crawl request",
    buckets=(0.1, 0.5, 1, 5, 15, 60, 300, 900, 1800),
)
DOWNLOAD_BYTES = Counter("crawler_download_bytes_total", "Bytes downloaded from sources", ["source"])
RETRIES = Counter("crawler_fetch_retries_total", "Download retries after a transient failure", ["source"])
WORKER_ERRORS = Counter("crawler_worker_errors_total", "Requests left uncommitted for redelivery after an error")
GITHUB_PAGES = Counter("crawler_github_pages_total", "Advisory pages fetched from the GitHub API")
GITHUB_RATE_LIMIT_REMAINING = Gauge(
    "crawler_github_ratelimit_remaining",
    "Requests left in the current GitHub rate-limit window (x-ratelimit-remaining)",
)
GITHUB_RATE_LIMIT_WAIT = Counter(
    "crawler_github_ratelimit_wait_seconds_total", "Seconds spent sleeping because of GitHub rate limits"
)

# The scheduler process (SENTRA-10). Gauges are refreshed from the database each pass, so any replica reports
# the shared state. `failures_total` counts failures this process observed since it started: with several
# replicas use max(), not sum().
SCHEDULER_REQUESTS = Counter(
    "scheduler_requests_total", "crawl.requested events published by the scheduler", ["source", "trigger"]
)
SCHEDULER_TICKS_SKIPPED = Counter(
    "scheduler_ticks_skipped_total", "Due ticks or retries not requested", ["source", "ecosystem", "reason"]
)
SCHEDULER_ACTIVE_RUNS = Gauge("scheduler_active_runs", "Runs requested, fetching or stored", ["source", "ecosystem"])
SCHEDULER_RETRIES = Counter("scheduler_retries_total", "Retries requested after a transient failure", ["source"])
SCHEDULER_LAST_SUCCESS = Gauge(
    "scheduler_last_success_timestamp_seconds",
    "Completion time of the newest published or unchanged run",
    ["source", "ecosystem"],
)
SCHEDULER_FAILURES = Counter("scheduler_failures_total", "Failed runs observed by the scheduler", ["source", "kind"])
SCHEDULER_ERRORS = Counter("scheduler_loop_errors_total", "Scheduler passes that failed and will be retried")
