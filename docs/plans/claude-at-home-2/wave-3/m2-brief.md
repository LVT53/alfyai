# Merge agent M2 · F-C onto the board F-B fixed

F-C (the App frame survives a reparent; the reader's unsaved step is flushed before a turn and merged with a landing
Alfy change) branched before F-B (the board UI fixes, a reworded conflict banner, a chunk guard at 68,608 B) merged into
`feat/artifacts`. Merging `fix/artifacts-w3-app-save` into `feat/artifacts` conflicts in one e2e file. You make that merge
**on F-C's branch** and finish the three loose ends F-C left.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxc3` (branch
  `fix/artifacts-w3-app-save`, clean), e2e port **5570**, label `m2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/m2-report.md`
- You are allowed exactly one merge: `git merge feat/artifacts` in that worktree. No other agent runs.

## Read first

`wave-3/common.md`; `wave-3/fc-report.md` (its concerns 1–3) and `wave-3/fb-report.md` (the banner wording, I3, the
Insert-menu waits); decisions.md ruling 68 **as amended** (the first-paint ceiling is 69,632 B gzip).

## Steps

1. Merge `feat/artifacts`; resolve `tests/e2e/artifact-canvas-comments.spec.ts` keeping both intents (F-C's rewritten
   conflict premise, F-B's banner wording); update any other assertion on the old banner text F-C's report names
   (`artifact-canvas.spec.ts`, `artifact-canvas-frames.spec.ts`) to the wording F-B shipped — never weaken what a test
   checks. Commit the merge alone.
2. Apply F-C's proven fix for an App dragged into a frame listed after it:
   `…/scratchpad/w3/frames-first-insert.full.patch` (`git apply`, then see its test red without the code change and green
   with it), fix the stale `conflict` doc in `canvas/_lib/server-board.ts`, and set `check:artifact-chunks`'
   `--max-gzip` in `package.json` to **69632** (ruling 68 amended). Commit each.
3. Prove it: the canvas and panel e2e specs (`tests/e2e/artifact-canvas*.spec.ts tests/e2e/artifacts-panel*.spec.ts`),
   `npm run build` + `npm run check:artifact-chunks` (report the first-paint bytes), then the full gates once
   (`common.md`), every artifact suite.

Final reply at most 8 lines: status, your model ID, the commit range, a one-line gate summary with the first-paint bytes.
