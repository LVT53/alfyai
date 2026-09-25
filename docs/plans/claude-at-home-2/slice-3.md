# Slice 3 — Canvas: the artifact board inside the panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the `artifacts/` boundary, the panel shell,
> `ArtifactCard.svelte`, `artifact-bodies.ts`, the `artifact_versions` / `artifact_comments` / `artifact_kv`
> tables) and **shares the comment layer with Slice 1** (the Document type renders the same threads).

**Goal:** Make `Canvas` a real artifact type: a Svelte Flow board that lives in the artifact panel, carries
the chat's own block components as live nodes, owns its own drawing layer and comment pins, and accepts an
**id-addressed BoardDiff** from Alfy that the user watches land.

**Architecture:** One lazy-loaded panel editor, `CanvasEditor.svelte`, mounted by the artifact panel when the
open artifact's type is `canvas`. All board logic lives in plain modules under
`src/lib/components/artifacts/canvas/_lib/` (pure functions over JSON, unit-testable without a browser);
the Svelte components are thin. The board body is JSON in `artifacts.content_text`; **comments are not in
the body** — they are `artifact_comments` rows, the one shared comment feature (§2.7, ruling 1). Frames are
real Svelte Flow group nodes, but **reparenting is app-level**: Svelte Flow does not adopt a node dragged
over a group, so this slice does the hit test and rewrites `parentId` itself. The drawing layer and the
comment pins both render through `<ViewportPortal target="front">` and both size their pointer-capturing
surface from the **visible pane** (`pane-rect.ts`), never from the board's box. Every write — a stroke, a
reparent, a tick, a BoardDiff — becomes one `artifact_versions` row through Slice 0's record boundary; the
Canvas has exactly two HTTP write routes (the shared op route and the shared body route).

**Tech Stack:** SvelteKit + Svelte 5 runes, `@xyflow/svelte` 1.7.0, `perfect-freehand`, `html-to-image`,
Chart.js 4.5.1 (already a dependency), MapLibre 6.7.0 (already a dependency), `@lucide/svelte`, Vitest,
Playwright.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decisions 12–14, 15, 16), §3 (the record),
§5 (panel/card/sandbox/export), §6 (Slice 3), §7 (perf budget). Rulings that bind this slice:
`decisions.md` **1** (comments are never in a body), **9** (the perf gate is split), **11** (one comment
layer: shared interface, per-type anchor resolvers), **12** (canonical hashing pinned by a test). Decisive
ADRs: [ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family, "Artifact" is never
shown in the UI), [ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Mockups: `claude-at-home-2-artifact-types-mockups.html` §1 (Canvas),
`claude-at-home-2-artifact-surfaces-mockups.html` §2 (the panel's list) and §3 (one artifact open).
Reference implementation (read it, do not copy it): `src/routes/prototype/canvas/` on the throwaway branch
`proto/artifact-canvas` (present in-tree as `git branch -a`, alongside `proto/artifact-apps-quality`,
`proto/artifact-document-editor`, `proto/artifact-document-editor-r2`) — see **Prototype pointers** at the
end of Contracts for the file-and-function map.

## Global Constraints

Same as `plan.md` §Global Constraints. In addition, for this slice:

- **Svelte 5 runes only.** `$props()`, `$state`, `$derived`, callback props (no `createEventDispatcher`),
  `onclick` not `on:click`, `{@render}` not `<slot>`. Existing legacy syntax elsewhere is migration debt,
  not a pattern.
- **Lucide icons only** (`@lucide/svelte`). No hand-written `<svg>` for icons. The board's dot grid is
  Svelte Flow's `<Background>`, not an icon. Annotation shapes are data-visualisation SVG, which AGENTS.md
  exempts.
- **Tokens only** from `src/app.css`. The four sticky-note fills and the map-paper tint are **new tokens**
  (see Task T2) — do not inline hex in node components.
- **EN + HU in the same commit**, both dictionaries, for every user-visible string including `aria-label`s.
  `src/lib/i18n/artifacts.ts` is created by Slice 0 with the module in `I18N_MODULES` and `"artifacts."` in
  `AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts:7-15`, `16+`; `plan.md` §Slice order, dependencies and
  parallelism) — this slice **appends**, it does not re-register.
- **"Artifact" never appears in the UI.** The type is called **Canvas** (HU: **Tábla**), per ADR-0066.
- **One user, permanently.** No sharing, no permissions, no presence, no co-editing affordances. Do not
  leave a "share" stub.
- **Every read and write is ownership-checked server-side** through the Slice 0 record boundary. The client
  never sends a `userId`.
- **Incognito:** a Canvas created in an incognito conversation is contained exactly like every other
  artifact — no listing in the Knowledge library, no retrieval by a later normal conversation, no
  `artifact_kv` readable from outside. See Task T9.
- **The board body round-trips through `content_text` only.** No side tables for strokes, blocks, or
  posters.
- **No schema change in this slice.** Every row a Canvas writes is a row Slice 0 created —
  `artifacts`, `artifact_versions`, `artifact_comments`. There is therefore **no `drizzle/0NNN_*.sql` file
  and no `_journal.json` entry in this slice**, and `npm run check:migrations` must be unchanged. If an
  implementer finds themselves needing a column, that is a Slice 0 defect to report, not a migration to add
  here. (For reference, Slice 0's migration is `drizzle/1777140000111_artifacts_spine.sql`, journal idx
  124; verified in-tree, the last existing entry is `1777140000110_drop_home_suggestion_events`
  (`_journal.json` idx 123), so the next free number is indeed `1777140000111`.)
- **Exactly these package versions, and no others:** `@xyflow/svelte` 1.7.0, `@xyflow/system` 0.0.83 (MIT),
  `perfect-freehand` (MIT), `html-to-image` 1.11.11 (MIT), `chart.js` 4.5.1 (MIT, already present),
  `maplibre-gl` 6.7.0 (BSD-3, already present), `@lucide/svelte` 1.17.0 (ISC). A different version needs a
  note in the slice's PR body explaining why the measured numbers still hold.
- **Never code Svelte Flow from React Flow memory.** Caveat 2 of the prototype findings is that v1 differs
  in ways that fail *silently*; every one of those differences is written into Contracts below.
- **`npm run check` stays at 0 errors, 0 warnings; `npm run build` emits 0 warnings.**

## Gates

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run check && npx biome check src scripts tests && npm test && npm run build
npm run check:migrations
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-canvas.spec.ts tests/e2e/artifact-canvas-perf.spec.ts \
  tests/e2e/artifact-canvas-mobile.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts \
  tests/e2e/incognito-indicator.spec.ts
```

**The perf gate is split (ruling 9), and the two halves mean different things:**

- **CI asserts structural budgets only** — board JSON size, node and stroke counts, pad hit-coverage, chunk
  sizes, and a *timing ceiling with a generous margin*. These are deterministic and machine-independent. A
  failing CI check means the change grew the board, the bundle, or the overlay geometry.
- **The 60 fps figure is a local, recorded measurement**, printed into the PR body, not asserted against on
  a shared runner. `tests/e2e/artifact-canvas-perf.spec.ts` computes it and *reports* it; the prototype's
  `_probe.mjs` is the reference for the sweep (163 nodes + 202 annotations at 8.3 ms average frame).
- A failing CI perf check is therefore **never** fixed by loosening the 60 fps number. Raising the floor, or
  moving the fps job to a dedicated runner, is an owner decision (Open question 3).

## Review Focus

1. **Every pointer-capturing overlay is sized from the pane, not the board (Task T4).** This is the trap
   the prototype measured: `inset: 0` inside `<ViewportPortal>` means "as big as the nodes", and on a
   163-node board at fit view that covered **6 of 144** sample points, so the board silently stopped being
   drawable once the camera zoomed out. The behaviour test is a hit-coverage count (≥ 95 % of sample points
   across the pane), not a visual check.
2. **A node dragged over a frame actually reparents, and a node dragged out leaves it (Task T3).** Svelte
   Flow moves a child with its parent and honours `parentId`, but never adopts. The handler must be on the
   lowercase `onnodedragstop`: `onnodeDragStop` is accepted as an unknown prop and silently does nothing.
3. **One handle drag produces exactly one edge (Task T3).** `@xyflow/svelte` v1 calls `addEdge` itself and
   then fires `onconnect` as a *notification*. Stamping the id in `onconnect` the React Flow way yields two
   parallel edges.
4. **The drawing layer and the comment pins are visible above frame children (Task T4, Task T5).** Frame
   children carry `z-index: 1`; both portal layers need an explicit `z-index: 2`. With `auto` the symptom
   is a pen that drags the node under it instead of drawing.
5. **A board with an App or map block exports as its poster, and says so (Task T7).** A `foreignObject`
   clone has no frame document, so without posters the PNG ships an empty box and nobody notices. The
   export result must name every block that fell back.
6. **A block that is reused is reused unchanged, and a block that cannot be is owned by the canvas (Task
   T2).** `chat/Checklist.svelte` is **read-only by owner decision** — its header says so, its checkbox is
   `disabled` (`src/lib/components/chat/Checklist.svelte:2-6,31`) and `Checklist.test.ts:6,28,39` pins that
   with `expect(box.disabled).toBe(true)`. The canvas therefore ships its **own** tickable checklist node;
   it does not "reuse the chat's checklist unchanged" and it does not gain an `editable` prop. Chart and
   map *are* reused unchanged. Getting this backwards either ships a board whose ticks do nothing, or
   quietly turns the assistant's reply into an editable form.
7. **Two writers, one board (Task T6).** A chat turn and the open panel can both write; every write carries
   `expectVersion` (body) or `baseVersionId` (ops) and a stale one is refused with a 409 rather than
   clobbering. The refusal string is the one Slice 1 already ships
   (`artifacts.document.versions.conflict`, `slice-1.md §i18n`).

---

## Contracts

### Packages

| Package | Version | Licence | Why |
|---|---|---|---|
| `@xyflow/svelte` | 1.7.0 | MIT | the board itself (pan, zoom, groups, handles, `ViewportPortal`) |
| `@xyflow/system` | 0.0.83 | MIT | transitive peer of the above; pin it explicitly so a minor bump cannot drift |
| `perfect-freehand` | latest at pin time | MIT | velocity-thinned pen outline |
| `html-to-image` | 1.11.11 | MIT | the PNG export |
| `chart.js` | 4.5.1 | MIT | already present — the Chart block reuses `Chart.svelte` |
| `maplibre-gl` | 6.7.0 | BSD-3 | already present — the map block reuses `MapRouteCard.svelte` |
| `@lucide/svelte` | 1.17.0 | ISC | every icon |

`@xyflow/svelte` is BSD-free and MIT; there is no copyleft in this list. Add them to `package.json`
`dependencies` (not `devDependencies`) and commit `package-lock.json` in the same commit. None of
`@xyflow/svelte`, `@xyflow/system`, `perfect-freehand` or `html-to-image` is in `package.json` today
(verified: `grep -n "xyflow\|freehand\|html-to-image" package.json` is empty).

### Schema: what this slice writes, and the one DDL it does not own

No migration. The Canvas writes rows in Slice 0's three tables and nothing else:

| Table | Slice 0's DDL (`slice-0.md §The migration`) | What the Canvas adds |
|---|---|---|
| `artifacts` (the existing table, unchanged) | `id`, `user_id`, `conversation_id`, `type`, `retrieval_class`, `name`, `mime_type`, `extension`, `size_bytes`, `binary_hash`, `storage_path`, `content_text`, `summary`, `metadata_json`, `created_at`, `updated_at` — the real columns; there is no `kind`, no `title` and no `is_incognito` | `type = 'artifact'` with `metadata_json.artifactType = 'canvas'` as the kind's single source of truth, the title in `metadata_json.title` (the row's `name` is what it renders from), and `content_text` = the body JSON below. Incognito is a property of the **conversation**, never of this row (`slice-0.md §The boundary`) |
| `artifact_versions` | `id`, `artifact_id`, `user_id`, `version_number`, `author`, `summary`, `body`, `body_hash`, `created_at` | one row per committed write (stroke batch, reparent, tick, BoardDiff) |
| `artifact_comments` | `id`, `artifact_id`, `user_id`, `anchor_json`, `body`, `parent_id`, `author`, `status`, `created_at` | `anchor_json` carrying `{kind:"node"}` / `{kind:"point"}` |

`body_hash` on a canvas version is **the canonical-JSON hash of the body** (next section), and
`artifact.updated_at` moves in the same transaction (`slice-0.md §The boundary`).

### The Canvas body

`artifacts.content_text` holds this JSON, and nothing else about the board:

```ts
// src/lib/shared/artifacts/canvas.ts — client-safe, no server imports.
import type { ToolCallMapData } from "$lib/server/services/messages-types"; // type-only, erased at build
import type { ArtifactSource } from "$lib/shared/artifacts/sources";

export type Pt = { x: number; y: number };

export type StickyTone = "yellow" | "mint" | "blue" | "plain";

/** A poster is a generated PNG file, produced by the existing chat-files storage. */
export type PosterRef = {
	fileId: string; // /api/chat/files/{fileId}/preview and /download
	width: number;
	height: number;
	capturedAt: number;
};

export type CanvasBlockData =
	| { kind: "frame"; label: string; width: number; height: number }
	| { kind: "sticky"; text: string; tone: StickyTone }
	| { kind: "text"; text: string }
	| { kind: "chart"; label?: string; subtitle?: string; code: string }
	| {
			kind: "checklist";
			label?: string;
			items: { id: string; text: string; done: boolean }[];
	  }
	| {
			kind: "map";
			label?: string;
			route: string;
			meta?: string;
			map: ToolCallMapData; // the existing shape MapRouteCard.svelte eats
			poster?: PosterRef;
	  }
	| {
			kind: "file";
			fileId: string;
			name: string;
			mime: string;
			bytes: number;
			label: string; // display type, e.g. "PDF"
	  }
	| { kind: "app"; artifactId: string; title: string; poster?: PosterRef }
	| {
			kind: "photo";
			items: { id: string; imageUrl: string; alt?: string }[];
			poster?: PosterRef;
	  }
	| {
			kind: "liveweb";
			query: string;
			sources: ArtifactSource[];
			fetchedAt: number;
			poster?: PosterRef;
	  };

export type StoredCanvasNode = {
	id: string;
	type: CanvasBlockData["kind"];
	position: Pt;
	/** Set only when the node lives inside a frame. Always frame-relative. */
	parentId?: string;
	width?: number;
	height?: number;
	data: CanvasBlockData;
};

/**
 * A node as the board holds it: Svelte Flow writes `measured`, `selected` and
 * `dragging` back onto the object it was handed, and `zIndex`/`extent` are
 * library fields we set. The live object is therefore a superset of the stored
 * one, and `boardJson` is what narrows it back.
 */
export type CanvasNode = StoredCanvasNode & {
	measured?: { width: number; height: number };
	selected?: boolean;
	dragging?: boolean;
	zIndex?: number;
	extent?: "parent" | [[number, number], [number, number]] | undefined;
	highlight?: boolean;
};

export type CanvasEdge = {
	id: string;
	source: string;
	target: string;
	label?: string;
};

export type AnnotationKind = "pen" | "highlighter" | "line" | "arrow" | "rect" | "ellipse" | "text";

export type Annotation = {
	id: string;
	kind: AnnotationKind;
	color: string;
	size: number;
	points?: Pt[]; // pen | highlighter
	from?: Pt; // line | arrow | rect | ellipse
	to?: Pt;
	at?: Pt; // text
	text?: string;
};

export type CanvasBody = {
	/** Bumped only by a migration in the serialize module; readers tolerate older. */
	version: 1;
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	viewport: { x: number; y: number; zoom: number };
	annotations: Annotation[];
};
```

**The body deliberately does NOT hold comments** (ruling 1, which corrects spec §3's body list). Comments,
versions and per-App key-value state are rows keyed by `artifact_id`; the body carries only what the
artifact *is*. A board that stored its own comment list would give the shared layer a second source of
truth, and §2.7 already makes comments one shared feature. There is nothing left to ask here — the ruling
settled it; Open question 1 was withdrawn.

`ArtifactSource` is the existing web-grounding source shape
(`src/lib/server/services/web-grounding.ts:10-20`, `GroundedWebPayloadSource`) consumed client-side through
the read model; Slice 5 owns its evidence wiring. If Slice 5 is not merged yet, declare
`src/lib/shared/artifacts/sources.ts` as a **re-export** of the server type's shape (a type-only alias, not
a second shape) and let Slice 5 move it — do not invent a parallel source shape (see Risks). `ToolCallMapData`
likewise is imported type-only from `$lib/server/services/messages-types` (`messages-types.ts:144`), which
is already what `MapRouteCard.svelte:23` does — no new client-visible map type.

### Canonical body JSON and the body hash (ruling 12)

Ruling 12 requires **one canonical form** used for hashing, pinned by a test proving that a no-edit round
trip produces an identical hash. For a JSON body that means stable key order and no volatile fields.

```ts
// src/lib/components/artifacts/canvas/_lib/board.ts
/** The canonical JSON: stable key order, volatile library fields dropped. */
export function boardJson(body: CanvasBody): string;

// src/lib/server/services/artifacts/serialize/canvas.ts
import { createHash } from "node:crypto";

/** sha256 of the canonical JSON, hex. Same rule as the Document's block hashes:
 *  it is computed on the CANONICAL form, never on whatever the client sent. */
export function canvasBodyHash(canonicalJson: string): string {
	return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
```

`boardJson` is the single canonicaliser and it is **not** `JSON.stringify(body)`:

- Keys are emitted in the fixed order `version, nodes, edges, viewport, annotations`; a node is emitted as
  `id, type, position, parentId, width, height, data`; an annotation as
  `id, kind, color, size, points, from, to, at, text`; a node's `data` with the registry row's own key order
  (so a `zod` parse → spread cannot reorder it).
- Volatile library fields (`measured`, `selected`, `dragging`, `zIndex`, `extent`, `highlight`) are dropped.
- Optional fields that are `undefined` are omitted, never emitted as `null`; an empty `annotations` array is
  emitted as `[]`, not omitted.
- Numbers are finite and rounded to 3 decimal places (`Math.round(n * 1000) / 1000`) so a pointer-derived
  `x: 412.00000000000006` and a reloaded `x: 412` hash the same.
- `viewport` is **included**, because the camera is part of the body. A pure pan therefore *does* change the
  body — which is why a pan is not saved by itself (below) and why the client compares `boardJson` output,
  not object identity, before deciding a save is needed.

**Ruling 12's test, verbatim on this slice:**

```ts
// src/lib/components/artifacts/canvas/_lib/board.test.ts
it("open → boardJson → normalizeCanvasBody → boardJson produces an identical body hash with no user edit", () => {
	const once = boardJson(normalizeCanvasBody(sampleBody).body);
	const twice = boardJson(normalizeCanvasBody(JSON.parse(once)).body);
	expect(canvasBodyHash(twice)).toBe(canvasBodyHash(once));
});
it("hashes the same body identically when a node's fields were reordered by the library", () => {
	// Svelte Flow writes measured/selected back onto the live node; the stored JSON must not move.
});
it("rounds a float-noise position to the same hash as its rounded twin", () => {
	expect(boardJson(withX(412.00000000000006))).toBe(boardJson(withX(412)));
});
```

**A pan is not a save.** Only a gesture that changes a node position, the node/edge set, or the annotations
commits a version. The camera rides along in the committed body, so the next open restores it, but a bare
pan leaves the stored `viewport` alone until the next real commit; the editor writes the camera into its
in-memory body and lets `dirty` stay false. (Without this rule, a board would mint a version every time the
user looked around it, and versions are the board's undo.)

### The block registry

`src/lib/components/artifacts/canvas/_lib/block-registry.ts` is the **one** place kind → component +
validator + default size + poster policy lives. Adding a block kind must not edit the board component.

```ts
import type { Component } from "svelte";
import { z } from "zod";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas";

export type BlockKind = CanvasBlockData["kind"];

export type BlockRegistryEntry = {
	kind: BlockKind;
	/** The Svelte component that renders the node body. */
	component: Component<{ data: CanvasBlockData; selected: boolean; dark: boolean }>;
	/** Lucide icon for the node shell header and the Insert menu. */
	icon: Component;
	/** Insert-menu label key, e.g. "artifacts.canvas.insert.chart". */
	labelKey: string;
	/** Default board size in board units. */
	size: { width: number; height: number };
	/** Insert-menu section: "blocks" for chat-derived, "text" for note-shaped. */
	section: "text" | "blocks";
	/** Needs a poster in export/offline (App, map, photo, liveweb). */
	needsPoster: boolean;
	/** Validates node data arriving from a stored body or a BoardDiff. */
	schema: z.ZodType<CanvasBlockData>;
	/** True when the node must not be a frame child. */
	structural?: boolean;
};

export const BLOCK_REGISTRY: Record<BlockKind, BlockRegistryEntry>;
export function blockEntry(kind: string): BlockRegistryEntry | null;
/** The default data a freshly-inserted node of this kind gets. */
export function defaultDataFor(kind: BlockKind): CanvasBlockData;
```

Registry rows for this slice, and what each node reuses — **the "reuses" column is a promise about the
import graph, and every claim in it is against a verified `path:line`:**

| kind | reuses | needsPoster | notes |
|---|---|---|---|
| `frame` | — | no | group node; `zIndex: -1`; `dragHandle` is the frame label bar |
| `sticky` | — | no | inline-editable text; the only free-text block |
| `text` | — | no | inline-editable, no chrome |
| `chart` | `chat/Chart.svelte` **unchanged** | no | props are `{ code?: string }` (`src/lib/components/chat/Chart.svelte:19`); the node passes `code` exactly as the chat does |
| `checklist` | **canvas-owned** (see below) | no | tickable; ticks commit through the board's own save |
| `map` | `chat/MapRouteCard.svelte` **unchanged** | **yes** | props are `{ map, highlightRange?, focusRange? }` (`src/lib/components/chat/MapRouteCard.svelte:27-31`); the component already carries an inline-SVG fallback for the WebGL-unavailable and print cases (its header comment), which is the offline shape |
| `file` | `FileTypeIcon.svelte` + the shared viewer | no | compact row; clicking opens the shared preview, never an inline heavy renderer |
| `app` | Slice 2's sandbox route in `<iframe sandbox="allow-scripts">` | **yes** | `nodrag` + `nowheel` on the frame |
| `photo` | `chat/ImageLightbox.svelte` | **yes** | props are `{ images, index, onClose, onNavigate }` (`src/lib/components/chat/ImageLightbox.svelte`); it is a **body-portalled full-view overlay**, not an in-node gallery, so the node shows a thumbnail grid and the lightbox opens on click. `imageUrl` values are the existing authed `/api/connections/immich/thumbnail/[assetId]?connectionId=` proxy URLs (`src/routes/api/connections/immich/thumbnail/[assetId]/+server.ts`) |
| `liveweb` | the existing evidence/source list rendering | **yes** | stores a snapshot; refresh re-runs the read |

**The `checklist` row is the one block that is NOT a reuse, and the reason is a measured contradiction.**
`chat/Checklist.svelte` renders GFM task items as **read-only** checkboxes: its header states the decision
("deliberately NOT interactive … an editable tick that silently resets on refresh is a false affordance") and
the input carries `disabled` (`src/lib/components/chat/Checklist.svelte:2-6,31`). `Checklist.test.ts:6` is
literally named *"renders GFM task items as READ-ONLY checkboxes"* and `Checklist.test.ts:28,39` assert
`box.disabled === true`. The mockup's legend line 3 for the Canvas — "Blocks are live. … and ticks save" —
is therefore describing behaviour the shared component cannot provide. Resolution, and the only one that
keeps both promises:

- The canvas ships **`nodes/ChecklistNode.svelte`**, its own component, with its own props
  (`{ data, selected, dark }` like every other node body).
- Its **data shape is the registry's** (`items: { id, text, done }[]`) and its own item editor, so a board
  tick appends to the node's data and commits with the board — it never resets on refresh, which was the
  original objection.
- `chat/Checklist.svelte` is **not touched**. No `editable` prop, no `onToggle`, no callback. The chat's
  reply stays a reply.
- The item shape difference is real and must be handled in the node, not papered over: the chat's
  `ChecklistItem` is `{ checked: boolean; task: boolean; html: string }`
  (`src/lib/components/chat/Checklist.svelte:11`) with `html` block-level markdown; the canvas's is
  `{ id, text, done }` with plain text. The canvas node renders plain text (a board note is not markdown),
  and the board↔chat projection, if one is ever wanted, belongs in Slice 5's tool, not in either component.
- `artifacts.canvas.checklistReadOnlyNote` is shown once in the node's meta line so the difference from the
  chat is visible rather than surprising: on the board, a tick is a saved edit.

**Reuse, do not fork, for everything else:** the Chart and map nodes must pass the same props the chat passes
and must not gain canvas-only props. If a block needs a canvas-only behaviour (no chrome, no delete button),
that lives in the **node shell**, not in the reused component. If a reused component turns out to need a
change, the change lands in the shared component and both callers are tested — never a canvas-local copy.

### The shared comment interface (ruling 11)

Ruling 11 splits the comment feature: threads/status/replies/`@Alfy` live in Slice 0's server service; the
**anchor interface** is one small shared type, implemented **per type**. This slice owns that interface file
plus the canvas resolver; the Document implements the same interface with its own `text` resolver. Neither
reimplements the other.

```ts
// src/lib/shared/artifacts/comments.ts — created here, consumed by Slice 1.
export type CommentAnchor =
	| { kind: "text"; blockId: string; quote: string; prefix?: string; suffix?: string }
	| { kind: "node"; nodeId: string }
	| { kind: "point"; x: number; y: number };

/** The three outcomes of resolving an anchor against a body. Exactly three. */
export type AnchorResolution =
	| { state: "exact" }
	| { state: "moved"; detail?: string }
	| { state: "orphaned"; reason: "block_missing" | "node_missing" };

/** One resolver per artifact type. Pure: body in, resolution out, no I/O. */
export type AnchorResolver = {
	/** Which anchor kinds this type can resolve; a kind outside the list is refused at intake. */
	readonly kinds: readonly CommentAnchor["kind"][];
	resolve(anchor: CommentAnchor, body: string | null): AnchorResolution;
};

export type CommentThreadReply = { id: string; author: "user" | "alfy"; body: string; at: number };

export type CommentThread = {
	id: string;
	anchor: CommentAnchor;
	author: "user" | "alfy";
	body: string;
	replies: CommentThreadReply[];
	status: "open" | "resolved";
	createdAt: number;
};
```

This is the **client-side projection** of `artifact_comments` rows (Slice 0 owns the table and the service).
The column names and the mapping are Slice 0's; this slice must not open its own queries against
`artifact_comments`.

The canvas resolver, in `_lib/comments.ts`:

```ts
// src/lib/components/artifacts/canvas/_lib/comments.ts
import type { AnchorResolution, CommentAnchor, CommentThread } from "$lib/shared/artifacts/comments";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";

export const canvasAnchorResolver: AnchorResolver; // kinds: ["node", "point"]

/** The board-space point a thread's pin sits at: the node's top-right corner,
 *  or the raw point. Null when the anchor is orphaned (no pin is drawn). */
export function pinAt(thread: CommentThread, nodes: readonly CanvasNode[]): Pt | null;

/** `resolve()` for the pin layer: a node anchor whose node was deleted is
 *  orphaned, not wrong. Orphaned threads stay in the list, dimmed, with the
 *  "the block is gone" row; the pin is not drawn. */
export function isOrphaned(thread: CommentThread, nodes: readonly CanvasNode[]): boolean;

export function pinLabel(threads: readonly CommentThread[], id: string): string;
export function threadSummary(threads: readonly CommentThread[]): string;
export function mentionsAlfy(body: string): boolean;
```

Both resolvers are pure and unit-tested against the same three outcomes, including the orphan: the canvas
suite asserts `exact` (node present), `moved` (a `point` anchor, which is never invalidated by a board edit),
and `orphaned` (node deleted); Slice 1's suite does the same for `text` anchors. `isOrphaned` is a
one-line wrapper over `resolve()` returning `state === "orphaned"` — it exists because the pin layer reads
it per render and allocating a discriminated union there is noise.

### The board `_lib` modules (exact signatures)

`src/lib/components/artifacts/canvas/_lib/pane-rect.ts`

```ts
export type PaneSize = { width: number; height: number };
export type ViewportLike = { x: number; y: number; zoom: number };
export type Rect = { left: number; top: number; width: number; height: number };

/**
 * The board-space rectangle the pane is showing, inflated by `margin` board
 * units. The transform on the viewport is `translate(x, y) scale(zoom)` with
 * `transform-origin: 0 0`, and the viewport element is `inset: 0` of the pane,
 * so the visible board rect is `[-pan/zoom, (-pan + paneSize)/zoom]`.
 * Returns an all-zero rect when the pane has not been measured yet, and the
 * caller falls back to `inset: 0` in that case — a 1x1 box in the middle of
 * nowhere is worse.
 */
export function visibleBoardRect(pane: PaneSize, viewport: ViewportLike, margin?: number): Rect;
```

`src/lib/components/artifacts/canvas/_lib/board.ts`

```ts
export const NODE_WIDTH = 190;
export const DEFAULT_NODE_HEIGHT = 84;

export function emptyCanvasBody(): CanvasBody;

/** Validates and normalises a stored body. Never throws: a body that is a
 *  version behind, or hand-edited, is the normal case. Drops what it cannot
 *  read (unknown node kinds, edges pointing at missing nodes, orphan children
 *  whose parent is gone, duplicate ids) and reports what it dropped. */
export function normalizeCanvasBody(raw: unknown): {
	body: CanvasBody;
	dropped: { nodes: string[]; edges: string[]; annotations: string[] };
};

/** The canonical persisted JSON (see "Canonical body JSON"). */
export function boardJson(body: CanvasBody): string;

/** Frame-relative → board-absolute, walking the parent chain. */
export function absoluteOf(node: CanvasNode, all: readonly CanvasNode[]): Pt;

/** The frame's board-space rect (frames are always top-level). */
export function frameRect(frame: CanvasNode): { x: number; y: number; width: number; height: number };

export function nodeRect(node: CanvasNode, measured?: { width: number; height: number }): {
	x: number;
	y: number;
	width: number;
	height: number;
};

/** The frame whose rect contains `p`, innermost first, excluding `exceptId`. */
export function frameAt(p: Pt, all: readonly CanvasNode[], exceptId?: string): CanvasNode | null;

/** The pure half of reparenting (Task T3): the hit test and the new geometry,
 *  with no Svelte Flow call in it. Null means "nothing to do — do not touch the
 *  node", which is what keeps a nudge inside a frame from being rewritten. */
export function reparentOnDrop(
	node: CanvasNode,
	all: readonly CanvasNode[],
	measured?: { width: number; height: number },
): { parentId?: string; position: Pt; extent: undefined } | null;
```

`src/lib/shared/artifacts/board-ops.ts` — the Canvas **vocabulary** (ruling 14), and the one file in this
contract that is not a `_lib` module. It sits in `src/lib/shared/artifacts/` because the server validates with
it: the generic mechanism is `src/lib/shared/artifacts/ops.ts`, created by this slice, and Slice 4's
`deck-ops.ts` is its twin.

```ts
import { z } from "zod";

export type BoardOp =
	| {
			op: "add_frame";
			id: string;
			label: string;
			position: Pt;
			size: { width: number; height: number };
	  }
	| { op: "add_node"; node: { id: string; type: string; parentId?: string; position: Pt; data: unknown } }
	| { op: "move"; id: string; to: Pt }
	| { op: "add_edge"; edge: { id: string; source: string; target: string; label?: string } }
	| { op: "remove_edge"; id: string }
	| { op: "update_node"; id: string; data: Record<string, unknown> }
	| { op: "remove_node"; id: string }
	| { op: "highlight"; ids: string[] };

export type BoardDiff = { id: string; summary: string; ops: BoardOp[] };

export const MAX_OPS_PER_DIFF = 40;
export const MAX_NEW_NODES_PER_DIFF = 24;

export const boardDiffSchema: z.ZodType<BoardDiff>;

/**
 * Server-side validation. Ids are addresses, not hints: an op touching an id
 * the board does not have (and the same batch did not create) is REFUSED, never
 * guessed. Returns the ops that apply, in order, plus one refusal per rejected
 * op so the model can react.
 */
export function validateBoardDiff(
	diff: BoardDiff,
	body: CanvasBody,
): { accepted: BoardOp[]; refused: { index: number; op: string; reason: BoardRefusalReason }[] };

export type BoardRefusalReason =
	| "unknown_id"
	| "duplicate_id"
	| "unknown_kind"
	| "kind_mismatch"
	| "missing_parent"
	| "self_parent"
	| "cycle"
	| "invalid_data"
	| "limit_exceeded";

/** Every refusal reason has a message key; the switch is exhaustive so a new
 *  reason cannot ship without one. */
export function refusalLabelKey(reason: BoardRefusalReason): string;

/** Everything except the position moves (those are tweened). */
export function structuralOps(diff: BoardDiff): BoardOp[];
export function moveOps(diff: BoardDiff): { id: string; to: Pt }[];
export function highlightedIds(diff: BoardDiff): string[];

/** One accepted op → the mutated board. Pure; the caller assigns. */
export function applyOp(body: CanvasBody, op: BoardOp): CanvasBody;
```

**Validation rules, in this order** (each failure is `refused`, and the rest of the batch still applies —
a partially-applied batch must still be a coherent board):

1. `diff.ops.length > MAX_OPS_PER_DIFF` → the whole diff is refused with `limit_exceeded` (a runaway batch
   is not partly applied).
2. `duplicate_id` — two ops in the batch creating the same id, or creating an id the board already has.
3. `unknown_id` — `move` / `remove_node` / `remove_edge` / `update_node` / `highlight` / `add_edge`
   source-or-target naming an id the board has and the batch does not create.
4. `unknown_kind` — `add_node.type` is not a `BlockKind`.
5. `kind_mismatch` — `update_node.data.kind` present and different from the stored `data.kind`. A block
   never changes kind in place; that is a remove + add.
6. `invalid_data` — the registry entry's `schema` rejects the merged data.
7. `missing_parent` — `add_node.parentId` names neither an existing frame nor a frame the batch creates
   **earlier in the op list** (parents before children).
8. `self_parent`, `cycle` — a frame cannot be its own parent or the child of its own descendant.
9. `limit_exceeded` — the resulting board would exceed `MAX_NODES_PER_BOARD` (400) or
   `MAX_BODY_BYTES` (1 MiB), or the batch creates more than `MAX_NEW_NODES_PER_DIFF` (24) nodes.

`add_frame` is sugar for `add_node` with `type: "frame"`; both are kept because the prototype's model
emitted `add_frame` and the eval suite (Slice 5) scores that vocabulary.

`src/lib/components/artifacts/canvas/_lib/annotations.ts`

Carries over from the prototype with these exported names and their behaviour unchanged:
`Annotation`, `AnnotationKind`, `Tool` (the 7 shapes plus `"select" | "pan" | "eraser" | "comment"`),
`DRAWING_TOOLS`, `isDrawingTool`, `INKS` / `DEFAULT_INK`, `baseSize`, `strokePath` (`getStroke` with
`simulatePressure: true`, `streamline: 0.5`, plus the capsule fallback for a stroke too short for an
outline), `dabPath`, `arrowHead`, `normRect`, `textWidth`, `annotationBounds`, `hitTest`, `translate`,
`pickAnnotation`, `normalizeAnnotations`, `describeAnnotation`.

Changes from the prototype, and only these:

- `nextId` moves to a shared `newId(prefix)` in `_lib/ids.ts` so annotations, nodes and pin replies mint
  ids the same way (`${prefix}-${base36 time}-${counter}`).
- `INK_BLUE` becomes the **token** `--artifact-ink-blue` read at render time; the constant stays as the
  fallback the export probe compares against. (The PNG scan reads the exported bitmap; a token that resolves
  to the same value on both themes is what keeps that assertion stable. The four inks are blue `#2f6fd0`,
  red `#c0392b`, green `#2f8f5b`, graphite `#59636e`; the blue is the probe's marker — do not change it
  without updating the e2e.)
- `normalizeAnnotations` gains a cap: at most `MAX_ANNOTATIONS_PER_BOARD` (600) and at most
  `MAX_POINTS_PER_STROKE` (1200, decimating by distance, not by index).

`src/lib/components/artifacts/canvas/_lib/poster.ts`

```ts
export const POSTER_WIDTH = 640;
export const POSTER_HEIGHT = 400;

/** True when this block cannot be reproduced by a foreignObject clone. */
export function needsPoster(kind: BlockKind): boolean;

/** What the export draws in place of a missing poster: a legible card naming
 *  the block and saying the live version is not in the image. */
export function posterPlaceholder(data: CanvasBlockData): { title: string; subtitle: string };

/**
 * Captures the live DOM of one node into a PosterRef, uploads it through the
 * canvas export route and returns the stored ref. Called by the panel when a
 * poster-needing block first mounts (debounced), when its data changes, and
 * once more before an export that finds a missing poster.
 */
export function capturePoster(node: CanvasNode, element: HTMLElement): Promise<PosterRef>;
```

`src/lib/components/artifacts/canvas/_lib/export-png.ts`

```ts
export type CanvasExportResult = {
	fileId: string;
	width: number;
	height: number;
	/** Blocks drawn as their placeholder because no poster existed. */
	missingPosters: { nodeId: string; title: string }[];
};

export async function exportBoardPng(input: {
	body: CanvasBody;
	/** The element to clone: the board's `.svelte-flow__viewport`. */
	viewportEl: HTMLElement;
	/** Svelte Flow's camera access, so the function can set and restore it. */
	setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => Promise<void>;
	getViewport: () => { x: number; y: number; zoom: number };
	/** Replaces the live node subtree with its poster before the clone. */
	mountPosters: (missing: string[]) => Promise<void>;
	unmountPosters: () => void;
}): Promise<CanvasExportResult>;
```

`src/lib/components/artifacts/canvas/_lib/ids.ts` — `newId(prefix: string): string`.

### Routes, literally

The Canvas has **four** HTTP surfaces and no more. Two of them are shared with another slice, and the
sharing is why the shapes below are written out rather than described.

| Route | Owner | Request | Response |
|---|---|---|---|
| `POST /api/artifacts/[id]/ops` | **this slice creates it**; Slice 4 adds a Slides branch | `{ baseVersionId: string; diff: BoardDiff }` | `{ ok: true, versionId: string, version: number, applied: number, refused: BoardRefusal[] }` \| 409 `{ ok: false, reason: "version_conflict", version }` \| 404 \| 400 \| 413 |
| `PATCH /api/artifacts/[id]/body` | **Slice 1 creates it**; this slice consumes it | `{ body: string; expectVersion: number }` | `{ ok: true, version: number }` \| 409 `{ ok: false, reason: "version_conflict", version }` \| 404 \| 413 |
| `POST /api/artifacts/[id]/exports/png` | this slice | multipart-or-`{ dataUrl: string; width: number; height: number; source: "canvas-export" }` | `{ ok: true, fileId: string, width: number, height: number }` \| 404 \| 413 \| 415 |
| `POST /api/artifacts/[id]/blocks/[nodeId]/refresh` | this slice | `{}` (the node id is the address) | `{ ok: true, nodeId: string, data: CanvasBlockData }` \| 404 \| 422 |

```ts
export type BoardRefusal = { index: number; op: string; reason: BoardRefusalReason };
```

**The ops route is a type-dispatching envelope, not a Canvas route.** Slice 4 (`slice-4.md §Routes`)
requires that a SlidePatch batch be **one branch** of the same endpoint and that no second route per type
appears. The envelope therefore lives in its own module and the route is thin enough that adding Slides
touches neither file's control flow:

```ts
// src/lib/server/services/artifacts/ops.ts  — SHARED: this slice creates it, Slice 4 adds a branch.
import type { ArtifactKind } from "./types";

export type OpsEnvelopeInput = {
	userId: string;
	artifactId: string;
	baseVersionId: string;
	/** The raw request body, already JSON-parsed and size-capped. */
	payload: unknown;
};

export type OpsEnvelopeResult =
	| { ok: true; versionId: string; version: number; applied: number; refused: BoardRefusal[] }
	| { ok: false; status: 404 | 400 | 409 | 413; reason: string; version?: number };

/**
 * auth is the route's job; this owns ownership → load → dispatch on kind →
 * validate → ONE version row → respond. A type with no branch is a 400, never
 * a silent success.
 */
export async function applyArtifactOps(input: OpsEnvelopeInput): Promise<OpsEnvelopeResult>;

/** kind → branch. This slice registers `canvas`; Slice 4 registers `slides`. */
export const OPS_BRANCHES: Partial<
	Record<ArtifactKind, (body: CanvasBody | string, payload: unknown) => OpsBranchOutcome>
>;
```

**The mechanism is shared; only the vocabulary is the Canvas's (ruling 14).** `src/lib/shared/artifacts/ops.ts`
holds the generic half — parse the `{ baseVersionId, diff }` envelope, validate the diff against the vocabulary
the type hands over, apply the ops in order, and return per-op `applied` / `refused` — and this slice creates it.
The Canvas vocabulary is `src/lib/shared/artifacts/board-ops.ts` (the file in §The board `_lib` modules above);
Slice 4's `deck-ops.ts` is its twin. `src/lib/server/services/artifacts/ops.ts` keeps what is server-shaped
instead: ownership, loading the body, the `baseVersionId` check, kind dispatch through `OPS_BRANCHES`, the single
`updateArtifactBody` call, and the response mapping. The shared module carries no route, no database handle and no
kind union.

`src/routes/api/artifacts/[id]/ops/+server.ts` is then ~15 lines: `requireAuth`
(`src/lib/server/auth/hooks.ts:9`), read the body, `applyArtifactOps(...)`, map `status`/`reason` through the
family's `{ ok: true, … }` / `{ ok: false, reason, … }` body built with `json(...)` — the success side may go
through `createJsonResponse` (`src/lib/server/api/responses.ts`), the failure side is **not**
`createJsonErrorResponse`'s `{ error }`. Ownership comes from
`getArtifactOwnershipScope` (`src/lib/server/services/knowledge/store/core.ts:141`), the same predicate the
incognito containment suite pins (`tests/cross-cutting/incognito-artifact-containment.test.ts:23-27,486-529`).

**The body route's payload field is `body`, and ruling 13 settles it.** Every type's write route takes
`body` plus `expectVersion`: a Document's body happens to be Markdown, and a board's or a deck's is JSON, so
the field is the generic one — **no alias and no per-type field name**.

- **This slice sends `{ body: boardJson(canvasBody), expectVersion }`** and expects
  `{ ok: true, version }`.
- Slice 1's Document sends `{ body: markdown, expectVersion }` on the same route. One field, five types; the
  route never learns what the body means.
- There is **no** `payload.body ?? payload.markdown` fallback: a second accepted spelling is a second contract
  to keep alive, and ruling 13 removes it rather than blessing it.
- The two slices therefore land in either order with no broken intermediate state, because both sides already
  spell the field the same way.

`expectVersion` (a monotonic integer) rather than a version *id* on this route, because Slice 1 and Slice 2
already use it (`slice-1.md §Service and routes`, `slice-2.md §The App card`) and a lost response can be
retried with the number the client already holds. The ops route keeps `baseVersionId`, because Slice 3 and Slice 4 agree on it and
it names the exact body a diff was derived from.

The client side, appended to Slice 0's `src/lib/client/api/artifacts.ts` (injectable `fetch`, same
`FetchLike` / `requestJson` shape as `src/lib/client/api/http.ts:7,318`; Slice 0 creates the file, this
slice appends):

```ts
export function saveCanvasBody(
	artifactId: string,
	body: string,
	expectVersion: number,
	fetchImpl?: FetchLike,
): Promise<{ ok: true; version: number } | { ok: false; reason: "version_conflict"; version: number }>;

export function applyArtifactOps(
	artifactId: string,
	baseVersionId: string,
	diff: BoardDiff,
	fetchImpl?: FetchLike,
): Promise<{ ok: true; versionId: string; version: number; applied: number; refused: BoardRefusal[] }>;

export function exportCanvasPng(artifactId: string, dataUrl: string, width: number, height: number): Promise<{ fileId: string; width: number; height: number }>;

export function refreshCanvasBlock(artifactId: string, nodeId: string): Promise<{ nodeId: string; data: CanvasBlockData }>;
```

### Frames and app-level reparenting

Svelte Flow's own behaviour, which must **not** be re-implemented and must not be relied on for adoption:

- A child moves with its parent, and a child's `position` is parent-relative.
- The library does **not** adopt a node dragged over a group. There is no `onNodeDragStop` adoption and no
  `extent: "parent"` auto-assignment in v1's API surface.

The handler, wired to the **lowercase** prop:

```svelte
<SvelteFlow
  bind:nodes
  bind:edges
  bind:viewport
  onnodedragstop={({ targetNode }) => targetNode && reparentOnDropCommit(targetNode as CanvasNode)}
/>
```

`reparentOnDropCommit(node)` calls the pure `reparentOnDrop(node, nodes, measured)` (contract above) and, if
it returns a patch, applies `flow.updateNode(node.id, patch)`. The measurement source is
`getInternalNode(node.id)?.measured ?? { width: NODE_WIDTH, height: DEFAULT_NODE_HEIGHT }`; the hit point is
the node's **centre**, computed from `absoluteOf(node, all)`. Clearing `extent` matters: a stale `extent`
from an earlier frame keeps clipping the node to a box it no longer belongs to.

Rules that come with it:

- **`zIndex: -1` on frame nodes** so a frame never covers its own children.
- **The frame's drag handle is the label bar only** (`dragHandle: ".artifact-frame__handle"`), so dragging
  inside a frame body does not move the frame out from under its children.
- **Reparenting is a structural change** and therefore a version: it goes through the body route's
  `saveCanvasBody` with the base version (Task T3), exactly like a text edit.
- **The marquee trap.** After a marquee (Shift-drag, or a select-mode background drag) the library renders
  `.svelte-flow__selection-wrapper` over the selection's bounding box at `z-index: 2000` with
  `pointer-events: all`. Measured consequence: a click on a checkbox inside a selected node, and a
  double-click to edit a selected sticky, both fail. Fix: in the canvas editor's stylesheet,
  `:global(.svelte-flow__selection-wrapper) { pointer-events: none; }` with a comment saying why. Group
  dragging still works by dragging any single selected node.

### Connectors

```svelte
<SvelteFlow
  connectionMode={ConnectionMode.Loose}
  onbeforeconnect={(connection) => ({
    ...connection,
    id: newId("e"),
    label: "",
  })}
  onconnect={(connection) => noteEdge(connection)}
/>
```

- The id and every app field are stamped in **`onbeforeconnect`** — the hook that runs *before* the store
  write, and whose return value is the edge that gets stored (returning `null` vetoes the connection).
- `onconnect` is a notification and is **only** used to note the change for the version row.
- Adding the edge in `onconnect` as well is the bug the prototype hit: one handle drag, two parallel edges.
- `ondelete` is also a notification, not a veto: the library filters the store itself and then calls back
  with what it removed. Prune exactly the reported ids, and re-derive dangling edges (`no edge may point at
  a missing node`) — the library removes an edge's endpoints' edges without naming them.
- The library's lowercase event-prop convention applies to **every** flow prop (`onnodedragstop`,
  `onbeforeconnect`, `ondelete`, `onconnect`). A camelCase guess is silently ignored.
- `selectionMode` is the `SelectionMode` enum (`SelectionMode.Partial`), not a string; there is no
  `snapToGrid` boolean in v1 — only `snapGrid` (`[number, number]`), which this slice does not set.

### The drawing layer

- **Board coordinates only.** Every point in `Annotation` is a board point, never a screen point. The layer
  renders inside `<ViewportPortal target="front">` (inside the transformed `.svelte-flow__viewport`), so a
  stroke drawn at 100 % stays glued to what it was drawn on at any zoom, and the PNG export — which clones
  that same viewport element — gets the strokes for free with no second render path.
- **The pad is sized from the pane.** `padRect = visibleBoardRect(paneSize, viewport)`, with `paneSize`
  measured from `.svelte-flow__pane` via a `ResizeObserver`. The pad is positioned at `left: padRect.left`,
  `top: padRect.top`, `width: padRect.width`, `height: padRect.height` in board units, and carries
  `pointer-events: auto` only while a drawing tool is active.
- **Styles for portal content live on portal content.** The portal renders into
  `.svelte-flow__viewport-front`, a *sibling* of the layer root, so a descendant rule written from the root
  never matches it. Setting "the pointer is mine" on the root left the pad at `pointer-events: none` and the
  symptom was a pen stroke that dragged the node under it.
- **`z-index: 2` on both portal layers.** Frame children are lifted to `z-index: 1` by the library, so the
  portal's `auto` puts the layer below every note inside a frame. 2 stays under the library's own selection
  chrome (`__nodesselection` 3, `__selection` 6) and under the app's panels, which are outside the
  transformed viewport.
- **One tab stop.** The layer is `role="application" tabindex="0" aria-label={$t("artifacts.canvas.drawingLayer")}`.
  It is the only tab stop the drawing surface adds: the toolbar is a separate `role="toolbar"` with
  `aria-label`s and `aria-pressed` on the active tool. Keyboard inside the layer: `Escape` returns to
  Select, `Delete`/`Backspace` removes the selected annotation, arrow keys nudge it by 1 board unit (10 with
  Shift). The walk found 36 tab stops and no visible focus ring; the fix is that every focusable element
  gets a `:focus-visible` outline from the token set, and the layer announces itself once.
- **Tools:** pen (velocity pressure), highlighter (same geometry, `size` 14, opacity 0.35), line, arrow
  (arrowhead polygon), rect, ellipse, text, eraser.
- **Undo/redo covers the drawing layer only.** `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z`, plus toolbar buttons.
  One gesture (draw, move, erase) is one step; the history is bounded at 50 snapshots. **Node, edge and
  comment changes are deliberately not in this history** — a half-history that reverted node moves but not
  the comments would be a lie about what "undo" covers, and the whole-board undo a user expects already
  exists as **artifact versions** (Slice 0's restore), which is more honest and more useful. Put that
  sentence in the module header.
- **Strictly out of scope for this slice:** stroke erasing (the eraser is a drag-to-delete sweep that
  removes whole annotations), annotation layers/grouping, annotation multi-select, and a joint
  node+annotation selection model. All four are named non-goals that the prototype left weak too.
- **Stylus pressure stays `simulatePressure: true`.** A real Wacom reports `event.pressure`, but the same
  board must stay JSON-serialisable and behave identically under a mouse and under synthetic pointer events.
  Reserve an optional `p?: number` per point for a later stylus pass, and do not populate it yet.
- **Multi-touch.** Svelte Flow arbitrates gestures, so an overlay inside the viewport inherits its rules: a
  two-finger pinch whose first finger lands on a block is dropped whole. The drawing layer does not add its
  own multi-touch handling; pinch-to-zoom over the pad is what pinch does everywhere else on the board, and
  the e2e test asserts exactly that (pinch over a block: no zoom, no node move; pinch over empty board:
  zoom).

### Comment pins

One shared comment feature, three anchor kinds (§2.7), of which this slice owns `node` and `point`. The
types are in **The shared comment interface** above; the behaviour is here.

- **Pins live in board space**, rendered through the same `ViewportPortal target="front"` at `z-index: 2`.
  A pin is a 22 px numbered circle; the number is the thread's 1-based position in the list, resolved
  threads keep their number, and an unknown id prints `?` rather than silently becoming pin 0.
- **The open thread card lives in screen space**, next to the pin, not in board space. At the phone's fit
  zoom (36 %) a board-space card is ~83 CSS px wide — legible in a screenshot, unusable with a thumb.
- **Click-to-place is a catcher rendered OUTSIDE the portal,** where `inset: 0` really is the pane
  (measured: `.catch` = `[0, 35, 1280, 865]`). Placing a comment is one click: the tool takes the next
  click, converts it to board coordinates, creates an open thread, and returns the tool to Select.
- **Client-side modals must actually be visible:** `@xyflow/svelte` uses its own modal layer; a
  `z-index` below it makes a comment card unclickable. The card's z-index is a named token
  (`--artifact-overlay-z`), and the e2e test clicks a card button to prove it is reachable.
- **`@Alfy` in a comment produces an edit plus a reply in the thread**, and it reuses the same BoardDiff
  application path as the model (Task T6) so a comment-driven change looks exactly like a model-driven one.
  Slice 5 owns the tool call; this slice owns the local application and the reply row's rendering.
- **Alfy leaves its own comment** when it makes a judgement call it is unsure about (§2.8). The row renders
  with the Alfy avatar and an author of `alfy`; the user can reply and resolve like any other thread.
- **Deleting an anchored block orphans its thread, not its content.** An orphaned thread stays in the
  list, dimmed, with the "the block is gone" row; the pin is not drawn. The state comes from
  `canvasAnchorResolver.resolve(...)` returning `orphaned`, never from a local "does this node exist"
  check — one authority for the outcome, shared with the Document's resolver shape.

### The BoardDiff application path

The model emits a `BoardDiff`; the user watches it land. Both the toolbar's "Ask Alfy" result and the
`@Alfy` comment path go through **one** function:

```ts
async function applyBoardDiff(diff: BoardDiff, label: string): Promise<{ applied: number; refused: BoardRefusal[] }>
```

Order, and this order is the contract:

1. `arranging = true` → the **"Alfy is arranging…" pill** appears (an overlay in screen space, top-centre,
   with a pulsing dot and the diff's one-line `summary`).
2. Server round-trip first: `POST /api/artifacts/[id]/ops` with `{ baseVersionId, diff }`. The **server**
   validates against the current body (Contracts → validation rules) and persists the accepted ops as one
   new version with `author: "alfy"` and `summary: diff.summary`. The client never applies an unvalidated
   diff.
3. On acceptance, apply the returned accepted ops **structurally first** (everything except `move`), with
   parents before children in the array; then `await tick()`.
4. Then **tween the moves**: 620 ms, `easeInOut`, one `requestAnimationFrame` loop updating positions, so
   the user sees the board rearrange rather than teleport.
5. Then highlight: each touched node gets `highlight: true` (a token-coloured ring), cleared after 3200 ms.
6. `arranging = false`; the response's `refused[]` renders as one dismissible notice — Slice 1's shared
   `src/lib/components/artifacts/RefusalNotice.svelte` (its T8), never a canvas copy — listing what was
   skipped and why, so a partial application is visible rather than silent.

A second `applyBoardDiff` while `arranging` is true returns immediately without queueing: two overlapping
arrangements are incoherent, and the model's second diff will be re-derived server-side from the board it
now sees. The toolbar's Ask-Alfy button is also disabled while `arranging`, so the refusal is not the first
thing the user learns.

**Where the diff comes from.** Slice 5 owns the `edit_artifact` tool and its prompt. For this slice, the
application path is proven by:
- the unit tests over `validateBoardDiff` and the ordering helpers,
- an integration test that posts a real diff to the ops route and asserts the version row,
- a Playwright test that drives `POST /api/artifacts/[id]/ops` with a canned diff through the page's own
  fetch path (the same way the prototype's "Simulate Alfy" button did) and asserts the pill, the moves, the
  highlight and the resulting board JSON,
- and Slice 5's eval suite 3 ("arrange Saturday"), which is the model-quality gate.

### Poster frames

- Blocks that cannot survive a `foreignObject` clone carry a `poster: PosterRef`.
- A poster is a **generated PNG file** stored through the existing chat-files path, so it is served by the
  canonical `/api/chat/files/{id}/preview` and `/download` routes and needs no new storage
  (`src/lib/server/services/chat-files.ts:443`, `storeGeneratedFile`).
- `capturePoster` uses `html-to-image`'s `toPng` on the node's own element, at `POSTER_WIDTH ×
  POSTER_HEIGHT`, with the app's `--surface-elevated` background.
- Capture happens (a) once, debounced 800 ms, after a poster-needing node first mounts with data, (b) again
  after the node's data changes, and (c) once more before an export that finds a poster still missing.
- **Offline and export both use the poster.** The map block's live basemap needs authed tiles and outbound
  access; the offline-honest map block is the static route image, which is exactly the shape
  `MapRouteCard.svelte`'s own inline-SVG fallback already has. The badge must say the basemap is not live
  rather than letting the attribution line imply one is underneath.
- **A missing poster never silently becomes an empty box.** `exportBoardPng` returns `missingPosters`, the
  panel shows one notice naming them, and the export itself draws a legible placeholder card
  (`posterPlaceholder`) instead of nothing.
- **A failed capture is not a failed board.** `capturePoster` rejects, the node keeps rendering live, and
  the failure surfaces once as `artifacts.canvas.posterFailed` in the node's meta line — it never blocks the
  save or the edit.

### PNG export

1. Compute `getNodesBounds` for the board, clamp to `width ∈ [800, 2400]`, `height ∈ [600, 1800]`.
2. `getViewportForBounds(bounds, width, height, 0.2, 2, 0.1)`; remember the camera; `setViewport(next,
   { duration: 0 })`; wait one `requestAnimationFrame`.
3. `mountPosters(missing)` — every poster-needing node's live subtree is swapped for its poster image.
4. `toPng(viewportEl, { backgroundColor: --surface-page, width, height, style: { width, height, transform } })`.
5. Restore the camera and `unmountPosters()` in a `finally`, so a failed export cannot leave the board
   rearranged or half-postered.
6. `POST /api/artifacts/[id]/exports/png` with the data URL, receive `{ fileId, width, height }`.
7. The panel shows the stored PNG and offers the canonical download. The export also becomes a
   `generated_output` artifact linked to the canvas, so it appears in the chat card and in the library like
   every other produced file (§5: `produce_file` stays the engine; this is the one client-captured case, and
   the reason is that only the browser has the rendered board).

**PDF export of a Canvas is a non-goal for this slice** (the mockup lists `Canvas → PNG · PDF`; PDF is
derived from the PNG in a later pass, through `produce_file`, and is not on this slice's critical path).

### Perf budget (split per ruling 9)

**CI-asserted structural budgets** — deterministic, machine-independent; a failure here means the change
grew the board, the bundle or the overlay:

| Number | Threshold | How it is measured |
|---|---|---|
| board JSON size, the 150-note + 200-stroke fixture | **≤ 512 kB** canonical JSON | `boardJson(fixture).length` in a unit test |
| node count, same fixture | exactly 150 stored nodes, 200 annotations | `normalizeCanvasBody(fixture).body` |
| pad hit-coverage at fit view on a ≥ 150-node board | **≥ 95 %** of 144 sample points across the pane | points at `(i/12, j/12)` of the pane, `document.elementFromPoint`, topmost element is the pad |
| timing ceiling, generous margin | **avg < 40 ms** | 80 `requestAnimationFrame` deltas during a scripted pan, first 8 dropped; generous by design, so a shared runner cannot fail it |
| stroke commit cost | < 8 ms per stroke end-to-end | 200 real pointer drags through the input pipeline |
| route chunk, canvas editor | ≤ 65 kB gzip | `scripts/check-artifact-chunks.mjs`, modelled on `scripts/check-built-worker-assets.mjs` |
| route chunk, chat route without an artifact open | unchanged by more than 2 kB gzip | same scan |
| module graph | Chart.js and MapLibre are **not** reachable from the canvas editor chunk | the same scan greps the chunk's static-import closure |

**Local, recorded measurement (not asserted):**

| Number | Reported as | How it is measured |
|---|---|---|
| frame time, 150 notes + 200 strokes | **avg and p95 ms, and the derived fps** | the same sweep, printed by the test and pasted into the PR body; the prototype measured **8.3 ms average (≈ 120 fps)** on a 163-node + 202-annotation board via `_probe.mjs` |

Notes the test must print, not hide: the number is **DOM-bound** (one component instance and subtree per
node), so it scales linearly with node count and every threshold above is only meaningful at the stated
board size. The 60 fps figure is the *product* target, measured locally; if a CI runner cannot hold it, that
is not a product regression and the fix is not a smaller number in the test. The escape hatch is a
documented decision by the owner (raise the floor, move the fps job to a dedicated runner), never a silently
loosened assertion.

Chart.js (776 kB) and MapLibre (474 kB) are already lazy-loaded by the existing chat path and must stay
that way: neither may be imported by the canvas editor module graph statically. The prototype's own route
chunk was 51 kB gzip precisely because those two load only when their blocks mount.

### Portal and z-index traps (collected, with the symptom each one produces)

| Trap | Symptom if ignored | Rule |
|---|---|---|
| Portal content cannot be styled from the portal's parent | the pen drags the node under it instead of drawing | styles for portal content live on portal content |
| Frame children carry `z-index: 1` | the drawing layer and the pins sit under every note inside a frame | explicit `z-index: 2` on both portal layers |
| A pointer-capturing overlay inside the portal is as big as the board, not the view | the board stops being drawable once the camera zooms out (6/144 points at 163 nodes) | size it from `visibleBoardRect(paneSize, viewport)` |
| The library's chrome owns the corners it occupies | a board-space zoom chip is unreachable under `Controls`/attribution | the zoom control is a snippet *inside* the `Controls` panel; at 390 px the app's quick chrome collapses to one button so the top-right corner is free |
| A comment card drawn in board space shrinks with the board | at 36 % zoom the thread card is unusable with a thumb | pins in board space, the open card in screen space |
| `.svelte-flow__selection-wrapper` is hit-testable at `z-index: 2000` | a checkbox inside a selected node and a double-click on a selected sticky both stop working | `pointer-events: none` on it, with a comment |
| `ondelete` is a notification, not a veto | pruning "everything selected" deletes a node nobody aimed at | prune exactly the reported ids and re-derive dangling edges |
| `onnodeDragStop` / `onBeforeConnect` / `snapToGrid` are React Flow spellings | the handler never runs and nothing is logged; the edge id is never stamped; a grid is never snapped | every flow prop is lowercase (`onnodedragstop`, `onbeforeconnect`, `ondelete`, `onconnect`); v1 has `snapGrid`, not `snapToGrid` |

### Limits and configuration

Every cap in this slice, with where it is read and its default. **None of these is environment-backed or
admin-configurable**, and that is deliberate: they are board-geometry and payload-shape guards whose value
belongs to the canvas format, not to a deployment. If the owner ever wants the node cap tunable, it goes
`env.ts` → `config-store.ts` → this module — the read path exists and is named below so the change is one
place.

| Value | Default | Where it lives | Why not configurable |
|---|---|---|---|
| `MAX_NODES_PER_BOARD` | 400 | `src/lib/server/services/artifacts/serialize/canvas.ts` | a board past this is a rendering problem, not a deployment preference; the node cap is what the perf budget is stated against |
| `MAX_BODY_BYTES` | 1 MiB (1048576) | same module | `content_text` is one SQLite text column; the cap is the storage shape |
| `MAX_ANNOTATIONS_PER_BOARD` | 600 | `_lib/annotations.ts` | export/recall budget; the prototype's heavy fixture was 202 |
| `MAX_POINTS_PER_STROKE` | 1200 | `_lib/annotations.ts` | decimated by distance, so the cap never clips an end |
| `MAX_OPS_PER_DIFF` | 40 | `src/lib/shared/artifacts/board-ops.ts` | a batch is one transaction; 40 ops is already a whole board |
| `MAX_NEW_NODES_PER_DIFF` | 24 | `src/lib/shared/artifacts/board-ops.ts` | one arrangement creates frames and blocks, not a board |
| `POSTER_WIDTH` × `POSTER_HEIGHT` | 640 × 400 | `_lib/poster.ts` | file size vs legibility; the export upscales from it |
| export clamp | 800–2400 × 600–1800 | `_lib/export-png.ts` | a phone screen and a 4K display |
| move tween | 620 ms, cleared highlight at 3200 ms | `CanvasBoard.svelte` | the animation is the product decision and is stated in Review Focus 5 / §2.13 |
| undo history depth | 50 snapshots | `AnnotationLayer.svelte` | bounded memory; one snapshot is one gesture |
| poster capture debounce | 800 ms | `CanvasBoard.svelte` | a drag must not trigger a capture per frame |
| comment card offset from its pin | 12 px screen space | `CommentLayer.svelte` | layout constant |
| `--artifact-overlay-z` | `2100` | `src/app.css` | above `@xyflow/svelte`'s own modal layer, below the app's own sheets |

If any of these ever **is** made admin-configurable, the path is the one `env.ts` → `config-store.ts` already
uses for `MAX_MODEL_CONTEXT` and friends (`AGENTS.md` §Config And Environment), and the value must be read
through a getter with the admin override applied — never `process.env` at the call site.

### UI states

The panel's content area is `CanvasEditor.svelte`; the shell (eyebrow, title, version pill, actions) is
Slice 0's. What this slice owns is the board area and the toolbar.

| State | 1440 px | 390 px | Component / tokens |
|---|---|---|---|
| **Empty** | dot grid, centred `artifacts.canvas.emptyBoard` at body size, `--text-muted`; the toolbar's Insert button gets the focus ring | same line, wrapped to 2 lines, centred | `CanvasBoard.svelte`; `--space-lg` padding, `--text-secondary` |
| **Loading** | the panel shell renders immediately; the board area shows three skeleton node cards on the dot grid (no spinner) | same, one shorter skeleton | `CanvasEditor.svelte`; `--surface-raised`, `--radius-lg`, no animation beyond a 1.4 s opacity pulse (suppressed under `prefers-reduced-motion`) |
| **Error (body unreadable)** | the board does not render; a centred card with `artifacts.canvas.loadFailed` and a Retry button | same, full width | `error` state of `CanvasEditor.svelte`; `--status-danger` icon, `--surface-elevated` card |
| **Error (dropped content)** | the board renders **and** one dismissible notice: `artifacts.canvas.blockDropped` with the count, because a partial board beats no board | same | `normalizeCanvasBody`'s `dropped` drives it; `--status-warning` |
| **Long content** | a 60-block board scrolls by panning only; the toolbar stays fixed to the panel's bottom-centre and the minimap to the bottom-right; nothing scrolls the page (the shell owns overflow) | panning only; the toolbar collapses to Select / Insert / Ask Alfy; the Insert sheet is full-height and scrolls internally | `CanvasToolbar.svelte`; `--artifact-overlay-z` for the sheet |

**Focus and keyboard order**, top to bottom, at both widths:

1. the panel header's own controls (Slice 0's: close, versions, actions) —
2. the drawing layer's single tab stop (`role="application"`),
3. the toolbar (`role="toolbar"`): Select → Pan → 7 drawing tools → ink swatches → Undo → Redo → Insert → Ask Alfy,
4. inside the Insert menu (when open): a roving tabindex over the rows, `Escape` closes and returns focus to Insert,
5. the board's nodes in document order (each node's own controls: text field, insert menu, delete),
6. the comment pins, then the open card's Reply / Resolve / Close.

Every focusable element gets a `:focus-visible` outline from `--focus-ring`; nothing relies on the browser
default. The toolbar's `aria-pressed` reflects the active tool; the Insert button carries `aria-expanded`.

### Failure modes

| What happens | Server | User sees (EN) | User sees (HU) |
|---|---|---|---|
| The model returns a malformed `BoardDiff` (schema-invalid JSON) | `400 { ok: false, reason: "invalid_diff" }` | `That change could not be read, so nothing moved.` | `Ezt a módosítást nem sikerült értelmezni, ezért semmi sem mozdult el.` |
| The diff is valid but every op refused | `200 { applied: 0, refused: [...] }` | the notice: `{count} change(s) were skipped: {reasons}` — never a silent no-op | `{count} módosítás kimaradt: {reasons}` |
| The network drops mid-drawing | nothing (the write never left) | `You are offline. Your drawing is kept and will be saved when the connection is back.` and `Saved` stays off | `Nincs kapcsolat. A rajzod megmarad, és visszatér a mentés, amint újra van hálózat.` |
| The network drops on a save in flight | the request fails; the client retries once, then shows the banner | `artifacts.canvas.saveFailed` + Retry | `Nem sikerült menteni a táblát.` + `Újra` |
| Another pane (a chat turn, a second tab) wrote first | `409 { ok: false, reason: "version_conflict", version }` | `Someone changed the board while you were drawing. Reload to see the newest version.` + Reload button; the local strokes are kept in memory until the user chooses | `Valaki módosította a táblát, amíg rajzoltál. Töltsd újra, hogy a legfrissebbet lásd.` + `Újratöltés` |
| The artifact is deleted while the panel is open | next save: `404 { ok: false, reason: "not_found" }`; the e2e's delete uses the same path | the board area switches to `This board was deleted.` with a Close button; no further writes are attempted | `Ezt a táblát törölték.` |
| The artifact belongs to someone else | `404` (never 403 — a 403 confirms the id exists) | `You do not have access to this board.` | `Nincs hozzáférésed ehhez a táblához.` |
| The body is over `MAX_BODY_BYTES`, or the batch over `MAX_OPS_PER_DIFF` | `413 { ok: false, reason: "too_large" }` / `200` with the batch refused as `limit_exceeded` | `artifacts.canvas.refusal.limit_exceeded` in the skipped notice | `a tábla elérte a korlátját` |
| A `liveweb` refresh fails | `422 { ok: false, reason: "refresh_failed" }` | `artifacts.canvas.refreshFailed` in the node's meta line; the stored snapshot stays | `Nem sikerült frissíteni ezt a blokkot.` |
| A poster capture throws | nothing (client-side) | `artifacts.canvas.posterFailed` once, in the node's meta line; the export still runs and names the block | `Nem sikerült állóképet készíteni erről a blokkról.` |
| The PNG export throws inside `toPng` | nothing (client-side) | `artifacts.canvas.exportFailed`, the camera is restored, the board is unchanged | `Nem sikerült exportálni a táblát.` |
| `@Alfy` in a comment, and Slice 5's tool is absent | `404` from the comment route's alfy branch | `artifacts.canvas.commentFailed` on the card; the comment itself is still posted | `Nem sikerült elküldeni a megjegyzést.` |
| A stored node has a kind this build does not know | nothing (client-side, on load) | the node renders as a `blockMissingKind` card and is kept in the body, not dropped | `Ez a blokktípus már nem támogatott.` |

`400 invalid_diff`, `409 version_conflict`, `404 not_found` and `413 too_large` are the four reason codes the
routes emit; the client switches on them and never on prose.

### Prototype pointers

Read the working code, do not invent the approach. All paths are on the throwaway branch
`proto/artifact-canvas` under `src/routes/prototype/canvas/`.

| Hard part | Prototype file + function | What to take from it |
|---|---|---|
| The visible-pane rect | `_lib/pane-rect.ts` → `visibleBoardRect(pane, viewport, margin = 24)` | the formula, the `margin` default, the all-zero unmeasured case, and the 246×166-in-1280×865 comment that produced the 6/144 number |
| The pad's geometry | `_components/PrototypeAnnotationLayer.svelte` → the pad block | how the rect is turned into board-unit `left/top/width/height` inside the portal |
| The click-to-place catcher | `_components/PrototypeCommentLayer.svelte` → `.catch` | why it is rendered outside the portal (measured `[0, 35, 1280, 865]`) |
| Stroke geometry | `_lib/annotations.ts` → `strokePath`, `baseSize`, the capsule fallback | the `getStroke` parameters (`thinning .55, smoothing .5, streamline .5, simulatePressure: true, last: true`) and the two-point-flick fallback |
| Hit testing | `_lib/annotations.ts` → `hitTest`, `pickAnnotation`, `annotationBounds` | rect hit-tests the stroke, not the fill; newest wins |
| The canonical board JSON | `_lib/board.ts` → `boardJson(...)`, `structuralOps`, `moveOps`, `highlightedIds` | the strip list (`measured/selected/dragging`) and the op partitioning; add the stable key order and the 3-decimal rounding ruling 12 requires |
| `BoardOp` vocabulary | `_lib/board.ts` → `BoardOp`, `saturdayDiff()` | the exact op names the prototype's model emitted (note: it lacks `remove_edge`; add it) |
| The perf sweep | `_components/PrototypeCanvas.svelte` → `measureBoard()` | 80 rAF deltas, first 8 dropped, `p95 = sorted[floor(len*0.95)]`, and the printed label `"N nodes · avg frame X ms · p95 Y ms · ~Z fps"` |
| The PNG export | `_components/PrototypeCanvas.svelte` → the export block | the clamps `min(2400, max(800, w+200))` / `min(1800, max(600, h+200))`, `getViewportForBounds(bounds, width, height, 0.2, 2, 0.1)`, and the colour scan for `rgba(140, 40, 190, .9)` |
| The pad-coverage probe | `_probe.mjs` → `padCoverage()` | the 12×12 pane grid and the `elementFromPoint(...).classList.contains("alayer__pad")` check — port it into the Playwright perf test |
| The tickable checklist node | `_components/PrototypeChecklistNode.svelte` | the whole component: `chat/Checklist.svelte` is read-only, so the prototype wrote its own and so does this slice. Note it calls `updateNodeData`, not a direct array mutation |
| The measured traps | `_notes/review.md` | the six findings (portal styling, frame-child z-index, gesture arbitration, the library's chrome corners, the board-space comment card at ~83 px at 36 %, pad-as-big-as-board) and the explicit "deliberately weak" list that this slice's Non-goals mirror |

### i18n

New namespace `src/lib/i18n/artifacts.ts`, spread into `src/lib/i18n/index.ts` beside `instructionsDict`
(the module imports a `*Dict` per file and spreads `.en` / `.hu`; `src/lib/i18n/index.ts:3-11,46-58`).
Keys are `artifacts.<type>.<thing>`; Slice 0 owns `artifacts.card.*` and `artifacts.panel.*`, Slice 1 owns
`artifacts.document.*`, Slice 4 owns `artifacts.slides.*`. **This slice owns `artifacts.canvas.*`; the
`artifacts.type.*` names are Slice 0's (ruling 22) and are restated here only because the Canvas is one of the
five.** Registration (`I18N_MODULES`, `AUDITED_PREFIXES`) is Slice 0's; this
slice only appends keys, and `artifacts.` is already an audited prefix (`slice-0.md §i18n`).

`artifacts.type.*` (HU follows ADR-0066's ratified names):

| Key | EN | HU |
|---|---|---|
| `artifacts.type.canvas` | `Canvas` | `Tábla` |
| `artifacts.type.document` | `Document` | `Dokumentum` |
| `artifacts.type.app` | `App` | `Alkalmazás` |
| `artifacts.type.slides` | `Slides` | `Diasor` |
| `artifacts.type.file` | `File` | `Fájl` |

`artifacts.canvas.*`:

| Key | EN | HU |
|---|---|---|
| `artifacts.canvas.drawingLayer` | `Drawing layer` | `Rajzréteg` |
| `artifacts.canvas.toolbar` | `Canvas tools` | `Tábla eszközök` |
| `artifacts.canvas.tool.select` | `Select` | `Kijelölés` |
| `artifacts.canvas.tool.pan` | `Pan` | `Mozgatás` |
| `artifacts.canvas.tool.pen` | `Pen` | `Toll` |
| `artifacts.canvas.tool.highlighter` | `Highlighter` | `Kiemelő` |
| `artifacts.canvas.tool.line` | `Line` | `Vonal` |
| `artifacts.canvas.tool.arrow` | `Arrow` | `Nyíl` |
| `artifacts.canvas.tool.rect` | `Rectangle` | `Téglalap` |
| `artifacts.canvas.tool.ellipse` | `Ellipse` | `Ellipszis` |
| `artifacts.canvas.tool.text` | `Text` | `Szöveg` |
| `artifacts.canvas.tool.eraser` | `Eraser` | `Radír` |
| `artifacts.canvas.tool.comment` | `Comment` | `Megjegyzés` |
| `artifacts.canvas.ink` | `Ink colour` | `Tinta színe` |
| `artifacts.canvas.inkName` | `{name} ink` | `{name} tinta` |
| `artifacts.canvas.ink.blue` | `Blue` | `Kék` |
| `artifacts.canvas.ink.red` | `Red` | `Piros` |
| `artifacts.canvas.ink.green` | `Green` | `Zöld` |
| `artifacts.canvas.ink.graphite` | `Graphite` | `Grafit` |
| `artifacts.canvas.undo` | `Undo` | `Visszavonás` |
| `artifacts.canvas.redo` | `Redo` | `Újra` |
| `artifacts.canvas.insert` | `Insert` | `Beszúrás` |
| `artifacts.canvas.insert.block` | `Insert block` | `Blokk beszúrása` |
| `artifacts.canvas.insert.text` | `Text` | `Szöveg` |
| `artifacts.canvas.insert.sticky` | `Sticky note` | `Jegyzet` |
| `artifacts.canvas.insert.frame` | `Frame` | `Keret` |
| `artifacts.canvas.insert.chart` | `Chart` | `Diagram` |
| `artifacts.canvas.insert.checklist` | `Checklist` | `Ellenőrzőlista` |
| `artifacts.canvas.insert.map` | `Map route` | `Útvonal` |
| `artifacts.canvas.insert.file` | `File` | `Fájl` |
| `artifacts.canvas.insert.app` | `App` | `Alkalmazás` |
| `artifacts.canvas.insert.photo` | `Photos` | `Fényképek` |
| `artifacts.canvas.insert.liveweb` | `Live web` | `Élő web` |
| `artifacts.canvas.ask` | `Ask Alfy` | `Kérdezd Alfyt` |
| `artifacts.canvas.comment` | `Comment` | `Megjegyzés` |
| `artifacts.canvas.commentPlaceholder` | `Write a comment. Use @Alfy to ask for a change.` | `Írj megjegyzést. Az @Alfy megszólításával változtatást kérhetsz.` |
| `artifacts.canvas.commentPost` | `Post` | `Küldés` |
| `artifacts.canvas.commentResolve` | `Resolve` | `Megoldva` |
| `artifacts.canvas.commentReopen` | `Reopen` | `Újranyitás` |
| `artifacts.canvas.commentReply` | `Reply` | `Válasz` |
| `artifacts.canvas.commentOrphaned` | `The block this comment was on is gone.` | `A blokk, amihez ez a megjegyzés tartozott, már nincs meg.` |
| `artifacts.canvas.commentSummary` | `{open} open · {resolved} resolved` | `{open} nyitott · {resolved} megoldott` |
| `artifacts.canvas.commentNone` | `No comments` | `Nincs megjegyzés` |
| `artifacts.canvas.commentPinA11y` | `Comment {n} on the board` | `{n}. megjegyzés a táblán` |
| `artifacts.canvas.commentPlaceHint` | `Click the board to place the comment.` | `Kattints a táblára a megjegyzés elhelyezéséhez.` |
| `artifacts.canvas.commentClose` | `Close` | `Bezárás` |
| `artifacts.canvas.commentFailed` | `Could not post the comment.` | `Nem sikerült elküldeni a megjegyzést.` |
| `artifacts.canvas.arranging` | `Alfy is arranging…` | `Alfy épp rendezi…` |
| `artifacts.canvas.arrangeBusy` | `Alfy is still arranging. Try again in a moment.` | `Alfy még rendezi a táblát. Próbáld újra egy pillanat múlva.` |
| `artifacts.canvas.arrangeRefused` | `{count} change(s) were skipped: {reasons}` | `{count} módosítás kimaradt: {reasons}` |
| `artifacts.canvas.arrangeDismiss` | `Dismiss` | `Elrejtés` |
| `artifacts.canvas.invalidDiff` | `That change could not be read, so nothing moved.` | `Ezt a módosítást nem sikerült értelmezni, ezért semmi sem mozdult el.` |
| `artifacts.canvas.refusal.unknown_id` | `nothing is at that position any more` | `már nincs ott semmi` |
| `artifacts.canvas.refusal.duplicate_id` | `that id already exists` | `ez az azonosító már létezik` |
| `artifacts.canvas.refusal.unknown_kind` | `unknown block type` | `ismeretlen blokktípus` |
| `artifacts.canvas.refusal.kind_mismatch` | `a block cannot change type in place` | `a blokk típusa nem változhat meg helyben` |
| `artifacts.canvas.refusal.missing_parent` | `the frame it belongs to is missing` | `hiányzik a keret, amihez tartozna` |
| `artifacts.canvas.refusal.self_parent` | `a frame cannot contain itself` | `a keret nem tartalmazhatja önmagát` |
| `artifacts.canvas.refusal.cycle` | `a frame cannot sit inside its own frame` | `a keret nem kerülhet a saját keretébe` |
| `artifacts.canvas.refusal.invalid_data` | `the block's content was not valid` | `a blokk tartalma nem volt érvényes` |
| `artifacts.canvas.refusal.limit_exceeded` | `the board is at its limit` | `a tábla elérte a korlátját` |
| `artifacts.canvas.refresh` | `Refresh` | `Frissítés` |
| `artifacts.canvas.refreshFailed` | `Could not refresh this block.` | `Nem sikerült frissíteni ezt a blokkot.` |
| `artifacts.canvas.fetchedAt` | `Fetched {when}` | `Letöltve: {when}` |
| `artifacts.canvas.staleBadge` | `Not live` | `Nem élő` |
| `artifacts.canvas.mapNotLive` | `The live map is not available offline.` | `Az élő térkép offline nem érhető el.` |
| `artifacts.canvas.export` | `Export` | `Exportálás` |
| `artifacts.canvas.exportPng` | `Export as PNG` | `Exportálás PNG-ként` |
| `artifacts.canvas.exportFailed` | `Could not export the board.` | `Nem sikerült exportálni a táblát.` |
| `artifacts.canvas.exportMissingPosters` | `{count} block(s) were drawn as a still image: {names}` | `{count} blokk állóképként került a képbe: {names}` |
| `artifacts.canvas.posterFailed` | `Could not make a still image of this block.` | `Nem sikerült állóképet készíteni erről a blokkról.` |
| `artifacts.canvas.blockMissingKind` | `This block's type is not supported any more.` | `Ez a blokktípus már nem támogatott.` |
| `artifacts.canvas.blockDropped` | `{count} block(s) could not be read and were left out.` | `{count} blokkot nem sikerült beolvasni, kimaradtak.` |
| `artifacts.canvas.nodeDeleted` | `Deleted from the board.` | `Törölve a tábláról.` |
| `artifacts.canvas.saved` | `Saved` | `Mentve` |
| `artifacts.canvas.saving` | `Saving…` | `Mentés…` |
| `artifacts.canvas.saveFailed` | `Could not save the board.` | `Nem sikerült menteni a táblát.` |
| `artifacts.canvas.saveConflict` | `Someone changed the board while you were drawing. Reload to see the newest version.` | `Valaki módosította a táblát, amíg rajzoltál. Töltsd újra, hogy a legfrissebbet lásd.` |
| `artifacts.canvas.reload` | `Reload` | `Újratöltés` |
| `artifacts.canvas.retry` | `Retry` | `Újra` |
| `artifacts.canvas.offline` | `You are offline. Your drawing is kept and will be saved when the connection is back.` | `Nincs kapcsolat. A rajzod megmarad, és visszatér a mentés, amint újra van hálózat.` |
| `artifacts.canvas.deletedWhileOpen` | `This board was deleted.` | `Ezt a táblát törölték.` |
| `artifacts.canvas.noAccess` | `You do not have access to this board.` | `Nincs hozzáférésed ehhez a táblához.` |
| `artifacts.canvas.loading` | `Opening the board…` | `Tábla megnyitása…` |
| `artifacts.canvas.loadFailed` | `Could not open the board.` | `Nem sikerült megnyitni a táblát.` |
| `artifacts.canvas.stickyPlaceholder` | `Write a note…` | `Írj egy jegyzetet…` |
| `artifacts.canvas.textPlaceholder` | `Write something…` | `Írj valamit…` |
| `artifacts.canvas.frameName` | `Frame name` | `Keret neve` |
| `artifacts.canvas.checklistReadOnlyNote` | `Ticks here are saved with the board.` | `Az itt bejelölt pipák a táblával együtt mentődnek.` |
| `artifacts.canvas.checklistPlaceholder` | `New item` | `Új elem` |
| `artifacts.canvas.checklistAdd` | `Add item` | `Elem hozzáadása` |
| `artifacts.canvas.checklistRemove` | `Remove item` | `Elem törlése` |
| `artifacts.canvas.checklistToggle` | `{name}: toggle done` | `{name}: kész állapot váltása` |
| `artifacts.canvas.photoEmpty` | `No photos in this block.` | `Ebben a blokkban nincsenek fényképek.` |
| `artifacts.canvas.zoom` | `Zoom` | `Nagyítás` |
| `artifacts.canvas.zoomIn` | `Zoom in` | `Nagyítás` |
| `artifacts.canvas.zoomOut` | `Zoom out` | `Kicsinyítés` |
| `artifacts.canvas.fitView` | `Fit to view` | `Illesztés a nézetbe` |
| `artifacts.canvas.blockCount` | `{count} blocks` | `{count} blokk` |
| `artifacts.canvas.emptyBoard` | `Empty board. Insert a block or draw on it.` | `Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.` |

Slice 6 reuses these: the Canvas tour's empty state is `artifacts.canvas.emptyBoard`'s one-line summary
form, and the tour's copy lives in the tour content table, not here.

---

## File ownership

Paths follow `plan.md`'s hot-file table and Slice 0/1/2, which all use
`src/lib/components/artifacts/` (**plural** — ruling 15, and the `ArtifactBodyProps` / panel contracts in
`slice-0.md`, `slice-1.md` and `slice-2.md`). A **shared** row names who lands first.

| File | Change | Shared |
|---|---|---|
| `package.json`, `package-lock.json` | add `@xyflow/svelte` 1.7.0, `@xyflow/system` 0.0.83, `perfect-freehand`, `html-to-image` 1.11.11 | no |
| `src/lib/shared/artifacts/canvas.ts` | create — the body types, `StoredCanvasNode` / live `CanvasNode` split | no |
| `src/lib/shared/artifacts/comments.ts` | create — `CommentAnchor`, `AnchorResolution`, `AnchorResolver`, `CommentThread` (ruling 11) | **yes** — Slice 1 consumes; land the type file **once, first**, here, because Slice 3 needs both the types and the Canvas resolver |
| `src/lib/shared/artifacts/sources.ts` | create **only if** Slice 5 has not landed `ArtifactSource` yet; a type-only re-export, never a second shape | **yes** — Slice 5 |
| `src/lib/components/artifacts/canvas/CanvasEditor.svelte` + test | create — the panel editor; **accepts `ArtifactBodyProps`** from `src/lib/components/artifacts/artifact-bodies.ts` (`slice-0.md §The panel`) | no |
| `src/lib/components/artifacts/artifact-bodies.ts` | **one line**: `canvas: () => import("./canvas/CanvasEditor.svelte")` | **yes** — Slice 0 creates the file, 1→2→3→4 each append one line, in that order (`plan.md` §Slice order, dependencies and parallelism) |
| `src/lib/components/artifacts/canvas/CanvasBoard.svelte` | create — the `SvelteFlow` host, its lowercase event props, reparent + edge pruning, the tween, the arranging pill | no |
| `src/lib/components/artifacts/canvas/NodeShell.svelte` | create — the block chrome (icon, title, meta, selection handles, connection anchors on selection) | no |
| `src/lib/components/artifacts/canvas/nodes/{Frame,Sticky,Text,Chart,Checklist,Map,File,App,Photo,LiveWeb}Node.svelte` | create — one per registry row; `ChecklistNode.svelte` is the only one that is not a reuse | no |
| `src/lib/components/artifacts/canvas/CanvasToolbar.svelte` | create — `role="toolbar"`: tools, inks, insert menu, undo/redo, Ask Alfy, export | no |
| `src/lib/components/artifacts/canvas/AnnotationLayer.svelte` | create — the pad, the tools' pointer handling, the bounded undo history | no |
| `src/lib/components/artifacts/canvas/CommentLayer.svelte` | create — board-space pins + the screen-space card + the outside-the-portal catcher | no |
| `src/lib/components/artifacts/canvas/CommentCard.svelte` + test | create — the thread card | **yes** — Slice 1 renders it for the Document's margin threads; declared here, consumed there |
| `src/lib/components/artifacts/RefusalNotice.svelte` | **do not create** — import Slice 1's one shared notice (its T8) at the shared root; a canvas copy would be a second notice | **yes — Slice 1 creates it; this slice is a consumer** |
| `src/lib/components/artifacts/canvas/_lib/*.ts` + tests | create — `pane-rect`, `board`, `annotations`, `poster`, `comments`, `export-png`, `ids`, `block-registry` | no |
| `src/lib/shared/artifacts/ops.ts` + test | create — the generic ops mechanism (ruling 14): an envelope in, per-op `applied` / `refused` out, and it knows nothing about boards | **yes** — Slice 4 is a read-only consumer of it |
| `src/lib/server/services/artifacts/serialize/canvas.ts` + test | create — body ⇄ JSON, `canvasBodyHash`, `MAX_NODES_PER_BOARD`, `MAX_BODY_BYTES` | no |
| `src/lib/shared/artifacts/board-ops.ts` + test | create — the Canvas **vocabulary** (ruling 14): `BoardOp`, `BoardDiff`, the caps, `boardDiffSchema`, `validateBoardDiff`, `applyOp`, the refusal reasons and their label keys | no (Slice 4 adds `deck-ops.ts` beside it) |
| `src/lib/server/services/artifacts/ops.ts` + test | create — the type-dispatching op envelope: ownership, load, the `baseVersionId` check, dispatch, one `updateArtifactBody` call | **yes** — Slice 4 adds the `slides` branch to `OPS_BRANCHES`; do not grow a second route per type (`slice-4.md §Routes`) |
| `src/routes/api/artifacts/[id]/ops/+server.ts` + test | create — thin adapter over the envelope | **yes** — Slice 4 extends, does not duplicate (`slice-4.md §Routes`) |
| `src/routes/api/artifacts/[id]/exports/png/+server.ts` + test | create | no |
| `src/routes/api/artifacts/[id]/blocks/[nodeId]/refresh/+server.ts` + test | create — liveweb/map refresh | no |
| `src/lib/client/api/artifacts.ts` | append — canvas ops, body save, export, refresh calls | **yes** — Slice 0 creates the file; append, do not restructure |
| `src/lib/i18n/artifacts.ts` + test | append — `artifacts.type.*` and `artifacts.canvas.*` | **yes** — Slice 0 creates the file and registers the module/prefix; this slice appends keys only |
| `src/app.css`, `tailwind.config.ts` | the four sticky fills, the map-paper tint, the annotation ink tokens, `--artifact-overlay-z` | no |
| `tests/e2e/artifact-canvas.spec.ts` | create | no |
| `tests/e2e/artifact-canvas-perf.spec.ts` | create | no |
| `tests/e2e/artifact-canvas-mobile.spec.ts` | create | no |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the canvas additions to PART A and the guard list | **yes** — Slice 0 creates it; append the canvas rows (the file already exists in-tree, 669 lines, PART A at the top and the guard at line 486) |
| `scripts/check-artifact-chunks.mjs` + test | create — the lazy-load chunk guard | **yes** — Slice 4's deck editor reuses the same script (it scans by chunk name); keep it parameterised |

**Serialisation, in the order the wave lands:**

1. `src/lib/shared/artifacts/comments.ts` — the type file, once. Slice 3 lands it (it needs the Canvas
   resolver in the same commit); Slice 1 rebases onto it and does **not** create its own.
2. `src/lib/components/artifacts/artifact-bodies.ts` — Slice 0, then 1, 2, **3**, 4, one line each.
3. `src/lib/server/services/artifacts/ops.ts` and the ops route — **this slice creates both**; Slice 4 adds
   a branch to `OPS_BRANCHES`. If Slice 4 somehow lands first, this slice adds the canvas branch to its
   envelope instead of creating a second one.
4. `src/lib/client/api/artifacts.ts`, `src/lib/i18n/artifacts.ts`,
   `src/lib/components/artifacts/artifact-bodies.ts`'s sibling `ArtifactCard.svelte` — append-only, never
   restructured.
5. `CommentCard.svelte` — declared here because Slice 3 needs it; Slice 1 consumes it for the Document's
   margin. Whichever lands first, the other rebases rather than duplicating.

---

## Tasks

### Task T1: The body model and its normaliser

**Files:** `src/lib/shared/artifacts/canvas.ts`, `_lib/board.ts` + `_lib/board.test.ts`,
`src/lib/server/services/artifacts/serialize/canvas.ts` + test
**Test:** unit

**Interfaces:**
- Produces: `CanvasBody`, `emptyCanvasBody()`, `normalizeCanvasBody(raw)`, `boardJson(body)`,
  `canvasBodyHash(canonical)`, `absoluteOf`, `nodeRect`, `frameRect`, `frameAt`.

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a body through boardJson and normalizeCanvasBody unchanged", ...);
it("open → boardJson → normalizeCanvasBody → boardJson produces an identical body hash with no user edit", ...);
it("hashes the same body identically when the library reordered a live node's fields", ...);
it("rounds a float-noise position to the same hash as its rounded twin", ...);
it("drops an unknown node kind and reports it instead of throwing", ...);
it("drops an edge whose endpoint is missing", ...);
it("drops a child whose frame is gone and keeps the child at its absolute position", ...);
it("keeps the first of two nodes with the same id and reports the second", ...);
it("drops Svelte Flow's measured/selected/dragging write-backs from the saved JSON", ...);
it("omits an undefined optional field rather than emitting null", ...);
it("keeps the camera in the body but lets a bare pan leave it unchanged on disk", ...);
it("caps a 5000-point stroke by decimating on distance, not on index", ...);
it("caps the annotation count and reports how many it dropped", ...);
it("tolerates a body with a missing viewport by defaulting to {x:0,y:0,zoom:1}", ...);
it("computes a child's absolute position through two levels of frame nesting", ...);
it("returns the innermost frame containing a point", ...);
it("ignores a node's own frame when hit-testing for reparenting", ...);
it("refuses a body over MAX_NODES_PER_BOARD as a refusal, not a silent truncation", ...);
it("refuses a body over MAX_BODY_BYTES", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas/_lib/board.test.ts \
  src/lib/server/services/artifacts/serialize/canvas.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the shared types, then `board.ts` as pure functions over plain objects. `normalizeCanvasBody` is a
validator, never a thrower: a snapshot is user-editable JSON and can be a version behind. `boardJson` is the
**canonical** serialiser (ruling 12): fixed key order, volatile fields dropped, `undefined` omitted, numbers
rounded to 3 decimals, `annotations: []` kept. Then the serialize module for the server side: it re-uses
`normalizeCanvasBody`, adds `canvasBodyHash` (sha256 over the canonical JSON) and the size caps
(`MAX_NODES_PER_BOARD = 400`, `MAX_BODY_BYTES = 1 MiB`) as refusals rather than silent truncation.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/shared/artifacts src/lib/components/artifacts/canvas/_lib \
  src/lib/server/services/artifacts/serialize
git commit -m "Give the Canvas a body model that survives a reload

A stored board is user-editable JSON and can be a version behind, so the loader
validates instead of trusting: unknown kinds, dangling edges and orphaned
children are dropped and reported rather than crashing the board. Strokes cap by
distance so a long stroke thins instead of losing its end.

The body hash is taken over one canonical JSON form — fixed key order, library
write-backs dropped, positions rounded — because hashing whatever the serialiser
happened to emit would change the hash on a mere open and every later patch would
be refused as a conflict."
```

### Task T2: The board, the registry and the blocks

**Files:** `_lib/block-registry.ts` + test, `CanvasEditor.svelte`, `CanvasBoard.svelte`,
`NodeShell.svelte`, `nodes/*.svelte`, `src/app.css`, `tailwind.config.ts`, `src/lib/i18n/artifacts.ts`,
`src/lib/components/artifacts/artifact-bodies.ts`
**Test:** component + e2e

**Interfaces:**
- Consumes: Slice 0's panel (`CanvasEditor` is the lazy content for `artifactType === "canvas"`, and its
  props are Slice 0's `ArtifactBodyProps`: `{ artifact: { id, kind, title, body }, onDirtyChange?,
  onBodyChange? }` — `slice-0.md §The panel`).
- Produces: every registry row, and `CanvasBoard`'s `onchange` callback that reports a structural change.

- [ ] **Step 1: Write the failing tests**

```ts
// block-registry.test.ts
it("has an entry for every CanvasBlockData kind", ...);
it("accepts every kind's own default data through its own schema", ...);
it("rejects data whose kind does not match the node's kind", ...);
it("marks exactly app, map, photo and liveweb as needing a poster", ...);
it("marks frame, sticky and text as structural", ...);
it("maps every refusal reason to a message key", ...);

// component
it("renders a Chart block through the chat's Chart.svelte with the same props the chat passes", ...);
it("renders a map block through the chat's MapRouteCard.svelte with the same props the chat passes", ...);
it("renders a map block with its inline SVG fallback when tiles are unavailable", ...);
it("ticks a Checklist block on the board and it is still ticked after a reload", ...);
it("does not import the chat's read-only Checklist.svelte into the board", ...);
it("never renders a heavy document previewer inside a file block", ...);
it("renders an app block in an iframe with sandbox=allow-scripts", ...);
it("puts nodrag and nowheel on the app block's frame", ...);
it("shows no redundant 'Note' header on a sticky and no 'Type' glyph on a text block", ...);
it("shows connection anchors only while the block is selected", ...);
it("shows four corner handles on a selected block", ...);
it("renders an unknown stored kind as the blockMissingKind card and keeps it in the body", ...);

// e2e (artifact-canvas.spec.ts)
it("opens a canvas artifact in the panel and paints its blocks", ...);
it("inserts each block kind from the Insert menu", ...);
it("closes the Insert menu on Escape and on a click outside, and returns focus to Insert", ...);
it("keeps the board's own content clear of the toolbar and the minimap", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas
npx playwright test tests/e2e/artifact-canvas.spec.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the registry, then the node components. The load-bearing detail: **Chart and map are reused
unchanged**, the **checklist is not** — `chat/Checklist.svelte:2-6,31` renders `disabled` boxes by owner
decision and `Checklist.test.ts:6,28,39` pins it, so `nodes/ChecklistNode.svelte` is canvas-owned, tickable,
and commits with the board (Contracts → the block registry). The node shell owns everything canvas-specific.
Add the new design tokens to `src/app.css` and `tailwind.config.ts` together (the sticky fills read on both
themes; the prototype's values are `#fdf2c4` / `#d8efe0` / `#dbe7f6` light and `#4a4222` / `#22402f` /
`#24384d` dark, plus a map-paper tint), along with the ink tokens and `--artifact-overlay-z`. Fix the three
chrome findings from `_notes/review.md` in the components rather than in the board: no redundant header on a
sticky, no bare type glyph on text, anchors and handles only on selection, the frame's resize grip only on
selection.

Register the editor in Slice 0's registry — one line in
`src/lib/components/artifacts/artifact-bodies.ts`:
`canvas: () => import("./canvas/CanvasEditor.svelte")`. That line is the only change to a shared file in
this task, and it goes at the end of the `ARTIFACT_BODIES` literal so a rebase is trivial.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `npx vitest run src/lib/components/chat` to prove Chart, MapRouteCard and
Checklist are untouched in behaviour. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas src/lib/components/artifacts/artifact-bodies.ts \
  src/app.css tailwind.config.ts src/lib/i18n
git commit -m "Put a real board in the artifact panel, with blocks that are the chat's own

The chart and the map are the chat's components, imported rather than
reimplemented. The checklist is not: the chat's checklist renders read-only
disabled boxes by owner decision, so a board tick would do nothing — the board
gets its own tickable node whose ticks commit with the board. What is
canvas-specific — no chrome, anchors on selection, the insert menu — lives in the
node shell. Chart.js and MapLibre keep loading only when their block mounts."
```

### Task T3: Frames, reparenting and connectors

**Files:** `nodes/FrameNode.svelte`, `CanvasBoard.svelte`, `_lib/board.ts`, `_lib/board.test.ts`,
`src/lib/client/api/artifacts.ts`
**Test:** unit + e2e

**Interfaces:**
- Consumes: `absoluteOf`, `frameAt`, `nodeRect`, `saveCanvasBody` (Slice 1's route, `{ body, expectVersion }`).
- Produces: `reparentOnDrop(node, all, measured) → { parentId?, position, extent } | null` (a pure function
  in `_lib/board.ts`, so the hit test is unit-testable without a browser).

- [ ] **Step 1: Write the failing tests**

```ts
it("adopts a node whose centre is inside a frame", ...);
it("re-bases the adopted node's position to be frame-relative", ...);
it("releases a node dragged fully out of its frame and keeps its absolute position", ...);
it("does nothing when an unparented node is dropped outside every frame", ...);
it("never adopts a frame into another frame", ...);
it("chooses the innermost frame when two frames overlap", ...);
it("does not adopt a node into the frame it is already in", ...);
it("clears a stale extent when the node leaves its frame", ...);

// e2e
it("drags a note into the Friday frame and the parentId lands in the board JSON", ...);
it("drags it back out and the parentId is gone", ...);
it("produces exactly one edge per handle drag", ...);
it("deleting a selected node removes its edges and nothing else", ...);
it("a checkbox inside a marquee-selected node is still clickable", ...);
it("double-clicking a selected sticky still opens its editor", ...);
it("a reparent is a version: the version count grows by exactly one", ...);
it("a reparent built on a stale version shows the conflict line and keeps the drag undone", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas/_lib/board.test.ts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "frame|edge|marquee"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `reparentOnDrop` as a pure function, then wire it to **`onnodedragstop`** (lowercase; a comment in the
file must say what `onnodeDragStop` does instead — nothing, silently). Add `onbeforeconnect` stamping the
edge id, and `ondelete` pruning exactly the reported ids and re-deriving dangling edges. Add the
`.svelte-flow__selection-wrapper { pointer-events: none }` global, with the reason.

A reparent is a structural change: persist it through the panel's own save path — `saveCanvasBody(id,
boardJson(body), version)` in `src/lib/client/api/artifacts.ts` — with a summary of the shape
`"Moved a note into Friday"`. A `version_conflict` keeps the in-memory board and shows
`artifacts.canvas.saveConflict`; it never silently re-saves on top.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas src/lib/client/api/artifacts.ts
git commit -m "Make frames actually adopt what you drop in them

Svelte Flow moves a child with its parent and honours parentId, but it never
adopts: the hit test and the parentId rewrite are ours. The handler is on
onnodedragstop, because the camelCase spelling is accepted as an unknown prop
and silently never fires. Edges stamp their id in onbeforeconnect, since v1
adds the edge itself before it calls back."
```

### Task T4: The drawing layer

**Files:** `AnnotationLayer.svelte`, `_lib/annotations.ts` + test, `CanvasToolbar.svelte`,
`_lib/pane-rect.ts` + test
**Test:** unit + component + e2e

**Interfaces:**
- Consumes: `visibleBoardRect`, Svelte Flow's `useSvelteFlow()` for the live viewport.
- Produces: a committed `Annotation[]` in the body, and a bounded undo/redo history.

- [ ] **Step 1: Write the failing tests**

```ts
// pane-rect.test.ts
it("returns the visible board rect for a panned and zoomed camera", ...);
it("returns an all-zero rect before the pane is measured", ...);
it("inflates by the margin in board units, not screen units", ...);

// annotations.test.ts
it("falls back to a capsule for a two-point flick perfect-freehand cannot outline", ...);
it("leaves a mark for a single-point click with the pen", ...);
it("hit-tests a rect on its stroke and not on its fill", ...);
it("picks the newest annotation when two overlap", ...);
it("translates a stroke, a shape and a text annotation alike", ...);

// component
it("leaves the pad at pointer-events: none while Select is active", ...);
it("renders the layer above a node that lives inside a frame", ...);
it("is exactly one tab stop and announces itself", ...);
it("undoes one gesture, not one point", ...);
it("caps the history and drops the oldest step", ...);
it("never puts node, edge or comment changes into the annotation history", ...);

// e2e
it("draws a pen stroke and it lands in the board JSON in board coordinates", ...);
it("keeps the stroke glued to its block across a zoom", ...);
it("does not pan the board while the pen is active", ...);
it("erases a whole annotation with a drag over it", ...);
it("places a text annotation and edits it", ...);
it("moves the camera when the Select tool marquee-drags", ...);
it("pinches with two fingers on empty board and zooms", ...);
it("does not zoom or move a node when the pinch starts on a block", ...);
it("keeps the pad covering at least 95% of the pane at fit view", ...);   // the trap, as a gate
it("reloads the board and every stroke is still where it was drawn", ...); // ids after reload
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas/_lib/pane-rect.test.ts \
  src/lib/components/artifacts/canvas/_lib/annotations.test.ts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "draw|pen|erase|pinch"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Port `annotations.ts` from the prototype with the three documented changes (shared id minting, the ink
token, the caps). Render through `<ViewportPortal target="front">` with `z-index: 2` and **styles declared
on the portal content**. Size the pad from `visibleBoardRect(paneSize, viewport)` with `paneSize` measured
from `.svelte-flow__pane` by a `ResizeObserver`. Wire the toolbar (one tab stop per button, `aria-pressed`,
`:focus-visible` outlines) and the bounded history. `Escape` returns to Select and is the same Escape that
closes the panel only when the layer is not focused — the layer consumes it first.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then the pad-coverage check:
`npx playwright test tests/e2e/artifact-canvas-perf.spec.ts -g "pad coverage"`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas
git commit -m "Draw on the board, in board coordinates, above the frames

Strokes are board points inside a ViewportPortal, so they stay glued to what
they were drawn on and land in the PNG with no second render path. The pad is
sized from the visible pane rather than the portal's box: measured on a
163-note board at fit view, an inset:0 pad caught 6 of 144 sample points and the
board silently stopped being drawable when the camera zoomed out."
```

### Task T5: Comment pins on the shared layer

**Files:** `CommentLayer.svelte`, `CommentCard.svelte` + test, `_lib/comments.ts` + test,
`src/lib/shared/artifacts/comments.ts`, `src/lib/client/api/artifacts.ts`
**Test:** unit + integration + e2e

**Interfaces:**
- Consumes: Slice 0's comment routes and service (`POST /api/artifacts/[id]/comments`,
  `.../comments/[commentId]/resolve`, `.../comments/[commentId]/alfy` — `slice-1.md §Service and routes`).
- Produces: `CommentCard.svelte`, `src/lib/shared/artifacts/comments.ts` (`CommentAnchor`,
  `AnchorResolution`, `AnchorResolver`, `CommentThread`) and `canvasAnchorResolver` for Slice 1.

- [ ] **Step 1: Write the failing tests**

```ts
it("pins a node thread at the node's top-right corner", ...);
it("pins a point thread at its board coordinates", ...);
it("marks a thread orphaned when its node is gone and draws no pin for it", ...);
it("resolves a node anchor as exact while its node exists", ...);
it("resolves a point anchor as moved rather than orphaned", ...);
it("resolves a node anchor as orphaned with reason node_missing", ...);
it("numbers pins by list position and keeps a resolved thread's number", ...);
it("prints ? for an id the list does not know, rather than pin 0", ...);
it("detects an @Alfy mention case-insensitively", ...);
it("is pure: the same anchor and body resolve identically twice", ...);   // ruling 11

// component (CommentCard.svelte — shared with Slice 1)
it("renders the author, the body and every reply", ...);
it("calls onReply with the typed text", ...);
it("calls onResolve and renders the resolved state", ...);
it("renders the orphaned row instead of the anchor when the anchor is gone", ...);

// integration
it("creates a node-anchored thread through the comment route and reads it back", ...);
it("refuses a comment on another user's artifact", ...);
it("keeps a text anchor and a node anchor on the same artifact without collision", ...);
it("refuses a text anchor on a canvas artifact at intake", ...);   // the resolver's `kinds` list
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas/_lib/comments.test.ts \
  src/lib/components/artifacts/canvas/CommentCard.test.ts src/routes/api/artifacts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Declare the shared anchor/thread types and the canvas resolver (ruling 11: the interface is shared, the
resolution is per type — the canvas never resolves a `text` anchor and the Document never resolves a `node`
anchor). Then the layer: pins in board space through the portal (z-index 2), the open card in **screen
space** next to the pin (a board-space card is ~83 CSS px wide at 36 % zoom), and a click-to-place catcher
rendered **outside** the portal, where `inset: 0` really is the pane. Wire the card's `@Alfy` action into
the same application path as Task T6.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then
`npx playwright test tests/e2e/artifact-canvas.spec.ts -g "comment"`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas src/lib/shared/artifacts/comments.ts \
  src/lib/client/api/artifacts.ts
git commit -m "Pin comments to blocks and to points, on the shared comment layer

A pin is a board-space mark so it stays where it was left; the open thread is a
screen-space card so it is still readable at the phone's fit zoom, where a
board-space card is about 83 pixels wide. The click-to-place catcher is outside
the portal on purpose: there inset:0 really is the pane, and a pad sized to the
board's box is the bug this slice spends a whole test on.

The anchor types are the one shared comment interface; the canvas supplies only
the node-and-point resolver, so the Document's text anchors are not resolved
twice by two different rules."
```

### Task T6: The BoardDiff path and the arranging pill

**Files:** `src/lib/shared/artifacts/board-ops.ts` + test, `src/lib/shared/artifacts/ops.ts` + test,
`src/lib/server/services/artifacts/ops.ts` + test,
`src/routes/api/artifacts/[id]/ops/+server.ts` + test, `CanvasBoard.svelte`,
`src/lib/client/api/artifacts.ts`
**Test:** unit + integration + e2e

**Interfaces:**
- Produces: `boardDiffSchema`, `validateBoardDiff`, `applyOp`, the envelope `applyArtifactOps(...)` and the
  route `POST /api/artifacts/[id]/ops → { ok, version, applied, refused }`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit
it("refuses an op touching an id the board does not have", ...);
it("accepts an op touching an id the same batch created earlier", ...);
it("refuses a child whose frame is created later in the same batch", ...);
it("refuses update_node.data.kind that differs from the stored kind", ...);
it("refuses a frame parented to its own descendant", ...);
it("refuses a frame parented to itself", ...);
it("refuses a whole batch over the op cap, without applying part of it", ...);
it("refuses a batch that would exceed the node cap", ...);
it("applies the rest when one op in the batch is refused", ...);
it("returns one refusal per rejected op, in batch order", ...);
it("maps every refusal reason to a key, exhaustively", ...);
it("separates structural ops from moves and reports highlighted ids", ...);

// integration
it("persists an accepted diff as one alfy version with the diff's summary", ...);
it("refuses a diff against a stale baseVersionId with a 409", ...);
it("404s an artifact that belongs to another user", ...);
it("404s an unknown artifact id, not 403", ...);
it("never writes a diff into an incognito artifact from another conversation", ...);
it("refuses a diff whose artifact kind has no branch, with a 400", ...);
it("leaves the board untouched when every op is refused", ...);

// e2e
it("shows the arranging pill for the whole gesture", ...);
it("lands the structural changes before the moves tween", ...);
it("highlights the touched nodes and clears the highlight", ...);
it("lists the skipped ops when a diff is partly refused", ...);
it("ignores a second diff while one is being applied", ...);
it("disables Ask Alfy while a diff is being applied", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/shared/artifacts/board-ops.test.ts src/lib/shared/artifacts/ops.test.ts \
  src/lib/server/services/artifacts/ops.test.ts src/routes/api/artifacts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "arrang"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the schema and validator, then the **type-dispatching envelope** in
`src/lib/server/services/artifacts/ops.ts` (auth is the route's job; the envelope owns ownership → load →
dispatch on `kind` → validate → one version row → respond), then the thin route. Then the client path in the
documented order: pill, server round-trip, structural ops, `tick()`, tween, highlight, clear, notice.

Slice 4 adds the `slides` branch to `OPS_BRANCHES` in a later commit; leave the seam obvious and the
`canvas` branch self-contained.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas src/lib/server/services/artifacts/ops.ts \
  src/routes/api/artifacts src/lib/client/api/artifacts.ts
git commit -m "Let Alfy rearrange the board, one validated op at a time

Ids are addresses, not hints: an op touching a missing id is refused rather than
guessed, and the rest of the batch still applies, so a partly-applied diff is
still a coherent board. The client never applies an unvalidated diff — the
server decides, the client animates what came back.

The op endpoint is a type dispatch, not a Canvas endpoint: the envelope loads,
dispatches on the artifact kind and writes one version row, so Slides can add a
branch without a second route that would drift from this one."
```

### Task T7: Posters, PNG export and the refresh action

**Files:** `_lib/poster.ts` + test, `_lib/export-png.ts` + test,
`src/routes/api/artifacts/[id]/exports/png/+server.ts` + test,
`src/routes/api/artifacts/[id]/blocks/[nodeId]/refresh/+server.ts` + test, `CanvasToolbar.svelte`
**Test:** unit + integration + e2e

- [ ] **Step 1: Write the failing tests**

```ts
it("substitutes a placeholder card for a block with no poster", ...);
it("names every block that was drawn as a still image", ...);
it("restores the camera even when the capture throws", ...);
it("unmounts every poster after a failed export", ...);
it("clamps the output between 800x600 and 2400x1800", ...);
it("stores the capture as a generated file and links it to the canvas", ...);
it("refuses an export for another user's artifact", ...);
it("refuses an export whose data URL is not a PNG, with a 415", ...);
it("re-runs the live-web read and writes the new sources back as an update_node", ...);
it("marks a liveweb block stale past its freshness window", ...);
it("leaves the stored snapshot when a refresh fails, with a 422", ...);

// e2e
it("exports a board and the PNG contains the chart's own colour", ...);
it("exports an app block as its poster, not as an empty box", ...);
it("warns when a block had no poster", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifacts/canvas/_lib/export-png.test.ts src/routes/api/artifacts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "export"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `poster.ts`, `export-png.ts` and the two routes. The PNG scan in the e2e looks for the chart's
violet `rgba(140, 40, 190, .9)` — the same trick the prototype used, because a canvas bitmap either
survived the `foreignObject` clone or it did not, and scanning for a colour nothing else on the board uses
is how that gets measured rather than assumed.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifacts/canvas src/routes/api/artifacts
git commit -m "Export the board as a PNG, with a still image where a live block cannot go

A foreignObject clone has no frame document and no canvas bitmap, so an app or a
map would ship as an empty box and nobody would notice. Those blocks carry a
poster, the export substitutes it, and the result names every block that was
drawn as a still image instead of quietly shipping a blank."
```

### Task T8: The perf budget and the lazy-load guard

**Files:** `tests/e2e/artifact-canvas-perf.spec.ts`, `scripts/check-artifact-chunks.mjs` + test
**Test:** perf (a gate)
**Not owned here:** the pad-coverage assertion's *implementation* lands in Task T4 (it is the trap's own
test); this task adds the structural budgets, the recorded sweep and the chunk guard.

- [ ] **Step 1: Write the failing tests**

```ts
it("holds the board's canonical JSON under 512 kB at 150 notes and 200 strokes", ...);   // CI, structural
it("keeps exactly 150 nodes and 200 annotations through a normalise round trip", ...);   // CI, structural
it("keeps the drawing pad covering at least 95% of the pane at fit view", ...);          // CI, structural
it("keeps the average frame time under the generous ceiling of 40 ms", ...);             // CI, structural
it("commits a stroke end-to-end in under 8 ms", ...);                                    // CI, structural
it("keeps the canvas editor chunk under 65 kB gzip", ...);                               // CI, structural
it("does not grow the chat route chunk by more than 2 kB", ...);                         // CI, structural
it("does not statically import Chart.js or MapLibre from the canvas editor graph", ...); // CI, structural
it("prints the measured average, p95 and derived fps for the record", ...);              // local, reported
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run build
npx playwright test tests/e2e/artifact-canvas-perf.spec.ts
npx vitest run scripts/check-artifact-chunks.test.ts
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

The sweep follows the prototype's `measureBoard()`
(`_components/PrototypeCanvas.svelte`): 80 `requestAnimationFrame` deltas while a scripted viewport pan runs,
the first 8 discarded as warm-up, reporting avg, p95 and fps. The **CI assertions are the structural ones
only**; the fps figure is printed and pasted into the PR body (ruling 9 — a shared runner cannot honestly
assert 60 fps, and a green CI run must not be read as "60 fps was proven"). The chunk guard follows
`scripts/check-built-worker-assets.mjs`: scan `build/client/_app/immutable/` for the chunk that contains
`CanvasEditor`, sum its gzip size, walk its static-import closure for Chart.js/MapLibre, and assert the chat
route's own chunk did not grow. Keep the script parameterised by chunk-name substring so Slice 4's deck
editor reuses it.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS, with the measured numbers printed.

- [ ] **Step 5: Commit**

```
git add tests/e2e/artifact-canvas-perf.spec.ts scripts/check-artifact-chunks.mjs \
  scripts/check-artifact-chunks.test.ts package.json
git commit -m "Hold the board's structural budget in CI, and record the frame time locally

The prototype measured 8.3 ms per frame at 161 nodes, and the number is
DOM-bound: one component instance per node, so it grows linearly. A shared CI
runner cannot honestly assert 60 fps, so CI asserts what is deterministic — board
size, node and stroke counts, pad coverage, chunk sizes, and a frame-time ceiling
with a generous margin — and the fps figure is measured locally and printed. The
pad coverage assertion is the one that matters most: it is the measured form of
the bug where the board stopped being drawable at fit view."
```

### Task T9: i18n, incognito, ownership and the archive

**Files:** `src/lib/i18n/artifacts.ts` + test, `tests/cross-cutting/incognito-artifact-containment.test.ts`,
`src/lib/server/services/account-data-archive/*` + test
**Test:** unit + cross-cutting

- [ ] **Step 1: Write the failing tests**

```ts
it("has both en and hu for every artifacts.canvas key", ...);
it("has both en and hu for every artifacts.type key", ...);
it("never shows the word Artifact in either locale", ...);   // ADR-0066
it("has a message key for every BoardRefusalReason", ...);
it("never lists a canvas made in an incognito chat in the library", ...);
it("never picks a canvas from an incognito chat as evidence elsewhere", ...);
it("refuses to read another user's canvas body, ops, exports or comments", ...);
it("carries canvas bodies, versions and comments into the account archive", ...);
it("erases canvas bodies, versions and comments on account deletion", ...);
it("does not carry board content into any telemetry event", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/i18n.test.ts tests/cross-cutting \
  src/lib/server/services/account-data-archive
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Fill both dictionaries, extend the containment suite's **PART A** behaviours for the canvas (create in
incognito → not in the library, not evidence elsewhere, invisible to a normal chat) and extend **PART B**'s
`ALLOWED_WITHOUT_SCOPE` guard (`tests/cross-cutting/incognito-artifact-containment.test.ts:486,529`) if the
canvas adds a file under `src/lib/server` that queries `artifacts` by user — the guard walks that tree and
fails on an unscoped query, so the canvas's own server files must either go through the scope or be named
with their reason. Then add the archive/erasure coverage for the canvas's rows in
`src/lib/server/services/account-data-archive/`. Incognito's guarantee should already hold through Slice 0's
single scope predicate — if a test fails, the scope is wrong; fix the scope, not the test.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/i18n tests/cross-cutting src/lib/server/services/account-data-archive
git commit -m "Say Tábla in Hungarian, and hold the incognito promise for the board

ADR-0066 keeps the word Artifact out of the interface, so the type is Canvas and
Tábla. The containment suite gains the canvas paths because a board is a second
place a user's content can live, and the promise that an incognito chat is not
remembered has to hold for the new one too."
```

---

## Non-goals

- **No stroke erasing.** The eraser is a drag-to-delete sweep that removes whole annotations; partial erase
  is not in this slice.
- **No annotation layers, grouping, or multi-select.** Annotations are one flat array behind the nodes.
- **No joint selection of nodes and annotations.** A marquee selects nodes; a click selects one annotation.
- **No board-level undo/redo.** Versions are the board-level undo, and that is deliberate: a history that
  covered strokes but not node moves would misdescribe itself. The drawing layer's undo covers exactly one
  gesture of exactly one kind of change, and says so.
- **No real stylus pressure.** `simulatePressure` stays; per-point `p` is reserved and unpopulated.
- **No Canvas PDF export.** PNG only in this slice.
- **No real-time collaboration, presence, sharing, or a comment inbox.** One user, forever (ADR-0066).
- **No canvas-side live web search.** The `liveweb` block stores a snapshot and refreshes through the
  existing read; the block never calls a search provider itself.
- **No `artifact_kv` UI.** Canvas does not use it; it belongs to Apps (Slice 2).
- **No new AI SDK stream part.** A board change arrives through the artifact record, not the stream.
- **No `editable` prop on `chat/Checklist.svelte`,** and no `chat/Checklist.svelte` change at all. The board
  has its own node; the chat's reply stays read-only.
- **No changes to `MapRouteCard.svelte`'s or `Chart.svelte`'s public props** without testing the chat
  callers in the same commit.
- **No new table, no new column, no migration.** Everything the Canvas writes is Slice 0's schema.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The pad is sized from the portal's box | The board silently stops being drawable once the camera zooms out — the failure is invisible at 100 % zoom | `visibleBoardRect` is the only source of the pad's geometry, and the 144-point coverage test fails below 95 % |
| `onnodeDragStop` looks right and does nothing | Reparenting never fires, and no warning is logged | The lowercase prop is in the contract, and an e2e test drags a note into a frame and reads `parentId` out of the board JSON |
| A second edge per handle drag | Boards quietly accumulate doubled edges | The id is stamped in `onbeforeconnect`; the e2e asserts `edges.length` after one drag |
| Portal content styled from its parent | The pen drags nodes instead of drawing | Styles live on portal content; the drawing e2e asserts the camera did not move and the selection did not change |
| Frame children at `z-index: 1` cover the overlays | The pen drags, the pins are unclickable | Explicit `z-index: 2` on both portal layers, with a test that draws over a note inside a frame |
| The board reuses `chat/Checklist.svelte` and the ticks do nothing | A board whose checkbox is `disabled` looks broken, and the "ticks save" promise is false | The checklist node is canvas-owned and tickable; a component test asserts the board never imports the chat's read-only checklist, and `chat/Checklist.test.ts` stays green untouched |
| A board hash changes on a mere open | Every later patch is refused as "you changed this block" (ruling 12's measured prototype failure) | One canonical `boardJson`, and the open → serialise → reload → serialise test asserts an identical hash with no user edit |
| The reused chat components get canvas-shaped props | The chart grows a canvas branch and the chat path drifts | Registry rows pass the chat's own props, with the chat's prop shapes cited at `path:line`; a component test asserts the same props the chat passes |
| Chart.js or MapLibre gets statically imported | The chat route chunk grows by ~475 kB gzip | The chunk guard asserts the canvas editor chunk's size and the chat chunk's delta, and walks the chunk's static-import closure |
| A diff is applied client-side without validation | A malformed op corrupts a board the user cannot undo | `applyBoardDiff` never applies an unvalidated diff; the ops envelope is the only writer |
| Two panes write at once | One silently clobbers the other, and the user's strokes vanish | Every write carries `expectVersion` (body) or `baseVersionId` (ops); a 409 shows `artifacts.canvas.saveConflict` and keeps the user's work in memory |
| Posters are captured but never refreshed | The export shows a stale board inside a fresh one | Capture is re-run on data change and once more before an export that finds a poster missing |
| CI hardware cannot hold 60 fps | The gate fails for a reason the change did not cause | The CI gate asserts structural budgets with a generous timing ceiling; the 60 fps figure is local and recorded (ruling 9), and changing it is an owner decision |
| Two agents land the shared files differently | The Document and the Canvas get two comment shapes, or two op envelopes | `src/lib/shared/artifacts/comments.ts`, `CommentCard.svelte`, `src/lib/shared/artifacts/ops.ts` with its per-type `board-ops.ts` / `deck-ops.ts` vocabularies, and the server `ops.ts` and the ops route each have one declared owner and a named serialisation order; whoever lands second rebases rather than duplicating |
| The body route's payload field is Document-shaped (`markdown`) | A canvas body has nowhere to go, or the route grows a second field per type | Ruling 13 makes the field generic `body` for all five types; Slice 1's Document sends Markdown in it, and there is no per-type spelling and no alias |

## Tests as files

Every trap the parent spec and this slice name has a file and an assertion. "Trap" marks the cases the
brief requires by name.

| Test file | Behaviour it covers | The assertion that proves it |
|---|---|---|
| `_lib/board.test.ts` | the canonical form and the hash (Trap: ids and hashes after reload) | `canvasBodyHash(boardJson(normalizeCanvasBody(JSON.parse(boardJson(sample))).body))` equals the first hash; a float-noise position hashes equal to its rounded twin |
| `_lib/board.test.ts` | a stored body is validated, not trusted | a body with an unknown kind, a dangling edge and an orphan child returns a board with the first and last dropped and a non-empty `dropped` report, and does not throw |
| `_lib/pane-rect.test.ts` | the visible-pane rect (Trap: pointer capture on the canvas) | `visibleBoardRect({width:1280,height:865},{x:-200,y:-100,zoom:1.5})` equals the hand-computed rect; an unmeasured pane returns all zeros |
| `_lib/annotations.test.ts` | stroke geometry, hit testing, ordering | `hitTest` on a rect's interior away from its stroke is false; `pickAnnotation` returns the newest of two overlapping |
| `src/lib/shared/artifacts/board-ops.test.ts` | id-addressed ops (Trap: stale-patch refusal at the op level) | an op naming an id the board does not have is `refused` with `unknown_id` while the batch's other ops land; a batch over the cap is refused whole |
| `src/lib/shared/artifacts/ops.test.ts` | the shared mechanism (ruling 14) | the ops come back in the batch's order with per-op `applied` / `refused`, and the vocabulary it is handed is the only thing it knows about the type |
| `_lib/block-registry.test.ts` | the registry is total over the union | `Object.keys(BLOCK_REGISTRY)` equals every `CanvasBlockData["kind"]`, and `refusalLabelKey` covers every `BoardRefusalReason` |
| `_lib/comments.test.ts` | the shared anchor interface, canvas side (ruling 11) | `canvasAnchorResolver.resolve({kind:"node",nodeId:gone},"…")` is `{state:"orphaned",reason:"node_missing"}`; a `point` anchor always resolves `exact` or `moved`, never orphaned |
| `_lib/export-png.test.ts` | posters and the camera | a rejected `toPng` still leaves `getViewport()` equal to the remembered camera and `unmountPosters` called; `missingPosters` names every placeholder |
| `_lib/poster.test.ts` | poster policy | `needsPoster` is true for exactly app/map/photo/liveweb and false for the rest |
| `CanvasEditor.test.ts` | the panel contract | it accepts `ArtifactBodyProps` and calls `onDirtyChange(true)` after the first edit and `onBodyChange` with the canonical JSON |
| `CanvasBoard.test.ts` | frames and edges (Traps: reparent, double edge, marquee, frame-child z-index) | one `onnodedragstop` over a frame writes exactly one version with `parentId`; one handle drag yields `edges.length === 1`; a click on a checkbox inside a marquee-selected node calls its handler |
| `CommentCard.test.ts` | the shared card | `onReply` receives the typed text; an orphaned thread renders `commentOrphaned` and no anchor row |
| `src/routes/api/artifacts/[id]/ops/ops.test.ts` | ownership and refusal (Trap: ownership) | another user's artifact id → 404 with no version row written; stale `baseVersionId` → 409; a `kind` with no branch → 400 |
| `src/routes/api/artifacts/[id]/exports/png/export-png.test.ts` | export intake (Trap: ownership) | a non-PNG data URL → 415; another user's artifact → 404; a valid capture → one `generated_output` linked to the canvas |
| `src/routes/api/artifacts/[id]/blocks/[nodeId]/refresh/refresh.test.ts` | the refresh path | a failed upstream read → 422 and the stored snapshot is unchanged |
| `src/lib/server/services/artifacts/ops.test.ts` | the envelope's dispatch seam | a registered branch is called once with the loaded body; an unregistered kind returns 400 without a version row (this is the test Slice 4 extends) |
| `src/lib/server/services/artifacts/serialize/canvas.test.ts` | caps as refusals | 401 nodes → refused with `limit_exceeded` and **nothing** written; a 2 MiB body → refused |
| `tests/e2e/artifact-canvas.spec.ts` | the whole board in a browser (Traps: pointer capture, marquee, double edge, reparent, ids after reload) | strokes keep their board coordinates across a zoom; a reload restores every node id and every stroke; the pad's coverage is ≥ 95 % of 144 pane points at fit view; `edges.length` after a handle drag; `parentId` after a drag into a frame |
| `tests/e2e/artifact-canvas-perf.spec.ts` | the split perf gate (Trap: lazy-load chunk sizes) | the structural budgets assert; the fps figure is printed not asserted (ruling 9) |
| `tests/e2e/artifact-canvas-mobile.spec.ts` | 390 px | the toolbar does not take a third of the viewport; the open comment card is inside the viewport and its Reply button is clickable |
| `tests/e2e/artifacts-panel.spec.ts` | the panel integration | opening a canvas artifact mounts `CanvasEditor` lazily and the chat route's chunk did not grow |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | incognito (Trap: incognito) | a canvas created in an incognito chat is absent from the library list and from a later normal conversation's evidence; PART B's guard passes with the canvas's server files either scoped or named |
| `scripts/check-artifact-chunks.test.ts` | the chunk guard (Trap: lazy-load chunk sizes) | the scanner finds the canvas chunk by name, sums its gzip size, and reports Chart.js/MapLibre as absent from its static closure |
| `src/lib/i18n.test.ts` | parity | every `artifacts.canvas.*` and `artifacts.type.*` key exists in both `en` and `hu`, and no value contains "Artifact" |

**Test commands, per task** (each task's Step 2 is the same command it re-runs in Step 4):

```bash
# unit, all canvas modules
npx vitest run src/lib/components/artifacts/canvas
# the server side of this slice
npx vitest run src/routes/api/artifacts src/lib/server/services/artifacts
# the browser side
npx playwright test tests/e2e/artifact-canvas.spec.ts tests/e2e/artifact-canvas-mobile.spec.ts
# the gates
npx playwright test tests/e2e/artifact-canvas-perf.spec.ts
```

## Verification checklist (for the reviewer)

Run these from the worktree, in this order. Every command's **pass** state is stated with its number, so a
reviewer does not have to interpret output.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
```

1. **Typecheck — a gate.** `npm run check` → **0 errors, 0 warnings**. Any new diagnostic is a regression;
   the count is compared against the pre-change run, not against zero alone.
2. **Lint — a gate.** `npx biome check src scripts tests` → clean. (`npm run lint` walks nested biome roots
   under `.claude/worktrees` and dies; check the three paths directly.)
3. **Unit tests — a gate.** `npm test` → green, including `src/lib/i18n.test.ts`'s key parity, every
   `_lib` suite in the table above, and the untouched `src/lib/components/chat/*` suites (Chart,
   MapRouteCard, Checklist).
4. **Build — a gate.** `npm run build` → **0 warnings** from Vite, Svelte, TypeScript or any plugin. Zero,
   not "only the usual ones".
5. **Migrations — a gate.** `npm run check:migrations` → unchanged, because this slice adds no table and no
   column. If it reports anything, the slice grew a schema change it does not own: report it, do not commit
   a migration.
6. **Dead-code/cycle audit — a gate.** `npx fallow --no-cache --format json --quiet --score
   --output-file /tmp/alfyai-fallow.json` → no new findings outside the documented debt, and **no new
   ignores** in `.fallowrc.json`.
7. **E2E — a gate.**
   `npx playwright test tests/e2e/artifact-canvas.spec.ts tests/e2e/artifact-canvas-perf.spec.ts tests/e2e/artifact-canvas-mobile.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts`
   → green. `PLAYWRIGHT_TEST=1` is set by the config; `playwright.config.ts` runs one worker with a 60 s
   timeout, so a board spec that exceeds 60 s is a real failure, not flake.
8. **The trap tests, explicitly.** Name them in the PR body, because they are the ones that fail silently
   if deleted: the pad-coverage assertion, the one-edge-per-drag assertion, the reparent `parentId`
   assertion, the marquee checkbox click, the checklist tick-after-reload, the canonical-hash idempotence.
9. **The recorded numbers.** The perf test's printed avg, p95, derived fps, pad coverage percentage, stroke
   cost and both chunk sizes are in the PR body. CI asserted the structural budgets; the fps figure is the
   local measurement, and the PR says which is which.
10. **Real-app visual check** against `claude-at-home-2-artifact-types-mockups.html` §1 at **1440×900 and
    390×844, light and dark**: the blocks match the mockup's card (no redundant sticky header, no bare type
    glyph, anchors and handles only on selection), the edge labels are styled and above the nodes, the zoom
    chip is inside the `Controls` panel, the phone shows one column of chrome with no overflow at the right
    edge, and every focusable control shows a focus ring.
11. **Staging, real model:** ask for a board ("Put everything for the Vienna trip on one board"), open it in
    the panel, draw a pen stroke and a highlighter stroke, add a sticky, drag it into a frame and back out,
    tick a checklist item **and reload the page to see the tick survive**, pin a comment on a block and one
    on empty board, then ask Alfy to "arrange Saturday" → the pill appears, the moves tween, the highlights
    land, and the version badge reads `v+1 · Alfy` (`v7 · You and Alfy · saved just now` in the mockup's own
    wording — the pill itself is Slice 0's).
12. **Staging:** export the board as PNG → the chart's bars are in the image, the app block is its poster,
    and the notice names any block that was drawn as a still image.
13. **Staging, two panes:** open the same board in the panel, edit it in a second tab, then draw in the
    first → the 409 path shows `artifacts.canvas.saveConflict` and the first tab's strokes are still there.
14. **Staging, on a phone:** open a canvas artifact → the toolbar does not take a third of the viewport, the
    open comment card is readable and tappable, and drawing works with a finger.
15. **Staging:** the same board inside an **incognito** chat is not listed in the Knowledge library and is
    not cited by a later normal conversation.
16. **Staging:** delete the artifact while its panel is open → the next save shows the deleted state and
    stops trying.
17. Read the staging service journal for new warnings.

## Open questions for the owner

1. **(Withdrawn — settled by ruling 1.)** Spec §3's body list mentioned `comments`, the `artifact_comments`
   table and §2.7 make comments one shared table, and the table wins: the body carries
   `{nodes, edges, viewport, annotations}` only. The export reconstructs threads from the record, which is
   one query more than a body copy would be and the correctness the shared layer needs. No decision is
   needed.
2. **Undo covers the drawing layer only.** Board-level undo is artifact versions. If a single Ctrl+Z that
   also reverts the last node move is wanted, that is a different feature (a board-level op log) and it
   changes the version model's role — worth deciding before it is half-built. **Recommendation:** keep the
   split as written; versions are a better undo than a partial history, and the module header says so.
3. **(Narrowed by ruling 9.)** CI no longer asserts 60 fps, so a shared runner cannot fail the build for
   being slow. What remains an owner call is only whether the **local, recorded** figure has a floor at all
   in this feature: the prototype measured 8.3 ms/frame at 161 nodes, and CI asserts a 40 ms ceiling.
   **Recommendation:** record the number in the PR, assert nothing tighter in CI, and revisit only if a
   later node-count increase moves it.
4. **Photo and live-web blocks are new UI**, not reused chat components (the chat has no photo card and no
   live-web card, only a sources list). They follow the same node-shell pattern, but they are the two
   registry rows with the least reuse and therefore the most to review. **Recommendation:** ship them as
   written, with the photo block's lightbox reuse (`chat/ImageLightbox.svelte`) and the live-web block's
   source-list reuse called out in the PR so a reviewer checks those two specifically.
5. **Settled by ruling 13: the body route's payload field is `body`.** Every type's write route takes
   `body` plus `expectVersion`; Slice 1's Document sends Markdown in that field and this slice sends the
   board JSON in the same one. There is no alias and no per-type field name to keep alive.
6. **Settled by ruling 14: one shared mechanism, per-type vocabularies.** This slice creates
   `src/lib/shared/artifacts/ops.ts` (the generic envelope) and the Canvas vocabulary
   `src/lib/shared/artifacts/board-ops.ts`; Slice 4 adds `deck-ops.ts` beside it and changes nothing in the
   shared module. `src/lib/server/services/artifacts/ops.ts` keeps the server-shaped half — ownership, load,
   the `baseVersionId` check, dispatch through `OPS_BRANCHES`, one version row — so Slice 4 **extends** it
   rather than creating it.
7. **Settled by ruling 15: the component directory is `src/lib/components/artifacts/` (plural).** Slices 4
   and 6 used the singular; the review pass corrects them, because a mixed tree would produce two directories
   that each look correct.
