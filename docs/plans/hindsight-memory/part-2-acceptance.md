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
