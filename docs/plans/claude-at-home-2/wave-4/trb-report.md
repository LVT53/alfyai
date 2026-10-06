# TR-B report: the tour card, its trigger in the panel, and the replay from the list's menu

Agent TR-B, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-tra`, branch `feat/artifacts-tours`, e2e port 5410.
Commits `4c27734f..e20be6e6` (six, on top of TR-A's `39649e44`). Nothing pushed, merged or rebased; no other branch or worktree
touched (one detached scratch worktree under the scratchpad measured the chunk gate at `39649e44` and my head, and was removed).

**Status: DONE_WITH_CONCERNS.** Every step of the brief is built, every gate is green, the screenshots were looked at (one real
defect found and fixed from them). The concerns (the chat-route headroom, the "resume on the slide it was left on" line of the
spec's staging checklist, the Canvas camera, archive semantics) are at the end.

## Step 1: the card

- `src/lib/components/artifacts/tour/ArtifactTour.svelte` and `illustrations/TourArtDocument|App|Canvas.svelte` (no Slides: ruling 69).
  **The card and its three drawings are one lazy chunk**: the manifest shows `ArtifactTour.svelte` as a dynamic entry (2,844 B gzip)
  with no static importer and the panel as its only dynamic one. The panel imports it with `import()` only when a tour is about to show.
- Contract (a deliberate simplification of the spec's): `{ tour, startSlide = 0, replay = false, onSeen(lastSlide), onDismiss(slide), onClose? }`.
  `onSeen` once, with the last index, on "Got it"; `onDismiss` once, with the current index, on Skip or Escape; in `replay` neither is
  called and every way out is `onClose()`. One way out per card instance (a double click or a held Enter writes once).
- A region, not a dialog: `<section aria-label="How this kind works" tabindex="-1">`; no trap, nothing inert. Tab order is Skip, Back, then
  the primary button. The step ("Step 2 of 3") is an `aria-live="polite"` paragraph that changes in place; the dots are one `role="img"`
  named "3 steps". It takes focus when it shows unless the reader is already typing (a field, or inside a contenteditable such as the
  Document's editor), and hands focus back to where it was when it goes. **Escape is Skip only while focus is inside the card** (an attached
  keydown on the region, not the window), and the card marks that Escape handled, so an expanded panel is not also closed by it.
- **Next and "Got it" are one `<button>`** (label, handler and test id change), so the keyboard keeps its place when the last slide
  arrives; when Back disappears on slide one, focus moves to the primary. Both were found by reasoning about the keyboard flow, put in
  the e2e (`finish with the keyboard alone`) and the unit tests, and mutation-checked.
- Motion: the words slide in 12 px on a slide change through the existing `reducedMotionAnimate` (`MOTION_DURATION.standard`); under
  `prefers-reduced-motion` it jumps to the end and `animate` is never called (unit test).
- Layout: grid, illustration 96 px at the left on a wide panel; at 767.98 px and under the 64 px picture **floats at the corner and the
  words wrap under it** (the spec's "wraps under it"), buttons side by side across the card, `max-height: 40vh` / `45vh` with an internal
  scroll for a long published slide, never fixed or sticky. Tokens only (`--surface-elevated`, `--border-subtle`, `--radius-lg`,
  `--shadow-sm`, `--text-*`, `--accent*`, `--focus-ring`); `btn-secondary` / `btn-ghost` / `btn-primary` give the 48 px phone targets.
- The drawings: inline SVG, token-coloured, `aria-hidden`, each with the AGENTS.md-exception comment (an illustration, not an icon; no Lucide
  glyph depicts "a page with a checklist on it" / "a tool with a slider and a button" / "a board with a note, a block and a stroke").
- Strings: `src/lib/i18n/artifacts.ts`, in a block after `artifacts.panel.backA11y` (middle of the file on purpose, so W4-B appending at the
  end cannot conflict), EN and HU in the same commit: `artifacts.tour.region`, `stepOf`, `dots`, `next`, `back`, `done`, `skip`,
  `replayHint`, `replayOpened` (the spec's text; Dokumentum, Alkalmazás and Tábla come from the content copy and `artifacts.type.*`).
- Tests: `ArtifactTour.test.ts`, 19 tests: three slides with dots and Next; Back and the bounds; `startSlide` clamped; `onSeen` once with
  the last slide (a double activation writes once); `onDismiss` with the current slide; the replay hint on the last slide only and never in
  a replay; the step announced in the same live element; one region, no `aria-modal`, nothing inert, Tab order Skip/Back/Next and focus can
  leave; the same button from Next to Got it and Back handing its focus over (mutation-checked red without the handover); Escape = Skip only
  with focus inside; replay calls neither callback (three exits); live language switch with `en` fallback for a missing or blank language;
  the drawing of the kind, hidden; animation on a change and none under reduced motion; focus taken, returned, and left alone while typing.
  Red first: the file did not resolve before the component existed.

## Step 2: the trigger and the replay row

All in `DocumentWorkspace.svelte`, by symbol (`tourItemKind`, `tourItemKey`, `presentTour`, `recordTour`, `replayOpenItemTour`,
`replayTourFromList`, the `tourCard` snippet). The static code in the chat shell is the shared kind list, the client module, the state and
the handlers; the card is lazy.

- **When it asks.** When an item whose kind passes `isShippedArtifactTourType` becomes the open one while the panel shows that item (not its
  list, not closed): one `getArtifactTour(kind)`. **Not in an incognito chat: no request at all** (new prop `incognito`, passed by the chat
  page from `memoryIncognito`; the Knowledge page and the Files dialog do not pass it). File, an upload and Slides never ask.
- **When it shows.** `tour && !seen` (a retired kind, `tour: null`, or a tour with no slides shows nothing). The card is rendered inside
  `.workspace-body` above the body, once per surface (mobile overlay or docked/expanded desktop, gated like the bodies, so there is never a
  duplicate in the DOM), and only while it names the item that is open.
- **What it writes, and when.** `completed` with the last slide on Got it, `dismissed` with the current slide on Skip or Escape, **never on
  render**: closing the panel mid-tour writes nothing and the card is met again from slide one. A 409 re-asks and starts the new copy at
  slide zero (only if the reader is still on that item); any other failure of either request is a `console.warn` and the panel works as before.
  A card whose item changed, or whose answer arrives after the reader left, is discarded.
- **Replay.** The list row's overflow menu (it exists: `artifact-row-menu-<id>`, today a Delete-only popover) gains one quiet row, "How this
  kind works" (`artifacts.tour.region`, a help icon, `data-testid="artifact-replay-tour"`), above Delete, via a new optional prop on
  `ArtifactDeletePopover` (`onReplayTour`, passed only for a kind that ships a tour and not in an incognito chat). It opens the item (the same
  selection path as clicking the row) and shows the card once that item is the open one, labelled "Replaying"; it records nothing (the card
  calls `onClose`, and the panel also refuses to write for a replay). **The replay row is only in the menu rows that already have the menu**
  (rows this chat may delete): I first made the menu appear for any row with a tour and reverted it, because two existing tests state that
  a row that cannot be deleted has no overflow, and changing that contract was not mine to do.
- **One callback for the bodies:** `ArtifactBodyProps.onReplayTour?: () => void`, given by the panel to the open body (both invocations) only
  where a tour can show. See the hand-off.
- **The shared e2e user.** One answer: **`tests/e2e/global-setup.ts` writes the admin's three "completed" rows** (the code copy's key
  `default:<ARTIFACT_TOUR_CONTENT_VERSION>`, the last slide, straight into `artifact_tour_states`, constants imported from the shipped
  list so a version bump keeps it right), so the shared admin that every other spec signs in as has seen every tour. No app route, no
  runner-side reset. The tours' own spec signs in as a **fresh user per test** (`createTourUser`, a bcrypt cost-4 row; "a second user still
  sees it" is then something the suite can say). Honest note: I mutation-checked the need by disabling the seeding and running 60 existing
  artifact tests (App sandbox, Canvas, Document keyboard, phone touch targets): they all still passed, so this is determinism insurance
  (a card that arrives a few hundred ms late moves what those specs measure and takes the focus they type into), not the repair of an observed failure.
- Tests: `DocumentWorkspace.tour.test.ts` (17, the client module mocked, a `FakeReplayBody` fixture): asks for the open kind and renders the card
  above the body; seen / retired show nothing; File, upload and Slides never ask; incognito: no request and no replay offered; not while closed
  or on the list; finish and Skip write the right body once; closing mid-tour writes nothing and the card returns at slide one; each kind its
  own; a late answer is dropped; 409 re-asks and the new key is what a later write uses; 409 after leaving the item does not re-ask; a failed
  GET and a failed POST are warnings with the panel intact; the replay through a body writes nothing; the replay from the list's menu opens the
  item, writes nothing and applies once; no replay row for a File or in incognito. Mutation-checked: dropping the incognito guard, asking for
  every kind, and not recognising 409 each turn tests red (the panel's `!view.replay` guard is a second layer behind the card and
  its mutation is equivalent, so it is covered by the card's own test and the e2e instead).
  `ArtifactDeletePopover.test.ts` (+4): the row leads, closes after calling, absent without a handler, Hungarian, never in the confirm.

## Step 3: proof with real input

`tests/e2e/artifact-tours.spec.ts` (15 tests, 1440x900 unless stated) and `artifact-tours-helpers.ts`. Written and run **red first** (the first test
against the panel without the trigger: card not found; the panel and the item had opened, so it failed for the right reason). Every flow is real clicks and keys; nothing
calls a callback or sets state through the page.

1. A Document shows its tour on the first open, above the page (geometry), nothing scrolls inside the card, nothing written until the end;
   finishing writes one `completed` row, last slide 2; the second open asks, is told "seen", shows nothing; nor after a reload.
2. Closing the panel mid-tour writes nothing (no POST, no row) and the tour is met again at Step 1 of 3.
3. An App and a Canvas each show their own tour (a different kind meets its own).
4. A File never shows one and never asks (no request to `/api/artifact-tours` at all).
5. Skip at slide two writes `dismissed`, last slide 1; reopened (and after the list) it does not come back.
6. The keyboard alone: the card has focus, Tab reaches Skip then the primary, Enter through the slides, the same button keeps focus into
   "Got it", Enter finishes (a `completed` row), focus goes back to the panel title; on an App Escape is Skip (`dismissed`, slide 0) and closes
   only the card.
7. Escape in an **expanded** panel leaves the card and keeps the panel (mutation-checked: without `preventDefault` the panel returns to docked).
8. The sidebar version badge, with a Canvas tour **published through the real admin API**, never opens a tour: its `/api/campaigns/latest`
   answer is not an `artifact_tour` and no dialog opens (mutation-checked: with the badge asking for tours the test fails).
9. Replay from the list's menu: the card shows, "Replaying", Step 1 of 3, no once-only hint; finishing and Skipping write nothing (rows and POST
   count unchanged).
10. A failed tour request (500 on the GET): a console warning, no card, the editor visible and typed into, nothing written.
11. A failed seen write (aborted): the card closes anyway, nothing is stored, and the tour shows again next time.
12. An incognito chat shows no tour, makes **no** request to the tour routes (filtered on the pathname: the dev server also serves the client
    module `/src/lib/client/api/artifact-tours.ts`), writes nothing, and offers no replay row.
13. A second user still sees a tour the first one finished, and their state is their own.
14. A tour published while the reader reads (a 409 on the write): nothing written, the card restarts at Step 1 of 3 with the new key, and
    finishing records `snapshot:<id>`.
15. 390x844: the card inside the screen, no page overflow, not `fixed`/`sticky`, Skip and Next 44 px or taller, **the whole card shows
    without scrolling inside itself** (red with a 20vh cap: 45 px of the card clipped, green with the real layout).

**The published-tour cleanup is a delete, not an archive.** An archived `artifact_tour` is a deliberate retirement (ruling 4, TR-A's
resolver): the kind then has no tour at all, and the e2e database outlives the spec. My first run archived and every later Canvas test
saw `tour: null`. `removeTour(campaignId)` deletes the campaign row (the tables cascade), which returns the kind to its code copy.

### Screenshots (HU), looked at

In `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trb/`
(the throwaway spec that took them is `../../zz-trb-shots.spec.ts.txt`, not committed):

- `canvas-1440-light-hu.png`, `canvas-1440-dark-hu.png`: the card above the board, Canvas drawing at 96 px with its dotted grid, dots, "1. lépés, összesen 3",
  serif title "Egy tábla, bármire", body, `Kihagyás` / `Tovább` right-aligned. Dark reads as well as light; hollow dots and the accent dot visible.
- `canvas-390-light-hu.png`: after the fix, the picture floats at the corner and the words wrap under it, buttons side by side, the card whole.
  **The first phone layout was a real defect**: stacked picture at 64 px, `max-height: 30vh` (253 px) and a card of about 300 px, so the footer buttons were clipped by the card's own
  scroll (the first screenshot showed `Kihagyás` and `Tovább` cut in half), and my phone assertion passed anyway because a clipped box keeps its size. Fixed (floating picture, 45vh
  cap) and the assertion now measures the card's scroll height and each button inside it.
- `document-last-slide-1440-light-hu.png`: "3. lépés, összesen 3", third dot, "Hogyan kérj ilyet", the once-only hint "Egyszer látod. Bármikor újranézheted." at the left of the footer,
  `Kihagyás` `Vissza` `Értem`; the editor toolbar follows below.
- `replay-row-menu-1440-light-hu.png`: the row's menu popover: "Így működik ez a típus" (quiet, help icon) above "Dokumentum törlése" (the red Delete).
- `document-slide2-390-light-hu.png`: the longest default copy at 390: whole card, three buttons side by side.
- `app-390-dark-hu.png`: the App card and drawing at 64 px in dark.

## Gates (once, on the finished tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2,465 files |
| `npm test` | 1,007 files passed + 1 skipped; **16,137 tests passed**, 2 skipped (+43 on TR-A's 16,094) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step, on that build) | **exit 0.** Editor first-paint closure 69.6 kB gzip (script kB = KiB, unchanged ~71,270 B of 71,680). **Chat route 540,590 B gzip, +2,025 against the new baseline 538,565 (2,048 allowed).** Forbidden libraries still out of the editor. |
| Playwright, port 5410 | chat, conversation, knowledge, every artifact suite (incl. `artifact-tours*.spec.ts`), `admin-users-campaigns`: **474 passed, 23 skipped, 0 failed** (39.3 min). 459 (TR-A) + 15 new = 474; skip count equals the baseline's |
| Fallow | 124 issues, 4 circular: identical to the baseline, no finding on a file of mine |
| `npm run check:migrations` | clean (no migration of mine) |

### The chat-route baseline (ruling 68 note), numbers

The brief expected the strings and the trigger to push the route over, and they did. Measured on one machine, one worktree path, the commit before against mine
(a detached scratch worktree, then removed): **538,909 -> 540,591 B gzip = +1,682 B**. (In `art-tra` TR-A's recorded 538,929 -> my 540,590 reads +1,661; the 20 B between the two
"before" figures is the worktree path.) `package.json`'s `--chat-baseline` moved **536,883 -> 538,565** (+1,682, commit `394d9160`, reason and numbers in its message). The growth is the
panel's trigger and handlers, the nine strings in two languages and the menu row; the card and drawings are not in it. **The 2 KiB tolerance was already spent before me** (the merged
groundwork was at +2,048 of 2,048), so the new baseline leaves 23 B: the next agent whose strings or panel code grow the route moves it by its own measured growth, or the orchestrator
re-baselines to the measured figure if the guard should regain its 2 KiB.

## Deviations from the spec, with reasons

1. **Card contract: `replay` + `onClose` instead of `onReplayLater`.** The spec says replay passes `onReplayLater={undefined}` and "neither callback writes", while its test list says the card
   "calls neither callback when replaying" and its UI table says Got it and Skip "just close". A card that needs a way to close without a callback needs one: `onClose`. `onReplayLater` had no use and is not built.
2. **`startSlide` exists but the panel never passes it.** An unseen tour has no stored slide (nothing is written on close, per the brief), and a seen one is not shown, so a resume cannot come from the server (see concern 2).
3. **Tokens:** the spec's `--surface-raised` and `--text-tertiary` do not exist; `--surface-elevated` and `--text-muted` are the nearest.
4. **Phone cap 45vh, not 30vh**, with the picture floated (see the screenshots): the shipped copy has to fit whole; 30vh is for a long published slide, which still scrolls inside.
5. **Skip is in the footer on every slide** (first in tab order), with Back as a quiet ghost button, as the spec's focus order says, rather than the mockup's two-button footer.
6. **Strings: only the nine the card and the menu use.** Not added: `artifacts.tour.close` (no X button: Escape and Skip are the exits), `artifacts.tour.loadFailed` (a failed GET shows nothing, per the spec's failure table),
   `artifacts.tour.illustrationAlt` (the drawings are `aria-hidden` next to their text) and `artifacts.tour.replay` (TR-C's empty-state link). The row reuses `artifacts.tour.region` ("How this kind works"): one string, one meaning.
7. **The replay from the list opens the item and shows the card above it** (there is no card in the list view). A retired kind (`tour: null`) opens the item and shows no card; the row still exists.
8. **`ArtifactDeletePopover` carries the replay row** though it is named for Delete; renaming it would churn every test id and spec for no behaviour. Its header comment and AGENTS.md say so.

## Open questions / concerns

1. **The chat route has 23 B of headroom** (above). Any growth in the route from here fails `check:artifact-chunks` unless it moves the baseline by its measured growth.
2. **The slice's staging checklist item 11 says a tour closed mid-way "appears again on the next open, on the slide it was left on". I restart at slide one.** The brief says closing writes nothing, so the server cannot know the slide; it could only
   come from client memory. Smallest honest version: an `onSlide` report from the card and a `Map<contentKey, slide>` in the panel (~150 B in the chat route), passing it as `startSlide`. Not built: it was not in the brief and it costs chat-route bytes.
3. **The Canvas keeps its camera when the card arrives or goes.** `CanvasBoard` fits once on open (`fitView` is an init prop, there is no re-fit on a container resize). When the card arrives after the board has fitted (the usual order in a warm tab), the board's
   content sits one card-height lower (170 px at 1440x900) until the reader pans or presses fit, and the bottom of a big fitted board is below the fold; in the other order (card first) it is centred. A small board is fine, a large one is cut. This is the
   Canvas editor's behaviour, not changed here; the fix is a re-fit on a container resize while the camera is untouched. Documents and Apps are unaffected.
4. **Archiving a published tour retires the kind (no tour at all), while the spec's failure table says "the next GET returns the default tour".** TR-A implemented the ruling-4 reading ("archiving must not silently resurrect the default"). Worth a line in the admin pane so an admin
   who archives understands that the kind then has no tour.
5. **The 409 test publishes the seeded draft unedited**, so the "new copy" has the same words as the code copy; what it proves is the key mechanics (409, nothing written, restart at slide one, the new key recorded), not that edited words reach the card
   (TR-A's route tests cover that path server-side).
6. **TR-A's two admin concerns are still open** (an admin can orphan a tour by editing "Release"; the campaign header says "Release" for a tour): TR-C's polish.

## HAND-OFF for TR-C

- **The replay callback.** `ArtifactBodyProps.onReplayTour?: () => void` (`src/lib/components/artifacts/artifact-bodies.ts`). The panel hands it to the open body, in both `<ArtifactBody>` invocations, as `onReplayTour={tourItemKind ? replayOpenItemTour : undefined}`: given for a Document, App or
  Canvas that is open in a panel that is showing it, **undefined in an incognito chat** (and for any other kind). A body renders its empty-state "Show it again" link exactly when the prop is given, and calls it with no argument. It GETs the kind's tour (so it shows the latest
  copy) and shows the card in replay mode above the body whether or not the tour was seen, writing nothing. A body that does not name the prop in its `$props()` ignores it (today's three bodies do).
- **Where the strings live.** `src/lib/i18n/artifacts.ts`, my block right after `artifacts.panel.backA11y` in both `en` and `hu`: `artifacts.tour.{region,stepOf,dots,next,back,done,skip,replayHint,replayOpened}`. **For you to add:** `artifacts.tour.replay`
  (EN "Show it again", HU "Újra megnézem"), `artifacts.document.emptyState` and `artifacts.app.emptyState` (the spec's texts), and `artifacts.tour.illustrationAlt` only if an empty state shows a drawing without adjacent text. The tour's own words are content, never in the dictionary.
- **The empty-state line.** The panel does not keep `tour.summary` today: `presentTour` (the one place that reads the GET answer) drops the tour when it is seen. Two ways: set a `{ itemKey, summary }` state there before the `seen` early return and pass it down as a body prop
  (one GET per open, nothing extra), or let a body call `getArtifactTour(kind)` itself. In an incognito chat **no request is made**, so the body must show the i18n fallback line, which is also what the spec wants for `tour: null`. Whatever you choose, bodies get the line as data, not a request of their own in incognito.
- **Test ids:** `artifact-tour` (the region; `data-kind`, `data-replay`), `artifact-tour-title`, `-body`, `-step`, `-dot`, `-skip`, `-back`, `-next`, `-done` (the same element as `-next` on the last slide), `-hint`, `-replaying`, `-illustration`; the list menu row `artifact-replay-tour`.
- **The e2e answer, and what to use.** The shared admin has seen every tour (`global-setup.ts`), so your empty-state e2e as admin meets no card and the replay still works for it (replay ignores "seen"). For anything that needs an unseen state, `tests/e2e/artifact-tours-helpers.ts`:
  `createTourUser(language)`, `startChatAs(page, user)`, `seedItem(user, conversationId, kind)`, `reopenChat`, `openItem(page, title)`, `backToList`, `tourCard`, `tourRows`, `watchTourRequests`, `waitForTourAnswer`, `finishTour`, and for an admin-published copy `adminApi` +
  `publishTour` + **`removeTour` (delete, never archive: an archived tour retires the kind for the rest of the run)**. Panel unit tests mock the client module (`vi.hoisted` + `vi.mock("$lib/client/api/artifact-tours")`) and use `__fixtures__/FakeReplayBody.svelte`.
- **Other things you will meet:** the panel's `incognito` prop (the chat page passes it; other hosts default false); the row menu is `ArtifactDeletePopover` (`onReplayTour`); the card never imports the panel and the panel never imports the card statically, so keep it that way (the chunk gate would fail); AGENTS.md has a Tours section now (add the empty states to it).
- **Chat-route budget:** you will add strings (and maybe a prop per body). Measure before and after in one worktree and move `--chat-baseline` by exactly the growth (the number above is 538,565, 23 B of headroom).

## Commits (`4c27734f..e20be6e6`)

```
4c27734f A kind's first-open tour is a card of three slides, drawn per kind, in one lazy chunk
57e43391 Ask once per kind when an item opens, show the tour above it, and replay it from the list's menu
cbc41e8c Prove the tours with real clicks and keys, as users who have seen nothing
394d9160 Move the chat-route baseline by the 1,682 B the tours' trigger and strings add
563e7f22 Say where the tours live, so the next change puts the next piece in the right place
e20be6e6 An Escape in an expanded panel leaves the tour and keeps the panel
```
