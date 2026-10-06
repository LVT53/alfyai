# W4-B report: Slice 5b T5 (a project's bundle lists what its chats made) and T6 (the doc fixes)

Model: `claude-sonnet-5-5`. Worktree `art-w4b`, branch `feat/artifacts-s5b-bundle` from `feat/artifacts` `f33f1316`. e2e port 5420.
Nothing pushed, merged or rebased; no other branch or worktree touched; no subagent dispatched.

## Commits (oldest first, all with the `Co-Authored-By: Claude Sonnet 5.5` trailer)

| commit | what |
|---|---|
| `03a526c8` | T5 server: `listProjectBundle` in the artifacts service; the route and the home summary read it; `listProjectKnowledge` stays files only |
| `19ac21d9` | T5 UI: the Files dialog row for a made item, the "items" counts, the e2e specs (written and seen red first) |
| `5ebc24e7` | T6: the three file-production doc corrections, "four" cycles, `fileProductionToolsAvailable` and the stub that fed it deleted |
| `8e36f161` | dialog polish: the open action on one line down the column, phone wrap, 44 px hit area |
| `0f8728bc` | AGENTS.md: where a project's bundle comes from, and why `listProjectKnowledge` stays files only |
| `e65748af` | fewer i18n bytes: the first seven strings put the chat route 118 B over its budget |
| `b1d5ba12` | the quiet line's wording pinned in `HomeSurface.test.ts` |
| `e1797259` | the bundle's chat reads take the one incognito scope (the full run's structural guard failed without it) |

Range: `f33f1316..e1797259`.

## T5: what changed and where

**What "a project's bundle" is.** The glossary (`CONTEXT.md`, Document Bundle) and ADR-0065 say it outright: "the Project Folder view that gathers the Artifacts from all conversations in the folder, together with its Folder Knowledge ... It is a view". The brief's own title is "lists what its chats made". The spec text only walked link rows (`project_knowledge_links`), which cannot do that without writing a link at every creation and going stale when a chat moves, so the bundle is both, de-duplicated:

- through its chat: a Document, App or Canvas made in a chat whose `conversations.project_id` is the project (read every time, never stored; a chat moved out takes its items with it);
- through a link: the reader added it from the library (the same `project_knowledge_links` row a file uses; unlinking removes that row and deletes nothing).

Never listed: Slides (ruling 69), a produced file (`generated_output` stays a file, ruling 18), another user's item, anything made in an incognito chat (the project's chat list takes `buildConversationContextScopeCondition` and the item takes the canonical ownership condition, two locks), an item whose chat is gone.

- `src/lib/server/services/artifacts/project-bundle.ts` (new) + `index.ts` export: `listProjectBundle({ userId, projectId })` returns `ProjectKnowledgeItem[]` in the files' own order (`sortProjectKnowledgeItems`). The kind comes from `metadata_json.artifactType` through `parseArtifactMetadata`, the title through `titleForArtifactRow`; no second column.
- `knowledge/project-knowledge.ts`: `ProjectKnowledgeItem` gains optional `artifactKind`, `sourceConversationId`, `sourceConversationTitle`, `linked` (absent on a file); new `listProjectLinks`; `sortItems` exported as `sortProjectKnowledgeItems`; `listProjectKnowledge` now stops at files (see Deviations 1). `knowledge.ts` re-exports both.
- `routes/api/projects/[id]/knowledge/+server.ts`: GET and POST answer with the bundle (`{ files }`, the key the browser always read). `home-summary.ts`: the project cards count `listProjectBundle(...).length` and carry `hasMadeItems`.
- `ProjectFilesDialog.svelte`: a made item shows its kind icon (`ARTIFACT_KIND_ICONS`), the kind word (`artifacts.type.*`, pill), the chat that made it under its name (`from “…”`), a "Open {title}" action (`artifacts.card.openA11y`) with the panel icon, and an unlink only when `linked !== false`. The open action builds the same workspace item the Knowledge page builds for a family row (`kind`, `artifactId`, `conversationId`, `mimeType: null`) and goes through the dialog's own `DocumentWorkspace`: the panel is the one viewer, no second one. Search matches titles. The type column is 86 px so "Alkalmazás" fits; the open icon stays in one column with or without an unlink beside it; on a phone the origin line wraps and the open action has a 44 px hit area (an `::after`, the button is not redrawn).
- Counts: once anything in the bundle was made by a chat, the quiet line (`HomeSurface`), the home project cards and the dialog footer say "items" (`artifacts.bundle.items`, `artifacts.bundle.footerNote`); a bundle of only files keeps "files" word for word, so every existing assertion holds. `projects.filesDescription` (both languages) was made true for both kinds of row instead of getting a twin.
- i18n (EN and HU, same commit, my own block at the end of each language in `artifacts.ts`): `artifacts.bundle.fromChat`, `artifacts.bundle.items`, `artifacts.bundle.footerNote`.
- AGENTS.md: a bullet in the Artifacts section for the bundle; the `project-knowledge.ts` line says it owns the project's FILES.

**Tests added (T5)**

- `artifacts/project-bundle.test.ts` (13, in-memory DB, real ownership scope): includes and orders with files; kind from metadata and the chat's title; a file row has no family field; never Slides, a produced file or an outside chat's item; incognito chat's item never appears and reappears when the flag is turned off; another user's item never, not even through a planted link row; an item linked from the library; once when it is both; `linked: false` for a chat-only item; unlinking deletes nothing (row, body and version intact); an item leaves with its chat; a deleted item leaves with its link; `listProjectKnowledge` stays files only.
- `ProjectFilesDialog.test.ts` (+8): kind words (EN and HU), origin line, no "artifact" in a row, open label, opens the panel on the item's kind (not the file viewer), unlink only where there is a link, "items" footer vs "file" footer, search by title.
- `HomeProjects.test.ts` (+2), `HomeSurface.test.ts` (+5, project mode): "items" vs "files", singular, HU. Route test updated (`project-knowledge.test.ts`): GET and POST carry the bundle.
- e2e, real pointer input, **red first** (6 of 6 failed on the unfixed UI: no kind pill, no "Open …" button, footer "4 files" for "4 items", an unlink where there is none; the phone case failed on the missing pill), then green: `tests/e2e/project-files.spec.ts` "Project bundle — what the chats made" (5: lists Document, App, Canvas beside the file with kind word and chat; opens a Document row on the editor; opens a Canvas row on the board and an App row on its frame; counts files and made items together on the quiet line and the footer; no unlink on a chat-only item and unlinking a linked one deletes nothing) and "Project bundle — phone" (1: kind and chat stack under the name, nothing past 390 px, a 44 px open target); `tests/e2e/home-projects.spec.ts` (+1: the card says "2 items" for a file and a Document, "1 file" for files only).

## T6

- Docs: `AGENTS.md` (Core Rules bullet on `normal-chat-context.ts`; the Chat Flow "Do" bullet) and `src/lib/server/services/AGENTS.md` (Normal Chat prompt note) now say what each file does: `prompts.ts` holds the base prompt text including the file-production guidance (6 `produce_file` occurrences; `normal-chat-context.ts` has 0 and consumes it through `getSystemPrompt`), `normal-chat-context.ts` assembles it with the recorded prompt name and the turn guidance, `normal-chat-tools/produce-file.ts` (hyphen, not `produce_file.ts` as the spec wrote) owns the model-facing contract. The Fallow gate line says "four known cycle findings" (the run reports 4 circular, 0 new).
- `fileProductionToolsAvailable`: declared at two sites in `normal-chat-context.ts`, threaded at one, set in `chat-turn/shared-normal-chat-model-run-helpers.ts`; nothing read it. Deleted at all four, with the arguments `normal-chat-context.test.ts` (5), `streaming-normal-chat-model-run.test.ts` (2) and `plain-normal-chat-model-run.test.ts` (2) passed it, the four `expect.objectContaining({})` the deletion would have left empty, and the one in `scripts/evaluate-tool-guidance-ab.ts` (a Fallow entry the spec did not list). The six byte-identical prompt tests stay green; `npm run check` is the proof for the rest.
- `shouldExposeFileProductionTools` (always `true`, called only by that setter) went with it: left alone it is an unused export, a new Fallow finding. Its reason (the tool set never varies by message, ADR-0055) stays as the header note of `normal-chat-tool-gating.ts`; the comment in `normal-chat-tools/index.ts` that named it points at that note.

## Gates (final tree, `e1797259`)

Logs: `scratchpad/w4b-gates-final/` (final tree) and `scratchpad/w4b-gates/` (the earlier full run on `e65748af`). In the Wave 3 rules' order:

| gate | result |
|---|---|
| `npm run check` | exit 0, **0 errors, 17 warnings** (the baseline 17: `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1) |
| `npx biome check src scripts tests` | exit 0, 2,451 files, no fixes |
| `npm test` (full vitest) | exit 0, **16,326 passed**, 2 skipped, 1,004 files passed. The first full run (`e65748af`) had two failures: `tests/cross-cutting/incognito-conversation-containment.test.ts` (a real one: my bundle read `conversations` by user without the scope condition; fixed in `e1797259`) and `region-manager.test.ts` (`ENOTEMPTY` on its temp dir, passes alone). The repeat on the final tree is all green |
| `npm run build` | exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (the baseline) |
| `npm run check:artifact-chunks` (own step) | **exit 0**. Editor first paint 69.6 kB gzip (own 61.5 kB; ceiling 71,680 B). **Chat route: 76 chunks, 538,743 B gzip = +1,860 against the 536,883 baseline (2,048 allowed): 188 B of headroom** |
| Fallow | exit 0, **124 issues, 4 circular, 0 new against the baseline** (the baseline JSON `fallow-baseline-00ef6d2a.json`) |
| `npm run check:migrations` | exit 0 (no migration added) |
| Playwright, full set on `e65748af` (`chat`, `conversation`, `knowledge`, every `artifact*.spec.ts`, `project-files`, `project-page`, `home-projects`) | **484 passed, 23 skipped, 0 failed** (40.4 min). `e1797259` (a server-side condition) landed during that run |
| Playwright on the final tree (`project-files`, `project-page`, `home-projects`, `knowledge`) | **55 passed, 0 failed** (1.7 min) |

## Screenshots (looked at each one myself; HU, seeded: a project of 5 rows, 3 made by one chat, 1 linked Document from another chat, 1 uploaded file)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/w4b/`
- `dialog-hu-desktop-light.png`, `dialog-hu-desktop-dark.png` (1440x900): the dialog; kind icons and words (Dokumentum, Tábla, Alkalmazás), `„Szombati program” beszélgetésből` under each name, "5 elem · az eltávolítás nem törli a könyvtárból", the open icon in one column, an unlink only on the linked Document and the file.
- `dialog-hu-phone-light.png`, `dialog-hu-phone-dark.png` (390x844): the sheet; rows stack name, chat, kind, time; the chat wraps instead of being cut; nothing past the edge.
- `panel-hu-desktop-light.png`: a made item's open action lands on the Document editor in the panel (not the file viewer).
- `project-page-hu-desktop-light.png`: the quiet line "5 elem". `home-hu-desktop-light.png`: the home card "5 elem".
- The throwaway spec that made them is parked at `scratchpad/w4/zz-w4b-shots.spec.ts.txt`; nothing under `tests/` or `docs/`.

## Deviations from the spec and why

1. **`listProjectKnowledge` stays files only; the bundle is `listProjectBundle` in the artifacts service.** (a) The prompt's "Project files" section and the file-name mentions read `listProjectKnowledge`; `mergeProjectFileMentions` hands a mention to `resolveLinkedContextSourcesForConversation`, which throws a 409 `linked_source_not_prompt_ready` for any row that is not prompt-ready, and a family row never is (no normalized sibling). Listing the chats' Documents there would have turned "the user typed its name" into a failed turn, in every project chat. (This was already latent for a family row linked from the library; it is closed now.) (b) The composition belongs a layer up: the artifacts service already imports the knowledge facade (`chat-blocks`, `canvas-export`), so a knowledge-to-artifacts import would be a cycle. (c) It is the facade rule. The cost: model-facing readers (prompt section, mentions, retrieval ids, read targets) see files and, as before, nothing the chats made. Whether project chats should see their siblings' Documents is a product decision (they cannot `read_artifact` them today), recorded below.
2. **Membership by chat, not links alone** (above). The link path is kept in full because the spec's tests need it.
3. **`artifacts.bundle.fromChat` has no `· {time}`**: the Added column already shows it (a linked item by its link, a chat-made one by when the chat made it). **`artifacts.bundle.projectFile` is not added**: file rows keep their extension, size and time, which already say what they are, and nothing would render the string. `artifacts.bundle.openA11y` is the existing `artifacts.card.openA11y`.
4. **"Items"** instead of "files" once anything was made by a chat (the spec says only that the count follows). "3 files" over a Document, an App and a Canvas would be false.
5. The spec's `tests/e2e/projects.spec.ts` does not exist: the cases live in `project-files.spec.ts` and `home-projects.spec.ts`.
6. T6 also deleted `shouldExposeFileProductionTools` (spec: leave it) because deleting its only caller makes it an unused export.

## Concerns and open questions for the orchestrator

- **Chat-route chunk gate: +1,860 B of 2,048 (188 B of headroom) on the final tree.** Every i18n string ships in every route's first load. My first seven strings measured +2,166 (118 B over); the trim (three keys, the card's open label, one plural key, the description line edited instead of twinned) brought it to +1,854 (+1,860 on the final tree, hash names moving by a few bytes). The base on this machine is about +1,640 (SMP/CHP/FLK reports), so W4-B costs about 210 B and the tours branch (baseline already moved to 538,983) plus TR-D1 plus this will have to share what is left: expect the baseline to be moved at the integration merge, with its reason.
- Product question (deviation 1): should a project's chats see the Documents, Apps and Canvases their siblings made (a "made in this project" line in the prompt, and a way to read them)? Not built; today they are the person's view only.
- Observed, not mine, not touched: the panel header's "This conversation" crumb (`DocumentWorkspace` -> `ArtifactPanelHeader`) is a dead button in a host with no list (the Knowledge page and now the project dialog): `handleBackToList` only calls `onListOpenChange`. A one-line `{#if list}` fixes it in TR-D1's file. Escape with a panel open in the project dialog closes the panel and the dialog together (FU-2's focus-trap area).
- `tests/e2e/project-files.spec.ts` "previews a file from a row without leaving the project page" failed once in a combined run ("Failed to load document preview": the uploaded `.txt`'s extraction was not settled) and passed alone and in the full run: a race of that existing test, not of this change. `region-manager.test.ts` failed once in a full vitest run (`ENOTEMPTY` on its temp dir) and passed alone; the full run was repeated.
- CHANGELOG `[Unreleased]` has no Feature 2 entries, so I added none; the release checklist owns it.
- Merge notes: TR-D1 and I both append at the end of each language block in `src/lib/i18n/artifacts.ts` (a textual conflict at those two spots, both sides to keep). If FU-2 touches `ProjectFilesDialog.svelte` for a focus trap, the made-item row (`{@const KindIcon ...}` in the `{#each}`) and the phone CSS are the places this branch changed.
- `recordDocumentWorkspaceOpen` in the dialog's open path has no `.catch` (as before for files); the route answers 200 for a family row, so nothing fails today. The chat page and the Knowledge page do catch it.

## Hand-off (what the next agent builds on)

- `listProjectBundle` (artifacts facade) is the one list behind the dialog, the quiet line and the cards; anything that counts or shows a project's material calls it. `listProjectKnowledge`, `listProjectKnowledgeContentTargets`, `listProjectKnowledgeArtifactIds` are the model's and stay files.
- `ProjectKnowledgeItem`: `artifactKind` set means "a Document, App or Canvas, not a file"; `linked === false` means "no link to remove"; `sourceConversationId` / `sourceConversationTitle` name the chat. `HomeProjectCard.hasMadeItems` and `HomeMode.project.hasMadeItems` carry the "items" wording.
- i18n: `artifacts.bundle.fromChat`, `.items`, `.footerNote`; `artifacts.card.openA11y` for the open action.
- e2e helpers in `tests/e2e/project-files.spec.ts`: `seedBundleProject`, `seedProjectChat`, `makeDocument`, `makeArtifact`.
- The Opus review should look hardest at: the files-only split (deviation 1) and that no model-facing reader got a family row; the membership query (`project-bundle.ts`); the dialog's made-item row on a phone.
