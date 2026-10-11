# VD report: the versioning design pass

Agent: VD, model `claude-opus-5-5`. Branch `design/artifacts-versioning` (worktree `.claude/worktrees/art-vd`), commits
`eb03dc69..2ce1b038` (5 commits, docs only). Status: DONE.

Deliverables:
- `docs/design/artifacts-versioning/versioning.md` (the spec, 870 lines: §1 problems with evidence, §2 principles,
  §3 the model, §4 server vs presentation, §5 every surface, §6 per kind, §7 motion, §8 EN/HU strings, §9 amendments,
  §10 implementation map, §11 tests, §12 build split, §13 owner questions).
- `docs/design/artifacts-versioning/index.html` (513 kB: 360 kB is the app's two fonts inlined one face per line,
  since Chrome refuses fonts over `file://`; screenshots are referenced from `current/`, not embedded).
- `docs/design/artifacts-versioning/current/` (VC's 14 screenshots, renamed for what each shows).
- `p5/vd-shots/` (8 captures, all looked at): `vd-1` the whole Document story, today beside new, 1440 HU;
  `vd-2` History right after a restore; `vd-3` an Undo folded onto Alfy's change, beside today's extra row;
  `vd-4` the phone sheet beside today's; `vd-5` the phone preview with its Restore bar; `vd-6` a waiting change, dark;
  `vd-7` the App's first version (Code compared with now) beside today's "v4" text; `vd-8` the board, Undo folded and
  the preview ringing Alfy's blocks.

## What I designed, and why (ten lines)

1. The history is told as **moments** derived from the existing `artifact_versions` rows: a headline (who did what,
   from the author and the summary vocabulary), a detail line (what changed, from a diff of the row with its parent:
   blocks, board blocks, lines) and a time; the number survives only in fine print.
2. **Folding** (§3.3): an Undo that immediately follows Alfy's change is drawn on that change ("Undone", "↳ You undid
   it"), a Redo completes it, a restore and its toast-Undo are one quiet moment, one turn of Alfy's edits is one
   moment; anything else stays in time order. No row is ever hidden or deleted.
3. **Markers from `body_hash`**: "Now", "Same as now", "Same as Monday 10:09", "Restored from here"; review status from
   the existing review computations: "Waiting for you" (with Review, which goes to the pill/bar), "Kept", "Undone".
4. **History is a mode of the panel**, not the 340 px popover: a read-only preview of the selected version with its
   changes highlighted, beside a day-grouped rail (narrow panel: list then preview; phone: a full sheet).
5. **Restore only from the preview**, guarded by `expectVersion`, with "This version's changes / Compared with now";
   after a restore History stays open on the result and the toast sits at the panel's foot.
6. **The header** names the latest moment ("Alfy módosította · 12 perce") instead of `v11` and the constant
   "Te és Alfy"; the App gets the same History (it has none today).
7. **Names** for versions, which close a typing burst so a named version's words cannot change under its name.
8. Every server-written summary moves into the translated vocabulary (four are English in HU today) and the App's
   regenerate copy stops hard-coding "v2" and promising a History it lacks.
9. One migration is proposed (`started_at`, `label`), with a no-migration fallback for every surface.
10. The mockup derives its New column from the same rows by the same rules, and draws its Today column from those rows
    by today's rules (or shows VC's real screenshot of that state), so the two columns always describe one history.

## Decisions for the owner (versioning.md §13), with my recommendation

1. History as a panel mode with a preview, not the popover: **yes**.
2. No version number on the header, list row or chat card (fine print only): **yes**.
3. One migration, `started_at` + `label` on `artifact_versions`: **yes** (fallback: names in `metadata_json`, no spans).
4. A typing burst closes after 30 minutes: **yes** (needs Q3).
5. An Undo folds onto the change it undid only when it follows it at once: **yes**.
6. Restore allowed on an item made in another chat, with a line saying it changes there too: **yes**.
7. An old App version runs in the preview through one new read-only route (security review): **yes**; fallback Code only.
8. Ask Alfy for subjectless past-tense edit summaries (moves the tool catalogue budget, ruling 23): **yes**.

## Proposed rule amendments (versioning.md §9, old text, new text, cost)

- **A1** AGENTS.md "One version number on every surface" becomes "One latest moment on every surface": the same
  `subscribeArtifactChanges` + `artifact-versions.ts` source, now carrying author and kind; the number orders and
  guards and is printed only in History's fine print.
- **A2** Ruling 47: no coalescing into a version the reader named; keep the burst's first save (`started_at`); cap a
  burst at 30 minutes (if Q3/Q4).
- **A3** Ruling 16: wording only: ⌘/Ctrl+Z, Undo (Alfy's change, pill/bar), Restore (History); History offers no Undo
  but the restore toast's own, drawn folded with it.
- **A4** Rulings 61/63: History shows the review status from the same marker and sends the reader to the review; it
  has no Keep/Undo of its own.
- **A5** The summary vocabulary covers every server-written summary; an Undo/Redo names the version it acts on.
- Unchanged and protected: rulings 1, 13, 14, 67; the save guard (now also on restore); Regenerate under the same id;
  the deletion cascade; the incognito scope.

## Build split (versioning.md §12)

After one shared first commit of `shared/artifacts/history.ts` (the `ArtifactMoment` type):
1. **Server (Sonnet):** `services/artifacts/history.ts` (`listHistory`, pure `deriveMoments`), the vocabulary, the
   restore guard and `undoOf`, naming, paging, the read model's latest moment, the migration if approved; unit tests.
2. **History shell + Document (Sonnet):** `components/artifacts/history/` (one lazy entry), `ArtifactPanelHeader`,
   the History slot in `DocumentWorkspace`, the Document preview, client API + `artifact-versions.ts`, i18n; Playwright
   T1–T5, T8, T9.
3. **Canvas + App previews (Sonnet):** the board preview as a lazy part (chunk gate), `AppVersionPreview`, the old-App
   route's client; Playwright T6, T7.
Then an Opus review of the batch.

## What my own walk-through of the mockup changed (worth carrying into the build)

- The Hungarian restore question cannot inflect a time (*10:09-es* but *10:20-as*), so it brackets it:
  *Visszaállítod ezt a változatot (tegnap 10:09)?*
- A first version has no step of its own: its preview compares with now and the first half of the switch is disabled.
- Today's top-right toast covers the panel's Done/Expand/Close (VC D11); the new design's toasts stand at the panel's foot.
- A folded restore-undo reads best as its own step, *Visszavontad a visszaállítást*, not as a sentence fragment.

## What I could not verify

- P10 (a restore without `expectVersion` racing an unsaved editor step) is from the code only; T5 is written to test it.
- The real panel width at a 1100 px window (the mockup assumes 652 px; 947 px at 1440 is measured from VC's shots).
- The server-side derivation's cost on 50 large bodies (bounded by the 256 KB skip and a per-row cache, not measured).
- Matching an `@Alfy` edit to its comment by time is best effort; I did not check the gap on real data.
- The old-App preview route's security (ruling 58) needs a review before it is built.
- The listbox pattern with VoiceOver/NVDA (designed to the ARIA pattern, not tried with a screen reader).
- Not captured by VC, designed from the code: a live Alfy landing while History is open, the `@Alfy` flow, a restore
  while a change waits.
