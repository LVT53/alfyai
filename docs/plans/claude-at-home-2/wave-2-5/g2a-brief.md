# Polish agent G2-A · Delete, the deleted state, and Regenerate

The owner, after walking the redesign on ai.dev:
> "I see this new info tooltip row button called 'Open as document' but then I don't see a delete option for the opened
> document. This will accumulate junk over time. I'd like you to add Delete functionality. Worst case in the UX it should
> show in the generated file rows that 'the file has been deleted' with an option to regenerate."

Facts found by the orchestrator: "Open as document" is the chat message action `chat.artifacts.keepAsDocument` (it turns
a reply into a Document); the artifacts service has `deleteArtifact` (`services/artifacts/record.ts`) but there is **no
delete route and no delete control** anywhere in the panel; an open Document already has a deleted state
(`artifacts.document.deleted.*`, "Mentés új dokumentumként").

**Agent G2-B runs at the same time** on the Document's phone touch targets, prose details, the review bar's laptop layout,
the comment filter and the refusal Dismiss motion (`document/DocumentBody.svelte`'s CSS, the prose stylesheet,
`MobileToolbar.svelte`, `ReviewBar.svelte`, `MarginPanel.svelte`, `RefusalNotice.svelte`, chip selects, task checkboxes):
stay out of those.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g2a`, branch
  `polish/artifacts-delete`, e2e port **5510**, label `g2a`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g2a-report.md`
- Screenshots: `…/scratchpad/rd/shots/g2a/` (same scratchpad as the report).
- Read first: `rd/common.md`; the hand-off sections of `rd/g1a-report.md` and `rd/g1b-report.md` (merged just before you),
  `rd/rd5a-report.md` and `rd/fxd-report.md` (the card), `rd/rd5b-report.md` (the App); AGENTS.md's Artifacts section (the
  facade rule; `generated_output` is never re-typed; the panel is `DocumentWorkspace.svelte`).

## 1 · Delete

- A thin `DELETE /api/artifacts/[id]` route (`requireApiUser`, the facade's ownership scope, `?conversationId=` for an
  incognito conversation per ruling 51, `{ ok: true }` per ruling 49, a foreign and a missing id answer the same 404 body)
  over `deleteArtifact`, after checking it removes the child rows (versions, comments, kv, review state, semantic
  embeddings, links) — test that.
- A Delete control for every artifact kind opened in the panel (Documents, including those made by "Open as document",
  and Apps): in the panel header's actions, behind an inline confirm popover (the header's popover pattern, focus-trapped,
  a sheet on phones) that names what is deleted ("Delete this document? It can't be undone." / HU). After delete: close
  the item, back to the list, a short toast. Also a Delete in each panel-list row's overflow, and — if the Knowledge →
  Documents list offers Delete for files — the same for artifact rows.
- Produced files (the File kind, `generated_output`): if a deletion path exists for them (Knowledge/chat files), use it
  from the File panel too; if not, say so in the report rather than inventing a second store.

## 2 · The deleted state (moved here from G1-B)

Every chat row or card that points at something deleted says so, muted, with no Open: the in-chat artifact card ("Ez a
dokumentum törölve lett" / "This document was deleted", per kind) and the generated-file rows ("A fájl törölve lett" /
"The file has been deleted"). Server signal: the conversation-detail read model returns the ids of artifacts and produced
files that this conversation's tool calls or keep-as-document actions refer to and that no longer exist, under the
ownership scope (facade only). Live: an Open that answers 404 flips the row/card to deleted without opening the panel.

## 3 · Regenerate

Each deleted row/card offers Regenerate where a stored source exists, and says why not where none does:
- a Document made by "Open as document" → run the same keep-as-document action on the same message again;
- a Document made by `create_artifact` → create it again from the stored tool input (the model's own arguments);
- an App → the App's existing regeneration path from the stored brief (within `create_artifact`'s budget; ruling 52/53);
- a produced file → a new file-production job from the stored request (the job ledger's `request_json`), through the
  file-production facade.
The regenerated item replaces the deleted state on that row/card. If one path is disproportionate (for example a server
mechanism that does not exist), build the others and report that one with a concrete proposal.

## 4 · Two small leftovers from G1-B (read `rd/g1b-report.md`)

- G1-B made every version the server reports flow through one announcement in `src/lib/client/api/artifacts.ts`, kept by
  the chat page. The header's "edited N min ago" and the list row's relative time still read the open-time snapshot's
  `updatedAt`: announce it with the version so they stay live. Announce deletions through the same channel, so an open
  list/card flips to deleted at once.
- A restored version's summary reads "visszaállítva: Szerkesztve" (restored + the old summary); make it name the
  version it came from ("Visszaállítva: v3" / "Restored v3"), localized as G1-B's shared summary vocabulary does.

## Proof

Tests first: the route's ownership/incognito/404 tests and cascade; the confirm flow; the deleted-state projection
(including another user's artifact and an incognito conversation); each Regenerate path; the 404-on-Open flip. Every
artifact suite at the end (`rd/common.md` gate 4). Screenshots in Hungarian, looked at yourself: the delete confirm, the
list after deleting, a deleted card and a deleted file row with Regenerate, the regenerated result.
