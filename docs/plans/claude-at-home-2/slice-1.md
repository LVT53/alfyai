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

**Spec:** [`-artifacts-spec.md`](./claude-at-home-2-artifacts-spec.md) §2.4–2.8, §3 (Document body), §4, §5, §6
(Slice 1), §7. Design target: the Document frame of
[`-artifact-types-mockups.html`](./claude-at-home-2-artifact-types-mockups.html) and the reference
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
  localized (see Contracts: chips).
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
npx vitest run tests/cross-cutting/incognito-artifact-containment.test.ts
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-document.spec.ts tests/e2e/chat.spec.ts tests/e2e/mobile-design.spec.ts
```

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
   with its id marker stripped**, which both sides compute from the same module.
3. **A patch that half-applies.** Per-op refusal is the contract: the applied count, the refused list and the
   visible notice must all agree, and a refused op must not have mutated the body. T2 asserts this per reason.
4. **The refusal being invisible.** "Your words win" is only a feature if the user sees it. T8's test drives the
   refused path and asserts the notice names the block, not a generic error.
5. **Tiptap leaking into the route chunk.** Importing `comments.ts` (which reaches Tiptap in the prototype) from
   the margin pulls the whole editor into every chat page. T7 asserts the built panel-shell chunk does not grow,
   and the review greps the non-editor modules for `@tiptap`/`prosemirror` imports.
6. **Anchors that lie.** A comment showing "Exact" when the quote moved is worse than no comment. T10 asserts
   all three anchor states against real edits, including the orphan.
7. **The mobile toolbar eating the screen.** The prototype's toolbar took 29% of a 390 px viewport (137 px).
   T11 has its own layout and a Playwright assertion on its height.
8. **Chips leaking locale into content.** A stored `value="Booked"` is content and must not become
   `value="Foglalt"`; only the label is translated (T9).
9. **The eval gate being skipped.** §4 makes the harness a gate per type, not a one-off. T13 wires it and the
   slice is not done until it has run against the real model and its result is in the report — a weak result
   changes the design rather than being argued away (spec §8.1).

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
export function fnv1aHex(input: string): string;
export function mintBlockId(kind: BlockKind): string;          // prefix + 5 base36 chars, e.g. "p7k2xq"
export function countMarkers(markdown: string): number;
export function buildIndex(blocks: DocumentBlock[]): Record<string, string>;   // id → hash
```

Rules:

- `normalizeMarkdown` is the **one** canonicaliser: it trims trailing whitespace per line, collapses >2 blank
  lines to 1, normalises the table column padding the prototype lost, and stabilises chip syntax. Both sides
  hash its output, so a Tiptap round-trip that shifts padding does **not** invalidate every hash. Without this,
  "your words win" refuses everything the moment the user touches the editor.
- `parseDocument` returns `minted: true` when it wrote ids. Callers that get `minted: true` **must persist the
  canonical Markdown** before doing anything else — that is the prototype's trap, written as an API contract.
- A marker line addresses **the block that follows it**. A marker with no following block, and a block with no
  marker, are both handled (the first is dropped, the second mints).
- `mintBlockId` prefixes by kind so a hand-read board is legible: `p` paragraph, `h` heading, `l` list,
  `t` taskList, `tb` table, `q` quote, `c` code.
- A block's `markdown` **never contains the marker**. `serializeDocument` is the only function that writes
  markers.

`anchor.ts` (same module, also pure):

```ts
export interface TextAnchor { kind: "text"; blockId: string; quote: string; prefix: string; suffix: string }
export interface AnchorResolution { blockId: string; from: number; to: number; confidence: 0 | 1 | 2 }
export function makeAnchor(blocks: DocumentBlock[], blockId: string, quote: string, prefix: string, suffix: string): TextAnchor;
export function resolveAnchor(blocks: DocumentBlock[], anchor: TextAnchor): AnchorResolution;
export function anchorStateFor(confidence: 0 | 1 | 2): "exact" | "moved" | "orphaned";
export function reanchor(blocks: DocumentBlock[], anchor: TextAnchor): TextAnchor | null;   // best-effort re-point after a block is split
```

`resolveAnchor` is the prototype's `resolveAnchorIn`/`scoreAt` moved onto shared blocks: **+4** for a hit inside
the anchor's own `blockId`, **+2** for a matching prefix, **+2** for a matching suffix; `confidence` is `0` when
the score is ≥ 4, `1` when the quote was found more weakly, `2` when it is gone. The UI never prints those
numbers — it prints `Exact`, `Moved`, `Orphaned` from `anchorStateFor`, and the *tone* (ok / warn / lost) comes
from the same function so the three labels cannot drift apart.

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

Additive extensions to Slice 0's service (do not break its callers):

```ts
// artifacts/record.ts
updateArtifactBody(params: {
	userId: string; artifactId: string;
	body: string; bodyHash: string;
	author: ArtifactAuthor; summary: string;
	/** Optional: merged into metadata_json in the same transaction. */
	metadataPatch?: Record<string, unknown>;
	/** Optional: written as artifact_kv['alfy.snapshot'] in the same transaction. */
	snapshot?: { at: number; docVersion: number; index: Record<string, string> };
	/** Optional: refuse unless the current version matches. */
	expectVersion?: number;
}): Promise<{ ok: true; versionId: string; versionNumber: number } | { ok: false; reason: "not_found" | "version_conflict" }>;
```

A `version_conflict` is what makes two panes (a chat and the panel) unable to silently clobber each other. If
Slice 0 has already merged without these fields, add them here as optional parameters — nothing in Slice 0
depends on their absence.

Routes (thin, ownership-scoped, `requireAuth`):

| Route | Request | Response |
|---|---|---|
| `PATCH /api/artifacts/[id]/body` | `{ markdown, expectVersion }` | `{ ok: true, version }` \| 409 `{ ok: false, reason: "version_conflict", version }` |
| `PATCH /api/artifacts/[id]/document/patches` | `{ patch: PatchSet }` | `{ ok: true, applied, refused, outcomes, version }` — used only by the panel's own "Ask Alfy on a selection" path (T10b); the model path goes through the tool |
| `GET /api/artifacts/[id]/versions` | — | `{ versions: ArtifactVersionSummary[] }` |
| `GET /api/artifacts/[id]/versions/[versionId]` | — | `{ markdown }` |
| `POST /api/artifacts/[id]/versions/[versionId]/restore` | — | `{ ok: true, version }` |
| `POST /api/artifacts/[id]/comments` | `{ anchor, body, parentId? }` | `{ comment }` |
| `POST /api/artifacts/[id]/comments/[commentId]/resolve` | `{ resolved }` | `{ ok }` |
| `POST /api/artifacts/[id]/comments/[commentId]/alfy` | — | `{ ok, patchResult }` — the `@Alfy` hook (T10b) |

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

**Export.** The panel's download action opens a small sheet (`Download PDF / DOCX / Markdown`) and posts to the
existing file-production intake with `sourceMode: "document_source"` and `requestedOutputs` (the model-facing
name — never `outputs`). **Read `file-production/execution-adapter.ts` for the document-source shape it accepts
and build that shape from the parsed blocks; do not invent a second source format.** Markdown export is a direct
body download through the existing chat-file download route, no sandbox. The produced file appears as a File
artifact in the same chat, and lands in the panel's list, because it is a produced file like any other — no new
plumbing (spec §5).

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
| `artifacts.document.refused.notice` | `Alfy left {count} part{s} alone because you had changed {them}.` | `Alfy {count} részt nem érintett, mert megváltoztattad.` |
| `artifacts.document.refused.changed` | `you changed this after Alfy last read it` | `ezt megváltoztattad, miután Alfy utoljára olvasta` |
| `artifacts.document.refused.unseen` | `Alfy has not read this part yet` | `Alfy még nem olvasta ezt a részt` |
| `artifacts.document.refused.missing` | `this part no longer exists` | `ez a rész már nincs meg` |
| `artifacts.document.refused.ambiguous` | `the text Alfy wanted to replace is not unique here` | `a szöveg, amit Alfy le akart cserélni, nem egyedi itt` |
| `artifacts.document.refused.other` | `Alfy could not apply this change` | `Alfy nem tudta alkalmazni ezt a módosítást` |
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

`"artifacts."` is already in `AUDITED_PREFIXES` from Slice 0; `chat.artifacts.*` needs its own entry
(`"chat.artifacts."`), because a bare `chat.` prefix is deliberately unaudited. Add it in the commit that adds
the first such key.

---

## File ownership

| File | Change |
|---|---|
| `src/lib/shared/artifact-document/blocks.ts`, `patch.ts`, `anchor.ts` + `*.test.ts` | create (pure; server + browser) |
| `src/lib/server/services/artifacts/serialize/document.ts` + test | create; register in `serialize/index.ts` |
| `src/lib/server/services/artifacts/document-ops.ts` + test | create |
| `src/lib/server/services/artifacts/record.ts`, `versions.ts` | the additive `updateArtifactBody` fields; `restoreVersion` wiring |
| `src/lib/server/services/normal-chat-tools/artifacts.ts` + test | create; register in `normal-chat-tools/index.ts` |
| `src/lib/server/services/normal-chat-tools/index.ts` | register three tools + their guidance |
| `src/lib/server/services/conversation-detail/read-model.ts` | nothing structural — Documents arrive through Slice 0's `artifacts` list |
| `src/routes/api/artifacts/[id]/body/+server.ts`, `.../document/patches/+server.ts`, `.../versions/**`, `.../comments/**` + tests | create |
| `src/lib/client/api/artifacts.ts` + test | extend |
| `src/lib/components/artifacts/document/**` | create |
| `src/lib/components/artifacts/artifact-bodies.ts` | one line: the `document` loader |
| `src/lib/components/artifacts/ArtifactCard.svelte` + test | the Document preview body + the tickable checklist (spec §2.3) |
| `src/lib/components/chat/MessageArea.svelte`, `MessageList`/message row | the `Open as document` action on an assistant reply |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | the Document open path (via Slice 0's `openArtifact`) |
| `src/lib/i18n/artifacts.ts`, `src/lib/i18n/index.ts`, `src/lib/i18n.test-helpers.ts` | keys + prefixes |
| `package.json`, `package-lock.json` | `@tiptap/*` 3.31.3 (pinned, exact) |
| `scripts/eval-artifact-contracts/cases.ts`, `document.ts`, `README.md` | the document suite |
| `tests/e2e/artifact-document.spec.ts`, `tests/integration/artifact-document.test.ts` | create |

**Serialisation with the other slices.** `src/lib/components/artifacts/artifact-bodies.ts`,
`src/lib/i18n/artifacts.ts` and `ArtifactCard.svelte` are **append-only** across slices 1–4 (plan decision 21):
each slice adds its own loader line, its own key namespace and its own body branch, and touches nothing else in
those files. Do not reformat them.

**Two cross-slice reconcilations the owner has to rule on** (found after slices 3–6 were written; not silent
changes — both are two conventions for one thing):

1. **Where the pure shared modules live.** This slice puts the Document's under
   `src/lib/shared/artifact-document/` (`blocks.ts`, `patch.ts`, `anchor.ts`); slices 3–4 use
   `src/lib/shared/artifacts/` (`canvas.ts`, `slides.ts`, `comments.ts`, `sources.ts`) for the same kind of
   module. One directory is enough: `src/lib/shared/artifacts/` with `document.ts`/`blocks.ts` beside
   `canvas.ts` and `slides.ts` reads better and matches the two committed slices. Until it is ruled, keep the
   **directory** this slice names and note the divergence in the report rather than moving another slice's
   files.
2. **Comment anchoring is one resolver, not one per type.** Slice 3 keeps a shared
   `src/lib/shared/artifacts/comments.ts`; this slice puts anchoring in
   `src/lib/shared/artifact-document/anchor.ts`. §2.7 makes comments **one shared feature** across types, and
   the anchor kinds (`text` for Document, `node`/`point` for Canvas) already share one DTO and one
   `artifact_comments` table. The resolver therefore belongs in **one** shared module that both types call —
   split by anchor kind inside it if that helps, but not by artifact type. If slice 3's file already exists when
   this slice starts, **move the text-anchor scoring into it and delete the duplicate**; do not ship two
   scorers, because two scorers produce two "Moved" verdicts for the same edit.

---

## Tasks

### Task T1: The pure block model, and the mint-before-hash order

**Files:** `src/lib/shared/artifact-document/blocks.ts`, `blocks.test.ts`
**Interfaces:** `parseDocument`, `serializeDocument`, `normalizeMarkdown`, `fnv1aHex`, `mintBlockId`,
`countMarkers`, `buildIndex`, `DocumentBlock`, `ParsedDocument`

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
6. `normalizeMarkdown` is idempotent, collapses 3+ blank lines to 1, trims trailing spaces, and **stabilises
   table padding**: given the padded and the unpadded form of the same table, both normalise to the same string
   and therefore the same block hash. This is the test that keeps "your words win" from refusing everything.
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
`src/lib/server/services/normal-chat-tools/index.ts`
**Interfaces:** `create_artifact`, `read_artifact`, `edit_artifact` (schemas + runs)

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
7. The registered tool set on a turn that has artifacts enabled includes the three names, and a turn without them
   (the existing capability gate) does not.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement** the module and register it in
      `normal-chat-tools/index.ts` beside `produce_file`, with the usage guidance in the tool interface (ADR-0055)
      — the guidance says when a Document is the right shape, that patches are block-addressed with the hash from
      `read_artifact`, and that a refusal means re-read rather than retry.

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
`readMarkdown(editor)`

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
5. Round-trip stability: load Markdown → `readMarkdown` → parse → unchanged hashes for every block, **twice** in
   a row. This is the test that catches a Tiptap serialisation that shifts padding.
6. Markers survive: a document with 12 blocks loads, the user types one character in block 5, saves, and all 12
   ids are the same 12 ids.
7. **The local recorded figure** (`decisions.md` ruling 9): at the prototype's 5,691-word document, typing 200
   synthetic keystrokes averages under **2 ms per keystroke**, and the measured number goes in the slice report
   whatever it is. This is a recording, not a CI gate — the CI half of the budget is T1.9's structural
   assertion, so a slow machine never becomes an argument for loosening the product.
8. **Chunk:** the panel-shell module graph contains no `@tiptap`/`prosemirror` import — assert by reading the
   built chunk list, or by a source scan of the non-editor modules (whichever the repo already does for the
   existing lazy preview stack; follow that pattern).

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
`src/lib/client/api/artifacts.ts`, the `artifacts/[id]/comments/**` routes, the `@Alfy` service path

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
   The prototype's toolbar took 137 px — 29% of the viewport — and that is the regression this test exists for.
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

The prototype's single toolbar took 29% of a 390 px viewport, so the phone gets a
short row and a sheet, and both toolbars are built from one action list so an
action cannot exist on one and not the other."
```

### Task T12: Export through `produce_file`

**Files:** `DownloadSheet.svelte` + test, the export route/service call, `src/lib/client/api/artifacts.ts`,
`tests/e2e/artifact-document.spec.ts`

- [ ] **Step 1: Write the failing tests**

1. The sheet offers PDF, Word and Markdown and names the artifact ("Vienna, 10–12 October" → a file named after
   it), never the word Artifact.
2. PDF goes through the file-production intake with `sourceMode: "document_source"` and `requestedOutputs`
   (assert the persisted request, not the renderer's output), and the resulting File artifact appears in the same
   chat's panel list.
3. The source handed to the renderer is built from the parsed blocks and **contains no `<!--b:` markers** — a
   marker in a client-facing PDF is a bug, and this is the assertion that catches it.
4. Markdown export downloads the stored body; it does not create a job and does not consume a sandbox run.
5. A failed job surfaces `artifacts.document.export.failed` and offers retry through the existing File card
   affordance, not a new one.
6. Export of another user's artifact 404s.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**, reading
      `file-production/execution-adapter.ts` for the accepted document-source shape and
      **`src/lib/server/prompts.ts`** for the existing `produce_file` guidance wording
      (`decisions.md` ruling 5: the outbound text is there, consumed by `normal-chat-context.ts`; do not
      re-add it to the context module).

- [ ] **Step 4: Run**
      `npx vitest run src/lib/components/artifacts tests/integration && npx playwright test tests/e2e/artifact-document.spec.ts && npm run check`

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/artifacts src/lib/client/api/artifacts.ts src/lib/server/services/artifacts tests/e2e/artifact-document.spec.ts
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
| The mobile toolbar eating the viewport | The prototype's 29% regression | T11.1 asserts a hard height budget |
| Chunk budget unmeasured | "It is lazy" becomes an assumption | The Gates block requires the measured pair in the report, method named |
| The eval gate skipped or explained away | The only proof the protocol works with a real model | T13 step 4 runs it on the box and its result goes in the report; §8.1 makes a weak result a design change |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — green, including `tests/cross-cutting/**` (with **no** new `ALLOWED_WITHOUT_SCOPE` entry) and
      the artifacts suites.
- [ ] `npm run build` — 0 warnings, and the measured panel-shell / editor chunk pair recorded in the report with
      its method.
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
   them. If "tabs" was meant as something else, this is the decision to correct before T9.
6. **Export goes through `produce_file` with `sourceMode: "document_source"`**, and the markers are stripped
   before the source is built.
7. **`Open as document` links an assistant message to one Document** (idempotent per message), and the created
   document is the message's visible text.
8. **The mobile toolbar is a separate component** with a shared action list, not a responsive restyle of the
   desktop one.
9. **`@tiptap/*` is pinned to exactly 3.31.3.** Every stored document's hashes depend on its Markdown
   round-trip; a floating range would make a minor upgrade a data migration.
