# Phase 5 (followable versions, fast gates, the friction audit, the build) — rules for every agent

**Read `docs/plans/claude-at-home-2/wave-3/common.md` first, then `wave-4/common.md`.** Both still apply (sources, the
specs-predate-the-tree rules, environment, how to work, the report format, real input red first, context economy), with
the changes below. Where they disagree, this file wins.

## Scope and what changed

- **Phase 5** (owner, 2026-10-11): a versioning design pass (a spec and a click-through mockup the owner reviews before
  anything is built), the fast gates, a friction audit (report only), then the build from the approved design and the
  owner's picks. **Slides stays shelved**: nothing you write may advertise, list, seed or render Slides; never touch
  `feat/artifacts-slides`.
- **Migrations:** none unless your brief says so. The next free number is after `1777140000112_artifact_tour_states`
  (journal entry 126). If you believe you need a column or table, stop and report.
- **Baseline gates** (`dev` = `7cb27654`, the M3 release gates of 2026-10-07 on this Mac): `npm run check` 0 errors /
  17 warnings; 17,408 unit tests (1,035 files); build 32 `Unused CSS selector` + 2 `must have an ARIA role`;
  `check:artifact-chunks` OK (editor closure 70.9 kB gzip under the 72,704 B ceiling; chat route +1,851 of 2,048 B);
  Fallow 124 issues / 4 circular, 0 new against `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json`; Playwright
  release set (66 spec files) 686 passed + 23 skipped in 48.3 min at `workers: 1` against `vite dev` (after the fast
  gates: the whole suite, 976 passed + 60 skipped, in ~8.5 minutes for every gate together). Known pre-existing
  build/check warnings are the only ones allowed.
- **Your gates are one command, once, at the end** (the fast gates, merged 2026-10-11):
  `scripts/gates.sh agent <out-dir> --port <P> --workers 4 <the e2e specs you changed or added>` — the static gates,
  your specs in full and the `@smoke` set, on the production build, about 4 minutes; `wave-3/common.md`'s Gates section
  says what it checks and how to iterate. The whole suite (966+ tests) runs only at the integration gate on `dev`. The
  chat route has no byte baseline any more: it is held by a rule (no heavy library in its first paint). The editor's
  first-paint ceiling stands, with about 80 B of headroom left after the versioning build: measure before you add to it.
- **Ports:** your brief gives a base port `P`. Ports `P` to `P+9` are yours (a parallel Playwright run uses one per
  worker). Real-model tunnels use the local port your brief names.
- **Commit trailer:** `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` for Sonnet agents,
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` for Opus agents. Say your model ID in your final reply.
- **Reports and screenshots** go to the orchestrator's scratchpad,
  `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/f7d2fd3b-f0d9-4b30-80c5-6cbea0e7a6a4/scratchpad/p5/`,
  under the names your brief gives. Never under `docs/plans/**`, never as files Fallow would see.
- **Do not dispatch any subagent or reviewer.** Never push, merge or rebase; never touch `main`, `dev`,
  `feat/artifacts` or another agent's worktree.

## Context economy (the owner's weekly token budget is the binding constraint)

Read by range (`grep -n`, `sed -n`), never whole large files or whole specs (`DocumentWorkspace.svelte`, the chat page,
`DocumentBody.svelte`, `CanvasBoard.svelte`, the slice specs, `docs/design/artifacts-redesign/index.html`, which embeds
images). Pipe long output through `tail -40`. Run targeted tests while iterating and the gates once. Do not re-read a
file you just edited. Keep screenshots few and look at each one yourself. Commit after each working step so an
interruption loses little. Your brief is sized for two or three steps: do those, report, stop.
