# RV-7 — Knowledge Documents tab and Workspace Search review

**Reviewer:** RV-7 (independent, adversarial). **Base:** `feat/artifacts-s7` at `50fffbf9` (7 commits on
`c7c7587f`). **Scope:** the Knowledge page's Documents tab and Workspace Search listing, filtering, searching
and opening the four artifact-family kinds (Document, App, Canvas, Slides) alongside uploads, produced files and
Skill Notes — `knowledge/store/documents.ts`, `knowledge.ts`, `workspace-search.ts`,
`knowledge/_components/documents-table.ts` + `DocumentsList.svelte`, `knowledge/_helpers.ts`,
`search/SearchModal.svelte`, `i18n/knowledge.ts`, and the containment guard.

## Verdict

**Hold is not warranted; ship with the two fixes below already applied.** Two real, independently provable
defects were found and fixed test-first, each on its own commit. The first is the edge the task brief predicted:
the artifact family's ownership condition did not get the same "no live conversation, no return" rule
`generated_output`/`work_capsule` already have, so a preserved (not hard-deleted) artifact-family row could
resurface for its owner — including one born inside an incognito conversation — the moment its own conversation
was gone. The second is a real, if quieter, regression in the merged listing's sort: the union's search
tie-break was hardcoded to date-descending regardless of the caller's chosen sort key, silently reordering
*every* row, old and new, whenever two results tied on relevance — contradicting the slice's own "byte-identical
below the new branch" promise. Everything else this slice touches — the artifact-family candidate loader and its
two-layer App-content exclusion, `scoreDocument`'s guard, `countsByKind`/`kindFilter` threading, the Documents
tab's chip row/version column/hidden actions, `SearchModal.svelte`'s badge and icon branches, `toWorkspaceDocument`,
and every new i18n key — was read against its own contract and found correct. One design question (chip-row DOM
position) is recorded below rather than patched, because the spec disagrees with itself about the intended order
and picking a side unilaterally would trade one deviation for another.

## Findings

| # | Severity | File:line | Impact | Test | Commit |
|---|---|---|---|---|---|
| 1 | Critical (containment) | `src/lib/server/services/knowledge/store/core.ts:212-224,231-256` (`buildArtifactCanonicalOwnershipCondition`, `isArtifactCanonicallyOwned`) | `type: "artifact"` rows (Document/App/Canvas/Slides) were excluded from neither function's "requires a live conversation link" rule — only `generated_output`/`work_capsule` were. `deleteConversationWithCleanup` (`cleanup/conversation-cleanup.ts`) **preserves** (does not hard-delete) an artifact-family row that has any reference from outside its conversation (a fork's copied `artifact_links` row, a cross-conversation evidence link); preserving does not keep the conversation link alive (`conversation_id` is `ON DELETE SET NULL`), so the moment the owning conversation is deleted, the preserved row's `conversation_id` goes to `null` and it fell through to the generic `artifact.userId === userId` stamp — resurfacing in `listLogicalDocumentsPage`/`searchWorkspace` for its owner. This directly contradicts slice-7.md's own Failure-modes claim ("identical to how a `generated_output` row already behaves") and ruling 51, and is exploitable with a row that started life inside an **incognito** conversation. `isArtifactDeletableByUser` is unaffected (userId stamp alone is sufficient for deletion), so the row stays cleanable even though it is no longer retrievable. | `tests/cross-cutting/incognito-artifact-containment.test.ts` — "an incognito artifact preserved by an outside reference, after its conversation is deleted" | `01e1754f` |
| 2 | Medium-High (regression) | `src/lib/server/services/knowledge/store/documents.ts:1040-1053` (`listLogicalDocumentsPage`, the merged sort) | The merge's search path sorted by `right.score - left.score \|\| compareKnowledgeDocumentItems(..., "date", "desc")` — a **hardcoded** tie-break, ignoring whatever `sortKey`/`sortDirection` the caller actually asked for. The single-source comparator this slice retired (`sortLogicalDocumentRecordEntries`) instead fell through to the **caller's own** `sortKey`/`sortDirection` whenever two entries tied on score, only short-circuiting to score order when scores actually differed. This silently reorders every row — old and new alike — the moment two search results tie on relevance (two rows with the identical name is the easy case), contradicting the Global Constraints' "byte-identical below the new branch" promise and Review Focus #4 ("zero regression for uploaded, produced and Skill Note rows"). | `src/lib/server/services/knowledge/store/logical-document-page-total.test.ts` — "keeps the caller's own sortKey as the search tie-break, not a hardcoded date order" | `4865aa24` |

## Reviewed and found correct (no defect)

- **Ownership on every new branch** (hunt #2): `loadArtifactFamilyDocumentEntries`, `loadMatchingArtifactFamilyCandidateRows` and `selectSingleArtifactFamilyRow` all apply the same two-step pattern every other query in these files uses (`buildArtifactVisibilityCondition` in SQL, `isArtifactCanonicallyOwned` post-filter in JS) — no new scoping rule, no bypass. `workspace-search.test.ts`'s new "excludes a candidate that isArtifactCanonicallyOwned refuses" case exercises this directly for the new loader specifically, not just by inheritance.
- **An App's body never leaks** (hunt #2, Review Focus #3): enforced at two independent layers exactly as the plan requires — the candidate loader's SQL excludes `contentText`/`summary` matches when `metadata_json.artifactType = 'app'` (name matches still work), and `scoreDocument`'s per-family-member loop separately `continue`s on `document.kind === "app"` before it can re-score content/summary. `familyArtifactIds` for an App is `[row.id]` only, so `textRows` is fetched for it (a minor, harmless extra read) but never scored or surfaced. The Documents tab's own search never reads body content for any kind, old or new (`scoreLogicalDocumentRecordForSearch`/`scoreArtifactFamilyRowForSearch` both stop at name/label/summary/role), so it has no equivalent risk.
- **Pagination/count agreement** (hunt #3): `countsByKind` is tallied on the query-filtered-but-not-yet-`kindFilter`-filtered union, strictly before the `kindFilter` narrowing step — verified with the existing mixed-row-type test in `logical-document-page-total.test.ts` (a chip click never moves the other chips' own counts) and a fresh `limit: 1` walk across an upload, a produced file and two artifact-family rows that visits all four exactly once. `getKnowledgeLibraryPage` re-fetches with a corrected offset when the requested page is out of range, reusing the same `kindFilter` both times.
- **No regression for uploaded/produced/Skill Note rows** (hunt #4), beyond Finding 2: every touched function's old path is a byte-identical branch below a new `type === "artifact"`/`document.kind` guard — confirmed by reading `getLogicalDocumentForArtifact`, `getDocumentKind`, `documentTypeFilterFor`, `toWorkspaceDocument`, and `documentBadgeKey` against their pre-slice bodies. `documents-table.ts`'s **client-side** local-search/sort fallback (used only when `DocumentsList` is not `serverManaged`, which the real Knowledge page always is) already had the correct score-then-caller's-sortKey fall-through and was untouched by this slice — Finding 2 was isolated to the new **server-side** merge only.
- **Opening** (hunt #5): `toWorkspaceDocument`'s new branch sets `kind` directly from the loaded item and skips `resolveWorkingDocumentIdentity` entirely, as documented. Traced the URL-handoff path end to end (`buildKnowledgeWorkspaceHref` → `getKnowledgeWorkspaceDocumentFromUrl` → `KnowledgeWorkspaceCoordinator.openHandoffDocument` → `getWorkspaceDocumentForArtifact`): `resolveWorkingDocumentIdentity` (browser copy) degrades gracefully for a `kind`-bearing item (`familyArtifactIds: [row.id]`, `promptArtifactId: null`, `sourceChatFileId: undefined`) and correctly resolves `family.artifactIds = [row.id]`, so the local lookup finds it; the network fallback (`/api/knowledge/documents/resolve` → the fixed `getLogicalDocumentForArtifact`) also correctly threads `kind`. Chip row is a real `<button aria-pressed>` per entry, in `DOCUMENT_TYPE_FILTER_ORDER`; `.documents-filter-chips` is `flex-wrap: wrap` with `--space-xs` gap and no `overflow-x`, matching the mobile-wrap requirement; the summary line is a plain `<p>` that wraps naturally. Confirmed (by reading `artifact-bodies.ts` and `DocumentWorkspace.svelte`'s `{#if activeArtifactBodyLoader}` gate) that a listed kind with no registered editor on this branch degrades to the existing File-preview path rather than crashing — see Open Questions.
- **Labels and i18n** (hunt #6): grepped the full `c7c7587f..50fffbf9` diff for the literal word "artifact" in any `.svelte` file — every hit is a code identifier, a CSS class, or a comment, never a `$t(...)` argument, `aria-label`, or `title`. The six chip labels (`knowledge.documents.filter.*`) match the orchestrator amendment's category nouns exactly, in EN and HU, and are deliberately distinct from the singular `artifacts.type.*` labels the Type pill reuses. `knowledge.documents.count.file` is correctly absent (dropped per the amendment). `SearchRowKind` and `ArtifactKind` are never read from each other (verified by reading every new branch); `KnowledgeDocumentItem.versionNumber` (extraction family) and `.artifactVersionNumber` (artifact family) are read by two separate functions that never cross-reference the other's field, including a synthetic test asserting `deriveArtifactVersionBadge` ignores `versionNumber`/`documentFamilyId` even when both are populated on the same row.

## Open questions

1. **Chip-row DOM/tab order disagrees with itself across the spec's own sources.** `slice-7.md`'s Contracts text
   says the chip row goes "immediately after the search input in DOM/tab order and before the sort control," but
   the actual mockup (`claude-at-home-2-artifact-surfaces-mockups.html` §4) renders `krow` → `toolbar` (search +
   sort + Upload) → `fchips` — chips *after* both, not sandwiched between them. The implementation
   (`DocumentsList.svelte:1300-1326`) puts the chip row and summary line *before* the search input entirely (its
   own comment: "Placed before the search/sort toolbar, which the empty state hides entirely, so this is the
   earliest tab stop either way"), matching neither reading exactly. Functionally this is not a defect — the
   chip row is still a real, fully reachable `aria-pressed` tab-stop sequence, satisfying the Verification
   checklist's explicit requirement — but the *exact* keyboard position relative to search/sort is genuinely
   ambiguous in the spec, and I did not pick a side and patch it, since either reordering is just as defensible
   as the other and neither is clearly "the bug." Recommend the orchestrator confirm the intended order once,
   directly against the mockup or a fresh screenshot, rather than leaving three different answers on record.
2. **A listed kind with no registered editor is a live, present-tense condition on this exact branch, not just a
   future risk.** `src/lib/components/artifacts/artifact-bodies.ts` on this branch registers **only** `app` —
   `document` is absent even though Slice 1 (Document) is an ancestor of `c7c7587f` on a *different* line of
   Feature 2's parallel integration branches (confirmed: `f211f9fd` "Record the Slice 1 merge" is an ancestor of
   `c7c7587f`, but the actual code merge commit `27a614e6` "Merge Slice 1 (Document) into the artifact chat-card
   branch," which *does* register `document:`, is not). Concretely: a "Document"-kind row opens to the panel's
   generic File-preview fallback today, not a real editor, on this reviewed tree. I confirmed this degrades
   gracefully (`DocumentWorkspace.svelte`'s `{#if activeArtifactBodyLoader}` gate, false for an unregistered
   kind, falls through to the existing preview path — no crash observed or expected from the code path), so this
   is not a Slice 7 defect (the file is explicitly and correctly untouched by this slice, and the risk is
   pre-flagged in slice-7.md's own Risks table for the orchestrator to resolve via merge sequencing) — flagging
   it here only because it is a real, checkable fact about *this* tree's current opening behavior, not a
   hypothetical.

## Gate summary

```
gates rv-7 at 4865aa24 fix(knowledge): stop the merged listing's search tie-break over — start 13:23:40
check      exit=0 :: COMPLETED 7814 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=0 :: Checked 2021 files in 891ms. No fixes applied.
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 844 passed | 1 skipped (845)  Tests 12806 passed | 2 skipped (12808)
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ::  51 passed (1.4m)  [artifacts-panel 5, chat 11, conversation 11, knowledge 13, search-modal 11]
done 13:29:24
```

Plus `tests/cross-cutting/incognito-artifact-containment.test.ts` run in isolation: **34 passed** (baseline 33,
+1 net new — the containment fix's own regression case). Every starting number held or improved: tests
12,804 → 12,808 (net +4: my 2 new cases plus 2 pre-existing skips already in the baseline's own count), build
and Fallow numbers unchanged, Playwright unchanged at 51/51.

`npm run lint` was not used (broken by nested worktrees, per the plan's own note); `npx biome check src scripts
tests` is the substitute and is clean.

**Branch HEAD:** `4865aa24` on `feat/artifacts-s7-review`, 2 commits ahead of `50fffbf9` (9 ahead of `c7c7587f`).
