# FX-V — fix what the versioning review found (RV-V: 6 Important, 12 Minor)

The Opus review of the versioning batch (ruling 76) found no Critical defect and six Important ones. You fix them and
the cheap Minors. Read `phase-5/common.md` and the two files it names first, then **the review**,
`<scratchpad>/p5/rvv-report.md` (all of it: 104 lines; its screenshots are in `rvv-shots/`), and the parts of
`phase-5/vb1-report.md`, `vb2-report.md`, `vb3-report.md` and `docs/design/artifacts-versioning/versioning.md` (§3.3,
§5.5) a finding points you to.

- Branch / worktree: `fix/versioning-review` in `.claude/worktrees/art-fxv`, made for you from `feat/artifacts` (it now
  carries the fast gates). Ports 5400–5409. Report: `<scratchpad>/p5/fxv-report.md`.
- Red first, real input, for every Important finding (common.md): the failing test, seen failing, then the fix, then
  **one commit per finding**. Minors may share commits by area.

## Important

- **I-1 (the restore guard).** The version Restore guards with is taken when the question opens (or the preview
  loads), not when the reader confirms; a `refresh()` that sees `newestVersion` move turns an open question into the
  "It changed while you were looking. Here's the latest." state (§5.5). Real-input e2e: an Alfy edit lands in the same
  chat while the question is open, Restore then asks again and writes nothing until confirmed on the new state. Check
  the same path against T5 when a flush outlasts its budget.
- **I-2 (ruling 58; read it in full).** The server refuses to restore an App version whose body fails the current audit,
  the same check the version route makes (`not_runnable`), with an answer the panel words; History offers no Restore on
  a Code-only version and says why (EN + HU). Then **find every path that writes an App's body** (create, rebuild,
  restore, Regenerate after delete, a reader's own edit if one exists, the board's App block) and confirm each runs the
  current audit before the body can be served live; list them in your report with the file:line of each audit, and fix
  any that does not. An Opus re-check reads this finding first.
- **I-3 (an Undo of several Alfy versions).** An Undo names the range it takes back (the run's first version, or the
  range), on the board (`review-controller.svelte.ts`) and the Document's "Undo all" (`DocumentBody.svelte`,
  `document-autosave.ts`'s single `pendingSummaryVersion`), and `deriveMoments`/`statusOfChange` mark every Alfy version
  in it Undone; old rows that name one version still read as before. Unit-test the review's probe
  (`v1 draft / v2 alfy / v3 alfy / v4 undo of v3, body = v1` → v2 and v3 both Undone).
- **I-4 (selection after the toast's Undo).** After any write, select the entry that holds the newest row (the step,
  not its fold's oldest row); "Now" appears only on the step or moment whose own row is the newest (one "Now" ever).
  Naming lands on what is selected, so it then names the current version. Real-input e2e of the review's repro.
- **I-5 (the preview's sandbox bar).** In preview mode the bar has its own words (… · read-only / … · csak olvasható),
  EN + HU; nothing else in the bar changes.
- **I-6** is already resolved by the fast gates (the byte baseline is gone): confirm `check:artifact-chunks` exits 0.

## Minor (the review's M-1 … M-12; M-11 needs nothing)

M-1 (one way of telling time in the rail), M-2 (the Canvas Insert menu's "From this chat" rows still print `v{n}`: no
number outside History, ruling 76 Q2), M-3 (items opened from the Knowledge library get the History button: pass the
latest-moment fields in `knowledge/_helpers.ts`), M-4 (a restored Alfy change does not read "Undone" next to "Same as
now"), M-5 (a board's History preview runs its App blocks inert: no writing bridge, no live data, a poster or a
read-only frame), M-6 (the read-only bridge's refusal is not an English sentence a Hungarian reader sees), M-7 (a live
landing's `alfyVersionNumber` is the call's own version), M-8 (a rebuild's toast Undo is announced as what the server
writes), M-9 (the phone sheet says "Előzmények" once; the board preview's zoom control and its tags cover nothing),
M-10 (History's `readReview` does not parse every version since the marker on every page and every refresh: once per
open, reused), M-12 (the Hungarian touches the review lists). Also VB-3's leftovers: the dead `v{n}` snippet and the
three unused i18n keys (`DocumentWorkspace.svelte`, `src/lib/i18n/artifacts.ts`). If a Minor turns out bigger than an
hour, leave it, say why, and go on.

## Gates

`scripts/gates.sh agent <out-dir> --port 5400 --workers 4` with `artifact-history.spec.ts`, `artifact-versions.spec.ts`,
`artifact-app.spec.ts`, `artifact-canvas-review.spec.ts`, `artifact-document-review-bar.spec.ts`, `knowledge.spec.ts`,
the Canvas spec that covers the Insert menu's chat blocks, and every spec you add or change. The editor's first-paint
ceiling has about 80 B of room: measure what you add to the Canvas.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the App body writers you found and
how each is audited, what you left and why.
