# Wave 3 (Canvas, Slides, tours) — rules for every build agent

You build one part of Feature 2's Wave 3 (Canvas = Slice 3, Slides = Slice 4, then the tours' remainder = Slice 6) on a
branch of `feat/artifacts` (Canvas) or `feat/artifacts-slides` (Slides). Two agents run at a time on disjoint files; your
brief names the other one and what it owns. The orchestrator merges, reviews and deploys; you do not.

## Sources (read only what your brief names, by line range)

- **Your slice spec** — `docs/plans/claude-at-home-2/slice-3.md` (Canvas, 2,238 lines), `slice-4.md` (Slides, 1,545) or
  `slice-6.md` (tours, 1,534). Read the sections your brief lists with `sed -n 'a,bp'`; never a whole spec.
- **Rulings** — `docs/plans/claude-at-home-2/decisions.md`. A ruling wins over a slice spec. Your brief lists the ones
  that bind you; rulings 62–65 (Wave 3) are at the end of the file.
- **AGENTS.md** is in your context: follow it (Svelte 5 runes and callback props, `onclick`, `{@attach}`, no new `<slot>`,
  Lucide icons via `@lucide/svelte`, semantic tokens not hex, the artifacts facade rule, "Artifact" never in a
  user-visible string). Its **Artifacts** section documents the shared parts you must reuse.

## The specs predate what is now in the tree — these win over the slice text

1. **Shared parts exist; never make a per-kind copy.** `src/lib/components/artifacts/`: `ArtifactPanelHeader`,
   `ArtifactCard` (one branch per kind), `CommentCard`, `RefusalNotice`, `ReviewBar`, `AnchoredPopover` +
   `popover-placement.ts`, `ArtifactDeletePopover`, `deleted-artifacts.ts`, `kind-icons.ts`, `artifact-bodies.ts` (one
   loader line per kind). The Document's are the reference implementation of how a body uses them:
   `artifacts/document/` (`DocumentBody.svelte`, `ChangeBar`/change pill, `MarginPanel` comment column,
   `CommentThread`, `CommentsSheet`, `VersionsSheet`, `DownloadSheet`, `keyboard-shortcuts.ts`). Read what you reuse by
   `grep -n` and ranges; `DocumentBody.svelte` and `DocumentWorkspace.svelte` are large.
2. **Anchors** are declared once in `src/lib/shared/artifacts/anchor.ts` (`Anchor`, `AnchorResolution`, `AnchorState`,
   `AnchorTone`; ruling 45). Import them; never redeclare.
3. **Bodies are written through the one body route** (`/api/artifacts/[id]/body`, `{ body, expectVersion }`, ruling 13)
   with the client's `saveArtifactBody`; user saves coalesce (ruling 47) inside `updateArtifactBody`.
4. **Routes:** `requireApiUser` (401 at the HTTP layer), `{ ok: true, … }` / `{ ok: false, reason }` (ruling 49), a
   foreign and a missing id give byte-identical 404s, an incognito conversation's item is read with `?conversationId=`
   (ruling 51). Nothing outside `services/artifacts/` queries the artifact tables (the facade rule).
5. **Tools:** one handler per kind per registry (`CREATE_/READ_/EDIT_ARTIFACT_HANDLERS`, ruling 50), the abort signal
   before any write (ruling 53), the turn's language (ruling 55), and **ruling 62: the advertised schema is the
   validator's own schema, the description's worked example is parsed through it by a test, and a refusal names the
   valid ops**. A create handler must honour `artifactId` (Regenerate re-runs it under the same id: `recreate.ts`).
6. **One version number everywhere:** every version the server reports goes through `subscribeArtifactChanges` in
   `src/lib/client/api/artifacts.ts` and `src/lib/client/artifact-versions.ts`; never print a version or an "edited"
   time from an open-time snapshot.
7. **No migration** in Slices 3 and 4. If you believe you need a column or table, stop and report.

## Environment

- Every shell: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Work only inside your worktree.
- `node_modules` is a symlink to `art-base`'s: never `npm install` through it. (Only a brief that says it adds
  dependencies replaces the symlink with its own `npm ci` first, then installs with `--save-exact`.)
- The orchestrator created your worktree and prepared its Playwright DB. Run e2e as
  `E2E_PORT=<your port> npx playwright test <spec>`. The `.vite` cache is shared with the other agent's worktree: if many
  tests fail at once with module/optimise errors, rerun that spec alone before calling a failure real.
- Docs: Context7 and the Svelte MCP are not available. For a Svelte/SvelteKit or library API you are unsure of, read the
  installed `.d.ts` first, or WebFetch the official page (`svelte.dev/docs/...`, `svelteflow.dev` for `@xyflow/svelte`
  **v1** — never React Flow memory). Sparingly.
- Real model (evals, live checks): `ssh -N -L <local port>:192.168.1.96:30000 alfyroot` in the **same** command as its
  user, model `qwen3-6-27b` (it serves the production Flash-Next model), `EVAL_ARTIFACTS_BASE_URL` /
  `EVAL_ARTIFACTS_MODEL` set, no key (ruling 54). Use the local port your brief gives. Never read
  `~/.config/opencode/opencode.json`. Runs are sequential and bounded.

## How to work

- **Test first**: the failing test, seen failing, then the smallest change. Vitest (+ `@testing-library/svelte`) for
  modules and components, Playwright for flows. Pure CSS needs no unit test but must be seen in a screenshot.
- Keep existing test ids and behaviour tests; update a test only when your change is meant to change what it checks.
- Every new UI string: `src/lib/i18n/artifacts.ts`, **English and Hungarian in the same commit**, inside your own block
  (the other agent appends to the same file). Hungarian is natural Hungarian (Canvas = Tábla, Slides = Diasor).
- For your surfaces: reduced motion (redesign §7.3), accessibility (roles, names, focus order, visible focus ring, 44 px
  touch targets on phones; Playwright role/name assertions), and **screenshots you look at yourself** — Hungarian at
  390×844 and 1440×900 (light; dark for your main surface), at most 8, in your screenshot folder, not committed. Agents'
  own screenshot checks have missed real defects three times: look at each one against the spec before you report.
- Commit after each working step, small, with a message that says why, ending with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Stage by explicit path. Never push, merge or rebase; never
  touch `main`, `dev`, `feat/artifacts`, `feat/artifacts-slides` or another worktree; do not edit `docs/plans/**`
  (write your report where your brief says).
- **Do not dispatch any subagent or reviewer.**

## Gates (once, at the end — not while iterating)

1. `npm run check` — 0 errors and no warning beyond the 17 pre-existing ones (`ToolActivityRow` 10, `ThinkingBlock` 6,
   `RouteItinerary` 1).
2. `npx biome check src scripts tests` (not `npm run lint`, which breaks on nested worktrees).
3. `npm test` (full vitest, once; ~14,200 tests).
4. `npm run build` — no new warning (baseline: 32 `Unused CSS selector` + 2 `must have an ARIA role` lines).
5. Playwright, once, on your port: **every** artifact suite plus chat, conversation and knowledge —
   `tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts
   tests/e2e/conversation.spec.ts`. A failure in a suite you did not touch: rerun it alone first. A test that fails only
   in combined runs usually measures mid-animation: wait for motion to settle (`waitForStableBoundingBox`,
   `waitForMotionToSettle`, `expectTopmost` in `tests/e2e/helpers.ts`).
6. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-<your label>.json` — baseline 124
   issues, 4 circular; your change adds **zero** findings (an unused new export counts).
7. `npm run check:migrations` passes unchanged.

## Context economy (the owner's weekly token budget is the binding constraint)

Read by range (`grep -n`, `sed -n`), never whole large files (`DocumentWorkspace.svelte` ~2,500 lines, the chat page
~3,400, `DocumentBody.svelte` ~1,300, the slice specs). Pipe long output through `tail -40`. Run targeted tests while
iterating and the full gates once. Do not re-read a file you just edited. Keep screenshots few. Commit as you go so an
interruption loses little.

## Report

Write the full report to the path in your brief: per step what changed and where, tests added, gate numbers, screenshots
(paths), deviations from the spec with reasons, open questions, and a **hand-off** section naming the modules, exports,
components and props the next agent builds on. Your final reply to the orchestrator is at most 12 lines: status
(DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), **your model ID**, the commit range, a one-line gate summary,
concerns.
