# Upstream curation status: research check

Checked 2026-11-18 against live GitHub API, official repository discussions and published docs. This is an upstream-status review, not a fresh end-to-end evaluation. No upstream message or issue was sent.

## Finding

**No committed upstream solution for durable selective correction/removal across source replacement was found in this bounded search.** Existing reversible curation is real and merged; related requests often end with advice to use those primitives or implement policy in the client. That does not establish that upstream will reject a precise source-replay bug report, but it is not a roadmap promise to fill our gap.

The public repository was accessible. The live `main` SHA was [`f6038a742743243c2df4a90b5b0542715f320359`](https://github.com/vectorize-io/hindsight/commit/f6038a742743243c2df4a90b5b0542715f320359). GitHub's latest published release was [v1.2.1](https://github.com/vectorize-io/hindsight/releases/tag/v1.2.1), published November 10, 2026. The earlier evaluator pin is `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`; current-main verification is separate from the earlier benchmark.

## Available versus proposed

| Upstream item | Verified status | What it does—and does not establish |
|---|---|---|
| [RFC #1951](https://github.com/vectorize-io/hindsight/issues/1951), [PR #1976](https://github.com/vectorize-io/hindsight/pull/1976) | PR merged June 10, 2026 | Native edit/invalidate/restore with dependent-observation handling. This is the mechanism already exercised in our native tests, not a newly discovered durable replay layer. The RFC assigns changed-world facts primarily to consolidation. |
| [Correct & Forget #2696](https://github.com/vectorize-io/hindsight/issues/2696) | Closed, not planned | A collaborator directed the requester to existing reversible curation. A community contributor explicitly identified reprocessing behavior and atomic correction as remaining gaps; that comment is **not a maintainer commitment**. Original claims that Hindsight lacked any per-fact invalidation were corrected in discussion. |
| [Per-fact delete/correction-expiry #3509](https://github.com/vectorize-io/hindsight/issues/3509) | Closed, not planned | The author acknowledged native invalidation and reported successful batch use. The maintainer objected to age-driven correctness/TTL and losing historical facts; the final closure assigned the discussed timestamp-based handling to clients. This does not demonstrate a delivered source-replay guarantee or justify quoting the original “no invalidation” claim as current fact. |
| [Bulk invalidate/edit #6177](https://github.com/vectorize-io/hindsight/issues/6177), [async/bulk curation #6418](https://github.com/vectorize-io/hindsight/issues/6418) | Open requests | These concern batching, contention and operation scheduling. Neither inspected proposal supplies semantic source reconciliation. No merged implementation or release commitment was established. |
| [Hermes invalidation tool #5373](https://github.com/vectorize-io/hindsight/issues/5373) | Open request | Exposes existing invalidation/discovery through the Hermes integration. It does not redefine reprocessing or prevent recreated facts. |
| [Recording-time curation #5563](https://github.com/vectorize-io/hindsight/issues/5563) | Closed as completed; maintainer identifies #5750, shipped in 1.1.0 | A useful native `mentioned_at` correction path preserving source identity. The issue explicitly limits its endpoint check: no concurrency/audit guarantee or production-history recovery claim. It is not persistent semantic correction through re-extraction. |
| [Source qualification #5705](https://github.com/vectorize-io/hindsight/issues/5705) | Closed, not planned | Maintainer recommends separate tagged quoted items, propagated tags, read filters, curation and source IDs. Requests a concrete case where that approach fails. Splitting mixed user messages into correctly attributed pieces would still require application judgment; this is no supplied semantic splitter. |
| [Rebuild observations after upgrade #6639](https://github.com/vectorize-io/hindsight/issues/6639) | Open request | Addresses old derived observations surviving a consolidation-prompt upgrade. Proposed rebuild preserves raw facts; it is not a persistent correction/removal mechanism. The deployment incident is the reporter's account, not reproduced here. |

## Memory Defense is not the missing personal-redaction facility

The official [0.8.2 announcement](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/blog/2026-06-12-version-0-8-2.md) describes redacting recognized sensitive-data patterns before both facts and original document text are stored. It applies to future retains, not retroactive cleanup. That makes its placement relevant to the source-expansion leak.

However, [custom per-bank regex request #4017](https://github.com/vectorize-io/hindsight/issues/4017) is closed as not planned. The request describes a custom process-wide extension as the alternative; no maintainer reply or supplied arbitrary personal-claim matcher was found there. Native pattern redaction should not be presented as selective semantic forgetting across paraphrases. The root agent's direct detector probe is recorded separately under `upstream-check/` and is stronger evidence of the tested detector's actual limits than this feature request.

## Search boundaries and interpretation

Live GitHub issue/PR searches included `reprocess curation` (14 results), `invalidated source text` (28), `correction replay` (19), `tombstone` (17), `"memory defense" "custom"` (6), and open curation/reprocess/supersession/redaction (14). Relevant returned issues and their comments were read. Public releases and curation merge metadata were checked directly through the API; search-engine snippets alone were not used to assign current status.

This was not an exhaustive inspection of every issue, branch, private roadmap or future work item. No promised delivery date was found. The safe conclusion is **no verified upstream commitment or available alternative identified**, rather than “upstream will never support it.” Existing memory primitives are already useful; building a policy on them may nevertheless recreate the part of AlfyAI's memory system the owner wants to stop maintaining.

## Local source verification and additional probe

Current main is two commits beyond the evaluated pin. The source diff adds knowledge-search reranking and a retry for retain completion-outbox writes; it does not change curation or reprocessing semantics. The [current pinned memory documentation](https://github.com/vectorize-io/hindsight/blob/f6038a742743243c2df4a90b5b0542715f320359/hindsight-docs/docs/developer/api/memories.mdx) explicitly documents that document reprocessing resets fact curation. The [revision evidence](upstream-check/revision-check.json) and engine diff are saved locally.

Six direct native Memory Defense component probes completed: bicycle colour, a paraphrase, a Hungarian shared condition and UK phone numbers all passed through unchanged; a synthetic GitHub-shaped token was redacted with the unrelated coffee preference preserved; an unsupported semantic detector name was silently allowed. See [probe results](upstream-check/defense-results.json). This was a component-level scope check, not a new retain/recall lifecycle test. No API/PostgreSQL service or model inference was started. No product implementation changed.

**Recommendation:** do not proceed on the assumption that upstream already owns the required durable curation semantics. A precise maintainer response to the source-replay/source-expansion reproducer would be useful evidence before betting on an upstream fix; no such response has been obtained or requested. Implementing a semantic extension or reconciliation ledger ourselves remains a substantive maintenance decision, not a thin integration detail. This investigation proposes no replacement contract and does not weaken selective removal or synchronized-source requirements.
