# Bounded Hindsight updates: P2 evidence and design boundary

2026-11-18. **Native per-claim documents make bounded updates feasible; whole-bank rebuilding is unnecessary. Native writes do not enforce AlfyAI's desired revision.** A small app-owned intent/acknowledgement ledger and guarded read boundary remain necessary. This establishes a practical mechanism conditional on P1's claim representation; it does not certify production capacity, distributed recovery, or complete feature parity.

Evidence: [reproduction and artifacts](bounded-update-prototype/README.md), [size results](bounded-update-prototype/size-results.json), [native overlapping-source results](bounded-update-prototype/overlap-results.jsonl), [offline admission checks](bounded-update-prototype/read-gate-results.json). Source pin `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, evaluator1.2.1. All data synthetic, tenant `synthetic-v2-p06`, banks `ready-p2-*`; no product changes, upstream changes, production reads or expensive external model calls. Consolidation used the shared local model evaluator; the old `common.cjs` model label is not independent evidence of the evaluator's deployed model identity.

## Native mutation and growth

Each claim was a separate native document with chunks extraction and literal supplied entities (`resolve_entities:false`). The resolved bank configuration was read back to verify observations disabled during the size ladder. Population was410claims total, split between10/100/300banks. Each bank received one target update and an identical retry.

| Bank claims | Population elapsed | Single-document update | Identical retry | Changed unrelated raw IDs/text | Raw count after update |
|---|---:|---:|---:|---:|---:|
|10|1,015ms|1,016ms|1,018ms|0|10|
|100|1,019ms|1,018ms|1,017ms|0|100|
|300|3,039ms|1,017ms|1,017ms|0|300|

These are end-to-end harness observations with a **1second polling floor**, not precise API latency or a capacity SLA. Chunks bypassed extraction LLM work; observations were deliberately off. Single-claim writes did not re-ingest peers, counts stayed bounded, and identical retries preserved target raw IDs. This does not measure disk/trace growth, giant entity graphs, consolidation at300claims, extraction cost, or heavy concurrent load.

Replaying the old amber claim after the newer blue version **actually replaced blue with amber**. Native document identity/content deduplication is not an application revision precondition. No native CAS guarantee can be inferred from a successful retry.

The API also returned exactly one raw unit for `GET /memories/list?document_id=claim-0&type=world&limit=100` in the300claimbank. A per-document acknowledgement therefore need not scan the whole bank. Document detail alone provides original text/hash/count but not the required raw-unit-ID mapping. [Native list filters](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/api/http.py#L5213).

## Active consolidation, overlapping sources, correction and reprocess

A separate five-claim fixture enabled observations: bicycle ownership, two differently worded red-colour claims, espresso preference, pottery. Six captured states establish:

1. Initial red observation cited both colour sources.
2. Deleting one colour document rebuilt red from the remaining source; unrelated ownership/coffee/hobby survived.
3. Deleting the second removed red raw and derived memories; unrelated claims survived.
4. Updating coffee to decaf removed espresso and produced decaf; ownership/pottery raw IDs stayed unchanged.
5. Native coffee reprocess recreated its raw unit and derived observation without reviving red or espresso.
6. Adding a new blue claim produced blue; other useful claims remained.

Six native consolidation operations completed. Reported operation durations were1,791/1,633/40/908/914/1,048ms. Progress reported5initial sources and1source for each meaningful later consolidation; the no-work deletion operation had no progress. These small-fixture measurements demonstrate modest bounded work here, **not a guarantee that every dependent observation closure is small**. No token-cost claim is made. [Operation evidence](bounded-update-prototype/consolidation-work.json).

Native deletion explicitly sweeps dependent observations before/after source cascade and requeues surviving co-sources; that implementation explains the observed preservation. [Delete-document implementation](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11640). Chunks skip automatic extraction/entity discovery: explicit stable entity supply must come from P1. Literal entity linkage worked here; semantic entity-resolution quality and graph-recall breadth are not established by this fixture. [Chunks extraction](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/retain/fact_extraction.py#L3524).

## Consistency boundary we can design around

The finite app-owned layer is desired claim revisions, immutable per-revision document IDs, a durable mutation queue, acknowledged raw-unit payload hashes, a reset epoch, and one admission function shared by every retrieval/source/UI path. Hindsight still owns storage, retrieval, native consolidation and its dependency invalidation. This is more than an HTTP forwarding adapter, but does not require rebuilding a retrieval or consolidation engine.

- Before dispatching a mutation, transactionally revoke the affected acknowledged claim versions and persist the desired revision. Unrelated accepted claims remain available. Revoke every source version in the affected claim/dependency closure; removing only one repeated source would intentionally leave the other evidence alive.
- Serialize desired writes, and use immutable revision document IDs so a late worker cannot overwrite a newer document. Delete superseded documents through bounded native operations. Native fact PATCH, uncontrolled reprocess and direct control-plane mutations must not bypass this path.
- After operation completion, read back that document's units and verify the expected payload before publishing its acknowledgement, conditional on the desired revision and epoch still matching. Interrupted/failed/uncertain writes stay unacknowledged; repair retries the current desired revision. Recording an operation ID alone is insufficient.
- Admission binds raw IDs **and payload hashes**, not IDs alone. Production hashing must bind all semantic and scope fields (including dates, entity/scope metadata and any displayed source content), not just the two fields used by this probe.
- Admit an observation only when its full source-ID set resolves to acknowledged current raw payloads. Recreated observations are evaluated by their current support, not permanently trusted old observation IDs. Missing source text or incomplete support means withhold that observation; independently verified raw claims can remain available.
- Compare request revision/epoch before returning a read. Reset revokes the old mapping/epoch immediately. Late old-bank writes cannot be exposed through the new mapping. Garbage collection and physical erasure are separate operations.
- Do not forward unfiltered native chunks, entity payloads or source expansion. **Unrestricted native Reflect is outside this boundary:** it can consume native memories before AlfyAI filters the result. Use filtered Recall evidence in the existing chat answer path, or explicitly engineer an equivalent enforced boundary before offering Reflect.

Recall exposes each observation's full source-ID list even when the token-budgeted source-text map is incomplete. This permits a fail-closed support check, with a tradeoff of fewer derived memories under a tight evidence budget. [Source-fact contract](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/source_facts.py#L1).

An offline harness replayed the **actual native Recall payloads**:12/12checks passed for pending edits preserving unrelated facts, reset/revision mismatch, old response rejection after recovery, new colour visibility, unknown provenance, same-ID raw/source-text mutation, and truncated support maps. It emits sanitized facts rather than passing the native response through. This proves the tested admission rules, not a running distributed transaction or injected worker-crash recovery.

Important limitation: valid source IDs/hashes establish provenance freshness, **not the truth of observation text**. An observation-only text mutation retaining unchanged valid support would pass this source-only gate. Prohibit direct observation PATCH too. If exact acknowledged observation payloads are promised, track/validate observation payload hashes and rebuild those acknowledgements when native consolidation changes them, or use verified raw claims as the authoritative presentation. Neither choice makes model derivation semantically infallible; that remains P1 quality evidence. The12checks do not claim otherwise.

## Erase, partial failure and remaining acceptance

Per-document removal/correction is native and bounded in this fixture; it does not require deleting every memory. Logical reset is bounded through an epoch/mapping switch. Account erase/export must additionally enumerate app ledgers, original sources, obsolete revision documents/banks and the chosen trace/backup scopes. Native document deletion only removes LLM traces when the configured opt-in is enabled; the source explicitly warns a worker can write a late trace after the local recorder flush, requiring the retention sweep. Do not label immediate retrieval suppression as complete physical erasure. [Trace caveat in deletion source](https://github.com/vectorize-io/hindsight/blob/9fb28dbd724dc1ce4da7cb4c49008e601db76c5f/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L11670).

No shared evaluator was killed or restarted. The actual stale replay, idempotent native retry, recreated provenance, and deterministic stale-read/reset checks cover mechanisms; real interrupted multi-worker recovery, queue starvation, lease expiry and physical reset/erase remain integration acceptance. The ledger/read gate must be tested there with failures between each durable boundary. A failed affected claim can remain unavailable while unrelated claims continue serving; there is no evidence here requiring a whole-bank outage.

**P2 conclusion:** the bounded native primitives and finite consistency design are viable; no whole-history rebuild is needed for ordinary edits. Do not call the stricter readiness checklist fully passed from this small ladder: representative capacity, calibrated latency/cost expectations, storage/trace growth and actual distributed failure recovery remain unmeasured. Once P1 freezes its claim/entity representation, validate any representation differences against these fixtures, then move to the replacement design and implementation acceptance rather than another open-ended architecture sweep.
