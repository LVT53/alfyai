# Agent 2 · Panel shell (redesign steps 3–5)

Second of five agents. Agent 1 landed the tokens, the motion helper and the Document prose styles: read the
**hand-off section** of `rd/rd1-report.md` before you start and use what it names. Agent 5 (in-chat cards, App panel,
Knowledge) comes after you; agents 3 (comments) and 4 (editing feedback) after that — leave their surfaces alone.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd2`, branch
  `feat/artifacts-rd2-shell`, e2e port **5410**, label `rd2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd2-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd2/`
- Read first: `rd/common.md` next to this brief.

## Read in `redesign.md`

§5.1–5.5 (lines 421–537) **except** "In-chat cards" (489–505, agent 5's); §7 (649–722, the list ↔ item push and panel
open/close); §8's `ArtifactPanelHeader` row (730); §9.2 rows for `ArtifactPanelHeader`, `DocumentWorkspace.svelte`,
`ArtifactCard.svelte` (`chrome="row"` only), `Tabs.svelte`, `DocumentToolbar.svelte` / `toolbar-actions.ts`,
`MobileToolbar.svelte`, and the chat page's count button (765–792); §9.3 (794–811). Ruling 61's third point (tabs).
In the mockup: `#pvList` / `.list-body` rows, the panel header in `#pvDoc`, `#tabs` / `.tabs-ink`, the toolbar, the
`#madeBtn` count button with `#madeDot`, and the phone More sheet.

## Step 3 · The shared header

`src/lib/components/artifacts/ArtifactPanelHeader.svelte` (new, knows nothing about Tiptap; §8 is its contract: kind,
title, version with `onVersions`, meta line, an actions snippet, `onBack`). Use it for Document, App and File in
`DocumentWorkspace.svelte`. For artifact kinds, remove the disabled History placeholder, the "Active document"
eyebrow, the source pill and the `OpenDocumentsRail`. Uploaded/library documents opened in the same panel keep
working as today (check the knowledge-page and search-result opens still render).

## Step 4 · List rows, push navigation, open/close motion, count button

- `ArtifactCard` gains `chrome="row"` (append-only; do not restyle `chrome="full"` or `"body"`, agent 5 owns the
  standalone card): one line per item — icon, title, kind, time; the whole row is the button. The panel list uses it.
- List ↔ item push navigation and the panel's open/close motion (slides from the right, the chat's width transition),
  through agent 1's motion helper, with the §7.3 reduced-motion path.
- The chat page's count button (`artifact-count-button`): pressed state while the panel is open, and the pending dot
  per §5.2. Drive the dot from the pending-change signal the page already has; agent 4 later makes pending review
  survive a reload, so keep the dot's input a single clear prop/derived value it can feed.

## Step 5 · Tabs, toolbar, More sheet

- **Tabs switch sections** (ruling 61): each tab shows only its own section, done as an editor decoration (tab-range
  visibility in `extensions.ts` / `document-editor.ts`), while search, export, the card preview and Alfy's reads still
  cover the whole document — prove the last point with a test. Sliding underline, badges, a `⋯` menu (rename, delete)
  instead of a pencil and cross on every tab, arrow-key navigation per the WAI tabs pattern.
- Toolbar grouped with dividers as §5.2 shows, one roving tabindex, the "✓ Saved" state on the right; no Download or
  History in it (they live in the header).
- The phone More sheet through `DialogShell` (`phonePresentation="sheet"`, a title and a close button).

## Tests and screens

- Unit/component tests first for: the header's contract, the row chrome, the tab decoration (only the active section
  visible; a whole-document read unaffected), tab keyboard behaviour, toolbar roving tabindex, the count button's
  pressed/dot states, reduced motion.
- Playwright at the end (port 5410): `tests/e2e/artifacts-panel.spec.ts`, `artifact-document.spec.ts`,
  `artifact-app.spec.ts`, `artifact-chat-card.spec.ts`, `knowledge.spec.ts`, plus `chat.spec.ts` and
  `conversation.spec.ts` (the chat page changes).
- Screenshots in Hungarian: the panel list and a Document open with header, tabs and toolbar at 1440×900 light and
  dark; the phone list, the phone Document and the More sheet at 390×844 light.
