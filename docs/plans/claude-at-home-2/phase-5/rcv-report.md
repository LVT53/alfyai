# RC-V: Opus re-check of FX-V's restore guard (I-1) and ruling 58's App audit (I-2)

Model: Opus 5.5 (`claude-opus-5-5`). Tree: `571afd65` (worktree `rc-v`, detached), diff `a8a5eecd..571afd65`. Report only. Nothing was fixed or committed.

**Verdict: ready for `dev`.** Both guard fixes do what the review asked. I found no Critical and no Important problems. There are two Minor findings, which a later pass can take:
- **M-1** is a gap in the restore guard that FX-V's tests do not reach: a late save that coalesces into the newest version.
- **M-2** is a dead Restore button during the App preview's probe.

Neither one loses words, and neither puts unaudited code into service.

**What I ran:**
- FX-V's `artifact-history-live.spec.ts` on `vite dev` :5490 (the fake provider needs dev): 2/2 passed.
- Three variations in a temporary spec, all with real input. The spec is deleted.
- The targeted unit tests: 9 files, 239 passed (versions, the restore route, the body route, audit, generate-and-verify, derive, review-controller, document-autosave, rail-model).

The server is stopped, `git status` is clean, and `test-results/` is empty. Logs and one screenshot are in `p5/rcv/`.

---

## Check 1: I-1, the restore guard

**Holds.**

How the fix works now:
- **The guard is taken when the question opens.** `HistoryMode.svelte:656–661` sets `restoreGuard = newestVersion` in `askRestore`. Both Restore buttons (the toolbar `:877` and the phone bar `:1104`) go through `askRestore`.
- **The request sends only that guard.** `:709` sends `{ expectVersion: restoreGuard }`. Nothing reads `newestVersion` at the moment of confirming.
- **A newer version while the question is open flips it.** If `refresh()` sees one, `:491–494` changes the question to "It changed while you were looking" and re-arms the guard to what the rail now shows.
- **A 409 does the same.** `:722–729` shows the line, refreshes and re-arms.

Why the guard cannot bury anything:
- **It only moves forward together with the line.** The only places that move it forward are the ask, a refresh that shows the "changed" line, and the 409 path, which also shows it.
- **Paging cannot move it.** `loadOlder` does not touch `newestVersion`.
- **A refresh in flight cannot move it backwards into danger.** If an older refresh resolves last, the guard can only go down, which makes the server refuse more, not less.
- **A refresh that changes the selection fails safe.** The selection effect at `:569–578` closes the question.
- **A restore's own announcement does not flip the question.** `restoreOpen` is false before `landOnTop()`, and `!restoring` covers the window while the request is in flight.

**Variation run (not in FX-V's tests), passed.** A landing that this tab hears *while the restore request is in flight*, followed by a second write this tab never hears:
1. I seeded Document v1 (Alfy) and v2 (user). In History I selected v1, pressed Restore, and held the restore POST with `page.route`.
2. I pressed Restore in the question. The request sent `{"expectVersion":2}`.
3. While the request was held, a real `edit_artifact` turn in the same chat wrote v3. The rail refreshed to 3 options. Because a restore was in flight, the "changed" line was not shown yet.
4. I released the request. It got 409, the question read "It changed while you were looking. Here's the latest.", and the server still held `[3,2,1]`.
5. I wrote v4 through the service, so this tab never heard of it, and pressed Restore again. The request sent `{"expectVersion":3}` and got 409, the line was shown again, and the rail showed 4 options.
6. On the third press the request sent `{"expectVersion":4}` and the server wrote `5: Restored v1`.

## Check 2: I-2, ruling 58

**Holds.**

- **The server refuses with the same check as the version route.**
  - `appViolations` (`app/audit.ts:295`) is the failing checks with `severity === "violation"`. It is the same set as `APP_VIOLATION_RULE_IDS`, which `generate.ts` uses, because both derive from `contract.ts`'s severities.
  - `restoreVersion` (`versions.ts:170–172`) audits `version.body`, which is the very body it then writes (`:219–228`).
  - The audit runs after the scoped `findVersion`, so an out-of-scope id still gets the plain 404.
  - It runs before the `undoOf` branch, so it also covers a rebuild's toast Undo.
  - The restore route maps the refusal to 422 (`restore/+server.ts:66–72`).
  - The version route asks the same function (`versions/[versionId]/app/+server.ts:49`).
- **History offers no Restore on a Code-only version** (`HistoryMode.svelte:263–278`). The e2e asserts that the button is gone and the note is shown. The probe window is the exception, see M-2.

**FX-V's writer table: every claim checked against the code, and it is accurate.**

| Writer | Audit |
|---|---|
| Create | `create.ts:187` → `createAppFromBrief` → `generateAndVerifyApp`, plus the generator's own retry or refusal (`generate.ts:468–491`) |
| Regenerate after delete | `recreate.ts` → `runCreateArtifactTool` with the stored brief, which regenerates the App and never re-inserts stored HTML |
| Panel rebuild | `regenerate.ts:85–118`, through `generateAndVerifyApp` |
| Repair | now audited (`generate-and-verify.ts:95–100`). A `repairedHtml` of null falls back exactly as before. |
| Restore | audited, see above |
| `PATCH /body` | audited at `body/+server.ts:135`, after `getArtifact`, on the exact `payload.body` that the App branch writes |

**I looked for a writer the list misses and found none.** The live route serves `artifacts.contentText` (`record.ts:434`). I checked every caller of the family `createArtifact` and `updateArtifactBody`, and every `insert`/`update` of `artifacts` and `artifact_versions` in `src` and `scripts`:
- `ops.ts` has only a `canvas` branch.
- `document-ops.ts` either refuses a non-Document (`readScopedDocumentRow`) or is reached only from the body route's Document branch. The same holds for `canvas-ops.ts` and the Canvas branch.
- Comment replies dispatch to the canvas or Document path.
- `edit_artifact` refuses an App.
- Forks copy `generated_output` only.
- Skill notes, capsules, extraction, `source-persistence` and readback write other types, through ids the server owns.
- No `metadataPatch` or metadata merge can flip a row's `artifactType`. All their keys are chosen by the server, so a Document's body cannot become an "App".

**Can unaudited code still reach the live route?** Not through any writer. Only these remain:
- Bodies stored before ruling 58, and the e2e specs' service seeding. The live route still does not audit at serve time, which FX-V documented as a deliberate residual under Owner decision 9.
- Code that passes the static patterns. The audit is a static pattern check, so "audited" means "passes the patterns". Ruling 58 accepts this with the tripwire as the net.

I agree these residuals are acceptable for `dev`.

## Check 3: the tests for I-3 and I-4

**They test what the review described.**
- **I-3, Document:** a real press on "Undo all" (`artifact-history-presses.spec.ts:88`). It checks one save, `Undid Alfy's changes: v2 to v3`, and that History marks both versions Undone and neither Kept.
- **I-3, derivation:** `derive.test.ts` has the review's probe exactly as written, for a board (`:942`) and for a Document. It also has the negative cases: a reader's version in between, a single-version Undo, and a range limited to its own versions.
- **I-3, board:** the run naming is tested only through `review-controller.test.ts`, with a mocked API (`summaryVersion: 3, summaryFromVersion: 2`, for both Undo and Redo). This is a nit and not a blocker: no test presses Undo on a real board over a two-version run, but the server's `toVersion` was already correct before the batch.
- **I-4:** a real-input walk (`:162`): restore, the toast's Undo, then Name. It checks that the step is selected, that there is exactly one `.marker-now`, and that only v4 is named.

---

## Critical

None.

## Important

None.

## Minor

### M-1. A late save that *coalesces* into the newest version does not trip the guard, so Restore goes through over words History never showed
`HistoryMode.svelte:538–544` and `:491` only react to a *higher* version number. `versions.ts:127–128` promises that a restore "can never silently bury … a change that landed while History was open", but `expectVersion` is a number. Ruling 47/A2 coalesces a reader's save into their own latest version without changing that number.

- **Repro (variation run, `vite dev`, real keyboard):**
  1. Seed v1 (Alfy) and v2, the reader's own "Edited" save from moments ago.
  2. Delay `PATCH …/body` by 6 s.
  3. In the editor, type " Aisle." and open History. The panel's 4 s wait runs out.
  4. Select v1 and press Restore. The question opens.
  5. The save lands and **coalesces into v2**: the server still holds `2:Edited | 1:…`. The rail stays at 2 options. The question stays "Bring back …? What you have now stays in History." with no "changed" line.
  6. Press Restore. The server answers 200 and writes `3: Restored v1`. v2's stored body now ends "Book the flight. Window seat. Aisle.". The reader never saw that text in History.
- **The same happens with the reader's second tab.** Its saves coalesce into the same version, and this tab never hears of them.
- **Why it is only Minor:**
  - It is only ever the reader's own text. Alfy's versions never coalesce, so no review decision is made silently.
  - Nothing is lost: the words are in the version directly under the restore, and the toast's Undo brings them back.
  - The no-coalescing T5 case, which is FX-V's test, is caught.
  - The gap existed before FX-V's change. The fix narrowed I-1 but does not close this case.
- **Fix direction:** guard the restore with the newest row's body hash as well. Moments already carry `bodyHash` (`shared/artifacts/history.ts:238`), and `updateArtifactBody` already refuses a stale `baseHash` as `stale`, so a restore can pass both and map `stale` to the "changed" line. Optionally, also refresh when an announcement for the same version number carries a newer edit time while the question is open. Otherwise, at least correct the promise in `versions.ts`.

### M-2. While the App preview's HEAD probe is still out, Restore is offered on a version that turns out Code-only, and the question it opens has a Restore that does nothing
`HistoryMode.svelte:263–270`: `codeOnly` is `previewState.codeOnly === true`, and `AppVersionPreview.svelte:131` starts at `runnable = "checking"`, so `canRestore` is true until the probe answers. Nothing closes an open question when `canRestore` turns false, and `confirmRestore` (`:696`) silently returns on `!canRestore`.

- **Repro (variation run, the HEAD probe delayed 4 s):**
  1. Select the violating v2. Restore is visible. Press it, and the question opens.
  2. The probe answers. The preview switches to "This version can't run any more, so only its code is shown." The question stays open, reading "Bring back today 00:16? … Saved data stays as it is now", with an **enabled** Restore button.
  3. Press it. No request is sent and nothing is written. There is no feedback, and the "can't be restored" note is not shown while the question is up. Screenshot `p5/rcv/probe-window.png`.
- **Security is not affected:** if the press had reached the server, it would have answered 422.
- **Fix direction:**
  - For an App, treat `runnable === "checking"` as not yet restorable. Expose it on `HistoryPreviewState`.
  - Close the question, or show `restoreNotRunnable` in it, when `canRestore` turns false while it is open.

## Residuals (no action asked)

- The live App route serves what is stored, without auditing it. Apps stored before ruling 58 (and the e2e specs' service seeding) still run, with the tripwire as the net (FX-V's concern 2).
- A restored App keeps the previous version's `metadata.verification` and `glitchRuleIds` (pre-existing, noted by FX-V).
- The App preview's HEAD probe still repeats the read and the audit (M-10's leftover, reasoned in FX-V's report).
