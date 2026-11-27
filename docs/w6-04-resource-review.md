# W6-04 Resource Review and Cost Control

**Task ID:** W6-04
**Week:** 6
**Epic:** Cost control
**Priority:** P1
**Owner/Lane:** DevOps/Product
**Dependency:** W6-02 (Observability)
**Status:** In Progress — implementation complete, production acceptance pending
**Acceptance:** Baseline + upgrade threshold documented
**Target environment:** Live (Contabo VPS)
**Specification reference:** Cost policy

---

## 1. Current Infrastructure Inventory

### Deployment target

| Item | Value | Source |
|------|-------|--------|
| Provider | Contabo VPS | README.md — Production deployment |
| OS | Ubuntu 24.04 | README.md — Production runbook |
| Container runtime | Docker | docker-compose.yml |
| Node.js | 24.19.0 (LTS) | README.md — Requirements |
| npm | 11.17.0 | README.md — Requirements |
| Deployment tool | PM2 | README.md — Production deployment |
| CI pipeline | GitHub Actions (4 parallel jobs) | README.md — Continuous integration |

### Infrastructure components (docker-compose.yml)

| Component | Image | Host port | Container port | Notes |
|-----------|-------|-----------|----------------|-------|
| PostgreSQL | postgres:18-alpine | 55432 | 5432 | Loopback only (127.0.0.1) |
| Redis | redis:8-alpine | 56379 | 6379 | Loopback only (127.0.0.1) |

### Application processes (run on host, not containers)

| Process | Port | Technology | Binding |
|---------|------|------------|---------|
| API | 3001 | NestJS 12 | 0.0.0.0 |
| Web | 3000 | Next.js 16 | — |
| Admin | 3002 | Next.js 16 | — |
| Worker | — | NestJS 12 | — |

### VPS configuration

**NOT DOCUMENTED.** The following are NOT in the repository and must not be invented:
- Contabo VPS plan/specs (CPU cores, RAM, disk size)
- Monthly cost
- Current resource utilization
- Disk growth rate
- Network traffic volume

These must be measured on the actual VPS before thresholds can be validated.

---

## 2. Available Resource Monitoring Capabilities

### W6-02 Observability (implemented, typecheck-verified)

| Capability | File | Metrics collected |
|------------|------|-------------------|
| Host CPU load | `packages/shared/src/resource-collector.ts` | load1, load5, load15, cpuCount, loadPercent |
| Host CPU utilization | `packages/shared/src/resource-collector.ts` | utilizationPercent (Linux /proc/stat) |
| Host memory | `packages/shared/src/resource-collector.ts` | totalBytes, freeBytes, usedBytes, usedPercent |
| Swap memory | `packages/shared/src/resource-collector.ts` | swapTotalBytes, swapFreeBytes, swapUsedBytes, swapUsedPercent (Linux /proc/meminfo) |
| Host disk | `packages/shared/src/resource-collector.ts` | totalBytes, freeBytes, usedBytes, freePercent, growthRateBytesPerHour |
| Network I/O | `packages/shared/src/resource-collector.ts` | bytesIn, bytesOut (cumulative), bytesInPerSecond, bytesOutPerSecond (Linux /proc/net/dev) |
| Container resources | `packages/shared/src/resource-collector.ts` | cpuUsageNanoseconds, memoryUsageBytes, memoryLimitBytes, memoryUsedPercent (Linux cgroup) |
| Current process | `packages/shared/src/resource-collector.ts` | pid, name, memoryRssBytes |
| Queue depth | W6-02 `packages/shared/src/metrics.ts` | QueueDepthSample (waiting, active, delayed, failed, oldestWaitingAgeMs) |
| Alert evaluation | W6-02 `packages/shared/src/alert.ts` | Threshold evaluation with consecutive breaches, sustained duration, cooldown |
| Default alert rules | `packages/shared/src/metrics.ts` | queue_depth_high, queue_depth_critical, host_cpu_high, host_memory_high, host_disk_low, queue_oldest_waiting_age, provider_failures, payment_failures |

### Existing shell monitoring script

| Script | File | Metrics | Platform |
|--------|------|---------|----------|
| monitor-resources.sh | `infrastructure/scripts/monitor-resources.sh` | CPU load (/proc/stat), memory (/proc/meminfo), disk (df) | Linux only |

### Not yet implemented

| Capability | Gap |
|------------|-----|
| Per-application resource consumption (API, Worker, Web, Admin separately) | No per-process tracking beyond current process |
| PostgreSQL resource consumption | No direct PostgreSQL metrics collection |
| Redis resource consumption | No direct Redis metrics collection |
| API/Worker observability transport | Worker and API run as separate processes with in-memory alert state only |
| Persistent alert state | Alert state is in-memory only, does not survive restarts |
| Notification delivery | Structured-log notifier only (log-only, no external delivery) |

---

## 3. Baseline Collection Methodology

### Collection tooling

**File:** `packages/shared/src/resource-collector.ts`

Dependency-free, read-only resource collection using only Node.js built-in modules:
- `node:os` — CPU load averages, memory totals, CPU count
- `node:fs/promises` — Disk stats via `statfs()`, swap via `/proc/meminfo`, network via `/proc/net/dev`, container via `/sys/fs/cgroup`

**Key design principles:**
- **Read-only:** Collection never mutates queue state, payment state, or provider state
- **Cross-platform:** Works on Linux (production VPS) and Windows (local development)
- **Graceful degradation:** Linux-specific sources (/proc, /sys, cgroup) are read where available; silently skipped elsewhere with `undefined` values
- **Never zero:** Missing/unavailable metrics are `undefined`, never zero
- **Lightweight:** Single tick collection, no long-running processes, no external network requests
- **Bounded:** File reads have implicit timeouts via Node.js fs promises

**API:** `collectResourceSnapshot(input)` returns a `ResourceSnapshot` with timestamp, CPU, memory, disk, network, container, currentProcess, and optional queueDepth.

### Baseline recording procedure

1. **Deploy W6-02 observability** to the VPS (API + Worker processes running)
2. **Collect snapshots** at regular intervals using `collectResourceSnapshot()` with `queueDepth` from BullMQ
3. **Record baselines** during:
   - Normal operating periods (typical daily usage)
   - Peak operating periods (campaign launches, high traffic)
   - Sustained utilization periods (multi-hour stable load)
4. **Store snapshots** with timestamps for trend analysis
5. **Re-collect** after any configuration change or traffic pattern change

### Observation periods

| Period | Purpose | Minimum duration |
|--------|---------|------------------|
| Normal operating | Establish typical baseline | 7 days |
| Peak operating | Establish worst-case baseline | 7 days (covering multiple peaks) |
| Sustained utilization | Confirm stability | 14 days |
| Campaign processing | Measure campaign workload impact | Per campaign (start to finish) |

---

## 4. Resource Baseline Recording Template

| Metric | Normal baseline | Peak baseline | Sustained | Unit | Source |
|--------|-----------------|---------------|-----------|------|--------|
| CPU load1 | | | | load | resource-collector.ts |
| CPU loadPercent | | | | % | resource-collector.ts |
| CPU utilizationPercent | | | | % | resource-collector.ts (/proc/stat) |
| Memory totalBytes | | | | bytes | resource-collector.ts |
| Memory freeBytes | | | | bytes | resource-collector.ts |
| Memory usedPercent | | | | % | resource-collector.ts |
| Swap totalBytes | | | | bytes | resource-collector.ts (/proc/meminfo) |
| Swap freeBytes | | | | bytes | resource-collector.ts (/proc/meminfo) |
| Swap usedPercent | | | | % | resource-collector.ts |
| Disk totalBytes | | | | bytes | resource-collector.ts (statfs) |
| Disk freeBytes | | | | bytes | resource-collector.ts (statfs) |
| Disk usedPercent | | | | % | resource-collector.ts |
| Disk growthRateBytesPerHour | | | | bytes/hr | resource-collector.ts |
| Network bytesIn (cumulative) | | | | bytes | resource-collector.ts (/proc/net/dev) |
| Network bytesOut (cumulative) | | | | bytes | resource-collector.ts (/proc/net/dev) |
| Network bytesInPerSecond | | | | bytes/s | resource-collector.ts |
| Network bytesOutPerSecond | | | | bytes/s | resource-collector.ts |
| Container memoryUsageBytes | | | | bytes | resource-collector.ts (cgroup) |
| Container memoryLimitBytes | | | | bytes | resource-collector.ts (cgroup) |
| Container memoryUsedPercent | | | | % | resource-collector.ts (cgroup) |
| Queue waiting | | | | count | W6-02 observability |
| Queue failed | | | | count | W6-02 observability |
| Queue oldestWaitingAgeMs | | | | ms | W6-02 observability |

---

## 5. Proposed Upgrade Thresholds

**ALL THRESHOLDS ARE PROPOSALS until approved by the owner.** They are based on industry-standard VPS sizing guidance, not on TruevineVoice production measurements (which do not exist yet).

CPU load average and CPU utilization are distinct metrics:
- **Load average** measures the number of processes waiting for CPU time (can exceed 100% on multi-core systems).
- **Utilization** measures the percentage of CPU time spent on non-idle work (0-100%).

Memory pressure should be based on **available memory** (MemAvailable), not just free memory, since available includes reclaimable cache.

| Metric | Warning | Critical | Min sustained period | Investigation before upgrade | Upgrade justification |
|--------|---------|----------|---------------------|------------------------------|----------------------|
| CPU load average | 70% of cores | 90% of cores | 15 minutes | Check for runaway processes, inefficient queries | Sustained >90% for 1 hour |
| CPU utilization | 75% | 90% | 15 minutes | Check for busy loops, tight polling | Sustained >90% for 1 hour |
| Memory usedPercent (free-based) | 80% | 90% | 15 minutes | Check for memory leaks | Sustained >90% for 1 hour |
| Memory availablePercent | 20% | 10% | 15 minutes | Check for insufficient RAM | Sustained <10% for 1 hour |
| Swap usedPercent | 10% | 25% | 10 minutes | Check for insufficient RAM | Any sustained swap usage |
| Disk freePercent | 20% | 10% | 30 minutes | Check for log growth, unpruned temp files | Projected exhaustion < 7 days |
| Disk growthRateBytesPerHour | 1 GB/hr | 5 GB/hr | 1 hour | Check for runaway logging, audio upload spikes | Sustained >5 GB/hr for 24 hours |
| Network bytesInPerSecond | 50% of link capacity | 80% of link capacity | 5 minutes | Check for DDoS, misconfigured clients | Sustained saturation |
| Network bytesOutPerSecond | 50% of link capacity | 80% of link capacity | 5 minutes | Check for runaway responses, scraping | Sustained saturation |
| Queue waiting | 50 | 100 | 5 minutes | Check for worker downtime, slow processing | Sustained >100 for 15 minutes |
| Queue failed | 5 | 10 | 5 minutes | Check for provider issues, bad payloads | Sustained >10 for 15 minutes |
| Queue oldestWaitingAgeMs | 300,000 (5 min) | 900,000 (15 min) | 10 minutes | Check for worker stuck, deadlock | Sustained >15 min for 30 minutes |
| Container memoryUsedPercent | 80% | 90% | 15 minutes | Check for container memory limit | Sustained >90% for 1 hour |
| Application response time (p95) | 2x baseline | 5x baseline | 10 minutes | Check for slow queries, external calls | Sustained degradation |
| Database query time (p95) | 1s | 5s | 10 minutes | Check for missing indexes, lock contention | Sustained degradation |

### Temporary spike vs sustained constraint

- **Temporary spike:** Single collection above threshold, or consecutive breaches < `sustainedForMs` — do NOT trigger upgrade consideration
- **Sustained constraint:** Consecutive breaches >= `sustainedForMs` — investigate before upgrade
- **Upgrade decision:** Only after sustained critical threshold + investigation confirms optimization is insufficient

### Investigation requirements (before any upgrade)

1. **Validate measurement accuracy** — confirm the metric is genuinely resource-constrained, not a monitoring or collection error
2. **Check application logs** for error spikes
3. **Verify no runaway processes or loops**
4. **Check database** for unindexed queries, missing constraints, lock contention
5. **Verify queue workers** are healthy and processing
6. **Attempt optimization** (log rotation, query indexing, cache tuning, connection pool tuning) first
7. **Document the optimization attempt and result**
8. **Prepare an upgrade proposal** only when sustained resource constraints remain after optimization
9. **Obtain explicit owner approval** before any purchase or VPS resizing

### Swap usage guidance

Swap usage alone does not justify a VPS upgrade. Some swap usage is normal on Linux systems. Investigate swap usage only when:
- Swap usage is sustained above 25%, OR
- Swap-in/swap-out activity is high (thrashing), OR
- Memory availablePercent is below 10%

---

## 6. Capacity Planning Decision Matrix

| Condition | CPU load | CPU util | Memory available | Disk free | Network | Queue | Action |
|-----------|----------|----------|------------------|-----------|---------|-------|--------|
| All below warning | <70% cores | <75% | >20% | >20% free | <50% link | <50 waiting | Monitor only |
| One metric at warning | 70-90% cores | 75-90% | 10-20% | 10-20% free | 50-80% link | 50-100 waiting | Investigate, optimize |
| One metric at critical | >90% cores | >90% | <10% | <10% free | >80% link | >100 waiting | Investigate, upgrade candidate |
| Multiple metrics at critical | Multiple >90% | Multiple >90% | Multiple <10% | Multiple <10% | Multiple saturated | Multiple backed up | Investigate, prepare upgrade proposal |
| Disk growth >1 GB/hr | — | — | N/A | N/A | — | — | Investigate log/audio growth |
| Swap usage >10% | — | >10% | — | — | — | — | Add RAM or reduce memory usage |

### Escalation path

1. **Warning level:** Investigate within 24 hours, optimize if possible. Do NOT upgrade based on warning alone.
2. **Critical level:** Investigate within 4 hours. Attempt optimization first. Upgrade only if optimization fails and constraint is sustained.
3. **Multiple critical:** Investigate all metrics in parallel. Prepare an upgrade proposal. Obtain owner approval before any purchase or resizing. Do NOT upgrade immediately without investigation.

---

## 7. Cost Optimization Recommendations

| Area | Recommendation | Expected impact |
|------|---------------|-----------------|
| Worker concurrency | Tune BullMQ concurrency based on CPU cores; avoid over-subscription | Moderate — reduces CPU contention |
| Queue scheduling | Schedule non-urgent jobs during off-peak hours; use rate limiting | Moderate — smooths peak load |
| Database optimization | Index frequently queried columns; vacuum regularly; tune connection pools | Moderate — reduces CPU and disk I/O |
| Redis memory management | Set appropriate TTL on keys; avoid storing large payloads in Redis | Low — Redis is lightweight |
| Log retention | Rotate logs; compress old logs; prune application logs per approved retention policy | Moderate — reduces disk growth |
| Audio asset storage | Set storage quotas per organization; retain per approved retention policy | Moderate — audio is typically the largest asset class |
| Container resource allocation | Right-size container memory limits based on measured usage; do not assume containers are unconstrained | Low — measure before concluding |
| Monitoring overhead | Keep collection interval >= 30 seconds; avoid per-request instrumentation; bounded collection with timeout | Low — monitoring is already lightweight |

**Data retention:** Do not delete audit records or audio assets without an approved retention policy. Deletion of financial or audit data must follow compensating entry procedures (append-only ledger principle).

**Container constraints:** Container memory and CPU limits must be measured before concluding they are unconstrained. cgroup v1/v2 metrics provide the basis for this measurement.

**Monitoring retention:** Monitoring data itself has retention overhead. Retain raw samples for no longer than necessary for trend analysis (recommended: 30 days raw, 12 months aggregated).

**No changes to existing configuration are made by this document.** All recommendations are for future consideration.

---

## 8. Production Measurement Procedure

1. **Deploy W6-02** to the VPS (API + Worker + observability)
2. **Start collection** using `collectResourceSnapshot()` at 30-second intervals
3. **Record baselines** in the template above for normal and peak periods
4. **Monitor alert rules** — W6-02 default alert rules provide initial thresholds
5. **Review weekly** — compare current usage against baselines
6. **Update thresholds** — adjust based on observed production patterns
7. **Make upgrade decision** — only after sustained critical thresholds + investigation

---

## 9. Dependency on W6-02

W6-04 builds on W6-02 (Observability) but implements its own resource collection:

| W6-02 component | W6-04 usage |
|-----------------|-------------|
| `QueueDepthSample` type | Queue depth metrics in snapshots |
| `AlertRule` / `DEFAULT_ALERT_RULES` | Initial threshold definitions and alert evaluation patterns |
| `AlertEvaluationService` | Reference pattern for alert evaluation (W6-04 uses independent evaluation) |
| `AlertRuleTracker` | Reference pattern for consecutive breach tracking |
| `StructuredLogNotifier` | Reference pattern for log-only alert notification |
| `HostResourceSnapshot` type | Reference pattern for host resource snapshots (W6-04 uses `ResourceSnapshot` instead) |

**W6-04 does not reuse W6-02's `sampleHostResources()`.** W6-04 implements independent resource collection in `packages/shared/src/resource-collector.ts` with cross-platform support, bounded collection, and proper handling of unavailable metrics.

**W6-04 does not modify W6-02 files.** W6-04 adds new tooling in `packages/shared/src/resource-collector.ts` that complements W6-02.

**W6-04 does not modify `packages/shared/src/resources.ts`.** The existing `resources.ts` file remains unchanged. W6-04's `resource-collector.ts` is a separate, corrected implementation.

---

## 10. Outstanding Production Verification Requirements

| Requirement | Status | Notes |
|-------------|--------|-------|
| VPS resource specs (CPU, RAM, disk) | Not available | Must be measured on actual VPS |
| Production cost figures | Not available | Must not be invented |
| Baseline measurements | Not available | Requires W6-02 deployed to VPS |
| Threshold validation | Not available | Proposals only until approved |
| Upgrade decision procedure | Not available | Requires owner approval |
| Cross-platform verification | Partial | Linux fixtures tested; Windows untested |
| ESLint verification | Not complete | ESLint hangs in current environment |
| API-wide typecheck | Unresolved | Exit code 2 in `correlation-id.middleware.spec.ts` (pre-existing, not W6-04 ownership) |
| Shared package typecheck | PASS | `tsc --noEmit -p packages/shared/tsconfig.json` |
| Shared package tests | PASS | 93 tests passing |
| Shared package build | PASS | `npm run build --workspace @truevine/shared` |
| Resource collector tests | PASS | 36 tests passing |

---

## 11. Files Created and Modified

### Created

| File | Purpose |
|------|---------|
| `packages/shared/src/resource-collector.ts` | Dependency-free, cross-platform resource collection tooling |
| `packages/shared/src/resource-collector.spec.ts` | 36 unit tests for resource collector |
| `docs/w6-04-resource-review.md` | This document |

### Modified

| File | Change |
|------|--------|
| `packages/shared/src/index.ts` | Added `export * from './resource-collector.js';` |

### Build artifact

| Artifact | Status |
|----------|--------|
| `packages/shared/dist/` | Rebuilt successfully |

---

## 12. Recommended Workplan Status

**W6-04: In Progress.**

Implementation complete:
- Resource collection tooling built and tested (36 tests passing)
- Typecheck clean (shared package)
- Build successful
- Documentation created with baseline template, thresholds, cost optimization

**Not complete (production acceptance pending):**
- VPS resource specs not yet measured
- No baseline data collected from production
- Thresholds not yet approved by owner
- No live resource monitoring deployed

**Do not mark W6-04 Complete until genuine live resource baseline evidence and approved upgrade thresholds are documented.**

---

## 13. Next Eligible Independent Development Task

| Field | Value |
|-------|-------|
| Task ID | W6-03 |
| Week | 6 |
| Epic | Recovery |
| Task | Backup restore drill |
| Implementation guidance | Restore DB into isolated environment; validate wallet/campaign integrity. |
| Owner/Lane | DevOps/QA |
| Dependency | W1-10 |
| Priority | P0 |
| Status | Not Started (per workplan) |
| Acceptance / Evidence | Restore evidence + measured time |
| Environment | Isolated |
| Spec Ref | §31 |

W6-03 depends on W1-10 (Backups), not W6-02. It can proceed independently of W6-04. W6-04 depends on W6-02 (Observability), which has been handed off but not yet production-accepted.

W7-01 (Pilot onboarding) depends on W6 (which includes W6-02, W6-03, W6-04), so it cannot proceed until W6 tasks reach an acceptable state.

**Do not start W6-03 or W7-01 without owner authorization.**
