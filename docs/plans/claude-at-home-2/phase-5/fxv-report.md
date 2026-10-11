# FX-V report: the fixes for RV-V (6 Important, 12 Minor), plus the coordinator's Hungarian-summary item

Model: Sonnet 5.5 (`claude-sonnet-5-5`). Branch `fix/versioning-review` (worktree `art-fxv`), commits `a8a5eecd..571afd65` (20 commits, 61 files, +3,084 / -149). Nothing pushed, merged or rebased.

**Status: DONE_WITH_CONCERNS.** All six Importants are fixed (I-6 confirmed), every Minor but M-11 is done (one sub-item of M-10 left, with its reason), the coordinator's item is done. The concerns: (1) the gate run showed one failure in a spec I did not touch (a `@smoke` fake-provider turn that timed out under the other agent's load; it passes alone), (2) the live App route still trusts what its writers stored (below), and (3) two small commits came after the gate run (below, with what I re-ran).

## I-2 first (ruling 58, for the Opus re-check): every writer of an App's body, and where each runs the current audit

`appViolations(html)` (`services/artifacts/app/audit.ts:295`) is now the one answer to "does the product run this body?": the failing checks among the rules whose severity is `violation` (self-navigation, WebRTC; a glitch is not one). It is pure and linear (the audit's tag regexes are bounded).

| # | Path that writes an App's body | Writes through | Audit that runs before the write |
|---|---|---|---|
| 1 | `create_artifact` (App) | `createAppFromBrief` -> `createArtifact` (`app/create.ts:99`) | `generate.ts:468` (`auditAppHtml`), `:473-491` retry once with the violation named, then refuse `contract_violation`. **New:** `generate-and-verify.ts:97` audits the verification pass's *repaired* html (see below) |
| 2 | Regenerate after delete (`POST /api/conversations/[id]/artifacts/[artifactId]/regenerate`) | `recreateArtifactFromStoredCall` -> the same create handler, under the old id -> #1 | same as #1 |
| 3 | The panel's rebuild (`POST /api/artifacts/[id]/app/regenerate`) | `regenerateApp` -> `updateArtifactBody` (`app/regenerate.ts:110`) | same as #1 (`generateAndVerifyApp`) |
| 4 | **Restore**, and an App rebuild's toast Undo (`undoOf`) | `restoreVersion` -> `updateArtifactBody` (`versions.ts:219`) | **New:** `versions.ts:170`, `not_runnable`; the restore route answers 422 (`restore/+server.ts`) |
| 5 | A reader's own save of an App's body (no UI offers one; `PATCH /api/artifacts/[id]/body` takes any signed-in client's) | `updateArtifactBody` (`body/+server.ts:171`) | **New:** `body/+server.ts:135`, 422 `not_runnable`, after the scoped read so an out-of-scope id still answers the plain 404 |
| - | The board's App block | writes none: its data is `{ artifactId, title, poster? }` (`shared/artifacts/canvas-blocks.ts:461`) | n/a |
| - | `applyArtifactOps` / `POST .../ops` | no App branch in `OPS_BRANCHES`: a 400 | n/a |
| - | `edit_artifact` on an App | refused: "Apps are not edited in place" (`edit.ts:543`) | n/a |
| - | An Alfy comment reply | refused for an App (`not_a_document`) | n/a |
| - | `keepMessageAsDocument`, `createDocumentArtifact` | Documents only | n/a |
| - | Conversation fork | copies only `generated_output` rows (`conversation-forks.ts:764`), never a family item | n/a |

Serving side: the saved-version route `versions/[versionId]/app/+server.ts:49` now asks `appViolations` (same check as before, one definition); **the live App route `app/+server.ts` does not ask**, it serves what the writers above stored. A comment on `appViolations` says so: a new writer must ask before it writes (also in AGENTS.md).

What I found beyond the finding's own repro:
- **A real unaudited writer:** `verifyApp` may hand back a *repaired* document the model wrote after `generateApp`'s audit, and `generateAndVerifyApp` shipped it (`finalHtml = repairedHtml`) with no audit. The repair is now audited the same way and a violating repair is refused like any refused repair: the audited original ships, the verdict becomes `uncertain`, the findings stay for Alfy's note (`generate-and-verify.test.ts`, red first).
- **`PATCH /body` for an App** took any body unaudited (#5 above).
- **Restore** itself (#4), the finding.

Decisions and residuals for the re-check:
- I did **not** put the audit in `createArtifact`/`updateArtifactBody` as a chokepoint: three e2e specs (`artifact-app.spec.ts`, `artifact-canvas-app-drag.spec.ts`, `artifact-history.spec.ts`) seed deliberately violating Apps through the service to prove the tripwire and History's Code-only handling, which a chokepoint would make impossible. The writers each ask instead.
- I did **not** add a serve-time refusal to the live route: it contradicts Owner decision 9 for Apps stored before ruling 58 and needs a localized frame state. So an App stored with a violation (before the rules, or by a path nobody knows of) still runs; the parent's tripwire stays the net. I looked for such paths (grep over every `insert(artifacts)` / `insert(artifactVersions)` / `contentText` write) and found the five above.
- Restoring an App version leaves `metadata.verification` / `glitchRuleIds` describing the version that was live before (the review mentions this in passing). Pre-existing, not changed.
- The restore refusal also covers the toast's Undo of a rebuild whose target is a pre-ruling-58 violating version: the panel then shows its generic "couldn't undo".

## The Importants (one commit each; red first, seen failing)

| # | What | Commit | Red-first evidence |
|---|---|---|---|
| I-1 | `HistoryMode.svelte`: the guard (`restoreGuard`) is the newest version the question was asked over, taken in `askRestore`, never read at confirm. `refresh()` that sees a newer version while the question is open turns it into "It changed while you were looking. Here's the latest." and guards the next press with what the rail then shows (so one more press, on the new state, confirms). The server conflict path re-arms from the refreshed rail. | `d9464f2b` | `artifact-history-live.spec.ts`: a real `edit_artifact` call in the same chat while the question is open (the question had only gained "Alfy's change waiting for you goes with it"), and the T5 case: an autosave delayed past History's 4 s flush budget lands after it opened (both red on the unfixed tree, green after) |
| I-2 | Server refuses `not_runnable`; History offers no Restore on a Code-only version and says why ("It can't run any more, so it can't be restored." / "Már nem futtatható, ezért nem állítható vissza."); the server's answer is worded if a press gets there first; the writers above. | `5706e807` | service tests (violation refused, nothing written; clean restores; a Document with the same text restores; an App rebuild's Undo onto a violating version refused), route tests (422), repair test, body-route tests, the Code-only e2e (Restore present on the forbidden version before), and an e2e that POSTs the restore and finds 422, three versions, the live App still the third |
| I-3 | Undo/Redo name a RANGE: `Undid Alfy's changes: v2 to v3` (also Redo); `summaryFromVersion` on the body route; the board controller names the run it took back (`toVersion + 1` to `latestAlfyVersion`) and its Redo the same; `document-autosave.ts` merges the Undos of an "Undo all" into one range; `deriveMoments` reads a numbered Undo/Redo as acting on every version in its range, so each Alfy version in it is Undone (a Document by what the Undo put back of each change). Rows that name one version read as they did. | `5e1ed2da`, then `571afd65` | the probe in derive tests (board and Document); a real "Undo all" on the review bar (saved `Undid Alfy's change: v3`, v2 read Kept before); controller/autosave/route tests. **`571afd65`** (after the gate run): an Undo that names ONE version over the body below an unbroken run of Alfy's rows is read as naming the run, so the review's probe *as written* (`v4 "Undid Alfy's change: v3"`, body = v1) also reads v2 and v3 Undone, whoever wrote the row (an older browser tab, or the code before this fix). The markers read the page's own classification. |
| I-4 | `landOnTop` selects the entry that holds the newest row (`newestEntryKey`, the step of a fold) and goes back to All; "Now" is printed once, on the entry whose own row is the newest (`entryIsNow`; a turn's newest step does not repeat its moment's); the accessible name follows. | `dd34507a` | real-input e2e of the review's repro: restore, the toast's Undo, then Name: the step selected, one `.marker-now`, only v4 named (red: the undone restore was selected) |
| I-5 | In a preview the bar reads "Runs sandboxed · no internet · read-only" / "Homokozóban fut · nincs internet · csak olvasható" (`artifacts.app.sandboxBarPreview`); nothing else in the bar changed, the live bar is as it was. | `7eea581b` | unit tests (EN, HU, live bar unchanged) and the T6 e2e asserts it in the real frame (red before) |
| I-6 | Confirmed: `check:artifact-chunks` exit 0, editor closure 70.9 kB gzip (ceiling 72,704 B), chat route 550,942 B gzip printed as information only. | - | the gate's `chunks` step and my own build before it |

## The Minors

| # | Status | Commit | Notes |
|---|---|---|---|
| M-1 | done | `9dd29be5` | a time up to a minute ahead of the rail's clock is "just now" (the clock ticks every 30 s), and the clock catches up on every refresh |
| M-2 | done | `885de224` | the Insert menu's chat rows print no number; with the VB-3 leftovers: the dead `artifactTypeAndVersion` snippet, its two pill styles (a leftover rule would have been a new "Unused CSS selector"), and `artifacts.card.version`, `artifacts.card.versionA11y`, `artifacts.canvas.chat.version` in both languages |
| M-3 | done | `fef19373` | `toWorkspaceDocument` passes `updatedAt`, `lastAuthor`, `lastKind`; the e2e opens a seeded Document from the Documents tab and finds the History button (red before) |
| M-4 | done | `71b149cf` | a later restore to the change, or to a version between it and its Undo, ends "Undone": the status is none (Kept would claim a review decision the reader did not make) |
| M-5 | done | `f8df655f` | `CanvasBoardContext.preview` (a getter on the board, its own prop); `AppNode` in a preview draws its poster or a card ("The App runs on the live board, not in History." / HU), no frame, no read of the App's data, no subscription; e2e with a counter App block (red: a frame was there) |
| M-6 | done | `d22796ad` | the read-only bridge rejects with the code `ALFY_STORAGE_READ_ONLY` |
| M-7 | done | `db64bd74` | the Document activity carries the call's `versionId`; the landing looks it up in the reload's version list (fallback: the newest) |
| M-8 | done | `a7d8a535` | the restore service/route/shared type say the `kind` of row written; the client announces it (an older server: the old guess) |
| M-9 | done | `59c94648` | the sheet's title steps aside while a preview is pushed (History named once); in a preview the zoom control stays in the corner (`stackedZoom` is for a toolbar a preview does not have; that was why it sat 68 px up over the Sunday frame); tags hang wholly above their block. Phone e2e measures it with real boxes (printed "History" words, zoom control against every block, each tag against its block) |
| M-10 | done, one sub-item left | `df3180b0` | `readReview` result cached per (artifact, newest row and hash, marker, kept blocks), version numbers only, 500 entries; the versions list is capped at 100. **Left:** the App preview's HEAD probe still repeats the read and the audit before the frame's GET. It is how the preview learns of a 422 (a frame cannot see one); moving the answer into the history page would put the audit on every row of every page. |
| M-11 | nothing to do | - | |
| M-12 | done | `3ac3e11f` | the three Hungarian lines (empty history, too-large, the help as sentences naming the buttons by their labels) |

Coordinator's item (Q8, Hungarian summary): `fc379119`. The `summary` field's description on `edit_artifact` now carries a Hungarian example of each acceptable shape ("Áttette a múzeumot csütörtökre", "Esős napi terv hozzáadva") and the one to avoid ("Áttettem …"). Measured (ruling 23), frozen snapshots moved in the same commit: `tool-catalogue.en.snapshot.txt` 72,946 B to 73,065 B (+119), `tool-catalogue.hu.snapshot.txt` 78,219 B to 78,338 B (+119); the catalogue budget (top-level descriptions, what the ceiling counts) 5,110 / 8,256 before and after, ceilings 5,136 / 8,283 untouched. The snapshot test was seen red before `-u`.

Also: `ed087133` records the new rules in AGENTS.md (restore guard, newest-row landing, inert preview, ranges, review cache, the App-body audit rule); `582e25dc` pins that `not_runnable` reaches the page by its reason (a test only; no gesture can send it now).

## Gates (`scripts/gates.sh agent <out> --port 5400 --workers 4`, at `ed087133`, 4 min 50 s; logs in `p5/fxv-gate-1/`)

```
check      ok  0 errors, 17 warnings in 8453 files
biome      ok  2609 files
migrations ok
vitest     ok  1056 files passed | 1 skipped; 17,809 tests passed | 2 skipped (baseline 17,408: +401 across the batch and the fixes)
build      ok  unused-css=32 aria=2 (baseline 32/2)
chunks     ok  editor closure 70.9 kB gzip; chat route first paint 550,942 B gzip in 82 chunks (information only)
fallow     ok  total=124 circular=4 new_vs_baseline=0
playwright FAIL 114 passed, 3 skipped, 1 failed, 0 flaky on 4 workers
```

Specs in the run: `artifact-history`, `artifact-versions`, `artifact-app`, `artifact-canvas-review`, `artifact-document-review-bar`, `knowledge`, `artifact-canvas-blocks` (the Insert menu's chat blocks), the two I added (`artifact-history-live`, `artifact-history-presses`), plus the `@smoke` set. The one failure: `artifact-chat-card.spec.ts:217` ("shows the card during the turn ... survives a reload", `@smoke`, a fake-provider turn I did not touch) timed out waiting 30 s for the reply text while the machine's load average was 7.6 to 9 (the other agent's builds). Rerun alone on the same production build: 8/8 of the file pass, that test in 2.7 s.

After the gate run, two commits: `582e25dc` (a unit test) and `571afd65` (the derivation inference, server-only). Re-verified: `npm run check` 0 errors / 17 warnings, `biome check src scripts tests` clean, vitest over `services/artifacts`, `components/artifacts/history` and `routes/api/artifacts` (1,053 tests) green, and the five History-related specs (`artifact-history`, `artifact-versions`, `artifact-history-presses`, `artifact-history-live`, `artifact-canvas-review`) rerun on `vite dev`: 42 passed. Fallow not rerun (no new export in either commit).

## Tests added or changed

- New e2e: `artifact-history-live.spec.ts` (2: a real Alfy edit while the question is open; a save outlasting the flush budget), `artifact-history-presses.spec.ts` (3: Undo all, the toast's Undo and Name, a board preview's App block). Changed e2e: `artifact-history.spec.ts` (Code-only, a restore request refused, the preview's bar, the phone sheet's title, the phone board's geometry), `knowledge.spec.ts` (the library's History button).
- New unit files: `generate-and-verify.test.ts`. Extended: `audit`, `versions` (service), `restore`/`body` routes, `versioning.routes`, `version-summaries`, `derive` (+14), `rail-model`, `moment-text`, `AppFrame`, `chat-block-nodes`, `chat-block-data`, `ChatBlocksSection`, `document-autosave`, `review-controller`, `alfy-activity`, `DocumentBody`, `bootstrap`, `history` (service, a spied review), `knowledge/_helpers`, `client/api/artifacts`.
- Existing tests changed because the contract changed on purpose: the restore result carries `kind`; the App/file chat rows no longer print `v{n}`; the artifact-family workspace item carries the latest moment; the preview's bar text; `parseRedidAlfyChange` returns `{ version, fromVersion? }`.

## Screenshots (`p5/fxv-shots/`, each looked at)

- `i2-code-only-no-restore-en-1440.png`: the forbidden App version selected: no Restore, "It can't run any more, so it can't be restored." where the button was, and the Code-only line.
- `i5-preview-bar-read-only-en-1440.png`: the preview's bar reads "... · read-only" under "changes aren't saved".
- `i4-after-toast-undo-en-1440.png`: after the toast's Undo the step "You undid the restore" is selected, with one "Now", the toolbar says "This is how it looks now".
- `m9-board-preview-phone-en-390.png`: the pushed phone preview names History once; the tags hang above their blocks; the zoom control is clear of the Sunday frame.
  (English and light only; the Hungarian strings are pinned by tests, not seen on screen.)

## Deviations from the brief, and decisions

1. **I-1:** the brief offered "capture at ask" or "refresh turns the question into the moved state"; both are in. After the moved line shows, the guard is re-armed to what the rail shows, so the next press confirms on that state (the line and the refreshed rail are what the reader saw before pressing); a press before the refresh completes is still refused by the server.
2. **I-3:** the brief says old rows that name one version still read as before *and* that the review's probe (v4 undo of v3, body = v1) reads v2 and v3 Undone. Both hold: new rows name ranges; a row that names one version reads as before unless its text is the text below a run of Alfy's rows, in which case it took the run back (`571afd65`). The Document's range is the span of the versions undone in one save (min to max); coverage per block keeps a Document's statuses honest if a version in the span was not touched.
3. **I-4:** `landOnTop` also resets the filter to All (a version made by a press is never named, so the Named filter would not list it). Opening History still selects the top moment, as before (an existing smoke test relies on it); only a write moves the selection to the newest-row entry.
4. **M-4:** the status after a restore-to-the-change is none, not Kept.
5. **M-5:** the inert block is a poster or a card; I did not make a read-only live frame (no live data was the brief's line).
6. A board in a preview has no editor-chunk cost beyond a getter and one condition: the chunk gate passes with room (70.9 kB of 72,704 B); I measured with a build before the gates.

## Hand-off (what the next agent builds on)

- `appViolations` (`services/artifacts/app/audit.ts`); `RestoreMomentKind` and `RestoreVersionResponse.kind` (`shared/artifacts/history.ts`); `undidAlfyChangeSummary(newest, first?)`, `redidAlfyChangeSummary(newest, first?)`, `ClassifiedSummary.fromVersion`, `saveSummaryFor(kind, newest, first)`; the body route's `summaryFromVersion` and the client guard's `summaryFromVersion`.
- `newestEntryKey`, `entryIsNow` (`history/rail-model.ts`); `HistoryPreviewState.codeOnly`; `CanvasBoardContext.preview`; `DocumentAlfyActivity.versionId`.
- A restore that is for an App is the one place a version body goes back into service: any new path doing that must call `appViolations` first.
