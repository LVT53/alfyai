# Local-model capacity and per-user backfill

2026-11-18. **Capacity is practical enough to proceed to implementation planning. Safe migration still needs an explicit policy for historical exclusions and incomplete provenance.** No product implementation, real-chat ingestion, migration or deployment occurred. Production access was aggregate read-only SQL; synthetic inference used the already authorized local model.

**Later same-session follow-up:** [overnight concurrency testing](capacity-concurrency-results.md) completed at limits 1/3/6/8. Six was fastest tested, about 2.8× matched serial throughput. The 5–10-hour allowance below is for serial background processing; overnight planning can instead use roughly 2–4 hours, subject to the documented limits and real migration rehearsal.

## Method and evidence

Pinned native Hindsight `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, the same current-information mission and supported per-bank `consolidation_llm_batch_size: 1` as the [current-list follow-up](current-list-followup-results.md). Native extraction, reasoning enabled, 8,192 output-token allowance; no replacement extractor or engine patch. Model alias `qwen3-6-27b` routes to the configured local Flash Next service; its name is not verified parameter size.

Scratch Hindsight/embeddings/reranking ran on the Mac, inference through the existing SSH bridge. A measured proxy admitted **one background model request at a time**, with short foreground probes allowed alongside it. Native queued requests were preserved. Times include transport and local processing. This is not a deployed production-host benchmark or a GPU-memory/power measurement.

Reproducible evidence: [analysis.json](capacity-backfill/analysis.json), `capacity-backfill/analyze.py` in the [source archive](research-source/README.md), [main results](capacity-backfill/results.json), [growth results](capacity-backfill/growth-results.json), [frozen inputs](capacity-backfill/frozen.json), [model calls](capacity-backfill/model-calls.jsonl), and [aggregate inventory](capacity-backfill/inventory.json). These contain synthetic text or anonymous aggregate counts, not production chat text. The three scratch banks were deleted successfully; scratch services were stopped. See [cleanup](capacity-backfill/cleanup.json) and checksums in `capacity-backfill/SHA256SUMS`.

## Measured capacity

| Work | Result |
|---|---|
| 16 short EN/HU user messages, about 110 characters each | 105.8 s native extraction; 24 raw facts |
| Consolidate those same facts, batch size 1 | 33.3 s; repeat 34.2 s |
| Consolidate those same facts, batch size 8 | 25.2 s |
| Same 16 messages with 1,651 characters of labelled assistant context each | 97.7 s extraction + 34.3 s consolidation |
| Single 11,168 / 24,146 / 48,149-character synthetic pasted inputs | 19.3 / 19.4 / 35.6 s extraction; 11.2 s combined consolidation |
| Four ordinary live turns, including changes to earlier facts | 5.1–8.2 s each, extraction through consolidation |
| Four dense messages containing 48 additional bin capacities | 25.2 s extraction + 24.3 s consolidation; bank grew from 39 to 87 observations |
| New capacity correction in that accumulated bank | 7.1 s; native observation contained the new 25-litre value |

One-fact consolidation cost about **34% more consolidation wall time**, but only **6.5% more extraction-plus-consolidation time** on the paired short workload. It used 32–33 model calls versus 12 for batch size eight, including native duplicate checks. The main consolidation calls were 24 versus four; native grouping means this is not simply one request per displayed row. Prompt tokens were about 168–175k versus 32k for consolidation alone. Local elapsed time is favorable, but a later move to paid per-token inference would need a separate cost calculation.

Dense growth produced four compound raw facts and 48 observations. Consolidating these used four main calls plus **34 native duplicate checks**. There is real content-dependent overhead; message count alone does not predict cost. No HTTP failures, output-length finishes or failed native operations occurred in the recorded phases. One native warning dropped a conflicting delete when the same response also updated that observation; the operation completed. This is a capacity result, not a new claim of perfect extraction quality.

The context workload is repetitive and may benefit from caching; it does **not** prove assistant context is free or establish the final context-packing strategy. Native observations still included fictional-example facts and some translated wording. Long pasted inputs were repetitive synthetic configuration, not arbitrary dense real conversations. Bank growth reached 87 observations, not thousands; prior bounded-update tests remain separate evidence. Rebuild observation counts varied (31/32/36), reinforcing that stable native row identity cannot be assumed.

### Foreground interference

Short, non-streaming completion probes: five baseline samples median **368 ms**, 42 loaded samples median **444.5 ms**, maximum **870 ms**; three after samples median **384 ms**. All succeeded. This measures complete short responses, **not first-token latency**, long chat turns, multiple simultaneous users or a production latency guarantee. No foreground probes ran during the separate growth phase.

Keep a shared low-priority model admission limit, fair per-user jobs and pause/backoff under live load. The prototype's single-background-request limit is a measured starting point. Merely limiting Hindsight job count is insufficient because it can submit several model requests concurrently. Do not put consolidation on the chat-response critical path or rebuild the entire bank after every turn.

## Actual volume and planning estimate

Read-only inventory found six currently enabled accounts, 754 potentially eligible chats, 2,104 user messages, 756,357 user characters and 4,008,460 assistant characters. Thirteen project scopes exist in addition to personal scopes. Thirty-two incognito messages were excluded; no current reset records or imported-message flags were found. These are **potential inputs**, not permission to migrate all of them: historical memory-off periods and user exclusions remain unresolved.

At the short-workload rate of 8.72 seconds per message, the simple linear estimate is **5.1 hours total**. The contextual workload gives about 4.8 hours. A practical planning allowance is **roughly 5–10 hours**, before long pauses for active users or resolving migration exceptions. The upper value is an explicit 2× allowance, not a measured confidence bound. A real dry run must replace this estimate before promising cutover time.

| Anonymous account | Potential user messages | Linear estimate | 2× planning allowance |
|---|---:|---:|---:|
| User 1 | 471 | 68 min | 137 min |
| User 2 | 256 | 37 min | 74 min |
| User 3 | 568 | 83 min | 165 min |
| User 4 | 2 | under 1 min | under 1 min |
| User 5 | 253 | 37 min | 74 min |
| User 6 | 554 | 81 min | 161 min |

These figures exclude startup, verification, retries, catch-up and manual exception handling. User 3 has a heavier long-message tail; User 6 has the two user messages over 16k characters (maximum 23,809). Assistant replies can reach 54,976 characters. Do not blindly concatenate complete conversations or omit necessary attribution/context merely to meet the estimate. Context selection must preserve short dependent replies, quoted material and assistant/user distinction.

Recent traffic was 110 user messages over seven days, across all six accounts. Linear extrapolation is **about 2.3 background minutes per day**, or roughly 2–5 minutes with the same allowance. Bursts, output density and model contention can be much worse than this daily average. Preparing inactive banks ahead of per-user cutover is plausible; no need to start every user with empty memory.

## Migration exceptions uncovered

Read-only scripts/results: `inventory`, `exceptions`, `actions`, and `reviews` under `capacity-backfill/`. Inventory queries ran at separate times while production remained active; they are planning snapshots, not a frozen migration snapshot.

- **28 active user-authored profile statements.** Twenty-five have no legacy provenance row; standalone summary edits can legitimately lack a chat source. Preserve trustworthy authored text and its scope/action ordering rather than importing the generated portrait.
- **38 deleted/suppressed profile rows.** Thirty-seven have successful user removal telemetry. Inherited generated origin does not make the subsequent user removal automatic or disposable.
- **96 saved `do_not_remember` review decisions**, referencing 105 distinct existing profile items. Only six referenced items are currently deleted/suppressed: **99 are outside that obvious exclusion list**. These decisions must be included in the migration audit. Counts overlap; do not add 96 decisions and 38 rows as distinct memories.
- Some removal provenance uses historical/indirect identifiers or references missing messages/chats. A failed direct ID join is not proof that no mapping exists: inspect available resolution/evidence metadata during the bounded migration audit. Do not silently regenerate excluded material or omit entire unrelated chats.
- Current memory-enabled flags do not prove historical enabled periods. The preferences route writes the current flag without a corresponding temporal history; the judge watermark is not evidence of uninterrupted consent. No reliable historical interval ledger was established by this audit.
- Fork metadata exists (52 copied messages across three accounts, all roles). Use explicit source lineage so a fork does not become a fresh assertion. The original assertion date and trustworthy later deliberate edit date remain different concepts.

The narrow existing correction/removal mechanism can enforce **mapped** choices. Inventing a global semantic prohibition engine to reconstruct every ambiguous historical exclusion would be rebuilding too much. Unresolved material should stay out of publication while unaffected material can migrate, with a clear exception report. A content-aware local audit must determine the affected units; aggregate counts cannot establish that mapping.

## What remains before implementation, and before release

**No further generic model bake-off or open-ended memory architecture search is warranted by these results.** The native engine is a viable implementation target, with the qualified limits in the current-list and Edit/Remove reports. This does not certify complete integrated feature parity.

Before implementation begins:

1. Freeze the migration policy: historical memory-off uncertainty, indirect/missing exclusion mappings, verified standalone edits and old messages without trustworthy edit dates. Recommend conservative publication of verified eligible material, a separate report for unresolved material, and no legacy generated facts as seeds. Any broader history import requires an explicit owner policy; current-enabled status alone is not authorization.
2. Write the concrete full-replacement implementation plan against the approved UI and current native contracts. Keep the app-owned boundary to authentication/scope, source revisions and user intent, accepted publication/revocation, resumable scheduling and migration. Include model admission/backoff and pinned-source formatting compatibility. Do not reintroduce extraction, a semantic canonicalizer, nightly repair, or arbitrary split/merge lineage promises.
3. Obtain the owner's implementation instruction. This session authorizes tests and documentation only.

During implementation, before enabling the replacement for real users:

- Complete A1–A5 in [replacement readiness](replacement-readiness.md): authenticated personal/project isolation; on/off/incognito/reset/erase and late-job behavior; Normal/retry/stream/tool integration; the complete approved UI with truthful Edit/Remove failure/retry, search, source navigation, EN/HU/accessibility/animations; and operational recovery/configuration.
- Exercise actual durable queues, prepared revisions, publication transactions and cache revocation under interruption, stale actions, deleted sources and concurrent chat edits. Scratch tests do not prove the production adapter.
- Rehearse real per-user migration locally under the agreed policy: source/context packing, all known manual actions and exclusions, fork deduplication, catch-up, permission rechecks, atomic cutover and rollback. Audit representative EN/HU recall and retain the previously found adversarial regressions. Verify larger banks and foreground latency on the intended service deployment.
- Establish service backups/restore, monitoring, bounded logs/retention, upgrade checks and actual product gates. Never run old and new memory as competing authorities after cutover.

**Recommendation:** proceed to that bounded plan and migration-policy decision. Capacity no longer blocks choosing Hindsight. Historical exclusion handling is the remaining substantive migration question; the rest is implementation and release verification, not another bespoke memory system.
