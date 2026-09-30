# Docs agent D1 · AGENTS.md learns the Canvas

AGENTS.md is the canonical engineering map; its **Artifacts** section documents the shared parts and the rules every
kind follows. Canvas (Slice 3) is about to ship to the dev environment and the section does not mention it. Several
build agents left suggested paragraphs in their reports. You write **one Canvas subsection** (and fold two small rules
into the section's existing lists) — accurate, short, in the section's own voice.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-d1`, branch
  `docs/agents-canvas` (from `feat/artifacts`), label `d1`. Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/d1-report.md`
- Edit **only** `AGENTS.md`. Another agent merges code on another branch; you touch no code.

## Sources

The suggested texts and hand-offs in `docs/plans/claude-at-home-2/wave-3/`: `s3p-report.md` (open question 4: the protocol
files and the one-envelope rule), `s3c-report.md` (its AGENTS.md paragraph: comments), `s3y-report.md` (its paragraph
replaces `s3z-report.md`'s: the per-chat panel memory), `s3r1-report.md` (line ~111: blocks from the chat, `onOpenItem`,
LazyNode), `s3a-report.md` (line ~185: landing and review), `s3x-report.md` (line ~140: posters, export, the chunk
budget), `fa-report.md` (line ~214: the allow-list, the stale refusal, the default footprint), `fc-report.md` (flush and
rebase, the tripwire per window). Rulings `decisions.md` 62–68 are the "why"; cite them by number.

## Rules

- Every path, export and symbol you name must exist in the tree (`grep`/`ls` each); drop what does not.
- Say what a future change must not break (like the section's existing "Do not" style), not the history of how it got
  here. Keep it to what an engineer needs: the boundaries (shared body/ops/vocabulary modules, the one ops envelope, the
  handlers, the lazy entries and the chunk ceiling), the invariants (advertised = parsed, the allow-list, the stale
  refusal, one-change review, a chat's own panel, poster/URL rules), and where each lives.
- The panel-memory rule is not Canvas-specific: put it where the section talks about the workspace/panel.
- No other section of AGENTS.md changes. Commit once, with a message that says why.

Final reply at most 6 lines: status, your model ID, the commit, the number of lines added.
