# Re-check RC-3 · is the Canvas ready for the owner?

The Opus review (`wave-3/rv3-review.md`) found 2 Critical, 6 Important and 13 Minor defects; fix agents F-A, F-B and F-C
addressed them (reports `fa-report.md`, `fb-report.md`, `fc-report.md`), S3-X added posters, the PNG export and the
performance budget (`s3x-report.md`) after the review had started, and FT-2 moved the campaign modals onto the shared
focus trap. You decide whether the Canvas is ready for the owner's own walk on ai.dev. **Report only**; do not fix.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/rc-3` (detached at the head the
  orchestrator gives you), e2e port **5590**, label `rc3`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/rc3.md`;
  screenshots `…/scratchpad/w3/shots/rc3/`.

## What to check

1. **Every RV-3 finding**, one line each: ADDRESSED / PARTLY / NOT, with the evidence (the test that now pins it, or your
   own probe). Re-run the review's own probes and failing-test sketches where it gave them (C1's bricked board opens;
   C2's note is drawn the size the model was told; I1's App survives a drag into a frame and the tripwire still fires
   on a real self-navigation; I2's typed step survives a racing send; I3, I4, I5's five rewrites refused, I6's stale
   refusal). A rewritten test must still test what the finding was about — say if one was weakened.
2. **S3-X's new surfaces**, which the Opus review never saw: the export and any poster-upload route (`requireApiUser`,
   ownership scope, `?conversationId=` for incognito, a foreign and a missing id give byte-identical 404s, PNG only →
   415, the size cap → 413, the stored file is `generated_output` linked to the board), a model-writable `poster` never
   becoming an `<img>` path (ruling 67), the camera and posters restored after a throwing capture, **the by-name exception S3-X added to
   `generated-file-serving.ts` so posters are served** (can it serve anything that is not this user's poster of this
   board? is the name pattern forgeable?), the chunk guard's
   figure honest and within ruling 68 (67 KiB gzip) for the editor’s first paint, the perf spec's numbers.
3. **The owner's walk, the way the owner does it** — in Hungarian, at 1440×900 and 390×844, light and dark, through the
   app with the e2e fake provider: a board made in the chat and opened from its card; notes, a frame, an arrow; blocks
   from the chat (a file, an App, a map, a chart, photos, a web search) and Refresh; drawing; a comment and `@Alfy`; an
   Alfy change landing, Keep and Undo, reload; the PNG download (open the PNG itself); Delete and Regenerate; the
   Knowledge tab and Workspace Search show the board; the chat card; a phone pass of the panel. **Look at every
   screenshot yourself** and write what you saw; Wave 2.5's final re-check caught a Critical this way that every gate had
   passed.
4. **The whole gates once** (`common.md`), every artifact suite, and name any flaky test with its rerun result.

## Report

Per item above: the verdict and the evidence; any NEW defect as Critical / Important / Minor with a failing-test sketch;
then "ready for the owner" or "not ready" and the smallest list that stands between. Final reply at most 10 lines.
