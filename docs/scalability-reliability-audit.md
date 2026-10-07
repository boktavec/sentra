# Scalability & Reliability Audit Checklist

Use this checklist when designing a new service, reviewing an existing system, reviewing a major feature, or evaluating whether an application can handle significantly more traffic.

The goal is not for every answer to be "yes." The goal is for the engineering team to be able to answer every relevant question intentionally.

---

# 1. System Context

## Purpose & Criticality

- [ ] What does this system/service/function do?
- [ ] Who depends on it?
- [ ] Is it user-facing, internal, asynchronous, or infrastructure?
- [ ] What happens to the business if it is unavailable?
- [ ] What data does it own?
- [ ] What data is authoritative?
- [ ] What operations are read-heavy?
- [ ] What operations are write-heavy?
- [ ] Which workflows are critical?
- [ ] Which workflows are optional or degradable?

## Traffic Profile

- [ ] What is normal RPS?
- [ ] What is peak RPS?
- [ ] What burst rate must be supported?
- [ ] What is expected request concurrency?
- [ ] What is the growth projection?
- [ ] Are there predictable spikes?
- [ ] Are there unpredictable spikes?
- [ ] What are typical and maximum payload sizes?
- [ ] Is traffic evenly distributed across users/tenants?
- [ ] Can one tenant become disproportionately large?

---

# 2. Performance & Latency

- [ ] What is the end-to-end latency target?
- [ ] What are the p50, p95, and p99 targets?
- [ ] Is there a latency budget per downstream dependency?
- [ ] Are slow dependencies prevented from consuming the entire request budget?
- [ ] Are expensive operations performed synchronously only when necessary?
- [ ] Can long-running work be moved to async processing?
- [ ] Are payload sizes bounded?
- [ ] Are expensive computations cached or precomputed where appropriate?
- [ ] Have hot code paths been profiled?
- [ ] Do we know the actual bottleneck before optimizing?

---

# 3. Timeouts

For every network or remote dependency:

- [ ] Is there a timeout?
- [ ] Is the timeout explicitly configured?
- [ ] Is the timeout smaller than the caller's total latency budget?
- [ ] Are connect and request/read timeouts appropriate?
- [ ] What happens when the dependency becomes slow?
- [ ] Can slow calls exhaust threads, workers, sockets, or connections?
- [ ] Can timeout values be configured without redeploying where appropriate?
- [ ] Are timeout events measured?

---

# 4. Retries

- [ ] Which operations are retried?
- [ ] Which failures are considered transient?
- [ ] Which failures must never be retried?
- [ ] Are retries bounded?
- [ ] Is exponential backoff used?
- [ ] Is jitter used?
- [ ] Is there a retry budget?
- [ ] Could multiple layers retry the same operation?
- [ ] Could retry amplification overload a failing dependency?
- [ ] Can retries increase queue depth dramatically?
- [ ] Are retry counts observable?
- [ ] Does the retry policy respect the total request deadline?

---

# 5. Idempotency & Duplicate Processing

- [ ] What happens if the same request is submitted twice?
- [ ] What happens if the first request succeeds but the response is lost?
- [ ] Are write operations idempotent where necessary?
- [ ] Are idempotency keys stable across retries?
- [ ] Are idempotency keys scoped correctly?
- [ ] Are duplicate events possible?
- [ ] Are queue consumers safe against duplicate delivery?
- [ ] Are database constraints used to prevent duplicate state?
- [ ] Can duplicate side effects occur?
- [ ] Is the original result returned for repeated idempotent requests when appropriate?

---

# 6. Caching

- [ ] Why is caching needed?
- [ ] What layer owns the cache?
- [ ] What is the source of truth?
- [ ] What is the cache key?
- [ ] Are cache keys tenant-safe?
- [ ] What is the TTL?
- [ ] Should TTL jitter be used?
- [ ] How is cache invalidation handled?
- [ ] Is stale data acceptable?
- [ ] For how long?
- [ ] What is the expected hit ratio?
- [ ] What happens on cache miss?
- [ ] What happens on cold start?
- [ ] Could many simultaneous misses overload the database?
- [ ] Is request coalescing/single-flight needed?
- [ ] Is stale-while-revalidate useful?
- [ ] Can hot keys overwhelm one cache node?
- [ ] What happens if the cache goes down?
- [ ] Can the system bypass it safely?
- [ ] Is the cache itself a single point of failure?
- [ ] Are cache hit/miss rates monitored?

---

# 7. Rate Limiting

- [ ] Is rate limiting required?
- [ ] Is it per IP?
- [ ] Per user?
- [ ] Per API key?
- [ ] Per tenant?
- [ ] Per endpoint?
- [ ] Global?
- [ ] Are expensive endpoints more tightly limited?
- [ ] Are external API quotas protected?
- [ ] Can one tenant consume all available capacity?
- [ ] Are limits burst-aware?
- [ ] Are limits distributed correctly across instances?
- [ ] What response is returned when limited?
- [ ] Is retry-after guidance supplied where appropriate?
- [ ] Are rate-limit events observable?

---

# 8. Backpressure & Load Shedding

- [ ] What happens when incoming work exceeds processing capacity?
- [ ] Is buffering bounded?
- [ ] Can queues grow without limit?
- [ ] Can producers be slowed?
- [ ] Can clients be rejected early?
- [ ] Can low-priority work be dropped?
- [ ] Is critical traffic prioritized?
- [ ] Are concurrency limits enforced?
- [ ] Are worker pools bounded?
- [ ] Are queues monitored for depth and age?
- [ ] Is there an emergency load-shedding strategy?
- [ ] Can the system recover after overload without a restart?

---

# 9. Circuit Breakers & Failure Isolation

- [ ] Can repeated calls to a failing dependency be stopped temporarily?
- [ ] Is a circuit breaker needed?
- [ ] What causes it to open?
- [ ] How does it recover?
- [ ] Are failures isolated by dependency?
- [ ] Are resource pools separated where needed?
- [ ] Can one feature exhaust resources needed by another?
- [ ] Can one tenant exhaust shared resources?
- [ ] Are bulkheads appropriate?
- [ ] Are external dependency failures prevented from cascading?

---

# 10. Graceful Degradation

- [ ] Which features are critical?
- [ ] Which features can degrade?
- [ ] Can stale data be returned?
- [ ] Can partial results be returned?
- [ ] Can optional enrichment be skipped?
- [ ] Can work be queued for later?
- [ ] Is there a fallback provider or fallback path?
- [ ] Can noncritical features be disabled independently?
- [ ] Will users receive a useful response during partial outage?
- [ ] Does degradation protect the core workflow?

---

# 11. Database Scalability

## Queries

- [ ] Are all high-volume queries known?
- [ ] Are indexes aligned with query patterns?
- [ ] Are queries bounded?
- [ ] Are full-table scans avoided on hot paths?
- [ ] Are N+1 queries avoided?
- [ ] Is pagination used?
- [ ] Is offset pagination acceptable at expected scale?
- [ ] Should cursor pagination be used?
- [ ] Are query plans reviewed for critical queries?
- [ ] Are expensive sorts/aggregations understood?

## Connections

- [ ] Is connection pooling configured?
- [ ] Is the pool bounded?
- [ ] How many app instances can connect simultaneously?
- [ ] Can total pool size exceed DB limits?
- [ ] What happens when the pool is exhausted?
- [ ] Is pool saturation monitored?

## Transactions & Locks

- [ ] Are transactions as short as possible?
- [ ] Are locks understood?
- [ ] Can concurrent requests deadlock?
- [ ] Can hot rows become contention points?
- [ ] Are transactions retried safely where required?
- [ ] Are invariants enforced at the database layer?

---

# 12. Replication & Read Scaling

- [ ] Are read replicas needed?
- [ ] What is expected replication lag?
- [ ] Is stale data acceptable?
- [ ] Which reads require read-after-write consistency?
- [ ] Can writes immediately followed by reads hit a stale replica?
- [ ] What happens if a replica fails?
- [ ] How are reads distributed?
- [ ] Can replication lag be monitored?
- [ ] Can traffic be shifted away from lagging replicas?

---

# 13. Partitioning & Sharding

- [ ] At what scale would partitioning become necessary?
- [ ] What would the partition key be?
- [ ] Is the key high-cardinality?
- [ ] Does it distribute load evenly?
- [ ] Can one key become hot?
- [ ] Can one tenant dominate a shard?
- [ ] How would shards be rebalanced?
- [ ] How are cross-shard queries handled?
- [ ] How are cross-shard transactions handled?
- [ ] Can data be moved between shards safely?
- [ ] Is shard ownership discoverable?
- [ ] Is resharding possible without significant downtime?

---

# 14. Concurrency & Race Conditions

- [ ] Can multiple requests modify the same state?
- [ ] What invariants must always hold?
- [ ] Are check-then-write operations atomic?
- [ ] Is optimistic locking needed?
- [ ] Is pessimistic locking needed?
- [ ] Can stale writes overwrite newer data?
- [ ] Are version/revision numbers used where appropriate?
- [ ] Can events arrive out of order?
- [ ] Can concurrent jobs process the same entity?
- [ ] Are atomic database operations used where possible?
- [ ] Are distributed locks truly necessary?
- [ ] What happens if a process holding a lock dies?

---

# 15. Queues & Messaging

- [ ] Why is a queue being used?
- [ ] What delivery guarantees does it provide?
- [ ] At-most-once?
- [ ] At-least-once?
- [ ] Effectively-once?
- [ ] Can messages be duplicated?
- [ ] Can messages be reordered?
- [ ] Is ordering required?
- [ ] Are consumers idempotent?
- [ ] Is message processing atomic enough?
- [ ] What happens when a consumer crashes?
- [ ] How are failed messages retried?
- [ ] Is there a dead-letter queue?
- [ ] Can poison messages block processing?
- [ ] Is queue depth monitored?
- [ ] Is consumer lag monitored?
- [ ] What is the maximum acceptable message age?
- [ ] Can consumers scale horizontally?
- [ ] Is partitioning balanced?
- [ ] Can queue growth be bounded?

---

# 16. Event-Driven Architecture

- [ ] Who owns each event?
- [ ] Is the event schema versioned?
- [ ] Are changes backward compatible?
- [ ] Can consumers tolerate unknown fields?
- [ ] Can old consumers process new events?
- [ ] Can events be replayed safely?
- [ ] Are consumers idempotent?
- [ ] Can consumers recover from missing events?
- [ ] Is ordering assumed accidentally?
- [ ] Is eventual consistency acceptable?
- [ ] Is there reconciliation for drift?
- [ ] Are event IDs traceable end-to-end?

---

# 17. Distributed Transactions & Workflows

- [ ] Does one business operation modify multiple systems?
- [ ] What happens if step 1 succeeds and step 2 fails?
- [ ] Is atomicity actually required?
- [ ] Can a local transaction be used?
- [ ] Should the transactional outbox pattern be used?
- [ ] Is an inbox/deduplication pattern needed?
- [ ] Is a saga appropriate?
- [ ] Are compensating actions defined?
- [ ] Can compensation fail?
- [ ] Is workflow state persisted?
- [ ] Can workflows resume after crashes?
- [ ] Is reconciliation required?

---

# 18. API Scalability

- [ ] Are list endpoints bounded?
- [ ] Is pagination mandatory?
- [ ] Are filters indexed?
- [ ] Are expensive sort options controlled?
- [ ] Are request body sizes limited?
- [ ] Are response sizes limited?
- [ ] Are batch endpoints available where useful?
- [ ] Are batch sizes bounded?
- [ ] Are long-running operations asynchronous?
- [ ] Is there an operation-status model?
- [ ] Are APIs idempotent where appropriate?
- [ ] Are API versions backward compatible?
- [ ] Are clients protected from breaking changes?
- [ ] Are error responses machine-readable?
- [ ] Are partial failures represented clearly?

---

# 19. Multi-Tenant Isolation

- [ ] How is tenant identity established?
- [ ] Is tenant context required for every data access?
- [ ] Can tenant context be accidentally omitted?
- [ ] Are authorization checks performed at resource boundaries?
- [ ] Are cache keys tenant scoped?
- [ ] Are queue messages tenant scoped?
- [ ] Are object-storage keys tenant scoped?
- [ ] Can one tenant consume all DB connections?
- [ ] Can one tenant create disproportionate queue backlog?
- [ ] Are per-tenant limits needed?
- [ ] Are noisy-neighbor risks understood?
- [ ] Can tenant data appear in another tenant's logs?
- [ ] Are cross-tenant admin operations explicitly controlled?

---

# 20. External Dependencies

For every third-party API/service:

- [ ] What is its SLA?
- [ ] What is its rate limit?
- [ ] What is its timeout?
- [ ] What happens if it is down?
- [ ] What happens if it is slow?
- [ ] Is retry behavior safe?
- [ ] Is there a fallback?
- [ ] Can requests be queued?
- [ ] Can results be cached?
- [ ] Can the application run without it?
- [ ] Is dependency health monitored?
- [ ] Are quotas monitored?
- [ ] What happens when credentials expire?
- [ ] What happens if response schemas change unexpectedly?

---

# 21. Authentication & Authorization Under Load

- [ ] Is auth performed locally or through a dependency?
- [ ] Can auth dependency latency affect every request?
- [ ] Are tokens verified efficiently?
- [ ] Are key/JWKS lookups cached safely?
- [ ] What happens during identity-provider outage?
- [ ] Are permission checks centralized enough to remain consistent?
- [ ] Are authorization decisions tenant-aware?
- [ ] Can auth caches become stale?
- [ ] Are revocation requirements understood?
- [ ] Are brute-force and abuse protections in place?

---

# 22. Storage & Object Systems

- [ ] Are object names/keys deterministic and collision-safe?
- [ ] Are uploads size-limited?
- [ ] Are downloads streamed?
- [ ] Are large files loaded into memory accidentally?
- [ ] Is multipart upload needed?
- [ ] Are signed URLs appropriate?
- [ ] Are lifecycle policies configured?
- [ ] Is storage tenant-isolated?
- [ ] Are retries safe?
- [ ] What happens after partial upload?
- [ ] How are orphaned objects cleaned up?

---

# 23. Memory, CPU & Resource Bounds

- [ ] Is request memory bounded?
- [ ] Can user input cause unbounded allocation?
- [ ] Are large files streamed?
- [ ] Are result sets bounded?
- [ ] Are worker concurrency levels bounded?
- [ ] Are CPU-heavy jobs isolated?
- [ ] Can background jobs starve request-serving workloads?
- [ ] Are memory leaks detectable?
- [ ] Are OOM events observable?
- [ ] Is resource utilization measured by workload type?

---

# 24. Horizontal Scaling

- [ ] Is the service stateless where practical?
- [ ] What state prevents horizontal scaling?
- [ ] Is session state externalized if necessary?
- [ ] Can any instance serve any request?
- [ ] Are local caches safe?
- [ ] Are scheduled jobs duplicated across instances?
- [ ] Is leader election required?
- [ ] Can workers be added safely?
- [ ] Does scaling the application overload downstream systems?
- [ ] Are autoscaling metrics actually tied to bottlenecks?

---

# 25. Load Balancing & Routing

- [ ] How is traffic distributed?
- [ ] Are health checks meaningful?
- [ ] Can unhealthy instances be removed quickly?
- [ ] Is connection draining supported?
- [ ] Are sticky sessions required?
- [ ] If so, why?
- [ ] Is consistent hashing needed?
- [ ] Is routing tenant-aware?
- [ ] Can one backend receive disproportionate traffic?
- [ ] Are long-lived connections handled correctly?

---

# 26. Autoscaling

- [ ] What signal triggers scale-out?
- [ ] CPU?
- [ ] Memory?
- [ ] Request concurrency?
- [ ] Queue depth?
- [ ] Consumer lag?
- [ ] Custom workload metric?
- [ ] How long does scale-out take?
- [ ] Can bursts arrive faster than autoscaling reacts?
- [ ] Is minimum capacity sufficient?
- [ ] Is scale-in safe?
- [ ] Can scale-in interrupt work?
- [ ] Does autoscaling simply move the bottleneck downstream?

---

# 27. Observability

## Metrics

- [ ] Request rate measured?
- [ ] Error rate measured?
- [ ] Latency measured?
- [ ] p50/p95/p99 available?
- [ ] Saturation measured?
- [ ] Queue depth measured?
- [ ] Consumer lag measured?
- [ ] DB pool saturation measured?
- [ ] Cache hit ratio measured?
- [ ] Retry counts measured?
- [ ] Timeout counts measured?
- [ ] Rate-limit counts measured?
- [ ] External dependency latency/error rates measured?

## Logs

- [ ] Are logs structured?
- [ ] Is a request/correlation ID present?
- [ ] Can a user request be followed across services?
- [ ] Is tenant context present where safe?
- [ ] Are logs queryable?
- [ ] Are secrets excluded?
- [ ] Are sensitive values redacted?
- [ ] Are errors actionable rather than noisy?

## Tracing

- [ ] Is distributed tracing available?
- [ ] Are major dependencies represented as spans?
- [ ] Can slow paths be identified?
- [ ] Can retry behavior be seen?
- [ ] Can queue producer/consumer flows be correlated?

---

# 28. SLOs & Reliability Targets

- [ ] Is availability target defined?
- [ ] Is latency target defined?
- [ ] Is correctness target defined where relevant?
- [ ] Are SLOs user-centered?
- [ ] Is an error budget defined?
- [ ] Are alerts tied to SLO impact?
- [ ] Can the team distinguish transient noise from user-visible failure?
- [ ] Are critical and noncritical workflows measured separately?

---

# 29. Alerting

- [ ] Will the team know when users are impacted?
- [ ] Are alerts actionable?
- [ ] Are alerts based on symptoms rather than only infrastructure metrics?
- [ ] Are dependency failures visible?
- [ ] Are queue lag alerts configured?
- [ ] Are saturation alerts configured?
- [ ] Are error-budget burn alerts appropriate?
- [ ] Are alerts deduplicated?
- [ ] Is alert fatigue controlled?

---

# 30. Deployment Safety

- [ ] Can old and new application versions run simultaneously?
- [ ] Are API changes backward compatible?
- [ ] Are event schemas backward compatible?
- [ ] Are database migrations backward compatible?
- [ ] Is expand-and-contract migration used where necessary?
- [ ] Can deployments be canaried?
- [ ] Are feature flags available?
- [ ] Is rollback possible?
- [ ] What happens to data written by the new version after rollback?
- [ ] Are long-running jobs deployment-safe?
- [ ] Are queue consumers compatible with messages created by adjacent versions?

---

# 31. Failure Recovery

- [ ] What happens if an instance crashes?
- [ ] What happens if an availability zone fails?
- [ ] What happens if a region fails?
- [ ] What happens if the database fails?
- [ ] What happens if the cache fails?
- [ ] What happens if the queue fails?
- [ ] What happens if object storage fails?
- [ ] What happens if DNS/service discovery fails?
- [ ] Can the system restart safely?
- [ ] Can in-progress work resume?
- [ ] Can failed work be replayed?
- [ ] Is recovery automated where appropriate?

---

# 32. Disaster Recovery

- [ ] What is the RPO?
- [ ] What is the RTO?
- [ ] Are backups enabled?
- [ ] Are backups actually restorable?
- [ ] Are restore procedures tested?
- [ ] Is backup retention sufficient?
- [ ] Are cross-region backups needed?
- [ ] Are secrets/configuration recoverable?
- [ ] Can infrastructure be recreated?
- [ ] Is disaster recovery documented?
- [ ] Has a disaster recovery exercise been performed?

---

# 33. Testing for Scale & Failure

- [ ] Are load tests performed?
- [ ] Are tests representative of real traffic?
- [ ] Are burst tests performed?
- [ ] Are soak tests performed?
- [ ] Are large tenant/data-volume scenarios tested?
- [ ] Are timeout scenarios tested?
- [ ] Are retries tested?
- [ ] Are duplicate messages tested?
- [ ] Are out-of-order messages tested?
- [ ] Are partial failures tested?
- [ ] Are dependency outages tested?
- [ ] Is cache cold-start behavior tested?
- [ ] Is queue backlog recovery tested?
- [ ] Are race conditions tested?
- [ ] Are migrations tested against production-scale data?

---

# 34. Capacity Planning

- [ ] What is the maximum throughput per instance?
- [ ] What is the maximum throughput per database?
- [ ] What is the maximum throughput per queue/partition?
- [ ] What is the maximum throughput per cache cluster?
- [ ] What is the current utilization?
- [ ] How much headroom exists?
- [ ] What is the next known bottleneck?
- [ ] At what traffic level will it be reached?
- [ ] What is the plan before reaching it?
- [ ] Are downstream quotas included in capacity planning?

---

# 35. Cost Scalability

- [ ] How does cost grow with traffic?
- [ ] Is growth roughly linear?
- [ ] Are there hidden multiplicative costs?
- [ ] Can retries multiply external API cost?
- [ ] Can large tenants cause disproportionate infrastructure cost?
- [ ] Are expensive queries/jobs attributable?
- [ ] Are cache/storage/data-transfer costs monitored?
- [ ] Can low-value workloads be tiered or delayed?
- [ ] Are architectural optimizations justified by actual cost?

---

# 36. Security at Scale

- [ ] Are authentication controls resilient under load?
- [ ] Are authorization checks enforced consistently?
- [ ] Are secrets centrally managed?
- [ ] Are credentials rotated?
- [ ] Are sensitive fields redacted from logs?
- [ ] Are abuse controls present?
- [ ] Can rate limiting mitigate brute-force or scraping?
- [ ] Are tenant boundaries enforced everywhere?
- [ ] Can a malicious request trigger expensive computation?
- [ ] Are request/input sizes bounded?
- [ ] Are audit logs available for privileged operations?

---

# 37. Operational Ownership

- [ ] Who owns the service?
- [ ] Who responds when it fails?
- [ ] Is there a runbook?
- [ ] Are common failure modes documented?
- [ ] Are dashboards available?
- [ ] Are dependency owners known?
- [ ] Is there a rollback procedure?
- [ ] Is there a data-repair procedure?
- [ ] Is there a replay/reconciliation procedure?
- [ ] Can an engineer diagnose the service without reading the entire codebase?

---

# 38. Final Senior-Engineer Review Questions

Before calling the design production-ready, be able to answer:

- [ ] What is the first thing that breaks at 10x traffic?
- [ ] What happens if the slowest dependency gets 10x slower?
- [ ] What happens if that dependency disappears completely?
- [ ] What happens if every retry fires at once?
- [ ] What happens if the same request runs twice?
- [ ] What happens if two requests update the same record concurrently?
- [ ] What happens if events arrive twice?
- [ ] What happens if events arrive out of order?
- [ ] What happens if a worker dies halfway through?
- [ ] What happens if the cache is empty?
- [ ] What happens if the cache is unavailable?
- [ ] What happens if a queue accumulates hours of work?
- [ ] What happens if one tenant generates 50% of all traffic?
- [ ] What happens during deployment while both software versions are live?
- [ ] What happens if a schema migration partially completes?
- [ ] What happens if the system succeeds but the client times out?
- [ ] How does the system tell us it is unhealthy?
- [ ] How do we identify the exact bottleneck?
- [ ] How do we recover?
- [ ] How do we prove the recovery worked?

---

# Audit Outcome Template

For each important finding, document:

## Finding
Describe the component or workflow.

## Risk
What can fail, overload, duplicate, race, become inconsistent, or cascade?

## Current Behavior
What does the system do today?

## Expected Scale
Current and projected load.

## Severity
Critical / High / Medium / Low.

## Recommendation
Simplest change that adequately reduces the risk.

## Tradeoff
Complexity, cost, latency, operational burden, or development time added.

## Verification
Load test, failure test, unit test, integration test, metric, alert, or production signal that proves the mitigation works.

## Owner
Who owns the follow-up?

## Status
Open / Accepted Risk / Planned / Implemented / Verified.

---

# Core Principle

A scalable system is not one that never fails.

A scalable system:

- fails in bounded ways,
- protects itself under overload,
- avoids duplicate or inconsistent state,
- isolates failures,
- degrades gracefully,
- exposes enough telemetry to diagnose problems,
- and can recover predictably.

Every critical path should have a defensible answer to:

> What happens under concurrency, high volume, partial failure, dependency slowness, duplicate delivery, and deployment?
