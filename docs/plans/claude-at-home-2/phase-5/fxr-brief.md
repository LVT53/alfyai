# FX-R — the friction build's fix round (three agents: FX-1 chat, FX-2 layout and phone, FX-3 board and downloads)

RC-A walked every finding of the friction build (`phase-5/rca-report.md`: 22 fixed, 8 better, 0 worse, 10 new) and RV-B
(Opus) reviewed its riskiest code (`phase-5/rvb-report.md`: ready for `dev`, 4 Minors). This round fixes what they and
the build agents left open, so the owner's walk meets a finished thing. Read `phase-5/common.md` and the two files it
names first, ruling 77 with its amendments (the owner's principle: short, natural Hungarian that does not crowd a row),
then the rows of `rca-report.md` §2 your section names (and the `fb*-report.md` concerns it names). Red first, real
input, one commit per item, `scripts/gates.sh agent` once at the end; stop only processes you started, by PID. Your
section below is your whole scope; the others' files are not yours.

## FX-1 — the chat (branch `fix/round-chat`, worktree `art-fx1`, ports 5400–5409)

Owns: `chat/MessageBubble.svelte`, `chat/ToolActivityRow.svelte`, `chat/MessageInput.svelte` (placeholder only), the
chat page (`chat/[conversationId]/+page.svelte` and its `_helpers.ts`), `search/SearchModal.svelte` (the title literal),
the conversation detail read model's artifact list/count, and the three stale specs.
1. **RC-A §2 #1:** a file a turn makes is missing from the panel list and the header count until a reload (every PDF
   request; a board's PNG export shows at once). Find the cause (FB-1's "only jobs made since the turn began" stamp,
   FB-1's `origin` filters, FB-7's card move: check each), fix it, and prove it with the turn path.
2. **RC-A #2:** a failed tool call shows its raw parameters and an English error, expanded, in a row named
   "Eszköz <uuid>": a failed row names what it tried in the reply's language ("Nem sikerült szerkeszteni: Bécsi
   hétvége"), stays folded, and keeps the technical detail out of the reader's view (behind a quiet "Részletek" at most,
   never raw `[object Object]`).
3. **The owner's call on F16 (RC-A §1):** a turn that creates and then edits an item shows one card for that item, not
   one per call.
4. **RC-A #5:** in a project chat at ≤1280 px with a panel docked, the header title runs under the count chip.
5. **FB-8's note:** after a reload during a first turn that fails, the chat says the turn failed (with a retry) instead
   of showing an empty conversation.
6. **RC-A #9:** the search modal prints "New Conversation" for an untitled chat (use FB-7's shared untitled title).
7. **The docked composer's placeholder** "Kérdezz erről: <long title>" wraps to two lines in a narrow composer: a short
   placeholder that fits (the owner's principle).
8. **The three stale locators** FB-8 found (`artifact-app.spec.ts:500, :554`, `artifact-document.spec.ts:885` look for
   the crumb's old name "This chat"; FB-5 renamed its accessible name): follow the new name.
Gate specs: yours plus `chat.spec.ts`, `streaming.spec.ts`, `conversation.spec.ts`, `artifact-chat-card.spec.ts`,
`artifact-app.spec.ts`, `artifact-document.spec.ts`, `search-modal.spec.ts`, `project-page.spec.ts`.

## FX-2 — layout, tour and phone (branch `fix/round-layout`, worktree `art-fx2`, ports 5420–5429)

Owns: `document-workspace/DocumentWorkspace.svelte` (tour placement, History as a Back layer), `artifacts/tour/**`,
`history/HistoryMode.svelte` (the Back layer only), `client/panel-history.ts`, `routes/(app)/knowledge/**` (phone
layout), the sidebar's conversation/project menus (row height), `ArtifactPanelHeader.svelte` (the status chip's hit
area), `document/DocumentBody.svelte` (the working strip's words only).
1. **RC-A #4:** the tour card is now an overlay that covers the Document's toolbar and first lines (the App's status
   row, the board's top; 214 of 844 px on a phone). Ruling 77: its room is made before the body paints. The answer is
   known before paint for every kind seen in this page load (TR-D1's cache): put the card in the flow from the first
   frame then, so nothing moves and nothing is covered; only a late answer may arrive with the existing short height
   transition. Measure both (no layout shift of what was visible; nothing covered).
2. **FB-5's note:** History mode is a Back layer: on a phone and a desktop, Back leaves History before it closes the item.
3. **RC-A #8:** the phone Knowledge page runs past the edge at 360 (the page switcher, sort, Upload, delete).
4. **FB-9's notes:** a Document status chip's 44 px hit area overlaps the change pill's buttons by 6 px at 390; the
   conversation and project menu rows are 32 px high on a phone (44).
5. **The owner's call on F6 (RC-A §1):** "Alfy dolgozik a dokumentumon…" shows ~7 s during a turn that only reads:
   words true for both a read and an edit ("Alfy átnézi a dokumentumot…" or better), EN and HU.
Gate specs: yours plus `artifact-tours*.spec.ts`, `artifact-panel-history.spec.ts`, `artifact-history.spec.ts`,
`knowledge.spec.ts`, `artifact-document-review-bar.spec.ts`, `phone-polish.spec.ts`, `mobile-design.spec.ts`.

## FX-3 — the board and downloads (branch `fix/round-board`, worktree `art-fx3`, ports 5440–5449)

Owns: `components/artifacts/canvas/**`, `shared/artifacts/{board-ops,board-diff,board-placement,canvas-review,
mermaid-size,node-size}.ts`, `services/artifacts/canvas-comments.ts`, the board branch of `review.ts`; and for RV-B's
items `services/artifacts/export.ts`, `client/downloads.ts`, `app/generate-and-verify.ts`,
`routes/api/chat/files/jobs/[id]/+server.ts`, `document/DownloadSheet.svelte`. The editor's first paint has ~89 B of
room: measure.
1. **RC-A #3:** an `@Alfy` rewrite that replaces a note by a new id puts the new note outside its frame (−174, 40 vs the
   old (20, 200) in the Saturday frame) and the bar still says "1 módosított és 1 eltávolított": a replacement takes the
   replaced block's place and frame, and reads as one change.
2. **RC-A #6:** a board with a flowchart opens at one fit and re-fits in one frame ~200 ms later (100 % → 60 %) when the
   diagram is drawn: fit to the planned size from the start (`plannedNodeSize`), or move the camera smoothly; the notes
   should not end at ~8 px.
3. **RC-A #7:** a board the reader has touched is cropped by the comments rail (the right column hidden): make room
   without taking the reader's camera away (a pan by the rail's width is fine), and the board's thread card in the
   300 px rail no longer clips its own lines.
4. **RC-A #10 (board):** on a phone at 360 the review bar's sentence takes three lines (a phone wording that fits one or
   two); "Svelte Flow" sits half under the toolbar (keep it, unobtrusive and clear of the toolbar). **FB-4's note:** on a
   phone a low block's selection pill can sit under the zoom control.
5. **RV-B M1–M4:** the export reuse key carries a renderer version, so a renderer fix reaches an unchanged item; two
   presses that share a job do not cancel each other's download; an App whose verifier repair was accepted carries the
   repair's glitch hints, not the draft's; the jobs route uses the API auth helper (401, not a redirect; ruling 39).
6. **RC-A #10 (downloads):** PDF and Word downloads keep the item's title as the file name (Unicode-safe, as Markdown
   does), the App's Letöltés takes one click where it can, and one wording for retry ("Újrapróbálom" vs
   "Újrapróbálkozás").
Gate specs: yours plus every `artifact-canvas*.spec.ts` you touch, `artifact-canvas-review.spec.ts`,
`artifact-canvas-comments.spec.ts`, `artifact-document.spec.ts`, `artifact-app.spec.ts`, `knowledge.spec.ts`;
`check:artifact-chunks` exit 0.

## Report

`<scratchpad>/p5/fx1-report.md` (or fx2/fx3), screenshots in `fx1-shots/` (etc.), each looked at, at most 6. Final reply
at most 12 lines: status, **your model ID**, commit range, gate summary, concerns.
