# Bounded-update throwaway evidence

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

Captured 2026-11-18. Synthetic tenant `synthetic-v2-p06`; banks `ready-p2-*` only. Native evaluator source pin `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f` (1.2.1), loopback port18890. No app implementation or production data. Model work uses the parent-owned local evaluator; helper/common files are copied test scaffolding, not production clients.

`size.cjs` populates 10/100/300 claims with chunks extraction and observations disabled, changes one document, retries it, compares peer identities, and replays an old version in the10-bank. `overlap.cjs` exercises native consolidation with5initialclaims, deletes overlapping sources, changes/reprocesses coffee and adds new colour. Both mutate synthetic banks: rerun only against an isolated evaluator with fresh banks, never against production or these retained evidence banks.

`node read-gate.cjs` is fully offline and replays the captured overlap responses. It writes `read-gate-results.json`;12assertions must all pass. This is an admission-model probe, not a distributed crash test. Hashes cover document ID and text only. See the report for production requirements and observation-text limitations.

`api.jsonl.gz` contains all requests/results (including poll operations), no real credential: the bearer token is a synthetic tenant selector. `consolidation-work.json` deduplicates completed consolidation operation timestamps/progress. Timings include shared-machine interference; the size harness polls at1second intervals. Results are feasibility evidence, not an SLA or measured token cost.
