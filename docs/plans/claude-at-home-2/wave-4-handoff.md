# Feature 2 · Artifacts — hand-off to the next orchestrator (sampling fix, the tours, Wave 4, the final)

Written 2026-10-05 by the Wave 3 orchestrator. Start here, then `progress.md` (its Wave 3 section and the last bullets are
the latest), `decisions.md` (rulings 1–69; rulings win over slice specs), `working-plan.md` §3–§8, and the slice specs the
agents need (`slice-5.md`, `slice-6.md`). AGENTS.md's Artifacts section (with its `#### Canvas` subsection) documents every
shared part.

## Where things stand

- **ai.dev = `dev` = `27274c0e`**: Waves 0–2.5, the whole **Canvas** (Opus-reviewed, re-checked), the owner-walk fixes
  (undo, the Keep/Undo pill, frames as groups, Mermaid diagrams on boards) and **multi-select**. Production (`main`) is
  untouched. `feat/artifacts` = `dev` + docs.
- **Slides is shelved** (ruling 69) on `feat/artifacts-slides` (`72d974e3`: deck model, create handler, suite 4, the fact
  check of ruling 66). Do not merge it; nothing on `feat/artifacts` advertises Slides.
- **Tours groundwork** waits on `feat/artifacts-s6` (Slice 6 T1/T2/T5: the tours table, migration `1777140000112`, types,
  admin seeding), branched long ago from `c7c7587f` — merge it into a fresh branch of `feat/artifacts` first; check
  `drizzle/meta/_journal.json` for the next free number at that moment (the last entry on `dev` was idx 124,
  `1777140000111`).
- Weekly budget: **0 %** on 2026-10-05 (resets weekly, Monday 09:00 UTC). Wave 3's Canvas used ~54 % of a week.

## The owner's scope for this phase (2026-10-05)

1. **Sampling on internal model calls — first, in tandem with Feature 2.** Chat turns use the qwen adapter's
   `defaultSampling` (`temperature 0.6, topP 0.95, topK 20`, `normal-chat-model/provider-compatibility.ts`, prod release
   `476f70c1`), but the control-model and utility paths build their own requests and send no sampling, so they run at the
   checkpoint's `generation_config` temperature 1.0 and short snippets come out garbled ("Rägyvágok"). One agent: find
   every server-side model request that bypasses the chat's sampling (thought-step status lines/classifier, the rail
   summary, title generation, context compression, the memory judge/consolidation, the App verifier, the canvas `@Alfy`
   reply — grep the model-call builders), make them all take the provider family's one sampling profile (never a second
   copy of the numbers), tests per path, a before/after live probe through the tunnel. Not Feature 2: **branch from
   `dev`**, merge into `dev`, then merge `dev` into `feat/artifacts`.
2. **The tours** (Slice 6 remainder, ruling 69: three tours — Document, App, Canvas; Slides' lands with Slides): merge
   `feat/artifacts-s6`, then T3 (panel card, trigger, replay from the panel — ruling 32's `getLatestPublishedCampaign`
   predicate fix with its test), T4 (seen-tracking, incognito never shows a tour — ruling 33), T6 (empty states say what the
   tour says), T7 (i18n, the account archive and erasure of the seen state). Also **hide the Knowledge tab's "Slides" chip**
   while no Slides can exist.
3. **The rest of Feature 2, excluding Slides — Wave 4 (S5b) and the final:** T4 artifacts as evidence rows in the Sources
   panel (rulings 6, 7: widen `EvidenceSourceType`, a test per group label), T5 the project bundle lists artifacts, T6 the
   doc fixes (ruling 5's two corrections, `fileProductionToolsAvailable`, AGENTS.md's "five" → four known cycles), T9 the
   all-suite live eval with ruling 59's recorded known-bad answers and the README numbers. Then the **Opus whole-branch
   review** (include focus-trap passes one and two), fixes, a Sonnet re-check that walks like the owner, `dev` + deploy, the
   owner's walk, the release checklist. **Production and the announcement campaign only on the owner's word.**

Open follow-ups the owner may pull in (all recorded in `progress.md`): Canvas select-all; edge resize handles on touch;
the undo stack kept across a panel close (design in `wave-3/ow1-report.md`); a table block for the chat's `csv` fences;
an App block reloading once when a frame adopts it; Knowledge → Documents' Delete leaving a board's poster files; the
`@Alfy` comment path's missing `stale` guard (RC-3 N8); three dialogs with no focus trap and `ModelForm`'s Escape
(FT-2); `settings-admin.spec.ts:411`; the live-check script reading comments from the wrong route.

## Tools

- Gates: `docs/plans/claude-at-home-2/wave-2-5/gates.sh <worktree> <port> <label> [specs]` (copy to your scratchpad);
  it now runs `npm run check:artifact-chunks` as its own step after the build (ruling 68: the budgets are a gate, not
  part of `npm run build`). Every artifact suite: `$(ls tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts)
  tests/e2e/knowledge.spec.ts`. Fallow baseline `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json` (124 / 4).
- Integrate on the main checkout (it holds `dev`), gate in the detached `dev-int` worktree (its own `node_modules`: run
  `npm ci` after a lockfile change), push `dev` and deploy only when every gate is green with 0 new Fallow findings.
  Deploy: `ssh -T -o ConnectTimeout=8 -o BatchMode=yes alfyroot 'sudo -u alfydesign -H bash -c "cd
  /home/alfydesign/apps/langflow-chat-dev && APP_DIR=/home/alfydesign/apps/langflow-chat-dev ./current/scripts/deploy-dev.sh"'`.
- Live checks without writing a file on the box: `ssh -T alfyroot 'set -a; . /root/verify-harness.env; set +a;
  BASE=http://127.0.0.1:3002 node --input-type=module -' < ~/.cache/alfyai-artifacts/live-checks/verify-canvas-w3.mjs`
  (`ONLY=…`; `sizes` is opt-in); `/root/verify-artifacts-w2.mjs` on the box for Documents/Apps. Real model for evals:
  `ssh -N -L <port>:192.168.1.96:30000 alfyroot` in the same command, model `qwen3-6-27b` (now vLLM v0.31 + FP8 KV).
- Agent rules: `docs/plans/claude-at-home-2/wave-3/common.md` (reuse it). Briefs and reports of Wave 3 are in `wave-3/`.

## Lessons from Wave 3 that must shape this phase

1. **The owner's own walk found five gaps every gate had passed** (undo needed focus inside the board; the pill hung from
   an empty corner; frames could not be grabbed; Mermaid had no block; no multi-select). Every UI agent reproduces its
   flows with real pointer and keyboard input in Playwright, red first; the final re-check walks like the owner; the
   orchestrator looks at the key screenshots itself before each merge.
2. **Never resume a finished agent to fix a merge** — it re-reads its whole context on every step. A fresh agent with a
   narrow merge brief (Wave 3's M1/M2) is far cheaper.
3. **Pace the 5-hour window:** two Sonnet agents burn ~20 %/h; an agent that hits the cap mid-work is costly to resume
   (cold cache). Start a second agent only when the window allows — a background `sleep` timer wakes the orchestrator.
4. **Measure what the user sees.** The canvas eval scored 24/30 against sizes that were never drawn; after the fix it
   measured the drawn board (83 %). Evals and budgets must describe the real thing.
5. **One orchestrator session per phase.** This one reached 85 % of its context; start fresh, keep it lean, commit a
   progress note after every merge.
