# RC-T report: the tours (`feat/artifacts-tours`, `c66d80c1`), reviewed and walked

Agent RC-T, model `claude-sonnet-5-5`. Worktree `rc-t` (detached at `c66d80c1`, left unmodified: `git status` clean), dev server on 5500 with a
scratch DB (`data/rct.db`, `db:prepare` first), label `rct`. Report only; no fix attempted, nothing committed, no subagent.
Scripts: `…/scratchpad/w4/rct/*.rct.ts` (Playwright with real pointer and keyboard; the repo's e2e helpers for users and seeding),
notes in `…/scratchpad/w4/rct/notes.log`. Screenshots: `…/scratchpad/w4/shots/rct/` (14, each one looked at).

## Verdict: READY for ai.dev (no Critical, no blocker). Two Important findings are worth a small fix pass first or straight after.

| Severity | Count |
|---|---|
| Critical | 0 |
| Important | 2 |
| Minor | 14 (listed below; several are copy and admin-pane polish) |

What would block: nothing found. What the owner will most likely notice within minutes of walking it: I-1 (the card shoving the open item
down, and a populated Canvas coming up mis-framed when the card arrives late) and I-2 (the admin's "second line" field that does nothing).

## Independent gates (run by me on `c66d80c1`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (3 files: the known ToolActivityRow / ThinkingBlock / RouteItinerary) |
| `npx biome check src scripts tests` | clean, 2,471 files |
| `npm test` | 1,009 files passed + 1 skipped; 16,195 tests passed, 2 skipped (identical to TR-C's figure) |
| `npm run build` | exit 0 in 18 s; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step) | exit 0. Editor first paint 69.7 kB gzip (ceiling 71,680 B); chat route 76 chunks, **541,006 B gzip = +2,023 against the baseline 538,983 (2,048 allowed): 25 B of headroom** on my machine |
| Fallow | 124 issues, same breakdown as TR-C's `fallow-trc.json` (unused files 13, exports 87, types 9, deps 3+1) |
| `npm run check:migrations` | clean |

Not re-run: the full Playwright suite (TR-C reported 485 passed + 23 skipped); I ran my own ~30 walks instead (below).

### Are the two chat-route baseline moves honest? Yes: strings and trigger only
I built the merge base (`43694579`, exported with `git archive`, removed afterwards) and `c66d80c1` on the same machine and diffed the
chat route's static closure chunk by chunk (`rct/closure-diff.mjs`). Base 538,538 B -> head 541,006 B = **+2,468 B** (groundwork ~+390 + TR-B +1,682 + TR-C +418, within path noise):

| Chunk in the chat's first load | Δ gzip | What it is |
|---|---|---|
| `i18n` | +1,083 | the dictionary (the reader strings `artifacts.tour.*`, the two empty-state lines, **and** the admin-only `admin.campaigns.*` tour strings, which ride in every reader's dictionary) |
| `DocumentWorkspace` | +1,028 | the trigger, handlers and the replay wiring |
| `tours` (new, tiny) | +630 | `client/api/artifact-tours.ts` + `shared/artifacts/tours.ts` (this module also carries the admin-only `seedArtifactTours`) |
| `archive` | −280 | a chunk that merged away |
| everything else | ±10 | noise |

`ArtifactTour.svelte` (`CrqBCxne.js`, a dynamic entry) and the three drawings are **not** in the closure. In dev, a reader who has seen
every tour never requests `ArtifactTour.svelte` or `TourArt*.svelte` (checked while opening all three kinds), and a new reader requests them
only when the first card shows.

## Findings

### Important

**I-1. The card arrives after the item is already on screen, so the item jumps down; and a populated Canvas is left mis-framed.**
`DocumentWorkspace.svelte:630-652` (`presentTour`: GET, then a dynamic `import()` of the card) and `:654-668` (the effect), rendered above the
body at `:2104` (phone) and `:2425` (desktop), with no entrance or reserved space. `CanvasBoard.svelte:1116` fits once on open (`fitView`),
and nothing re-fits when the pane gets shorter.
Repro (first open of an unseen kind, HU, 1440x900, tour answer delayed 450 ms as on a real network: `page.route` on `/api/artifact-tours/*`):
1. Document: the editor host paints at y=166 (t=871 ms), the toolbar settles at 194, then at t=1293 ms the card lands and the page drops to y=384.
   190 px in one frame, no animation, ~420 ms after the reader could already read. Dismissing the card jumps it back up the same way.
   (With no artificial delay the gap is ~10 ms, i.e. one frame; the stock e2e therefore never sees it.)
2. Canvas with a 21-note board (`Nagy tábla`, screenshot 03): before the card the notes span y=161..789 inside the pane 121..900; after it
   the pane is 289..900 and the notes 329..957, so the last row sits 57 px below the fold and the row above is half under the toolbar
   (notes 19-21 not visible until the reader pans or presses the fit button). Whether it happens depends on which finishes first, the card
   (GET + chunk) or the board's first fit: with no delay the card wins and the board is centred (screenshots 02, 09 and 14), with latency the board wins.
TR-B (concern 3) and TR-C (concern 4) both saw this and left it. For a first impression of the feature it is the most visible rough edge.
Direction only: start the GET earlier (row click or hover), hold a collapsed slot, animate the insertion, or re-fit the Canvas on a container resize while the camera is untouched.

**I-2. The admin's tour editor has a required "second line" that nothing ever shows, with a placeholder that says it is shown.**
`artifact-tours.ts:144` takes only `summarySlide.title` for the reader (`ResolvedArtifactTour.summary` is a `LocalizedText`, no body); the card and the
empty states have no second line. Yet publish requires the summary slide's `body` in EN and HU (`announcement-campaigns.ts` slide rule: an empty body answers 400
"Localized EN/HU title and body are required", reproduced), and the seed fills it with "Add a short second line here, shown under the artwork." /
"Adj hozzá egy rövid második sort, ami a kép alatt jelenik meg." (`artifact-tours.ts:349-352`), which is false.
Repro: Settings > Adminisztráció > Kampányok > Canvas tour > slide 1: the "Cím" is the empty board's line (nothing on the slide says so) and the "Szöveg" is dead; screenshot 10.
The spec (slice-6.md:226-227) says that body is "the smaller second line"; the empty state TR-C built draws only the line and the link, and this is not in either report's deviations.
Direction only: either draw the second line in `EmptyState`, or stop requiring it and say on the summary slide that its title is the empty-state line.

### Minor

1. **Archive reveals the previous published copy, not the code copy, when two revisions are published.** `artifact-tours.ts:84-100` takes the newest *published* revision;
   publishing never archives the old one, so the normal Duplicate > edit > Publish loop leaves two. Repro (API): publish rev 2 and rev 3 of the Canvas tour, archive rev 3: readers get rev 2
   (`published:REV2`); only archiving rev 2 too gives `default:`. Ruling 71's "archiving falls back to the code copy" and the owner's "archive it -> the default copy is back" hold for one revision only.
   Also by design but worth knowing: a reader who only ever saw the published copy sees the code copy as a new tour (once) after an archive (`content_key` differs).
2. **A tour draft's details dialog still offers the First-run / Release pills.** `CampaignDialog.svelte:68-82`. Repro: App tour draft > pencil > "Kiadás" > type 9.9.9 > "Adatok mentése": the header reads
   "Kiadás · 9.9.9 · 4 dia" until a reload; the server ignored it (API afterwards: still `artifact_tour`, release `app`). Nothing persists (TR-C concern 5, reproduced).
3. **The slide-layout picker offers "Összegzés / Summary" for every campaign type**, release notes and first-run included (`SlideOptionsDialog.svelte:81`); only a tour gives it a meaning.
4. **The admin preview, image/alt/button fields and performance card are the announcement ones.** The preview (screenshots 10, 11) shows the AlfyAI logo placeholder, title, body and "1 / 4",
   not the card; every slide offers desktop/mobile screenshot upload, alt text and a button that no tour uses; the rail says "4 dia" for a three-step tour; the performance card on a tour reads
   "0% · Mind a(z) 4 diát végignézte · 0 Megjelenítve · 0 Befejezve · 0 Kihagyva · 0 Újranézve" (`PerformanceCard.svelte`) although tours record nothing by design.
5. **Row menu keyboard:** `role="menu"` (`ArtifactDeletePopover.svelte:97`) but ArrowDown does nothing and focus lands on the popover's "Bezárás" button; Tab reaches "Így működik ez a típus", Enter works.
   Pre-existing pattern, now with a second item in it.
6. **The live region announces only "n. lépés, összesen 3"** (`ArtifactTour.svelte:215`); a screen-reader user who presses Next does not hear the new title or body.
7. **The empty line flashes the default text before an admin-edited one.** `DocumentWorkspace.svelte:663-667` clears `tourSummary` on every item change, so until the answer arrives the dictionary line shows
   (with the "Újra megnézem" link already offered). With the 450 ms delay: default line at t=1081, edited line at t=1289 (`c7`). Invisible with the shipped copy (dictionary equals default).
8. **Hungarian copy.** (a) Document slide 2 names "a Megtartás és a Visszavonás" (`artifact-tour-defaults.ts:69`) but the pill's buttons say "Megtartom" / "Visszavonom" (`artifacts.ts:1144-1145`);
   the English names match the buttons. (b) "1. lépés, összesen 3" reads stiffly; "1. lépés / 3" is more usual. (c) The admin button "Bemutatók létrehozása" does not say "piszkozat" and sits under a help line about the
   first-run "bemutatókampány"; "bemutató" now names both. (d) The seeded drafts are called "Document tour / App tour / Canvas tour" (`artifact-tours.ts:334-338`) in a Hungarian admin.
   (e) "3 bemutató piszkozat létrejött, 0 már létezett." and the English "Seeded 1 tour drafts" have no plural handling (`settings.ts:92`).
   Everything else I read in HU reads naturally, including the three copies, the hint, the empty-state lines and the replay link.
9. **The sidebar badge is narrower than ADR-0012.** `api/campaigns/latest/+server.ts:10` now asks for `release_update` only; ADR-0012 (lines 17 and 85) and CONTEXT say the badge opens "the latest published campaign",
   which included first-run onboarding. Right for tours, a behaviour change for onboarding (a newer first-run is no longer what the badge replays). Ruling 32 says "announcement campaigns only"; either widen to
   {first_run_onboarding, release_update} or say so in the ADR. The shipped e2e (`artifact-tours.spec.ts:321-351`) only covers "tour published, no release note"; the real case (release note, then a newer tour) is a unit
   test, which I walked live and it holds (screenshot 12, `/api/campaigns/latest` returns `type: release_update`).
10. **The account archive files the rows under "Memory"** (`account-data-archive/index.ts:760-770`) as "Feature introductions seen"; `content_key` is left off on purpose, so a republish shows two identical "Canvas · completed" lines. Cosmetic.
11. **One GET per open, with no memory of the answer** (`DocumentWorkspace.svelte:654-668`), even for a reader who has seen every kind. Cheap; it is also what makes I-1 and 7 possible.
12. **After "Értem" a changed copy can bring the card straight back** (the 409 path, ruling 71's "starts again at slide one"): confirmed live (`c6`: Got it on slide 3 of the old copy -> 409 -> "ÚJ első dia", 1. lépés, nothing written for the old copy).
    By design, but at that moment the button looks like it did nothing.
13. **`seedArtifactTours` (admin only) sits in the module the chat loads** (`client/api/artifact-tours.ts:86-95`): a few dozen bytes of the +630. And ~half of the +1,083 B dictionary growth is admin strings the chat never shows.
    The chat route has 25 B of headroom, so the next string anywhere in the dictionary fails `check:artifact-chunks` until someone re-baselines.
14. **The Slides copy stays in `ARTIFACT_TOUR_DEFAULTS`** (`artifact-tour-defaults.ts:150-182`), unreachable: ruling 69 allows it and every path reads `SHIPPED_ARTIFACT_TOUR_TYPES`; noted only because the rule is "nothing advertises Slides".

## Diff review against the RV-6 list (file:line where it matters)

| Item | Result |
|---|---|
| Badge predicate | `getLatestPublishedCampaign(type)` now has a required type (`announcement-campaigns.ts:1184-1189`), the route passes `"release_update"`; a published tour never reaches the badge or its replay count. Live: release note published, Document tour published after it, badge click opened the release note (screenshot 12). See Minor 9 for the ADR gap. |
| Once per user per kind and per published copy | Unique `(user, kind, content_key)` + `onConflictDoNothing` (`artifact-tours.ts:311-329`); key `snapshot:<id>` or `default:1`. Live: an old-copy reader sees a new publish once (U1 and U2), Skip/Got it each recorded once, a second POST answers `alreadyRecorded: true`. |
| Replay writes nothing | Card `onClose` only (`DocumentWorkspace.svelte` `handleTourClose`); live: rows byte-identical after a mouse replay, a keyboard replay and three empty-state replays; requests were GETs only. |
| Incognito | `tourKindOf` returns null (`DocumentWorkspace.svelte:598-603`); live: a fresh user in an incognito chat opened a Document, a Canvas, an App and two empty items: **zero** `/api/artifact-tours*` requests, no rows, no link in the empty states; the same user's normal chat then showed the tour. |
| Seen row | No conversation or artifact column (`schema.ts`, migration `…112`); `USER_SCOPED_TABLES` cascade (`user-scoped-tables.ts`); the account archive lists it (checked in the real zip: no chat or artifact id in the section); deleting a user via the admin API took 3 rows to 0. |
| Archiving | `publishedCampaignForKind` reads `published` only; single revision: default is back (U1: `seen:true, default:1`, empty line back to the dictionary text). See Minor 1. |
| Publish rule for the kind | `announcement-campaigns.ts` `tourKind`; live: `slides`, `file` and `Canvas` each answer 400 with the message; the checklist mirror blocks the button first. |
| No Slides | GET and POST `/slides`, `/file`, `/toString`, `/__proto__`, `/Document`, `/canvas ` all 404 `{ok:false, reason:"unknown_type"}`; seeding made exactly 3 drafts; the Knowledge chips are Összes · Dokumentumok · Táblák · Alkalmazások · Fájlok, and the page has no "Slides"/"Diasor" text (screenshot 13). |
| Route shapes (ruling 49) | 401 (hooks' `{error, code:"session_expired"}`), 404 `{ok:false,reason}`, 400 `{ok:false,reason:"invalid_state",fieldErrors}`, 409 `{ok:false,reason:"content_changed",contentKey}`, 200 `{ok:true,…}`; extra body fields (conversationId, artifactId, userId) are dropped. The admin seed route answers 403 to a reader. |
| Lazy card | Dynamic entry in the manifest; see the chunk section. |
| "Artifact" in a user string | None in either language (grepped the added strings, the card, the menu, the admin lines, the archive; only URLs, class names and test ids). |
| Svelte 5 and Lucide | `$props`, `onclick`, `{@attach}`, `$state.raw`, `untrack`; `CircleQuestionMark` from `@lucide/svelte`; the three drawings are inline SVG, justified in each file's header as artwork, not icons (AGENTS' rule is about icons). No `<slot>`, no new legacy lifecycle. |
| Telemetry | None; the only logs are two `console.warn` of the error object on a failed request. A full walk (first open of all three, finish, replay, empty-state replay) produced **no console warning or error**. |

## The walk (Hungarian unless said; 1440x900 and 390x844; light and dark)

| Step | What I did and saw |
|---|---|
| First open of each kind | Document, App, Canvas each showed their own card with their own drawing and copy; 3 slides; hint "Egyszer látod. Bármikor újranézheted." on the last (screenshots 01, 02, 08). The card takes focus (a named region), 48 px buttons on the phone, no horizontal overflow at 390; no scrolling inside the card at 1440, 1024x768 and 820x1180 (178-248 px tall, buttons inside it). |
| Mouse | Next, Back, Next, Next, Értem on the Document: one POST `completed` (slide 2, default:1). Skip on App slide 2: `dismissed`, lastSlide 1. |
| Keyboard alone (Canvas) | Focus: card -> Tab Skip -> Tab Next -> Enter keeps focus on Next -> Shift+Tab Back -> Enter (focus is handed to Next because Back disappears) -> Enter, Enter -> "Értem" is the same element -> Enter finishes and focus returns to the panel title. Escape on slide 2 (focus in the card) = Skip, `dismissed`, in a normal and in an **expanded** panel (the panel stays open). |
| Reopen / reload | Opening a finished Document again: GET answered, no card. App after Skip + full reload: no card. |
| Replay from the list row menu | Row ⋯ > "Így működik ez a típus" (screenshot 04) opens the item with the card labelled "Újranézés" (screenshot 05, caught mid-slide animation); no writes (mouse and keyboard, Escape closes it); the menu row is absent on a File row. |
| Empty states | Canvas "Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá." + "Újra megnézem" (screenshot 06); Document line under the first line (screenshot 07), gone at the first letter, back after undo; App line + link; each link replays, writes nothing. |
| Incognito / second user | See the table above; a second fresh user saw every tour. |
| Admin | Fresh pane: "Bemutatók létrehozása" made 3 drafts ("3 bemutató piszkozat létrejött, 0 már létezett."); the rail reads "Bemutató · Tábla · 4 dia"; 12/12 checks. Edited the summary title (EN/HU) and slide 2's HU title, "Piszkozat mentése", "Publikálás" (no confirmation; screenshot 11). U1 (had finished the default) and U2 (had dismissed it) each saw the new card once; the empty Canvas then said the edited line. "Archiválás" (confirm dialog) -> `source: default`; U1 no card, empty line back; a reader who saw only the published copy sees the default tour once. |
| Version badge | Release note published first, a newer tour after: badge opens the release note (screenshot 12). |
| Knowledge | No Slides chip (screenshot 13). |
| Dark / phone | Canvas card in dark at 1440 (screenshot 09) and on the phone (screenshot 14): tokens read well, drawings fine. |

## Screenshots (all in `…/scratchpad/w4/shots/rct/`)
01 Document card, slide 1 · 02 Canvas card, slide 3 (keyboard focus ring), board below · **03 big Canvas, card arriving late: the last rows cut (I-1)** · 04 row menu with the replay row ·
05 Document replay, last slide · 06 empty Canvas line + link · 07 empty Document line + link · 08 App card on the phone (light) · 09 Canvas card, dark desktop · **10 admin tour editor: the dead "Szöveg", the generic preview (I-2)** ·
11 admin after Publish · 12 badge opens the release note · 13 Knowledge chips, no Slides · 14 Canvas card on the phone (dark).

## Method notes for a fix agent
- To see I-1: route `**/api/artifact-tours/*` GET with a 400-500 ms delay in Playwright, seed a tall board (21 stickies in 3 columns, 200 px apart) and a Document, open each as a fresh user.
- Users and seeding come from `tests/e2e/artifact-tours-helpers.ts` (`createTourUser`, `startChatAs`, `seedItem`, `markToursSeen`); the shared e2e admin has seen every tour, so a tour needs a user of its own.
- Re-baseline note for the chat route: measured on `c66d80c1` here, 541,006 B; the base (`43694579`) 538,538 B on the same machine.
- What was clicked and what was API: every reader flow (open, Next/Back/Skip/Got it, Tab/Enter/Escape, row menu, empty-state link) and the admin flows seed, edit, save, publish, archive and the details dialog were real pointer and keyboard input. The release note for the badge test, the extra revisions (Minor 1), the 409 publish, the Slides/File publish probes, the HTTP status checks and the account archive/erasure checks used the app's own HTTP routes (as the e2e helpers do).
