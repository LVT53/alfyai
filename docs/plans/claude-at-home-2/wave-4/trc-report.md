# TR-C report: the empty states say what the tour says; the admin side's gaps; the last tour strings; no Slides chip

Agent TR-C, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-tra`, branch `feat/artifacts-tours`, e2e port 5410.
Commits `ffe2e222..c66d80c1` (12, on top of TR-B's `e20be6e6`). Nothing pushed, merged or rebased; no other branch or worktree touched; no subagent.

**Status: DONE_WITH_CONCERNS.** Every step of the brief is built, red first, and every gate is green. The concerns (the chat route's 33 B of headroom,
the alt-text deviation, the Canvas camera under the card, a type-switch trap in the admin dialog) are at the end.

## What the empty state was, per kind (the brief asked me to find out first)

| Kind | What a person saw in a new, empty one | What it is now |
|---|---|---|
| **Canvas** | A centred muted line, `canvas-empty` (`artifacts.canvas.emptyBoard`, the same sentence as the shipped summary), over the empty board, with the Insert button pulsing. Not interactive. | The same place and look, drawn by the shared `EmptyState`, with the line from the tour's summary and the link beneath it. |
| **Document** | **Nothing visible.** `createDocumentEditor` gives Tiptap's `Placeholder` "Write anything, or ask Alfy to.", but nothing in the repo styles `.is-editor-empty` / `data-placeholder` (grepped), so an empty or cleared Document is a blank page with the comment rail beside it (the red-run screenshot shows it). | The line and the link, laid just under the page's first line while the editor reports itself empty; the first typed letter takes them away, emptying the page brings them back. The Tiptap placeholder is left as it was (invisible); the empty state is a real element so a screen reader reads it. |
| **App** | **Nothing.** `AppBody`'s only "nothing" states are the transient "Alfy is writing the app…" (detail not loaded) and the load failure; an App whose stored source is blank got a blank iframe. The create and regenerate tools refuse an empty App (`empty_content`), so in practice an App is never empty. | The line and the link in the Preview where the blank frame would be, for a loaded App whose source is blank (or only whitespace). Rare by construction; flagged below. |

## Step 1: the empty state says what the tour says (T6)

- `src/lib/components/artifacts/empty-state.ts`: `emptyStateLine(summary, language, t, kind)` and `EMPTY_STATE_FALLBACK_KEYS` (document `artifacts.document.emptyState`,
  app `artifacts.app.emptyState`, canvas `artifacts.canvas.emptyBoard`). The summary in the reader's language, else the dictionary's line **in that language** (never the
  English summary on a Hungarian page). New strings (EN/HU in `artifacts.ts`): `artifacts.tour.replay` ("Show it again" / "Újra megnézem"), `artifacts.document.emptyState`,
  `artifacts.app.emptyState` (the spec's texts verbatim).
- `src/lib/components/artifacts/EmptyState.svelte`: the one block all three draw (never a per-kind copy): the line (`<p data-testid="<kind>-empty">`) and, when the panel supplies
  `onReplayTour`, a quiet underlined button beneath it (`<kind>-empty-replay`), 44 px tall on a phone, token colours, focus ring. Absent link in an incognito chat and for kinds with no tour.
- **The data path.** The panel (`DocumentWorkspace.svelte`) already asks once per open; it now keeps `tour.summary` from that same answer, seen or not (`tourSummary`, keyed by the open
  item, cleared with the item) and hands it down as the new `ArtifactBodyProps.tourSummary`. One request per open, nothing extra; a body never asks, and an incognito chat (no request) shows the
  dictionary's line with no link. Tour request failed: the same.
- Document: `createDocumentEditor` gained `onEmptyChange`, asked of **every transaction** (Alfy's landing content and a restored version carry `preventUpdate`, so an update-driven flag would stay up over them;
  a test pins exactly that). `DocumentBody` lays the block ahead of the editor host in a zero-height anchor, absolutely under the first line, so nothing shifts when the first word is typed.
  App: `appEmpty` shows it in the Preview. Canvas: `CanvasBoard` takes `emptyLine`/`onReplayTour` from `CanvasEditor` (which turns the summary into the line).
- Tests (red first; the unit files did not resolve before the code existed, the editor/body/panel/e2e ones failed on the right assertion): `empty-state.test.ts` (T6's five tests plus never-a-bare-key and a Hungarian
  fallback; **the drift guard reads both sources** and was mutation-checked: one word changed in `artifacts.app.emptyState` turns it red), `EmptyState.test.ts`, `document-editor.test.ts` (+4, real Tiptap in jsdom),
  `DocumentBody.test.ts` (+6), `AppBody.test.ts` (+7), `DocumentWorkspace.tour.test.ts` (+5: seen or not, each kind its own, none in incognito, none on a failed request).
  `tests/e2e/artifact-tours-empty-states.spec.ts`, **9 tests, real input**: a new empty Canvas shows the summary and the link beneath it; an empty Document says it, real typing takes it away and emptying the page brings it back;
  an App with nothing in it; the link shows the tour again, "Replaying", Step 1 of 3, through to "Got it", and **writes nothing** (no POST, no new row); an admin edits and publishes the Canvas tour through the API and the empty state shows
  **the edited line**, and after the admin archives it the code copy's line again (ruling 71); Hungarian; an incognito chat (line, no link, **no request at all**, no row); Tab-to-the-link and Enter on a Canvas and on a Document; a 390 px phone
  (link 44 px or taller, inside the screen, no page overflow). Run against the unfixed tree first: 7 of 8 failed (the incognito one passes by design, it guards the absence).

## Step 2: the admin side's two gaps, and the meta line

- **(a) Ruling 71, archive falls back to the code copy.** `artifact-tours.ts` reads only `published` campaigns (newest revision), so archiving takes the admin's words back and never the kind's tour; a still-published older
  revision stays live when a newer one is archived (an archived campaign is not live). `resolveCurrentTour` can no longer be null, so the wire types lost their nulls (`ArtifactTourResponse.tour` is always a tour; the 409's `contentKey` always
  a string) and the panel lost its `tour: null` check. Service, route and client tests rewritten (5 service tests: archived to code copy with its key, archive-while-live, older-published-stays, seen state against the code key, 409 names the key that writes).
  The e2e helper no longer deletes rows from the database: `archiveTour(api, id)` (the admin's own call), and `publishTour` duplicates the kind's last campaign when an earlier test left no draft; it can also reword the summary.
- **(b) A tour whose release is not a shipped kind cannot be published.** `validatePublishInput` adds `tourKind` ("A tour campaign's release must be the kind it introduces: document, app or canvas.", built from the shipped list), its mirror
  in `campaign-checklist.ts` (rule `tourKind`, path `tourKind`, so Publish is dead before a click), and the strings in both languages (`admin.campaigns.validation.tourKindInvalid`, `checklist.fail.tourKind`, `checklist.rule.tourKind`).
  Release updates are untouched. Tests: 4 service tests (each shipped kind publishes; `2.1.0`, `slides`, `file`, `Canvas`, `canvass` are refused; the refusal is added to other refusals, never instead of them; a release update's version is left alone),
  5 checklist tests. **Through the admin UI, real clicks** (`admin-users-campaigns.spec.ts`): the pane's New campaign dialog can only make first-run and release campaigns, so the arrangement (a tour with release `2.1.0`) is made through the API and everything
  after is the admin's: open the row, read "Tour · 2.1.0 · 4 slides", "1 check failing: Tour kind: Document, App or Canvas", Publish disabled, and a client that skips the pane gets the server's 400 with the same sentence; the same tour under
  `canvas` reads "Tour · Canvas · 4 slides", "12 of 12 checks pass · Ready to publish", Publish enabled. Each half of the rule was switched off in turn and the test went red.
- **TR-A's concern 2 is smaller than reported.** An admin cannot orphan a tour by editing "Release": `updateCampaignDraft` ignores `releaseVersion` (and `type`) for any campaign that is not a `release_update`, and `CampaignDialog` shows the Release
  field only for release updates. A tour with a wrong release can only come from `POST /api/admin/campaigns` with `type: "artifact_tour"`, which the pane never calls. The rule is a backstop for that route, as asked.
- **(c) The meta line.** `campaigns/campaign-labels.ts` (`tourLead`): the pane's line and the rail's row say "Tour · Canvas · 4 slides" / "Bemutató · Tábla · 4 dia", the kind in its `artifacts.type.*` word; a release text that names no kind is shown as it is, so
  the mistake can be read. (The rail had the same raw "canvas · 4 slides"; fixed with it.) New string `admin.campaigns.type.tour` ("Tour" / "Bemutató"). 4 pane tests.

## Step 3: the last strings, and no Slides chip

- **T7 tests:** `artifacts.test.ts` (the tour keys the card, menu and empty states read, named exactly, both languages, none blank, same placeholders in both, the house plural handled, no engineering word in them);
  `artifact-tour-defaults.test.ts` (no "artifact"/"artefakt" in any default string in either language, including Slides' kept copy; every Hungarian default names its own kind by the ratified word, from the `artifacts.type.*` row to the copy;
  no English or invented word for a kind, "vászon" included); `ArtifactTour.test.ts` (the drawings carry no words of their own). The "never says artifact in any dictionary value" test already covered the chrome.
- **Slides chip hidden:** `DOCUMENT_TYPE_FILTER_ORDER` loses `"slides"` (All · Documents · Canvas · Apps · Files); only the chip row hides, the filter type, the server's kind filter and the summary line still know the kind, so bringing it back is one entry.
  Unit tests updated (order, no chip, `documentTypeFilterFor` still buckets a Slides row); a new Knowledge e2e reads the five chips and none for Slides (red with the chip restored, green without).
- **AGENTS.md** Tours section: ruling 71, the tour-kind rule, the empty states (where each kind's lives, why the Tiptap placeholder is not it), the archive-based e2e cleanup.

## Gates (once, on the finished tree `c66d80c1`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2,471 files |
| `npm test` | 1,009 files passed + 1 skipped; **16,195 tests passed**, 2 skipped (+58 on TR-B's 16,137) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step, on that build) | **exit 0.** Editor first-paint closure **69.7 KiB gzip** (69.6 at the start of this phase; ceiling 70 KiB = 71,680 B). **Chat route 540,998 B gzip, +2,015 against the new baseline 538,983 (2,048 allowed).** Chart.js, MapLibre, Mermaid still out of the editor. |
| Playwright, port 5410 | chat, conversation, knowledge, every artifact suite (incl. `artifact-tours*.spec.ts`), `admin-users-campaigns`: **485 passed, 23 skipped, 0 failed** (39.7 min). 474 (TR-B) + 11 new = 485 (9 empty-state, 1 admin refusal, 1 Knowledge chips); the skip count equals the baseline's |
| Fallow | 124 issues, 4 circular: identical to the baseline and to TR-A's run; no finding on a file of mine (I made `tourKindWord`, which only `tourLead` reads, private before the run) |
| `npm run check:migrations` | clean (no migration of mine) |

### The chat-route baseline (ruling 68 note), numbers

Measured in one worktree path, on one machine: the commit before this phase (`e20be6e6`) **540,580 B** (+2,015 of the old 538,565, 33 B of headroom). My first full build was 541,017 (+437) and I moved the baseline by that; the finished tree
measures **540,998, +418**, so the baseline is **538,565 + 418 = 538,983** (two commits: `da57f1ee`, settled by `c66d80c1`, each with its numbers). The growth is the dictionary the chat loads (the two empty-state fallback lines, the replay link and the admin's
tour-kind strings are every route's) and the panel keeping the summary for its bodies; the empty-state parts themselves live in the lazy bodies. The route sits where it sat before this agent: **+2,015 of 2,048, 33 B of headroom**. Anything else that
touches the chat's dictionary or the panel moves it again by its own measured growth, or the orchestrator re-baselines to regain the 2 KiB.

## Screenshots (HU), looked at

In `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trc/` (the throwaway spec that took them is `../../zz-trc-shots.spec.ts.txt`, not committed):

- `canvas-empty-1440-light-hu.png`, `canvas-empty-1440-dark-hu.png`: "Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá." centred, "Újra megnézem" underlined beneath it, the Insert button pulsing as before. Dark reads as well as light.
- `canvas-empty-390-light-hu.png`, `canvas-empty-390-dark-hu.png`: line and link centred in the board, clear of the toolbar and the zoom control, nothing overflowing.
- `document-empty-1440-light-hu.png`, `document-empty-390-light-hu.png`: the line and the link left-aligned under the page's first empty line, in the UI face (so it reads as a hint, not as content). **The first phone shot was a defect**: the link was indented 12 px
  from its line (side padding meant for a touch target); fixed (the 44 px comes from the height only) and retaken: the link sits under the line's first letter.
- `app-empty-1440-light-hu.png`: the App's Preview with the line and the link centred where the blank frame was (the Preview/Code tabs and "Módosítás…" above it as for any App).
- `canvas-empty-replay-1440-light-hu.png`: after a click on the link, TR-B's card above the board, "Újranézés", "1. lépés, összesen 3", Kihagyás/Tovább; the empty state still below it.
- `knowledge-chips-1440-light-hu.png`: Összes · Dokumentumok · Táblák · Alkalmazások · Fájlok, and no Diasor chip.
- `admin-refusal-1440-light-hu.png`: the campaign "Elírt bemutató" with the meta line "Bemutató · 2.1.0 · 4 dia", the failing check "A bemutató típusa: dokumentum, alkalmazás vagy tábla" and Publikálás not clickable; `admin-good-tour-1440-light-hu.png`: the same tour under `canvas`: "Bemutató · Tábla · 4 dia", "12 / 12 ellenőrzés rendben · Publikálásra kész". The rail rows read the same way.

## Deviations from the brief and the spec, with reasons

1. **No illustration alt text, so no `artifacts.tour.illustrationAlt`.** T7 lists "illustration alt text built from `artifacts.type.*`". TR-B's drawings are decorative (`aria-hidden`, next to the words that say what they show), which is the right
   accessibility call (an "An illustration of a Canvas" before every slide is noise), and I kept it. The test holds what is true: the drawings carry no words of their own in either language. If the owner wants alt text, it is one string
   and `role="img"` + `aria-label` on three SVGs, and +~150 B on the chat route.
2. **`emptyStateLine(summary, language, t, kind)`, not `(tour, t, kind)`.** The sketch had no language, and the panel keeps only the summary, so it takes `tour.summary` (`LocalizedText`) directly. `kind` is `ShippedArtifactTourType` (no Slides: ruling 69),
   so the spec's "no fallback key, so the `artifacts.type.*` name" branch cannot occur and is not built.
3. **The Document's empty state is not the Tiptap placeholder** (it has no style, and a pseudo-element cannot hold a link or be read by a screen reader); it is a real element under the first line.
4. **The wire types lost their nulls** (ruling 71 makes "no tour" impossible), a small simplification beyond "correct the resolver and its tests".
5. **The rail's meta line was fixed too**, not only the pane's.
6. **The failing checklist row states the requirement** ("Tour kind: Document, App or Canvas"), like its neighbours, instead of the bare "Tour kind" I first wrote: the Release field is not on the dialog for a tour, so the row is the only clue.
7. **T7's "keeps the admin.campaigns.* additions sorted" test** is in the spec but not in the brief's list, and the sorted placement of my own five strings was done by hand (verified by eye); I did not add a dictionary-order test the repo does not have.

## Open questions / concerns

1. **The chat route has 33 B of headroom again** (above). The next agent whose strings or panel code grow the route moves the baseline by its own measured growth, or the orchestrator re-baselines.
2. **The editor's first paint is at 69.7 of 70 KiB** (+0.1 KiB for the Canvas's empty block and its two props). Another 0.3 KiB there needs a recorded reason or a lazy part.
3. **An App is never empty in practice**, so its link is almost unreachable; the Canvas (delete everything) and the Document (clear the page) are the real hosts. Ruling 71 calls the empty state "the host every item has"; for an App that is true only of a blank one.
4. **The Canvas keeps its camera when the card arrives** (TR-B's concern 3) is untouched: not in this brief. With an empty board there is nothing to mis-frame, but a replay on a populated board hits it.
5. **The campaign dialog's type pills on a tour draft** (First-run / Release, neither active) let an admin click "Release", which turns the draft's local type into a release update and shows a Release field; the server ignores the type on save, so nothing persists,
   but the pane then reads wrong until reload. Pre-existing, not mine; a three-line fix would hide the pills for `artifact_tour`.
6. **`artifacts.document.editor.placeholder` is now a dead-looking key**: it still feeds Tiptap's invisible `data-placeholder`. Removing it means dropping the option from `createDocumentEditor` and a dozen tests that pass it.
7. **The empty-state link's accessible name is just "Show it again"** (the spec's string); read out of its context a screen-reader user hears no "what". An `aria-describedby` on the line, or a fuller label, is a cheap follow-up if the owner wants it.

## HAND-OFF

- **Props:** `ArtifactBodyProps.tourSummary?: LocalizedText | null` (the panel's, keyed by the open item) beside `onReplayTour`; a new kind's body draws `<EmptyState line={emptyStateLine(tourSummary, $uiLanguage, $t, kind)} testId="<kind>-empty" {onReplayTour} />` and its dictionary key goes in `EMPTY_STATE_FALLBACK_KEYS`
  (the drift test then holds it to the shipped summary).
- **Where things are:** `components/artifacts/{EmptyState.svelte,empty-state.ts}`; `createDocumentEditor`'s `onEmptyChange`; `settings/_components/campaigns/campaign-labels.ts` (`tourLead`); `announcement-campaigns.ts` `validatePublishInput` (`tourKind`) and its mirror in `campaign-checklist.ts`.
- **e2e:** `artifact-tours-helpers.ts` gained `markToursSeen(user)` (a returning reader), `startIncognitoChatAs`, `seedItem(..., { empty, title })`, `createTourUser(language, role)`, `archiveTour(api, id)` (replaces `removeTour`), `publishTour(api, kind, { summary })`.
- **Not done on purpose:** a resume on the slide a closed tour was left on (ruling 71: it starts over), Slides anything (ruling 69), the Canvas re-fit under the card.

## Commits (`ffe2e222..c66d80c1`)

```
ffe2e222 Archiving a published tour gives the kind its code copy back, as ruling 71 says
4e47d62b A tour whose release names no kind that ships cannot be published
720706ad A tour reads as a tour of its kind in the campaign pane, not as 'Release · canvas'
b7a4d76f A Document, an App and a Canvas with nothing in them say what their tour says
40389b27 Prove the tour-kind refusal through the admin pane, with real clicks
96eed266 Hold the tours' last strings to the words the interface already uses
f5c4e0e0 Hide the Knowledge tab's Slides chip while no Slides can exist
97c6f22a Say in AGENTS.md where the tours' empty states, publish rule and archive semantics live
da57f1ee Move the chat-route baseline by the 437 B the tours' last strings and wiring add
a6b2ad20 Prove the empty states' link can be reached and used from the keyboard alone
ccba4f11 Keep the tour kind word private to the module that builds the line
c66d80c1 Settle the chat-route baseline at the growth the finished tree measures: +418 B
```
