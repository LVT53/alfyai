# RC-A — the re-check of the friction build: walk every finding the way the owner does (report only)

The friction build (ruling 77, `phase-5/build-plan.md`) fixed the 30 findings of the friction audit (`phase-5/fa-report.md`)
and the owner's later finds (ruling 77's amendments: the "Vissza" crumb and short labels; the sidebar collision on a
phone; no keyboard chords on a touch screen). Nine agents FB-1…FB-9 did it; their reports are `phase-5/fb*-report.md`.
You check, finding by finding, whether a person now feels the difference. **You fix nothing.** Read `phase-5/common.md`
and the two files it names first, then `fa-report.md` (all of §1 and §2: the "before" for each finding, with its
numbers), ruling 77 with its amendments, and the FB reports' "concerns" sections.

- Worktree: `.claude/worktrees/rc-a`, detached at the `feat/artifacts` head the orchestrator names in your prompt; e2e
  DB prepared. Base port 5500. Report: `<scratchpad>/p5/rca-report.md`; screenshots `<scratchpad>/p5/rca-shots/` (at
  most 40, each looked at). Reuse the friction audit's walk kit (`<scratchpad>/p5/fa-kit/`, copy it to your own folder
  first) and its method: a production build, a fresh Hungarian user, real input, the widths 1440, 1280, 1100 docked and
  390 (and 360 for the phone items), light and dark, the measured waits and layout shifts.
- **The real model** for the chat-driven flows (a tunnel on local port 30410:
  `ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -L 30410:192.168.1.96:30000 alfyroot`,
  model `qwen3-6-27b`, in the same command as its user; about 20 turns, one at a time: one account's overlapping turns
  answer 503). The e2e fake provider where a flow must repeat exactly.

## For each finding F1–F30 and the owner's three additions

Walk the audit's own steps for it, measure what the audit measured, and say **fixed / better / not fixed / worse**, with
the before → after number and a screenshot where it shows. Then look for what the fixes broke: a new jump, overlap or
wait the audit did not have, a flow that got an extra step, a Hungarian string that reads oddly (the owner's principle:
short, natural Hungarian that does not crowd a row). Two calls the owner should hear about: FB-7 now draws every
artifact card after the reply's text instead of above it (judge how it reads in a short and a long reply), and FB-6's
"Alfy dolgozik a dokumentumon…" shows during a turn that only reads the Document (judge whether that misleads).

## Report

A table first: **finding, verdict, before → after, evidence**; then anything new the fixes introduced, ranked like the
audit (how often × how bad), with steps; then what you could not walk. Final reply at most 12 lines: status, **your
model ID**, counts (fixed / better / not fixed / worse / new), the five things to fix before the owner's walk.
