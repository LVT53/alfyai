# FX-4 report: the release gate green after the friction build (fix round, branch `fix/round-integration`)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fx4`, from `feat/artifacts` at `5fa7e80f9` (the merged tree that failed).
Commits: `5fa7e80f9..d2feeb158` (8). The release gate summary is in "Gates" at the end of this file.

The failing run (`gates-devint-m5`) listed 12 failures in its summary; its Playwright log has **13**: the summary prints at most 12 lines.
The 13th is `search-modal.spec.ts:86`. All 13 are handled below.

## Result per failure

| # | Failure | Product or test? | Cause | Fix (commit) |
|---|---|---|---|---|
| 1-4 | `artifact-chat-card` :217, :337, :397, :553 (all wait 30 s for "Made the document.") | **fixture** (the fake provider) | The app sends ONE user message, a context bundle whose Retrieved Evidence holds the user's other finished tasks with their request text. On the release gate's slot 2, `artifact-card-arrival` (FB-7's late-card spec) ran just before `artifact-chat-card`; its request text ("...then make the document late.") was in the next spec's bundle, and the fake provider's late-card scenario (FB-7) read its marker anywhere in the request body and, ahead of the create scenario in the dispatch order, answered every create turn with a Hungarian late card ("Hetvegi terv", "Elkeszult a dokumentum..."). Reproduced: arrival then chat-card on one worker fails the same four tests. The board's edit scenario had hit the same thing and reads `currentTurnText`; the late-card one did not. | `6e34ab8b9`: the late-card marker is read from the current turn's message only. Red first: a provider integration test whose bundle carries the late-card marker only as evidence and asks for a create turn got "Hetvegi terv" instead of "Weekend plan". The two specs back to back on one worker now pass (10/10). |
| 5-7 | `artifact-panel-motion` :607 (Document, App, Canvas) | **test** (FB-3's overlay expectation) | FB-3 laid the tour card over the item, so it asserted that nothing moves when the card arrives AND when it leaves. FX-2 (ruling 77) put the card back in the flow with its room made before the body paints; when the reader dismisses it the room closes with the card's own short transition. The item moved up 168.5 px (Document), 190.1 px (App), and the board re-fitted, over 28 frames in 267 ms, as designed. | `51929419d`: arrival is still asserted (nothing moves, nothing resized, the board fitted once). Leaving now asserts the new behaviour: the item goes up by exactly the room the card held (card height + its top margin, < 2 px off), in at least 4 frames, no frame taking more than half the way, within 600 ms; the board follows its pane and ends centred in the larger one. Numbers (production build): Document travel 168.53 px in 28 frames / 267 ms, largest step 21.6 px; App 190.1 / 29 / 267 / 21.6; Canvas 94.6 (half the pane's growth) / 24 / 216 / 12. |
| 8 | `artifact-panel-motion` :712 (phone: the text must not start below the middle while the card is up) | **product** | FX-2's in-flow card is 214 px of 844 on a phone, so the Document's text started at y 453 (475 at 360 px in Hungarian), below the middle, which ruling 77 does not allow. | `51929419d`: a compact phone form for the card. A 48 px picture at the corner (was 64), the words under it, and the step line and the buttons in ONE row (`.tour-bar`; it dissolves on a wide panel and the step line goes back above the words by `order`, so the desktop card is as it was). 160 px instead of 214: the text starts at y 398 at 390 px in English and 360 px in Hungarian (first slide). Skip and Next stay 48 px tall (finger rule). The spec now runs both widths/languages and checks the 44 px targets. Red first: both variants failed at 453 and 475 on the unfixed card (the first one also at 453 in the gate). |
| 9 | `artifact-canvas-blocks` :476 (`savedStatus` read "") | **test** | The editor's status says "Saved" for 2.5 s after a save (`SAVED_MS`) and then goes quiet. The board saved (the failure screenshot says "Edited by you . just now", both Apps on it); the save lands about a second after the second insert, in the middle of the Apps' round trips, so the assertion passed only when everything after it took less than the flash (page-time 3431 ms Saving, 4410 ms Saved, check at 4900 ms on a quiet machine). | `789b93c1a`: the test polls the stored board for two App blocks before it reloads (what it needs), not the flash. Red first, same signature as the gate (expected /Saved/, received ""): the old assertion after 3.5 s of the same work; the new one passes after the same 3.5 s. |
| 10 | `artifact-canvas-charts` :610 (60 s timeout in `openCanvasPanel`) | **test helper** (inferred; see below) | The helper took "the editor is not visible within 2 s" for "the panel is not open" and pressed the count button, which toggles (FB-3, F26): on a restored panel whose editor was late it closes what is coming back, after which neither the board nor the list can appear (the failure screenshot: panel closed). The helper's race had no timeout, and the "click at line 126" in the stack is its catch handler after the teardown closed the page. | `9aa76cc1c`: `openCanvasPanel` waits for hydration, asks the count button (`aria-pressed`, true as soon as the page holds the panel) and presses it only when the panel is not coming back; a panel restored on its list is opened from its first row; the wait for board or list is bounded at 20 s and fails with the button's state in the message. 66 canvas tests pass on it. **Not reproduced**: 60 repeats at five workers, API/chunk responses jittered up to 3.5 s, 28 CPU burners, all green on the old helper; the reading is the one that fits the page state and the stack. |
| 11 | `artifact-canvas-comments` :153 (pin 4 px off, limit 3) | **test** | The test read the block's box before the comment was written and compared the pin with it afterwards. FX-3's rail slide (RC-A #7, approved) moves a board the reader has the camera of over by what keeps in view what they were looking at once the column takes room: here the text block's right edge is 4 px inside the 24 px margin, so the board slides 4 px (translate 16 -> 12, probed). The pin goes with the board; the stale box did not. The test passed only when the pin was read early in the 250 ms glide. | `d9f5054d4`: read the camera once it has stopped (`settledCamera`) and hold the pin to the block's present corner; its sibling ("a click on empty board leaves a comment on that spot") had the same race and is held to where the spot is now by the camera's own shift. 57/57 (3 repeats of the file). |
| 12 | `chat-scroll-on-load` :334 (phone: chat switch, `waitForURL` timeout) | **test** (inferred; see below) | The failure's page snapshot has the target row's "Conversation options" button focused and its menu open: the press hit the three-dots button. The menu is at the viewport's left padding (x 12), where a menu for a trigger at the row's resting place would be at 174: it was placed while the trigger was still sliding in. So the press landed mid-slide (the drawer's transform and opacity transitions run 240 ms and its rows are pressable from the first frame). Nothing in this build touches the drawer's motion or its rows' layout on a phone. | `716a46291`: `waitForMotionToSettle` after opening the drawer, on both viewports (the helper's own comment names this hazard). **Not reproduced** (animations at 5 % speed, 8x CPU throttle, 24 burners at three workers: 40 clean runs). FB-5's panel-history entries are not involved: no panel exists in this test. |
| 13 | `search-modal` :86 ("appears centered in viewport": top 44, wanted > 50) | **test** | The modal is `fixed inset-0 flex items-center`, max-height 90dvh. With three recent conversations and three recent documents (what it lists at rest in that worker's database) it is 632 px of the 720 px window and its top is 44 px, which is where a centered modal that tall belongs; with a short list it is 417 px and the top is 151. Probed: 3 conversations with a message + 3 canvases -> top 44, height 632; empty database -> top 151. The spec's own screenshot tests already note that the height varies with ambient rows. | `03f2719b0`: the centering test types a query that matches nothing (the file's own convention for a deterministic state); a second test seeds the full list on purpose and asserts the property that matters (nearly window-tall, equal room above and below, left and right). |

Product regressions: **one** (#8, the tour card on a phone). Everything else was a test or fixture reading the wrong thing.

## What changed where

- `src/lib/components/artifacts/tour/ArtifactTour.svelte`: markup order (slide, then `.tour-bar` holding `.tour-meta` and `.tour-footer`), `display: contents` + `order: -1` on a wide panel, the compact phone CSS. AGENTS.md: one sentence in the Tours paragraph.
- `tests/mocks/ai-provider/openai-compatible-provider.ts` + `tests/integration/openai-compatible-provider.test.ts` (+1 test).
- `tests/e2e/`: `artifact-panel-motion` (the tour block), `artifact-canvas-comments`, `artifact-canvas-blocks`, `artifact-canvas-helpers` (`openCanvasPanel`), `chat-scroll-on-load`, `search-modal`.

## Screenshots (`fx4-shots/`, each looked at)

`tour-before-en-390-slide1.png` / `tour-after-en-390-slide1.png` (text at y 453 -> 398), `tour-before-hu-360-slide1.png` / `tour-after-hu-360-slide1.png` (475 -> 398), `tour-after-en-390-slide3.png` and `tour-after-hu-360-slide3.png` (the longest slide, with the hint and three buttons in one row: text at 421 and 461, i.e. below the middle on the last slides at 360 px / Hungarian), `tour-after-hu-desktop-slide3.png` (the desktop card is as it was).

Phone numbers by slide (text top, px of 844; before -> after): English 390: 453/453/502 -> 398/398/421; Hungarian 390: 453/475/502 -> 398/418/441; English 360: 453/453/502 -> 398/398/441; Hungarian 360: 475/496/523 -> 398/438/461. The first slide (what a reader meets on arrival, and what the spec holds) is above the middle in all four; the later slides are bounded by their copy and the last slide's one-line hint.

## Concerns

1. **Two fixes are inferences, not reproductions** (#10, #12): both rest on the failure artifacts and are the established remedy for the hazard; if either test fails again in the gate the next step is a trace, not another wait.
2. The compact card's later slides at 360 px / Hungarian still start below the middle (438-461): the copy needs five lines there. Dropping the hint on a phone would buy 22 px; I left it (content, not chrome).
3. The release gate's port: another session's agent gates (exfil-a/b1/b2, `--port 5300/5400/5500`) were running on this Mac when I started, one of them on 5400-5401; see the gate section for the port I used.

## Gates (`scripts/gates.sh release <out> --port 5410`, at `d2feeb158`; logs in `gates-fx4/`)

Port: **5410** (inside the 5400-5419 range, not 5400) because another session's agent gates (`exfil-a/b1/b2`, `--port 5300/5400/5500`, started 20:46) were running on this Mac and one held 5400-5401; the release gate waited for them to finish before it started, so the machine was not shared while it ran (load 7.5 at start, 10.1 at end).

```
check      exit=0 ok      49s  :: 0 errors, 17 warnings in 8492 files
biome      exit=0 ok       1s  :: Checked 2672 files in 1187ms. No fixes applied.
migrations exit=0 ok       0s  :: All schema tables have corresponding migrations.
vitest     exit=0 ok   10m18s  :: files 1075 passed | 1 skipped (1076); tests 18265 passed | 2 skipped (18267)
build      exit=0 ok      17s  :: unused-css=32 aria=2 (baseline 32/2)
chunks     exit=0 ok       0s  :: editor closure 71.0 kB gzip; chat route first paint 558949 B gzip in 84 chunks (information only)
fallow     exit=0 ok       6s  :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ok    9m09s  :: 1146 passed, 60 skipped, 0 failed, 0 flaky on 6 workers
total 10m36s; ALL GATES PASSED
```
(The failing run: `playwright 1131 passed, 60 skipped, 13 failed`; this one has 2 more tests than it, 1206 against 1204: the search modal's full-list test and the second phone width of the tour text test, in place of one.)

A second full run on the same commit (`gates-fx4b/`, started right after the first, load 10.1 at start, 8.5 at the end) to see whether the fixes hold and not only pass once:

```
check      exit=0 ok      37s  :: 0 errors, 17 warnings in 8492 files
biome      exit=0 ok       1s  :: Checked 2672 files in 1172ms. No fixes applied.
migrations exit=0 ok       0s  :: All schema tables have corresponding migrations.
vitest     exit=0 ok    7m29s  :: files 1075 passed | 1 skipped (1076); tests 18265 passed | 2 skipped (18267)
build      exit=0 ok      17s  :: unused-css=32 aria=2 (baseline 32/2)
chunks     exit=0 ok       0s  :: editor closure 71.0 kB gzip; chat route first paint 558957 B gzip in 84 chunks (information only)
fallow     exit=0 ok       6s  :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ok    8m45s  :: 1146 passed, 60 skipped, 0 failed, 0 flaky on 6 workers
total 9m02s; ALL GATES PASSED
```

The editor's first-paint closure is unchanged (71.0 kB gzip; no editor file was touched), Fallow adds nothing (the card change is CSS and markup; the helpers and fixtures are tests), the build's warnings are the baseline 32 + 2.

## Hand-off

- `ArtifactTour.svelte`: `.tour-bar` holds `.tour-meta` and `.tour-footer`; on a wide panel it is `display: contents` and `.tour-meta` has `order: -1`, so a change to the desktop card's order goes through those two rules; the phone form is the one media query at the bottom of the style block. The card is 160 px on a phone for the first slide.
- `artifact-canvas-helpers.ts` `openCanvasPanel`: waits for hydration and decides from the count button's `aria-pressed`; it throws after 20 s with the button's state in the message instead of hanging.
- The fake provider's scenario markers: a new scenario that is dispatched ahead of another one must read `currentTurnText(body)` (the board edit and the late card do), never `JSON.stringify(body)`: the bundle's evidence carries the user's other finished tasks with their request text. `bodyAsksForCreateArtifact`, `bodyAsksForEditArtifact` and `bodyAsksForStandingInstruction` still read the whole body; they have not bitten (they are dispatched late or share no words with the markers that run before them) but are the same hazard.
