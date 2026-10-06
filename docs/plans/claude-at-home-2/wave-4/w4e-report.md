# W4-E report — Slice 5b T4: what a turn made appears in the message's Sources panel

Model: `claude-sonnet-5-5`. Branch `feat/artifacts-s5b-evidence` (from `feat/artifacts` `86a736b5`), worktree `art-w4e`, e2e port 5430.
Commit range: `86a736b5..46ec8139` (9 commits, all with the Co-Authored-By trailer; nothing pushed, merged or rebased).

```
50b81a94 Say once what an artifact tool call is about
4a6bd4cf Give what a turn made its own group in the message's evidence
942f10c5 Write what a turn made into the same evidence write as its sources
bebfb5dc Show what a turn made in the message's Sources panel
a01e7ea5 Check, with real clicks, that what a turn made is in its Sources and opens
b7a93f83 Don't tell what a turn made twice in its Sources
c53abafe Check that a Sources row of a deleted item says so instead of opening nothing
dc62d6b3 Format the Sources panel's item lists the way the linter does
46ec8139 Read a stored summary with the real reader, not a JSON round trip
```

Status: DONE_WITH_CONCERNS (the concerns are scope/decision calls listed under "Decisions to look at", not defects).

## What was built (ruling 72 scope: the widening and the "Made in this chat" group; `getArtifactSources` and `artifacts.sources.*` NOT built)

### Step 1 — the server (no new read, no new table, no migration)

- `src/lib/shared/artifacts/artifact-calls.ts` — new `artifactCallOf(call)`: the one reading of "this `create_artifact` / `edit_artifact` call made or changed that item" (refused, failed, id-less and other tools are `null`). `artifactCallsFromSegments` now goes through it, so the chat card and the Sources panel cannot drift apart on what counts as a successful call.
- `src/lib/server/services/message-evidence.ts`
  - `EvidenceSourceType` gains `"artifact"`; `GROUP_LABELS.artifact = "Made in this chat"`; `GROUP_ORDER` is web 0, document 1, **artifact 2**, tool 3, memory 4 (after document, before tool).
  - `TurnArtifactRef { artifactId, artifactKind, title }` and the private `buildTurnArtifactsGroup`: ONE group per turn, only when the turn made or changed something; items are `sourceType: "artifact"`, `status: "reference"`, `artifactId`, `description: null`, `channels: ["tool"]`, `metadata: { artifactKind }`. The body is never copied (the builder reads three fields).
  - `buildAssistantEvidenceSummary({ turnArtifacts })`; the raw Tool Outputs row of a call that the group already tells is dropped (see decision 2).
- `src/lib/server/services/chat-turn/finalize-steps.ts` — private `turnArtifactsFromToolCalls(doneToolCalls)` (through `artifactCallOf`; kind + title from the call's own metadata, title falling back to the create call's `input.title`; one entry per item, in first-touched order; only kinds that ship) passed as `turnArtifacts` in the SAME `buildAssistantEvidenceSummary` call, so the evidence write and `projectFilesRead` stay one `updateMessageEvidence`.
- `src/lib/response-activity-types.ts` — `ResponseActivitySourceType` gains the literal `"artifact"` (type only; see decision 4).

### Step 2 — the row

- `src/lib/components/chat/MessageEvidenceDetails.svelte`
  - made items leave the citation buckets and the considered/used count (`everyItem` / `madeItems` / `allItems`), and get their own section after "Also found" and before "Set aside": `<h4>` = `artifacts.evidence.madeInThisChat`, `role="group"` with the same label;
  - `isDocument()` widened: an artifact row with a known kind and an `onOpenDocument` is a button; `openDocument` now also hands the page the item's `kind` — that is what sends the chat page's `openArtifactFromChat` through the artifact read first, so a deleted item flips its card to the deleted state (exactly the card's path) instead of opening an empty panel;
  - the kind's own icon from `kind-icons.ts` (`iconFor`; `typeIconFor` has the explicit `case "artifact"` for a row that names no drawable kind) and the kind word `artifacts.type.*` after the title (also on the plain, non-clickable row); tooltip `artifacts.card.openA11y`;
  - the "· N considered, M used" line is hidden when nothing was considered (a turn that only made something);
  - 44 px min-height for the made row on coarse pointers; quiet rail + muted heading like "Also found".
- `src/lib/i18n/artifacts.ts` — one key, `artifacts.evidence.madeInThisChat`: "Made in this chat" / "Ebben a beszélgetésben készült". No other string (the row's word is `artifacts.type.*`).

## Tests (all written red first, each seen failing)

Unit (28 new): `artifact-calls.test.ts` +3; `message-evidence.test.ts` +8 (one group labelled Made in this chat; item shape; kind in metadata and no body even if a caller passes one; omitted for a turn that made nothing; never in the document group; order web/document/artifact/tool/memory; raw tool row not repeated but a refused call keeps its row; produced file stays a tool output, summary identical with and without `turnArtifacts: []`); `finalize-steps.test.ts` +8 on the real in-memory DB with the **real tools** (`create_artifact` / `read` / `edit_artifact` through `createNormalChatTools`, so the group reads the metadata the tools actually write): lists the made Document as one reference row and no raw tool row; create-then-edit is one row; refused edit and the real Slides refusal list nothing; hand-written `ok:true` Slides/File calls are not named (guard pinned); produced file never an artifact row; **made-then-deleted keeps the row**; **incognito turn: rows on its own message, another chat's message untouched**; a legacy summary (no group) still reads through `getMessageEvidenceState`; `MessageEvidenceDetails.test.ts` +9 (button opens through the page's path with `kind`; heading + kind word EN and HU for document/app/canvas; own icon vs the generic file icon; out of the citation buckets and counts; made-only turn has no considered line; stored summary has no heading; plain row when the page gave no way to open; a stamp naming no kind, or `"toString"`, is not a button).

Playwright (2 new, real clicks, existing suites):
- `tests/e2e/artifact-chat-card.spec.ts` "a Document the turn made is listed in the message's Sources, and its row opens it" — Hungarian: a real fake-provider `create_artifact` turn → the message gets "Források" without a reload → expand → heading "Ebben a beszélgetésben készült" → row named "Weekend plan Dokumentum" with `lucide-square-pen` (no `lucide-file-text`) → click → panel "Weekend plan, Dokumentum" with the Document text → reload → row still there. Seen failing first against the old component (heading missing), green with it; ran 4 times green, once inside the full suite.
- `tests/e2e/artifact-delete.spec.ts` "A Sources row of an item that was deleted … flips the card to deleted, says so, and opens nothing" — the item is deleted after the page loaded; clicking the row flips the card (`data-state="deleted"`), no panel. Mutation-checked: without the `kind` on the opened item the test fails (the page then opens the panel on a gone item). The evidence on that seeded message is hand-written (the real-turn path is the test above).
- Also measured by hand with a throwaway spec (deleted, never committed): Tab order Sources toggle → Memória → made row → message actions; `:focus-visible` outline `auto 1px rgb(0,95,204)` on the made row; Enter opens the Document; on a touch viewport (390 wide, `hasTouch`) the made row is exactly 44 px tall (31.5 px on desktop, unchanged look).

## Gates

| Gate | Result |
| --- | --- |
| `npm run check` | 0 errors, 17 warnings (the pre-existing 17) |
| `npx biome check src scripts tests` | clean (2,488 files) |
| `npm test` | 1,017 files passed (+1 skipped); 16,701 tests passed, 2 skipped. (One test was swapped for a real-reader version afterwards, net zero; targeted rerun 203/203 green.) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (baseline) |
| `npm run check:artifact-chunks` (own line) | exit 1, only the chat-route clause: first load **542,495 B gzip** (+2,887 over the 539,608 baseline; 2,048 allowed). Editor/Chart.js/MapLibre/Mermaid clauses pass; the CanvasEditor line is identical on base and mine (207.1 kB raw / 61.8 kB gzip target, 226.6 kB raw / 69.9 kB gzip exclusive closure; ceiling 71,680). **Base `86a736b5`, measured by reverting my `src` diff in the same worktree and rebuilding: 542,086 B (+2,478), also exit 1 — so my own growth is +409 B gzip.** `--chat-baseline` not moved. |
| Playwright, port 5430: `artifact*.spec.ts`, `artifacts-*.spec.ts`, knowledge, chat, conversation, `live-evidence-metadata` (525 tests, 41 min) | 501 passed, 23 skipped, 1 failed: `artifact-canvas-charts.spec.ts:648` (a Mermaid sequence diagram's SVG not drawn within 30 s in the combined run, on the `.vite` cache shared with TR-D4). Rerun alone: 25/25 passed. A suite I did not touch. |
| Fallow | 124 issues, 4 circular — unchanged, zero new findings |
| `npm run check:migrations` | passes unchanged |
| Containment suite `tests/cross-cutting/incognito-artifact-containment.test.ts` | 54 passed; no new artifact read exists, so no `ALLOWED_WITHOUT_SCOPE` entry |

## Screenshots (looked at each: Hungarian, the Sources panel with the new group)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/w4e/`
- `desktop-light-page.png`, `desktop-dark-page.png` — 1440×900
- `phone-light-page.png`, `phone-dark-page.png` — 390×844, touch, 2×
- `phone-light-longtitle.png` — a long Hungarian title wraps in the row; kind word and the open icon stay right and centred

What they show: "Források · 1 vizsgált, 0 felhasznált" / "Szintén találat (1)" (the memory row only) / "Ebben a beszélgetésben készült" with the row `[pen-square icon] Weekend plan   Dokumentum ↗`. Before the raw-tool-row change the same panel also listed a `create_artifact` row ("Created Document …", English, under "Szintén találat") — see decision 2.

## Decisions to look at (the Opus reviewer's attention)

1. **An item made and then deleted in the same turn keeps its row.** The group is read off the turn's own finished calls; nothing is queried, so there is no new artifact read. The row is a record of what the turn did (the card for it also stays, in its deleted state), it opens into the deleted state the card shows, and Regenerate re-creates the item under the SAME id so the row works again. Dropping it at finalize would need a `listMissingArtifactIds` read, and would still leave rows for items deleted a minute later: half a rule. Test: `finalize-steps.test.ts` "keeps the row of an item deleted before the turn finished…". Cost if wrong: one read through the facade's scope and a filter.
2. **Scope extension, small and revertible: the raw tool row of a call that the group tells is no longer listed.** Today every turn that calls `create_artifact` already shows a Tool Outputs row titled `create_artifact` ("Created Document …", English) in "Also found"; beside the new group it said the same thing twice under a tool name. `buildAssistantEvidenceSummary` drops completed calls whose `artifactCallOf(...).artifactId` is in `turnArtifacts`; a refused call keeps its row. To revert: delete the `madeIds`/`toolOutputCalls` filter in `message-evidence.ts` (pass `completedToolCalls` again) and the one test "does not list the call that made an item as a tool output as well…" (+ the `["artifact"]`-only assertion in `finalize-steps.test.ts`).
3. **The "kinds that ship" guard is `isShippedArtifactTourType`** (`shared/artifacts/tours.ts`), used by `finalize-steps.ts` and by the panel. Its name says "tour", but it is the repo's one client-safe list of the shipped kinds (ruling 69: Slides shelved; bringing Slides back is one entry there and the evidence group follows). I did not add a fourth list. A reviewer who dislikes the name can ask for a rename; the behaviour is pinned by the "names only kinds that ship" test (Slides and File with `ok:true` are not listed).
4. **`ResponseActivitySourceType` gains `"artifact"`** — widening `EvidenceSourceType` broke two assignments in `routes/(app)/chat/[conversationId]/_helpers.ts` (an activity row mirrors a tool call's `sourceType`). Importing `EvidenceSourceType` into `response-activity-types.ts` would add a type-only import cycle (Fallow's circular count), so the literal is added by hand with a comment; the stream validator `isResponseActivitySourceType` still accepts only the four tool values.
5. **The panel renders the group outside the citation buckets** (status `reference` is still what the data says, as the spec has it, so any other reader files it under "Also found" rather than "Cited"). Hence made rows are not "considered" and a made-only turn shows no considered/used line. The server `GROUP_LABELS.artifact` string is the data-model label; the person reads `artifacts.evidence.madeInThisChat` (the slice's own warning that the constant is not what the user sees holds).

## Known limits, not defects

- A turn with no persisted turn state (a stopped stream) writes no evidence at all today, so it has no Sources row for what it made; its chat card still shows it.
- A fork copies the evidence snapshot, so the heading "Made in this chat" in a fork's copied message refers to the original chat; the row opens through the same path as the fork's card (for an incognito fork: "Made in the original chat", via `unreachableArtifactIds`). The card has the same wording gap.
- Chat route +409 B gzip: roughly the component's new section/branches, 2 i18n strings and the `artifactCallOf` refactor; the route was already over its 2 KiB allowance on the base (FU-2 / W4-B), so the orchestrator's re-baseline should take the new figure, 542,495 B.

## Hand-off

- Exports: `artifactCallOf` (`shared/artifacts/artifact-calls.ts`); `TurnArtifactRef`, `EvidenceSourceType` `"artifact"`, the `turnArtifacts` parameter (`message-evidence.ts`). `turnArtifactsFromToolCalls` is private to `finalize-steps.ts`.
- Panel: `madeItems`, `artifactKindOf`, `iconFor`; classes `.evidence-group--made`, `.evidence-row-button--made`, `.evidence-kind`; the open path is `onOpenDocument` with `kind` set (a new row kind reuses it).
- Suggested AGENTS.md line (AGENTS.md is the orchestrator's, I did not touch it), under Artifacts: "What a turn made is evidence of the turn (Slice 5b · T4, rulings 6, 7, 72): `finalize-steps.ts` derives `turnArtifacts` from the turn's own finished `create_artifact` / `edit_artifact` calls through the shared `artifactCallOf` and `message-evidence.ts` writes ONE `artifact` group (`status: "reference"`, kind in metadata, never the body, no read). `MessageEvidenceDetails.svelte` lists it under `artifacts.evidence.madeInThisChat`, outside the citation buckets and the considered count, and a row opens through `onOpenDocument` with its `kind`, so the chat page's open path reads the item first and a deleted item shows the card's deleted state. A produced file stays `generated_output` in the Tool Outputs group (ruling 18)."
- Throwaway capture specs (`tests/e2e/zz-w4e-*.spec.ts`) were created and removed; none is in any commit; `git status` is clean.
