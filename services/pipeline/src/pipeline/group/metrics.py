from prometheus_client import Counter, Histogram

# SENTRA-23 owns the metrics stack; these are the grouper's own signals.
ADVISORIES = Counter("group_advisories_total", "Advisories recomputed")
GROUPS = Counter("group_groups_written_total", "Groups produced by recomputation")
MERGED = Counter("group_merged_total", "Previous groups that were merged away or split")
CONFLICTS = Counter("group_conflicts_total", "Advisories left ungrouped because their component was ambiguous")
RUN_SECONDS = Histogram("group_run_duration_seconds", "Time for one pass", buckets=(0.1, 1, 10, 60, 300, 900, 3600))


def record(stats, seconds: float) -> None:
    ADVISORIES.inc(stats.advisories)
    GROUPS.inc(stats.groups)
    MERGED.inc(stats.merged)
    CONFLICTS.inc(stats.conflicts)
    RUN_SECONDS.observe(seconds)
