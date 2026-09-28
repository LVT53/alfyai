# Agent 5b · The App panel (redesign step 13) and the in-chat card's remaining states

Agents 1, 2, 5a and 5k are merged (and live on ai.dev). **Agent 3a runs at the same time as you** on the comment cards
and the comment rail (`CommentCard.svelte`, `document/CommentThread.svelte`, `document/MarginPanel.svelte`,
`document/DocumentBody.svelte`, `document/extensions.ts`, `document/document-editor.ts`): do not touch those files.
Read the **hand-off sections** of `rd/rd1-report.md`, `rd/rd2-report.md` and `rd/rd5a-report.md` first and reuse what they
name (tokens, `reducedMotionAnimate`, `ArtifactPanelHeader` and its actions snippet, `ArtifactCard`'s chrome and view
fields).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd5b`, branch
  `feat/artifacts-rd5b-app`, e2e port **5445**, label `rd5b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd5b-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd5b/`
- Read first: `rd/common.md` next to this brief.
- i18n: add your keys **inside the existing App block and the card block** of `src/lib/i18n/artifacts.ts` (EN and HU),
  never at the end of the `en`/`hu` objects — agent 3a edits the same file in parallel.

## Step 13 · The App panel

Requirements: the **"Step 13 · App panel"** section of `rd/rd5-brief.md` (same folder), including its last bullet (decide
the Open-documents rail for App and File). Read `redesign.md` §6.1–6.5 for the App parts (538–604, 617–648 App rows),
§7 (the busy veil, the toast), §9.2's `AppBody.svelte` / `AppFrame.svelte` row (790), §9.3 (`focusTrap`, `DialogShell`
sheets, `Toast.svelte`). Mockup: "d · App & Knowledge" → Open the App, Ask for v2. Ruling 58's exact-string sandbox/CSP
tests must stay green; do not touch the frame's sandbox attribute, CSP or bootstrap.

## The in-chat card's remaining states (from agent 5a's "Deviations" section in `rd/rd5a-report.md`)

- **Open in panel, live:** wire the card's existing `current` state to the panel's open item (the page's
  `activeWorkspaceDocumentId` is the workspace item id `"artifact:" + id`; match through `workspaceDocuments`' own
  `artifactId`, as 5a describes).
- **Creating:** a skeleton card while `create_artifact` runs (kind and title are in the tool input); `edit_artifact`
  keeps today's row. Reduced motion: no shimmer.
- **Failed:** a card that says the item could not be made, with the reason, for a soft refusal of `create_artifact`.
  Keep `tool-activity.test.ts`'s rule that a refused `edit_artifact` shows the refusal, not a deliverable, unless the spec
  says otherwise. **No Retry button unless a real retry path exists** — do not invent one; say what you did in the report.
- **App fact-check line on the card:** only if the App's verification verdict is already stored on the artifact —
  then project it through `services/artifacts/read-model.ts` (facade only) with a test, and show the same line the panel's
  status row shows.
- Not yours: the "deleted" state (no server signal exists; the final review decides) and the "1 part left alone" pill
  (agent 4a, with the refusal summary).

## Tests and screens

- Tests first: the App status row, the segmented Preview/Code control, the regenerate popover's focus behaviour
  (Escape, focus return) and phone sheet, the busy veil (`inert` v1), the v2 toast's Undo, the rail decision, each new
  card state, the live `current` state, the fact-check projection if built.
- Screenshots in Hungarian: the App panel (Preview) at 1440×900 light and dark; the regenerate popover; the App panel at
  390×844; the chat with a creating card and a failed card at 1440×900.
