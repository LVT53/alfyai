# FX-2 report: layout, tour and phone (fix round)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fx2`, branch `fix/round-layout` from `feat/artifacts` (`db32912b0`). Ports 5420-5429. All five items done, red first with real input (touch at 390/360, frame-by-frame sampling for the tour), one commit per item.

| Commit | Item |
|---|---|
| `9b8759ecd` | 1. RC-A #4: the tour card has its room from the item's first frame and covers nothing |
| `d9106800b` | 2. FB-5 note: History is a Back layer |
| `30e4544eb` | 5. F6 (owner's call): the working strip's words are true for a read and an edit |
| `cd27c8cfb` | 4b. FB-9 note: conversation and project menu rows are 44 px on a phone |
| `8bd2e281c` | 4a. FB-9 note: the status chip's finger area and the change pill no longer share pixels |
| `278acf156` | 3. RC-A #8: the phone Knowledge page no longer runs 40 px past the screen |
| `4fdb971d5` | AGENTS.md: History is a layer of the panel's history entries (the tour paragraph is in `9b8759ecd`) |
| `9e9fdb822` | gate fixes (type guard, an answer that is not a tour, two asks counted from the last load) |

Range: `db32912b0..9e9fdb822` (8 commits; this report is not committed).

## 1. The tour card (RC-A #4, ruling 77) — 9b8759ecd

**Cause.** FB-3 laid the card over the item (`.workspace-tour-layer`, absolute) so a late answer could not push what was visible. Nothing moved, but it covered the Document's toolbar and first lines, the App's status row, the board's top (214 of 844 px on a phone).

**Fix.** The card is a row of `.workspace-stage` ahead of the body again (`.workspace-tour-slot`). The answer is in hand before the reader reaches for the item: `warmTours` asks for the tour of every kind the chat has an item of as soon as the chat has it (once per kind, shared with the open that follows through TR-D1's cache; not for a File; never in an incognito chat) and loads the card chunk when the reader owes the tour. `presentTour` runs in a `$effect.pre` and, when `peekArtifactTour(kind)` has a settled answer and `loadedTourCard()` has the card, decides synchronously, so the card is in the page in the flush that opens the item, before the body mounts (`entrance: "none"`). A late answer (first ask still on the wire, a replay, the new copy after a 409) arrives with the card's existing height transition (`entrance: "reveal"`), and the board follows its pane as before FB-3. New: `peekArtifactTour` (settled map, kept in step with the promises), `artifacts/tour/tour-card.ts` (the card's one lazy door).
Two behaviours changed with it, both found by the tests: the card leaves as a shrinking height only when the reader leaves (a card that goes with its item goes at once, so two same-kind cards never overlap), and it takes focus a task after it mounts (an on-time card mounts before the panel moves focus to the item's title, which took it back); it does not steal focus the reader already put inside it.

**Measured (frame by frame, relative to the panel; `artifact-tours-arrival.spec.ts`):**
- On time, fresh reader, 1440: Document, App, Canvas: the card is in the page in the item's first frame, the item's root and first part start at or below the card's bottom in every frame (red before: card bottom 291 over a toolbar at 122, on all three), neither the item nor the card moves (< 1 px). Phone 390 touch: the card is 214 px of 844 and the toolbar starts under it.
- Late answer: the Document goes down 190 px over 27 frames and 225 ms, largest step 16.6 px, and back up the same way on Skip (the two arrival tests FB-3's overlay had left stale pass again). Under reduced motion it is two frames at most.
- Asked before the reader's press (asked at 240 ms, pressed at 821 ms, text first painted at 1208 ms with the card already up).

**Screenshots (looked at):** `fx2-shots/tour-document-1440-hu-after.png` (card above tab strip, toolbar, text), `tour-document-390-hu-after.png` (phone: toolbar and first lines fully visible), `tour-canvas-1440-hu-after.png` (board fully below the card, 100%), `tour-app-1440-hu-after.png`, `debug-phone-before.png` (the overlay state on a phone).

## 2. History as a Back layer (FB-5's note) — d9106800b

`panel-history.ts`: `PanelLayer`'s item gets `history?: true`; depth may be 3 (only History reaches it); `planPanelHistory`: History gives way first whatever comes next (`back 1`, then planned afresh from the entry below), opens over its own item as one more entry (2 over a card's item, 3 over a list's), a close pops every entry. The chat page keeps `artifactHistoryOpen` (in `panelLayer`, `applyPanelLayer`) and passes `historyWanted` + `onHistoryOpenChange` to `DocumentWorkspace`, which stays the one that opens and closes History (flush + lazy chunk); History also goes with its item (a closed panel or the list no longer leaves the mode standing under the next open). A reload with History open opens it again from the entry the browser kept.
Tests: `artifact-panel-history.spec.ts` +5 at 390 touch and 1440 mouse with the browser's own Back/Forward: Back leaves History and the item stays; Forward brings it back; Done/Escape leave no entry; the X over History takes every entry; reload keeps it. Red first: 3 failed before. Unit: planner (29), new `DocumentWorkspace.history.test.ts` (6, fake History).
Concern: on a phone History is a sheet with its own preview/list peeling (Escape, grabber); the browser's Back leaves History as a whole.

## 3. Phone Knowledge (RC-A #8) — 278acf156

The page's column was `w-full box-content px-5`: the screen plus 40 px below md (page switcher at 375, sort/Upload at 371, delete at 364 on 360; 405/401/394 on 390). Now `box-border md:box-content`. `phone-polish.spec.ts` at 360 and 390 (touch, Hungarian, a Document, an App and a board in the library): no control or card reaches past the screen, no sideways scroll. Red before. Screenshots: `knowledge-360-before.png`, `knowledge-360-hu-after.png` (looked at: switcher, search + Upload, sort, card buttons all inside). Noted, not changed: the search placeholder is clipped at 360 ("Keresés név, cím, szerep vagy ta…"), a copy follow-up in the owner's "short Hungarian" direction.

## 4. FB-9's notes — 8bd2e281c, cd27c8cfb

- 4a chip vs pill: the chip's phone area is 44 px (9 px past its 26 px pill) and the inline change pill's buttons have a 44 px area (12 px past their 20 px box); the pill sits 3 px under the line it is about (14.8 px under the previous pill), so a tap on the chip's lower edge hit Keep/Undo and the boxes overlapped 6 px at 390. Squeezing one side cannot give both their pixels (the room is 43.8 px for 44), so below 480 px the pill takes the room itself (`margin-block: 18px 9px` in `ChangeBar.svelte`). Red first at 390 (box overlap) plus a real tap 3 px above the chip pill's bottom edge; 36 Document chip/pill/keyboard tests still pass. Screenshot `document-390-chip-and-pill-after.png` (looked at: pills clear of the chips, not airy).
- 4b menus: conversation menu, move-to-project submenu (was 30 px) and project menu rows `max-md:min-h-[44px]`; `phone-polish.spec.ts` at 360/390 touch (rows >= 44 px, words still one line; FB-9's old "one line" check by height now counts lines). Screenshot `conversation-menu-360-hu-after.png` (looked at).

## 5. The working strip (owner's call on F6) — 30e4544eb

`artifacts.document.working` is the line while nothing says what Alfy will do (the read phase): HU "Alfy átnézi a dokumentumot…" (was "Alfy dolgozik a dokumentumon…"), EN "Alfy is going through the document…". With the edit call's summary it still says "Alfy dolgozik a dokumentumon: {summary}" (true then). Words only, EN + HU together; unit tests red-then-green (AlfyWriting, DocumentBody) and the three `artifact-document-friction.spec.ts` assertions follow (that spec is in the gate run below).

## Gates (`scripts/gates.sh agent`)

First run (`fx2-gate/`, at `4fdb971d5`): migrations/biome/fallow/build/chunks ok (unused-css 32, aria 2; editor closure 70.9 kB; fallow 124 / 4 circular, 0 new); check 6 errors (a type guard and the test helper's option type: fixed), vitest 7 failures (6 = the chat page runtime test, an effect reading `answer.tour` of a stubbed answer: fixed; 1 = `mineru/client.contract.test.ts`, a timing assertion under load, passes alone), playwright 196 passed + 2 failed (two arrival tests counted the visit's ask as well as the reload's: fixed). Specs in the run: artifact-tours (+arrival, empty-states, api, admin), artifact-panel-history, artifact-history, knowledge, artifact-document-review-bar, phone-polish, mobile-design, artifact-document-friction, artifact-document-touch-targets, plus the `@smoke` set.
Second run after the fixes (`fx2-gate2/summary.txt`, at `9e9fdb822`): **ALL GATES PASSED**, 5m05s at load 11-21 (other agents running):
```
check      ok   0 errors, 17 warnings (baseline) in 8,483 files
biome      ok   2,654 files
migrations ok
vitest     ok   1,070 files passed, 18,185 tests passed, 2 skipped
build      ok   unused-css=32 aria=2 (baseline 32/2)
chunks     ok   editor closure 70.9 kB gzip; chat route first paint 557,383 B in 84 chunks (information only)
fallow     ok   total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright ok   198 passed, 0 skipped, 0 failed, 0 flaky (production build, 4 workers, 1m45s)
```

## Deviations, concerns, hand-off

- The panel now asks for a kind's tour as soon as the chat has an item of that kind (one small GET per kind per page load, none for File or incognito). The spec text said "asks once when an item opens"; the unit test "does not ask while the panel is closed or showing its list" became "asks for the kinds of the chat's items as soon as the chat has them". It is what makes "the room is made before the body paints" true for a fresh reader's first open.
- The Document's own tab strip appears when its editor is ready and moves the toolbar down 28 px (`{#if editorReady}<Tabs/>` in `DocumentBody.svelte`): pre-existing, independent of the card, not touched.
- On a phone the in-flow card takes 214 of 844 px until Skip; nothing is hidden. The inline pill's margins add ~27 px under each pending change on a phone.
- Hand-off: `peekArtifactTour`, `tour/tour-card.ts` (`loadTourCard`, `loadedTourCard`), `ArtifactTour`'s `entrance`, `DocumentWorkspace`'s `historyWanted` / `onHistoryOpenChange`, `PanelLayer.history`.
