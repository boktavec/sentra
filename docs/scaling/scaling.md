# Sentra Scaling Strategy

## Goal

Sentra should be designed so application and worker capacity can increase without fundamentally rewriting the system.

Do not optimize for hypothetical internet scale on day one. Scale through measured bottlenecks.

## Progressive Load Targets

Use progressive test stages such as:

- 10 users
- 100 users
- 1,000 users
- 10,000 users
- 100,000 modeled users
- larger simulated populations
- eventual 10M-user capacity-planning exercise

Registered users, concurrent users, and requests per second are different measurements and should not be treated interchangeably.

## Primary Metrics

Measure:
- requests/sec
- p50 latency
- p95 latency
- p99 latency
- error rate
- CPU
- memory
- database query latency
- connection-pool usage
- cache hit rate
- queue depth
- consumer lag
- worker throughput
- storage throughput
- AI inference latency

## Application Scaling

Prefer stateless API and web services where practical.

Scale by increasing replicas behind a load balancer.

Do not store request/session state in process memory when it must survive across replicas.

## Data Pipeline Scaling

Crawler and processing capacity should scale independently.

Measure:
- incoming records/sec
- fetch throughput
- normalization throughput
- event lag
- storage write throughput

When input exceeds processing capacity, the system should apply backpressure or accumulate durable queued work rather than collapse.

## Multi-Tenant Scale

Load tests should simulate uneven tenant sizes.

Ask:
- Can one large tenant degrade smaller tenants?
- Are rate limits tenant-aware?
- Can one tenant create unbounded queue pressure?
- Are expensive AI operations isolated or limited?

The noisy-neighbor problem is part of the scale model.

## Database Evolution

Start with PostgreSQL.

Scale in response to evidence:
1. improve queries/indexes
2. tune connection pools
3. introduce PgBouncer when needed
4. cache appropriate reads
5. consider read replicas
6. partition large tables
7. move analytics to ClickHouse
8. consider sharding only when simpler options are insufficient

## Load Testing

Use k6 for repeatable API workloads.

Load tests should model realistic traffic mixes rather than repeatedly hitting one trivial endpoint.

Record every meaningful scale experiment under `docs/scaling/` with:
- workload
- infrastructure assumptions
- before metrics
- bottleneck
- change made
- after metrics
- conclusion

## Scaling Principle

The desired loop is:

```text
Baseline
  -> Load
  -> Observe
  -> Find bottleneck
  -> Change one thing
  -> Re-test
```

Architecture changes should be justified by measurements whenever possible.
