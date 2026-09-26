# RV-1A — independent review of Slice 1's Document engine and server side

**Scope:** `feat/artifacts-s1` at `e17c6f09` (`git log 2bf644aa..e17c6f09`, the whole slice), the engine and
server half: `src/lib/shared/artifact-document/` (blocks, patch, anchor), `src/lib/server/services/artifacts/`
(document-ops, serialize/document, record, versions, comments, export, read-model), the Document handlers in
`normal-chat-tools/artifact-tools/`, and the Document routes under `src/routes/api/artifacts/` and
`api/conversations/[id]/messages/[messageId]/document`. Reviewed against `AGENTS.md`, `slice-1.md` (Global
Constraints, Review Focus, Contracts), rulings 11, 12, 35, 36, 45, 47, 49, 50, 51, 53, 55 and `review-5a.md`.
The editor UI, the live channel's client side, the margin and the toolbar are RV-1B's; the few editor files I
touched are named below, each for an engine defect, each a minimal change.

**Method:** every defect was reproduced with a failing test first (the red line is quoted below), fixed with the
smallest change, and re-run with its neighbours; one commit per defect. Where a defect only shows through the real
editor, the test drives the real Tiptap 3.31.3 editor (`canonical-roundtrip.test.ts`, `anchor-birth.test.ts`):
ruling 12's pure gate test never meets the editor's own spelling, which is where most of the canonical-form
defects were hiding. Concurrency was tested with real interleavings on the real database, and the card tick with
the browser's own `saveArtifactBody`/`toggleDocumentTask` against the real routes.

## Verdict: **merge with these fixes**

The slice's design holds up: ids are minted before any hash, the three-way guard is the right guard and the
server really is the authority, per-op refusal is honest, the routes are scoped and answer one shape, and ruling
53's abort/read-bound/cap are in. But the review found 32 defects, and the worst of them break the slice's two core
promises in ordinary use, not in corner cases:

- **The canonical form rewrote the user's content** on every save: every horizontal rule became the text
  `| --- |`, a code block's `+` lines became `-` (a diff inverted), every Shift+Enter line break was deleted,
  a checklist item the user had just added came back as a bullet reading `[ ]`, and a `[chip in]` the user
  typed was replaced by an empty chip token.
- **"Your words win" had holes:** two concurrent `edit_artifact` calls (the AI SDK runs a step's tool calls
  together) or an autosave landing mid-patch lost an applied edit or the user's save while every tool result
  said "applied"; a card tick and an open editor could overwrite each other because ruling 47's in-place
  coalescing is invisible to `expectVersion`; and a model-written marker line could hand another block's id
  (and its comments) to Alfy's text.
- **Comments were broken in the most common cases:** any selection touching a block's start or end was refused
  with a 400, and any quote touching bold, italic, a link or an `&` was "Orphaned" at birth — so `@Alfy`
  refused it without asking the model.
- **Ruling 12's gate failed through the real editor** for tables (delimiter padding), nested checklists and
  split blocks — hashes (or ids) changed with no user edit, which is exactly what makes Alfy's next patch be
  refused as "you changed this block".

All 32 are fixed on this branch with red tests. Hold the branch at its HEAD, not at `e17c6f09`.

## Findings

Locations are at `e17c6f09`. Severity is for a single-user install: High = content loss or a core promise
broken in ordinary use; Medium = wrong result or false refusal in a realistic flow; Low = contract or polish.

### 1 · Mint-before-hash, id stability, the canonical form at rest

| # | Sev | Where | What breaks, for whom | Test (red) | Commit |
|---|---|---|---|---|---|
| 1 | **High** | `blocks.ts:95` `normalizeMarkdown` | The prose rules (bullets, `1)`, table padding, chips, blank runs) ran on fenced code. A diff's `+ added` was stored as `- added`, a `1)` as `1.`, two blank lines as one — on the first save, because the client canonicalises before every autosave. | `blocks.test.ts` "keeps a fenced code block verbatim" — `expected '```diff\n- added line…' to be '```diff\n+ added line…'`; editor half in `canonical-roundtrip.test.ts` | `7f0f0f15` |
| 2 | **High** | `blocks.ts:139` `isTableDelimiterRow` | A bare `---` (the editor's horizontal rule, and Alfy's) was read as a one-cell delimiter row and normalised to `| --- |`: every divider came back from a reload as a paragraph showing `| --- |`. The pure gate passed because the corrupted form is idempotent. | "keeps `---` a horizontal rule" — `expected '| --- |' to be '---'`; editor half | `66a650ee` |
| 3 | **High** | `patch.ts:273` | An op's text was stored as one block whatever it was. Text that is two paragraphs (or a new section) was stored under one marker, so the next reload minted an id and the snapshot no longer matched (false `block_changed`); a marker line in the text was absorbed on reload and **handed another block's id — and its comments and snapshot entry — to Alfy's text**. The engine now re-reads the result with the parser's own splitter (markers dropped, extra blocks minted, `insertedBlockIds` on the inverse). | `patch.test.ts` RV-1A — `expected [ 'One.\n\nTwo.', 'Second.' ] to deeply equal [ 'One.', 'Two.', 'Second.' ]`, marker, empty and kind cases | `b21ef102` |
| 4 | Medium | `blocks.ts:132` `splitTableCells` | Split on every `|`, so a cell holding GFM's escaped `\|` became two cells: a column appeared and GFM dropped the last cell's text. Shared by the canonicaliser, `addTableRow` and export. | `expected '| a | b |\n| --- | --- |\n| x \ | y |…' to be '… | x \| y | …'` | `d6b28674` |
| 5 | Medium | `blocks.ts:385` `consumeSingleListItem` | A task item's nested child became a block of its own; the marker line between parent and child ends the list in every reader, so a reopen un-nested it — **ruling 12's gate failed for every nested checklist** (hash changed, structure flattened, Alfy refused as "you changed"). | `expected [ Array(4) ] to deeply equal [ 'taskList', 'taskList' ]`; editor half | `d8eea4b0` |
| 6 | Medium | `blocks.ts:145` `normalizeTableRow` | Delimiter dashes are padding too: the editor pads `| --- |` to the column width, so any table Alfy wrote changed its hash on a mere reopen once a cell was wider than three characters (**gate failure for tables**). | `expected '| A | B |\n| ------- | --- |…' to be '| A | B |\n| --- | --- |…'`; editor half `expected { tb0vnn9: 'd7861d32' } to deeply equal { tb0vnn9: '0525d305' }` | `1429333d` |
| 7 | Medium | `blocks.ts:94` rule 1 trim | The editor writes Shift+Enter as two trailing spaces, and rule 1 trims trailing whitespace: every hard break came back from a reload as a space (measured: 1 hard break in, 0 out). Now written as the backslash break. | `expected 'First line\nsecond line' to be 'First line\\\nsecond line'`; editor `expected +0 to be 1` | `1feef8fb` |
| 8 | Medium | `blocks.ts:421` `consumeListBlock` | The editor writes a hard break's second line in a list item unindented (CommonMark lazy continuation); the splitter cut it out as a paragraph block, outside the list, on the next reload. | `expected [ 'list', 'paragraph', 'list' ] to deeply equal [ 'list' ]`; editor `expected +0 to be 1` | `3b49a02f` |
| 9 | Low-Med | `blocks.ts` hard-break rule | The same loss inside a quote: both lines start with `>`, read as a new block, so the break was still trimmed. | `expected '> quoted line\n> second quoted' to be '> quoted line\\\n> second quoted'`; editor `expected +0 to be 1` | `42b435a2` |
| 10 | Medium | `extensions.ts:183` (editor id plugin) | Enter (or paste) copies the node's attrs, id included, onto the new node; the plugin minted only missing ids, so the client's canonicalisation minted a **new id for the second half on every autosave**: Alfy's next patch on it was `block_missing`, marks/Undo lost it, and a comment there lost its same-block bonus and read "Moved". One-loop fix: a duplicate id counts as missing. | `canonical-roundtrip.test.ts` split — `expected [ 'pgrhiv', 'pgul9g', 'pgsirq' ] to deeply equal [ 'pgrhiv', 'pgtk0l', 'pgsirq' ]` | `98567f90` |
| 11 | Low | `blocks.ts:243` `normalizeChipSyntax` | Rewrote any `[chip …]`: the editor writes a typed "[chip in]" as `\[chip in\]`, and the canonicaliser replaced it with `\[chip kind="" value=""]` — the words deleted. Only a real token is rewritten now. | `expected 'We will \[chip kind="" value=""] late…' to be 'We will \[chip in\] later.'` | `25a831bb` |
| 12 | Low-Med | `document-ops.ts:428` `saveDocumentBody` | Stored the client's Markdown verbatim. An unmarked block reached Alfy's read (`mint:false`) with id `''`; two such blocks shared it and a patch for one was applied to the other. Now parsed and minted on the server (a no-op for the editor, which canonicalises first). | `integration` — `expected '<!--b:px3903-->\nFirst.\n\n<!--b:px4a…' to be '…First.\n\nSecond.…'` | `18e405be` |
| 13 | Medium | `blocks.ts:94` rule 1 trim | The editor writes an item the user has just added, before typing, as `2. ` or `- [ ] ` and reads it back only with that space. An autosave landing on a fresh item stored `2.` / `- [ ]`: after a reload the numbered item was the text "2." inside the item above, and **the checklist item was a bullet reading "[ ]"**. A bare marker now keeps one space. | "keeps the one space after a bare marker" — `expected '- [ ]' to be '- [ ] '`; editor `expected [ 'orderedList:1', 'bulletList:1' ] to deeply equal [ 'orderedList:2', 'taskList:1' ]` | `03a18fe2` |
| 14 | Low-Med | `blocks.ts:421` `consumeListBlock`, `:385` | A list or checklist item with two paragraphs (blank line, then the second indented to the item's content column) lost its second paragraph out of the list on the next reload. Also: finding the next non-blank line sliced the rest of the document per blank line (quadratic on a long loose list). | `expected [ 'list', 'paragraph', 'list' ] to deeply equal [ 'list' ]`; editor `expected [ 1, +0 ] to deeply equal [ 2, 2 ]` | `21245078` |
| 15 | Low | `blocks.ts:576` `deriveLabel` | A code block's label was empty (its first line is the fence), so a refusal on a code block named nothing (Review Focus 4); other labels kept their inline Markdown. | `expected '' to be 'const total = 1;'` | `d1f83d68` |

### 2 · The guard and per-op refusal

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 16 | **High** | `document-ops.ts:336` `applyDocumentPatch` | Read → apply → await → write the whole body with no guard. Two `edit_artifact` calls in one model step run concurrently, so the second write replaced the first's body: an applied edit vanished while both results said `applied: 1`; an autosave landing in the window was overwritten the same way. The write now carries `baseHash` (the existing guard) and a stale write re-reads and re-applies. | `integration` — `expected [ 'Alpha.', 'Beta changed.' ] to deeply equal [ 'Alpha changed.', 'Beta changed.' ]`; user-save race `expected undefined to be 'block_changed'` | `de36f4ce` |
| 17 | Medium | `patch.ts:189` | The guard compared against the working copy, so a second op on one block (two typo fixes; `@Alfy`, whose prompt asks for "one or more ops against ONLY this passage") was refused as `block_changed` — "you changed this block", told to the user and the model. Now compared against the pre-patch block. | `expected [ 'applied', 'block_changed' ] to deeply equal [ 'applied', 'applied' ]` | `21e4301b` |
| 18 | Medium | `patch.ts:237` `replaceRange` | `String.replace` with a string replacement reads `$$`, `$&`, `` $` ``, `$'`: "\$\$5" was stored as "\$5", "\$&" as the found text. | `expected 'The price is $5 (TBD The price is …' to be 'The price is $$5 ($& $\` $') for now.'` | `642c440c` |
| 19 | Medium | `patch.ts:219` `insertText` | At `start` the text went before the markup: `# Title` became the paragraph `New # Title`, `> quoted` became `Note: > quoted`. | `expected [ 'New # Title', …] to deeply equal [ '# New Title', …]` | `ab5e9409` |
| 20 | Low-Med | `patch.ts:103` `renderCell` | A `|` in a cell split it (GFM then drops the excess cell), a newline cut the table; a chip value with `"`/`]` was cut. Pipes escaped, newlines folded, unholdable chip values refused `bad_row`. | `expected [ 'line two' ] to deeply equal [ 'Train \| bus', 'line one line two' ]`; `expected undefined to be 'bad_row'` | `6aea13a7` |

### 3 · Versions, ruling 47, the card tick

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 21 | Medium | `body/+server.ts`, `client/api/artifacts.ts:189`, `record.ts:528` | Ruling 47 coalesces a user burst **without moving the version number**, and `expectVersion` was the only guard: a card tick and an open editor both passed `expectVersion N` whatever the other had written. An autosave landing between the tick's read and write was overwritten by the tick; an editor that had not seen a tick saved over it. The route now takes `baseHash` (→ `stale`) and `coalesce`; the tick sends its read hash and `coalesce: false`, so the editor's next save is `version_conflict` (its conflict notice), never a silent win. | `integration` (real routes + the browser's own calls) — `expected true to be false` (tick.ok, "bring boots" lost), `expected true to be false` (editorSave.ok, tick lost) | `ee8cdaa5` |
| 22 | Low-Med | `record.ts:528` `canCoalesce` | A restore and a user-created document are authored `user`, so the next autosave updated them in place — ruling 47 says restores and creation "are never merged". A burst is now consecutive saves with the same summary. | `expected { ok: true, version: 3 } to match { version: 4 }`; `expected { version: 1 } to match { version: 2 }` | `057e4688` |

### 4 · Routes, ownership, incognito

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 23 | Low-Med | `routes/api/artifacts/document/+server.ts:32` | `createDocumentArtifact`'s thrown refusal escaped: a foreign or missing `conversationId` and an oversize body answered an unhandled **500**, not ruling 49's shape. Now 404 `not_found` (one answer for missing and foreign) / 413 `too_large`. | `DocumentOperationError: conversation_not_found` (uncaught) | `0bec1e0c` |
| — | coverage | `incognito-artifact-containment.test.ts` | Alfy's read (+ snapshot write), a patch, a body save and `@Alfy` from outside an incognito conversation answer `not_found` and write nothing; from inside they work and the card preview is in its own list only. No exemption added. | new, green (28 → 30) | `2a406167` |

Every Document route authenticates first (`requireApiUser`/`requireAuth`), answers `{ ok: true, … }` /
`{ ok: false, reason }`, scopes through `getArtifactOwnershipScope` with `?conversationId=` (ruling 51), and a
foreign id is byte-identical to a missing one — confirmed route by route.

### 5 · Comments and `@Alfy`

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 24 | **High** | `comments.ts:56` `toAnchor` | Required non-empty prefix **and** suffix, but the editor captures context inside the block: a selection at a block's start or end — a whole heading, a task line, a first or last word — was refused with a 400 and the comment lost. The unit tests only anchored mid-block quotes. | `expected undefined to deeply equal { kind: 'text', … }` | `875d3ebf` |
| 25 | **High** | `anchor.ts:105` | The resolver searched the editor's visible text in the block's **Markdown**: "the train" is not in `**the** train`, "train & a" not in `train &amp; a`. A comment on formatted text was "Orphaned" at birth and `@Alfy` refused it without calling the model. Now resolved against `blockVisibleText` (new, shared), and an empty context matches only at the block's edge. | `expected 'orphaned' to be 'exact'`; real editor `the anchor on "train & a ": expected 'orphaned' to be 'exact'`; `@Alfy` `expected "vi.fn()" to be called 1 times, but got 0 times` | `c3bff88d`; perf follow-up `06d1ff21` (my first version read every block per thread per render — 17.4 ms → 0.5 ms on 1 000 blocks × 10 threads; red: `read a block after a perfect own-block match`) |
| 26 | Low-Med | `comments.ts:505` | The `@Alfy` model call's usage was dropped: the cost display left out every `@Alfy` reply. Now `recordControlModelUsage` (`artifact_comment_alfy`), on the artifact's own conversation (the knowledge panel names none). | `expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ]` | `eccb61d2` |

Checked clean: ops are pinned to the anchored block server-side (a comment cannot reach another block or
artifact; the marker-injection route is closed by #3); one Alfy version per change; abort-aware before the model,
after it and before the write; applied/refused/answered always leave a reply.

### 6 · Tool handlers and their metadata

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 27 | Medium | `edit.ts:477`, `alfy-activity.ts:275` | `refusedBlocksJson` was `{ blockId, reason }` and the panel marked by block: one refused op marked **every** op on that block refused — an applied change shown as refused, with no mark and no Undo. Refusals now carry `opIndex`; the panel matches by index (old metadata falls back to block). | client `expected [ 'refused', 'refused' ] to deeply equal [ 'refused', 'applied' ]`; metadata `expected [ { blockId, …(1) } ] to deeply equal [ { blockId, …(2) } ]` | `e36f8bde` |
| 28 | Low | `read.ts:103` | The Document read writes the snapshot but never checked its abort signal (ruling 53: nothing written after an abort). | `expected [ { blockId: 'p6jkep', … } ] to be undefined` | `b0be43de` |

Checked clean: create and edit check the signal before writing; the read is bounded by the shell (ruling 53);
`appliedCount` matches `result.applied`.

### 7 · The card preview (T9.7)

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 29 | Low | `blocks.ts:194` `readTaskBlock` | The one task reader the preview and the client card share returned raw Markdown: `Pay the **deposit**`, link syntax, `&amp;`, whole chip tokens on the card. | `expected { checked: true, … } to deeply equal { checked: true, … }` | `332cbff2` |

Checked clean: bounded (five tasks + a count), never ships the body, tab count from metadata, incognito only in
its own list (pinned by the new containment case). After #5 a nested sub-task travels with its parent, so the
preview counts top-level tasks.

### 8 · Export (T12, ruling 36)

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 30 | Medium | `export.ts:51` and the other mappers | The report renderers print text verbatim, and the mapper handed them raw Markdown: a PDF/DOCX export showed `**bold**`, `[the bus](https://…)`, `&amp;`, `\*`. Also a task's continuation line and nested plain items each became an **unchecked checkbox**, and an unclosed code fence lost its last line. | `export.test.ts` RV-1A (three cases) | `138d3d8d` |
| 31 | Low | `export/+server.ts:83` | The `.md` export dropped every line starting `<!--b:`, including code content that only looked like a marker. Now the parsed blocks joined. | `expected 'How the ids look:\n\n```html\n<p>Hi</…' to be '…<!--b:example-->…'` | `8b2cbfd8` |

Checked clean: the server reads the stored body (never a client one); ticks render in all four renderers
(ruling 36, per-renderer tests); nothing truncates — the intake refuses `source_too_large` and the PDF renderer
refuses `page_limit_exceeded`, both visible; filenames are bare basenames, and the download header is
RFC 5987-encoded.

### Other

| # | Sev | Where | What breaks | Test (red) | Commit |
|---|---|---|---|---|---|
| 32 | Low | `messages/[messageId]/document/+server.ts:18` | "Open as document" titled the Document with the first line's Markdown (`**Weekend plan** for *Vienna*`). | `"title": "**Weekend plan** for *Vienna*"` | `13f4c654` |

## The live eval (hunt 9)

Re-ran the document suite once on the production model, `qwen3-6-27b`, through the one-command tunnel:
**7 cases scored, 7 good, 0 bad; the known-bad case failed as expected** (`knownBadFailedAsExpected: true`,
`stoppedEarly: false`) — the committed 7/7 is confirmed. No fixture was re-recorded. `--replay` after every
engine change still scores 7/7.

Recipe note: `~/.ssh/config` has `ControlMaster auto` / `ControlPersist 10m`, so `ssh -N -L … & … kill $T` does
**not** close the forward — the client exits at once (the `kill` fails) and the forward lives on in the shared
master for ten minutes. I closed mine with `ssh -O cancel -L 30620:192.168.1.96:30000 alfyroot` (verified the
port closed). The recipe should say so, or use `-o ControlMaster=no`.

## Open questions (no code)

1. **Alfy-written Markdown the editor re-spells.** Measured through the real editor: bare URLs →
   `[url](url)`, `&` → `&amp;`, `<`/`>` → entities, `_em_` → `*em*`, `__strong__` → `**strong**`, loose lists →
   tight, `~~~` → `` ``` ``, `***`/`___` → `---`, setext and closed-ATX headings, autolinks, raw HTML, `\_` in
   snake_case, footnote refs. A block Alfy wrote that way changes its hash on the first user-side save (any edit
   re-serialises the whole document), so a patch built on an **older** read is refused as "you changed this
   block" although the user did not touch it. Read-before-edit (the tool guidance) makes it rare, not impossible.
   Options: (a) extend the canonical form with the structural rewrites (loose→tight, fences, rule spelling,
   heading forms, `_`→`*`); (b) a hash-only equivalence for entities and autolinks — which breaks the spec's own
   "stored bytes are hashed bytes"; (c) accept. I recommend (a) plus a decision on (b).
2. **`read_artifact` "full" on a Document sends the text twice** (every block's text, then the same text
   joined as `body`), each capped separately at 100 000 characters — up to ~200 000 characters per read. Blocks
   alone (or body alone) would halve the model context.
3. **Editor vs editor (two tabs typing) still coalesce blind:** the editor's autosave carries only
   `expectVersion`. The route now accepts `baseHash`; threading the last-saved body hash through
   `DocumentBody.svelte`'s autosave would close it (RV-1B's file, so not done here).
4. **Undo of a multi-block Alfy change:** the engine records the added blocks on the inverse
   (`insertedBlockIds`, #3), but `marks.ts`'s Undo and the live channel's `reconstructDocumentPatch` restore only
   the original block — the added blocks stay. RV-1B.
5. **Partial `@Alfy` refusals** are not visible in the thread: the reply is the model's own note ("Fixed both
   typos") even when one op was refused; the route returns the refused count. A UI decision.
6. **A fuzz residue, not fixed:** 20 000 random constructs through `normalizeMarkdown` and a reload now leave one
   class unstable (52 → 26 cases, all the same shape): a bullet whose whole text looks like a delimiter row
   (`* |:--|--:|`) is rewritten to `- |:--|--:|`, which the next pass reads as a table. Pre-existing and
   garbage-in; noted so nobody rediscovers it.
7. **Spec drift, not a defect:** the Contracts table's `PATCH /api/artifacts/[id]/document/patches` and the
   client's `applyArtifactPatches` were never built; "Ask Alfy" on a selection goes through a comment and the
   `@Alfy` hook instead. Worth confirming that is the intended shape, and dropping the row if so.

## Found in passing, for RV-1B (editor, not fixed here)

- **A Markdown image crashes the editor on open** (`RangeError`/"Called contentMatchAt on a node with invalid
  content", from the trailing-node plugin's `appendTransaction`): a Document Alfy writes with `![…](…)` — e.g.
  after `image_search` — cannot be opened in the panel.
- **A `|` typed in a table cell is serialised unescaped** (`x|y`): the canonical form (correctly) reads a new
  column, and GFM drops the excess cell. The table serializer must escape it.
- **Task items cannot hold a hard break:** the task-item tokenizer reads neither a backslash break nor a lazy
  continuation, and the serializer writes `- [ ] a␠␠\nb`, which it cannot read back — Shift+Enter in a task
  item is lost (the canonical form leaves task items as they were rather than add a stray `\`).
- **A code block whose content contains a ```` ``` ```` line is written with a ```` ``` ```` fence**, so the
  content closes it: on reload the block is cut, the rest of the document is swallowed into a new code block,
  and a block marker ends up inside code. The serializer must use a longer fence than any run in the content.
- **A paragraph whose text starts `2024. ` or `- ` is written unescaped**, so it reloads as a list (the input
  rules make this rare when typing; pasting reaches it).
- My one editor-file change is #10 (`extensions.ts`, one loop in `buildAbsorbAndMintTransaction`); the
  existing `noUnusedVariables` warnings there are untouched.

## Gate summary

Full gate run at the last fix commit (`bash gates.sh …/rv-1a 5620 rv-1a` with the three artifact specs):

```
gates rv-1a at 21245078 fix(artifacts): a list item's second paragraph stays in the ite — start 14:54:22
check      exit=0 :: COMPLETED 7893 FILES 0 ERRORS 17 WARNINGS 3 FILES_WITH_PROBLEMS
biome      exit=0 :: Found 2 warnings.
migrations exit=0 :: All schema tables have corresponding migrations.
test       exit=0 ::  Test Files 867 passed | 1 skipped (868)  Tests 12886 passed | 2 skipped (12888) 
build      exit=0 :: unused-css=32 aria=2 (baseline 32/2)
fallow     exit=0 :: total=124 circular=4 new_vs_baseline=0 gone_vs_baseline=0
playwright exit=0 ::  46 passed (1.5m) 
done 14:58:49
```

Plus: `npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts` → **30 passed** (28 + the two new
cases, no exemption added); the named ruling-12 gate `npx vitest run src/lib/shared/artifact-document -t
"canonical form"` → 4 passed.

Against the starting gates at `e17c6f09`: check 0 errors / 17 warnings (held), biome 2 warnings (held — the
two `noUnusedVariables` in `extensions.ts` are RV-1B's), migrations clean, tests 12,823 → **12,886** (+63, all
this review's), build 32 unused-CSS + 2 ARIA (held), Fallow 124 / 4 circular / 0 new (held), Playwright **46**
(held; the two `✘` lines are RV-1B's `test.fail()` tests failing as expected).

One earlier full run had Playwright at 45 failed / 1 passed: every page failed to hydrate
(`TypeError: Cannot read properties of undefined (reading 'call')`) because the symlinked, shared
`node_modules/.vite` (art-s1's install) was re-optimised by another worktree's dev server mid-run. Nothing had
changed in this worktree; the rerun above is clean. Worth knowing for the other reviewers: two concurrent dev
servers on the shared install can break each other.

## Branch

`feat/artifacts-s1-review-engine` on top of `e17c6f09`: 32 fixes (33 commits, counting the anchor perf
follow-up) with their red tests, one coverage-only containment test, and this review as the last commit. The
code the gates above ran on ends at `21245078`.
