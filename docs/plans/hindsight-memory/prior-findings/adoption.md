> Archived findings from /Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-adoption/report.md. Associated evidence files remain in that artifact directory. New decisions and status are in ../README.md.

# Hindsight adoption checks — 18 November 2026

**Recommendation: proceed to the integration and UI design, keeping local Flash Next as the target. Do not treat Hindsight as a drop-in replacement or the tests as a production acceptance certificate.**

The local model handled the attribution probes well in this follow-up. The more concrete remaining issue is preserving user corrections and forgetting across source reprocessing. A small persistent source-control layer worked in the isolated test; native fact edits and invalidation alone did not.

## Model identity correction

The owner identifies the self-hosted model as Flash Next (~120B), served under three aliases. Live `/models` returned `qwen3-6-27b`, `qwen3-8-flash-next`, and `flash-next`. Earlier “27B” descriptions were inferred from an alias and should not be read as verified weight metadata. Historical weights were not independently verified. The tests retain the configured alias for reproducibility.

No more external model calls were made after the local-only restriction. The already-completed Kimi diagnostic had 30 scored calls, 21,312 total reported tokens, plus separate small compatibility probes. No monetary cost is inferred from token counts.

## Attribution results

Scores below assess the central ownership/attribution decision, not every wording choice or full assistant quality. All answers were manually inspected, not blindly graded.

| Test | Result | What it establishes |
|---|---:|---|
| Kimi diagnostic answering local-Hindsight evidence | 30/30 | The existing evidence can support correct attribution with another answer model |
| Local Flash Next, six fresh cases, reasoning off | 6/6 | Correct handling of colleague allergy, friend treatment, temporary pet care, customer quotation, genuine condition and genuine device ownership |
| Local Flash Next, ten existing cases × two evidence formats, reasoning on | 20/20 | Correct decisions on this small adversarial set |
| Local paired repeats: two prior failures × two formats × two repetitions, reasoning off | 8/8 | Earlier failures did not reproduce in these current runs |
| Same paired repeats, reasoning on | 8/8 | Correct decisions, but no demonstrated causal advantage over reasoning off |

The formats were full recalled facts plus source objects, and source text alone. These are correlated probes, not 72 independent new scenarios. The paired runs used identical prompts and a 4,096 output-token ceiling for both settings; historical non-reasoning calls used 400. No call in these scored sets ended through token truncation. Reasoning tokens were actually returned when enabled.

Median paired-answer latency: reasoning off 563 ms; on 1,532 ms. These are small sequential samples amid other synthetic work, not production capacity benchmarks. Do not enable reasoning globally on this evidence alone. Some answers were unnecessarily verbose; one reasoning answer invited another personal disclosure. Perfect attribution scores do not imply perfect UX.

The earlier larger benchmark remains separate: grounded Hindsight 69/72 versus raw-history 64/72, with its documented synthetic-case and grading limitations. This follow-up does not erase its failures or establish why the earlier local answers differed.

## Correction and forgetting lifecycle

Each strategy was checked immediately, after an unrelated new message, after changed older-source replay, after an API/database restart, and after another replay in a new test process. Original facts: a red bicycle and decaf preference. New unrelated message: learning pottery. The correction was blue. The tests used a dedicated synthetic tenant and bank per strategy.

| Strategy | Observed outcome |
|---|---|
| PATCH the stored bicycle fact to blue | Initially answered blue; changed source replay restored red, which persisted after restart |
| Retain an explicit dated correction as a separate source | Answered blue throughout; replay nevertheless recreated an old red derived observation alongside the blue correction |
| Invalidate the bicycle fact | Fact disappeared from recall results, but the retained coffee source chunk still contained the red bicycle; the answer repeated it immediately. Replay restored the fact too |
| Delete the source document | Immediately removed bicycle and coffee; replay of the original document restored both |
| Persist a source replacement removing the bicycle sentence | Bicycle absent from listed facts and returned recall/source evidence after replay and restart; decaf and new pottery fact survived |
| Persist a source replacement correcting red to blue | Blue survived replay and restart; no red fact remained in the final listed facts; decaf and new pottery fact survived |

**The source text matters as much as the fact table.** Passing raw chunks to the answer model can undo fact-level hiding. A Memory screen that simply lists native observations can also show stale contradictory claims even when the final answer chooses correctly.

The source-level experiments used a small disk-persisted JSON ledger keyed by tenant, bank and source ID. On every replay, the test supplied the user's effective replacement text rather than the original source. The ledger was read again after restart. This is a throwaway experiment, not an AlfyAI implementation.

## What AlfyAI would still own

1. Stable per-message source identities and a durable record of user corrections/removals, consulted by every retry, import and reindex path.
2. A clear distinction between new life events and correcting an earlier mistake. A genuine change can remain a dated new source; a correction must not leave a misleading current item in the UI.
3. Source-aware forgetting that removes the relevant content from both facts and evidence chunks, without losing unrelated information.
4. A minimal current-memory presentation with evidence and correction history, instead of exposing Hindsight's raw fact/observation list as the user's profile.

Hindsight can still own extraction, consolidation and retrieval. These requirements do not justify rebuilding those engines ourselves.

## Limits and next decision

The source ledger tests covered one known affected source per operation. They did not prove discovery of every paraphrase across many messages, transactionality under concurrent ingestion, in-flight job cancellation, account-wide erasure, or erasure from logs/backups. These are integration requirements, not features proven by this bench.

The replacement applies to a whole source body. The changed-source replay added a morning-coffee clause; the replacement intentionally retained the approved decaf text and did not merge that new clause. A real design must preserve distinct new messages and specify how an edited original message is reconciled with an existing correction/removal. Do not present this prototype as a general semantic merge algorithm.

Next: produce the small integration contract and redesigned Memory UX around these observed behaviors. Keep implementation and migration separate until that design makes corrections, forgetting, tenant isolation and source visibility concrete. Existing multi-user tests were not rerun here; see the earlier benchmark for those results.

## Reproduction and scope

Hindsight 1.2.1, source commit `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`; local multilingual embeddings and local reranker; native static-key tenant extension with isolated evaluation schemas. Intake and consolidation used local Flash Next without reasoning; the reasoning experiment changed only answering.

All data was synthetic. No AlfyAI product code, production memory data or production service configuration was changed. Only isolated test services/database were restarted. No claim is made about production deployment readiness.

Raw answers, API/model transcripts, the original attribution freeze manifest, runner versions and SHA-256 evidence hashes accompany this report. `lifecycle-results.jsonl` contains all 36 lifecycle snapshots. The final packaging hashes are integrity records, not a claim that exploratory follow-up scripts were preregistered.
