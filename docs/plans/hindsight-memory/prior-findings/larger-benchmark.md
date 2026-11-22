> Archived findings from /Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/hindsight-bench-v2/report.md. Associated evidence files remain in that artifact directory. New decisions and status are in ../README.md.

# Hindsight larger decision bench — 18 November 2026

**Decision: promising replacement foundation; not an unconditional adoption pass.** The larger run supports designing around Hindsight, but does not establish that a small integration can eliminate the remaining attribution errors. Do not implement a new UI/API on the assumption that this is already solved. Stop broad prompt-tuning on these examples; resolve the specific adoption conditions below.

## Results

| Path | Fully grounded answers on 72 questions | Separate 10 boundary probes |
|---|---:|---:|
| Hindsight facts + original evidence, source-aware chat answer | 69/72 | 9/10 |
| Same model with all prior raw user messages | 64/72 | Not run |
| Hindsight original passages only, exploratory follow-up | 64/72 | 9/10 |

There were 102 synthetic sessions across six isolated users, three English and three Hungarian. Each user's bank mixed topics and projects. The 72 questions cover twelve scenario families with different entities/languages, **not 72 independent kinds of difficulty**. Twelve repeated ownership/profession checks retained the same core ownership/unknown outcomes; 11/12 repeat answers were fully grounded (one repeated an earlier unsupported explanation). No production data was used.

Scores use manual, non-blind grading against frozen expected/forbidden content, with additional false facts counted as grounding failures. For example, correctly naming a replacement device but inventing the sale date fails. Minor voice/grammar/style problems are separately recorded. Cooking time and allergy handling are memory constraints here, not medically validated recipe safety. The earlier 18-question results are from another dataset and are not directly comparable percentages.

### What worked

* Future, current and past itineraries, including relative dates.
* Replacement devices versus a relative's device.
* Conditional relocation and changed response preferences.
* Project-specific writing rules and user-stated project progress.
* General personal information mentioned inside a project.
* User isolation with identical bank/document names across users.

### Remaining mistakes

In the main Hindsight run:

1. A replacement device inherited an **everyday-use habit** stated only about the old device. The derived observation and answer both overgeneralised.
2. An answer correctly left profession/ownership unknown, but invented that an employer was considering an approval and confused the origins of quoted fictional details.
3. One answer correctly recited food restrictions but offered neither of the two requested lunches.

The separate, subtler boundary probes were important. **“My client is gluten-sensitive” became “you are gluten-sensitive.”** Hindsight had stored the client attribution correctly, and the original source was available. The answering model misused it. The probe also covered product questions without explicit ownership disclaimers, shopping, translation, an applicant's profession, genuine self-statements inside questions, and a contemplated sale.

The exploratory source-only format fixed the client-attribution answer, but then said **“you do not own a laptop”** when only a neighbour's laptop was mentioned. Unknown is not a negative fact. It also lost some date accuracy. Neither representation cleared the personal-attribution requirement across the extended suite.

## What was actually tested

Pinned Hindsight 1.2.1 source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`; self-hosted Qwen `qwen3-6-27b`; local multilingual-e5-small embeddings and MultiBERT FlashRank reranker; PostgreSQL scratch database; native StaticKeysTenantExtension.

The candidate used only **user messages** for personal-memory intake, original dates, generic personal-memory missions, and the same source-aware answer prompt as the raw-history comparator. No custom extractor, verifier, ownership regex or per-case repair was added. Recall searched the authenticated user's bank across projects, with source/project labels available so a general personal fact stated inside a project remained accessible. This tests semantic applicability, not project-level access authorization.

Retain and consolidation ran before each checkpoint. Chronological replay prevented future-message leakage. The main cases, runner and plan were frozen before inference. The ten boundary probes were separately frozen after the main run was underway; they are an additional diagnostic suite. The source-only representation was explicitly exploratory and run after observing failures; it reused the same retrieved passages and answer prompt without re-extraction or retrieval tuning.

The comparator sees all previous raw messages from that user. With only 17 sessions per user, this is an evidence ceiling for short histories, not a scalable production retrieval design. Hindsight's default extraction/consolidation temperatures were retained; answer generation used temperature zero. This is not a model-independent architecture score. The prior AlfyAI implementation was not rerun on these 72 questions.

## Stored-memory review

The internal store was inspected as well as the answers. It retained the original and updated ownership/preferences as dated evidence, with derived observations describing the update. This is useful history but unsuitable for a flat list presented as “current facts about you.”

Some observations still changed meaning: everyday usage carried across to a replacement device; Hungarian paraphrases sometimes described how the user likes to answer rather than how they want the assistant to answer; a project instruction became a description of the user's writing elsewhere. Low-value episodes, such as preparing a quiz, were also retained. The UI cannot simply display every internal row as a verified personal fact.

## Multi-user and operational checks

All six users' codename/hobby answers matched their own sources. Foreign-codename recall probes returned no foreign-user codename. Missing/invalid credentials were rejected, cross-user fact reads and edits returned 404, and cross-user operation access returned `not_found` without payload. Original documents with the same ID resolved within the caller's tenant.

An unchanged-source retry preserved the exact memory IDs and used zero additional extraction tokens. After restarting the API/worker process, all six users' saved memory IDs, texts and types were identical. These checks do not establish crash consistency, sustained-load capacity, full endpoint security, backup isolation or account-deletion correctness.

## Integration cost matters

The first representation passed full recall objects to the chat model. **Average answer input was 12,442 tokens**, compared with **928** for raw history in these short cases. Hindsight's fact-token budget counts text, not the accompanying identifiers, metadata and source-fact objects. Duplicated representations amplified the cost. This is an integration mistake to avoid, not evidence that Hindsight inherently needs that many answer tokens.

Median retain was 1.61 seconds; median additional wait for background completion was 3.02 seconds; recall was 395 ms. The answer step's median was 1.40 seconds for the verbose Hindsight representation versus 693 ms for raw history. These are small-bank observations with concurrent synthetic users and a shared model, not production latency guarantees. The source-only follow-up's measured input size is in `metrics.json`; it reduced overhead but did not solve attribution reliably. A compact format retaining useful normalized dates remains untested.

## Adoption conditions and design implications

1. **Personal attribution:** establish an answer/evidence contract that keeps another person's condition or a product question from becoming the user's biography. The current Qwen-based paths did not fully pass. Since the client fact was stored correctly, this also requires evaluating the answering layer; changing the memory backend alone cannot settle it.
2. **Authoritative manual changes:** the previous live probe demonstrated that reprocessing an updated source chat can undo a manual fact correction. This remains unresolved. The replacement design must preserve user corrections and forgetting across re-ingestion, rather than wire an Edit button directly to a transient fact ID.
3. **A bounded, efficient integration:** compact context, server-owned tenant identity, privacy/read-write gates, and explicit job states. Avoid creating a second bespoke memory engine around Hindsight. If reliability requires that, the expected maintenance savings have not been demonstrated.

A new Memory experience should be built around source-linked understanding, scoped preferences and durable user corrections—not around Hindsight's raw database rows or the old AlfyAI screens. Assistant-executed actions, long task continuity, document/artifact search, full persona-summary refresh, large histories, migration and production failure recovery were not validated by this bench. User-only personal intake must not silently drop legitimate assistant work outcomes; that is a separate integration contract.

Upstream maintenance is a reason to prefer an established dependency, not a guarantee of future quality. Pin the chosen release and keep a reproducible acceptance suite for upgrades. **The evidence justifies Hindsight as the leading candidate; the attribution and correction gates prevent calling the replacement decision settled today.**

All work remained in disposable evaluation files. No AlfyAI production code, UI, API, schema or deployment changed.
