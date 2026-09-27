# Agent 1 · Foundation (redesign steps 1–2)

First of five agents; agents 2–5 build on your tokens, motion helper and Document styles, so name them clearly in the
report's hand-off section.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd1`, branch
  `feat/artifacts-rd1-foundation` (from `feat/artifacts` `87f5ee5d`), e2e port **5400**, label `rd1`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd1-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd1/`
- Read first: `rd/common.md` next to this brief (the rules for every agent).

## Read in `redesign.md`

§1 (lines 25–83), §2 (84–140), §7 (649–722), §9.1 (743–763), §9.3 (794–811), §10 steps 1–2 (820–824). In the mockup,
grep `index.html` for its `:root` token block, `.prose`, `.doc-page`, `.tasks`, the tracker table, the chip pills,
`.alfy-change` / the change mark, and the comment mark.

## Step 1 · Tokens and motion helpers

1. Add §9.1's tokens to `src/app.css` for light and dark with the table's exact values; map them in
   `tailwind.config.ts` only where a utility is useful. `--duration-settle` also goes into the reduced-motion override.
2. `color-scheme: dark` on the dark root (and `light` on the light one) so native checkboxes and selects follow.
3. The WAAPI helper in `src/lib/utils/motion.ts` beside `prefersReducedMotion` / `reducedMotionAware`: a small function
   that runs `element.animate(...)` with the motion tokens and, under reduced motion, follows §7.3 (no movement; jump to
   the final state or a short opacity-only change, as §7.3 says). Design its API for what §7.2 lists (list ↔ item push,
   panel open/close, the change mark's settle, card arrivals) so agents 2–4 can call it; unit-test both paths.
4. Replace `.btn-text`, which is defined nowhere: its only uses are three in `src/lib/components/artifacts/CommentCard.svelte`;
   switch them to the real button classes per §2.1 (a later agent redesigns that card; you only make these real buttons).
5. Replace the undefined `--status-*` tokens: `--status-warning-text/-surface` (`MarginPanel.svelte` ~416) →
   `--warning-text` / `--warning-tint`; `--status-danger` (`CommentThread.svelte` ~140, `DownloadSheet.svelte` ~170) and
   `--status-danger-text` (`VersionsSheet.svelte` ~210) → the existing `--danger` (app.css :128 / :215) or a defined
   danger text token. After this, `grep -rn "var(--status-" src` finds nothing.
6. A separate small commit: the global `btn-primary` text colour → `--accent-text` (§9.1's last paragraph: accent text on
   a 12 % tint is 3.5:1 in light). Check the other surfaces that use `btn-primary` still look right (one screenshot of a
   non-artifact screen that uses it is enough).
7. A contrast unit test that parses the solid token values from `app.css` (light and dark) and pins the ratios §9.1
   states against the page surface: `--accent-text`, `--on-accent` on `--accent-fill`, `--warning-text`,
   `--success-text` — each at least 4.5:1. This stops later agents from regressing them.

## Step 2 · Document prose and marks

1. Style the text inside `.document-content` (today its only rule removes the focus outline) to match the mockup's
   `.prose` page in both themes: serif body (the long-form serif AGENTS.md names), sans headings, lists, **inline task
   items** (checkbox on the text line), the **tracker table** (bordered, status pills), **chip selects as pills**,
   quotes, code. Keep it inside the Document component boundary (`DocumentBody.svelte`'s styles or a stylesheet it
   imports) and do not restructure its markup — agents 2–4 change the layout around it.
2. `.alfy-change` in `src/lib/components/artifacts/document/marks.ts` (and its CSS): the visible Alfy mark per §1/§4
   (accent tint from `--alfy-mark` plus the spec's rule) and an `arrive` class that settles from `--alfy-mark-arrive` to
   `--alfy-mark` over `--duration-settle`; reduced motion shows the final state with no animation.
3. Comment-anchor highlights with `--comment-mark`, `--comment-mark-active`, `--comment-rule` in both themes, applied
   to the existing comment-anchor decoration's classes. Only the styles: the active state, click → thread and the rail
   belong to agent 3.

## Non-goals

No change to the panel layout, header, list, tabs, toolbar, comment rail, cards, selection bubble, change bar or App
panel (agents 2–5). No new dependency.

## Tests and screens

- Unit: the motion helper (both paths), the contrast test, and `marks.test.ts` / `extensions.test.ts` if class names or
  decoration attributes change.
- Playwright at the end (port 5400): `tests/e2e/artifact-document.spec.ts`, `artifact-document-comments.spec.ts`,
  `artifact-document-selection-bubble.spec.ts`, `artifacts-panel.spec.ts`.
- Screenshots (UI in Hungarian): a seeded Document with headings, a task list, a tracker table with status pills and
  a chip, one Alfy change mark and one commented phrase — at 1440×900 light and dark and 390×844 light — each compared
  with the mockup's Document page in HU.
