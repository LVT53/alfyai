# Slice 1 — Document

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Make the **Document** type real: Markdown with persisted block ids, Alfy's `read_artifact` /
`edit_artifact` with per-block hashes and per-op refusal, versions with restore, the lazy Tiptap editor in the
panel, tracker chips, tabs, comments with `@Alfy`, a mobile toolbar of its own, export through `produce_file`,
and its evaluation suite wired as a gate.

**Architecture:** The block model, the patch engine and the comment-anchor resolver are **pure, shared and
Tiptap-free** (`src/lib/shared/artifact-document/`), so the **server** can refuse a patch and the **browser**
can render one with the same code. Tiptap is only the view, living behind a lazy `import()` in the panel. The
last-read snapshot that makes "your words win" possible is persisted in `artifact_kv` under `alfy.snapshot`,
which is why it is server state and not a browser variable.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle on better-sqlite3, `@tiptap/*` **3.31.3** (core,
starter-kit, extension-list, extension-table, extension-placeholder, markdown, pm — the exact set the prototype
used, read from its `package.json` before adding), Vercel AI SDK tools with Zod, Vitest, Playwright, Biome,
Fallow.

**Spec:** [`claude-at-home-2-artifacts-spec.md`](./claude-at-home-2-artifacts-spec.md) §2.4–2.8, §3 (Document body), §4, §5, §6
(Slice 1), §7. Design target: the Document frame of
[`claude-at-home-2-artifact-types-mockups.html`](./claude-at-home-2-artifact-types-mockups.html) and the reference
implementation in the prototype at
`.claude/worktrees/agent-a883f7e86c2b442fd/src/routes/prototype/document/` (`_lib/doc-model.ts`,
`patch-engine.ts`, `comments.ts`, `anchor-state.ts`, `alfy-change.ts`, `tracker-chip.ts`, `sidecar.ts`,
`extensions.ts`, `editor-runtime.ts`, `PrototypeToolbar.svelte`, `PrototypeMargin.svelte`,
`PrototypeSelectionBubble.svelte`).

## Global Constraints

- **Node 22 only.** Prefix every npm/npx/vitest/playwright call with
  `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **"Artifact" is never shown in the UI** (ADR-0066). The type is **Document / Dokumentum** in every string,
  `title`, `aria-label` and error. `chat.artifacts.*` and `artifacts.document.*` must be in `AUDITED_PREFIXES`,
  and Slice 0's no-`/artifact/i` dictionary test must stay green.
- **Your words win** (spec §2.5). A patch whose block the user changed after Alfy's last read is **refused per
  op**; the refusal is visible, the other ops still apply, and Alfy never silently overwrites.
- **Block ids are minted or absorbed immediately after parse** — before hashing, snapshotting or rendering
  (spec §2.6). This is the prototype's one real bug; it is the first test in Task T1.
- **The editor is lazy.** The chat route, the panel shell and the margin must not import Tiptap or
  ProseMirror — not even transitively. The prototype split `anchor-state.ts` out of `comments.ts` for exactly
  this reason; keep that discipline.
- **No sharing, ever** (spec §2.16). No permissions, no invitations, no multi-user merge code.
- **Server authority.** Nothing in the browser decides whether an edit is allowed. The browser proposes, the
  server refuses or applies, and the browser renders the outcome.
- **Ownership:** every artifact read/write goes through the `artifacts/` facade and its scope. **No new
  `ALLOWED_WITHOUT_SCOPE` exemption.** The kv snapshot is read through a scoped artifact id, which is the rule
  Slice 0 added for `artifact_kv`.
- **Schema:** no new table in this slice. If one becomes necessary, it needs a migration **and** a
  `_journal.json` entry **and** a `user-scoped-tables.ts` entry in the same commit.
- **No new runtime-configurable setting** without `env.ts` + `config-store.ts` + the loaders + README +
  `.env.example`.
- **Svelte 5 only** in touched files; no new `<slot>`, `on:`, `createEventDispatcher`,
  `afterUpdate`/`beforeUpdate`. `bind:this` refs that an effect or handler reads are `$state(...)`.
- **Icons:** Lucide via `@lucide/svelte` only. The toolbar's names in the prototype are placeholders — map each
  to a real Lucide export in 1.17.0 (`bold`, `italic`, `strikethrough`, `heading-1`, `heading-2`, `list`,
  `list-ordered`, `list-checks`, `quote`, `code`, `table`, `link`, `undo-2`, `redo-2`, `ellipsis`,
  `message-square`, `sparkles`, `history`, `download`, `plus`, `x`, `chevron-down`, `panel-right`) and **verify
  each name against the installed package before using it** — a wrong name is a build error, not a silent fail.
- **i18n:** EN + HU in the same commit as the first string that uses it. Stored content values are **never**
  localized (see Contracts: chips). The mechanics are not optional: `src/lib/i18n/artifacts.ts` is registered in
  `I18N_MODULES` and `"artifacts."` is added to `AUDITED_PREFIXES` **by Slice 0**
  (`src/lib/i18n.test-helpers.ts:7-15` and `:16-90`), because the parity test only reads the modules that list
  names and only compares keys under an audited prefix (`src/lib/i18n.test.ts:15-21`, `collectDictionaryKeys`
  at `src/lib/i18n.test-helpers.ts:187-208`) — a namespace not named there is a namespace nothing checks, which
  is the pre-existing drift a bare `chat.` prefix already documents
  (`src/lib/i18n.test-helpers.ts:31-34`). This
  slice adds `"chat.artifacts."` in the commit that adds the first such key, spreads the module into
  `dictionary.en` / `dictionary.hu` (`src/lib/i18n/index.ts:44-67`), and uses the ICU plural the helper really
  implements — `{count, plural, one {…} other {…}}`, one/other only, no nested braces
  (`src/lib/i18n/index.ts:73-80`).
- **Commits:** small and focused, staged by explicit path, explaining the *why*; never a bare `git stash`; every
  message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Never push.
- **`npm run lint` is broken** by nested worktrees — run `npx biome check src scripts tests` and say so.

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check                     # 0 errors, 0 warnings
npx biome check src scripts tests
npm test
npm run build                     # 0 warnings
npm run check:migrations          # this slice adds no table; must stay clean
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-document.spec.ts tests/e2e/chat.spec.ts tests/e2e/mobile-design.spec.ts
```

**Named gates.** Four checks fail this slice on their own, and each has a test that names it:
`npx vitest run src/lib/shared/artifact-document -t "canonical form"` — **ruling 12's gate**: open → serialise →
reload → serialise with **no user edit** produces identical hashes for every block;
`npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts` — with **no** new
`ALLOWED_WITHOUT_SCOPE` entry (a Document reads `artifacts` by user, so a file that touches
`.from(artifacts)` without a scope marker fails it, `tests/cross-cutting/incognito-artifact-containment.test.ts:498-508,561-593`);
`npm run check:migrations` — this slice adds no table, so it must stay clean, and a stray `CREATE TABLE` is a
hard stop; and the recorded chunk pair below. A slice is not done while one of these is red.

**Chunk budget, asserted not assumed.** The chat route and the panel shell must not grow by the editor's cost.
Record the measured pair (`panel shell` and `editor` chunk, raw and gzip) from the build output before and after
this slice, in the slice report, with the method (the build manifest or a `--json` build log). The findings doc
records the prototype's route at **157 kB gzip**, dominated by Tiptap/ProseMirror (line 64), and this slice's
acceptance is that **the same page without a Document open is unchanged** — the editor's bytes load only when a
Document opens.

## Review Focus

1. **Ids minted too late.** If a marker is written after the first hash or snapshot, the first read has no
   identity and *every* patch is refused. The prototype hit this. T1 asserts the order explicitly, and T3's
   round-trip test asserts that a freshly created Document is immediately patchable **after a reload**.
2. **The hash substrate must be computable on both sides.** The prototype hashed ProseMirror JSON — only the
   browser can do that, and the server is the one that must refuse. T1 hashes the **block's canonical Markdown
   with its id marker stripped**, which both sides compute from the same module. **Ruling 12 is binding here:
   hashing the raw serialiser output is wrong**, because the prototypes measured that a mere reopen rewrote six
   table lines' padding and blank lines — so a plain open would change hashes and every patch would be refused
   as "you changed this block". The canonical form is defined once, next to the hasher, and pinned by the named
   gate above; T1.6 is the pure half and T7.5 the editor half.
3. **A patch that half-applies.** Per-op refusal is the contract: the applied count, the refused list and the
   visible notice must all agree, and a refused op must not have mutated the body. T2 asserts this per reason.
4. **The refusal being invisible.** "Your words win" is only a feature if the user sees it. T8's test drives the
   refused path and asserts the notice names the block, not a generic error.
5. **Tiptap leaking into the route chunk.** Importing `comments.ts` (which reaches Tiptap in the prototype) from
   the margin pulls the whole editor into every chat page. T7 asserts the built panel-shell chunk does not grow,
   and the review greps the non-editor modules for `@tiptap`/`prosemirror` imports.
6. **Anchors that lie.** A comment showing "Exact" when the quote moved is worse than no comment. T10 asserts
   all three anchor states against real edits, including the orphan.
7. **The mobile toolbar eating the screen.** The prototype's single toolbar was 226 px of an 844 px phone
   viewport (27 %; chrome 322 px = 38 %) before its own fix, and 137 px after it — the parent spec's "29 %"
   is that unfixed number rounded up, not a budget. T11 has its own layout and a Playwright assertion on its
   height (≤ 48 px) and on the editor keeping its share of the viewport.
8. **Chips leaking locale into content.** A stored `value="Booked"` is content and must not become
   `value="Foglalt"`; only the label is translated (T9).
9. **The eval gate being skipped.** §4 makes the harness a gate per type, not a one-off. T13 wires it and the
   slice is not done until it has run against the real model and its result is in the report — a weak result
   changes the design rather than being argued away (spec §8.1).
10. **The body component's props drifting from Slice 0's registry.** `ArtifactBodyProps` is fixed by Slice 0
    (`slice-0.md:687-697`): **flat props** — `artifactId`, `kind`, `title`, `body`, `onDirtyChange?`,
    `onBodyChange?` — and the registry resolves `ARTIFACT_BODIES[kind]` through a cached-promise loader
    (`slice-0.md:698-706`). `DocumentBody.svelte` takes **exactly** those props; the editor factory's own options
    (`createDocumentEditor({ element, markdown, … })`) are internal to this slice and must not leak into the
    registry contract, or slice 4's Slides body and slice 3's Canvas body stop being drop-in.
11. **Markers reaching a user-facing file.** `<!--b:…-->` is addressing, not content. T12.3 asserts the source
    handed to the renderer contains none, and the Markdown export path must strip them too (T12.4) — a marker in
    a downloaded file is a bug that looks like corruption to the user.

---

## Contracts

### The shared block model — `src/lib/shared/artifact-document/blocks.ts`

Pure TypeScript, **no Tiptap, no ProseMirror, no DOM, no Svelte** — importable from `$lib/server/**` and from
the browser. This is what makes the server able to refuse.

```ts
export const MARKER_PREFIX = "<!--b:";
export const MARKER_RE = /^<!--b:([A-Za-z0-9_.-]+)-->$/;

export type BlockKind = "paragraph" | "heading" | "list" | "taskList" | "table" | "blockquote" | "code" | "hr" | "other";

export interface DocumentBlock {
	/** Stable across reloads because it is written into the Markdown. */
	id: string;
	kind: BlockKind;
	/** The block's Markdown with the id marker line removed. Hashing input and the patch unit. */
	markdown: string;
	/** fnv1aHex(normalizeMarkdown(markdown)) — the same value on both sides. */
	hash: string;
	/** The first line of visible text, for the model's blockLabel and the UI's refusal notice. */
	label: string;
}

export interface ParsedDocument {
	/** The canonical Markdown, with one marker line before every block. */
	markdown: string;
	blocks: DocumentBlock[];
	/** true when this parse minted at least one id — the caller must persist the result. */
	minted: boolean;
}

/**
 * Parse, then mint or absorb. The mint happens HERE, before any hash is
 * computed, so the returned blocks always have ids. Never hash a document
 * that has not been through this function.
 */
export function parseDocument(markdown: string, opts?: { mint?: boolean }): ParsedDocument;

export function serializeDocument(blocks: DocumentBlock[]): string;
export function normalizeMarkdown(markdown: string): string;
export function blockHash(markdown: string): string;                 // fnv1aHex(normalizeMarkdown(markdown))
export function fnv1aHex(input: string): string;
export function mintBlockId(kind: BlockKind): string;          // prefix + 5 base36 chars, e.g. "p7k2xq"
export function countMarkers(markdown: string): number;
export function buildIndex(blocks: DocumentBlock[]): Record<string, string>;   // id → hash
```

Rules:

- **Ruling 12: the canonical form, defined here and next to the hasher.** `normalizeMarkdown` is the **one**
  canonicaliser, and `blockHash` is the **one** hasher. The canonical block form is exactly:
  1. **trimmed lines** — no trailing whitespace on any line, and no leading whitespace on a non-indented line;
  2. **collapsed table padding** — `| a  |   b |` and `| a | b |` normalise to the same key (this is the one the
     prototypes lost: reopening rewrote six table lines' padding);
  3. **normalised list markers** — `*`/`+`/`-` bullets become `-`, ordered markers become `N.` with the number
     kept, `- [x]`/`- [X]` becomes `- [x]` and `- [ ]` stays `- [ ]`;
  4. **no trailing blank lines** — a block's Markdown ends with its last non-blank line, and internal runs of
     3+ blank lines collapse to one;
  5. **stabilised chip syntax** — `[chip kind="status" value="Booked"]` attribute order and quoting are fixed.
  `normalizeMarkdown` is **idempotent** (the property the whole thing rests on), `blockHash` is
  `fnv1aHex(normalizeMarkdown(markdown))`, and `serializeDocument` writes the normalised form — so the stored
  Markdown and the hashed Markdown cannot drift apart. Both sides hash its output, so a Tiptap round-trip that
  shifts padding does **not** invalidate every hash. Without this, "your words win" refuses everything the
  moment the user touches the editor.
- **Pinned by the ruling's own test, in two places.** The pure half is
  `blocks.test.ts` → `"canonical form: open → serialise → reload → serialise keeps every hash"` (parse, serialise,
  parse the serialised string again, compare `buildIndex` maps — **no user edit in between**); the editor half is
  T7.5, twice in a row through real Tiptap. The named gate command in Gates runs the pure half by name.
- `parseDocument` returns `minted: true` when it wrote ids. Callers that get `minted: true` **must persist the
  canonical Markdown** before doing anything else — that is the prototype's trap, written as an API contract.
- A marker line addresses **the block that follows it**. A marker with no following block, and a block with no
  marker, are both handled (the first is dropped, the second mints).
- `mintBlockId` prefixes by kind so a hand-read board is legible: `p` paragraph, `h` heading, `l` list,
  `t` taskList, `tb` table, `q` quote, `c` code.
- A block's `markdown` **never contains the marker**. `serializeDocument` is the only function that writes
  markers.

#### The anchor interface — `src/lib/shared/artifacts/anchor.ts` (**shared with Slice 3**)

Per **ruling 11** there is one anchor interface in `src/lib/shared/artifacts/`, implemented **per type**. This
slice creates that file and ships the Document's resolver; Slice 3 appends the canvas resolver. The interface is
the only thing the two types share — the resolver is not.

```ts
/** The one anchor DTO. `text` is the Document's; `node`/`point` are Slice 3's. */
export type Anchor =
	| { kind: "text"; blockId: string; quote: string; prefix: string; suffix: string }
	| { kind: "node"; nodeId: string }
	| { kind: "point"; x: number; y: number };

/** Ruling 11 names the three outcomes; they are the vocabulary, not a number. */
export type AnchorState = "exact" | "moved" | "orphaned";
export type AnchorTone = "ok" | "warn" | "lost";

export interface AnchorResolution {
	state: AnchorState;
	/** null when the anchor is orphaned and no block can be named any more. */
	blockId: string | null;
	/** Character range inside the resolved block; -1/-1 when orphaned. */
	from: number;
	to: number;
}

/** The single mapping from state to the label's tone, so the two cannot drift. */
export function anchorTone(state: AnchorState): AnchorTone;   // exact→ok, moved→warn, orphaned→lost
export function anchorStateFor(score: number): AnchorState;   // >=4 → "exact", >0 → "moved", else "orphaned"
```

`src/lib/shared/artifact-document/anchor.ts` — the Document's **text** resolver, pure, on top of the interface
above (Slice 3's file is `src/lib/shared/artifacts/canvas-anchor.ts`, and it must not reimplement this one):

```ts
export function makeAnchor(blocks: DocumentBlock[], blockId: string, quote: string, prefix: string, suffix: string): Extract<Anchor, { kind: "text" }>;
export function resolveTextAnchor(blocks: DocumentBlock[], anchor: Extract<Anchor, { kind: "text" }>): AnchorResolution;
export function reanchor(blocks: DocumentBlock[], anchor: Extract<Anchor, { kind: "text" }>): Extract<Anchor, { kind: "text" }> | null;   // best-effort re-point after a block is split
```

`resolveTextAnchor` is the prototype's `resolveAnchorIn`/`scoreAt` moved onto shared blocks: **+4** for a hit
inside the anchor's own `blockId`, **+2** for a matching prefix, **+2** for a matching suffix, over at most
**50** candidate positions per block (the prototype's cap — a document is user-sized and an unbounded scan is the
one place a comment could cost O(document) per render; see Limits). `anchorStateFor` turns the score into the
state: `0`/nothing found means `orphaned`. The UI never prints the score — it prints `Exact`, `Moved`,
`Orphaned` from `artifacts.document.anchor.*` with the tone from `anchorTone`, so the label and its colour cannot
disagree.

**Cross-slice note (report, do not fix elsewhere).** Slice 0 already declares the same union as `ArtifactAnchor`
in its own server-only `comments.ts` (`slice-0.md:429-433`), with `parseArtifactAnchor` as the validating parser
(`slice-0.md:445`, and its own note at `:451-455` that the *resolution* is per type). The two are structurally
identical, so nothing breaks in either order; the clean end
state is one line in `types.ts` — `export type ArtifactAnchor = Anchor` imported from the shared module — which
is an additive, type-only edit to a Slice 0 file (serialise: Slice 0 first). If the owner prefers to leave Slice
0 untouched, the shared file still stands on its own because TypeScript unions are structurally compared. The
server may import from `$lib/shared/…` — `file-production/intake.ts:8` already imports
`isInlineTextOutputType` from `$lib/shared/file-types/production`.

### The patch engine — `src/lib/shared/artifact-document/patch.ts`

Also pure. Runs on the server for every model patch and in the browser only to render the outcome.

```ts
export type PatchOpKind = "replaceBlock" | "insertText" | "replaceRange" | "toggleTask" | "addTableRow";

export interface PatchOp {
	opId: string;
	kind: PatchOpKind;
	blockId: string;
	/** The block's hash as the model read it. The whole guard. */
	baseHash: string;
	/** What the model calls this block, for the refusal notice. */
	blockLabel: string;
	text?: string;
	/** replaceRange: the exact text inside the block this op rewrites. */
	find?: string;
	at?: "start" | "end";
	checked?: boolean;
	cells?: (string | { chip: { kind: "status" | "date"; value: string } })[];
}

export interface PatchSet { patchId: string; label: string; note?: string; ops: PatchOp[] }

export type RefusalReason =
	| "block_missing"        // "block no longer exists"
	| "block_unseen"         // "not in Alfy's last read (no hash to check)"
	| "block_changed"        // "you changed this block after Alfy last read it"
	| "not_a_text_block"
	| "empty_text"
	| "find_not_found"       // replaceRange: `find` is not in the block
	| "find_ambiguous"       // replaceRange: `find` occurs more than once
	| "not_a_task_block"
	| "not_a_table_block"
	| "bad_row";             // cells length does not match the table's columns

export interface OpOutcome {
	opId: string; kind: PatchOpKind; blockId: string; blockLabel: string;
	status: "applied" | "refused";
	reason?: string;                  // human-readable, localized by the UI from `code`
	code?: RefusalReason;
}

export interface PatchResult {
	patchId: string; label: string; appliedAt: number;
	outcomes: OpOutcome[]; applied: number; refused: number;
	blocks: DocumentBlock[];          // the document after the applied ops
	markdown: string;                 // serializeDocument(blocks)
	/** Applied ops in reverse, so Undo is exact rather than a re-parse. */
	inverses: PatchInverse[];
}

export function applyPatchSet(input: { blocks: DocumentBlock[]; patch: PatchSet; snapshot: Record<string, string> }): PatchResult;
```

The guard, per op, in this order — **all three must agree**:

1. `findBlock(blocks, op.blockId)` → missing ⇒ `block_missing`.
2. `snapshot[op.blockId]` → absent ⇒ `block_unseen`.
3. `snapshot[op.blockId] !== blocks[i].hash || snapshot[op.blockId] !== op.baseHash` ⇒ `block_changed`.

`snapshot` is what Alfy last read. `blocks[i].hash` is what the document says now. `op.baseHash` is what the
model claims it read. The prototype compared exactly these three (`patch-engine.ts:141-152`).

Then the op is applied to that block's `markdown` **text** (never to a ProseMirror range), and the whole document
is re-serialised. Ops:

- `replaceBlock` — the block's markdown becomes `op.text`, re-normalised. Refuses `empty_text`.
- `insertText` — `at: "start" | "end"` inside the block's first/last paragraph-ish line; refuses
  `not_a_text_block` and `empty_text`.
- `replaceRange` — `find` must occur **exactly once** in the block; zero ⇒ `find_not_found`, more than once ⇒
  `find_ambiguous`. Ambiguity is refused, never guessed: this is the server-side reading of §2.5.
- `toggleTask` — flips `- [ ]`/`- [x]` on a task item inside the block; refuses `not_a_task_block`.
- `addTableRow` — appends a row; refuses `not_a_table_block` and `bad_row` when the cell count does not match the
  header row.

A refused op **must leave `blocks` untouched**: the engine applies ops to a copy and the caller only receives
blocks that include applied ops. Assert this in T2 for every refusal reason.

### The last-read snapshot

`artifact_kv` under key **`alfy.snapshot`**, value `{ at: number, docVersion: number, index: Record<string, string> }`.

- `read_artifact` writes it in the same transaction as the read (with `docVersion` = the version it read).
- `edit_artifact` reads it, passes `snapshot.index` to `applyPatchSet`, and on success writes the new body
  **and** a fresh snapshot (so Alfy's next edit is against what it just wrote).
- A missing snapshot is not an error: every op refuses `block_unseen`, which is the correct answer for "Alfy has
  never read this document".
- It is server state on purpose. A browser-held snapshot would make "your words win" a client-side promise; the
  spec says it is a server decision (§4).

### Service and routes

`src/lib/server/services/artifacts/serialize/document.ts` — the Document's serializer, registered against
Slice 0's `ArtifactSerializer` interface:

```ts
export interface DocumentBody { markdown: string; tabs: DocumentTab[] }
export interface DocumentTab { id: string; title: string; startBlockId: string }

export const documentSerializer: ArtifactSerializer<DocumentBody>;
// createBody(input: { title: string; markdown?: string }): DocumentBody   → parse + persist ids
// parse(body: string): DocumentBody | null
// serialize(body: DocumentBody): string                                    // the stored form
// hashBody(body: DocumentBody): string
```

**Unverified, and the implementer must read the real file first:** `ArtifactSerializer` is declared by Slice 0
(`slice-0.md:292` puts it in `serialize/index.ts` with a registry, and `slice-0.md:1199` fixes the lookup
contract: a kind with no serializer returns `null`, never a throw), and Slice 0 has **not landed in this
worktree** — there is no `src/lib/server/services/artifacts/` here yet (`ls` on that path: no such directory).
The signatures above are the shape this slice needs; take the exact generic from the landed interface and adapt
to it rather than inventing a second one. Do not build a parallel registry: `serialize/index.ts` owns it and this
slice adds the `document` entry beside Slice 0's `file` entry.

`DocumentBody.tabs` is the tab strip, and `startBlockId` names the **first block of that section** — a tab is a
marker into the one Markdown body, not a second body. **Where the two halves are persisted, said once, because
it is the one thing `DocumentBody` does not answer by itself:**

- `artifacts.content_text` holds the **Markdown only**, with its `<!--b:id-->` markers (spec §3), and
  `artifact_versions.body` is the same string at that point in time (spec §3's DDL comment: "the whole
  serialised artifact at this point").
- The tab strip goes to **`metadata_json.tabs`**, written through `metadataPatch` in the same transaction as the
  body (`updateArtifactBody` below). So `serialize(body: DocumentBody)` returns `body.markdown`, and the tabs
  never enter the version store: a version is text.
- Consequence for restore (T6): restoring an older version restores the **text** and leaves the tab strip alone.
  A tab whose `startBlockId` is absent from the restored blocks is resolved **on read** — the strip maps it to the
  block at that tab's ordinal position (its own first block, or the last block when nothing follows) rather than
  dropping the tab, because dropping it would take its comments with it (T9.2). Never destroy user-visible state
  to make a read simpler.
And what stays **unused**: `ArtifactMetadata.idIndex` (Slice 0's `types.ts`, `slice-0.md:308-312`) is **not
written by this slice** — the block index is derived on demand from the parsed blocks, so there is exactly one
index in the system and no second one to keep in sync (this slice's Owner decision 2).

`src/lib/server/services/artifacts/document-ops.ts` — the Document's server-side operations, so routes and tools
stay thin:

```ts
export async function readDocumentForAlfy(params: { userId: string; artifactId: string }): Promise<{
	artifactId: string; title: string; version: number; tabs: { id: string; title: string }[];
	blocks: { blockId: string; kind: BlockKind; label: string; hash: string; text: string }[];
}>;
export async function applyDocumentPatch(params: { userId: string; artifactId: string; patch: PatchSet }): Promise<
	{ ok: true; result: PatchResult; version: number } | { ok: false; reason: "not_found" | "not_a_document" }
>;
export async function createDocumentArtifact(params: { userId: string; conversationId: string | null; title: string; markdown?: string; author: ArtifactAuthor; summary: string }): Promise<ArtifactRecord>;
export async function saveDocumentBody(params: { userId: string; artifactId: string; body: DocumentBody; author: ArtifactAuthor; summary: string }): Promise<{ ok: boolean; reason?: string; version?: number }>;
```

`readDocumentForAlfy` returns **text, not Markdown**: the model gets `blockId`, `label`, `hash` and the block's
text, and never sees a marker. `edit_artifact` returns the `PatchResult` (applied count, per-op refusals with
their labels) so the model can react, exactly as §4 requires.

Additive extensions to Slice 0's service (do not break its callers): the three optional parameters
`metadataPatch?`, `snapshot?` and `expectVersion?` plus the `version_conflict` reason, declared once and verbatim
under **File ownership → the `updateArtifactBody` diff** below. `saveDocumentBody` is the Document's own wrapper
around it: it calls `updateArtifactBody({ body: serialize(body), metadataPatch: { tabs: body.tabs }, … })` (with
`serialize` from the serializer above, whose result **is** `body.markdown`), so tabs and text land in one
transaction and no route builds that pairing itself.

A `version_conflict` is what makes two panes (a chat and the panel) unable to silently clobber each other. It is
an **extension of Slice 0's declaration**, which has already landed in the plan branch (commit `9395f3d4`) —
edit that declaration rather than adding a second `updateArtifactBody`, and keep its existing optional `baseHash`
and its `too_large` / `stale` / `hash_mismatch` reasons.

Routes (thin, ownership-scoped, `requireAuth`):

| Route | Request | Response |
|---|---|---|
| `PATCH /api/artifacts/[id]/body` | `{ body, expectVersion }` | `{ ok: true, version }` \| 409 `{ ok: false, reason: "version_conflict", version }` |
| `PATCH /api/artifacts/[id]/document/patches` | `{ patch: PatchSet }` | `{ ok: true, applied, refused, outcomes, version }` — used only by the panel's own "Ask Alfy on a selection" path (T10b); the model path goes through the tool |
| `GET /api/artifacts/[id]/versions` | — | `{ versions: ArtifactVersionSummary[] }` |
| `GET /api/artifacts/[id]/versions/[versionId]` | — | `{ body }` |
| `POST /api/artifacts/[id]/versions/[versionId]/restore` | — | `{ ok: true, version }` |
| `POST /api/artifacts/[id]/comments` | `{ anchor, body, parentId? }` | `{ comment }` |
| `POST /api/artifacts/[id]/comments/[commentId]/resolve` | `{ resolved }` | `{ ok }` |
| `POST /api/artifacts/[id]/comments/[commentId]/alfy` | — | `{ ok, patchResult }` — the `@Alfy` hook (T10b) |

**The body field is named `body`, for every type** (`decisions.md` ruling 13): a Document's body happens to be
Markdown, which is why its value is the serialised document — `serializeDocument(parseDocument(markdown).blocks)`
— but the request field, the version response field and the service parameter are all `body`. No `markdown`
alias, no per-type field name: Canvas and Slides write JSON through the same route shape, and a field called
`markdown` would lie for three of the five types.

Client API in `src/lib/client/api/artifacts.ts` (extend Slice 0's module; same `fetchImpl` / `requestJson`
shape): `saveArtifactBody`, `applyArtifactPatches`, `fetchArtifactVersions`, `restoreArtifactVersion`,
`createArtifactComment`, `resolveArtifactComment`, `askAlfyInComment`.

### The tools — `normal-chat-tools/artifacts.ts`

Schema and `run` live in their own module (the house pattern: `produce-file.ts`, `read-generated-file.ts`), and
`normal-chat-tools/index.ts` registers them beside `produce_file`. Usage guidance lives in the tool
**interface** (ADR-0055), so the prompt block is one place.

```ts
create_artifact: { artifactType: z.literal("document"), title: z.string(), body: z.string() }   // Markdown
read_artifact:   { artifactId: z.string() }
edit_artifact:   { artifactId: z.string(), patches: z.array(patchOpSchema), label: z.string() }
```

- `artifactId` is **never** model-facing for `create_artifact`; the tool's scope (`userId`, `conversationId`,
  turn id) is server-owned, exactly like `produce_file`.
- `read_artifact` on a non-Document id returns a model-safe failure naming the type, not a stack trace.
- `edit_artifact` returns `{ applied, refused: [{ blockId, blockLabel, code, reason }], version }` — the model
  must see the refusal *and* its label, or it will simply retry the same op.
- A successful `create_artifact` / `edit_artifact` links the artifact to the assistant message that caused it
  (the same mechanism `generatedFiles` already uses on the stream metadata) so the card and the count in the
  chat header follow a Document exactly as they follow a produced file.
- **Prompt guidance is not a gate.** The server refuses; the prompt only makes refusal rare. Do not add a
  prompt-side guard that pretends to enforce the hash rule (spec §4).

### The panel editor (client)

| File | Owns |
|---|---|
| `src/lib/components/artifacts/document/DocumentBody.svelte` | the Document body the panel's registry loads: tab strip + toolbar + editor host + margin. **Not** the editor itself |
| `src/lib/components/artifacts/document/DocumentToolbar.svelte` | desktop toolbar (one row) |
| `src/lib/components/artifacts/document/MobileToolbar.svelte` | the phone toolbar: one row of 6 primaries + a `More` sheet (T11) |
| `src/lib/components/artifacts/document/MarginPanel.svelte` | comment threads, anchor states, `See change` / `Resolve` / `Reply` |
| `src/lib/components/artifacts/document/SelectionBubble.svelte` | `Ask Alfy` / `Comment` on a selection |
| `src/lib/components/artifacts/document/chips.ts` | the tracker chip's display layer: canonical stored value → localized label, the status dropdown |
| `src/lib/components/artifacts/document/document-editor.ts` | **the only module that imports `@tiptap/*`**. Exports `createDocumentEditor({ element, markdown, onDirty, onSelection, onChange })` and `readMarkdown(editor)`. Imported with `await import(...)` |
| `src/lib/components/artifacts/document/extensions.ts` | the extension list: StarterKit, `TaskList`/`TaskItem` from `extension-list`, `Table`/`TableRow`/`TableCell`/`TableHeader` from `extension-table`, `Placeholder`, and the two Document-specific nodes below |
| `src/lib/components/artifacts/document/marks.ts` | `AlfyChange` mark + widget (the inline `Alfy · Keep · Undo`) |

Two custom nodes keep the markers and the chips alive through the round-trip, mirroring the prototype:

- **`BlockIds`** (extension) — a `blockId` attribute on every block type, with a `buildBlockIdTransaction` that
  mints an id for any block that lacks one, dispatched with `addToHistory: false` so the user's undo stack is not
  polluted by bookkeeping.
- **`BlockMarker`** (node) — parses `<!--b:x-->` from Markdown, stores it, and serialises back to the marker
  line. `absorbBlockMarkers` on load moves it onto the following block's `blockId`; `injectMarkers` puts it back
  on serialise. None of the three may run after the first hash (Global Constraints).
- **`TrackerChip`** (node) — inline atom, serialises as `[chip kind="status" value="Booked"]`. Chip **values are
  canonical English tokens** (`Booked`, `To book`, `Paid`, `Cancelled`) plus ISO date strings for the date kind.
  The UI shows a localized label and edits the token; the stored content never changes with the locale.

**Export.** The panel's download action opens a small sheet (`Download PDF / DOCX / Markdown`) and posts
`{ format }` to **`POST /api/artifacts/[id]/export`**, which builds the source server-side and calls the existing
file-production intake in-process (`submitFileProductionIntake({ userId, body })`,
`file-production/index.ts:226`). The browser never builds a source: one mapping, one place (Owner decision 11).
**Two different modes, and the second one is not what this slice first assumed:**

1. **PDF and DOCX** — `sourceMode: "document_source"`, `documentSource: GeneratedDocumentSource`, and
   `requestedOutputs: [{ type: "pdf" }]` (or `docx`). `documentSource` is the exact field the intake reads
   (`src/lib/server/services/file-production/intake.ts:47` and `:435`), and the `document_source` mode is
   reserved for **pdf / docx / html** (`shouldUseDocumentSourceForOutputs`,
   `src/lib/shared/file-types/production.ts:72-88`); an empty `requestedOutputs` in this mode means "render the
   default PDF" (`intake.ts:216-230`). Build the source from the parsed blocks — do not invent a second source
   format. The Document → `GeneratedDocumentBlock` mapping
   (`src/lib/server/services/file-production/source-schema.ts:1-20`) is total, one row per block kind:

   | Document block | `GeneratedDocumentBlock` | Rule |
   |---|---|---|
   | `heading` (level 1–3) | `{ type: "heading", level, text }` | level clamped to 1–3; deeper ATX levels export as 3 |
   | `paragraph` | `{ type: "paragraph", text }` | inline `**bold**`/`*italic*` stay Markdown in `text`; chips become plain words |
   | `list` (bullet) | `{ type: "list", style: "bullet", items }` | one item per line, continuation lines folded in |
   | `list` (ordered) | `{ type: "list", style: "numbered", items }` | the source numbers are dropped; the renderer numbers |
   | `taskList` | `{ type: "list", style: "bullet", items }` | **the state is kept verbatim in the item text** (`"[x] Book the hotel"`), because the renderer's `items` are plain strings (`renderers/standard-report-pdf.ts` `drawList(style, items: string[])`, `renderers/standard-report-html.ts`'s `<li>`): dropping it would silently turn a checklist into a list |
   | `table` | `{ type: "table", … }` | header row required; a chip cell exports its label |
   | `blockquote` | `{ type: "quote", text }` | |
   | `code` | `{ type: "code", language: null, text }` | the fence's info string is dropped |
   | `hr` | `{ type: "divider" }` | |
   | `other` | `{ type: "paragraph", text }` | a block the splitter did not classify still exports its text |

   The renderer's `chart`, `image`, `sourceChips`, `confidenceMarker`, `basisMarker` and `pageBreak` blocks are
   **never** produced by a Document export — a document has no chart, image or page-break source. Do not invent
   one.
2. **Markdown** — `sourceMode: "inline_text"` with `inlineText: { content, files: [{ filename, outputType: "md" }] }`
   (`src/lib/server/services/file-production/intake.ts:296-380`, dispatched by
   `execution-adapter.ts:187` and written directly at `execution-adapter.ts:592`). `md` is
   `production.validation: "text"` and has **no** `documentSource` flag (`src/lib/shared/file-types/table.ts:61-77`;
   the flag is strictly narrower than `documentRenderKind`, `src/lib/shared/file-types/types.ts:127-134`), so
   `isInlineTextOutputType("md")` is true and the bytes are written **without a renderer and without a
   container**. The earlier draft of this slice said Markdown was "a direct body download through the existing
   chat-file download route": that is wrong — `src/routes/api/chat/files/[id]/download/+server.ts` resolves a
   **generated-file** id through `resolveGeneratedFileServing`, so a Document body has no row to download
   through, and a second download route for artifact bodies is exactly the duplicate plumbing the spec rules
   out. It also gets the markers stripped in the same pass (`serializeDocument` output minus marker lines).

   Filenames come from the artifact title and must satisfy the intake's basename rules: a bare basename, no
   leading dot, ≤ 120 characters (`sanitizedProducedFilename`, `intake.ts:278-289`), and for `inline_text` the
   name must end with the extension its type expects — `.md` (`intake.ts:353-380`). A title that cannot be a
   filename (empty after trimming, or longer than the cap) falls back to `document.md`.

   **The intake needs a conversation** (`intake.ts:396-406`: `"conversationId is required"`), and
   `artifacts.conversation_id` is nullable (`slice-0.md:317`, `:375`). Every Document this slice creates comes from a chat,
   so the null case is unreachable today, but the export route must not 500 on it: it answers
   **409** `{ ok: false, reason: "no_conversation" }` and the sheet shows
   `artifacts.document.export.noConversation`. Do **not** silently attach the document to whatever conversation is
   open — that would mutate the record to make an export work.

The produced file appears as a File artifact in the same chat, and lands in the panel's list, because it is a
produced file like any other — no new plumbing (spec §5).

### i18n (`src/lib/i18n/artifacts.ts`, the `artifacts.document.*` namespace; extend Slice 0's module)

| Key | EN | HU |
|---|---|---|
| `artifacts.document.cardSubtitle` | `Document · {count} tabs` | `Dokumentum · {count} fül` |
| `artifacts.document.openAsDocument` | `Open as document` | `Megnyitás dokumentumként` |
| `artifacts.document.tab.add` | `Add a tab` | `Fül hozzáadása` |
| `artifacts.document.tab.rename` | `Rename` | `Átnevezés` |
| `artifacts.document.tab.delete` | `Delete tab` | `Fül törlése` |
| `artifacts.document.tab.deleteConfirm` | `Delete “{name}” and its text?` | `Törlöd a(z) „{name}” fület és a szövegét?` |
| `artifacts.document.editor.placeholder` | `Write anything, or ask Alfy to.` | `Írj bármit, vagy kérd meg Alfyt.` |
| `artifacts.document.editor.failedToLoad` | `The editor could not be loaded.` | `A szerkesztőt nem sikerült betölteni.` |
| `artifacts.document.toolbar.bold` | `Bold` | `Félkövér` |
| `artifacts.document.toolbar.italic` | `Italic` | `Dőlt` |
| `artifacts.document.toolbar.strike` | `Strikethrough` | `Áthúzott` |
| `artifacts.document.toolbar.heading` | `Heading {n}` | `Címsor {n}` |
| `artifacts.document.toolbar.bullets` | `Bulleted list` | `Felsorolás` |
| `artifacts.document.toolbar.numbers` | `Numbered list` | `Számozott lista` |
| `artifacts.document.toolbar.tasks` | `Checklist` | `Feladatlista` |
| `artifacts.document.toolbar.quote` | `Quote` | `Idézet` |
| `artifacts.document.toolbar.code` | `Code` | `Kód` |
| `artifacts.document.toolbar.table` | `Table` | `Táblázat` |
| `artifacts.document.toolbar.link` | `Link` | `Hivatkozás` |
| `artifacts.document.toolbar.undo` | `Undo` | `Visszavonás` |
| `artifacts.document.toolbar.redo` | `Redo` | `Újra` |
| `artifacts.document.toolbar.more` | `More` | `Több` |
| `artifacts.document.change.alfy` | `Alfy` | `Alfy` |
| `artifacts.document.change.keep` | `Keep` | `Megtartom` |
| `artifacts.document.change.undo` | `Undo` | `Visszavonom` |
| `artifacts.document.change.keptNotice` | `Kept.` | `Megtartva.` |
| `artifacts.document.change.undoneNotice` | `Undone — your text is back.` | `Visszavonva — a szöveged visszaállt.` |
| `artifacts.document.refused.notice` | `{count, plural, one {Alfy left one part alone because you had changed it.} other {Alfy left some parts alone because you had changed them.}}` | `{count, plural, one {Alfy egy részt nem érintett, mert megváltoztattad.} other {Alfy néhány részt nem érintett, mert megváltoztattad.}}` |
| `artifacts.document.refused.changed` | `you changed this after Alfy last read it` | `ezt megváltoztattad, miután Alfy utoljára olvasta` |
| `artifacts.document.refused.unseen` | `Alfy has not read this part yet` | `Alfy még nem olvasta ezt a részt` |
| `artifacts.document.refused.missing` | `this part no longer exists` | `ez a rész már nincs meg` |
| `artifacts.document.refused.ambiguous` | `the text Alfy wanted to replace is not unique here` | `a szöveg, amit Alfy le akart cserélni, nem egyedi itt` |
| `artifacts.document.refused.other` | `Alfy could not apply this change` | `Alfy nem tudta alkalmazni ezt a módosítást` |
| `artifacts.document.save.offline` | `Not saved yet — you are offline. Your text is safe here.` | `Még nincs elmentve — nincs kapcsolat. A szöveged itt biztonságban van.` |
| `artifacts.document.save.tooLarge` | `This document is too long to save.` | `Ez a dokumentum túl hosszú ahhoz, hogy elmentsük.` |
| `artifacts.document.deleted` | `This document was deleted while it was open. Your text is still here.` | `Ezt a dokumentumot törölték, amíg nyitva volt. A szöveged még itt van.` |
| `artifacts.document.deleted.saveCopy` | `Save it as a new document` | `Mentés új dokumentumként` |
| `artifacts.document.notFound` | `This document is not available.` | `Ez a dokumentum nem érhető el.` |
| `artifacts.document.export.tooLarge` | `This document is too long to export. Split it into two documents.` | `Ez a dokumentum túl hosszú az exportáláshoz. Bontsd két dokumentumra.` |
| `artifacts.document.export.noConversation` | `This document is not linked to a chat, so it cannot be exported.` | `Ez a dokumentum nincs beszélgetéshez kapcsolva, ezért nem exportálható.` |
| `artifacts.document.selection.askAlfy` | `Ask Alfy` | `Kérdezd Alfyt` |
| `artifacts.document.selection.comment` | `Comment` | `Megjegyzés` |
| `artifacts.document.comment.placeholder` | `Write a comment, or start with @Alfy` | `Írj megjegyzést, vagy kezdd így: @Alfy` |
| `artifacts.document.comment.submit` | `Comment` | `Megjegyzés` |
| `artifacts.document.comment.reply` | `Reply` | `Válasz` |
| `artifacts.document.comment.resolve` | `Resolve` | `Megoldva` |
| `artifacts.document.comment.reopen` | `Reopen` | `Újra megnyitás` |
| `artifacts.document.comment.seeChange` | `See change` | `Módosítás megtekintése` |
| `artifacts.document.comment.alfyAsking` | `Alfy is looking at this…` | `Alfy éppen megnézi…` |
| `artifacts.document.comment.alfyAnswered` | `Alfy replied and changed the document.` | `Alfy válaszolt és módosította a dokumentumot.` |
| `artifacts.document.comment.alfyRefused` | `Alfy answered, but left your text as it is.` | `Alfy válaszolt, de a szövegedet nem bántotta.` |
| `artifacts.document.anchor.exact` | `Exact` | `Pontos` |
| `artifacts.document.anchor.moved` | `Moved` | `Elmozdult` |
| `artifacts.document.anchor.orphaned` | `Orphaned` | `Elárvult` |
| `artifacts.document.anchor.orphanedDetail` | `the anchored text is gone` | `a hivatkozott szöveg eltűnt` |
| `artifacts.document.versions.title` | `Versions` | `Változatok` |
| `artifacts.document.versions.current` | `Current` | `Jelenlegi` |
| `artifacts.document.versions.restore` | `Restore` | `Visszaállítás` |
| `artifacts.document.versions.restoreConfirm` | `Restore this version? The current one is kept as a version.` | `Visszaállítod ezt a változatot? A jelenlegi is megmarad változatként.` |
| `artifacts.document.versions.byUser` | `You` | `Te` |
| `artifacts.document.versions.byAlfy` | `Alfy` | `Alfy` |
| `artifacts.document.versions.conflict` | `This document changed elsewhere. Reload to see the current text.` | `Ez a dokumentum máshol megváltozott. Töltsd újra a jelenlegi szövegért.` |
| `artifacts.document.planned.writing` | `Alfy is writing: {label}` | `Alfy írja: {label}` |
| `artifacts.document.chip.status.Booked` | `Booked` | `Lefoglalva` |
| `artifacts.document.chip.status.ToBook` | `To book` | `Lefoglalandó` |
| `artifacts.document.chip.status.Paid` | `Paid` | `Kifizetve` |
| `artifacts.document.chip.status.Cancelled` | `Cancelled` | `Lemondva` |
| `artifacts.document.export.title` | `Download` | `Letöltés` |
| `artifacts.document.export.pdf` | `PDF` | `PDF` |
| `artifacts.document.export.docx` | `Word (DOCX)` | `Word (DOCX)` |
| `artifacts.document.export.markdown` | `Markdown` | `Markdown` |
| `artifacts.document.export.preparing` | `Making the file…` | `A fájl készül…` |
| `artifacts.document.export.failed` | `The file could not be made.` | `A fájlt nem sikerült elkészíteni.` |

`"artifacts."` is already in `AUDITED_PREFIXES` from Slice 0, together with `"artifacts"` in `I18N_MODULES` and
`src/lib/i18n/artifacts.test.ts` (`slice-0.md:910-912`, and `src/lib/i18n.test-helpers.ts:7,15` for the two lists
themselves). This slice adds exactly **one** entry to those lists: `"chat.artifacts."`, in the commit that adds
the first key under it — a bare `chat.` prefix stays deliberately unaudited. If Slice 0 has not landed when this
slice starts, do **not** start a second dictionary module: add the `I18N_MODULES` / `AUDITED_PREFIXES` entries
yourself in that commit and say so in the report.

**The three tools' strings are not dictionary keys.** `ToolI18n` is
`Record<string, { description: string; errorPrefix: string }>` resolved per language
(`src/lib/server/services/normal-chat-tools/index.ts:259-261`, `en` at `:262`, `hu` at `:354`) and the tool reads
`i18n.<toolName>.description` at registration (`:1113`). So `create_artifact` / `read_artifact` / `edit_artifact`
each need an `en` **and** a `hu` entry written by hand in the same commit — the parity test cannot see them, and
a missing `hu` entry falls back to the English description silently. `TOOL_TIMEOUTS_MS` is keyed the same way and
is a plain `Record<string, number>` (`shared.ts:196`), so a forgotten entry yields `undefined` at the call site
rather than a compile error: add all three keys in the same commit as the tools.

---

## File ownership

| File | Change | Shared with |
|---|---|---|
| `src/lib/shared/artifact-document/blocks.ts`, `patch.ts`, `anchor.ts` + `*.test.ts` | create (pure; server + browser). `anchor.ts` here is the **text resolver only** | — (see the directory note below) |
| `src/lib/shared/artifacts/anchor.ts` + `anchor.test.ts` | create: `Anchor`, `AnchorState`, `AnchorTone`, `AnchorResolution`, `anchorTone`, `anchorStateFor` | **Slice 3** (appends the node/point resolvers, `canvas-anchor.ts`) — this slice lands it first |
| `src/lib/server/services/artifacts/serialize/document.ts` + test | create; register in `serialize/index.ts` | — |
| `src/lib/server/services/artifacts/document-ops.ts` + test | create | — |
| `src/lib/server/services/artifacts/record.ts`, `versions.ts` | the additive `updateArtifactBody` fields (`snapshot`, `metadataPatch`, `expectVersion`); `restoreVersion` wiring | **Slice 0** lands first; see the diff note below |
| `src/lib/server/services/artifacts/types.ts` | one type-only line: `ArtifactAnchor = Anchor` from the shared module (optional, see the note) | **Slice 0** lands first |
| `src/lib/server/services/normal-chat-tools/artifacts.ts` + test | create the three tools | — |
| `src/lib/server/services/normal-chat-tools/index.ts` | register the three tools; add their `TOOL_I18N` `en`+`hu` entries and the `TOOL_TIMEOUTS_MS` keys | **Slices 2–5** append their own tools — append-only in the `tools` object and the two maps |
| `src/lib/server/services/normal-chat-tools/shared.ts` | three `TOOL_TIMEOUTS_MS` entries | **Slices 2–5**, append-only |
| `src/lib/server/services/normal-chat-tools/produce-file.ts` | none — the export calls the intake, not the tool | — |
| `src/lib/server/services/conversation-detail/read-model.ts` | nothing structural — Documents arrive through Slice 0's `artifacts` list | **Slice 0** |
| `src/routes/api/artifacts/[id]/body/+server.ts`, `.../document/patches/+server.ts`, `.../versions/**`, `.../comments/**` + tests | create (new files in Slice 0's route tree) | **Slice 3** adds canvas routes beside them |
| `src/routes/api/conversations/[id]/messages/[messageId]/document/+server.ts` + test | create (`Open as document`) | — |
| `src/lib/client/api/artifacts.ts` + test | extend (append the Document calls) | **Slices 2–4**, append-only |
| `src/lib/components/artifacts/document/**` | create | — |
| `src/lib/components/artifacts/artifact-bodies.ts` | one line: the `document` loader | **Slices 2–4**, append-only (plan decision 21) |
| `src/lib/components/artifacts/ArtifactCard.svelte` + test | the Document preview body + the tickable checklist (spec §2.3) | **Slices 2–4**, append-only; **Slice 0** created it |
| `src/lib/components/chat/MessageArea.svelte` and the assistant-message row | the `Open as document` action beside the existing copy action | — |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | the Document open path (via Slice 0's `openArtifact`) | **Slice 0** |
| `src/lib/i18n/artifacts.ts`, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` | keys + the `"chat.artifacts."` prefix | **Slice 0** (module + `"artifacts."`), **Slices 2–4** (their namespaces) |
| `package.json`, `package-lock.json` | `@tiptap/*` 3.31.3 (pinned, exact) | — |
| `scripts/eval-artifact-contracts/cases.ts`, `document.ts`, `run.ts`, `README.md` | the document suite | **Slices 2–4** add their suites to the same runner |
| `tests/e2e/artifact-document.spec.ts`, `tests/integration/artifact-document.test.ts` | create | — |

**The `updateArtifactBody` diff, verbatim against Slice 0's landed declaration** (`slice-0.md:484-495`).

```ts
// Slice 0 ships exactly this (read it in the landed file; do not retype it from here):
updateArtifactBody(params: {
	userId: string; artifactId: string;
	body: string; author: ArtifactAuthor; summary: string;
	/** Optional optimistic guard: the hash the caller last read. */
	baseHash?: string;
}): Promise<
	| { ok: true; versionId: string; bodyHash: string }
	| { ok: false; reason: "not_found" | "too_large" | "stale" | "hash_mismatch" }
>;
```

**There is no `bodyHash` parameter** — Slice 0 argues against one (`slice-0.md:504-506`): the stored hash is
computed inside the function from `body`, and the caller's *expected* hash goes in `baseHash?`, whose mismatch is
`stale`. This slice adds three **optional** parameters and one new failure reason, and returns the version number
the panel needs to echo back as its next `expectVersion`:

```ts
updateArtifactBody(params: {
	userId: string; artifactId: string;
	body: string; author: ArtifactAuthor; summary: string;
	baseHash?: string;                                                                  // Slice 0's guard, unchanged
	metadataPatch?: Record<string, unknown>;                                            // merged in the same transaction
	snapshot?: { at: number; docVersion: number; index: Record<string, string> };      // written to artifact_kv['alfy.snapshot']
	expectVersion?: number;                                                             // refuse unless the current artifact version_number matches
}): Promise<
	| { ok: true; versionId: string; bodyHash: string; versionNumber: number }
	| { ok: false; reason: "not_found" | "too_large" | "stale" | "hash_mismatch" | "version_conflict" }
>;
```

**Two hashes, two questions, and neither replaces the other.** The version row's `body_hash` is Slice 0's
`hashArtifactBody` over the stored string (`slice-0.md:288`: "slice 1 changes its *input*, not its mechanism" —
the input becomes canonical Markdown because this slice writes canonical Markdown); it answers *which body*. The
per-block `blockHash` from `blocks.ts` answers *which block*, and it is the unit of the "your words win" guard.
If the two are conflated, `verify`-style whole-body comparisons start refusing patches that changed nothing, or
accepting ones that did.

Nothing in Slice 0 depends on their absence, so this is a compatible widening **only if Slice 0 lands first**
(and Slice 0's deepening commit `9395f3d4` has already landed this declaration in the plan branch — make the edit
against that file rather than writing a second `updateArtifactBody`). Three guards now exist and they are not
interchangeable: `baseHash` is Slice 0's **body-hash** guard (`stale`), `expectVersion` is this slice's
**version-number** guard (`version_conflict`, the panel's autosave race), and the per-block `op.baseHash` guard
lives a layer up in `document-ops.ts` (`block_changed`, T2). Use the one that answers the question being asked;
do not collapse them into one parameter. The snapshot write shares the body write's transaction, which is what
makes "Alfy read exactly this" true after a crash too.

**Serialisation with the other slices.** `src/lib/components/artifacts/artifact-bodies.ts`,
`src/lib/i18n/artifacts.ts` and `ArtifactCard.svelte` are **append-only** across slices 1–4 (plan decision 21):
each slice adds its own loader line, its own key namespace and its own body branch, and touches nothing else in
those files. Do not reformat them. The same append-only rule covers `normal-chat-tools/index.ts` and
`normal-chat-tools/shared.ts` (each slice adds its own tools and its own `TOOL_I18N` / `TOOL_TIMEOUTS_MS` keys,
and leaves the neighbours' entries alone), `src/lib/client/api/artifacts.ts`, and
`scripts/eval-artifact-contracts/` (each type adds a suite file and a case-list entry). Two slices touching one
of these files is a merge conflict waiting to be resolved wrongly — resolve it by keeping both sides, never by
taking one.

**Cross-slice state after the rulings** (what is settled, and the one thing still needing the owner):

1. **Anchoring — settled by ruling 11.** One `Anchor` / `AnchorResolution` / `anchorStateFor` in
   `src/lib/shared/artifacts/anchor.ts`, one resolver **per type**: this slice's `resolveTextAnchor` (text, over
   the block index) and Slice 3's canvas resolver (node/point, over the board). Slice 3's
   `src/lib/shared/artifacts/comments.ts` becomes the interface plus its own resolver and **must not**
   reimplement the text scoring, and this slice must not reimplement node/point. Both resolvers are pure, and
   both are unit-tested against the same three outcomes including the orphan (T10.2, T10.3). Do not ship two
   scorers: two scorers produce two "Moved" verdicts for one edit.
2. **The canonical hash form — settled by ruling 12.** Defined once next to the hasher (Contracts), pinned by
   the named gate, and the same rule applies to the canvas body's `body_hash` for JSON with stable key order —
   that half belongs to Slice 3's body serializer, not to this slice. This slice must not grow a second
   canonicaliser anywhere (not in the panel, not in the serializer, not in the export mapping).
3. **Still open: one directory for the pure shared modules.** This slice keeps the Document's under
   `src/lib/shared/artifact-document/` (`blocks.ts`, `patch.ts`, `anchor.ts`), while Slices 3–4 use
   `src/lib/shared/artifacts/` (`canvas.ts`, `slides.ts`, `sources.ts`) for the same kind of module. Ruling 11
   already puts the **anchor interface** in `src/lib/shared/artifacts/`, so after this slice the two directories
   coexist for a documented reason rather than by accident. Recommendation to the owner (asked in the report):
   keep `blocks.ts`/`patch.ts`/`anchor.ts` where they are — they are the *document's* engine and nothing else
   imports them — and let `artifacts/` hold the cross-type interfaces. **Do not move another slice's files**;
   this is a report item, and the divergence is now deliberate, not silent.

---

## Tasks

### Task T1: The pure block model, and the mint-before-hash order

**Files:** `src/lib/shared/artifact-document/blocks.ts`, `blocks.test.ts`
**Interfaces:** `parseDocument`, `serializeDocument`, `normalizeMarkdown`, `blockHash`, `fnv1aHex`,
`mintBlockId`, `countMarkers`, `buildIndex`, `DocumentBlock`, `ParsedDocument`

- [ ] **Step 1: Write the failing tests.** Behaviours:

1. **The trap, first.** Given Markdown with **no** markers, `parseDocument` returns one block per top-level
   node, every block has a non-empty `id`, `minted` is `true`, and **every `hash` is non-empty** — i.e. hashes
   were computed *after* minting. Name the test after the failure mode ("mints ids before hashing so the first
   read is addressable").
2. Round trip: `parseDocument(a).markdown` → `parseDocument` again is **idempotent** (`minted: false`, same ids,
   same hashes) and `blocks.length` is unchanged. This is the "ids survive a reload" behaviour the prototype
   could not demonstrate.
3. A hand-written marker line is **absorbed**, not duplicated: `<!--b:p1x2y3-->\nHello` gives the paragraph the
   id `p1x2y3`, the stored `markdown` for that block is exactly `Hello`, and `countMarkers(markdown) === 1`.
4. A marker with no following block is dropped; a marker whose id is already used elsewhere keeps the first and
   re-mints the second (never two blocks with one id).
5. `serializeDocument(parseDocument(m).blocks)` contains exactly `blocks.length` markers, each on its own line
   immediately before its block.
6. **Ruling 12's gate, named exactly: `"canonical form: open → serialise → reload → serialise keeps every
   hash"`.** Parse a mixed document, `serializeDocument` it, parse the serialised string **again** with no edit in
   between, and assert the two `buildIndex` maps are equal and that every block's `markdown` is byte-identical —
   this is the named gate in the Gates block, so the test name matters. Alongside it, one test per canonical
   rule, each a paired input asserting one normalised output: trailing spaces and leading indentation trimmed;
   `| a  |   b |` and `| a | b |` normalise to the same key (the padding the prototypes lost — the pure form of
   the bug ruling 12 records); `*`/`+`/`-` bullets normalise to `-`, `- [X]` to `- [x]` with `- [ ]` kept, and an
   ordered marker keeps its number; a block ending in blank lines loses them and internal 3+ blank runs collapse
   to one; chip attribute order and quoting are fixed. `normalizeMarkdown` is asserted **idempotent** on every
   one of those inputs (that property is what `blockHash` rests on), and `blockHash` is asserted equal to
   `fnv1aHex(normalizeMarkdown(markdown))` so nothing can quietly bypass the canonicaliser.
7. `fnv1aHex` is stable across runs and differs for `"a"` vs `"b"` (a fixed-value assertion, so a future change
   to the function is a deliberate act).
8. `mintBlockId` produces a kind-prefixed id matching `/^[a-z]{1,2}[0-9a-z]{5}$/` and two calls do not collide
   over 10,000 iterations.
9. **The budget is split the way `decisions.md` ruling 9 splits Canvas's** (a strict ms assertion cannot be
   honest on a shared CI runner): CI asserts the **structural** facts — a 6,000-word document yields its
   expected block count, `buildIndex` covers every block, re-parsing is idempotent, and the parse completes
   under a **generous machine-independent ceiling** (30 ms, ~10× the prototype's pace) so a real regression
   fails and a slow runner does not. The headline **1.5 ms/keystroke at 5,691 words** figure is measured
   locally in T7.7 and recorded in the slice report, and a failing CI check never means "weaken the product".

- [ ] **Step 2: Run to verify they fail**
      `npx vitest run src/lib/shared/artifact-document` → FAIL, module does not exist.

- [ ] **Step 3: Implement.** Port `doc-model.ts`'s parser and hashing rules from the prototype
      (`.claude/worktrees/agent-a883f7e86c2b442fd/src/routes/prototype/document/_lib/doc-model.ts`:
      `MARKER_RE`, `fnv1aHex`, `mintBlockId`, `countMarkers`, `buildBlockIdTransaction`), but hash **canonical
      Markdown** instead of ProseMirror JSON, and keep every Tiptap import out of this module. The block splitter
      recognises: ATX headings, fenced code, blockquotes, `- [ ]` task lists, `|`-tables, `-`/`*`/`1.` lists
      (with their continuation lines), horizontal rules, everything else as a paragraph. **Read the prototype's
      test file** (`_lib/prototype-document.test.ts`, 647 lines) for the tree shapes it already covers.
      Ruling 12 asks for the canonical rules to be **documented next to the hasher**: write the five rules from
      the Contracts section as a comment block immediately above `blockHash`, with the sentence that a hash change
      without a user edit is the failure this prevents. `serializeDocument` writes `normalizeMarkdown`'s output
      for each block, so the stored bytes and the hashed bytes are the same bytes. The module imports **nothing
      from `@tiptap/*`, `prosemirror*`, Svelte or the DOM**, and the test asserts that by reading the file (the
      source-scan pattern already in the repo: `readFileSync` on the module path plus
      `expect(source).not.toContain("@tiptap")`, as in
      `src/lib/components/chat/context-sources-removal.test.ts:38-43`).

- [ ] **Step 4: Run**
      `npx vitest run src/lib/shared/artifact-document && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/artifact-document
git commit -m "Add the document block model both sides can run

The server has to refuse an edit that would overwrite the user's words, and the
server has no editor. Splitting the block model, the hashes and the id minting
into a pure module lets one implementation decide on the server and render in the
browser, and hashing canonical Markdown instead of ProseMirror JSON is what makes
that possible at all.

Ids are minted or absorbed inside the parse, before any hash exists: the
prototype minted them later and every patch against a freshly loaded document was
refused."
```

### Task T2: The patch engine and per-op refusal

**Files:** `src/lib/shared/artifact-document/patch.ts`, `patch.test.ts`
**Interfaces:** `PatchOp`, `PatchSet`, `PatchResult`, `OpOutcome`, `RefusalReason`, `applyPatchSet`

- [ ] **Step 1: Write the failing tests.** One test per refusal reason, each asserting **all three** of: the
   outcome's `code`, the document being byte-identical to the input, and `refused === 1`:

   1. `block_missing` — an op naming an id that is not in the document.
   2. `block_unseen` — the snapshot has no entry for the block.
   3. `block_changed` — the snapshot hash differs from the live hash (the user typed in the block after Alfy's
      read) **and** the case where the snapshot matches the live hash but the op's `baseHash` does not (a stale
      retry).
   4. `not_a_text_block`, `empty_text`, `not_a_task_block`, `not_a_table_block`, `bad_row`.
   5. `find_not_found` and `find_ambiguous` — the second is the important one: `find` occurring twice **must not**
      be applied to the first occurrence.

   Then the positive behaviours:

   6. A patch set with two good ops and one changed-block op applies the two, refuses the one, and the refusal
      carries the **block's label** for the notice.
   7. `toggleTask` flips only the addressed task item; a second, unrelated task item is untouched.
   8. `addTableRow` with chip cells produces a row whose chips serialise as `[chip kind="status" value="Booked"]`
      and whose stored token is unchanged by any locale.
   9. `replaceRange` rewrites exactly the `find` substring and leaves the rest of the block identical.
   10. `inverses` is populated for every applied op, and applying the inverses in reverse returns the document to
       its exact pre-patch Markdown.
   11. `applied + refused === patch.ops.length` for every case, including an empty patch set.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** on top of T1's blocks. Port the guard and
      the change-inverse idea from `patch-engine.ts`, with the reasons as data (`code`) and the human sentence
      produced by the UI from `artifacts.document.refused.*` — the engine must not carry English strings.

- [ ] **Step 4: Run**
      `npx vitest run src/lib/shared/artifact-document && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/artifact-document
git commit -m "Refuse a patch per operation, in one place

Your words win is a server decision, so the guard compares what Alfy read, what
the document says now and what the op claims to have read, and returns a reason
code per operation instead of one failure for the set. A refused op leaves the
document untouched, and the engine carries no English so the notice can be
localized where it is shown."
```

### Task T3: The snapshot, the Document serializer, and the server-side ops

**Files:** `src/lib/server/services/artifacts/serialize/document.ts` + test,
`src/lib/server/services/artifacts/document-ops.ts` + test,
`src/lib/server/services/artifacts/record.ts` (additive fields)
**Interfaces:** `documentSerializer`, `DocumentBody`, `DocumentTab`, `readDocumentForAlfy`, `applyDocumentPatch`,
`createDocumentArtifact`, `saveDocumentBody`, `updateArtifactBody` extensions

- [ ] **Step 1: Write the failing integration tests**
      (`tests/integration/artifact-document.test.ts`), against a real DB:

1. `createDocumentArtifact` writes a Document artifact whose stored `content_text` contains **one marker per
   block**, and whose first `artifact_versions` row is the created body.
2. Creating from Markdown that already has markers preserves those ids; creating twice from the same input does
   not share ids (each artifact mints its own).
3. `readDocumentForAlfy` returns blocks with `blockId`, `label`, `hash`, `text` — and **no `<!--b:` marker in any
   returned text**; it writes `artifact_kv['alfy.snapshot']` with exactly those hashes.
4. **The reload trap, as an integration test:** create → read the raw body → parse it **fresh from the stored
   string** (the reload path) → `applyDocumentPatch` with the hashes from the read → `applied === ops.length`.
   Fail this and the whole type is unusable.
5. The user edits a block through `saveDocumentBody`, then the same patch is submitted: it refuses with
   `block_changed`, the stored body is unchanged, and the version count grew by exactly one for the user's edit.
6. `saveDocumentBody` with a stale `expectVersion` returns `version_conflict` and writes nothing.
7. `applyDocumentPatch` on another user's artifact returns `not_found`; on a `canvas`/`app` artifact returns
   `not_a_document`; on an incognito conversation's artifact from outside the scope, `not_found`.
8. Restoring a version writes a **new** version whose summary names the restored one, and the body is the old
   Markdown with its ids intact — a restore must not re-mint ids, or every comment anchor in the document breaks.
9. `artifact_kv['alfy.snapshot']` is not readable without going through a scoped artifact read (assert through
   the service, not by querying the table directly).
10. **The stored body is already canonical (ruling 12 at the storage boundary):** create from a document whose
   Markdown has padded tables, `*` bullets and trailing blank lines; read the raw `content_text`;
   `parseDocument` → `serializeDocument` → assert the result is **byte-identical** to what was read and that the
   `buildIndex` maps match. A reload that rewrites a byte is a "user edit" nobody made, and the next patch would
   refuse on a document the user never touched.
11. **Body and snapshot are written in one transaction.** Force the `artifact_kv` write to fail inside the
   transaction (a stub that throws is enough) and assert **neither** the body nor the snapshot moved. A body
   newer than the snapshot it was written with is precisely the state that refuses every subsequent patch, so it
   must be unreachable rather than merely unlikely.

- [ ] **Step 2: Run to verify they fail**
      `npx vitest run tests/integration/artifact-document.test.ts`

- [ ] **Step 3: Implement** the serializer (registered in `serialize/index.ts`, replacing Slice 0's `file`-only
      registry entry pattern with the real registry), then `document-ops.ts` on top of T1/T2 and Slice 0's
      `versions.ts`.

- [ ] **Step 4: Run**
      `npx vitest run tests/integration/artifact-document.test.ts src/lib/server/services/artifacts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/artifacts tests/integration/artifact-document.test.ts
git commit -m "Persist what Alfy last read

The guard only works if the snapshot is durable: a browser variable would make
your-words-win a promise the client keeps to itself. The snapshot lives in the
artifact's own key-value table, written in the same transaction as the read, and
the Document serializer is what turns Markdown into addressable blocks on the way
in and out."
```

### Task T4: The three tools

**Files:** `src/lib/server/services/normal-chat-tools/artifacts.ts` + test,
`src/lib/server/services/normal-chat-tools/index.ts` (registration, `TOOL_I18N` `en` + `hu`),
`src/lib/server/services/normal-chat-tools/shared.ts` (`TOOL_TIMEOUTS_MS`)
**Interfaces:** `create_artifact`, `read_artifact`, `edit_artifact` (schemas + runs), three `TOOL_I18N` entries
per language, three `TOOL_TIMEOUTS_MS` keys

- [ ] **Step 1: Write the failing tests**

1. `create_artifact` with `artifactType: "document"` is scoped by the server-owned `userId`/`conversationId`, and
   **its input schema has no `userId` / `conversationId` / `artifactId` field** (assert the schema's shape — a
   leaked scope field is how one user writes into another's conversation).
2. An unknown `artifactType` is a model-safe failure, not a throw.
3. `read_artifact` on a Document returns blocks with hashes; on a File returns a message naming the type; on
   another user's id returns not-found.
4. `edit_artifact` returns `{applied, refused: [{blockId, blockLabel, code, reason}], version}`, and the refusal's
   `reason` is a plain sentence the model can act on.
5. `edit_artifact` with an empty `ops` array does not write a version.
6. Both successful calls link the artifact id to the assistant message, so `MessageArea` can render the card for
   an artifact created by a tool call (assert the link row, not the rendering).
7. **Registration, stated against what actually exists.** There is **no** artifact capability gate today: the
   `tools` object conditionally spreads only the provider- and connection-gated tools — `research_web`/`fetch_url`
   behind `parallelConfigured` and the connection tools behind `ctx.enabledConnectionCapabilities`
   (`normal-chat-tools/index.ts:615-640`) — while `produce_file` is registered unconditionally (`:1111`). A
   Document is app-local like `produce_file`, so the test asserts the three names are in the registered set for
   an ordinary turn, and (the real risk) that **no tool schema exposes `userId`, `conversationId` or
   `artifactId` as a model-facing input** for `create_artifact`. If Slice 5 adds a capability gate, this test is
   the one that changes — deliberately, in that slice.
8. **The two hand-written maps are complete.** Each of the three tool names has a `TOOL_I18N.en` **and**
   `TOOL_I18N.hu` entry, and a `TOOL_TIMEOUTS_MS` key (both are `Record<string, …>`, so a miss is a silent
   `undefined`, not a type error — `normal-chat-tools/index.ts:259-262,354` and `shared.ts:196`). Assert all
   three keys in both locales; a Hungarian turn with a missing entry gets the English description by fallback and
   nobody notices.
9. **Oversize and orphaned creation fail the same way, not differently.** `create_artifact` with a body over
   Slice 0's `ARTIFACT_BODY_MAX_BYTES` (2 MiB, `slice-0.md:932`) surfaces `too_large`, and a `conversationId`
   that is not the caller's surfaces `conversation_not_found` (`slice-0.md:472-476`) — both as the same
   model-safe failure shape as the unknown-type case in item 2, and neither silently truncating the body or
   creating the artifact anyway.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the module and register it in
      `normal-chat-tools/index.ts` beside `produce_file`, with the usage guidance in the tool interface (ADR-0055)
      — the guidance says when a Document is the right shape, that patches are block-addressed with the hash from
      `read_artifact`, and that a refusal means re-read rather than retry.

      The three `en` entries (the model-facing contract; the guidance **is** the tool, ADR-0055), and their
      `errorPrefix` in both languages — the prefix is what the user sees on the tool-call row when the tool
      throws, so it is UI text and gets an EN **and** a HU value:

      | Key | `en` | `hu` |
      |---|---|---|
      | `create_artifact.description` | `Make a Document: a piece of writing the user will come back to and both of you will edit over time — a plan, an itinerary, a letter, a draft, a checklist, meeting notes. Pass {"artifactType": "document", "title": "…", "body": "Markdown"}. Use real Markdown headings and lists; the block ids are added for you, never write them yourself. Do not use it for a file the user asked to download (produce_file), for a quick answer in the reply (just answer), or to copy back something you already wrote in this turn. Returns the new document's id and title.` | `Dokumentum készítése: olyan írás, amihez a felhasználó visszatér, és amit idővel ketten szerkesztetek — terv, útiterv, levél, vázlat, feladatlista, megbeszélés-jegyzet. Így hívd: {"artifactType": "document", "title": "…", "body": "Markdown"}. Használj valódi Markdown címsorokat és listákat; a blokk-azonosítókat a rendszer adja hozzá, soha ne írd le őket. Ne használd letölthető fájlhoz (produce_file), gyors válaszhoz (csak válaszolj), és ne azért, hogy visszamásold, amit ebben a körben már megírtál. Az új dokumentum azonosítóját és címét adja vissza.` |
      | `read_artifact.description` | `Read a Document's current blocks before you edit it. Pass {"artifactId": "…"}. Returns every block with \`blockId\`, its \`hash\`, a short \`label\` and the block's text — never the raw Markdown. Use those hashes as the \`baseHash\` of your patches; a hash you did not get from here will be refused. Call it again after a refusal, or if the user says they changed something. Read it twice rather than guess once.` | `Dokumentum jelenlegi blokkjainak beolvasása szerkesztés előtt. Így hívd: {"artifactId": "…"}. Minden blokkot visszaad \`blockId\`, \`hash\`, rövid \`label\` és a blokk szövege mezőkkel — nyers Markdown helyett. Ezeket a hash-eket használd a patchek \`baseHash\` mezőjében; amit nem innen kaptál, azt a szerver elutasítja. Elutasítás után, vagy ha a felhasználó azt mondja, változtatott valamit, olvasd be újra. Inkább olvasd el kétszer, mint hogy egyszer tippelj.` |
      | `edit_artifact.description` | `Change a Document you have read. Pass {"artifactId": "…", "label": "one short sentence the user sees on the change bar", "patches": [...]}. Every patch is one operation on one block: \`blockId\` plus that block's \`baseHash\` from \`read_artifact\`, then exactly one of \`replaceBlock\` (whole block, \`text\`), \`insertText\` (\`text\`, \`at\`: "start"/"end"), \`replaceRange\` (\`find\` plus \`text\`; the \`find\` must be unique in the block), \`toggleTask\` (\`checked\`), \`addTableRow\` (\`cells\`). A patch whose block the user changed after your read is refused, and the others still apply — the result says which, by \`label\`, so re-read that block and try again rather than repeating the same patch. Keep the change inside what was asked: never rewrite a whole document to change one sentence.` | `Olyan dokumentum módosítása, amit beolvastál. Így hívd: {"artifactId": "…", "label": "egy rövid mondat, amit a felhasználó a változtatássávon lát", "patches": [...]}. Minden patch egy blokkon végzett egy művelet: \`blockId\` és annak a blokknak a \`baseHash\`-e a \`read_artifact\`-ből, majd pontosan egy a következőkből: \`replaceBlock\` (a teljes blokk, \`text\`), \`insertText\` (\`text\`, \`at\`: "start"/"end"), \`replaceRange\` (\`find\` és \`text\`; a \`find\` csak egyszer szerepelhet a blokkban), \`toggleTask\` (\`checked\`), \`addTableRow\` (\`cells\`). Ha a blokkot a beolvasásod után megváltoztatta a felhasználó, azt a patchet a szerver elutasítja, a többit viszont alkalmazza — az eredmény \`label\` szerint megmondja, melyiket, ilyenkor olvasd be újra azt a blokkot, és ne ugyanazt a patchet ismételd. Maradj a kérésen belül: soha ne írj át egy egész dokumentumot egyetlen mondat megváltoztatásához.` |
      | `create_artifact.errorPrefix` (EN/HU) | `Could not make the document` | `A dokumentumot nem sikerült létrehozni` |
      | `read_artifact.errorPrefix` (EN/HU) | `Could not read the document` | `A dokumentumot nem sikerült beolvasni` |
      | `edit_artifact.errorPrefix` (EN/HU) | `Could not change the document` | `A dokumentumot nem sikerült módosítani` |

      `TOOL_TIMEOUTS_MS` entries: `create_artifact: 10_000`, `read_artifact: 10_000`, `edit_artifact: 20_000`.
      All three are local database work with no provider round trip — `produce_file`'s 40 s exists only because
      it waits in-turn for a worker verdict (`shared.ts`'s comment on that key) and `run_python`'s because it
      waits for a container. Do not copy either number here.

- [ ] **Step 4: Run**
      `npx vitest run src/lib/server/services/normal-chat-tools && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/services/normal-chat-tools
git commit -m "Give Alfy read and block-addressed edit tools for documents

Read returns text with ids and hashes rather than Markdown with markers, and edit
returns the per-operation outcome so a refusal is something the model can act on
instead of a wall. The tools carry no scope fields: the server decides which
conversation and which user they act on."
```

### Task T5: "Open as document"

**Files:** the assistant-message row under `src/lib/components/chat/`, `MessageArea.svelte`,
`src/lib/client/api/conversations.ts` (the call it already uses for message actions), i18n keys
**Interfaces:** a `keepAsDocument(messageId)` action

- [ ] **Step 1: Write the failing tests**

1. An assistant message with text offers `Open as document`; a message that is only a tool call, or empty, does
   not.
2. Choosing it creates a Document artifact from the message's visible text (headings preserved), opens it in the
   panel, and the chat header count increases by one.
3. Choosing it twice for the same message opens the **same** artifact — a second Document is not created (the
   link is by message id).
4. The created document's Markdown has one marker per block and no `tool_call`/reasoning text in it — the visible
   text only.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement.** The server side is a route
      (`POST /api/conversations/[id]/messages/[messageId]/document`) that calls
      `createDocumentArtifact` with the message's visible text; **reuse the existing visible-text/`normalizer`
      output rather than re-extracting text in the route** (see AGENTS.md's rule about duplicated visible-text
      extraction). The link lives beside the existing evidence metadata on the message, not in a new table.

- [ ] **Step 4: Run**
      `npx vitest run src/lib/components/chat && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/chat src/routes/api/conversations "src/routes/(app)/chat/[conversationId]/+page.svelte" src/lib/i18n
git commit -m "Keep a reply as a document

Every answer that is worth coming back to should be one click from being a
document, and the link is on the message so asking twice opens the same document
instead of making a second copy."
```

### Task T6: Versions and restore

**Files:** `src/routes/api/artifacts/[id]/versions/**` + tests,
`src/lib/components/artifacts/document/VersionsSheet.svelte` + test, `src/lib/client/api/artifacts.ts`
**Interfaces:** `listVersions` / `restoreVersion` (Slice 0) exposed; `VersionsSheet`

- [ ] **Step 1: Write the failing tests**

1. The sheet lists versions newest first, each with author, relative time and summary, newest marked `Current`.
2. Restoring an older version makes **it** the current body, and the previously current version is still in the
   list (a restore is a version, per T3.8).
3. A version row shows who made it (`You` / `Alfy`) — a Document edited by both must be readable as a history of
   who did what.
4. Restoring does not re-mint block ids: the ids and hashes of unchanged blocks are identical before and after
   (assert on the parsed blocks).
5. Another user's version ids are 404 from the route.
6. Restoring a version restores the **text** and leaves the tab strip intact (`metadata_json.tabs` is not versioned),
   and a tab whose `startBlockId` no longer exists in the restored body still renders — re-pointed on read, as the
   Contracts state — with its comments still attached.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement.**

- [ ] **Step 4: Run** `npx vitest run src/routes/api/artifacts src/lib/components/artifacts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/artifacts src/lib/components/artifacts src/lib/client/api/artifacts.ts
git commit -m "Show the document's history and let it be restored

Nothing Alfy does is destructive if the previous state is one click away, and a
restore is itself a version so a restore cannot be the thing that loses work."
```

### Task T7: The lazy editor

**Files:** `src/lib/components/artifacts/document/DocumentBody.svelte`, `document-editor.ts`, `extensions.ts`,
`DocumentToolbar.svelte`, `*.test.ts`, `src/lib/components/artifacts/artifact-bodies.ts`, `package.json`
**Interfaces:** `createDocumentEditor({ element, markdown, editable, onDirty, onSelection, onChange })`,
`readMarkdown(editor)`. **`DocumentBody.svelte` takes Slice 0's `ArtifactBodyProps` verbatim** — flat props:
`artifactId`, `kind`, `title`, `body`, `onDirtyChange?`, `onBodyChange?` (`slice-0.md:687-697`) — because the
panel resolves it through `ARTIFACT_BODIES[kind]` with a cached-promise loader; the factory's own options are
internal to this slice.

- [ ] **Step 1: Write the failing tests**

1. `DocumentBody` with a `document` artifact renders the editor host and the toolbar, and the editor module was
   loaded **once** across three re-renders (the cached-promise rule from Slice 0's registry).
2. Typing marks the body dirty, and the debounced save posts the canonical Markdown — assert the posted string
   equals `serializeDocument(parseDocument(browserMarkdown).blocks)`, i.e. the **server's** canonicaliser, not a
   second one in the browser.
3. Saving a body that came back `version_conflict` shows `artifacts.document.versions.conflict` and does not
   discard the user's text (the editor keeps what they typed).
4. The user's edit is what the next `read_artifact` sees: after a save, a patch addressed with the *pre-edit*
   hash refuses `block_changed` (the end-to-end proof of "your words win" through the real editor).
5. **Ruling 12's gate, the editor half — name it `"canonical form survives the editor round trip"`.** Load a
   document containing every trap at once — a padded table, a `*` bullet, a nested list, a task list, a chip, a
   code fence with a blank line inside, and a trailing blank line — then `readMarkdown(editor)` → parse →
   `serializeDocument` → load **that** into the editor again → `readMarkdown` → parse, and assert the
   `buildIndex` maps from pass one and pass two are **equal** (and every block's `markdown` byte-identical) with
   **no user edit in between**. Two passes, not one: a single pass catches padding, the second catches state the
   first pass introduced (a normaliser that is not idempotent passes once and fails forever after).
6. Markers survive: a document with 12 blocks loads, the user types one character in block 5, saves, and all 12
   ids are the same 12 ids.
7. **The local recorded figure** (`decisions.md` ruling 9): at the prototype's 5,691-word document, typing 200
   synthetic keystrokes averages under **2 ms per keystroke**, and the measured number goes in the slice report
   whatever it is. This is a recording, not a CI gate — the CI half of the budget is T1.9's structural
   assertion, so a slow machine never becomes an argument for loosening the product.
8. **Chunk, by source scan — the repo has no chunk-manifest assertion to follow.** Nothing in `src/**/*.test.ts`
   or `tests/` reads `.svelte-kit/output` or a build manifest today, so do not invent that machinery: assert by
   **reading the source files** that must stay clean (`readFileSync` + `expect(source).not.toContain("@tiptap")`,
   the pattern already used at `src/lib/components/chat/context-sources-removal.test.ts:38-43` and
   `src/lib/components/document-workspace/preview-runtime/pdf/PdfPreview.test.ts:675-676`) for `DocumentBody`'s
   shell, the toolbar, the margin, the chips module, the selection bubble and `artifact-bodies.ts`. The **numbers**
   are the build-output recording the Gates block requires, quoted in the report next to the prototype's
   157 kB gzip / 146,817 B gzip Tiptap figures — a measurement someone reads, not a test that runs.
9. **Offline mid-edit.** Saving while the network is down leaves the user's text in the editor, posts again on the
   next debounce when the request succeeds, and shows `artifacts.document.save.offline` until it does; it must
   **not** clear the draft or flip the panel out of edit mode, and a later successful save must clear the notice.
   (Server side: no request, no code — the loop is client-only, which is why the test is here and not in T3.)
10. **Deleted while open.** A save that answers **404** (`{ ok: false, reason: "not_found" }`, the same answer a
    foreign artifact gets) stops the autosave loop, keeps the text, shows `artifacts.document.deleted` with the
    `artifacts.document.deleted.saveCopy` button, and that button creates a **new** Document from what is in the
    editor (`createDocumentArtifact`) and switches the panel to it. Silently retrying a 404 forever is the
    failure mode: a user typing for ten minutes into a document that no longer exists.
11. **Over the body cap.** A save that answers **413** `{ ok: false, reason: "too_large" }` (Slice 0's
    `ARTIFACT_BODY_MAX_BYTES`, 2 MiB) keeps the text, shows `artifacts.document.save.tooLarge`, and **stops the
    autosave loop** — a size refusal is not transient, and a loop that keeps retrying a 2 MiB POST is worse than
    the refusal. Assert both: the notice, and that no second request follows the 413.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the editor behind the lazy import, with
      `@tiptap/*` **pinned to exactly 3.31.3** (the prototype's versions; do not float the range — a minor bump
      on this stack is a different Markdown round-trip and every hash in every document depends on it).

- [ ] **Step 4: Run**
      `npx vitest run src/lib/components/artifacts && npm run build && npm run check`
      then record the measured chunk sizes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts package.json package-lock.json
git commit -m "Open a document without paying for the editor everywhere

Tiptap and ProseMirror are the whole cost of this route, so the editor is a lazy
module and the shell, the toolbar's host and the margin stay free of them. The
Markdown that leaves the browser goes back through the shared canonicaliser, so
what is hashed after a keystroke is what the server would hash."
```

### Task T8: Change marks, Keep and Undo, and the visible refusal

**Files:** `src/lib/components/artifacts/document/marks.ts`, `ChangeBar.svelte` (the inline `Alfy · Keep · Undo`),
`RefusalNotice.svelte`, `AlfyWriting.svelte` (the planned-section shimmer), `*.test.ts`
**Interfaces:** the mark + widget; `onKeep(changeId)`, `onUndo(changeId)`

- [ ] **Step 1: Write the failing tests**

1. An applied patch marks exactly its inserted/replaced text with the change mark, and the inline bar shows
   `Alfy · Keep · Undo` with the comment count for that block when there is one.
2. `Keep` clears the mark and leaves the text; `Undo` removes exactly that change and restores the previous text
   byte-for-byte, and both preserve every block id.
3. A second patch to the same block after `Keep` applies; after `Undo` it refuses `block_changed` (the user's
   undo *is* a user edit).
4. A patch with one refused op renders the notice naming the block's label, the count of untouched parts, and a
   `See what Alfy did` affordance that scrolls to the applied change — asserting only that the applied change is
   still visible is not enough; the refusal must be *findable*.
5. Undo twice is an error-free no-op (the inverse is applied once).
6. The pending states render: `Alfy is writing: {label}` while a tool call is in flight, and the shimmer is
   replaced by content, never left behind.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** on `patch.ts`'s `inverses` (never by
      re-parsing a previous Markdown: a re-parse can re-number nothing but it *can* drop a change the user made in
      between, which is precisely what §2.4's "undo restores exactly" forbids).

- [ ] **Step 4: Run** `npx vitest run src/lib/components/artifacts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts/document src/lib/i18n
git commit -m "Show every change Alfy made, and every change it refused to make

Keep and Undo are exact because they use the inverse the patch engine recorded,
not a re-parse of an earlier document. A refused operation is surfaced with the
name of the part Alfy left alone, because a guard the user cannot see is
indistinguishable from Alfy forgetting."
```

### Task T9: Tabs, and the tracker chips

**Files:** `Tabs.svelte` + test, `chips.ts` + test, `extensions.ts` (the `TrackerChip` node),
`ArtifactCard.svelte` (the Document preview body + the tickable checklist)
**Interfaces:** `DocumentTab` navigation; `chipLabel(kind, value)`, `chipValues(kind)`

- [ ] **Step 1: Write the failing tests**

1. Tabs render in order with the first active; switching a tab scopes the margin to that tab's comments and does
   not re-render the editor's document (assert the editor's scroll position survives — a tab switch that
   remounts the editor is a performance and a caret bug).
2. Adding a tab appends an empty section; renaming persists; deleting asks, then removes the tab and its
   comments, and the document's other tabs are byte-identical afterwards.
3. A document with one tab hides the strip (no tab bar for a single section).
4. The card's subtitle reads `Document · 3 tabs`.
5. **Chips:** a stored `[chip kind="status" value="Booked"]` renders the label from
   `artifacts.document.chip.status.Booked`, and choosing another status writes the **canonical token**
   (`To book`), never a localized string — assert the serialised Markdown contains `value="To book"` even when
   the UI locale is Hungarian.
6. A date chip stores an ISO date and displays a localized date; a document saved in one locale reloads in
   another with identical stored values.
7. The card's tickable checklist (spec §2.3) shows the first five task items, ticking one writes the document
   (through the same patch path, not a second write path) and the checkbox shows its new state after a reload;
   a document with more than five shows `+N more`.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement.**

- [ ] **Step 4: Run** `npx vitest run src/lib/components/artifacts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/i18n
git commit -m "Split a plan into tabs and make the tables trackers

Tabs are sections of one document, so a plan, its budget and its packing list stay
one thing Alfy can read at once. Chips store their value as a canonical token and
are translated only for display, so a document never becomes half-Hungarian
because of the language it was opened in."
```

### Task T10: Comments, `@Alfy`, and the margin

**Files:** `MarginPanel.svelte`, `SelectionBubble.svelte`, `CommentThread.svelte` + tests,
`src/lib/shared/artifacts/anchor.ts` + `anchor.test.ts` (the shared interface, ruling 11),
`src/lib/shared/artifact-document/anchor.ts` + `anchor.test.ts` (the Document's text resolver),
`src/lib/client/api/artifacts.ts`, the `artifacts/[id]/comments/**` routes, the `@Alfy` service path
**Interfaces:** `Anchor`, `AnchorState`, `AnchorTone`, `AnchorResolution`, `anchorTone`, `anchorStateFor`,
`makeAnchor`, `resolveTextAnchor`, `reanchor`

- [ ] **Step 1: Write the failing tests**

1. Selecting text shows the bubble with `Ask Alfy` and `Comment`; the created comment's anchor holds the quote
   plus its context, and the margin shows it against the right block.
2. **Anchoring:** after an unrelated edit above it, the comment reads `Exact` with the same range; after the
   quote's own paragraph is edited, `Moved`; after the quote's text is deleted, `Orphaned` — and an orphaned
   comment **keeps its quote visible** rather than vanishing.
3. Two identical sentences in different blocks: a comment on the second resolves to the second, not the first
   (the `+4` in-block bonus is what makes this true, and this is the test that proves it).
4. Replies nest, `Resolve` sets the status and can be undone, and the thread's count appears as the dot on the
   inline change bar when the comment is anchored inside an Alfy-changed block.
5. **`@Alfy`:** a comment containing `@Alfy` runs one patch attempt scoped to the anchored block. Three outcomes
   are each asserted: applied (the document changed **and** a reply appeared in the thread), refused (the reply
   explains it left the text alone, using `artifacts.document.comment.alfyRefused`), and answered-only (a question
   — `@Alfy is Westbahnhof a good base?` — changes nothing and replies).
6. Alfy's own note: after a patch whose op was a judgement call the tool flagged, a comment authored `Alfy`
   exists in the thread and is styled as a note, not as an error.
7. A comment on another user's artifact 404s, and a comment body cannot be authored as `alfy` from the client
   (assert the server ignores an `author` field in the request body).
8. **The shared interface, tested as an interface (ruling 11).** `anchorStateFor` maps the prototype's score to
   the three states (`>= 4` → `exact`, `> 0` → `moved`, else `orphaned`), `anchorTone` maps state → tone, and
   `resolveTextAnchor` is asserted against the **same three outcomes** the Canvas resolver will be asserted
   against — a fixture table of (anchor, blocks) → `{ state, blockId, from, to }` with the orphan producing
   `blockId: null` and `from`/`to` of `-1`. Slice 3 adds its own rows to that idea; it does not get a second
   vocabulary.
9. **A row whose anchor will not parse is an orphan, not a crash.** `parseArtifactAnchor` returns `null` for
   malformed JSON and for a `text` anchor missing any of its five fields (`slice-0.md:445`, `:448-450`); the margin
   renders that comment with `artifacts.document.anchor.orphaned`, keeps its body and its thread, and never
   throws. This is the one comment state a user cannot cause on purpose and therefore the one that would ship
   broken.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement.** The `@Alfy` path is a server call, not a
      browser generation: it scopes to the anchored block, runs the same patch engine, and appends the reply —
      one code path with T4, not a second one.

- [ ] **Step 4: Run**
      `npx vitest run src/lib/components/artifacts src/routes/api/artifacts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/routes/api/artifacts src/lib/client/api/artifacts.ts src/lib/i18n
git commit -m "Let a comment talk to Alfy, and let Alfy leave a note

A comment carries a quote and its context, so an anchor survives an unrelated
edit, reports that it moved, and keeps the quote when the text is gone. @Alfy goes
through the same patch path as the chat, which is why a comment on a block the
user changed is refused rather than obeyed."
```

### Task T11: The mobile toolbar

**Files:** `MobileToolbar.svelte` + test, `DocumentToolbar.svelte` (the shared action definitions),
`tests/e2e/artifact-document.spec.ts`

- [ ] **Step 1: Write the failing tests**

1. At 390×844 the toolbar's own height is **≤ 48 px** and the editor keeps at least 60% of the viewport height.
   The prototype's single toolbar was **226 px — 27 % of the 844 px viewport** before its own fix (total phone
   chrome 322 px = 38 %), and even the fixed prototype's row still measured **137 px** (`_notes/review.md`
   finding 1, `_notes/probe-report.txt`: "head 97 + toolbar 137 + status bar 35"). The 48 px budget is
   deliberately below both: this slice's toolbar carries the format actions and nothing else, and the phone's
   height belongs to the document.
2. Six primary actions are on the row and the rest are in the `More` sheet; every action in the desktop toolbar
   is reachable on mobile (assert the action **ids**, not their labels, so the two toolbars cannot drift).
3. The sheet opens over the editor without scrolling the document, and closing it returns the caret to where it
   was.
4. Tapping a list/task action inside a table does not steal the table's own gestures; the toolbar is reachable
   while the keyboard is open (assert the toolbar is not pushed off-screen at 390×420, the viewport with a phone
   keyboard).
5. The `Ask Alfy` / `Comment` bubble is reachable on touch: selecting text by touch shows it, and it does not
   cover the selection.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the shared action list so both toolbars
      describe the same set, and a `More` sheet for the overflow. **Touch handlers that need `preventDefault()`
      use an action or `addEventListener` with `{ passive: false }`, never a legacy modifier** (AGENTS.md).

- [ ] **Step 4: Run**
      `npx playwright test tests/e2e/artifact-document.spec.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts/document tests/e2e/artifact-document.spec.ts src/lib/i18n
git commit -m "Give the phone its own toolbar

The prototype's single toolbar took 226 px of an 844 px phone viewport, so the
phone gets a short row and a sheet, and both toolbars are built from one action
list so an action cannot exist on one and not the other."
```

### Task T12: Export through `produce_file`

**Files:** `src/lib/components/artifacts/document/DownloadSheet.svelte` + test,
`src/lib/server/services/artifacts/export.ts` + test (the block → `GeneratedDocumentSource` builder),
`src/routes/api/artifacts/[id]/export/+server.ts` + test, `src/lib/client/api/artifacts.ts`,
`tests/e2e/artifact-document.spec.ts`

- [ ] **Step 1: Write the failing tests**

1. The sheet offers PDF, Word and Markdown and names the artifact ("Vienna, 10–12 October" → a file named after
   it), never the word Artifact; a title that cannot be a filename falls back to `document.md` / `document.pdf`.
2. **PDF and DOCX go through the intake server-side**, from `POST /api/artifacts/[id]/export` with
   `{ format: "pdf" | "docx" | "markdown" }`, which builds the source and calls
   `submitFileProductionIntake({ userId, body })` in-process (`file-production/index.ts:226` — the produce route
   is an HTTP adapter around the same function, `src/routes/api/chat/files/produce/+server.ts:98-104`; do not add
   a second HTTP hop and do not build the source in the browser). Assert the **persisted request**:
   `sourceMode: "document_source"`, `documentSource.template === "alfyai_standard_report"`, and
   `requestedOutputs: [{ type: "pdf" }]` — never `outputs` (`intake.ts:216-230` accepts both; the model-facing
   name is the one in the spec). The resulting produced file appears in the chat's panel list through Slice 0's
   `artifacts` list, because it is an ordinary produced file.
3. **The source contains no `<!--b:` markers**, and the mapping is **total**: for a fixture with one block of
   every kind, the builder emits exactly one `GeneratedDocumentBlock` per block, of the expected `type`, and a
   `taskList` keeps its state in the item text (`"[x] Book the hotel"`) — dropping it would silently turn a
   checklist into a plain list, and the renderer's items are plain strings
   (`renderers/standard-report-pdf.ts` `drawList(style, items: string[])`).
4. **Markdown uses `sourceMode: "inline_text"`, not a body download** — assert
   `inlineText.files[0].outputType === "md"`, the filename ends in `.md` and is a bare basename
   (`intake.ts:278-289,353-380`), and the bytes written equal the stored body **with the marker lines removed**.
   The job is real (a File card appears) but no renderer and no sandbox run are involved:
   `execution-adapter.ts:187` dispatches it and `:592` writes the bytes directly. A `document_source` request for
   `md` must be asserted **impossible**: `isInlineTextOutputType("md")` is true because `md` is
   `validation: "text"` with no `documentSource` flag (`table.ts:61-77`, `production.ts:106-112`).
5. A failed job surfaces `artifacts.document.export.failed` and offers retry through the existing File card
   affordance, not a new one.
6. Export of another user's artifact 404s; a `markdown` export of an artifact in an incognito conversation from
   outside the scope 404s too.
7. **A document too large to render is refused, not truncated.** A fixture whose `documentSource` JSON exceeds
   `maxSourceJsonBytes` (2 MiB, `file-production/limits.ts:70-86`, overridable through
   `getFileProductionLimits(config)`) comes back as the intake's limit failure, and the sheet shows
   `artifacts.document.export.tooLarge` — the renderer's limits (`maxPdfPages: 250`, `maxTableRows: 10_000`) do
   the same at their own thresholds. Do not raise a limit to make a fixture pass.
8. **A Document with no conversation is refused, not 500.** `createArtifact` allows `conversationId: null`
   (`slice-0.md:317`, `:375`) and the intake requires one (`intake.ts:396-406`): the route answers **409**
   `{ ok: false, reason: "no_conversation" }` and the sheet shows `artifacts.document.export.noConversation`. The
   state is unreachable through this slice's own creation paths, which is exactly why it needs one test — an
   unreachable branch is where a 500 ships.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**, reading
      `file-production/execution-adapter.ts` and `source-schema.ts` for the accepted document-source shape, and
      **`src/lib/server/prompts.ts`** for the existing `produce_file` guidance wording
      (`decisions.md` ruling 5: the outbound text is there, consumed by `normal-chat-context.ts`; do not
      re-add it to the context module). The export route is `requireAuth` + the artifact scope and nothing more:
      it parses `format`, reads the body through the facade, builds the source and returns the intake's verdict.
      The panel does not poll a second time — the File card and the panel list refresh through the conversation
      detail the chat page already refetches for produced files.

- [ ] **Step 4: Run**
      `npx vitest run src/lib/components/artifacts tests/integration && npx playwright test tests/e2e/artifact-document.spec.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/client/api/artifacts.ts src/lib/server/services/artifacts "src/routes/api/artifacts" tests/e2e/artifact-document.spec.ts
git commit -m "Export a document through the engine we already have

Produce_file stays the only file-production path, so an exported document is a
normal produced file with a normal card, job state and download route instead of a
second export pipeline. The markers that address blocks never reach the file."
```

### Task T13: The document evaluation suite

**Files:** `scripts/eval-artifact-contracts/document.ts`, `cases.ts`, `run.ts`, `README.md`, `scoring.test.ts`

- [ ] **Step 1: Write the failing tests** for the **pure** half only (the live half never runs in CI):

1. `scoring.test.ts` grades a documented fixture set for the document suite: a patch that applies cleanly is
   `good`; a patch that applies but rewrites text outside the requested scope is `bad`; a patch that refuses a
   non-existent block is `good` (refusing correctly is a pass, not a failure); a patch that **does not** refuse
   when it should is `bad` with the reason named; an answer with no parseable ops is `bad`, not a throw.
2. The suite's case list is non-empty, each case carries a real prompt, a real document fixture and the expected
   verdict, and `cases.ts` fails a duplicate case id (a silent overwrite would quietly shrink the gate).

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement the suite's cases** — port the prototype's
      document fixtures. Cover at least: a clean patch; a patch on a block the user changed (must refuse); a
      `replaceRange` whose `find` occurs twice (must refuse, not guess); a patch that stays inside its scope; a
      multi-op patch with a mix; and a Hungarian-language request against a Hungarian document (the owner's
      language is not always English, and neither is the model's answer).

- [ ] **Step 4: Run it for real, on the box, against the model**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run scripts/eval-artifact-contracts/scoring.test.ts
npx tsx scripts/eval-artifact-contracts/run.ts --suite document     # live; needs the model configured
```
Paste the scored result into the slice report. **A weak result changes the design** (spec §8.1), and a refusal
rate that is high because the model never re-reads is a prompt-and-tool-shape finding, not a model failure to be
excused.

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-artifact-contracts
git commit -m "Score the document patch contract against the real model

The prototype canned its document patches, so the patch protocol has never been
run against a model that can get it wrong. Refusing correctly counts as a pass;
failing to refuse when the user's text changed is the case this suite exists to
catch."
```

---

## Tests as files

Every test file this slice creates, what it covers, and the assertion that proves it. The trap cases the parent
spec names are marked **[trap]** — a slice is not done while one of them is red. Out of scope here: slice 2's
sandbox storage bridge, slice 3's canvas pointer capture and perf probe, and slices 4–6's own suites; they are
named so nobody assumes they are covered by this file.

| Test file | Covers | The assertion |
|---|---|---|
| `src/lib/shared/artifact-document/blocks.test.ts` | the block model, id minting/absorbing, the canonical form | **[trap]** ids exist **and every hash is non-empty after a parse that minted them** (T1.1); **[trap]** parse → serialise → parse is idempotent with identical ids and hashes (T1.2, "ids survive a reload"); **[trap, ruling 12]** `"canonical form: open → serialise → reload → serialise keeps every hash"` — equal `buildIndex` maps, no user edit (T1.6); one test per canonical rule; `normalizeMarkdown` idempotent; `blockHash === fnv1aHex(normalizeMarkdown(m))`; `mintBlockId` matches `/^[a-z]{1,2}[0-9a-z]{5}$/` and does not collide in 10,000 calls; a 6,000-word document parses under a machine-independent 30 ms ceiling; the module source contains no `@tiptap`/`prosemirror` (T1.9, T1.3) |
| `src/lib/shared/artifact-document/patch.test.ts` | per-op refusal, the guard, inverses | **[trap]** one test per `RefusalReason`, each asserting the `code`, `refused === 1` **and a byte-identical document** (T2.1–T2.5); the ambiguous `find` is refused rather than replaced (T2.5); two good ops + one refused → `applied === 2`, `refused === 1`, the refusal carries the `label` (T2.6); `toggleTask` flips only its own item (T2.7); chip cells serialise the canonical token regardless of locale (T2.8); inverses applied in reverse restore the exact pre-patch Markdown (T2.10); `applied + refused === ops.length`, including the empty set (T2.11) |
| `src/lib/shared/artifacts/anchor.test.ts` | the shared anchor vocabulary (ruling 11) | score → state (`>= 4` exact, `> 0` moved, else orphaned); state → tone; the orphan yields `blockId: null` and `-1/-1` (T10.8) |
| `src/lib/shared/artifact-document/anchor.test.ts` | the Document's text resolver | **[trap]** two identical sentences resolve to the anchored block, not the first (the `+4` bonus, T10.3); an unrelated edit above keeps `exact`; the quote's paragraph edited → `moved`; the quote deleted → `orphaned`; `reanchor` after a split; the 50-candidate cap bounds the scan (T10.2, T10.9) |
| `src/lib/server/services/artifacts/serialize/document.test.ts` | the serializer against Slice 0's `ArtifactSerializer` | `createBody` mints ids and returns a body whose `hashBody` equals the hashes of the parsed blocks; `parse(serialize(body))` round-trips; a body with a marker in it is parsed, not trusted |
| `src/lib/server/services/artifacts/export.test.ts` | block → `GeneratedDocumentSource` | the mapping is **total** — one output block per input block, expected `type` each (T12.3); **no `<!--b:` anywhere in the source**; a `taskList` keeps `[x]`/`[ ]` in the item text; `chart`/`image`/`sourceChips`/`pageBreak` are never emitted; a title that cannot be a filename falls back to `document` |
| `tests/integration/artifact-document.test.ts` | the Document on a real DB | **[trap]** the reload path — create → read the raw stored body → parse it fresh → patch with those hashes → `applied === ops.length` (T3.4); **[trap]** after a user edit through `saveDocumentBody`, the same patch refuses `block_changed` and the body does not move (T3.5); **[trap] ownership** — another user's artifact is `not_found`, a canvas is `not_a_document`, an incognito artifact outside the scope is `not_found` (T3.7); stored body is already canonical (T3.10); body + snapshot are one transaction (T3.11); `restoreVersion` writes a new version with ids intact (T3.8); stale `expectVersion` → `version_conflict` and no write (T3.6); `artifact_kv` is unreadable outside a scoped read (T3.9) |
| `src/lib/server/services/normal-chat-tools/artifacts.test.ts` | the three tools | **[trap] scope** — `create_artifact`'s schema has no `userId`/`conversationId`/`artifactId` (T4.1); an unknown `artifactType` is a model-safe failure, not a throw (T4.2); `read_artifact` on a File names the type; on another user's id, not-found (T4.3); `edit_artifact` returns per-op `{blockId, blockLabel, code, reason}` (T4.4); an empty `ops` writes no version (T4.5); both successful calls write the message link row (T4.6); the three names are registered unconditionally and the schemas expose no scope fields (T4.7); `TOOL_I18N` has `en`+`hu` and `TOOL_TIMEOUTS_MS` has all three keys (T4.8) |
| `src/routes/api/artifacts/**/*.test.ts` | the Document routes | body PATCH: `{ok:true,version}`, 409 `version_conflict` and 413 `too_large`; patches route returns `{applied, refused, outcomes, version}`; versions list/restore, and another user's version ids 404 (T6.5); comments create/resolve; `@Alfy`'s three outcomes (T10.5); a client-supplied `author: "alfy"` is ignored (T10.7); export 404 for a foreign or out-of-scope artifact (T12.6), the limit failure (T12.7) and the `conversationId: null` **409** `no_conversation` (T12.8) |
| `src/lib/client/api/artifacts.test.ts` | the browser calls | every function posts the documented shape through the injected `fetchImpl`, parses through `requestJson`/`_unwrapList`, and surfaces the conflict/limit codes rather than a string |
| `src/lib/components/artifacts/document/*.test.ts` | the panel editor and its chrome | **[trap]** the editor module loads **once** across three re-renders (T7.1); **[trap, ruling 12]** `"canonical form survives the editor round trip"` — two full load/serialise passes, identical hashes, no user edit (T7.5); the save posts `serializeDocument(parseDocument(browserMarkdown).blocks)` — the server's canonicaliser, not a second one (T7.2); a conflict keeps the user's text (T7.3); after a save the pre-edit hash refuses `block_changed` (T7.4); 12 ids survive a keystroke and a save (T7.6); offline keeps the text and shows the notice (T7.9); a 404 stops autosave, keeps the text and offers `saveCopy` (T7.10); `Keep`/`Undo` are exact and preserve ids (T8.1–T8.5); the refusal notice names the block (T8.4); tabs keep the editor mounted (T9.1); chips store canonically under a Hungarian UI (T9.5–T9.6); the margin's three anchor states including the orphan (T10.2, T10.9); the mobile toolbar height + the shared action ids (T11.1–T11.5); the download sheet's three formats, filenames and failure state (T12.1, T12.5) |
| `src/lib/components/artifacts/ArtifactCard.test.ts` | the Document card | the subtitle counts tabs; the preview shows the first lines; **[trap]** ticking a card checkbox writes through the patch path (a refused patch must leave the checkbox unticked after a reload — T9.7) |
| `src/lib/components/chat/**` (the message-row test beside the component) | `Open as document` | the action appears on a text answer and not on an empty or tool-only one; asking twice opens the same artifact (T5.1–T5.3); the created body has one marker per block and no reasoning text (T5.4) |
| `src/lib/i18n/artifacts.test.ts` (Slice 0's) + `src/lib/i18n.test.ts` | namespaces | parity green for `artifacts.` and `chat.artifacts.`; **no value in either locale matches `/artifact/i`**; the `refused.notice` plural renders for 1 and 3 in both locales |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | the ownership guard | unchanged file, unchanged `ALLOWED_WITHOUT_SCOPE`: the new `artifacts` readers must carry a scope marker (`:498-508,561-593`) |
| `tests/e2e/artifact-document.spec.ts` | the whole journey | the Verification checklist's end-to-end list, at 1440×900 and 390×844 |
| `scripts/eval-artifact-contracts/scoring.test.ts` | the eval's pure half | refuses-correctly is `good`; a patch that rewrites outside its scope is `bad`; a failed refusal is `bad` **with the reason named**; unparseable ops are `bad`, not a throw; duplicate case ids fail (T13.1–T13.2) |

The live half — `npx tsx scripts/eval-artifact-contracts/run.ts --suite document` — is **not** in CI and is not a
unit test; its scored output is a slice-report artefact (T13 step 4).

## UI states

The shell is Slice 0's `document-workspace/DocumentWorkspace.svelte` (its path, props and `data-testid`s are
pinned — ruling 10), and this slice adds only the content area for `kind: "document"`. Scroll ownership stays
with the panel shell (AGENTS.md), never with the body or `body`.

| State | 1440 px | 390 px | Component · tokens |
|---|---|---|---|
| **Empty** (a Document with no text yet) | the editor is focusable with the placeholder `artifacts.document.editor.placeholder` in `--text-muted`; the tab strip is hidden at one tab; the toolbar is visible but inert actions are `--text-muted` | same, minus the tab strip; the toolbar is `MobileToolbar` | `DocumentBody.svelte` → `--surface-page` for the editor surface, `--border-subtle` for the toolbar's rule, `--radius-md` on the sheet edges |
| **Loading** (the lazy editor chunk) | the body area shows a reserved-height skeleton on `--surface-elevated`; the toolbar renders immediately (it must not import the editor) and is disabled until ready; **no layout shift** — the container's min-height is set before the module resolves | same; the skeleton fills the content area below the toolbar | `DocumentBody.svelte`'s `{#await}` over the cached-promise loader (Slice 0's pattern, `DocumentWorkspace.svelte:611-618`), `--duration-standard` on the fade, `common.loading` for the status line |
| **Error** (the chunk fails to load, or the artifact answers 404) | `artifacts.document.editor.failedToLoad` + a `common.retry` button in the content area; a 404 shows `artifacts.document.deleted` instead, **with the text still in the editor** and the `saveCopy` button | same, full width | `--surface-overlay`, `--border-default`, `--text-primary` for the line, `--border-focus` on the button's focus ring |
| **Long content** (6,000 words) | the editor scrolls inside the content area; the tab strip and toolbar stay put; the margin becomes a right-hand column ≥ 1024 px | the editor fills the viewport minus the toolbar (≤ 48 px, T11.1); the margin is a bottom sheet opened from the change bar's count | the margin at ≥ 1024 px is `--surface-elevated` with a `--border-subtle` left rule; the `More` sheet is `--surface-overlay` + `--shadow-lg` + `--radius-lg` |
| **Alfy writing** | the inline `Alfy is writing: {label}` shimmer at the block's position (`artifacts.document.planned.writing`), `--duration-emphasis` | same | `AlfyWriting.svelte` |
| **Refused** | the change bar keeps `Alfy · Keep · Undo` for applied changes, and `artifacts.document.refused.notice` appears once per patch with a `See what Alfy did` link that scrolls to the applied change | same, in the bottom sheet's header area | `--surface-overlay`, `--border-default` |

**Focus and keyboard order.** At 1440 px, DOM order is the tab strip → the toolbar row → the editor → the margin
threads; at 390 px it is the toolbar → the editor → the `More` sheet's trigger, and the margin sheet is reached
from the change bar. The editor is **one tab stop** (the contenteditable host, not each block). The `More` sheet
traps focus while open, `Escape` closes it and returns focus to the button that opened it, and the chip dropdown
is a listbox driven by arrow keys with `Enter` to commit. Every focusable control shows the `--border-focus` ring;
nothing relies on hover. Decorative icons carry `aria-hidden="true"`; every control's `aria-label` names the type
in words ("Document", never "Artifact" — ADR-0066), and `Esc` in the editor does not bubble into the panel's
close action.

## Failure modes

| Failure | Server behaviour | User sees |
|---|---|---|
| **The model returns malformed output** — unknown op kind, a missing `baseHash`, `cells` of the wrong shape | the tool's Zod schema rejects it before any write; the SDK returns a tool error to the model, the turn continues, and **no version row is written**. The browser-only `PATCH …/document/patches` route answers **400** `{ ok: false, reason: "invalid_patch" }` through `createJsonErrorResponse` | nothing in the document; the tool-call row shows `Could not change the document` / `A dokumentumot nem sikerült módosítani` (`edit_artifact.errorPrefix`). The model is told to re-read and retry |
| **A patch is refused** — not an error, the feature | **200** with `{ ok: true, applied, refused, outcomes }`; each refused op carries its `code` (`block_changed`, `block_unseen`, `find_ambiguous`, …). Nothing is written for a refused op | `artifacts.document.refused.notice` (ICU plural, 1 vs many) plus the per-op sentence from `artifacts.document.refused.*` naming the block's label, and the applied changes are still visible |
| **The network drops mid-edit** | no request reaches the server; no code is involved | `artifacts.document.save.offline` (`Not saved yet — you are offline. Your text is safe here.` / `Még nincs elmentve — nincs kapcsolat. A szöveged itt biztonságban van.`); the text stays, the next debounce retries, the notice clears on success |
| **The save collides with another pane** (a tool call wrote the body first) | **409** `{ ok: false, reason: "version_conflict", version }` from `PATCH /api/artifacts/[id]/body`; nothing written | `artifacts.document.versions.conflict` — `This document changed elsewhere. Reload to see the current text.` / `Ez a dokumentum máshol megváltozott. Töltsd újra a jelenlegi szövegért.` The user's typed text is **kept** in the editor (T7.3) |
| **The body exceeds Slice 0's cap** (2 MiB of Markdown — a pasted novel) | **413** `{ ok: false, reason: "too_large" }` from `PATCH /api/artifacts/[id]/body`; nothing is written and the version count does not move (`slice-0.md:932`) | `artifacts.document.save.tooLarge` — `This document is too long to save.` / `Ez a dokumentum túl hosszú ahhoz, hogy elmentsük.` The user's text **stays** in the editor and autosave **stops retrying** (a size refusal is not transient); the export path's `export.tooLarge` is a different message for a different limit |
| **The artifact is deleted while it is open** | **404** `{ ok: false, reason: "not_found" }`; autosave stops | `artifacts.document.deleted` — `This document was deleted while it was open. Your text is still here.` / `Ezt a dokumentumot törölték, amíg nyitva volt. A szöveged még itt van.` + `artifacts.document.deleted.saveCopy` → creates a new Document from the editor's text |
| **No permission** (another user's artifact, or an incognito conversation read from outside the scope) | **404**, never 403 — the same answer Slice 0's routes give, so existence is not confirmed (`slice-0.md:604`, `:606-608`) | `artifacts.document.notFound` — `This document is not available.` / `Ez a dokumentum nem érhető el.` There is no "you cannot" message in this feature, because the only two users in the system are the owner and nobody |
| **Alfy has never read the document** | every op refuses `block_unseen`; **no error** | nothing — the model gets the refusal and reads first. `read_artifact` is what writes the snapshot |
| **A tool call times out** (`TOOL_TIMEOUTS_MS`: 10 s / 10 s / 20 s) | the envelope aborts and returns the tool's error to the model; the turn continues | the tool-call row shows that tool's `errorPrefix`, and Alfy's reply says what it could not do |
| **Export is too large to render** | the intake refuses with its own status and limit code (`maxSourceJsonBytes` 2 MiB, `maxPdfPages` 250, `maxTableRows` 10 000 — `file-production/limits.ts:70-86`); nothing is queued | `artifacts.document.export.tooLarge` — `This document is too long to export. Split it into two documents.` / `Ez a dokumentum túl hosszú az exportáláshoz. Bontsd két dokumentumra.` Do not raise a limit to make a fixture pass |
| **The export job fails after it was accepted** | the job's own failure state, unchanged by this slice | `artifacts.document.export.failed` and the **existing** File card's retry affordance — not a second retry UI |
| **A Document has no conversation to export into** (`artifacts.conversation_id` is nullable, `slice-0.md:317`, `:375`, but file production requires one, `file-production/intake.ts:396-406`) | **409** `{ ok: false, reason: "no_conversation" }` and nothing is queued — never a 500, and never a silent attach to whatever chat is open | `artifacts.document.export.noConversation` — `This document is not linked to a chat, so it cannot be exported.` / `Ez a dokumentum nincs beszélgetéshez kapcsolva, ezért nem exportálható.` |

## Limits and configuration

**No new runtime setting, and no change to `env.ts` or `config-store.ts`** (Non-goals). Everything this slice
bounds is either derived from an existing limit or a named client constant:

| Cap | Value | Where it is read / set | Why it is what it is |
|---|---|---|---|
| Document save debounce | **800 ms**, injectable | `createDocumentAutosave({ save, delayMs = 800 })` in the document module — the same injectable-delay shape as `createDraftPersistence(fetchImpl, delayMs = 400)` (`src/lib/client/conversation-session.ts:426-429`) | hard-coded on purpose: it is a feel decision, and it is one named constant rather than a literal at each call site. 800 ms is one idle step above the chat's 400 ms draft save, because a document save is a version row |
| Anchor candidate scan | **50** positions per block | `resolveTextAnchor` in `src/lib/shared/artifact-document/anchor.ts` | hard-coded: the prototype's cap. A document is user-sized and the margin re-resolves on every change, so an unbounded scan is the one place a comment could cost O(document) per keystroke |
| Version list | newest first, **50** per call | Slice 0's `listVersions(params:{…, limit?})` (`slice-0.md:415`) and its `ARTIFACT_VERSIONS_DEFAULT_LIMIT = 50` (`slice-0.md:935`) | existing; the sheet asks for the default and pages no further |
| `read_artifact` text budget | **24,000 characters** per call, then `truncated: true` with the remaining block ids | `MAX_READ_ARTIFACT_CHARS = 24_000` in the tool module, mirroring `MAX_CONTENT_LENGTH = 24000` (`normal-chat-tools/read-generated-file.ts:2214`) | a 6,000-word document must not be dumped into the context; the model can address the blocks it did not receive by id, so truncation is a pointer, not a loss |
| Tool timeouts | 10 s / 10 s / 20 s | `TOOL_TIMEOUTS_MS` (`normal-chat-tools/shared.ts:196`) | local database work only — no provider, no container, so `produce_file`'s 40 s wait is irrelevant here |
| Export source size | **2 MiB** (`maxSourceJsonBytes`), PDF pages **250**, table rows **10 000** | `getFileProductionLimits(config)` → `DEFAULT_LIMITS` (`file-production/limits.ts:70-86`), override-aware through the runtime config (`fileProductionMax*`) | existing limits, already enforced by the intake. This slice **consumes** them and surfaces the refusal; it does not change them |
| Produced filename | bare basename, no leading dot, **≤ 120 chars**, extension must match the type (`.md`) | `sanitizedProducedFilename` (`file-production/intake.ts:278-289`) and the inline-text extension check (`:353-380`) | existing intake rules; the sheet's fallback name is `document.md` / `document.pdf` |
| Document body size | **2 MiB** — Slice 0's `ARTIFACT_BODY_MAX_BYTES`, already enforced | `record.createArtifact` / `record.updateArtifactBody` → `too_large` (`slice-0.md:932`); this slice **surfaces** it in the panel and adds no second cap | not configurable, and this slice must not make it so: the body is `content_text` in SQLite, and the panel's job is to show the refusal (the failure-modes table) rather than to re-check the size in the browser. A second cap in the panel would be a second source of truth for the same limit |

## Prototype pointers

The prototype is a throwaway branch, but its engine is real, working code and is the reference for every hard
part here. Read these rather than inventing an approach; the worktree is
`.claude/worktrees/agent-a883f7e86c2b442fd/src/routes/prototype/document/`.

| Hard part | Read | What to take, and what to change |
|---|---|---|
| Marker parsing, minting, absorbing | `_lib/doc-model.ts` — `MARKER_PREFIX`, `MARKER_RE`, `BlockMarker` (the Markdown tokenizer/renderer), `absorbBlockMarkers`, `injectMarkers`, `ensureBlockIds`, `countMarkers` | take the tokenizer and the absorb/inject pair; **change the hash substrate** (prototype `blockHash` hashes ProseMirror JSON) and move the mint to immediately after the parse |
| The mint-before-hash bug, as measured | `_notes/review.md` | the failure it records: ids minted after the snapshot made every patch refuse on a freshly loaded document |
| The guard, verbatim | `_lib/patch-engine.ts` — `applyPatchSet(editor, patch, snapshot)` | take the three-way comparison (snapshot vs live vs `baseHash`) and the per-op `continue`, not the English refusal strings: the reasons become `code`s and the sentences move to `artifacts.document.refused.*` |
| Exact undo | `_lib/patch-engine.ts` — the change-inverse record | take the inverse-per-applied-op idea so Undo never re-parses |
| The chip node | `_lib/tracker-chip.ts` — `createInlineMarkdownSpec` | **the spec must be spread at the top level**; nested under `markdown:` it parses back as literal text and the round trip silently breaks. Values: `STATUS_VALUES = ["Booked", "To book", "Paid", "Cancelled"]`, dates as ISO (`_lib/chip-values.ts`) |
| Comment anchoring | `_lib/comments.ts` — `scoreAt`, `resolveAnchorIn` (candidate cap 50, confidence 0/1/2), `reanchor(doc, comment, range)` | take the scoring and the cap; the module split changes (ruling 11: the interface is shared, the resolver is per type) |
| Anchor labels and tones | `_lib/anchor-state.ts` — `anchorState(confidence)` → `{ tone: "ok" \| "warn" \| "lost", label, detail }` | take the three tones; the labels become `artifacts.document.anchor.*` |
| The lazy boundary | `_lib/editor-runtime.ts` — `createEditor({ element, markdown, onUpdate, onSelectionUpdate })`, `loadMarkdown(editor, markdown)` | take the shape: `contentType: "markdown"`, and `loadMarkdown` = `setContent(markdown, { contentType: "markdown" })` **then** `ensureBlockIds(editor)` |
| The inline change bar | `_lib/alfy-change.ts` + `PrototypeSelectionBubble.svelte` | take the mark + widget pattern for `Alfy · Keep · Undo` |
| The mobile toolbar regression | `PrototypeToolbar.svelte` + `_notes/review.md` + `_notes/probe-report.txt` | the measured numbers: **before** the fix, toolbar 226 px = 27 % of the 844 px phone viewport (chrome 322 px = 38 %); **after** it, toolbar 137 px and chrome 269 px = 31.8 % with the notice dismissed (head 97 + toolbar 137 + status 35) — the 48 px budget T11.1 asserts |
| The numbers to compare against | `_notes/review.md` | route 157 kB gzip; the Tiptap bundle 468,060 B raw / **146,817 B gzip**; the route chunk 53,350 B raw / 16,871 B gzip; 49 ids survive a reload; 12 markers cost +208 chars (+14.4 %) ≈ 17 chars per block. This slice's report quotes the real post-change build output next to these |

**Reading trap.** `src/lib/server/services/file-production/source-schema.ts` contains a NUL byte, so plain `grep`
treats it as binary and reports nothing. Use `rg -a` (or the Read tool) — the block union is at `:1-20` and
`GeneratedDocumentSource` at `:235`.

---

## Non-goals

- **No Canvas, App or Slides body.** `artifact-bodies.ts` gains one line.
- **No prompt guidance for choosing a type.** The tools are registered and usable; the "when to offer an
  artifact" prompt work and the Info-popover rows are Slice 5.
- **No evidence integration** — an artifact's sources becoming visible is Slice 5.
- **No project bundle listing** (Feature 1's list of a project's artifacts) — Slice 5.
- **No collaborative or multi-careted editing**, no presence, no per-block locking beyond `expectVersion`.
- **No file versioning for uploaded or generated files.** ADR-0065's exception is Documents only, and no AI edit
  of an uploaded library file.
- **No in-document search/replace UI**, no grammar tooling, no Pandoc-style import of `.docx` into a Document.
- **No new table, no new admin setting.**

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Ids minted after the first hash or snapshot | Every patch refuses; the type looks broken on the second session | T1.1 asserts the order, T3.4 asserts it across a real reload, and `parseDocument` returns `minted` so a caller cannot forget |
| The browser's Markdown and the server's canonicaliser drift | Hashes disagree, so either everything or nothing refuses | One `normalizeMarkdown`, imported by both; T7.5 asserts a two-pass round trip in a real editor |
| Tiptap's Markdown round trip is not byte-identical (padding, chips) | Silent hash churn on a load with no user edit | T1.6 pins the padding case; T7.5 is the editor-level version of the same test |
| Tiptap leaking into the panel shell | Every chat page pays ~147 kB gzip | The editor is one lazy module; T7.8 asserts it; the margin imports only the pure anchor module |
| A refused op that still mutated the document | Silently loses the user's words — the one thing §2.5 forbids | T2 asserts byte-identity for every refusal reason; the engine applies to a copy |
| Undo implemented as "re-parse an earlier Markdown" | Loses a user edit made in between, or re-mints ids and orphans every comment | T8 uses `inverses` and asserts ids survive; T3.8 asserts restore does not re-mint |
| `expectVersion` missing | A chat tool call and a panel save clobber each other silently | T3.6 asserts the conflict path; T7.3 asserts the editor keeps the user's text on conflict |
| Chip values localized into content | A document's stored data changes with the UI language | T9.5/T9.6 assert the canonical token in the serialised Markdown |
| The mobile toolbar eating the viewport | The prototype's unfixed toolbar took 226 px of an 844 px phone viewport (27 %; 137 px even after its own fix) | T11.1 asserts a hard 48 px height budget and the editor's share of the viewport |
| Chunk budget unmeasured | "It is lazy" becomes an assumption | The Gates block requires the measured pair in the report, method named |
| The eval gate skipped or explained away | The only proof the protocol works with a real model | T13 step 4 runs it on the box and its result goes in the report; §8.1 makes a weak result a design change |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — green, including `tests/cross-cutting/**` (with **no** new `ALLOWED_WITHOUT_SCOPE` entry) and
      the artifacts suites.
- [ ] **Both halves of ruling 12's gate, run by name:** `npx vitest run src/lib/shared/artifact-document -t
      "canonical form"` and `npx vitest run src/lib/components/artifacts -t "canonical form survives the editor
      round trip"` — the second asserts two full load/serialise passes with no user edit in between.
- [ ] `npm run check:migrations` — clean; no new table and no `_journal.json` entry in any commit of this slice.
- [ ] `npm run build` — 0 warnings, and the measured panel-shell / editor chunk pair recorded in the report with
      its method (raw and gzip, before and after), next to the prototype's figures.
- [ ] The document editor's laziness is asserted by **source scan** (no chunk-manifest machinery was invented):
      no `@tiptap`/`prosemirror` string in the shell, the toolbar, the margin, the chips module or
      `artifact-bodies.ts`.
- [ ] Every new key has a real Hungarian value — including the three **tool descriptions** in `TOOL_I18N.hu`,
      which the parity test cannot see and which otherwise fall back to English silently.
- [ ] `artifacts.document.refused.notice` renders for a 1-part and a 3-part refusal in both locales (the ICU
      `one`/`other` branches), and its English text never prints `{count}` literally.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-document.spec.ts tests/e2e/artifact-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/mobile-design.spec.ts`
      — green.
- [ ] The E2E spec covers, end to end: create a Document from chat; reload and confirm the same ids; ask Alfy for
      a change; **edit the block first and watch the refusal**; `Keep`; `Undo`; comment with `@Alfy` and see the
      reply; tick a card checklist item; export a PDF; open it at 390×844.
- [ ] Real-app visual check at **1440×900 and 390×844, light and dark** against the Document frame of the
      mockups, including the tab strip, a tracker table with a status dropdown open, the selection bubble, an
      inline `Alfy · Keep · Undo`, the margin with an `Exact`, a `Moved` and an `Orphaned` thread, and the mobile
      `More` sheet.
- [ ] i18n parity green; no value in either locale matches `/artifact/i`; `"artifacts."` and `"chat.artifacts."`
      in `AUDITED_PREFIXES`.
- [ ] `scripts/eval-artifact-contracts/run.ts --suite document` has been run against the real model and its
      scored result is in the report; the scoring module is in CI and the live run is not.
- [ ] No new runtime setting; `@tiptap/*` pinned to exactly 3.31.3, and every other new dependency named in the
      report with its license.
- [ ] Perf numbers in the report: ms/keystroke at 5,691 words (budget 2 ms), and the parse time from T1.9.
- [ ] Every touched file is Svelte 5 (`$props`, callback props, `onclick`), with no new legacy syntax.
- [ ] Every new icon is a real `@lucide/svelte` export, verified against the installed package.

## Owner decisions

Locked by the spec and not reopened here: block ids persist in the Markdown as `<!--b:id-->` markers (§2.6); a
patch to a block the user changed is refused, the others apply (§2.5); comments are one shared feature across
types (§2.7); Alfy leaves its own note when it makes a judgement call (§2.8); the editor is lazy (§2.15);
comments are how you talk to Alfy inside the document (§2.7, §2.8); no sharing (§2.16).

Decisions **this slice adds**, for the owner to confirm or overrule:

1. **The hash is over canonical block Markdown, not ProseMirror JSON.** The prototype hashed the editor's JSON,
   which only the browser can compute; the spec makes refusal a server decision (§4), so the substrate had to
   change to something both sides can compute. `normalizeMarkdown` is what makes it stable across an editor
   round trip.
2. **The last-read snapshot is persisted in `artifact_kv['alfy.snapshot']`**, not in `metadata_json` and not in
   the browser. The spec lists `idIndex?` in `metadata_json` without saying what it is for; this slice does not
   persist a second index — the live index is derived on demand from the blocks it already parses.
3. **`replaceRange` refuses an ambiguous `find`** rather than replacing the first occurrence. The prototype could
   pick a ProseMirror range; the server cannot see one, and guessing would break §2.5 in the one case where the
   user cannot tell it happened.
4. **Patches are applied to block text server-side, so the prototype's four op kinds become five**
   (`replaceBlock` is new, and `insertText`/`replaceRange`/`toggleTask`/`addTableRow` are re-expressed against
   Markdown). The model's contract stays block-addressed with a base hash, as §4 requires.
5. **Tabs are sections of one document** (the mockup's "Plan, Budget, Packing") and the card subtitle counts
   them; their storage is decision 13 below. If "tabs" was meant as something else, this is the decision to
   correct before T9.
6. **Export goes through the file-production intake, in two modes, and the markers are stripped in both.**
   PDF/DOCX use `sourceMode: "document_source"` with a `GeneratedDocumentSource` built from the parsed blocks;
   Markdown uses `sourceMode: "inline_text"` because `md` is renderable but not a document source
   (`src/lib/shared/file-types/types.ts:127-134`) and there is no artifact-body download route to reuse
   (`/api/chat/files/[id]/download` serves generated-file ids through `resolveGeneratedFileServing`). The source
   is built **server-side** in `POST /api/artifacts/[id]/export`, never in the browser.
7. **`Open as document` links an assistant message to one Document** (idempotent per message), and the created
   document is the message's visible text.
8. **The mobile toolbar is a separate component** with a shared action list, not a responsive restyle of the
   desktop one.
9. **`@tiptap/*` is pinned to exactly 3.31.3.** Every stored document's hashes depend on its Markdown
   round-trip; a floating range would make a minor upgrade a data migration.
10. **`read_artifact` truncates rather than dumps.** The call returns at most 24,000 characters of block text plus
    `truncated: true` and the ids of the blocks it did not send — a 6,000-word document must not be pushed into
    the context in one call, and the ids make the omission addressable rather than silent.
11. **The panel never builds a file-production source.** The block→`GeneratedDocumentSource` mapping and the
    marker stripping are server-side, in the export route and its builder module, so there is exactly one
    implementation of each and the browser cannot drift from it.
12. **A Document with no permission to read is a 404 with a "not available" line, not a permission message.**
    This feature has no sharing (§2.16), so the only reviewer of a permission string is the person who wrote it;
    matching Slice 0's route rule keeps the two answers indistinguishable, which is the safer default if sharing
    ever changes (it will not).
13. **The tab strip lives in `metadata_json.tabs`, not in the version store.** `artifact_versions.body` is the
    Markdown at that point (spec §3), so a version is text and a restore restores text; tabs are structure, and a
    restore reconciles them on read rather than rewriting or dropping them (Contracts). The alternative —
    embedding tabs in the Markdown — would put UI structure inside the document the model reads and writes.
14. **`expectVersion` is a version-number guard beside Slice 0's `baseHash` body-hash guard, not a replacement.**
    The panel's autosave race is about *which version* it is editing; the model's per-block guard is about *what
    the user changed*. Collapsing them would answer one question with the other's evidence.
