# Agent W4-B · Slice 5b T5 (a project's bundle lists what its chats made) and T6 (the doc fixes)

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-w4b`, branch
  `feat/artifacts-s5b-bundle` (from `feat/artifacts`), e2e port **5420**, label `w4b`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/w4b-report.md`;
  screenshots `…/scratchpad/w4/shots/w4b/`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 5, 18, 20, 22,
  60, 69 in `decisions.md`; in `slice-5.md`, by range: 572–616 (the project bundle contract), 1057–1105 (T5),
  1105–1159 (T6). AGENTS.md's Artifacts section and the `projects.ts` / `project-knowledge.ts` lines. The spec's line
  numbers predate Waves 2–3: re-anchor by symbol.

## Steps

1. **T5 — the bundle lists artifacts.** Per T5's test list: a project's Documents, Apps and Canvases (never Slides,
   ruling 69; a produced file stays a file, ruling 18) appear in its bundle (`ProjectFilesDialog.svelte`,
   `listProjectKnowledge`), ordered with its files, the kind from metadata (`artifacts.type.*` words, never
   "Artifact"), the row says the chat it came from; a row opens **the panel on that item** the way the chat's own card
   does (find how the project page opens a Document today and reuse that path; no second viewer); the home surface's
   count follows the same list; no other user's item; unlinking deletes nothing. Every read goes through the artifacts
   facade and its ownership scope (the facade rule), and an incognito chat's item never appears. The spec's
   `tests/e2e/projects.spec.ts` does not exist: extend `tests/e2e/project-files.spec.ts` (or `project-page.spec.ts`)
   with the two e2e cases, driven by real clicks, red first.
2. **T6 — the doc fixes.** Ruling 5's two corrections as T6 describes them, re-anchored (the file-production guidance
   claim: AGENTS.md's Purpose bullet on `normal-chat-context.ts` and the Chat Flow "Do" bullets, plus
   `src/lib/server/services/AGENTS.md`; the dead `fileProductionToolsAvailable`, today at `normal-chat-context.ts:450,
   1879, 1966`, its setter in `chat-turn/shared-normal-chat-model-run-helpers.ts`, and the tests that pass it —
   including `streaming-normal-chat-model-run.test.ts`), and AGENTS.md's Fallow gate line "the five known cycle
   findings" → four (the baseline has had 4 circular since `00ef6d2a`). Docs-only lines need no test; the field
   deletion is proven by `npm run check` and the six byte-identical prompt tests staying green.

Then the full gates once (Wave 3 rules' list; add the project e2e specs you touched and `tests/e2e/home-projects.spec.ts`
to the Playwright run). Screenshots you look at yourself: the project dialog with a Document, an App and a Canvas row,
HU at 1440×900 and 390×844, light and dark.

**Runs beside you:** agent TR-B on `feat/artifacts-tours` (the tour card, its trigger and replay in
`DocumentWorkspace.svelte`, `components/artifacts/tour/`). The only file you may share is `src/lib/i18n/artifacts.ts`:
append your keys in your own block at the end of each language.
