# Wave 2.5 (the Artifacts redesign) — rules for every build agent

You build one part of the owner-approved redesign of AlfyAI's Artifact surfaces (Feature 2). Five agents run one after
another on branches of `feat/artifacts`; one Opus review covers everything at the end. Your brief names your steps,
worktree, branch, port, report path and screenshot folder.

## Sources (read only what your brief names)

- Spec: `docs/design/artifacts-redesign/redesign.md` — read the sections your brief lists, by line range
  (`sed -n 'a,bp'`); never the whole file. §7 is the motion system, §9 the implementation map, §10 the build plan.
- Mockup: `docs/design/artifacts-redesign/index.html` (3,159 lines — never read it whole). `grep -n` for the classes and
  ids you need; to see it, open `file://<worktree>/docs/design/artifacts-redesign/index.html` in Playwright and use its
  toggles `#themeDark`, `#langHu`, `#devMobile`, `#reducedToggle` (the `T` table in its script holds the EN/HU strings).
  The "before" screenshots are in `docs/design/artifacts-redesign/current/`.
- Owner decisions: `docs/plans/claude-at-home-2/decisions.md` ruling 61 (lines 588–598). A ruling wins over the spec.
- `AGENTS.md` is already in your context: follow it (Svelte 5 runes and callback props, `onclick`, `{@attach}`, no new
  `<slot>`, Lucide icons only via `@lucide/svelte`, semantic tokens instead of hex in components, the artifacts
  facade rules, "Artifact" never appears in a user-visible string).

## Environment

- Every shell: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Work only inside your worktree.
- `node_modules` is a symlink to `art-base`'s: never `npm install`, never add a dependency (axe-core is not installed;
  do not add it).
- The Playwright DB is prepared. Run e2e as `E2E_PORT=<your port> npx playwright test <spec>`. The `.vite` cache is
  shared with other worktrees: if many tests fail at once with module/optimise errors, rerun that spec alone before
  calling a failure real.
- Docs check (AGENTS.md): Context7 and the Svelte MCP are not available. For a Svelte/SvelteKit API you are unsure of,
  WebFetch the page under `https://svelte.dev/docs/...` or read the installed `.d.ts`; do this sparingly.
- To seed screens for screenshots, follow the spec's Appendix (the e2e suites' own helpers, e.g. in
  `tests/e2e/artifact-document*.spec.ts`, and `PLAYWRIGHT_TEST=1`). Put throwaway capture specs outside git or delete
  them before committing.

## How to work

- **Test first** for behaviour: write the failing test (vitest + `@testing-library/svelte` for components, plain unit
  tests for pure helpers, Playwright for flows), then the code. Pure CSS needs no unit test but must be seen in a
  screenshot.
- Keep the existing test ids: `artifact-count-button`, `artifact-panel-list`, `alfy-change-bar`, `refusal-notice`,
  `margin-comment`, `selection-bubble`, `document-tabs`. Update tests that assert the old look only when the spec
  changes that look; never delete a behaviour test to get green.
- Every new UI string goes into `src/lib/i18n/artifacts.ts` in **English and Hungarian together** (plurals via the
  existing ICU/plural helper; check how `artifacts.ts` does it).
- Your share of step 15 for your surfaces: reduced motion (every animation has the spec's §7.3 reduced path; test it
  where logic decides it), accessibility (roles, accessible names, focus order, visible 2 px focus ring, 44 px touch
  targets on phones; assert with Playwright role/name queries), and **Hungarian screenshots** at 390×844 and 1440×900
  (light; dark for your main surface) compared with the mockup in HU. Save them as PNG in your screenshot folder with
  descriptive names, at most 8, look at each once, fix what differs from the mockup, and do not commit them.
- Commit after each working step, small and focused, with a message that says why. Never push, merge or rebase; never
  touch `main`, `dev`, `feat/artifacts` or another worktree; do not edit `docs/plans/**`.
- **Do not dispatch any subagent or reviewer.** The orchestrator reviews after you report.

## Gates (once, at the end — not while iterating)

1. `npm run check` — 0 errors and no warning beyond the 17 pre-existing ones (`ToolActivityRow` 10, `ThinkingBlock` 6,
   `RouteItinerary` 1); a new warning is a regression.
2. `npx biome check src scripts tests` (not `npm run lint`, which breaks on nested worktrees).
3. `npm test` (full vitest, once; ~13,450 tests).
4. The Playwright specs your brief lists, on your port.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-<your label>.json` — the baseline is
   124 issues with 4 circular dependencies; your change must add **zero** findings (an unused new export counts).

## Context economy (the owner's weekly token budget is almost spent)

Read by range (`grep -n`, `sed -n`), never whole large files (`DocumentWorkspace.svelte` 2,465 lines, the chat page
3,393, `DocumentBody.svelte` 1,279, `index.html` 3,159). Pipe long output through `tail -40`. Run targeted tests while
iterating and the full gates once. Do not re-read a file you just edited. Keep screenshots few. Commit as you go so an
interruption loses little.

## Report

Write the full report to the report path in your brief: per step what changed and where, tests added, gate numbers,
screenshots taken (paths), deviations from the spec with reasons, and a **hand-off** section naming the tokens, classes,
components and props later agents should reuse. Your final reply to the orchestrator is at most 12 lines: status
(DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), the commit range, a one-line gate summary, concerns.
