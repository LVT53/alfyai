# Memory part 2: acceptance

Plan: [Task 7 of the part 2 plan](../../superpowers/plans/2026-11-23-memory-labels-part-2.md). Branch `claude/memory-part-2-d9c9bf`. Counts only in this file; the runner's raw outputs (synthetic text) are under [part-2-acceptance/results/](part-2-acceptance/results/). Every chat, fact and person in these runs is invented.

## Method

- **Engine:** Hindsight at the pin `9fb28dbd`, installed on this Mac from its source with the embedded Postgres, ONNX embeddings and FlashRank (production's `compose.yaml` choices), listening on `127.0.0.1:18990`. Not production, and no production data.
- **Model:** Flash-Next (`qwen3-6-27b`) through `inference.alfycomms.com`, with production's retain settings (`enable_thinking: true`, `max_tokens: 8192`). At most three model calls were in flight: Hindsight's own semaphore was three and the runner kept three requests open at most.
- **Banks:** `p2a-config-1` holds the previous release's config byte for byte; `p2a-config-2-personal` and `p2a-config-2-project` hold config 2 for each bank kind (`nativeBankConfig`), configured through the same PATCH the app sends.
- **Fixtures:** [part-2-acceptance/fixtures.json](part-2-acceptance/fixtures.json), 20 chats per category, 10 English and 10 Hungarian in each, written for this run.
- **Extraction** goes through `POST /memories/dry-run-extract`, which persists nothing, with production's context shape (the previous assistant reply as context). **Consolidation** retains and consolidates on one scratch bank per scenario: the first statement dated 10 March 2026, the second 20 September 2026.
- **Runner:** [part-2-acceptance/run.ts](part-2-acceptance/run.ts), phases `setup`, `extraction`, `consolidation [v1|v2]`, `classifier`, `recall-build [v1|v2]`, `recall-measure`, `report`. The engine: [part-2-acceptance/start.py](part-2-acceptance/start.py).

```sh
# The engine, once (Python 3.12; downloads the pinned source, its wheels, Postgres and two small models)
export PART2_HS_ROOT=/tmp/alfyai-hindsight-part2
git init -q "$PART2_HS_ROOT/source" && git -C "$PART2_HS_ROOT/source" fetch -q --depth 1 https://github.com/vectorize-io/hindsight.git 9fb28dbd724dc1ce4da7cb4c49008e601db76c5f && git -C "$PART2_HS_ROOT/source" checkout -q --detach FETCH_HEAD
/opt/homebrew/bin/python3.12 -m venv "$PART2_HS_ROOT/venv" && "$PART2_HS_ROOT/venv/bin/pip" install "$PART2_HS_ROOT/source/hindsight-api-slim[local-onnx,embedded-db]" flashrank
"$PART2_HS_ROOT/venv/bin/python" docs/plans/hindsight-memory/part-2-acceptance/start.py &
# The runs
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts setup
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts extraction
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts consolidation v2
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts consolidation v1
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts classifier
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts recall-build v1
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts recall-build v2
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts recall-measure
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/run.ts report
```

## Summary

| Target (spec, "Testing and acceptance") | Config 1 (today) | Config 2 | Target | Result |
| --- | --- | --- | --- | --- |
| Question-only chats leave no new entry | 20/20 | 20/20 | at least 18/20 | **pass** |
| A settled brainstorm leaves at most its outcome (read by hand) | 1/20 (automatic, see below) | 10/20 (EN 4/10, HU 6/10) | at least 16/20 | **miss** |
| Plainly stated lasting facts are kept | 20/20 | 20/20 | at least config 1 | **pass** |
| Kind right | | 81/84, 96% (EN 42/44, HU 39/40) | at least 85% | **pass** |
| Subject right | | 70/84, 83% (EN 35/44, HU 35/40) | at least 80% | **pass** |
| Lasting facts labelled temporary or ongoing | | 1/34, 3% (EN 1/17, HU 0/17) | at most 1 in 20 | **pass** |
| A real-world change: the new state current, the old one kept as earlier | 5/20 (automatic) | 18/20 by hand (16/20 automatic) | at least 16/20 | **pass** |
| A correction leaves no trace of the wrong value | 17/20 | 18/20 (EN 9/10, HU 9/10) | today's suites still pass | no worse than config 1; suites not run |
| Time | | the tests below | | **pass** |
| Label entities' effect on recall (60 questions, top three) | 29/60 | 27/60 | no harm | **no measurable effect** |
| Earlier entries stay out of turns not about them (small bank, 10 unrelated messages) | | 9/10 reach a temporary entry in the top three | never on its own | **open** (see Recall) |
| Regression gate | | not run | at or above today's | **not run** |

"Config 2" is the final wording: the targets were first measured with the first wording, which missed brainstorms and lasting labels, and the wording was revised once (commit `1e779c63e`). The classifier, the fallback for labels, meets every label target too (below).

## Extraction

`POST /memories/dry-run-extract`, one call per user turn, the previous assistant reply as context. 20 chats per category, 10 in each language.

| | Config 1 | Config 2, first wording | Config 2, final wording |
| --- | --- | --- | --- |
| Question-only chats with no fact | 20/20 | 20/20 | 20/20 |
| Brainstorms whose every fact names the chosen option | 0/20 | 0/20 | 1/20 |
| Brainstorms with no fact keeping a dropped option | 1/20 | 2/20 | 14/20 (EN 8/10, HU 6/10) |
| Brainstorms whose outcome is kept | 20/20 | 20/20 | 19/20 |
| Facts from the 20 brainstorms | 89 | 87 | 56 |
| Lasting facts kept | 20/20 | 20/20 | 20/20 |

**Brainstorms, read by hand** (final wording): a chat passes when nothing it leaves is a request, an option or a reaction to one; background facts said along the way (a friend's birthday, the room facing north, the band's genre) are memories and pass. 10 of 20 pass (EN 4/10, HU 6/10). What still gets kept: the request itself ("The user needs a new laptop for travel, budget around 1,200 euros", "nem tudja, mit vegyen Verának"), in 6 chats, and an option or a reaction to one ("finds Lumio Pro nicer but too heavy", "might send it on Sundays", "a karamellás túl édes lenne"), in 6; two chats keep both. One outcome was lost (a cake's flavour). **The target misses after the one wording revision**; the numbers above are the measured ones. The first wording's own clause ("an explicit personal statement inside them still is") let reactions through as statements; the final wording removed it and names requests, options, reactions and their reasons, with examples that are not in the test set.

## Labels

Labels come from Hindsight's own extraction (`entity_labels`, config 2), on the facts that name their chat's fact (a marker), against the chat's labels. Lasting, ongoing and temporary chats on a personal bank, 20 project-chat sentences on a project bank.

| | First wording | Final wording |
| --- | --- | --- |
| Kind right | 79/86 (92%) | 81/84 (96%) |
| Subject right | 73/86 (85%) | 70/84 (83%) |
| Lasting facts labelled temporary or ongoing | 6/35 (17%) | 1/34 (3%) |
| Facts with no kind | 0 | 0 |

The first wording read "studies at a university" and a project's goals and figures as ongoing. Most remaining subject differences are a temporary event filed under a specific subject where the fixture expected "other" (a driving theory exam as `work_study`, a plumber's visit as `home_family`).

**The classifier** (`classifyMemoryFacts`, the label migration's and the fallback's), on the same 84 facts, 20 per call, at temperature 0 with thinking off, through the same JSON-schema request shape the curation model path sends: kind 81/84 (96%), subject 71/84 (85%), lasting facts labelled temporary or ongoing 0/34; EN kind 42/44, subject 36/44; HU kind 39/40, subject 35/40. 84 facts took 7.6 seconds.

## Consolidation

One scratch bank per scenario, config 2 (final wording): the first statement retained and consolidated (dated 10 March 2026), then the second (20 September 2026); the observations are read afterwards.

| | Config 1 | Config 2 |
| --- | --- | --- |
| Change: the new state is current | 20/20 | 20/20 |
| Change: the old state is kept anywhere | 12/20 | 20/20 |
| Change: new state current, old one kept only as earlier (automatic) | 5/20 (EN 3/10, HU 2/10) | 16/20 (EN 8/10, HU 8/10) |
| Change: the same, read by hand | | 18/20 (EN 8/10, HU 10/10) |
| Observations with an end date the person did not state | 4 | 0 |
| Dated earlier-state notes `(YYYY-MM-DD HH:MM: …)` written by Hindsight | 0 | 0 |
| Correction: the right value, no trace of the wrong one | 17/20 (EN 9/10, HU 8/10) | 18/20 (EN 9/10, HU 9/10) |

The automatic grader counts an observation that names the old value as earlier only when it carries a history word; it misses Hungarian past tense ("járt", "elégedett volt"), which is why two Hungarian changes pass only by hand. It grades both configs the same way. By hand, config 2's two failures are a rented flat left current beside the bought house, and a separate present-tense line about the old phone.

**Corrections.** Both configs fail the same two: the spec's own case, "my sister lives in Graz, not Vienna", where "works at a hospital there" stays "in Vienna" (config 1 the same), and "I don't speak Italian", kept as the person's own negation (config 1 the same). Config 1 also keeps "allergic to eggs, not milk". So config 2's history sentence does not weaken corrections on this set; the Graz/Vienna residue is older than part 2. One config 2 oddity: the Graz/Vienna chat, in English, got two observations written in German.

**Where earlier states live (review Important 3).** At the pin Hindsight writes a dated earlier-state note only when an older fact arrives after the observation it changes (`consolidator.py`, the `later` and `marked` branch); a change told in order keeps the old value only if the model writes it into the observation's text. Neither config produced a single dated note in 40 scenarios. Config 2's sentence is what keeps the old value (20/20 against 12/20) and stops invented end dates, so it stays, but the history it keeps is undated prose inside the current entry ("The user lives in Norwich; previously lived in Exeter"). The spec's page line "Earlier: lived in Budapest · said March 2025" therefore cannot come from notes for ordinary changes: part 3 needs another source (Hindsight keeps an observation's earlier versions, `GET /memories/{id}/history`) or shows the text as it is. This is a spec finding for the owner, not something this part can change without changing Hindsight.

## Recall

**Label entities.** The same 60 personal facts (lasting, ongoing, temporary; one document each, dated across 2026) retained and consolidated into one bank per config, then the same 60 questions ("What do you know about <name>?", in each fact's language) against both. Recall makes no model call; this stack ranks with ONNX embeddings and FlashRank, not production's GPU embedder and BGE reranker.

| | Config 1 (no labels) | Config 2 (`kind:` and `subject:` entities) |
| --- | --- | --- |
| Observations | 59 | 55 |
| The fact ranked first | 17/60 | 18/60 |
| In the top three | 29/60 | 27/60 |
| Anywhere in the results | 53/60 | 54/60 |

No measurable effect at this size. The integrated benchmark would measure it at scale (Regression gate).

**Earlier entries for a message that is not about them (review Minor 4).** In the config 2 bank, 10 unrelated messages ("Thanks, that helps a lot!", "How do I convert Fahrenheit to Celsius?", five of each in Hungarian): **9 of 10 put a temporary entry in the top three**, so the spec's rule as built (an Earlier entry may join a turn from the top three places of its bank's message ranking) would bring Earlier entries into most turns of a small bank. FlashRank scores "Thanks, that helps a lot!" at 0.99 against Hungarian temporary entries here, so no score floor can be calibrated on this stack. **Open before rollout:** measure the same on a non-production Hindsight with production's embedder and BGE reranker; if unrelated messages still reach Earlier entries, admit an Earlier entry only above a reranker score measured there, or not by rank alone. `RECALL_EARLIER_NOTE` tells the model to bring such an entry up only when the conversation is about it, which softens but does not remove this.

## Time

On a fixed clock, in the repository's own tests (no model involved; part of every `npm test`):

| Target | Test |
| --- | --- |
| A temporary entry is no longer offered on its own after the threshold, counted from its event date when it has one | `memory-profile/entry-time.test.ts`, "counts a temporary entry from the later of its mention and its event"; `memory-context/native.test.ts`, "keeps Earlier entries out of the core" |
| A quiet project is marked, then Earlier | `entry-time.test.ts`, "marks an ongoing entry quiet, then earlier, by its last new fact only" |
| A new fact makes it current again; being recalled does not | `native.test.ts`, "a new fact makes an ongoing entry current again; recall itself never does" |
| A message about it brings it into that turn, marked as earlier, at most three per turn | `native.test.ts`, "admits an Earlier entry only from the top three of its bank's ranking", "keeps at most three Earlier entries in a turn, the best ranked first" |
| The model's own lookup returns Earlier entries and earlier states, marked | `native.test.ts`, "the tool returns Earlier entries and earlier states, marked" |
| Lasting, unlabelled, undated and person-written entries never age | `entry-time.test.ts`, "never ages a lasting, unlabelled or undated entry", "never ages an entry the person wrote"; `native.test.ts`, "an entry the person wrote never ages" |

Folding on the page is part 3's.

## Regression gate

Not run tonight. Each of the three needs the app itself as Hindsight's admission service and real deliveries, which the spec places on a non-production Hindsight on the box with the owner's approval:

- `docs/plans/hindsight-memory/native-lifecycle-acceptance/` (`run.ts <en|hu|cancel|privacy|faults>`, its README's five steps).
- The current-list and edit/remove holdouts (`docs/plans/hindsight-memory/current-list-followup/`, `edit-remove-followup/`): their records are in the repository, their scripts are not.
- The integrated benchmark (`docs/plans/hindsight-memory/integrated-native-benchmark/run.ts p01` to `p06`): 102 authored messages for each of six profiles, about 600 deliveries, each a retain and a consolidation; well over a thousand model calls, which at three in flight is an overnight run on its own.

The label entities' effect on recall (the spec: "its effect on recall must be measured") belongs to the integrated benchmark, run once with config 1 and once with config 2: it was not measured tonight. Part of the correction guarantee is covered below at the engine level (Consolidation, corrections).

## Config 3 (2026-11-24)

Bank config 3 (`nativeBankConfig` in `contracts.ts`; config 2 is kept word for word as `nativeBankConfig2`) changes two things, both found by the 2026-11-24 regression runs: **a purchase or an acquisition is lasting** (config 2's extraction labelled a dated purchase temporary, so a phone the person bought aged into Earlier) and **a stated preference about how the assistant should answer is kept as a lasting preference even when phrased as a plain request** (config 2's "requests are not memories" rule dropped it). Its words: the `kind` label's lasting and temporary descriptions (the classifier reads the same), and one retain-mission sentence. The observation mission is unchanged. Files: [part-2-acceptance/config-3/](part-2-acceptance/config-3/) (`fixtures.json`, `run.ts`, `start.py`, `relabel-acceptance.ts`, `results/`). Counts only here; every chat, fact and person is invented.

### Method

The same as above (Hindsight at the pin `9fb28dbd`, Flash-Next `qwen3-6-27b`, retain thinking on, `dry-run-extract` and scratch-bank retains), with two differences. The model was reached through the shared bridge (`regression-2026-11-24/bridge.cjs`), which holds the key and keeps every process of the run together, two helper sessions' calls included, at three in flight at most (peak 3, every call HTTP 200). And part 2's fixtures were run again as they are, with three new sets: **20 purchases and acquisitions** (10 English, 10 Hungarian: a phone, a puppy, a guitar given as a gift, a flat, a bike, a car, an adopted cat, a 3D printer, a standing desk ordered), **20 plain answer-preference requests** (10 and 10: "Please keep your answers short", "Rövid válaszokat kérek.", bullet points, a language, a tone, no emojis, a table for comparisons; each also said right after a long assistant reply, the way the app sends the previous reply as context), and **10 task requests** that look like preferences but ask for one piece of work ("Write me a short summary of the French Revolution", "Meg tudnád rövidíteni ezt a bekezdést?"), which must leave nothing. Config 2 ran the new sets and the question set in the same session as the baseline of the new targets; its other numbers are part 2's recorded ones above. Extraction labels are Hindsight's own (`kind:` and `subject:` tags of the facts naming the item); the classifier is `classifyMemoryFacts` with config 3's words. A purchase item passes when every fact naming it is labelled lasting; a preference passes when a fact names it and is labelled lasting.

### Summary

| Target | Config 2 | Config 3 | Target | Result |
| --- | --- | --- | --- | --- |
| Question-only chats leave nothing | 20/20 (recorded; again 20/20) | 20/20 (EN 10/10, HU 10/10) | at least 18/20 | **pass** |
| No new false keeps: task requests that look like preferences leave nothing | 10/10 | 10/10 (EN 5/5, HU 5/5) | none new | **pass** |
| Plainly stated lasting facts kept | 20/20 | 20/20 | at least today | **pass** |
| Kind right (extraction labels) | 81/84, 96% | 81/84, 96% (EN 42/44, HU 39/40) | at least 85% | **pass** |
| Subject right | 70/84, 83% | 72/84, 86% (EN 36/44, HU 36/40) | at least 80% | **pass** |
| Lasting facts labelled temporary or ongoing | 1/34, 3% | 1/34, 3% (EN 1/17, HU 0/17) | at most 1 in 20 | **pass** |
| A real change: new state current, old one kept as earlier | 16/20 automatic, 18/20 by hand | 16/20 automatic (EN 10/10, HU 6/10), 17/20 by hand; new state current 20/20 | at least 16/20 | **pass** |
| A correction leaves no trace of the wrong value | 18/20 (EN 9/10, HU 9/10) | 17/20 automatic (EN 9/10, HU 8/10), 18/20 by hand | no worse | **pass** |
| A settled brainstorm leaves only its outcome, by hand | 10/20 (EN 4/10, HU 6/10) | 10/20 (EN 5/10, HU 5/10) | today's 10/20 | **at today's number** (below the spec's 16/20, an open item since part 2) |
| **New:** purchases and acquisitions labelled lasting, by extraction | 7/20 (EN 3/10, HU 4/10; 13 of 20 had a temporary fact) | **18/20 (EN 9/10, HU 9/10)**; 2 of 20 have a temporary fact | at least 9 of 10, each language | **pass** |
| **New:** the same facts through the classifier (config 3's words) | | 43/43 lasting (the 21 facts config 3 extracted, the 22 config 2 extracted) | at least 9 of 10 | **pass** |
| **New:** a plain answer-preference request kept as a lasting preference | 18/20 (EN 10/10, HU 8/10) | **20/20 (EN 10/10, HU 10/10)**; after a long assistant reply also 20/20 (config 2 18/20) | at least 8 of 10 | **pass** |

No wording was revised: the first config 3 wording met every target, so there was nothing to choose between.

### Extraction

- **Purchases.** Config 3 misses two: "my parents gave me a guitar for my birthday on Saturday" (the gift reads as part of a birthday event) and "I ordered a standing desk" (Hungarian: an order not yet delivered reads as an errand). Both are ambiguous by nature; config 2 had 13 of 20 purchase items with a temporary fact.
- **Preferences.** Config 2 already kept most of them in this harness, English 10/10; its Hungarian misses were "Kérlek, pontokba szedve válaszolj." (bullet points) and "Magyarázd el egyszerűen, mintha kezdő lennék." (explain simply), with and without a preceding assistant reply. "Rövid válaszokat kérek." alone was kept by both configs here (as "A felhasználó rövid válaszokat kér."), so the 2026-11-24 regression miss, which came in a longer scenario, is not reproduced by a bare message; config 3 keeps all 40 variants, each labelled lasting.
- **Brainstorms by hand** (the criterion above: nothing left may be a request, an option or a reaction to one; background facts pass): passes EN b-en-01, 02, 04, 07, 08 and HU b-hu-02, 05, 08, 09, 10; fails EN 03 ("has not decided on a colour", a request), 05 ("the subject is golden, not dark", a reaction), 06 (the request and a reaction to a laptop), 09 ("might send it on Sundays", an option), 10 ("Bubbles is what everyone calls theirs", a remark on an option) and HU 01 (the name "should sound natural", a request), 03 ("can't choose a colour"), 04 (a plan for the hike and "the Kékes is too far"), 06 (the need), 07 ("the name Délibáb is taken", a reason). Automatic: no fact keeps a dropped option 15/20 (config 2 14/20), the outcome is kept 19/20 (19/20), 53 facts from the 20 brainstorms (56).

### Labels and the classifier

Hindsight's labels on part 2's 84 facts are in the summary. The classifier (`classifyMemoryFacts`, config 3's words, temperature 0, thinking off) on the same facts: kind 81/84, subject 71/84 (EN 42/44 and 36/44, HU 39/40 and 35/40), lasting facts labelled temporary or ongoing 0/34: as part 2 measured it.

**What a relabel would change** (the classifier with config 3's words, on facts config 2's extraction labelled temporary): all **13** purchase facts become lasting (EN 7, HU 6); **0 of the 21** truly temporary facts (an exam, a visit, a trip) move; the 4 project facts labelled temporary stay; the one fixture "ongoing" fact config 2 had labelled temporary stays temporary in this run (in the end-to-end run below it moved to ongoing in one of two runs).

**End to end** ([relabel-acceptance.ts](part-2-acceptance/config-3/relabel-acceptance.ts), `results/relabel-acceptance.json`): a fresh app database built by the app's own migrations (146 included), two synthetic accounts (one with the label migration's classifier labels, one new with extraction's) and a tester-flagged one, each holding the 86 facts config 2's extraction wrote for part 2's fixtures and this round's purchases, labelled as config 2 labelled them, one entry per fact said long ago. Real classifier through the bridge, two runs (the committed record is the second): per account **35 temporary facts, 13 moved to lasting** (every one a purchase), 22 left temporary, **entries Earlier 35 → 22** (the first run also moved the one mislabelled ongoing fact to ongoing: 14 and 21); 4 model calls for both accounts, 11 to 13 seconds, every other table byte for byte as before, the tester never read and its labels unchanged, a second run asks nothing (`nothing_to_relabel`, 0 calls), the rollback restores the original label rows exactly (13 changed and restored, 22 only looked at, a second rollback refused with `label_relabel_not_run`), and a run after the rollback asks the same facts again and reaches the same result.

### Consolidation

The observation mission is config 2's, so this is a check that config 3's retain sentence and kind words changed nothing there. One scratch bank per scenario, 40 scenarios, same grading as above.

| | Config 2 | Config 3 |
| --- | --- | --- |
| Change: the new state is current | 20/20 | 20/20 |
| Change: new state current, old kept only as earlier (automatic) | 16/20 (EN 8/10, HU 8/10) | 16/20 (EN 10/10, HU 6/10) |
| Change: the same, read by hand | 18/20 (EN 8/10, HU 10/10) | 17/20 (EN 10/10, HU 7/10) |
| Correction: the right value, no trace of the wrong one | 18/20 by hand | 17/20 automatic, 18/20 by hand |

By hand, config 3's Hungarian misses are c-hu-04 (the violin lessons stay current beside the guitar), c-hu-05 (the old phone is gone, not kept as earlier) and c-hu-06 (the old university is gone and the new one appears twice); c-hu-10 passes by hand (past tense "járt ... amíg fel nem mondta", which the grader misses). The three correction misses are x-en-05 (the correction's pronoun lost its subject: "An unidentified male lives in Montreal" beside Daniel in Toronto), x-hu-08 ("Máté tanár" stays beside the new partner's name) and x-hu-03, which passes by hand (the observations are in English: "The user's niece is nine years old"). Hungarian changes vary from run to run at ten scenarios each; they differ from config 2's in which scenario fails, not in kind, and the target holds.

### Reproduce

```sh
# The engine and the bridge (see regression-2026-11-24.md "Reproduce" for the pinned install), then:
ALFYAI_BRIDGE_PORT=18891 ALFYAI_BRIDGE_LIMIT=3 ALFYAI_NATIVE_MODEL_TRACE=<synthetic trace file> node docs/plans/hindsight-memory/regression-2026-11-24/bridge.cjs &
/tmp/alfyai-hindsight-eval/venv/bin/python docs/plans/hindsight-memory/part-2-acceptance/config-3/start.py 18990 alfyai-config3 &
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
for phase in setup extraction classifier consolidation report; do node --import tsx docs/plans/hindsight-memory/part-2-acceptance/config-3/run.ts $phase; done
node --import tsx docs/plans/hindsight-memory/part-2-acceptance/config-3/relabel-acceptance.ts
```
