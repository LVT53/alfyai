# S4-V report: the deck fact check (ruling 66), and suite 4 re-run with it

Agent model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s4v`, branch `feat/artifacts-s4-verify` (from
`feat/artifacts-slides`). Commits `b80a2e9e` (the step-0 merge) .. `72d974e3` (the merge and 13 commits after it; 29 files,
+4,894 / -107 after the merge; nothing under `docs/`, `AGENTS.md`, `package.json`, `src/lib/components` or `tests/`, nothing in
another worktree). Status: **DONE_WITH_CONCERNS** (concerns in section 7).

## 1. Result in six lines

- **Step 0**: `feat/artifacts` merged in (Canvas and Slides side by side, both kinds kept everywhere); catalogue ceiling
  re-measured once for both kinds (5,031 en / 8,158 hu tokens measured, ceiling 5,057 / 8,185); both frozen snapshots regenerated.
- **Step 1**: before a deck is written, `create_artifact`'s Slides path runs the fact check: what the deck says that the
  user's material does not is confirmed by a page the web tool actually returned (and kept with it) or taken out; the
  result is stored with the deck (`metadata.factCheck`) and told to the model.
- **Step 2, live, web off (strictest mode), 3 repeats + the committed run = 16 decks**: 15 reached the check; **7 of those 15
  had unsupported specifics before it, 0 of 15 after**; 15 good, 1 bad (a structural refusal the check never saw).
- **What the check costs**: 7 of 15 decks lost something (14 details), 12 of 456 text fields changed or gone, **0 slides
  dropped**, 0.1 s on average (3 of 15 decks cost a model call, ~0.5 s each).
- Live too, with a **stubbed web** and the real model: the lookup pass calls `research_web`, classifies, copies a returned
  page as the source, and never confirms a private person.
- The one thing that changed shape against the brief: **only headings are reworded** (section 4), on measured evidence.

## 2. Step 0: the merge (`b80a2e9e`)

Resolved as both reports' merge notes said. Kept both kinds in: the create/edit/read handlers, `kind-prose.ts` (both worked
examples and both fragments), the serializer registry, the facade exports, `cases.ts`/`scoring.ts`/`TOOL_SUITES = { canvas,
slides }`, the README (canvas paragraph, then slides), the base prompt ("Document, App, Canvas or Slides"). `run-tool-suite.test.ts` is
a union (one describe per kind, the shared cases once); `tool-path.test.ts` asserts both contracts.
Every kind has a real create handler now, so the registry tests no longer leave a kind unregistered: they borrow one slot
and put the real handler back (a later test must never find a kind missing).

Catalogue, measured on the merged tree: descriptions **5,031 en / 8,158 hu** tokens (Canvas alone 5,002 / 8,117, Slides
alone 4,802 / 7,822: additive to within a token). `CATALOGUE_TOKEN_CEILING` = measurement + the same 26 / 27 margin =
**5,057 / 8,185** (was 5,028 / 8,144 on the Canvas side, 4,828 / 7,849 on the Slides side). Snapshots regenerated with `-u`:
en 51,194 -> 71,044 chars, hu 56,373 -> 76,337 (exactly the two branches' growth added). Numbers are in the merge commit
message. `npm run check` and the affected vitest were green before step 1.

## 3. Step 1: the fact check

Files (all under `src/lib/server/services/artifacts/slides/` unless noted):

- `facts.ts` (+ `facts.test.ts`): the suite-4 scorer's extraction **moved here with its tests** (one implementation). New:
  `listDeckFields` / `deckFactFields` enumerate a model's draft and a stored deck under the same labels, with a reference
  each field can be edited by; a cap on the number pairs tried for a derived figure (400 most recent distinct numbers; a pool
  under the cap behaves exactly as before). The scorer no longer has a field list of its own (a test proves it).
- `fact-check.ts` (+ test, 43): the core, `factCheckDeck(input)`; pure (its two questions go through an injected `ask`).
- `fact-material.ts` (+ test, 11): the user's material.
- `fact-check-runtime.ts` (+ test, 16): the app's wiring (`createSlidesFactChecker`).
- `create.ts`: `createSlidesArtifact` takes the check as `checkDeck` and an `abortSignal`.
- `src/lib/shared/artifacts/slides-fact-check.ts`: the record's type (client-safe, for the panel).
- `messages.ts`: `listConversationMessageTexts` (+ test).
- `normal-chat-tools/artifact-tools/{create,kind-registry}.ts`, `normal-chat-tools/index.ts`: the handler, payload, params.

**How it works** (the order is the contract; each step is tested):

1. Find the specifics (numbers, times, names and places) the deck has that the material does not, with the suite's own
   extraction. **None found: no model call at all** (an honest deck costs nothing).
2. A **time or a price** (a number with a currency beside it) the user did not give is **personal**: removed, no lookup.
   The rest (max 12 distinct per deck) go to ONE lookup pass (the chat model, thinking off, `research_web` built from
   `research-web-tool.ts`, at most 4 tool steps, ruling 57: no new cycle). A detail is **kept only when the pass names a
   page that the web tool actually returned** (the model's word for a source is not a source); a `private_person`,
   `booking`, `price` or `time` category is never kept whatever the pass says; unread answers, timeouts and errors remove.
3. What goes is **taken out**: a bullet whole, speaker notes sentence by sentence, a quote's slide whole; a **heading** (slide
   title/subtitle/eyebrow, deck title) is reworded by ONE bounded repair pass, checked with the same extraction (nothing
   unsupported left or added) and required to be no longer, else the heading's detail is removed instead.
4. A last deterministic pass makes sure nothing unsupported is left (up to 3 rounds), so the deck written meets the bar
   by construction. A slide whose title or quote went, or that lost all its bullets/columns, is **dropped and counted**; a deck
   with nothing left keeps one title slide; a deck/card title that cannot be reworded becomes "Presentation"/"Prezentáció".
5. A multi-word name ("Vila Nova de Gaia") is one detail (looked up, kept or removed, reported once).

**Time and stops**: total 90 s inside `create_artifact`'s 120 s (lookup <= 60 s, repair <= 25 s, a pass is not started with
< 4 s left); out of time removes (`out_of_time`), never fails the create. The create call's abort signal reaches both passes;
a stop that lands with an answer counts as a stop; a stopped call writes nothing (checked again right before the write).

**The user's material** (`gatherDeckMaterial`, every source scoped to the ONE conversation and its owner, through the
existing services): the conversation's words, both sides (new scoped `listConversationMessageTexts`, modelled on
`listRecentUserMessageTexts`); the message this turn answers (`ctx.requestText`: it is stored only when the turn ends) and
what the turn's earlier tool calls returned (the recorder: digest, summary, source titles and snippets); the conversation's
attached documents (the knowledge service that feeds the chat); and the Documents the turn read with `read_artifact`, **in
full** through the artifacts service (the recorder's digest is clipped to 1,500 characters). A source that cannot be read
is left out (more is then checked, never a failure). Incognito: a chat's words only vouch for that chat's deck; another
chat's (incognito or not) and another user's never do (tests on a real database).

## 4. Deviations from the brief, with reasons

1. **Only headings are reworded; body text is taken out** (the brief allows "removed or neutrally rephrased"). The first live run
   (12 decks) reworded 4 texts and **2 read badly**: a bullet left as `ish — Metro line E to Trindade`, speaker notes as `A
   Belvedere-ben egy csodája, A csók látható.`. The check can prove a rewrite adds no fact and is no longer, not that it is
   grammatical. Headings kept (the alternative is losing a slide), 2 heading rewrites in the later runs read fine (tiny samples).
   Rewording bullets again is one entry in `REWRITABLE_ROLES`. (Correction: the message of `32731b4d` says "2 of 6"; it is
   2 of 4, fixed in `978a62c3`.)
2. Prices and times are personal **by rule** (no model decides), so an opening hour or a ticket price a page could state is
   also removed. That is the brief's own list ("a time, a price, a booking, a person").
3. The extraction and its test file moved into the app (`artifacts/slides/`); the scorer imports it. `suites/slides-facts.ts` and
   its test no longer exist at the old path.
4. `read_artifact` results stay in the material as digests too (a board's read has only its digest here); only Documents are
   read in full. A canvas or deck body is not read in full: its positions and ids are numbers a deck could then "derive" from.
5. Nothing in the UI, the read model or the card summary: `metadata.factCheck` is where the panel agent reads it.
6. Not built, no handler exists yet: **Alfy's later edits go through the same check**. The API is reusable (section 7).

## 5. Step 2: suite 4 with the check, live

Harness: `ToolSuite.afterAnswer` (one optional step, given one plain completion through the run's own endpoint) and
`ToolPathEnvelope.extra` (one optional field), so `run.ts`, `config.ts`, `client.ts` are untouched (ruling 44). A live run
applies the app's check to each deck the strict parse accepts (**web off**: the request and its source are the whole material,
every unconfirmed detail is removed), keeps the model's own call untouched and records the outcome beside it (`extra.factCheck`:
checked deck, record, calls, tokens, time); the scorer scores the deck as written, counts a **confirmed** detail as sourced
(its page is on record) and scores a hand-written answer (no record) as written; a deck the strict parse refused is not checked
(the app answers with the refusal and the model resends once; the harness does not simulate that retry). A known-bad answer
never reaches the step (ruling 59). Each run is `qwen3-6-27b`, thinking off, sequential, port 30030.

| Configuration | Decks | No deck | Structurally invalid (never checked) | Language miss | Unsupported before the check | **Unsupported as written** | Good |
|---|---|---|---|---|---|---|---|
| S4-D v2, no check (its report) | 16 | 0 | 1 | 0 | 9 of 16 | 9 of 16 | 7 |
| First design of the check (body text reworded), 3 repeats | 12 | 1 | 1 | 0 | 5 of 10 that reached it | **0 of 10** | 10 |
| **Final**, 3 repeats | 12 | 0 | 1 | 0 | 6 of 11 (17 flags) | **0 of 11** | 11 |
| **Final**, the committed run | 4 | 0 | 0 | 0 | 1 of 4 (4 flags) | **0 of 4** | 4 |
| **Final, together (the rate)** | **16** | **0** | **1** | **0** | **7 of 15 (21 flags)** | **0 of 15** | **15** |

- **Ruling 66's bar (zero unsupported specifics in the deck as written): 15 of 15 decks that reached the check (100%), 15 of 16
  decks asked (94%); the one miss is a structural refusal** (an `eyebrow` on a `closing` slide, the model's recurring slip: S4-D's
  open question 2), which the app would answer with a refusal, not write. On the same runs the model's own decks had the
  problem in 7 of 15 (47%; S4-D measured 56%): the check is what meets the bar. It meets it **by construction** for the extraction
  (the same one the scorer uses); the next section says what that extraction cannot see.
- **What the check costs** (final code, 15 decks): removed something in **7 of 15** (2, 5, 1, 1, 2, 1, 2 details; 14 in all; reasons
  `web_unavailable` 13, `personal` 1), **12 of 456 text fields changed or gone, 0 slides dropped, 0 emptied**; latency **mean 0.1 s,
  max 0.5 s** (the check itself; only 3 decks needed a model call, mean 0.5 s, ~290 tokens each). The deck-writing call itself
  is ~4 s. **This eval has no lookup pass** (the brief's strictest mode); in the app the lookup pass runs only for decks with
  general details the material lacks (about half of these decks), bounded at 60 s + 25 s inside a 90 s check (the ruling's own
  estimate: 20 to 60 s). It has not been timed against the real Parallel API here.
- Also measured, **live with a stubbed web and the real model** (an ad-hoc script, not committed): a deck naming Klimt/Belvedere/
  1907/Kiss and "Ask for Anna at the front desk": 3 `research_web` calls in 2.6 s, the JSON contract followed, the four general
  details kept with a source copied from the stub's results, "Anna" `private_person` and removed as `personal`.
- **What the written decks still contain that the extraction cannot see** (I read the itinerary and Hungarian decks against their
  sources): a claim that is neither a number nor a name ("Casa da Ribeira is a short walk from Trindade"), a number that
  equals a relation of two source figures by coincidence ("about 3 hours" next to lunch three hours after a 10:00 visit), a
  lowercase detail ("A csók látható", the painting's title). These are limits of the suite's own definition of a "specific".

Committed: `scripts/eval-artifact-contracts/fixtures/slides/responses/*.json` (one run, 4 decks, all good, one deck lost 2
details), so `run.ts --suite slides --replay` re-scores the checked decks (4 scored, 0 bad). After re-recording, run
`npx biome check --write scripts/eval-artifact-contracts/fixtures` (the harness writes 2-space JSON, the repo's format is tabs).

## 6. Gates (final tree, `72d974e3`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the pre-existing ones) |
| `npx biome check src scripts tests` | clean (2,306 files) |
| `npm test` | 950 files, **15,019 passed**, 2 skipped, 0 failed (this agent added ~119 tests in 11 files and moved 25; one more test was added after this run, its file passes alone: 202) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` = the baseline exactly |
| Playwright, port 5450, all `artifact*`/`artifacts-*` specs + knowledge + chat + conversation | **202 passed, 1 failed, 11.1 min**; the 1 is the **first test of a fresh dev server**, `artifact-app.spec.ts:235` (`page.goto('/')` `net::ERR_ABORTED` after a Vite hydrate error in `node_modules/.vite`). Rerun alone it fails the same way; **with `--retries=1` all 12 pass (1 flaky)**. Server-only change, no client code touched; the `.vite` cache is shared through the `art-base` symlink |
| Fallow | **127 issues, 4 circular = the merge commit's own baseline** (measured on `b80a2e9e`: identical in every category); 0 findings in this agent's files. (The brief's 124 was before S3-B) |
| `npm run check:migrations` | passes; **no migration** was needed |
| `run.ts --suite all --replay` | document 7/0 bad, app 10/0, verification 4/0, canvas 6 scored 1 bad (unchanged), slides 4 scored 0 bad |

No screenshots: there is no UI in this agent. No i18n rows: every string I wrote is model-facing English.

## 7. Concerns and open questions

1. **The web path has not run against the real Parallel API.** It is proved by unit tests (mocked `research_web`), and once live
   with the real model and a stubbed web. Suggested walk on dev: "make 4 slides about the Belvedere museum in Vienna" with no
   material (the general details should come back confirmed with sources in `metadata.factCheck.confirmed`), then a deck with
   a private name or time in the request's own words (must survive), and one with a time the request never gave (must go).
2. The extraction's blind spots (above) are real; the bar is as good as its definition of a specific.
3. **`edit_artifact`'s description says "Documents and Slides: send patches" but no Slides edit handler exists** (S4-D's note 8):
   an edit on a deck answers `unsupported_kind`. Wrong if shipped before the edit slice.
4. Regenerate re-runs the check on the stored raw deck with less material (no turn context), so it may remove more than the
   first run did.
5. **Observed, not touched**: `app/verify.ts`'s `toModelCallUsage` reads `promptTokens`/`completionTokens`, but the model run reports
   `inputTokens`/`outputTokens`, so the App verifier's cost rows record 0 prompt and completion tokens (`totalTokens` is right).
   The Slides check reads the right names.
6. The structural slip (`eyebrow` on `closing`, 3 times in ~45 decks over all runs; a missing `body` once; a `two-column` without its
   right column once) still fails ~1 in 12 first attempts; the app's refusal names each fix.
7. The recorded name of the removed details is the deck's own wording (the web-off eval cannot tell personal from general, so it
   reports `web_unavailable`; in the app the lookup pass separates them).

## 8. Hand-off

**Record with the version** (`metadata_json.factCheck`, type `SlidesFactCheck` in `src/lib/shared/artifacts/slides-fact-check.ts`):

```ts
{
  checked: number;                       // details the material did not contain, examined: confirmed.length + removed.length
  confirmed: { text: string; source: string }[];   // kept; source = a page the web tool returned
  removed: { text: string; reason: "personal" | "unconfirmed" | "web_unavailable" | "out_of_time" | "not_checked" }[];
  slidesDropped: number;                 // slides taken out whole
}
```

Absent on a deck made before the check; `checked: 0` when everything came from the user's material. The panel's line: "Alfy
checked {checked} details; removed {removed.length} it couldn't confirm" (localised; the reasons are codes, not prose). Not yet
in `ArtifactCardSummary`/the read model (the card would read `metadata.factCheck`, like the App's `verification`).
`removed[].text` is the detail as the deck wrote it (a name or a number), never the sentence around it.

**What the model is told** (the `create_artifact` success payload): `factCheck: { ...the record, note? }`; `note` only when
something was left out, English: the details under `removed` are NOT in the deck; tell the user in one short sentence what you
left out and offer to add it. The tool call's metadata also carries `factCheckChecked/Confirmed/Removed/SlidesDropped` (numbers).

**API**: `factCheckDeck(input)` in `fact-check.ts` (pure; `draft`, `cardTitle`, `language`, `material`, `web`, `ask`,
`abortSignal`, `limits`, `clock`; returns the checked draft, card title, record, calls, tokens, elapsed ms, or `{ aborted: true }`);
`createSlidesFactChecker({ userId, conversationId, language, requestText?, turnEntries?, abortSignal })` in
`fact-check-runtime.ts` returns a `DeckChecker` (what `createSlidesArtifact({ checkDeck })` takes); `gatherDeckMaterial` in
`fact-material.ts`. **For Alfy's later edits** (Slides edit slice): build the changed slides into a `SlidesDraft` (no ids), run
the checker with the same conversation, and store its record with `updateArtifactBody({ metadataPatch: { factCheck } })`.
`CreateArtifactHandlerParams.turnContext` (`{ requestText?, sources }`) is what the tool closure hands a handler about its turn.

**Suite**: `ToolSuite.afterAnswer` + `ToolPathEnvelope.extra` (generic; Canvas can use them); the scorer's `extra.factCheck` reader is
in `suites/slides.ts`. Re-run:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
# replay, no model, no key:
npx tsx scripts/eval-artifact-contracts/run.ts --suite slides --replay
# live, one command with its tunnel (local port 30030), 3 repeats, answers kept for a look:
ssh -N -o ExitOnForwardFailure=yes -L 30030:192.168.1.96:30000 alfyroot & T=$!; sleep 2; \
  EVAL_ARTIFACTS_BASE_URL=http://127.0.0.1:30030/v1 EVAL_ARTIFACTS_MODEL=qwen3-6-27b \
  npx tsx scripts/eval-artifact-contracts/run-tool-suite.ts --suite slides --repeat 3 \
    --out /tmp/slides-out --responses-out /tmp/slides-answers; kill $T
# re-record the committed set (one run): add --write-responses (not with --repeat); then biome --write the fixtures
```

Working files (not committed), in this folder's `s4v/`: `stats-s4v.mts` (all the numbers above, from the recorded answers),
`show-written.mts`, `rewrites.mts`, `offline.mts` (recorded raw decks through the final check without a model), `verify-live.mts`
(the stubbed-web live check), `live.sh`, and every run: `run-answers` (first design), `final-answers`, `final2-answers` (final),
`committed2` (the committed run), `gate-*.log`, `fallow-s4v.json`.
