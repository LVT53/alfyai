# Independent review: accepted-edit replay ledger

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](research-source/README.md)

Reviewed 2026-11-18, read-only against `replay-ledger-prototype/run.cjs`, `frozen.json`, and `results.json`. No new model calls or product changes. This is manual, non-blind review of recorded outputs.

**Historical first-version result (superseded by the v3 review below): all 11 projected text outcomes satisfy the supplied edit intent and preserve the useful remainder in these examples.** This is a promising bounded replay component, not proof of automatic first-edit correctness or end-to-end forgetting. Its trusted original/accepted/safe-remainder ledger is explicitly supplied synthetic input. Native extraction is reused unchanged.

| Case | Text outcome | What survives / changes |
| --- | --- | --- |
| forget_keep_new_details | Pass | Bicycle ownership remains without colour; new espresso preference and pottery remain. |
| shared_subject_hu | Pass | Partner's sensitivity survives without attributing it to user; shared city and pottery remain. |
| new_explicit_life_event | Pass | Prague move and office work remain; accepted historical Berlin correction survives. |
| conflicting_target_edit | Pass, conditional on stated conflict policy | Neither blue nor green is served; bicycle ownership and espresso remain, conflict ID recorded. Accepted blue is retained in ledger, not active projected text. |
| compound_price | Pass | Colour removed; ownership, €250 price and daily riding retained. |
| different_projects | Pass | Atlas becomes TypeScript; Beacon Rust and new mobile app remain. |
| two_bikes | Pass | Road bicycle becomes yellow; mountain bicycle stays blue and Sunday riding remains. |
| sibling_hu | Pass | Sister's city remains without user-city attribution; tennis/running remain. |
| phone_reassignment | Pass | Company reception number and new personal number remain; former personal attribution removed. |
| fresh_shared_tea | Pass | Sister's tea preference remains without user's; both cities and phone details remain. |
| fresh_camera | Pass | Ownership omitted; partner's landscape interest and lens-shopping context remain. |

The 28 candidates produced three local rewrites and one conflict. Classification itself is not entirely faithful to the declared categories: the already-compatible Berlin fact is labelled replay instead of keep; the shared-tea fact is labelled merge although the trusted accepted text already preserves its entire safe remainder. Both yield correct text here. Thus the run supports narrower output quality, not perfect classification or guaranteed minimum model work.

## What the separation improves

The model no longer has to invent an accepted correction while deciding replay semantics. Ordinary unrelated candidates pass through; accepted replacement/remainder text is reused verbatim; the two genuinely mixed examples retain new information through a local rewrite. This directly addresses a source of complexity in the previous curator design without introducing a replacement extractor, ranker, or consolidation engine.

## Guarantees still missing

- **Accepted input is an important prerequisite.** This does not establish how an ordinary automatic workflow produces the first accepted text and safe remainder, nor how much confirmation that requires. Hand-supplied safe remainder must not be presented as solved automatic decomposition.
- **This runner is a text projector.** It neither mutates a native bank nor reads it back. It does not test source chunks, provenance expansion, observations, entities, dates, embeddings, causal links, caches, exports, or restart/replay behavior. Correct projected text alone cannot establish that forgotten information stops being served elsewhere.
- **The ledger retains the forgotten claim.** `original`, `previous`, and `latest` contain sensitive attribution, including the former personal phone number. Retaining an internal suppression record differs from erasing the information. Its storage/access/logging and whether raw original text is necessary need an explicit product boundary. These test fixtures are synthetic; this is not a detected real-user leak.
- **Rewritten text loses structured provenance in this prototype.** Kept strings carry `When/Where/Involving` annotations; replacement and merged strings do not. A production adapter must preserve valid provenance/time and remove invalid associations without leaving the old user-sensitive relationship in native metadata. The prior source review's causal-edge limitation remains relevant.
- **Same-source identity is assumed.** Cases supply one trusted ledger and the intended changed source. There is no owner/bank/project/document/revision enforcement, multi-edit composition, stale job rejection, reset epoch, or atomic publication here. These are bounded integration responsibilities, but are necessary before calling replay durable.
- **Conflict handling can still discard unrelated new detail.** A compound candidate such as “the bicycle is green and now has a basket” could be classified conflict, where code substitutes only the old safe remainder and loses the basket. None of the 11 cases combines a conflicting value with newly added independent information. This deserves a focused test before freezing the contract.
- **Failures and ambiguity remain model-dependent.** ID coverage is checked, but merge content has no semantic validator or fail-closed publication path. Exact unchanged fact hashes are not used here: all supplied candidates are classified again. Prompt-in-source interference, repeated paraphrases, ambiguous new events, several successive edits, and conflicting ledgers are untested.

The conflict example's policy is coherent but should be described precisely: the accepted correction is retained privately while its active value is withheld pending resolution. “Preserve my correction” alone does not necessarily imply permission to hide it whenever source text changes.

## Assessment

Reasonable to continue with this bounded component. The evidence supports **11/11 correct replay projections given trusted accepted edits**, including useful-remainder preservation. It does not support “correction and forgetting solved,” “11 independent unseen tests,” or “no custom semantic reconciliation needed.” Nine cases reuse known failure scenarios, and two add fresh edit actions over recorded native facts; there is no repeated-run stability estimate. The next decisive checks are compound conflict-plus-new-detail and a native write/readback cycle covering provenance and derived-memory leak paths, rather than another full custom memory engine.

## V3 independent follow-up: 12/14, with a prior-case regression

Reviewed complete `v3-results.json` (14 entries), `v3.cjs`, and the three explicitly constructed `regression-inputs.json` cases. **12/14 projected text outcomes pass; 13/14 would overlook the phone-attribution regression.** This remains an exploratory, repeatedly inspected prompt-development suite, not independent accuracy or stability measurement.

| Case | V3 outcome | Independent finding |
| --- | --- | --- |
| forget_keep_new_details | Pass | Removes bicycle colour; ownership, espresso and pottery retained. |
| shared_subject_hu | Pass | Removes user sensitivity; partner sensitivity, shared city and pottery retained. |
| new_explicit_life_event | Pass | Prague move and office work retained alongside corrected historical Berlin. |
| conflicting_target_edit | Pass under conflict policy | Disputed colour withheld, bicycle ownership and espresso retained, conflict recorded. |
| compound_price | Pass | Colour removed; €250 price and daily riding retained. |
| different_projects | Pass | Atlas correction preserved; Beacon language and app retained. |
| two_bikes | Pass | Road colour corrected; mountain colour and Sunday riding retained. |
| sibling_hu | Pass | User city removed; sister city and both activities retained. |
| phone_reassignment | **Fail — disclosure** | Classifier now chooses keep for the compound fact, retaining “user's old personal number 07700 901111” verbatim. Company ownership and new personal number survive, but requested former-personal attribution remains. V1 passed this case. |
| fresh_shared_tea | Pass | Only user's tea preference removed; sister preference and other details retained. |
| fresh_camera | Pass | Ownership removed; partner interest and lens-shopping context retained. |
| conflict_new_basket | Pass | Disputed green/blue colour omitted; ownership and new front basket retained. |
| conflict_shared_city_hu | Pass | Disputed user city omitted; new cycling and sister's Győr residence retained. |
| conflict_two_bikes | **Fail — collateral loss** | Output contains only the green mountain bicycle. Road bicycle ownership and Tuesday riding are lost, although neither is disputed. |

V3 introduces a separate conflict-remainder deletion prompt, fed original and neutral safe remainder rather than the accepted disputed value. That fixes two constructed conflict cases. It does not establish reliable relationship-level deletion: in the third, a compound clause is removed too broadly. The new-event exception also competes with forgetting: retaining a legitimate company reassignment must not retain the forgotten historical personal relationship. This is a classifier failure before the local rewrite even runs.

These two failures belong to the **custom replay/neutralization component**, not native extraction: in each input, the native/constructed fact already contains the useful information and the local projection either leaves prohibited attribution intact or discards unrelated information. The three regressions are constructed compound facts, not newly measured native extractions. The original 11 use previously recorded native facts.

The trusted approved ledger remains explicit input; automatic first-edit correctness remains outside this test. No native write/readback, observation regeneration, source-chunk suppression, graph repair, privacy erasure or durable concurrency guarantee is exercised. Earlier metadata and ledger-retention limitations still apply.

**Recommendation:** retain this as evidence that accepted-edit replay is a useful bounded direction, but stop short of parity or dependable automatic compound-edit claims. More prompt iterations on these same 14 cases cannot establish general reliability. The specific unresolved boundary is preserving all independent relationships while suppressing only the edited one, including historical attribution embedded in a genuine new event.
