from prometheus_client import Counter, Histogram

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
