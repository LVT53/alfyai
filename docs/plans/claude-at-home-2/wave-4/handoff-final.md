# Feature 2 · hand-off for the last stretch (written 2026-10-07 by the Wave 4 orchestrator)

Read this, then `progress.md`'s Wave 4 section (the table and the bullets under it are the live state), `decisions.md`
rulings 70–75 (this phase's), and the briefs in this folder. AGENTS.md's Artifacts section (Canvas, Tours) is current.

## Where things stand

- **ai.dev = `dev` = `9aed65c0`**: M1 (one route to sampling, cleaner titles/status lines/chips, the "angolul" rule) and
  M2 (the three tours, re-checked and fixed; TR-D3's board follows its pane only until the first touch). The owner is
  checking M2. Production (`main`) untouched.
- **`feat/artifacts`** (in `art-base`) = `dev` + everything after M2: FU-1 (the board's `@Alfy` stale guard, every Delete
  takes a board's posters), FU-2 (focus traps pass three, `ModelForm`'s Escape, the admin flake), W4-B (a project's bundle
  lists what its chats made; ruling 73), W4-E (the "Made in this chat" Sources group), W4-V (the all-suite live eval,
  CI replay), TR-D4 (the owner's Android keyboard reveal), RV-F (Opus final review: ready after fixes), FX-A (the
  `edit_artifact` stale guard after a coalesced save), FX-B (the panel over the Files dialog; the tours' reader).

## Running / queued at the time of writing

- Running: **FX-C** (Sources rows for deleted/forked items, `SHIPPED_ARTIFACT_KINDS`, the card's meta line), **CV-A**
  (ruling 74: Alfy draws diagrams; placement of what Alfy adds; canvas eval), **CV-B** (editing everything inserted on a
  board; reproduce first). Briefs: `fx-brief.md`, `cv-brief.md`.
- Queued: **CV-C** (touchpad like Figma), **LANG-2** (ruling 75), **FX-B2** (the panel over the Files dialog: the ring
  click, screen readers, Back and the scroll lock). Worktrees are created at dispatch from the current `feat/artifacts`.

## Then

1. Merge each agent into `feat/artifacts` in `art-base` (`--no-ff`); keep both sides of append-only conflicts.
2. **Chat-route size budget:** after each merge, build in `art-base` and run `npm run check:artifact-chunks`; if the chat
   route reads over, move `--chat-baseline` in `package.json` by exactly the measured before/after difference and record it
   in ruling 68's notes (the pattern of the five moves this phase). Agents never move it themselves.
3. A **Sonnet re-check that walks like the owner** (every flow at 1440 and 390, HU, light/dark; the Canvas with Alfy's
   diagrams and placement, editing inserted blocks, touchpad; the tours; Sources; project bundle) and checks each RV-F
   finding is closed; fix agents for what it finds.
4. Merge `feat/artifacts` into `dev` (main checkout), full gates in `dev-int` with every artifact suite + `streaming`,
   `follow-up-chips`, `admin-users-campaigns`, `project-*` specs and the size budgets as their own step (`gates.sh` in the
   orchestrator's scratchpad, copied from `wave-2-5/gates.sh`), push `dev`, deploy (command in `wave-4-handoff.md`), live
   checks (`~/.cache/alfyai-artifacts/live-checks/`: `verify-canvas-w3.mjs`, `verify-tours-m2.mjs`, `probe-charts.mjs`,
   and `/root/verify-language.mjs` on the box). Tell the owner what to look at; stop for their walk.
5. The release checklist (`alfyai-2-0-release-checklist` memory + the open items in `progress.md`: RV-F M-4/M-5/M-8/M-9/
   M-10, W4-V's eval gaps and below-bar suites, the App eval's thinking-off gap). Production only on the owner's word.

## Lessons from this phase

- Agents' screenshots and the orchestrator's own look caught real defects (clipped phone buttons, a board jumping under a
  keyboard): keep looking at the key shots before every merge.
- A flaky e2e under machine load is common with three agents running; rerun the failing test alone before calling it a
  regression — and do not trust a short bisect (FLK showed a 14/14 streak was luck).
- The 5-hour window: three Sonnet agents ≈ 30 %/h; an Opus review ≈ 25 min. Time dispatches to the window's reset with a
  background `sleep`.
- Several separately-measured string additions overflow the chat-route budget once merged: re-baseline at each merge with
  the measurement, never in an agent.
