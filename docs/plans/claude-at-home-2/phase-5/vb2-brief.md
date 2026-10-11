# VB-2 — versioning build, History mode and the Document: a history a person can follow

The owner approved the versioning design (ruling 76). You build agent 2 of `versioning.md` §12: the History mode of the
panel, the latest moment on every surface, and the Document's preview, restore and naming. Read `phase-5/common.md` and
the two files it names first, then ruling 76 (end of `docs/plans/claude-at-home-2/decisions.md`) and, from
`docs/design/artifacts-versioning/versioning.md` (by range): §2 (principles), §3 (the model), §5 (every surface; the
heart of your job), §6, §7 (motion), §8 (the strings, EN and HU), §9 (A1, A3, A4), §10's browser table, §11 (T1–T5,
T8, T9), §12. The mockup `docs/design/artifacts-versioning/index.html` is the visual reference: open it in a browser
(Playwright against `file://`) and click through the Document story; never read the file whole (360 kB of it is fonts).

- Branch / worktree: `feat/versioning-history` in `.claude/worktrees/art-vb2`, made for you from VB-1's first commit
  (the shared `ArtifactMoment` type in `src/lib/shared/artifacts/history.ts`). Ports 5420–5429.
- Report: `<scratchpad>/p5/vb2-report.md` (`<scratchpad>` is in common.md).
- Beside you: **VB-1** builds the server (`src/lib/server/**`, `src/routes/api/artifacts/**`, the shared vocabulary,
  the migration) on `feat/versioning-server`; until its routes reach you, build against fixtures of `ArtifactMoment[]`
  (put them beside your tests). When the orchestrator merges VB-1 into `feat/artifacts`, it merges that into your branch
  too and tells you; then run against the real routes. **FG-2** owns the test infrastructure (`playwright.config.ts`,
  `tests/e2e/e2e-*.ts`, `scripts/gates.*`). Later, **VB-3** adds the Canvas and App previews to your History mode and
  deletes the old sheet.

## What you build

1. **The data layer and the latest moment (A1, Q2).** `src/lib/client/api/artifacts.ts`: `fetchArtifactHistory`,
   `nameArtifactVersion`, `restoreArtifactVersion(…, { expectVersion, undoOf })`, and announcements
   (`subscribeArtifactChanges`) that carry author and kind. `src/lib/client/artifact-versions.ts` keeps, per artifact,
   the highest version with its time, author and kind. Every surface that prints a version number or "edited …" today
   (the panel header's version trigger, the list rows, the in-chat card, the header line "Te és Alfy · szerkesztve …",
   which is one fixed string today) shows the latest moment instead, through that one source; the number appears only
   in History's fine print. Keep `data-testid="artifact-version-pill"` as an alias on the new history button for one
   release and add `artifact-history-button`.
2. **History mode** (`src/lib/components/artifacts/history/`, one lazy entry `history-parts.ts`): `HistoryMode.svelte`
   (the rail beside a read-only preview; the narrow-panel and phone layouts, the phone through `DialogShell`),
   `MomentRail.svelte` (a listbox: day groups, folded steps, the Named filter, "Show older" paging, ↑/↓ Home/End,
   the live announcements), `MomentPreviewToolbar.svelte` (Name, the Restore question, "This version's changes /
   Compared with now", the change stepper), `moment-text.ts` (headline, detail and marker text from the shared
   vocabulary in EN and HU; it replaces `document/version-summary.ts` for History), and a **per-kind preview registry**
   so VB-3 can add the Canvas and App previews by adding entries.
   `DocumentWorkspace.svelte`: the History slot (hide the body, show History, Done in the actions, flush the body's
   pending save first, through the flush the panel already registers). `DocumentBody.svelte`: drop its `VersionsSheet`
   mount, expose `flush` and `reload`.
3. **The Document preview, restore and naming:** `DocumentVersionPreview.svelte` (block and word diff, read-only,
   no Tiptap: a Markdown renderer with marks), Restore only from the preview with `expectVersion` (T5: an unsaved step
   is flushed first and becomes the moment before the restore), the restore toast at the panel's foot with its Undo
   folded with the restore, naming a version, "From the chat" scrolling to and flashing the message.

**Until VB-3:** a Canvas keeps its current Versions sheet behind the same header button, and an App keeps what it has.
**Do not delete** `document/VersionsSheet.svelte` or `document/version-summary.ts`: VB-3 removes them with the Canvas's
mount. Every new string in `src/lib/i18n/artifacts.ts`'s `artifacts.history.*` block, EN and HU in the same commit, HU
from §8 (natural Hungarian; the time is bracketed in the restore question: *Visszaállítod ezt a változatot (tegnap
10:09)?*). Lucide icons, semantic tokens, reduced motion (§7), 44 px targets on phones. Update AGENTS.md's "One version
number" bullet to A1's text when your change lands.

## Tests and gates

Red first, real input (common.md): T1–T5, T8, T9 in `tests/e2e/artifact-history.spec.ts`, each seen failing on the
unfixed tree; Vitest for `moment-text.ts`, the rail's keyboard model and the latest-moment store. Screenshots you look
at yourself, at most 8: History at 1440 and 1100 docked and 390, HU, light, one dark, the folded undo, the restore
question, the phone preview. Gates once at the end as common.md says; Playwright = your spec plus
`artifact-versions.spec.ts`, `artifact-document*.spec.ts`, `artifact-chat-card.spec.ts`, `artifact-card-narrow.spec.ts`,
`artifacts-panel*.spec.ts`, `artifact-panel-*.spec.ts`; `check:artifact-chunks` inside the ceiling (History is lazy; the
Document body should shrink by losing its static `VersionsSheet`).

Commit after each of the three parts. If the job runs long, stop after a committed part and report DONE_WITH_CONCERNS
with what remains, rather than running out of context. Final reply at most 12 lines: status, **your model ID**, commit
range, gate summary, the screenshots to look at first, concerns.
