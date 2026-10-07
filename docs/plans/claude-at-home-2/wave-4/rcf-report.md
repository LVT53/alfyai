# RC-F · the final re-check before the last deploy (report only)

Checker: `claude-sonnet-5-5` · head `a5f94f57` (feat/artifacts, worktree `rc-f`, detached) · production build on port 5520 · 2026-10-07.

**Verdict: not ready.** Critical 0 · Important 4 · Minor 10. Every RV-F finding in scope is closed; the four Important items are new, each small, each found by walking the owner's own flows (the Canvas round, 1100 docked, the Knowledge page).

Gates on the built tree, run by me:

- `npm run build`: exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline).
- `npm run check:artifact-chunks`: passes. Editor first paint 70.7 kB gzip (ceiling 72,704 B). **Chat route 543,315 B, +1,826 over the 541,489 baseline, 222 B of the 2,048 left** (RV-F M-4 stays open; the next string added to the chat route nearly spends it).
- `npm run check`: 0 errors, 17 warnings. `npx vitest run`: 17,270 passed, 2 skipped, 0 failed.
- Console, page errors, failed requests and the server log over the project page, Files dialog, chat panel (Document, App, Canvas), Knowledge, Settings and home: none (walk `errors.walk.ts`).
- Fallow and the full Playwright suite were not re-run (the agents' and orchestrator's runs stand).

## 1. RV-F findings: each one closed, with the evidence

| RV-F | State | Evidence (what I ran, on the production build) |
|---|---|---|
| I-1 stale guard vs a coalesced reader save | **Closed** | `canvas-stale-read.test.ts` (8 tests through the real `createNormalChatTools` → `read_artifact` / `edit_artifact`, the reader's save made with `coalesceUserEdits: true`), `canvas-stale-read-cutoff.test.ts` and `canvas-handlers.test.ts`: 64 passed. The only callers of the two runners are `normal-chat-tools/index.ts:1816, 1893`, which hand over the per-turn `knownBoards` (`:710`). RV-F's own probe, replayed unchanged, still overwrites: it calls the runners directly with only the version id, i.e. the fallback, which no app path takes. Not a defect. |
| I-2 Tab and Escape with the panel over the Files dialog | **Closed** | Real keys (`dialogs.walk.ts` D1.2, D1.4). Document: Tab x9 from the title cycles Fül hozzáadása, Félkövér, editor, Megjegyzések, Letöltés, Bezárás and wraps, every stop in the panel and on top. Canvas: Tab x7 stays in the panel (tool buttons, then the board). Escape in the editor closes the panel only, focus goes to the row ("Hétvégi tábla megnyitása"); the second Escape closes the dialog, focus goes to the "3 elem" chip. |
| I-3 tours cache across an in-tab sign-out/sign-in | **Closed** | RV-F's own walk (`third.walk.ts`, retargeted): A finishes the Canvas tour in the dialog, signs out, B signs in on the same tab, opens his first Canvas from the dialog. Before: no card, 0 requests. Now: **card shown, 1 new tour GET**. |
| M-1 deleted item's Sources row | **Closed** | `closure.walk.ts` 1.4/1.5. After a Knowledge delete the card says "Ez a dokumentum törölve lett" + "Újragenerálás"; the Sources row is plain text with the same sentence, 0 buttons and 0 links in the group (screenshot 02). After Regenerate the card and the row are live again (row is a button). |
| M-2 a fork's copied Sources | **Closed** | 1.6: the fork's group heading is "AZ EREDETI BESZÉLGETÉSBEN KÉSZÜLT", "Ebben a beszélgetésben készült" count 0 (screenshot 03). |
| M-3 shipped-kinds guard | **Closed** | `SHIPPED_ARTIFACT_KINDS` / `isShippedArtifactKind` in `shared/artifacts/kinds.ts:35-54`; used by `chat-turn/finalize-steps.ts:268` and `MessageEvidenceDetails.svelte:242`; the tours list is checked against it (`shared/artifacts/tours.ts:35`). |
| M-6 Files dialog footer | **Closed** | D1.1: three made items, footer reads "3 elem", 0 unlink buttons. The note exists only with a removable row (`ProjectFilesDialog.svelte:133-154`). |
| M-7 meta line splits "1 fül" | **Closed** | 1.1/1.2: "Dokumentum · 1 fül · v1" is one line (`factsLines` 1, no clipping) at 1440 undocked and docked, 1280 docked, 1100 docked; the action never overlaps it. At 1100 docked the card is 257 px wide, the "Megnyitva a panelen" action sits on its own row (screenshot 01). |
| M-11 crumb with no list | **Closed** | D1.2: from the Files dialog and from Knowledge the panel header has no "Back to this chat" crumb (screenshot 04); in the chat it does ("EZ A BESZÉLGETÉS 1", screenshots 02, 07). |
| M-8 (owner: ruling 75), real model | **Holds** | See section 3 (Hungarian e-mail). |

Also confirmed from FX-B2: a press on the 20 px ring closes only the panel (D1.3), browser Back with panel and dialog open ends on `/` in the same document with the scroll lock released (D1.5), and in the dialog a press inside the Download popover keeps popover, panel and dialog open and Escape closes only the popover.

## 2. Important (4)

### IMP-1 · A freshly made board with a flowchart is not fitted: the flowchart runs off the bottom and 180 px of dead space sits on top

- **Where:** `src/lib/components/artifacts/canvas/CanvasBoard.svelte:1222` (`fitView={fitOnOpen}`, the library's one fit at node initialisation) and `:1128-1145` (the only refit is `$effect` on `[boardWidth, boardHeight]`, so a block that grows after render never triggers `fitBoard`).
- **Repro, real model (steps 1-2), and without a model (step 3):**
  1. Ask Alfy (HU): a board with a Szombat and a Vasárnap frame, two notes each, a bar chart of costs and a flowchart from the airport to the hotel.
  2. Open the card. 1440: pane 121..901, content 294..1070 (zoom 94%); screenshot 07. 1280 dark: pane 121..801, content 213..1101; screenshot 15.
  3. `fit.walk.ts`: a board written the way Alfy writes it (the flowchart node has a width and no height) at 1440, 1280 and 1100 docked. The Mermaid block measures 441x477 / 386x418 / 324x352 after render, but the camera is the same at 300 ms, 1.5 s and 4 s: content bottom 1042 / 926 / 853 against pane bottoms 901 / 801 / 801, content top 299 / 275 / 305 against pane top 121.
  4. Press "Illesztés a nézetbe": everything fits (bottom 788 / 689 / 689).
- **Why it matters:** this is the owner's headline flow, and the first picture of the board has a cut-off flowchart and an empty band on top. After Alfy's later edits the camera also stays put (screenshot 08: the new pie chart sits half below the pane).
- **Fix direction:** re-fit while `followsPane(camera, fitted, touched)` holds when a block's measured size changes (not only the pane's), or fit after the lazy blocks have reported their size; a Mermaid block could also be given an estimated height by `mermaid-size.ts` for the first fit.

### IMP-2 · The Knowledge page: a press inside the panel's Download popover closes the whole panel (FX-B2's known open item)

- **Where:** `src/lib/components/document-workspace/DocumentWorkspace.svelte:1494-1515` (`handleDocumentPointerdown`). The popover is painted outside the panel, and the guard at `:1504` (`overDialog && !isTopmostDialog`) only covers the over-a-dialog host. FX-B2 proposed `if (hasOpenDialog()) return;` here.
- **Repro:** `/knowledge` → Dokumentumok → click a Document row (panel opens) → "Letöltés" → press anywhere in the popover: popover and panel close (D3.1). A real click on the "Markdown" option does the same and starts nothing (D3.2). The chat's expanded panel and the Files dialog host keep the panel open on the same presses (D2.1, D3.3), so only the Knowledge host is affected.
- **Why it matters:** the owner asked for exactly this check; Download by mouse cannot work on that page.

### IMP-3 · Editing a flowchart (or any tall block) low on the board: Save and Cancel are below the pane, and the palette covers the form

- **Where:** the in-block edit form of the lazy `block-edit` entry. CV-B2 fixed the phone (a pinned sheet) and recorded "on desktop Save can still sit under the board toolbar"; it is worse than under the toolbar.
- **Repro:** HU, 1440 docked, open a board, Insert → "Folyamatábra" (from this chat) after a few other blocks so it lands in the lower half, select it (head), toolbar Edit. The Save button is at y 966 on a 900 px viewport, `elementFromPoint` there returns null, Playwright's click times out (E1.4); the form's source field is half hidden behind the palette (screenshot 12). Tab, Tab, Enter does save (the picture updates to "Indulás"), so it is reachable by keyboard only.
- **Fix direction:** pan the board to reveal the form when it opens (TR-D4's reveal is the precedent), or use the same pinned sheet as on the phone at every width.

### IMP-4 · At 1100 docked the board's palette covers the zoom-out button

- **Where:** `canvas/CanvasToolbar.svelte:304-314` (centred, 517 px wide, `max-width: calc(100% - 24px)`) against `canvas/ZoomChip.svelte` (bottom right, 140 px wide). The pane is 713 px wide at 1100 docked, so they overlap by 54 px; at 1280 (pane 836) they do not.
- **Repro:** HU, 1100x800, open any board with the panel docked (`floats.walk.ts`): `elementFromPoint` at the centre of "Kicsinyítés" returns the palette's "Alfy megkérdezése" (not clickable); "Nagyítás" and "Illesztés a nézetbe" are fine. Screenshot 16 shows the zoom reading "0%" with its minus gone. The zoom chip already steps aside for a selected block (RC-3 N3) but not for the palette.

## 3. What I walked, and what held

Production build, scratch DB, Playwright with real mouse, keyboard, touch and wheel input (scripts in `scratchpad/w4/rcf/walk/*.walk.ts`, logs `scratchpad/w4/rcf/*-log.txt`), Hungarian UI, 1440 / 1280 / 1100 docked and 390, light and dark. The real model (`qwen3-6-27b`) only through `ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -L 30406:192.168.1.96:30000 alfyroot` started in the same command as each run (`with-tunnel.sh`); `~/.config/opencode/opencode.json` never read. 11 bounded prompts in all (3 for the board, 3 + 3 for the language and dark-board runs, 2 smoke); turns took 15-40 s.

**Canvas (real model).** P1 in section 2 made a board of 8 blocks: two frames with two notes each, a bar chart, and a Mermaid flowchart that is a real diagram (SVG with 5 nodes and 4 links; in dark mode a diamond decision node). No overlap, nothing sticking out of a frame, no stray text fragment between notes (DOM overlap and containment check plus screenshots 07, 08, 15). P2, "add a note about the Schönbrunn trip next to the Belvedere note": the note landed in the same frame, same row, 15 px to its right, no overlap; Alfy widened the frame and moved the Sunday frame and the chart to make room ("4 módosítás vár rád"). P3, "put a pie chart in the Szombat frame": the chart is inside the frame (frame grew to 440x660, the flowchart moved below), no overlap, no peeking; review bar "Alfy 6 blokkot módosított" with Megtartom / Visszavonom (screenshot 08).

**Editing what was inserted, by mouse (HU).** Note (double-click, type, click away: stored), checklist (Edit title "Bécsi teendők" stored; item added by keyboard and ticked by click: stored), chart from the chat (Edit data, 30 to 45: stored, form closed), flowchart (see IMP-3), map (title edited: "Reptér – szálloda" shown), File (a click selects and offers Open; a double click opens it in the panel, screenshot 10). On a phone by touch: Insert, select by tap, Edit opens the sheet with Save and Cancel pinned inside the viewport (y 780..828 of 844, 48 px high, 16 px fields), the change is stored (screenshot 13); a File block taps to select and its toolbar Open opens it.

**Selection toolbar near the top.** A note dragged to 27 px under the pane's top: the toolbar and the "Alfy megkérdezése / Megjegyzés" pill both flip below it and stay inside the pane (screenshot 11).

**Touchpad.** Wheel dY=120 pans y by -120, dX=90 pans x by -90 (1:1); Ctrl+wheel zooms about the pointer (1.0 to 1.12), Meta+wheel zooms back out to exactly the earlier camera; a wheel over a note being typed in pans the board (y -120 to -220) and the note stays in edit. `overscroll-behavior` is `none` on the board and the body, the page does not scroll. **Not testable here:** an OS back-swipe and Safari's pinch events (headless Chromium).

**Phone keyboard over a low note.** Six-note board, note 6 (bottom row) double-tapped, viewport shortened by 336 px: zoom unchanged (0.7409), one pan (y 173 to -72), the note ends inside the visible pane (y 379..426 of 124..508), typing works, the camera is unchanged when the keyboard closes (screenshot 13b). The selection pill and the node toolbar overlap by 4 px there (see MIN-1).

**Chat.** Card at 1440/1280/1100 docked: one-line facts, action on its own row when narrow, no overlap (section 1). Sources "Made in this chat" row opens the Document; the deleted and forked states (section 1). Hungarian chat with the real model: the title is generated in Hungarian ("Napelem működése és otthoni megítélése", screenshot 14), the follow-up chips are instructions in Hungarian ("Számold ki a megtérülést 4 főre", "Készíts listát a pályázati lehetőségekről"). "Írj egy e-mailt angolul a kollégámnak a csütörtöki határidő elhalasztásáról.": the commentary, the placeholders note, the chips ("Írj egy formálisabb, főnöknek szóló változatot", "Töltsd ki a hiányzó adatokat a fő e-mailben") and the thought-step line stay Hungarian, only the e-mail (Subject / Hi [Name] ...) is English; the title does not change. Ruling 75 holds. The chips are visible only while the pointer is over the last message on desktop (opacity 0 at rest) and always on a phone; that is the existing design.

**Panel and dialogs.** Section 1 and IMP-2. In the Files dialog and on the Knowledge page the Document header has no version pill (see MIN-3), so the Versions popover is reachable only in the chat (its popover and the Download popover keep the expanded panel open there).

**Tours (fresh Hungarian reader).** First open of Document, App and Canvas each shows the card with its Hungarian text (1. lépés / 3), focus lands on the card, Tovább, Tovább, Értem writes `completed:2` for each; reopening shows no card; the list row menu's "Így működik ez a típus" replays the card labelled "Újranézés" and writes nothing (3 rows before and after); an incognito chat makes zero tour requests and shows no card and no replay link ("Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá."). On a phone in dark mode the card fits (366 x 214 at x 12), the buttons are 164 x 48 (screenshot 06).

Environment notes (not product defects): no Docker or MinerU on this machine, so every page shows the "Néhány képesség korlátozottan működik" banner and file exports (the Download options) cannot complete; I could not see a real download.

## 4. Minor (10)

- **MIN-1 · Phone, keyboard up: the selection pill and the node toolbar overlap by 4 px** (pill y 267..319, toolbar y 315..367; screenshot 13b). RV-F M-5, carried.
- **MIN-2 · The opened-documents rail lists the Canvas as "Board v2 · Tudásbázis · UNSUPPORTED"** after a File is opened from a board (screenshot 10): raw English type label and a "knowledge base" origin on a board.
- **MIN-3 · No version pill, so no Versions popover, for a Document opened from a project's Files dialog or from Knowledge** (header: "Bécsi jegyzetek / Dokumentum", no "v1", no provenance line; the chat header has both). The version number is carried by the chat's card list only.
- **MIN-4 · After a ring press, focus is on a covered "Bezárás" button, not on the row that opened the panel** (`active()` reports `visibleOnTop=false`). FX-B2's known leftover.
- **MIN-5 · Alfy's replies repeat internal placement numbers**: "kördiagram (360x397)", "folyamatábrát lejjebb (y: 740) tettem", "440x660-ra nőtt" (screenshot 08). The edit answer lists what the app placed and the model parrots it.
- **MIN-6 · "Add a note next to Y" moved three other blocks** (widened the frame, moved the Sunday frame and the chart); the result is tidy, but the review bar then asks for four decisions for one note.
- **MIN-7 · Phone header meta line wraps with a dangling separator**: "Dokumentum · v1 ⌄ ·" then "Te és Alfy · szerkesztve épp most" on the next line (screenshot 06).
- **MIN-8 · A restored panel for a deleted Document** (after deleting it on Knowledge and coming back) shows "Ez a dokumentum nem érhető el." under a live-looking header: v1 pill, download, delete and a comments column (screenshot 02).
- **MIN-9 · Hungarian naming in the Insert menu:** a chart is "Diagram", a flowchart is "Ábra" (its row is named by its title), so a request for a "diagram" and the menu use the word for different things. Wording only.
- **MIN-10 · RV-F M-4 (size budget) has 222 B of headroom** on the chat route; M-9 and M-10 are untouched this round (as planned).

## 5. Screenshots (`scratchpad/w4/shots/rcf/`, 15, each looked at)

| File | What it shows |
|---|---|
| `01-hu-1100-docked-card` | Chat at 1100 docked: the card with one-line facts, "Átnézve" pill and action on their own rows (M-7, FX-D). |
| `02-hu-deleted-card-and-sources-row` | Deleted Document card with Újragenerálás; the restored panel behind it (MIN-8). |
| `03-hu-fork-sources` | A fork: "Az eredeti beszélgetésben készült" group (M-2). |
| `04-hu-files-dialog-with-panel` | The expanded Document panel over the Files dialog: no crumb (M-11), no version pill (MIN-3). |
| `06-hu-phone-dark-document-tour` | 390 dark Document tour card (MIN-7 in the header). |
| `07-hu-live-board-after-first-ask` | Alfy's first board at 1440 docked: frames, chart, real flowchart; the flowchart cut off, the empty band on top (IMP-1). |
| `08-hu-live-board-after-note-and-chart` | After "note next to Y" and "chart in the Saturday frame": review bar, the pie chart in the frame, the jargon in the reply (MIN-5). |
| `10-hu-board-all-kinds-and-file-open` | The File opened from a board; the rail with "UNSUPPORTED" (MIN-2). |
| `11-hu-toolbar-near-top` | Selection toolbar and pill flipped below a note near the pane's top. |
| `12-hu-flowchart-edit-save-covered` | The flowchart's edit form cut by the pane, the palette over it (IMP-3). |
| `13-hu-phone-chart-edit-sheet` | Phone edit sheet with Save and Cancel pinned. |
| `13b-hu-phone-keyboard-low-note` | Phone with the keyboard up over note 6 (MIN-1). |
| `14-hu-email-in-english-chips-title` | Hungarian chat, English e-mail in a quote, Hungarian title. |
| `15-hu-dark-1280-live-board` | Alfy's board in dark mode at 1280 docked; the flowchart cut off (IMP-1). |
| `16-hu-1100-docked-board-palette-meets-zoom` | 1100 docked board: the palette over the zoom chip (IMP-4). |

## 6. Method and files

- Server: `node build` on 127.0.0.1:5520, scratch DB `scratchpad/w4/rcf/rcf.db`; first the e2e configuration (`PLAYWRIGHT_TEST=1`, fake provider harness) for the seeded and fake-provider walks, then restarted without `PLAYWRIGHT_TEST` with MODEL_1, MODEL_2 and TITLE_GEN pointed at the tunnel for the live walks (titles and chips need that). Stopped at the end; no tunnel or test process left running. No tracked file touched (`git status` clean).
- Walks: `closure`, `dialogs`, `tours`, `canvas-live`, `canvas-edit`, `canvas-phone`, `lang-live`, `fit`, `floats`, `chips`, `errors` (+ RV-F's `second` and `third` retargeted) under `scratchpad/w4/rcf/walk/`; helpers `run-walk.sh`, `with-tunnel.sh`, `serve.sh`, `serve-live.sh`, `gates.sh`.
- Two false starts of my own, noted so nobody repeats them: a conversation created before the provider is selected keeps the old model (the first message went to the default model), and the live server must use the SESSION_SECRET the seeded providers were encrypted with.
