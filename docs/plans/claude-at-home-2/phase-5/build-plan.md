# Phase 5 · the friction build: all 30 findings and the leftovers (ruling 77)

The owner (2026-10-12): "Do all honestly, they all seem important." The findings are in `phase-5/fa-report.md`
(§1 the ranked table, §2 one paragraph per finding with steps, measurements and file:line, §3 the patterns); the
screenshots in the orchestrator's scratchpad `p5/fa-shots/`. Product calls: ruling 77. Eight agents on disjoint files,
at most three at a time, each in its own worktree from `feat/artifacts`, red-first real-input tests, one commit per
finding, `scripts/gates.sh agent` once at the end.

| Agent | Findings | Owns (only these, plus their tests) | Batch |
|---|---|---|---|
| FB-1 files and downloads | F1, F23, F25, F27, F30 | `artifacts/document/DownloadSheet.svelte`, the App's download popover, `client/downloads.ts`, the artifact export routes and services, how a finished export reaches the reader (and never a later reply's cards: `MessageArea.svelte`'s generated-file attachment), `routes/(app)/knowledge/**`, `document-workspace/DocumentPreviewRenderer.svelte`, `routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte` | 1 |
| FB-2 Alfy's tools and words | F2, F10, F20, F22, LV's App brief | `normal-chat-tools/**` (tool text, `create.ts`, `edit.ts`, `kind-prose.ts`, the App rebuild entry), `src/lib/server/prompts.ts` file guidance, `artifacts/keep-message.ts`, `chat/ToolActivityRow.svelte`'s labels, the thought-step status prompt, the frozen tool snapshots | 1 |
| FB-3 the panel's motion and layout | F3, F4, F15, F19, F26 | `document-workspace/DocumentWorkspace.svelte`'s shell (dock, expand, close, delete flow, tour placement), the chat page's dock region (`chat/[conversationId]/+page.svelte`), `stores/ui.ts` (sidebar), `artifacts/tour/**` placement | 2 |
| FB-4 the board | F8, F11, F12, F18 (board), F24 (board), F28 (board), F9 (Insert menu rows) | `components/artifacts/canvas/**`, `shared/artifacts/{board-ops,board-diff,canvas-review,mermaid-size,node-size}.ts`, the board branch of `services/artifacts/review.ts`, `services/artifacts/chat-blocks.ts` | 2 |
| FB-6 the Document and comments | F6, F13, F14, F18 (Document), F24 (Document), F28 (Document "+") | `components/artifacts/document/**` except `DownloadSheet.svelte`, `artifacts/ReviewBar.svelte`, `CommentComposer.svelte`, `CommentsSurface.svelte`, `CommentCard.svelte` | 2 |
| FB-5 rows, headers and the phone | F7, F9 (panel rows), F21, F26 (count button), F28 (phone crumb, project card), F29 | `DocumentWorkspace.svelte`'s rows, list, headers and history entries (after FB-3), `ArtifactPanelHeader.svelte`, `ArtifactCard.svelte` meta, the landing's project card | 3 |
| FB-7 the first message and the reply | F5, F16, F17 | the chat page's bootstrap view (after FB-3), `i18n/chat.ts`, the untitled title (`services/conversations.ts`, `ConversationTitleText.svelte`), `chat/MessageBubble.svelte` (chips, the card's place while a turn runs), `chat/MessageArea.svelte` (after FB-1) | 3 |
| FB-8 the leftovers | RC-V M-1, M-2; FG's reconnect hang, `map-route-card` CSP, "database is locked"; the App's restore metadata | `services/artifacts/{versions,record}.ts`, `history/HistoryMode.svelte`, `chat-turn/stream-reconnect.ts`, the map route card and the CSP it needs, deferred write transactions | 3 |

Then: a Sonnet re-check that walks every finding like the owner (HU, 1440/1280/1100 docked/390, light and dark, mouse,
keyboard, touchpad, touch, the real model for chat-driven flows) and says, per F-number, fixed / better / not fixed; an
Opus look only at what touches ownership, file serving or the App sandbox (FB-1's download paths, FB-2's App edit path,
FB-8's guard); fixes; the release gate in `dev-int`; deploy; live checks; the owner's check (M5).
