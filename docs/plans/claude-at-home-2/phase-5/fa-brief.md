# FA — the friction audit: walk it the way the owner does and say what feels clanky (report only)

The owner walked all of Feature 2 on ai.dev and said: "To me it seems fine. Although I still think it's a little clanky."
They cannot phrase it yet. Your job is to find it for them: walk the main flows the way the owner does and list **every
jump, overlap, wait, extra step and surprise**, ranked, with screenshots, so the owner can react ("fix F3, F7, F12").
**You fix nothing.** Correctness bugs you meet go in the list too, marked as such. Read
`docs/plans/claude-at-home-2/phase-5/common.md` and the two files it names first.

- Worktree: `.claude/worktrees/art-fa` (detached at `feat/artifacts`, which equals what ai.dev runs plus docs;
  `node_modules` linked, e2e DB prepared). Base port **5480**. Report: `<scratchpad>/p5/fa-report.md`; screenshots
  `<scratchpad>/p5/fa-shots/` (at most 40, each looked at; a short frame sequence counts as one finding's evidence).
- Versioning is being redesigned separately (VD). Note its friction briefly but spend your time elsewhere.

## How to walk

- **A production build** on your port with a scratch database (`npm run build`, then `node build` with the env the e2e
  config gives the server; or the e2e web server if that is quicker to get right), a fresh user who has seen no tour plus
  the seeded admin. **Hungarian UI** (the owner's), English only for a cross-check.
- **The real model** for every flow a chat turn drives (making and editing a Document, an App, a Canvas, a file; Alfy's
  edits; `@Alfy` replies), so the waits are the owner's: a tunnel on local port **30407**
  (`ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -L 30407:192.168.1.96:30000 alfyroot`,
  model `qwen3-6-27b`, in the same command as its user). Bounded: about 25 real turns in total. The e2e fake provider
  where a flow needs to be repeated exactly.
- **Reuse RC-F's walk kit** instead of building one: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/rcf/`
  (`walk/*.walk.ts` with `common.ts` and `playwright.walk.config.mts`, `run-walk.sh`, `serve.sh` for the fake-provider
  server, `serve-live.sh` + `env-live.sh` for the real-model server, `with-tunnel.sh`). Copy it to
  `<scratchpad>/p5/fa-kit/` and change its paths and ports to yours; never edit the original. Its method notes are in
  `docs/plans/claude-at-home-2/wave-4/rcf-report.md` §6, including two traps: a conversation created before the provider
  is selected keeps the old model, and the live server must use the `SESSION_SECRET` the seeded providers were encrypted
  with.
- **Widths and themes:** 1440, 1280 and 1100 with the panel docked, and 390 (phone emulation with touch); light and dark.
  Not every flow at every width: walk each flow once at 1440 and once at 390, and the panel-heavy ones at 1100 docked.
- **Real input only** (`page.mouse`, `page.keyboard`, `locator.click()`, touch via `page.touchscreen` / CDP
  `Input.dispatchTouchEvent`, wheel and Ctrl+wheel for a touchpad), as a person would: no `page.evaluate` to drive the UI.
- **Measure the waits** you meet: from the action to the first visible feedback, and to "done" (a send to the card
  appearing, a card's Open to the body painted, Keep to the pill gone, an Insert to the block placed, a phone sheet
  opening). Anything over ~300 ms with nothing on screen, or a blank flash, is a finding.

## The flows (the owner's main ones)

1. Landing → first message → the chat opens; the follow-up chips; the title.
2. **Document:** ask for one in a chat → the card → open the panel → read → type → ask Alfy for a change in the chat →
   the change pill and review bar (Keep, Undo) → a comment and an `@Alfy` reply → download.
3. **App:** ask for a small app → its preview → ask for a change → regenerate.
4. **Canvas:** ask for a board with notes, a chart and a flowchart → insert one of each block kind from the menu → edit
   what you inserted → move, resize, multi-select, frames → ask Alfy to add something next to a block → review → comments
   → export a picture → a touchpad (two-finger pan, pinch, Ctrl+wheel) → the same board on a phone (tap, drag, the
   keyboard over a low note).
5. **File:** ask for a PDF and a spreadsheet → the card → preview → download.
6. **The panel:** "Made in this chat" list, switching items, docked vs expanded, closing and reopening, a reload with the
   panel open, the 1100 docked chat column beside it, Escape and outside clicks with popovers and sheets open.
7. **The tours:** the first open of each kind for the fresh user; replay from the list menu and the empty state.
8. **Knowledge:** the Documents tab and its chips, open an item into the panel, global search → open a result.
9. **Projects:** the project page's bundle line and cards, the Files dialog → open an item → the panel over the dialog.
10. **Sources:** "Made in this chat" rows, a deleted item's row, Delete then Regenerate.
11. **Phone end to end:** a chat, the panel as a sheet, the Document toolbar and selection bubble, a Canvas block edit.

## What counts as friction (look for these)

A layout jump (something moves after it appeared, including a late card, a re-fit, a font swap); an overlap (two layers on
each other, something clipped, a toolbar or pill over content, a popover off-screen); a wait with no feedback; an extra
step (a second click, a confirm that adds nothing, having to scroll to reach a button that should be in view); a surprise
(the focus jumps, Escape closes the wrong layer, a click does something else than its label says, an undo undoes the
wrong thing, a Hungarian string that reads oddly or wraps badly); inconsistency (the same thing done three ways in three
places); a dead end (no way back, no way to find something you made).

## Report

`fa-report.md`: a ranked table first — **ID (F1…), one-line finding, flow, width/theme/input, kind (jump / overlap /
wait / extra step / surprise / inconsistency / dead end / bug), how often the owner meets it (every time / often /
sometimes / rarely), how bad it feels (1–3), screenshot** — ranked by frequency × badness, the top 15 marked; then one
short paragraph per finding with exact steps to reproduce, the measured wait where it applies, and the likely place in
the code if you know it (file:line), without proposing a fix longer than a line. Then the patterns you see across
findings (for example "everything that floats over a board is placed by a different rule"), and what you could not walk.
Final reply at most 12 lines: status, **your model ID**, the report path, the five findings you would fix first.
