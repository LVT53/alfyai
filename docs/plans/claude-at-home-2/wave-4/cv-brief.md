# The owner's Canvas round and the language rule (2026-10-07) · four agents

The owner, after M2: (1) "Are you sure you fixed Canvas so that the model can actually render the same charts from chat?"
— a live probe on ai.dev (`~/.cache/alfyai-artifacts/live-checks/probe-charts.mjs`) showed Chart.js charts land (bar, radar,
pie, line), but a requested flowchart became three sticky notes: ruling 64 lets Alfy add only frame, sticky, text,
checklist and chart; (2) "A bit of work is also needed on where AlfyAI places new blocks when asked to"; (3) "a bit of work
on touchpad friendliness for laptops"; (4) "I can't edit pieces that were already added, in any way or shape. This goes for
all Insert options"; (5) "Írj egy e-mailt angolul…" should keep the conversation in Hungarian (RV-F M-8).

Common to all four: `wave-4/common.md` (+ the Wave 3 rules); AGENTS.md's Canvas subsection; red first with **real input**
(pointer, keyboard, touch, and for CV-B/CV-C the wheel as a laptop touchpad sends it); full gates once at the end with
every artifact suite; **do not move `--chat-baseline` or the editor's ceiling** — measure your growth against your base and
report both numbers. Reports to `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/<id>-report.md`,
screenshots beside them in `…/w4/shots/<id>/` (look at each one).

## CV-A · Alfy draws the chat's diagrams on a board, and puts what it adds where a person would

Worktree `art-cva`, branch `feat/canvas-alfy-blocks` (from `feat/artifacts` after FX-A), port **5430**, tunnel **30404**.
**Ruling 74 (orchestrator, on the owner's request):** a `diagram` block joins the kinds Alfy may add (ruling 64 amended):
Alfy writes the Mermaid source exactly as it does in a chat reply, the board draws it with the chat's own `Mermaid.svelte`
(the same security settings the chat uses: check them), the block's schema is the one the reader's Insert already uses, and
`update_node` may change a diagram's source. Ruling 62 holds (advertised = parsed; a worked example parsed by a test);
the tool texts in EN and HU; the catalogue ceilings moved and recorded (ruling 23). **Placement:** when Alfy adds blocks to
an existing board they land where a person would put them — beside or under what they extend, inside the frame they
belong to, in free space (never on top of another block), near what the reader is looking at. Prefer a deterministic placer
in the shared vocabulary (`board-ops.ts`, used by create, edit and `@Alfy`) for a block whose place the model leaves out or
gives relative to another block (`near`, `in`), with the model's absolute place honoured when it is free and nudged when it
is not. Measure on what is drawn: the canvas eval before and after, plus new "add to an existing board" cases in both
languages ("add a note about X next to Y", "put a chart in the Saturday frame", "add a flowchart of …"), live through the
tunnel. Files: `shared/artifacts/canvas-blocks.ts`, `board-ops.ts`, `services/artifacts/ops.ts` if the placer needs the
envelope, `normal-chat-tools/artifact-tools/{create,edit,canvas-model,kind-prose}.ts`, the canvas eval suite.

## CV-B · Everything a person inserts on a board can be changed afterwards

Worktree `art-cvb`, branch `fix/canvas-edit-inserted` (from `feat/artifacts`), port **5440**. **Reproduce first, on a
production build, before any fix:** for every option the Insert menu offers (note, text, checklist, frame, chart, and each
"From this chat" kind: diagram, chart, file, App, map, photo, web), with a mouse and with a laptop touchpad's input: select
it, move it, resize it, change its look, edit its content where it has content of its own, delete it, undo. Write the
table of what works and what fails, with the cause, into your report first. Then fix what is broken, red first. Where a
kind has no way at all to change what it shows (a chart's numbers or type, a diagram's source), give the reader the
smallest editor that fits the design — editing the block's own source in place, validated by the same schema, one step of
the board's undo — and for the app-owned kinds (file, App, map, photo, web) the change a person expects (a title, a
caption, Refresh); say what you chose and why. Files: `canvas/nodes/**`, `canvas/_lib/{block-meta,block-registry}.ts`,
`NodeShell.svelte`, `CanvasBoard.svelte` (interaction only: **not** the wheel and pinch props, which are CV-C's),
`i18n/artifacts.ts` (your own block).

## CV-C · A laptop's touchpad drives the board like Figma

Worktree `art-cvc`, branch `fix/canvas-touchpad` (from `feat/artifacts`), port **5450**. The rule: a two-finger scroll pans
(both axes); a pinch (the browser's Ctrl+wheel) zooms around the pointer, smoothly for a touchpad's small steps; a mouse
wheel pans too and Ctrl/⌘+wheel zooms; Shift+wheel pans across; over the board the page never scrolls and the browser's
back-swipe never fires (`overscroll-behavior`); Space+drag, the Hand tool, the middle button and touch screens unchanged; a
scroll inside a block that scrolls (a long checklist, a web block) scrolls that block. Red first with real wheel events
(`page.mouse.wheel` with deltaX/deltaY, with and without Control) on a board. Files: `CanvasBoard.svelte` (the flow's
scroll/zoom props and any wheel handling), a new e2e spec; nothing CV-B touches.

## LANG-2 · A request for content in another language keeps the conversation's language (RV-F M-8)

Worktree `art-lang2`, branch `fix/content-language` (from `feat/artifacts`), port **5460**, tunnel **30405**. The owner:
"Írj egy e-mailt angolul a kollégámnak…" keeps the reply, the chips and the status line in Hungarian and writes only the
email in English; "Válaszolj angolul" / "answer in English" / "in English please" still flips the reply; the mirror holds
for English turns asking for Hungarian content. Files: `services/language.ts` (`detectExplicitLanguageRequest` and its
callers), `normal-chat-context.ts` only if the model needs one line saying the content's language differs from the reply's
(AGENTS.md: guidance lives where it lives today), tests both ways in both languages, and CHP's live trap prompts re-run with
new content-language cases (reuse `…/w4/chp-probe/`).
