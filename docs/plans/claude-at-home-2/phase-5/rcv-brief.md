# RC-V — Opus re-check of FX-V's two guard fixes (narrow, report only)

RV-V (your predecessor's review, `phase-5/rvv-report.md`) found six Important defects in the versioning batch; FX-V fixed
them (`<scratchpad>/p5/fxv-report.md`). Two of them guard what a person can lose or what an App can do, so they get an
Opus look before `dev`; the rest is covered by FX-V's tests and the integration gate. **You fix nothing.** Read
`phase-5/common.md` first (skip its build sections), then RV-V's I-1 and I-2 and FX-V's report.

- Worktree: `.claude/worktrees/rc-v`, detached at the `fix/versioning-review` head the orchestrator names in your
  prompt; e2e DB prepared. Port 5490 (5490–5495). Report: `<scratchpad>/p5/rcv-report.md`. Budget: about 30 minutes.

## Check

1. **I-1, the restore guard.** Is the version Restore guards with now fixed when the question opens (or the preview
   loads), and does a change that lands in this tab while the question is open turn it into "It changed while you were
   looking" rather than burying it? Read the diff and FX-V's test; run that test; try one variation it does not cover
   (for example the landing arriving between the reader's confirm and the request, or two landings in a row).
2. **I-2, ruling 58** (read it in full). Does the server refuse to restore an App version the current audit calls a
   violation, with the same check the version route makes, and does History offer no Restore there? Then FX-V's list of
   every path that writes an App's body and where each audits: check each claim against the code, and look for a writer
   the list misses (grep for every caller of the App body write and of `updateArtifactBody` with an App kind). Can any
   path still put unaudited code where the live App route serves it?
3. A glance at I-3 and I-4's tests: do they test what the review described, with real input where it matters?

Report: findings by severity with file:line and steps, and a verdict (**ready for `dev`** / **ready after fixes**).
Final reply at most 8 lines: verdict, **your model ID**, findings by severity, the one thing to know.
