# RV-F · Opus final review of Feature 2 before the owner's walk and production (report only)

You are the last adversarial reviewer before the owner walks the whole of Feature 2 on ai.dev and decides on production.
Feature 2 (Artifacts: Document, App, Canvas, File; Slides shelved, ruling 69) has been built over five waves, each
reviewed in its own area (Opus: RV-0A, RV-1A, RV-2A, RV-3, the Delete/Regenerate security review; Sonnet re-checks after
each). **Your job: find what those area reviews could not see — the seams between them, the invariants that must hold
across the whole family, and everything this last phase changed.** Report only; do not fix. A fix plan follows from you.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/rv-f` (detached at the head the
  orchestrator names at dispatch), e2e/dev-server port **5540**, label `rvf`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/rvf-review.md`;
  screenshots `…/scratchpad/w4/shots/rvf/` (at most 16, each one you looked at).
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); `decisions.md` (rulings
  1–73; skim the headings, read in full those you test); AGENTS.md's Artifacts section with its Canvas and Tours
  subsections, and its Core Rules lines on sampling, short texts and follow-up chips; `progress.md`'s Wave 4 section (what
  each agent did, its deviations and open items). Earlier reviews, for what they already covered: `wave-3/rv3-review.md`,
  `wave-2-5/sec-review.md`. Read code by range; never whole large files.

## 1. This phase, in depth (the diff `27274c0e...<head>`, file by file, `--stat` first)

- **Ownership, incognito, deletion** (Opus-class risk): FU-1's library Delete through the panel's cascade
  (`deleteLibraryArtifact`, `deleteFilesOfDeletedBoard`) — can it delete what is not the caller's, or leave what should go?
  The board's `@Alfy` stale guard (`readBody`). W4-B's `listProjectBundle` — any path to another user's or an incognito
  chat's item, or to a project the caller does not own? The tours' seen state (no chat/artifact ids; archive; erasure).
- **The evidence/sources surface** (W4-E): the `artifact` group, `artifactCallOf`, `turnArtifacts` in `finalize-steps`; old
  stored summaries still read; nothing of a body or another chat leaks into evidence; the row's open path.
- **The model calls** (SMP, SMP-2, CHP): one route to sampling (`sampling.ts` and its structural guard), the short-text
  cleanup, the follow-up chip check, the "angolul" rule — correctness and any path that bypasses them.
- **The tours** (TR-A/B/C/D1/D2): rulings 4, 32, 33, 69, 71 hold; the badge reader; one live tour per kind; the session cache
  (`keepArtifactToursFor`) across sign-out/sign-in in one tab.
- **The board** (TR-D3, TR-D4): `followsPane`/`touched`, the keyboard reveal (never a zoom, once per focus) — no case where
  the board moves under a reader who is working, and none where a populated board is left mis-framed for an untouched reader.
- **Focus traps, passes one, two and three** (FT-1/2, FU-2): every `aria-modal` dialog and sheet in the app traps, returns
  focus and nests on the one dialog stack; Escape closes the topmost only; no fading dialog takes a click.

## 2. Across the whole family (working-plan §7's RV-final list, still owed)

One refusal notice, one comment card, one anchor interface, one ops mechanism (`applyArtifactOps`), one tool registry, one
body route, one version number on every surface; ownership scope and byte-identical 404s on every artifact route; the
containment suite with no new allow-list entry; no "Artifact"/"artefaktum" in any user-visible string (EN, HU); i18n parity;
the size gates honest (the chat-route baseline moved five times this phase — check each move's record against the code);
Fallow against the baseline (124 / 4); no dead exports added; nothing advertises, lists, seeds or renders Slides.

## 3. Walk it once like the owner (real browser, Hungarian, 1440×900 and 390×844, light and dark)

On a local server on your port with a scratch DB and the e2e fake provider (no model needed): a chat that makes a Document,
an App and a Canvas (first open → each tour; the card's buttons by mouse and by keyboard), the Sources panel's "Made in this
chat" row, a project whose Files list shows them, a Delete from the panel and from Knowledge, an empty Canvas's line and
replay, an incognito chat (no tour, no leak), a phone board with a note typed in over a shortened viewport. Note anything
that looks wrong, moves, clips, reads oddly in Hungarian or takes more than one try.

## Report

Findings by severity (**Critical** / **Important** / **Minor**), each with file:line, a reproduction (a test you would write,
or steps), and why it matters; then a verdict (**ready after fixes** / **not ready**), and a **fix plan in at most three
clusters with disjoint files**, each sized for one Sonnet agent of two or three steps. Your final reply to the orchestrator is
at most 15 lines: verdict, your model ID, counts by severity, each Critical and Important in one line, the cluster plan in
three lines, the screenshot paths to look at.
