# D1 report · AGENTS.md learns the Canvas

Model `claude-sonnet-5-5`. Worktree `art-d1`, branch `docs/agents-canvas` (from `feat/artifacts` at `96544867`).
One commit: `0e32dd04`. One file: `AGENTS.md`, **+19 lines, 0 deleted** (about 1,730 words; the Artifacts section was about 1,760).
Nothing pushed, merged or rebased; no other worktree touched; no subagent.

## What changed (all inside `### Artifacts`)

1. **Panel memory** (not Canvas-specific): one bullet right after the `DocumentWorkspace.svelte` bullet, from S3-Y's
   paragraph (which replaces S3-Z's): `document-workspace-state.ts` is the one reader/writer, a chat's own panel, what a
   chat with none takes, the emptied panel, the incognito rules.
2. **One Do-not line** after the existing three: no second copy of an advertised op/patch schema and no second writer of
   id-addressed changes (rulings 62, 14). These are the two rules every kind shares.
3. **`#### Canvas`** after the Do-not list: a 3-line intro (with a short-path key so every path resolves) and 12 bullets:
   shared body/ops/vocabulary modules and the `prepareCanvasBoard` gate (64, 14, 12) · the one envelope
   `applyArtifactOps` / `OPS_BRANCHES` (14) · advertised = parsed, worked example, catalogue ceiling (62, 23) · what Alfy
   may create and change: the five kinds, the allow-list, the URL rule, the default footprint (64, 67) · the `stale`
   refusal (67) · one pending change and Keep/Undo (63, 61, 16) · comments and `@Alfy` on a board (1, 62) · the board's
   whole steps and `land` (16) · the editor chunk, lazy entries and the ceiling (68) · blocks from the chat, `LazyNode`
   and its import rule, `onOpenItem`, live-web writes nothing (58) · pictures and posters (18) · the reader's unsaved
   step and the tripwire per window (F-C).

## Verified

Every backticked path, route and identifier in the added lines was checked against the tree with a script
(`scratchpad/w3/d1-verify.py`: files exist, routes have a `+server.ts`, every identifier occurs in `src`/`scripts`/`tests`)
and the load-bearing ones by hand against their declarations (`applyArtifactOps`, `OPS_BRANCHES`, `modelUpdatableFields`,
`lastKnownBoardVersion`, `OpsJudgeContext.readDoc`, `estimatedNodeHeight`, `needsPoster` rows, `LOADERS` in
`lazy-nodes.ts`, `storeGeneratedFile`, `canvasAnchorResolver`, the route files). Claims of behavior were read against the
code, not only the reports: RV-3's fixes (F-A, F-B) are in this base, so the allow-list, `stale`, `NODE_WIDTH` and
`estimatedNodeHeight` describe what is in the tree. Nothing named is missing.

## Things the orchestrator should know

1. **The last Canvas bullet describes F-C, which is not in this tree.** `fix/artifacts-w3-app-save` (M2's branch) holds the
   flush before a turn, the rebase of an unsaved step, and the tripwire armed per window; `feat/artifacts` at `96544867`
   still has the per-element tripwire. I named nothing that exists only there (`onFlushReady`, `awaitOpenStepSave`,
   `canvas/rebase-board.ts`, `ArtifactPanelBodyActions.flush` are left out; the bullet points at `DocumentWorkspace.svelte`,
   `app/AppFrame.svelte` and `parentsFirst`, which exist). I checked its wording against F-C's branch (`git show`, read
   only). **Merge D1 after M2's branch lands**, or delete that one bullet.
2. **No ceiling number is written.** Ruling 68 was amended to 69,632 B, `package.json` still says 68608 until M2 sets it; the
   bullet says "the gzip ceiling ruling 68 records".
3. **Rulings cited:** 62, 63, 64, 67, 68 (and 1, 12, 14, 16, 18, 23, 58, 61). 65 (Slides waits on its own branch) and 66
   (deck fact-check) are Slides-only and have no Canvas rule to cite.
4. **Left out on purpose:** S3-Z's Config note (`optimizeDeps.entries`, another section: "no other section changes"); the
   fake-provider trap (scenarios read only `## Current User Message`; it is a Known Trap, another section); F-A's open item
   that an `@Alfy` reply passes no `readVersionId` (a known gap, not a rule); the eval and `canvasPreview`.
5. `biome` was not run: it does not lint Markdown and this worktree has no `node_modules`. No other gate applies to a
   docs-only change.
6. If it should be shorter, the two cuts that lose least are the `onOpenItem`/`AppFrame` sentence and the poster
   file-naming clause in the last two-thirds of the "Blocks from the chat" and "picture" bullets.
