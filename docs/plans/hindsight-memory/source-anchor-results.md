# Structured source-anchor experiment

2026-11-18. Isolated follow-up to the authorized curation prototype. No product code, upstream work, deployment or revised product contract.

## Result

**Separating edit intent from source matching improved the specific conflict decision, but did not make selective removal dependable.** The matching call does not see the user's replacement value. Code then applies the recorded correction for the old claim, withholds an unexplained changed value, or accepts an explicit new event.

All three deliberate changed-value conflict examples were flagged in fast mode; the paired reasoning run also flagged them. That fixes the specific silent “new green becomes old blue” branch from the previous prototype. However, the text retained around the conflict was often incomplete, and unrelated ownership could disappear from Hindsight's facts. Ordinary removals also still leaked targeted information or removed another person's information.

Do not equate a correct conflict decision with a correct source projection. This experiment is not a full replacement acceptance pass.

## What was built

A throwaway two-call projector:

1. From the original source and user action, create an anchor: subject, attribute, old value, replacement value, exact original passage and correction/removal mode.
2. Give a separate call only the subject/attribute/old passage/value plus latest source. **Do not give it the user action, removal mode or replacement value.** It proposes exact source matches, current values, templates, an attribute-free remainder and quoted evidence for a new event.
3. Deterministic code checks span presence/uniqueness/non-overlap and template shape. It compares canonical values, applies the saved correction or emits a conflict. Untouched text remains unchanged.

The prototype records real model-generated anchors; they were not hand-supplied gold mappings. The model still decides subject identity, the value and scope of a claim, which wording is a genuine event, and which information is unrelated. Those semantic responsibilities are not made deterministic by storing the result as JSON.

Existing revision/publication gating was not reimplemented or broadly rerun. Native roundtrips use new isolated banks on the same pinned Hindsight evaluator (`9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, 1.2.1).

## Runs and grading

- Fast mode: 16 reused cases plus eight fresh cases frozen before their run. Same local Flash Next alias `qwen3-6-27b`; no external model.
- Reasoning comparison: 16 selected paired cases from those sets, unchanged prompts, `enable_thinking:true`, output budget increased from 1,800 to 6,000. **Both reasoning and token budget changed**, so do not attribute every difference to reasoning alone. These are repeats, not an independent held-out score.
- Manual grading distinguishes a complete fixture result, a qualified partial result, a failure, and an unusable-output block. Qualified results do not count as acceptance. All raw outputs and reasons are retained.

| Set | Met scoped expectation | Qualified/partial | Failed | Blocked |
|---|---:|---:|---:|---:|
| Fast, 16 reused | 8 | 3 | 5 | 0 |
| Fast, 8 fresh | 6 | 1 | 1 | 0 |
| Reasoning, 16 selected repeats | 9 | 4 | 2 | 1 |

Do not read these as production accuracy or compare them as identical populations. Source-fragment quality and ownership preservation matter here; a conflict can be correctly identified while its full projection remains only a partial success.

### Concrete successes

- Ordinary corrections preserved new unrelated preferences/hobbies.
- A bicycle paraphrase with ownership and location corrected successfully.
- A changed source referring to a brother's bicycle was left about the brother; no new personal ownership was invented by the projector.
- Sale/negation, price/use details and a hypothetical future repaint survived the fresh probes.
- A single saved/reloaded red→blue anchor was reused for an ordinary edit, unexplained green edit, an unrelated added sentence and a later explicit repaint. Stale exact spans were rejected. The new repaint remained green instead of being forced back to blue. See `reuse-results.json`; some alignment outputs were reused from the frozen cases, with one new event-matching call.

### Remaining failures

- **Fast removal leak:** the matcher supplied the original red statement as the supposedly attribute-free remainder. Code accepted it; native Hindsight stored and answered red.
- **Reasoning removal collateral loss:** reasoning omitted the bicycle statement entirely. Colour became unknown, but ownership also disappeared. Native storage and answer both confirmed that loss.
- **Shared Hungarian information:** fast mode left a literal placeholder in one health example. Reasoning preserved the partner's condition, location and hobby, but retained “also”; native Reflect correctly answered the user's sensitivity was unknown while speculating that the user might share it. This is improvement, not clean removal of every implication. Both modes removed the sister's location when only the user's location should disappear in another fresh case.
- **Historical personal attribution:** fast mode preserved the forgotten old personal number's personal-history attribution after reassignment. Reasoning returned unusable matching output on that case; the runner recorded a blocked error rather than publishing it.
- **False conflict:** phone-number formatting (`+44` versus local `0`) yielded different canonical strings and a false conflict. A value string is not a reliable semantic identity.
- **Incomplete/duplicated text:** examples included `My bicycle is .`, duplicated unrelated project/preferences, and bare possessive fragments. Native extraction discarded ownership from the incomplete English conflict remainder. Exact-span validation does not prove the remainder is meaningful.
- **Unused latent defect:** the repaint match's template put the value slot on the *previous* colour, although its current value was green. The successful new-event branch kept the source unchanged and did not use that template. It is not proof that every proposed template was correct.

## Five native Hindsight roundtrips

Fast-mode ordinary correction answered blue/espresso/pottery, but unnecessarily treated ownership as unknown despite “my bicycle.” The fast conflict did not answer a colour; its derived facts retained espresso but lost ownership. The fast removal repeated red. Reasoning-mode shared health information kept the partner's condition and relevant unrelated facts, with the inference caveat above. Reasoning-mode colour removal lost ownership as well as colour.

These tests isolate responsibility: Hindsight cannot restore unrelated information our projection discarded, and it will retain a supposedly removed fact if our projector still supplies it. Native extraction/answer quality can add further losses even to a plausible projection.

## Cost and maintenance implications

Fast anchor creation plus matching had median model time about **0.87 seconds**. Reasoning's 15 rows with returned anchor metadata had median **7.45 seconds**, maximum **46.95 seconds**; the unusable-output case is not included in those timings. These exclude Hindsight retention/consolidation and are small-bank synthetic measurements. The prior publication guard withholds memory while current work is pending, so this difference affects availability as well as compute.

The useful boundaries remain: versioned edit intent; source revisions; no exposure of unedited originals through Hindsight; stale-worker rejection; and a matching call isolated from the desired replacement. No new prompt/regex patches were added to rescue individual fixture failures.

The unresolved component is **claim-level attribution and preservation**. Explicit IDs/offsets help detect stale spans, but cannot determine by themselves whether “both of us,” “also,” a changed owner or a later event preserves/contradicts an edit. Rebuilding that semantic interpretation on every edit remains substantial memory logic, even with Hindsight handling storage/search/consolidation.

## Recommendation

Keep the conflict-decision separation as a design finding. Do not adopt this projector or assume reasoning mode supplies a reliability guarantee. Further work should target structured claim-to-source provenance and preservation of independent claims, rather than another whole-message rewrite or model-review loop. It must also prove initial attribution, because a stable anchor to the wrong person's fact merely preserves the mistake.

This is a remaining engineering requirement, not a promise that adding more metadata solves it. The owner permits maintaining an AlfyAI component; that does not make collateral loss, source freezes, constant confirmation prompts or unsafe automatic publication acceptable. No weaker contract is proposed.

## Evidence

[Recorded-results walkthrough](source-anchor-prototype/walkthrough.html) embeds the actual fast-mode compiler and outputs. Change a source, append unrelated text or invalidate a saved span; it runs locally with no model calls. JavaScript syntax was checked; no visual browser acceptance is claimed.

[Artifacts](source-anchor-prototype/): frozen prompts/cases, fast and reasoning outputs, manual grading, five native roundtrips, saved-anchor reuse, scripts and compressed API/model traces. `accepted:true` means the prototype's structural checks passed, **not** that the result met semantic requirements. `manual-grading.json` is the human assessment. SHA-256 manifest covers saved files. This is scratch evaluation code; do not import it into product code.

The scratch services were stopped after the run. App gates were not run: only authorized throwaway evaluation and documentation changed, with tracked product code untouched.
