# Fix agent F-A · the Canvas protocol and the model's contract (RV-3 cluster A)

The Opus review of the Canvas (`wave-3/rv3-review.md`) found 2 Critical and 6 Important defects. You fix **cluster A**:
the server/shared protocol and what the model is told. Clusters B (the board UI) and C (the App frame and the reader's
unsaved step) are other agents' — stay out of their files (the review's fix plan lists them).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxa3`, branch
  `fix/artifacts-w3-protocol` (from `feat/artifacts`), e2e port **5550**, label `fa`, model tunnel local port **30060**.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/fa-report.md`
- **Agent S3-X runs at the same time** (posters, PNG export, the chunk budget: `canvas/**` components, the export
  route, `package.json`). Stay out of those; if a fix needs one, say so in the report.

## Read first

`wave-3/common.md`; `wave-3/rv3-review.md` — C1, C2, I5, I6, Minor 5, 6 and 7, and the fix plan's cluster A; decisions.md
rulings 62, 64, **67** (new: the allow-list and the stale refusal — build exactly that); the hand-offs of
`s3p-report.md` and `s3t-report.md` (the vocabulary, the handlers, the eval).

## The fixes (test first, each red before green)

1. **C1 — duplicate ids.** The model schema refuses a checklist whose items share an id (and any other in-body id
   collision the review names), with a refusal that names the fix; the normaliser **repairs** duplicates on read (so a
   board that already holds one opens again) and reports it. The review's failing test, plus: a bricked board from the
   review's probe opens after the fix.
2. **C2 — what Alfy makes is drawn the size Alfy is told.** A node the model creates without a size gets the default
   footprint stored (the one shared 190×84 in `canvas-blocks.ts`); frames keep their size; the tool text, the create
   example (its note must sit inside its frame by the eval's own rule) and the eval's `sizeOf` all agree with what is
   drawn. Update the catalogue snapshots and ceiling (ruling 62/23, numbers in the commit). Cluster B makes the board
   draw an unsized legacy node at the default width.
3. **I5 — ruling 67's allow-list** in `stepUpdateNode`, with the review's P2 probes as tests (each rewrite refused
   `invalid_data`, the message naming what may change); `poster` never model-writable.
4. **I6 — ruling 67's stale refusal.** The canvas edit handler takes the version the model last read of this board in
   the same turn (the turn's earlier tool results reach the handler — S4-V proved that seam for create; use it, and edit
   `normal-chat-tools/index.ts` only if there is truly no other way, minimally, and say why) and the envelope refuses as
   `stale` an op whose node changed between that version and now; the rest applies. Add `stale` to the refusal
   vocabulary, its label key (EN/HU) and the model-facing text. The review's failing test.
5. **Minor 5, 6, 7** as the review describes them.

## Then measure

Re-run the canvas eval live through the tunnel (the committed tool path, 3 repeats of the six fixtures) and report the
numbers next to S3-T's 24/30 — with C2 fixed, the score now describes what the owner sees. Report as measured.

## Proof

Full gates once at the end. Report per finding: the failing test, the fix, the commit.
