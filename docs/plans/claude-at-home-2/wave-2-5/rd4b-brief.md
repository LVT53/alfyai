# Agent 4b · The change pill, the review bar, and pending review that survives a reload (step 10 + ruling 61)

The last build agent; it runs alone. Every other redesign agent is merged (1, 2, 5a, 5k, 5b, 3a, 3b, 4a). Read the
**hand-off sections** of every `rd/rd*-report.md` first — in particular 2's count-button dot input, 5a's
`pendingReviewCount` wiring on the in-chat card (the card's "N changes to review" pill must follow the persisted state
too), 3a's change chip (`changeIdByCommentId`, session-only today: make it survive a reload with the same state if it is
small, else say so), and 4a's refusal summary line — and reuse what they name.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd4b`, branch
  `feat/artifacts-rd4b-review`, e2e port **5435**, label `rd4b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd4b-report.md`
- Screenshots: `…/scratchpad/rd/shots/rd4b/` (same scratchpad as the report).
- Read first: `rd/common.md` next to this brief, then ruling 61's first point in `decisions.md` (588–598) and
  rulings 47 (user saves coalesce; every Alfy change is a new version), 49 (`{ ok: true }`), 51 (`conversationId` on
  artifact routes for incognito) in the same file.

## Read in `redesign.md`

§4.2 items 5–6 (lines 334–350), "Reload with a pending change" and "The chat side" (365–375), §4.3–4.5 rows about
changes and review (376–420), §8's `ChangePill` / `ReviewBar` rows (733–734), §9.2 rows for `ChangeBar.svelte`,
`ReviewBar.svelte`, `marks.ts` (772–778), §7 (the settle motion). Mockup: `#review` (the review bar) and the inline
"Alfy · Keep · Undo" pill.

## Step 10 · Change pill and review bar

- `document/ChangeBar.svelte` becomes the inline pill as a ProseMirror **widget decoration** right after the change
  (keep `data-testid="alfy-change-bar"`), with Redo after Undo; the change mark settles with agent 1's `arrive` class.
- New shared `src/lib/components/artifacts/ReviewBar.svelte` (knows nothing about Tiptap, §8): pending count, refused
  count (agent 4a's summary line), index with prev/next, Keep all / Undo all, at the bottom of the text column.
- Keep / Undo / Redo per change, Keep all / Undo all, the version bump shown in the header, reduced-motion paths.

## Ruling 61 · A pending Alfy change survives a reload (a data change — design it through the artifacts facade)

The edit is already a saved version; only its review state is lost today. Build:
- **Stored state** on the artifact (its `metadata_json`, so no migration; if you find a column is truly needed, stop
  and report instead): the last Alfy version the user has reviewed, plus the ids of blocks already kept in newer Alfy
  versions. Written only through a new function on `src/lib/server/services/artifacts/index.ts` (ownership scope as
  the facade's other writes) and a thin route under `src/routes/api/artifacts/` (`requireApiUser`, `{ ok: true, … }`,
  `?conversationId=` honoured for incognito, a foreign or missing id → the same 404 body), plus a browser call in
  `src/lib/client/api/artifacts.ts`.
- **Pending set on load:** for each Alfy version newer than the marker, the blocks it changed against its parent
  (block by block), minus blocks already kept, minus blocks the user edited in a later version, minus blocks that no
  longer exist. The artifact's creation is never pending. **No marker yet** (every existing artifact): nothing is
  pending, and the first new Alfy edit writes the marker as its parent version.
- **Keep** acknowledges (persisted); **Undo** restores the parent's content for those blocks **as a user edit**
  (ruling 47's coalescing applies) and acknowledges them; **a user's own edit** to such a block acknowledges it. When
  nothing is pending, the marker advances to the latest Alfy version and the kept-ids list clears.
- The review bar counts the reloaded pending changes; the count button's pending dot (agent 2) follows the same state.
- Documents only (Apps keep their own v2 toast + Undo).

## Tests and screens

- Tests first: server — the pending-set computation (multiple Alfy versions, partial keep, user edit in between,
  deleted block, creation not pending, no marker), the route's ownership/incognito/404 behaviour, the marker write on
  the first Alfy edit; client — the pill widget, Redo after Undo, review bar navigation and bulk actions, reduced motion.
- Playwright at the end (port 5435): an e2e that makes an Alfy edit through the suite's fake provider
  (`AI_SMOKE_EDIT_ARTIFACT_MARKER`, as `artifact-document.spec.ts` does), reloads, sees the marks and the count, keeps
  one, reloads, sees one fewer; plus `artifact-document.spec.ts`, `artifact-document-comments.spec.ts`,
  `artifacts-panel.spec.ts`, `artifact-chat-card.spec.ts`, `artifacts-api.spec.ts`.
- Screenshots in Hungarian: two pending changes with the pill and the review bar at 1440×900 light and dark; the same
  after a reload; the phone review bar at 390×844.
