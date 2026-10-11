# VB-1 — versioning build, the server: moments derived from the version rows

The owner approved the versioning design (ruling 76). You build its server half: agent 1 of `versioning.md` §12.
Read `phase-5/common.md` and the two files it names first, then ruling 76 (the end of
`docs/plans/claude-at-home-2/decisions.md`) and, from `docs/design/artifacts-versioning/versioning.md` (read by range):
§3 (the model, the vocabulary, folding F1–F4), §4 (server vs presentation, the migration, §4.5's vocabulary and route
changes), §5.5 (restore and its undo), §5.6 (naming), §5.10 (deleted, incognito, another chat, a fork, a conflict),
§9 (amendments A2, A5), §10's server table, §11 (the unit tests, T5, T8), §12.

- Branch / worktree: `feat/versioning-server` in `.claude/worktrees/art-vb1` (made for you from `feat/artifacts`,
  `node_modules` linked, e2e DB prepared). Ports 5400–5409.
- Report: `<scratchpad>/p5/vb1-report.md` (`<scratchpad>` is in common.md).
- Two other agents run beside you: FG-2 (test infrastructure: `playwright.config.ts`, `tests/e2e/e2e-*.ts`,
  `scripts/gates.*`) and, soon, VB-2 (the History UI and the Document preview, under `src/lib/components/**`,
  `src/lib/client/**`, the chat page and `src/lib/i18n/artifacts.ts`'s `artifacts.history.*` block). Do not touch their
  files.

## Step 0 — the shared type, first and fast (within ~30 minutes)

Write `src/lib/shared/artifacts/history.ts`: the browser-safe `ArtifactMoment` type and the vocabulary the server and
the browser share (moment kinds, steps, review statuses, markers, detail facts as data, never as English text), exactly
as §3 and §4.2 need, plus the history route's response type. No logic beyond small pure helpers. Commit it alone, then
**send the orchestrator a one-line message** (SendMessage to `main`) with the commit hash: VB-2 starts from that commit
and builds its UI against fixtures of your type. After that, change the type only additively; if a breaking change is
unavoidable, message `main` first.

## Step 1 — the vocabulary, the migration, the writers

- `src/lib/shared/artifacts/version-summaries.ts`: the whole vocabulary of §4.5 (A5), old forms still parsed (rows in
  the database keep their text). Every server-written summary goes through it: `comments.ts`, `canvas-comments.ts`,
  `normal-chat-tools/artifact-tools/edit.ts`, `artifacts/keep-message.ts`, the App's regenerate, `recreate.ts`. An
  Undo or Redo names the version it acts on.
- The migration (Q3): `drizzle/1777140000113_artifact_version_moments.sql` + journal entry 127 + `schema.ts`
  (`started_at`, `label`, both nullable, no backfill), `npm run check:migrations`, the prepare-db required pieces
  (ruling 29), the account data archive exports `label`.
- `record.ts` `updateArtifactBody` (A2): `started_at` on every insert, untouched by a coalesced update; coalescing
  only into the reader's own latest version with the same summary, no `label`, last saved under 10 minutes ago, and a
  burst started under 30 minutes ago (Q4).

## Step 2 — history, restore, naming, the routes

- `services/artifacts/history.ts` (on the facade): `listHistory({ userId, artifactId, before?, limit } & scope)` →
  a page of moments, reading the rows plus the parent of the oldest; a pure `deriveMoments(rows, review, kind)` for the
  tests; the fold rules, `body_hash` markers, `restoredFrom`, review statuses from the existing review computations
  (`review.ts`, `computeCanvasReview`), the per-row cache keyed by `(id, body_hash)`, the 256 KB skip.
- `versions.ts`: `listVersions` gains `before` (paging: ruling 47 always said "paged"; today it stops at 50);
  `restoreVersion` gains `expectVersion` (a restore over a newer version is refused like a stale save) and `undoOf`;
  `nameVersion` (the `label` column; naming never mints a version).
- `read-model.ts`: `ArtifactCardSummary` gains `lastAuthor` and `lastKind` from the newest row (A1's server half).
- Routes (thin, `requireApiUser`, `{ ok: true, … }`, a foreign and a missing id answer the same 404, an incognito
  conversation's item read with `?conversationId=`; ruling 39 and 49): `GET /api/artifacts/[id]/history`;
  `PATCH /api/artifacts/[id]/versions/[versionId]` `{ label }`; restore accepts `{ expectVersion, undoOf }`; the body
  route's `summaryKind: redid_alfy_change` and `summaryVersion`.
- **The old-App version route (Q7, security-sensitive):** `GET /api/artifacts/[id]/versions/[versionId]/app` serves
  that version's App to the panel's sandboxed frame with exactly the sandbox headers the current App route uses
  (`sandbox-response.ts`; read ruling 58 in full first) and a storage bootstrap that refuses writes. Reuse, never
  re-invent, the CSP; scope it like every artifact route. An Opus security review reads it before `dev`: keep it small
  and say in your report exactly what it serves and why it cannot leave the sandbox.
- **Q8:** the edit tool asks for a subjectless past-tense summary line. The tool text is in the cached prompt prefix:
  move `CATALOGUE_TOKEN_CEILING` (`normal-chat-tools/index.test.ts`) and the frozen snapshots in the same commit, with
  the measured before and after in its message (ruling 23).
- AGENTS.md's Artifacts section: the vocabulary sentence (A5) and one short bullet for the history service and its
  routes.

## Tests and gates

Test first. Vitest: `deriveMoments` for each fold rule and its counter-case, hash markers, `restoredFrom`, the
statuses, the vocabulary parsers (old and new forms), coalescing (a named version; the 30-minute cap; a different
summary), the restore guard (T5's server half), paging, the routes' 404 parity and incognito scope (the pattern of the
existing artifact route tests). Playwright only where an existing spec asserts a summary or restore text you changed:
`grep -rn "Undid Alfy\|Restored v\|Kept from a chat\|comment reply\|made the app\|regenerated the app" tests/e2e`, and
run those specs plus `artifact-versions.spec.ts` and `artifacts-api.spec.ts`, once, at the end. Static gates as in
common.md (check 0/17, biome, migrations, vitest, build 32/2 then `check:artifact-chunks`, Fallow 0 new).

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, what the security review should
read first, concerns.
