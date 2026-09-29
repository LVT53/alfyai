# Polish agent G1-B — Versions popover, one version number, count button, toast exit, Undo's summary

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-g1b`, branch `polish/artifacts-versions` (from `78c94588`).
Status: **DONE** (one adjacent staleness not fixed, see "Not done").
Commits `78c94588..3f7c0a76` (12):

```
98179db1 fix(artifacts): show one version number on every surface
c11096d9 feat(artifacts): record Undo of Alfy's change as its own version
6afb1718 feat(artifacts): rebuild the Versions popover to the approved mockup
426cd4a9 fix(chat): lean the artifact count button into the header's right end
50758665 feat(ui): give the toast its exit motion
4be605fc fix(artifacts): let a Versions summary wrap to two lines on touch
a2abcad4 test: register the fake versioned body's panel actions on mount
5124a47f chore: keep the save-summary table module-private
c76ed14c style: biome format the new popover and page test
06803246 docs+fix: name the new artifact boundaries (its pointer-events half is reverted by 3f7c0a76)
06e55237 test: wait for the version pill to be a button before clicking it
3f7c0a76 fix(artifacts): keep the overlaid Restore clickable while it fades in
```

## 5 · One version number everywhere — root cause first

**Root cause.** Four surfaces printed an artifact's version and each read its own copy, taken at its own moment:

| surface | where it read the number |
|---|---|
| panel list row, in-chat card | `artifacts` state on the chat page = the last conversation-detail refresh (`ThinkingBlock`'s card `preview` and `artifactToWorkspaceItem` both derive from it). Patched only by a task tick; not by user saves, Undo or restores. |
| panel header's version button | `activeDocument.versionNumber` = the item **snapshot in `workspaceDocuments`** taken when the item was opened (from the card's `body.preview`, or the list row) — and saved across reloads in the persisted workspace state. `DocumentWorkspace` resolves `documents.find(...)` **before** `availableDocuments`, so the fresher artifact-aware copy never won. |
| Versions popover | fresh `GET /api/artifacts/[id]/versions` on every open (the server's newest row) — the only one that was always right. |

Nothing fed `DocumentBody`'s own live `versionNumber` (updated after every save/restore/Alfy reload) back to the others.
The server side is consistent (`record.ts` is the only writer; `max(version_number)` = the list's top row; the client does no version arithmetic).

**Evidence on the unfixed code** (the new e2e walk, per step, server / header / list / card / Versions):
- user edit: v2 / **v1** / **v1** / – / v2
- Alfy live edit: v3 / **v1** / v3 / v3 / v3
- Undo: v4 / **v1** / **v3** / **v3** / v4 (and the summary saved as "Edited")

I could not reconstruct the owner's exact "v5 in the overview, v4 and no v5 in the list" from code alone (nothing can put the client ahead of the server); it is the same mechanism seen at another moment (the popover is fetched fresh, the others are stale in different ways). The walk shows three different numbers for one document at one instant.

**Fix (one source of truth = the server's newest version row, as the Versions list shows it):**
- `src/lib/client/api/artifacts.ts`: `subscribeArtifactVersions(listener)`; every response that carries a current version is announced — `fetchArtifact`, `saveArtifactBody` (ok), `saveDocumentTabs` (ok), `createDocumentCopy`, `fetchArtifactVersions` (the top row), `restoreArtifactVersion`, `regenerateApp` (success and conflict). This is the choke point every body (Document, App), the card tick and the restore toast already go through, so **no change to `DocumentBody`/`AppBody`/`DocumentWorkspace` plumbing was needed** (G1-A owns those files).
- `src/lib/client/artifact-versions.ts` (pure, tested): `observeArtifactVersion` is monotonic (a version only ever grows, so "highest heard" is exact and a late older response can never pull a surface back), `withCurrentSummaryVersion`, `withCurrentItemVersion` (skips `file` kind, whose versions are file-production's).
- Chat page: `observedArtifactVersions` (`$state.raw`) fed by one `onMount(subscribeArtifactVersions(...))`; `liveArtifacts` (rows and in-chat cards, count) and `liveWorkspaceDocuments` (the open item the header reads) derive from it. Reload-safe: the saved snapshot at v1 no longer wins over the artifact's real version.
- **Side effect found and fixed:** the open item is now a new object whenever its number moves, and `DocumentWorkspace`'s `$effect` that resets `bodyPanelActions` read the whole `activeDocument`, so the version button became plain text after the first save (the body registers its actions once, on mount). Fixed with `activeDocumentIdentity = $derived(activeDocument?.id)` (7 lines, the only edit in that file). Test: `DocumentWorkspace.test.ts` + a new fixture `__fixtures__/FakeVersionedArtifactBody.svelte`.

**Tests:** `artifact-versions.test.ts` (15), `client/api/artifacts.test.ts` (+10: announcements, unsubscribe, refused saves), `page-runtime.test.ts` (+1: header pill and list row follow a save; a late older answer never lowers them — verified red without the overlay), `DocumentWorkspace.test.ts` (+1), and the e2e walk `tests/e2e/artifact-versions.spec.ts` "create → user edit → Alfy edit (live, fake provider) → Undo → restore → undo the restore → reload": asserts server = header = Versions popover = list row (= in-chat card once Alfy made a call) at every step. Red on the old code, green now (cold and warm server).

## 2 · Undo's own version summary

- `src/lib/shared/artifacts/version-summaries.ts` (new, browser-safe): the fixed summaries the server writes itself as one vocabulary (`edited`, `undidAlfyChange`, `restoredPrefix`, `alfyFirstDraft`, `savedAsCopy`) plus `parseSaveSummaryKind`/`saveSummaryFor`. The literals in `body/+server.ts`, `versions.ts` (restore), `create.ts` (first draft) and `artifacts/document/+server.ts` now come from it.
- `PATCH /api/artifacts/[id]/body` accepts `summaryKind: "undid_alfy_change"` (a NAME, never free text; unknown ⇒ "Edited"; `Object.hasOwn`, so `"toString"` is not a kind).
- `document-autosave.ts`: `schedule(markdown, { summaryKind })`, sticky for the debounce window (typing right after the Undo stays part of that save), one save only. `DocumentBody.handleUndoChange` schedules with it; `bindAutosave` forwards it (Undo all loops the same handler). Two small hunks in `DocumentBody.svelte`, as briefed.
- Ruling 47 holds: an Undo has a summary of its own, so it is a version of its own, and typing after it starts another (test in `record.test.ts`).
- Localized in the Versions list: new `version-summary.ts` (`localizeVersionSummary`, recursive over `restored …`), keys `artifacts.document.versions.summaryUndidAlfyChange` ("Undid Alfy's change" / "Alfy módosításának visszavonása"), and — because the popover's line two is meant to be localized — `summaryFirstDraft` ("Alfy wrote the first draft" / "Alfy megírta az első vázlatot") and `summarySavedAsCopy` ("Saved as a new document" / "Mentve új dokumentumként").
- Tests: `body.test.ts` (+4), `record.test.ts` (+1), `document-autosave.test.ts` (+5), `DocumentBody.test.ts` (Undo asserts `summaryKind`), `version-summary.test.ts` (5), `version-summaries.test.ts` (3), `VersionsSheet.test.ts` (Undo's summary EN/HU), and the e2e asserts the stored summary "Undid Alfy's change".

## 1 · The Versions popover (and Download)

- `src/lib/components/artifacts/popover-placement.ts` (pure, 10 tests): under the button, left edges aligned, kept **inside the panel** (`anchor.closest(".workspace-shell")`) and the window, narrows for a narrow panel, flips above only when it does not fit below and above has more room, otherwise stays below and scrolls inside a capped height.
- `src/lib/components/artifacts/AnchoredPopover.svelte` (+9 tests): the one desktop-popover / phone-`DialogShell`-sheet shell (the code `VersionsSheet` and `DownloadSheet` each carried, and `AppBody`'s regenerate popover has a third copy of): dialog stack, Escape + focus return, press-outside, `aria-expanded` on the trigger while open, scale-in with the reduced-motion path, z-index 130, its own body scroll with a fixed heading, re-placement on content resize (`ResizeObserver`).
- `document/VersionsSheet.svelte` rebuilt to the mockup's `#history`: two-line rows (avatar — the signed-in user's, or Alfy's sparkle — name, `v{n}`, relative time; newest row also carries a small **Current** pill; the localized summary on line two), 9px-radius rows with hover/focus-within tint (the newest has no hover: nothing to act on), even height (line-height 1.25 ⇒ 49 px rows, the mockup's 48). **Restore is overlaid on the row's right end on hover/focus over a short fade — it reserves no space** (every row the same height, the summary keeps its full width; asserted in e2e: row boxes identical before/after hover; summary width unchanged), (plain opacity reveal; a `pointer-events: none` refinement was tried and reverted — see the last commit). On touch (`hover: none` + `pointer: coarse`) it is always shown as its own 44 px column (spec: "always shown on touch") and the summary may wrap to two lines. The inline confirm takes the row's action area (row 3, Restore hidden); opening it moves focus to its confirming button, Cancel returns focus to that row's Restore.
- `document/DownloadSheet.svelte` now uses the same shell (chrome, head, placement, anchoring, Escape, focus) — the two match by construction.
- Tests: `VersionsSheet.test.ts` (+5 rows/keyboard; 20 total, all old ones kept), `DownloadSheet.test.ts` unchanged and green, e2e (1440×900 and 1280×800): under its own button + inside the panel (never over the chat column) + width 320–360 + inside the window; expanded panel too; even row pitch and no movement on hover; long history scrolls inside a ≤480 px popover with the heading fixed; keyboard-only (Tab reaches Restore and reveals it, visible 2 px ring, Enter asks, focus on the confirming button, Cancel returns focus, Escape closes and returns focus to the version button); phone sheet with the rows on top of the mobile shell.

## 3 · The count button

`+page.svelte`: `.chat-title-bar-actions .artifact-count-button { margin-right: -0.75rem }` — the bar keeps its 24 px gutter (so the title's centring, which comes from the equal side columns, does not move) and the button leans 12 px into it: **inset from the header's right edge 24 px → 12 px, the mockup's `#madeBtn`**. A margin on the button, not on its column, changes nothing about column sizing. The compact row below `lg` already sat at 10 px; a test guards it. Pressed state and the pending dot untouched. e2e (1440×900, 1280×800, panel closed and open): inset 8–14 px, title centre within 1 px of the header centre, title right edge left of the button.

## 4 · The toast's exit

`src/lib/components/ui/toast-motion.ts` `toastExit`: out, standard (150 ms) · ease-in (`cubicIn`), fading while sinking the 12 px it rose; reduced motion ⇒ `{ duration: 0 }` (§7.2 #33, §7.3). Pure function of the motion preference, tested directly (`toast-motion.test.ts`, 4). `Toast.svelte` gets `out:toastExit` (its stale comment about not adding an outro is replaced). jsdom never finishes an outro, so `Toast.test.ts`'s three dismissal tests now ask for reduced motion (whose exit is instant by §7.3 — they stay about dismissal), plus two exit tests: the animation Svelte starts (finished by hand: 150 ms, opacity 1→0, `translateY(0→12px)`) and "leaves at once under reduced motion". Playwright (`artifact-versions.spec.ts`) watches the real thing frame by frame after a restore: it fades (<0.9), sinks (>2 px), leaves the DOM in 60–700 ms; under `reducedMotion: "reduce"` it is gone in <100 ms with no intermediate opacity/transform.

## Gates (final state)

1. `npm run check`: **0 errors, 17 warnings** (the pre-existing 17; my first attempt added one in a test fixture, fixed).
2. `npx biome check src scripts tests`: clean.
3. `npm test`: **903 files passed (1 skipped), 13,848 tests passed (2 skipped)**.
4. Playwright on port 5505, all artifact suites + knowledge + chat + conversation, fresh server, at the final HEAD: **115 passed (5.2 m)**. (An intermediate run at `06e55237` had one failure, `artifact-document-comments.spec.ts › restores a version…`, whose failure screenshot showed the popover gone and the panel restored — the signature of a Vite dependency-optimisation page reload from the `.vite` cache shared with G1-A's server; it passed alone three times and in the final full run.)
5. `npx fallow --no-cache …`: **124 issues, 4 circular dependencies** — exactly the baseline (my first pass had 125: an unused `SAVE_SUMMARY_KINDS` export, made private).

## Screenshots (Hungarian; `…/scratchpad/rd/shots/g1b/`, not committed)

Mine: `g1b-versions-hu-light-1440.png`, `g1b-versions-hu-dark-1440.png`, `g1b-versions-hu-light-1280.png` (each with a row hovered, showing Restore), `g1b-versions-hu-phone-390.png` (touch-emulated), `g1b-chat-header-hu-1440.png`, `g1b-chat-header-hu-1280.png`, `g1b-surfaces-agree-hu.png` (after a live Alfy edit: chat card v2 · header v2 · popover "v2 Jelenlegi"). Mockup references: `mock-*.png` (same folder).
Looked at each once against the mockup: the popover sits under `v6 ▾` inside the panel at 1440 and 1280, 340 px wide, rows/pill/hover match `#history` (row pitch 49 vs 48 px); dark is correct; the phone sheet shows the same rows (touch: Restore column, summary wraps); the button sits 12 px from the header's right edge with the title centred. I also looked at the Download popover once (same shell; not saved).

## Deviations / decisions

- **No prop threading for the version.** The brief allowed the body to report up; I put the choke point in `client/api/artifacts.ts` instead, which covers Document, App, the card tick, restore and the Undo toast with zero edits to `DocumentBody`/`AppBody`/`DocumentWorkspace` plumbing (G1-A's files) beyond the two Undo hunks and one 7-line identity fix.
- **Restore reveals without reserving space** (brief) rather than the mockup's always-reserved third column: at rest the summary keeps its full width (the mockup truncates every non-current summary at the button's reserved width; with the Hungarian summaries that cut "Alfy módosításának visszavonása"). On touch the reserved column is used (always visible).
- The count button keeps its earlier borderless style (the mockup's `#madeBtn` is a bordered pill); the brief asked only for its position.
- `AGENTS.md`: two bullets in the Artifacts section (one version number; the shared popover shell and summary vocabulary).
- Extra localized summaries beyond Undo's ("first draft", "saved as new document"), since line two of a v1 row is otherwise English in the Hungarian UI.

## Not done / concerns

- **The header's meta line ("You and Alfy · edited 2 min ago") and the list row's relative time still read the open-time snapshot's `updatedAt`** — the same class of staleness, not in the brief (it is not a version number). A follow-up can feed `updatedAt` through the same announcement.
- A cold dev server shows the header's version pill as plain text until the Document body loads (several seconds); pre-existing (`onVersions` is registered by the body). My e2e waits for the button variant.
- `AppBody`'s regenerate popover is still its own copy of the popover shell; it could move to `AnchoredPopover` (not touched).
- `.vite` cache is shared with G1-A's server: the first navigation after a source edit against a persistent dev server sometimes aborts (`ERR_ABORTED`); rerunning fixes it. Not a product issue.

## Hand-off — reuse these

- **`AnchoredPopover.svelte`** (`title`, `anchorTestId`, `popoverTestId`, `closeLabel`, `width`, `maxHeight`, `boundarySelector`, `onClose`, `children` snippet): any header/anchored popover; sets `aria-expanded` on the trigger; phone ⇒ `DialogShell` sheet at `z-[150]`. `AppBody`'s regenerate popover is the obvious next adopter. Its geometry lives in `popover-placement.ts` (`placePopover`, pure).
- **`subscribeArtifactVersions`** (`client/api/artifacts.ts`) + **`artifact-versions.ts`**: read every displayed version through `withCurrentSummaryVersion`/`withCurrentItemVersion`; a new API function that returns a version must call `announceArtifactVersion`.
- **Do not key an `$effect` on a whole `activeDocument`** — it is a new object whenever a field (the version) moves; key on its id (`activeDocumentIdentity`).
- **`VERSION_SUMMARY` / `saveSummaryFor` / `SaveSummaryKind`** (`shared/artifacts/version-summaries.ts`) and **`localizeVersionSummary`** (`document/version-summary.ts`): add a new server-written summary in both, plus the two i18n keys. A new "named" save kind = one entry in `SAVE_SUMMARY_KINDS` and one call to `autosave.schedule(md, { summaryKind })`.
- **`toastExit`** (`ui/toast-motion.ts`) and its test pattern: a pure `TransitionConfig` function for numbers; jsdom tests of an outro must finish Svelte's dummy animation by hand (`animate.mock.results[i].value.onfinish()`) or ask for reduced motion.
- Tokens/classes: `.versions-row`, `.versions-action` (the overlaid, hover/focus-revealed action slot, revealed by `opacity`), `.versions-current` (the neutral pill), `.anchored-popover-body` (the scrolling region). Test ids: kept `artifact-version-pill`, `document-versions-popover`, `document-download-popover`; new `version-row`, `versions-list`. In e2e use `button[data-testid="artifact-version-pill"]` (the span variant is the not-yet-interactive one).
- e2e helpers: `tests/e2e/artifact-live-edit.helpers.ts` (fake-provider model setup, copied from `artifact-document.spec.ts` because spec files cannot import each other) — a future spec that needs a live `edit_artifact` should use it.
