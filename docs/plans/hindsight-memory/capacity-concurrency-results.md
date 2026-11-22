# Overnight backfill concurrency

2026-11-18, follow-up to [serial capacity and migration audit](capacity-backfill-results.md). Owner asked whether the roughly five-hour estimate assumed one request at a time and whether overnight processing could use three or the maximum practical concurrency.

**Yes: that estimate limited background inference to one request at a time. Six concurrent requests was the fastest tested setting; eight did not improve total throughput. Plan around 2–4 hours overnight for the current potential volume, pending a real migration rehearsal.** This is a planning allowance, not a promised migration duration or a proven hardware maximum.

## Matched experiment

At each limit, three fresh scratch banks received the same eight EN/HU source messages apiece (24 messages total). Native extraction completed across the banks, then native batch-one consolidation ran across them. Same pinned native engine, local model, mission and reasoning configuration as the serial test. The proxy enforced a global model-request limit of 1, 3, 6 or 8. No real chats were processed; no production service/model configuration changed. No foreground latency test at these higher limits: they are candidates for idle overnight use, not validated daytime settings.

| Background request limit | Extraction | Consolidation | Combined | Speedup vs matched serial | Linear estimate for 2,104 messages |
|---:|---:|---:|---:|---:|---:|
| 1 | 144.4 s | 43.5 s | 187.8 s | 1× | 4.6 h |
| 3 | 60.6 s | 24.3 s | 84.9 s | 2.2× | 2.1 h |
| 6 | 45.5 s | 22.2 s | 67.7 s | 2.8× | 1.65 h |
| 8 | 44.5 s | 26.3 s | 70.7 s | 2.7× | 1.72 h |

Applying the same measured speedups to the earlier five-hour estimate gives about 2.3 hours at three and 1.8 hours at six. Hence **roughly 1½–2 hours of ideal processing and a 2–4-hour overnight allowance** is reasonable for planning. That allowance is judgment, not a statistical confidence interval; long contexts, active-user pauses, retries, larger banks, catch-up and exception review can extend it.

The observed extraction concurrency reached each configured limit. Consolidation peaked at four simultaneous model calls in the six/eight tests: there were only three banks, each with sequential native consolidation and some duplicate checks. A source bank must retain its ordering; multiple users/project banks supply safe parallel work. More banks or a different workload could shift the best setting. Do not claim six is the model's maximum supported concurrency or that eight is intrinsically slower: this was one run per setting with stochastic output, shared/repetitive prompts and possible caching. Six and eight are close enough that output variation can explain their difference. There was no reason to load the shared model further merely to find a crash limit.

## Reliability observations

All model responses recorded by the proxy were HTTP 200 with `finish_reason: stop`; all native operations eventually completed. This does **not** mean there were no retries:

- At concurrency one, the much larger queue caused two native client request timeouts at about 120 seconds. Requests already in the proxy could continue after their caller timed out. One malformed extraction also triggered native schema recovery. One late response fell outside the timed phases; the experiment therefore includes retry/cancellation effects and is not a pure scheduler microbenchmark.
- At concurrency eight, two malformed extraction responses triggered native schema recovery. There were no recorded equivalent warnings in the three/six runs. This does not establish concurrency as their cause.
- Native raw/observation counts varied across runs. We retained all snapshots; this capacity exercise did not grade semantic quality. The earlier quality/current-list qualification remains the separate acceptance evidence.

**Implementation implication:** admission should happen in the app's durable delivery queue before work enters native request timeouts, with bounded native extraction fan-out as well as a global model budget. Native/request timeout and cancellation handling must be aligned. Do not eagerly enqueue an entire backfill behind a serial HTTP proxy and let it retry indefinitely. At night, a six-request budget is a reasonable starting ceiling; during active chat, reduce to the measured one-background-request setting or pause backfill. Preserve fairness across users, source ordering, stable operation/source revision IDs and normal retries. This is scheduling, not a replacement memory engine.

## Remaining work

The faster results change the capacity estimate, not the [migration exceptions and implementation/release gates](capacity-backfill-results.md#what-remains-before-implementation-and-before-release). Before implementation: settle historical eligibility/exclusion policy and record the bounded full-replacement plan, then receive implementation authorization. During implementation: actual durable scheduling/publication and privacy integration, full approved UI, real migration rehearsal/catch-up/cutover, deployed latency and operational acceptance. No further broad model bake-off is needed.

Evidence: [results](capacity-concurrency/results.json), [analysis](capacity-concurrency/analysis.json), `capacity-concurrency/analyze.py` and `capacity-concurrency/run.cjs` in the [source archive](research-source/README.md), [model calls](capacity-concurrency/model-calls.jsonl), and native `server.log`. All twelve scratch banks were deleted successfully ([cleanup](capacity-concurrency/cleanup.json)); both scratch services were stopped. File checksums are in `capacity-concurrency/SHA256SUMS`. No product implementation, real migration or deployment occurred.
