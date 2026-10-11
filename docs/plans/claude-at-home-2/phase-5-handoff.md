# Feature 2 · Phase 5 hand-off: followable versions, fast gates, the friction audit (written 2026-10-11)

For the next orchestrator. Read this, then `progress.md` (its Wave 4 section, the last bullets are newest),
`decisions.md` (rulings 1–75; rulings win over specs), `wave-4/handoff-final.md` (tools and lessons, still true) and
AGENTS.md's Artifacts section with its Canvas and Tours subsections. Follow the memories `alfyai-dev-process-speed`,
`alfyai-token-budget-pacing`, `alfyai-orchestrate-dont-code` and `alfyai-subagent-model-preference`.

## Where things stand

- **ai.dev = `dev` = `7cb27654`** — all of Feature 2 except Slides: Document, App, Canvas, File; the tours; Sources'
  "Made in this chat"; a project's bundle; the owner's Canvas round (Alfy draws diagrams and places blocks sensibly, every
  inserted block is editable, the touchpad works like Figma, the Android keyboard reveal); the sampling route and cleaner
  short answers; the content-language rule (ruling 75); the chat's Mermaid hardening. Release gates green (Playwright
  686/0), live checks green. **Production (`main`) untouched.** `feat/artifacts` = `dev` + docs.
- **Slides is on ice** (owner, again 2026-10-11): `feat/artifacts-slides` stays unmerged; nothing advertises Slides.
- **The owner's walk (2026-10-11):** "seems fine … a little clanky … **versioning is still crazy and unfollowable**."

## The phase, in the owner's order (approved 2026-10-11)

1. **In parallel, two agents on separate areas:**
   - **A versioning design pass** — a design, not code yet: a spec plus a click-through mockup (like the approved
     redesign in `docs/design/artifacts-redesign/`, an Opus design pass the owner loved) of a version history a person can
     follow across Document, App and Canvas. What makes it unfollowable today: Alfy edits, the reader's editing bursts
     (coalesced into their newest version for ten minutes, ruling 47), Undo (saves an older body as a new version), restores
     and `@Alfy` replies all mint numbered versions; the header's number climbs and says little; a newer version can hold
     older content. Starting points, for the designer to test rather than adopt: a timeline of named moments ("You edited ·
     3 min", "Alfy added the Rainy day frame", "Undone", "Restored to …"), the reader's typing as one entry, an undo shown on
     the change it undid, no bare version number in the header, named versions the reader saves, preview before restore.
     Say what the server keeps vs what the UI shows (prefer presentation over existing rows; a migration only if needed).
     The owner reviews the mockup before anything is built. Model: Opus for the design pass (precedent), Sonnet to build.
   - **The fast gates** (memory `alfyai-dev-process-speed`): e2e against the production build, parallel workers with a
     database per worker (today `workers: 1`, one shared DB and user, `vite dev`: ~45 of ~50 minutes), the independent gates
     in parallel; agents run their own specs plus a smoke set and the full suite runs once at the integration gate on `dev`;
     replace the chat route's fixed-byte baseline (nine recorded moves in Wave 4, ruling 68's notes) with a closure check
     that no heavy library (Chart.js, MapLibre, Mermaid, the flow library, Tiptap) reaches the chat route — the editor's own
     first-paint ceiling stays. Measure before/after; target ~15 minutes. Sonnet.
2. **The friction audit** — the owner finds it "a little clanky" but cannot phrase it yet: one agent walks the main flows
   the way the owner does (HU, 1440/1280/1100 docked/390, light and dark; mouse, keyboard, touchpad, touch) and lists every
   jump, overlap, wait, extra step and surprise, with screenshots, ranked, for the owner to react to. Report only.
3. **Build, from the approved design and the owner's picks from the audit.** Likely parts: the versioning; one layout for
   everything that floats over a board (today `placeToolbar`, `selectionPillPlacement`, `keepPillInPane`,
   `STACK_ZOOM_BELOW`, `revealForm`, `revealPan`, each added after a collision); one layer model for the panel, dialogs,
   sheets and popovers (Escape, outside press and focus were patched case by case in FU-2, FX-B, FX-B2, FX-F); admin-only
   strings and calls off the chat route (RV-F M-4); evals that match the product (the Document suite through the real tool
   path; thinking on, as chat runs). Extensions the owner may pick: chart data as a small table instead of raw JSON, a table
   block for the chat's `csv` fences, Canvas select-all, accepting board ops sent as one escaped string (~20 % of first calls
   are refused for it today).
4. **The release checklist and production — only on the owner's word**, with an announcement campaign
   (memory `alfyai-2-0-release-checklist`; the open items in `progress.md`: RV-F M-5/M-8/M-9/M-10, W4-V's below-bar suites
   and eval gaps, FX-E's question about markdown images loading any https address, FX-F's "a second Alfy edit under a
   pending review never reached the open board" with the fake provider — watch it with the real model).

## How to run it (lighter, per the owner's speed feedback)

- Small fixes: one agent → its own tests → merge. The full re-check and an Opus review only before a production release
  or for ownership/deletion/evidence/security changes. Two or three agents at a time, paced to the 5-hour window
  (`get_usage` before each dispatch; a background `sleep` to the reset).
- Everything else as Wave 4: worktrees under `.claude/worktrees/`, ports from 5400, `node_modules` linked to `art-base`'s,
  `npx svelte-kit sync` before a fresh worktree's first Playwright run, red-first real-input Playwright for UI, the
  orchestrator looks at key screenshots before each merge, merges in `art-base`, `dev` in the main checkout, gates in the
  detached `dev-int`, push `dev` and deploy only when green, live checks from `~/.cache/alfyai-artifacts/live-checks/`.
  Stop for the owner when a milestone is live.
