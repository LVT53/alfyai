# RV-F · final review of Feature 2 (report only)

Reviewer: `claude-opus-5-5` · head `ce62e412` (feat/artifacts) · worktree `rv-f` (detached), port 5540 · 2026-10-07.

**Verdict: ready after fixes.** Critical 0 · Important 3 · Minor 11.

The ownership, incognito and deletion paths this phase added hold, and so do the tours' server side, the badge, the
evidence group's content rules, the one sampling route and the family-wide invariants. Three seams fail, each between two
pieces that were each reviewed on their own:

- the board's stale guard (ruling 67) and user-save coalescing (ruling 47) on the edit tool's path;
- W4-B's "open a made item from the project's Files dialog" and the dialog stack;
- the tours' page-load cache and a panel host that names no reader.

Each has a reproduction below, either a probe or real input in a browser.

## Independent gates on `ce62e412`

- **Build:** exit 0. 32 `Unused CSS selector` and 2 `must have an ARIA role`, which is the baseline.
- **Chunk gate:** `npm run check:artifact-chunks` exits 0. The editor's first paint is 69.9 kB gzip with Chart.js, MapLibre
  and Mermaid kept out. The chat route is **542,478 B gzip, +1,993 over the baseline 540,485 (2,048 allowed): 55 B of
  headroom** (see M-4).
- **Fallow:** 124 issues / 4 circular. Compared by name with SMP-2's run on the phase's base (`fallow-smp2.json`), the set of
  unused files, exports and types and the cycles is **identical**: no new dead export and no new cycle.
- **Probes:** two throwaway vitest probes on the real migrated test DB, both outside the repo (`scratchpad/w4/probes/`).
- **Owner-style walk:** four Playwright scripts with real pointer, keyboard and touch input, outside the repo
  (`scratchpad/w4/walk/*.walk.ts`, logs `walk-log.txt`, `walk2-log.txt`, `walk3-log.txt`).
- **Not re-run:** `npm run check`, the full vitest suite and the full Playwright suite. The agents' and orchestrator's runs
  stand for those.

## Important

### I-1 · Alfy's board edit overwrites what the reader changed after it read the board, whenever the reader's save coalesces (ruling 67 × ruling 47)

**Where**

- `src/lib/server/services/normal-chat-tools/artifact-tools/edit.ts:398-405`: the handler passes `readVersionId` from
  `lastKnownBoardVersion` (`canvas-model.ts:145`), which tracks a **version id**.
- `src/lib/server/services/artifacts/ops.ts:233-237`: the read counts only when `readVersionId !== newest.id`.
- `src/routes/api/artifacts/[id]/body/+server.ts:89`: the body route coalesces by default (`coalesce !== false`).

**Mechanism**

A reader's save inside the 10-minute window, with the same summary, is written **into** their newest version (ruling 47).
If that is the version the turn read, the id is unchanged and the body is not. The envelope then sees "nothing changed
since the read" and judges the ops against the current board, so `update_node`, `move` and `remove_node` land on the
reader's new words.

FU-1 found this exact mechanism. It is described in `ops.ts`'s `readBody` doc comment, but FU-1 fixed only the `@Alfy`
comment path (`canvas-comments.ts`, `apply(ops, artifact.body)`). The tool path, which is far more common, still uses the
version id.

The tests miss it because the ruling-67 tests save with `coalesceUserEdits: false` (`canvas-handlers.test.ts:834`), which
the route never does by default.

**Reproduction** (`scratchpad/w4/probes/stale-coalesce.probe.test.ts`, real DB):

1. `createArtifact` makes a board (author `user`, summary `edited`).
2. `runReadArtifactTool` reads it.
3. The reader saves `note-museum = "Museum, 16:30 (the reader's)"` through `saveCanvasBoard` with `coalesceUserEdits`.
4. `runEditArtifactTool` runs `update_node note-museum` with that read in `turnContext.sources`.

Results:

- `coalesceUserEdits: false`: refused `stale`, and the reader's words stay.
- `coalesceUserEdits: true` (what the app does): `success=true`, and the board now says **"Alfy's words"**.

**Why it matters**

This is the everyday case: the reader edits the board, asks Alfy, and keeps tweaking while the turn runs. Ruling 67's
promise ("never overwrites what the reader changed after it read the board") fails silently. The text can be recovered
only through Undo or Versions.

**Fix direction**

Judge against the body the turn read, not the row it came from:

- `read_artifact` keeps the board body it showed in a small per-turn, in-process map keyed by turn and artifact (bounded,
  dropped at turn end; the `regenerating` map in `recreate.ts` is the precedent).
- Each edit that lands moves the stored body forward, as `lastKnownBoardVersion` does now.
- `edit.ts` passes it as `readBody`. When the map has nothing (for example after a server restart), it falls back to
  `readVersionId`.
- No body goes into the persisted tool-call metadata.
- The red test is the probe above.

### I-2 · A made item opened from a project's Files dialog: Tab goes into the hidden dialog behind the panel, and one Escape closes the panel and the dialog together

**Where**

- `src/routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte:304-530` renders the expanded
  `DocumentWorkspace` beside its `DialogShell`, inside the same `{#if open}`.
- The Files dialog is the topmost entry on the one dialog stack, so its trap owns Tab and Escape.
- `DocumentWorkspace.svelte:1364` (`if (hasOpenDialog()) return;`) defers its own Escape to that dialog.
- The expanded panel is not on the stack.

**Reproduction** (real input, walks B2 and H1)

1. Open a project and click "N elem".
2. Click "Jegyzet H" (a Document) and then into the editor. Typing works and is saved.
3. Press Tab three times. Focus moves to `input[project-files-search]`, then "Hozzáadás a könyvtárból", then "Feltöltés".
   All three are inside the dialog, and none is visible on top (`elementFromPoint` is the panel).
4. Press Escape in the editor. The editor **and** the dialog are gone, and focus lands on the page's "1 elem" button.

The same happens over a Canvas (B2): six Tabs cycle through the dialog's search field, toolbar and rows, never the
panel's or the board's controls.

**Why it matters**

W4-B made this the way to open, and therefore edit, a Document, App or Canvas from a project. In that path:

- a keyboard user cannot reach Close, Versions, Download or the board's toolbar by Tab;
- Escape is the editors' and board's "cancel" key, and here it throws away both layers.

This breaks the brief's invariant ("every `aria-modal` dialog… traps, returns focus and nests on the one dialog stack;
Escape closes the topmost only"). W4-B recorded the Escape half as open; the Tab half is new here.

**Fix direction**

When the panel is expanded over a dialog, it joins the stack: `registerDialog` while open, its Tab trap gated by
`isTopmostDialog`, and Escape closes the panel only, with focus returned to the row that opened it.

A narrower alternative: the Files dialog hides (`inert`) and stands down its trap while its panel is open.

The fix needs a real-key e2e test with Tab and Escape over the dialog, red first.

### I-3 · The tours' page-load cache crosses readers in one tab when the panel is hosted by the project's Files dialog

**Where**

- `ProjectFilesDialog.svelte:519-529` passes no `currentUser` to `DocumentWorkspace`.
- So `DocumentWorkspace.svelte:641` calls `keepArtifactToursFor(undefined)`, and every reader is `null`
  (`src/lib/client/api/artifact-tours.ts:46`).
- Logout's one client boundary (`src/lib/client/session-boundary.ts:7-18`, `clearClientAccountState`) does not drop the
  kept tour answers either.

**Reproduction** (walk I, `third.walk.ts`, real clicks and keys)

1. Reader A opens a Canvas from their project's Files dialog and finishes its tour.
2. A signs out through the sidebar: "Kijelentkezés", then confirm.
3. Reader B signs in through the login form on the same tab.
4. B goes in-app to their own project and opens **their first Canvas ever** from the Files dialog.

Result: **no card, zero tour GETs** (the answer came from A's page-load cache), and B has 0 seen rows.

**Why it matters**

- B misses the first-open tour (rulings 4 and 32).
- The panel acts on A's "seen" state, so one reader's bit is applied to another.
- This is exactly the case `keepArtifactToursFor` exists for. It works for the chat page and Knowledge, which pass the user,
  and fails for the third host.
- Impact is low, the fix is about two lines, and the brief named this check.

**Fix direction**

- Pass `currentUser` from the project page through `ProjectFilesDialog` to `DocumentWorkspace`. This also gives comment
  avatars there the reader's own placeholder-free identity.
- Drop the tours cache in `clearClientAccountState`, so no future host can miss it.

## Minor

- **M-1 · A deleted item's "Made in this chat" row stays a live-looking link.**
  - After a Knowledge Delete, the chat card says "Ez a dokumentum törölve lett · Újragenerálás", while the Sources row
    still shows "Weekend plan · Dokumentum ↗" (shots 05 and 12).
  - A click only raises the toast. `MessageEvidenceDetails.svelte` (made rows, `:83`, `:226`, `:472`) never reads the page's
    `deletedArtifactIds`.
  - Fix: thread the same `DeletedArtifacts` prop the cards use, and draw the deleted state.
- **M-2 · A fork's copied Sources say "Ebben a beszélgetésben készült" for the parent's item.**
  - `messages.ts:175-185` reads `forkEvidenceSnapshot`, and the group is copied with it. Found by reading the code.
  - The card's "Made in the original chat" wording exists for the same situation.
- **M-3 · The evidence surface's "this kind ships" guard is the tours' list.**
  - The guard is `isShippedArtifactTourType`, in `finalize-steps.ts:268` and `MessageEvidenceDetails.svelte:226`.
  - A kind that ships without a tour, or whose tour is shelved, would silently lose its "Made in this chat" rows.
  - W4-E flagged this. Fix: a browser-safe `SHIPPED_ARTIFACT_KINDS` in `shared/artifacts/kinds.ts`, with the tours list
    derived from or checked against it.
- **M-4 · The size gate is honest but nearly spent.**
  - **History:** the chat-route baseline moved seven times this phase, +3,602 B in total (1,682 · 437 · −19 · 159 · 420 ·
    46 · 462 · 415). Each move records a measured number.
  - **Consistency:** M2's recorded +2,010 on 539,608, plus the two later moves, predicts ~542,495. My build measures
    542,478, so the records add up.
  - **Drift:** the slack has crept from ~1,650 to 1,993 without a move.
  - **Headroom:** **55 B is left**. The next change that adds a few strings to the chat route fails the gate.
  - **Cause:** admin-only strings (+159 B) and admin calls ride the chat route because the dictionaries and
    `client/api/campaigns.ts` are monolithic (TR-D2's open follow-up).
  - **Fix:** do that split, or re-baseline deliberately with the reason recorded, before production work resumes on the
    chat route.
- **M-5 · On a phone with the keyboard up, two floating layers overlap at their corners.**
  - The selection's pill ("Alfy megkérdezése / Megjegyzés") and the note's tone toolbar overlap (shot 10). The TR-D4 reveal
    itself works: note 6 sits at y 378–426 above the toolbar at 442, with zoom unchanged and the typed text shown.
  - Likely pre-existing placement: RC-3 N3 keeps layers off the change pill and the zoom control only.
- **M-6 · The Files dialog footer makes a promise nothing on the list offers.**
  - It reads "3 elem · az eltávolítás nem törli a könyvtárból", but none of the three made items offers removal (shot 04).
  - The footer should count, or reword, only when a removable row exists.
- **M-7 · The chat card's meta line splits a number from its unit.**
  - At the desktop chat width it wraps as "Dokumentum · 1 / fül / · v1" (shot 01).
  - Probably earlier work, but it reads oddly in Hungarian. Fix: keep "1 fül" together (`white-space: nowrap` on each meta
    part).
- **M-8 · The explicit-language rule flips the whole turn for a content-language request.**
  - "Írj egy e-mailt angolul a kollégámnak…" flips the whole turn to English, including the chips and status line.
  - "Mondd el angolul" stays `null`, as CHP's own open item says. Probe: `scratchpad/w4/probes/lang.probe.test.ts`.
  - Owner decision; not a regression (before CHP any "angolul" flipped the turn).
- **M-9 · A linked family item's place in the project's lists is inconsistent.**
  - `listProjectKnowledge` drops family rows (`project-knowledge.ts:352`), while `listProjectKnowledgeContentTargets` and
    `readProjectArtifactDocumentIds` still include a family row linked from the library.
  - So the prompt section and the turn's read targets can disagree on a linked Document, App or Canvas. Found by reading
    the code; low.
- **M-10 · `home-summary.ts` repeats the ownership-scope read once per project.**
  - It calls `listProjectBundle` per project, and each call re-reads the ownership scope (all the user's conversation ids).
  - The cost is N scope reads, cached 30 s in production. Pass one scope in, or batch.
- **M-11 · Known (W4-B), seen again:** the panel opened from the Files dialog shows the "EZ A BESZÉLGETÉS" crumb with no list
  behind it (shot 13).

## What I checked and found sound

- **Library Delete (FU-1)**
  - The pre-read takes the store's own visibility scope (incognito included).
  - Posters go only when the store really deleted that row (`result.deletedArtifactIds.includes(row.id)`).
  - `deleteFilesOfDeletedBoard` scopes by the row's user, chat and board.
  - Child rows cascade through their FKs.
  - Walk C2: the Knowledge Delete of the Document flipped the chat card to deleted with Regenerate (shot 05).
- **`@Alfy` stale guard:** `readBody` is the body shown to the model, kept across the one retry. `ops.ts` prefers it to the
  version id.
- **`listProjectBundle` (W4-B)**
  - The project join is `projects.user_id = caller`, and its chats are the caller's, non-incognito
    (`buildConversationContextScopeCondition`).
  - Every row passes the canonical ownership condition with the non-incognito scope.
  - Linked rows go through the same scope. The GET and POST routes check project ownership first.
  - No produced files and no Slides are listed.
- **Tours**
  - Routes use `requireApiUser`.
  - Shipped kinds only: Slides and File return 404.
  - Seen writes are insert-if-absent, ignore any conversation or artifact id in the body, and answer 409 on a content
    change.
  - `artifact_tour_states` holds no chat or artifact id, erasure cascades (`user-scoped-tables.ts`), and the archive shows
    kind and status only.
  - The badge reads only first-run and release types (`getLatestPublishedAnnouncement`).
  - A tour is never eligible as a modal campaign (`getEligibleCampaignForUser`), and there is one live tour per kind.
  - **Walk results:**
    - Document by mouse (Tovább, Tovább, Értem) → `completed:2`.
    - Canvas, Escape while the card has focus → `dismissed:0`, and the board re-fits (6/6 notes in the pane).
    - The card takes focus when it shows.
    - Replay from the empty board shows "Újranézés" and records nothing (shot 14).
    - In incognito: zero tour requests, no card, no replay link (shot 07).
    - Phone tour (shot 09) and dark mode (shot 08) look right.
- **Evidence (W4-E)**
  - The group is built only from the turn's own finished create/edit calls: titles and kinds, no body, no read, no other
    chat's item.
  - Older stored summaries still parse.
  - In Hungarian the heading reads "Ebben a beszélgetésben készült" and the row "Weekend plan · Dokumentum" (shots 02 and
    12); the row opens the Document.
- **Sampling**
  - Every `generateText` and `streamText` file calls `resolveModelCallSampling`, and the call sites in multi-call files
    pass the resolved sampling through.
  - The only hand-built `chat/completions` call is the provider liveness ping.
  - Explicit temperatures are listed with reasons in `sampling.test.ts`.
- **Board (TR-D3/D4)**
  - `followsPane` holds while the camera equals the last fit and the reader has not pressed, touched or focused inside.
  - Fit re-arms it.
  - The keyboard reveal pans once per opening, never zooms, and resets when the room grows.
  - The tour card's focus return never lands inside the board, so it cannot mark an untouched board as touched.
- **Family invariants**
  - No i18n value (EN or HU) contains "artifact" or "artefakt".
  - Slides is not advertised: `advertisedArtifactKinds()` lists only kinds with a handler, and there is no Slides handler,
    body or card branch.
  - The incognito-containment suite adds no `ALLOWED_WITHOUT_SCOPE` entry.
  - The new routes return the same 404 for a foreign id as for a missing one.

## Fix plan (three clusters, disjoint files; each one Sonnet agent, two or three steps)

1. **Stale guard (I-1)**
   - Files: `normal-chat-tools/artifact-tools/read.ts`, `edit.ts`, `canvas-model.ts`, plus their tests.
   - (a) A red test: the probe, saving with coalescing.
   - (b) A per-turn read-body map, filled by `read_artifact`, moved forward by landed edits, passed as `readBody`, with
     `readVersionId` as the fallback.
   - (c) Gates.
   - Changes no chat-route bytes.
2. **Project dialog panel and tours reader (I-2, I-3, M-6, M-11)**
   - Files: `ProjectFilesDialog.svelte`, `projects/[projectId]/+page.svelte`, `DocumentWorkspace.svelte`,
     `client/session-boundary.ts`, `client/api/artifact-tours.ts`, `i18n/projects.ts`, plus a new e2e spec.
   - (a) Red e2e tests: Tab and Escape over the Files dialog, and the in-tab sign-out/sign-in.
   - (b) The panel joins the dialog stack when it sits over a dialog; `currentUser` is threaded through; logout drops the
     tours cache; the footer copy is fixed.
   - (c) Gates, plus a recorded chat-route move if one is needed (55 B of headroom).
3. **Sources and kinds (M-1, M-2, M-3)**
   - Files: `MessageEvidenceDetails.svelte`, `chat/[conversationId]/+page.svelte` (prop threading only),
     `shared/artifacts/kinds.ts`, `chat-turn/finalize-steps.ts`, `i18n/artifacts.ts`.
   - (a) Red test: a deleted item's row and a fork's wording.
   - (b) The deleted state from `DeletedArtifacts`, and a `SHIPPED_ARTIFACT_KINDS` guard.
   - (c) Gates. This cluster grows the chat route, so it needs a recorded ruling-68 baseline move, or it goes after M-4's
     split.

M-4 (split the admin strings and calls off the chat route), M-5, M-7, M-8, M-9 and M-10 go to the release checklist or
the owner.

## Screenshots (`scratchpad/w4/shots/rvf/`, all looked at)

| Shot | What it shows |
|---|---|
| 01 | Document tour, desktop light |
| 02 | Sources toggle (the expanded content sat below the fold) |
| 03 | Canvas tour over a fitted board |
| 04 | Project Files dialog with three made items |
| 05 | Deleted Document: card deleted, Sources row still live |
| 07 | Incognito empty Canvas: no card, no link |
| 08 | Dark Canvas tour |
| 09 | Phone Canvas tour |
| 10 | Phone note typed with the keyboard up |
| 11 | Phone dark Files dialog |
| 12 | Phone dark Sources: deleted card beside a live row |
| 13 | B's first Canvas in the project dialog with no tour (I-3) |
| 14 | Empty Canvas replay ("Újranézés") |
