# Agent 3a · Comment cards and the comment rail (redesign steps 6–7)

Agents 1, 2, 5a and 5k are merged (and live on ai.dev). **Agent 5b runs at the same time as you** on the App panel and
the in-chat card (`AppBody.svelte`, `AppFrame.svelte`, `ArtifactCard.svelte`, `ToolActivityRow.svelte`, the chat page,
`DocumentWorkspace.svelte`'s Open-documents rail): do not touch those. Read the **hand-off sections** of
`rd/rd1-report.md`, `rd/rd2-report.md` and `rd/rd5a-report.md` first and reuse what they name. Agent 1 styled the comment
highlight (`.comment-anchor`, `.is-active`, `.is-resolved` with `--comment-mark*`) but **no comment-anchor decoration
exists yet**: you build it. Agent 3b (phone comments, the narrow-panel drawer, Versions/Download popovers) and agents
4a/4b (the editing chain) come after you.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd3a`, branch
  `feat/artifacts-rd3a-comments`, e2e port **5420**, label `rd3a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd3a-report.md`
- Screenshots: `…/scratchpad/rd/shots/rd3a/` (same scratchpad as the report).
- Read first: `rd/common.md` next to this brief.
- i18n: add your keys **inside the existing comment/margin blocks** of `src/lib/i18n/artifacts.ts` (EN and HU), never
  at the end of the `en`/`hu` objects — agent 5b edits the same file in parallel.
- The panel now slides in when it opens: an e2e that measures geometry must first wait for it to settle
  (`waitForStableBoundingBox` in `tests/e2e/helpers.ts`), and list items open by clicking the row
  (`getByTestId("artifact-row")`), not an "Open" button.

## Read in `redesign.md`

§3.1–3.2 up to (not including) the "Phone" paragraph (lines 141–224), §3.3–3.5 (235–279, the rows about the rail and
cards), §8's `CommentCard` / `CommentThread` / `CommentRail` rows (731–732), §9.2 rows for `CommentCard.svelte`,
`CommentThread.svelte`, `MarginPanel.svelte`, `extensions.ts` / `document-editor.ts` (comment anchors) and
`DocumentBody.svelte` (one scroll container) (771–775), §7 for the fold/reply animations. **Ruling 61's second point
wins over the spec and the mockup:** the rail shows **Open** threads by default, with a quiet "N resolved" toggle to
All; resolved threads fold to one line either way. Mockup: `#rail`, `.rail-filter`, `#railBody` and the thread cards.

## Step 6 · Comment card and thread anatomy

`src/lib/components/artifacts/CommentCard.svelte` (shared, knows nothing about Tiptap — §8) and
`document/CommentThread.svelte`: avatar (`AvatarCircle` for the user, a sparkle tile for Alfy), name, time
(`formatRelativeTime`), body with `@Alfy` highlighted, the Guess tag, the change chip, the refusal variant (keep
`RefusalNotice.svelte`'s `data-testid="refusal-notice"` working; agent 4a finishes the pinned refusal), actions as
`btn-ghost btn-sm` with Lucide icons; the quote button (goes to the anchor); resolve folds the card to one dashed line
with a peek (height animates, §7.3 reduced path); the reply composer ("Reply, or ask @Alfy…") that turns into Ask Alfy
when `@Alfy` is typed, with Alfy's typing placeholder while a reply is pending.

## Step 7 · The rail

`MarginPanel.svelte` becomes the rail (`CommentRail` in §8's terms; renaming the file is optional — keep
`data-testid="margin-comment"` on cards): a 300 px column inside the **same scroll container as the text** (delete the
scroll-sync effect; keep `margin-layout.ts` as is); a sticky header "Comments" with the Open/All filter and counts per
ruling 61; comments on removed text in a folded group at the end; "In other tabs" rows (one per other tab with open /
resolved counts; choosing one switches the tab — agent 2 built tab switching); the empty state; **two-way linking**
through a comment-anchor decoration in `extensions.ts` / `document-editor.ts` (hover/focus on a card marks its words
`.is-active`; clicking the words opens and focuses the thread; resolved anchors use `.is-resolved`).

## Tests and screens

- Tests first: card anatomy variants (user, Alfy, guess, change chip, refusal, folded), reply → Ask Alfy switch, the
  filter's default (Open) and toggle with counts, the removed-text group, other-tab rows, the anchor decoration
  (active/resolved classes, click → thread), the fold animation's reduced path, focus order and accessible names.
- Playwright at the end (port 5420): `tests/e2e/artifact-document-comments.spec.ts`, `artifact-document.spec.ts`,
  `artifacts-panel.spec.ts`, `artifact-document-selection-bubble.spec.ts`.
- Screenshots in Hungarian: the Document with the rail (open threads, one folded resolved, the removed-text group) at
  1440×900 light and dark; a thread with the reply composer open.
