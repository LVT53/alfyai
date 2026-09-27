# Agent 5k · Knowledge chips (redesign step 14 only)

A small, self-contained step of the Artifacts redesign. Agents 1, 2 and 5a are merged; you touch only the Knowledge
page's Documents list. Read the **hand-off section** of `rd/rd1-report.md` (tokens and the `reducedMotionAnimate` helper)
and reuse what it names.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-rd5k`, branch
  `feat/artifacts-rd5k-chips`, e2e port **5448**, label `rd5k`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/rd5k-report.md`
- Screenshots: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd5k/`
- Read first: `rd/common.md` next to this brief. The requirements are the **"Step 14 · Knowledge chips"** section of
  `rd/rd5a-brief.md` (same folder): read that section only.

## Budget (binding — the owner's weekly limit is nearly used)

Aim for well under 100 tool calls. Targeted reads by line range; tests first for the chip behaviour; the full vitest
once; `tests/e2e/knowledge.spec.ts` once at the end (rerun only if your change broke it, after the fix); at most 2
screenshots (Knowledge → Documents with Files chosen, HU, 1440×900 light; the same at 390×844). Commit as you go. If the
orchestrator messages you to stop, finish the edit in hand, leave what is committed green, write the report and reply.

## Gates at the end

`npm run check` (0 errors, the 17 old warnings only), `npx biome check src scripts tests`, `npm test` once,
`E2E_PORT=5448 npx playwright test tests/e2e/knowledge.spec.ts`, Fallow (124 issues / 4 circular, zero new).
