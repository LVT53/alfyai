# Slice 3 — Canvas: the artzfact board inside the panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `plan.md` first. **This slice needs Slice 0** (the `artifacts/` boundary, the panel shell,
> `ArtifactCard.svelte`, the `artifact_versions` / `artifact_comments` / `artifact_kv` tables) and **shares
> the comment layer with Slice 1** (the Document type renders the same threads).

**Goal:** Make `Canvas` a real artifact type: a Svelte Flow board that lives in the artifact panel, carries
the chat's own block components as live nodes, owns its own drawing layer and comment pins, and accepts an
**id-addressed BoardDiff** from Alfy that the user watches land.

**Architecture:** One lazy-loaded panel editor, `CanvasEditor.svelte`, mounted by the artifact panel when the
open artifact's type is `canvas`. All board logic lives in plain modules under
`src/lib/components/artifact/canvas/_lib/` (pure functions over JSON, unit-testable without a browser);
the Svelte components are thin. The board body is JSON in `artifacts.content_text`; **comments are not in
the body** — they are `artifact_comments` rows, the one shared comment feature (§2.7). Frames are real
Svelte Flow group nodes, but **reparenting is app-level**: Svelte Flow does not adopt a node dragged over a
group, so this slice does the hit test and rewrites `parentId` itself. The drawing layer and the comment
pins both render through `<ViewportPortal target="front">` and both size their pointer-capturing surface
from the **visible pane** (`pane-rect.ts`), never from the board's box.

**Tech Stack:** SvelteKit + Svelte 5 runes, `@xyflow/svelte` 1.7.0, `perfect-freehand`, `html-to-image`,
Chart.js 4.5.1 (already a dependency), MapLibre 6.7.0 (already a dependency), `@lucide/svelte`, Vitest,
Playwright.

**Spec:** `docs/plans/claude-at-home-2-artifacts-spec.md` §2 (decisions 12–14, 15, 16), §3 (the record),
§5 (panel/card/sandbox/export), §6 (Slice 3), §7 (perf budget). Decisive ADRs:
[ADR-0066](../../adr/0066-artifacts-are-a-family-of-five-types.md) (the family, "Artifact" is never shown in
the UI), [ADR-0065](../../adr/0065-living-documents-are-edited-in-place.md) (editing in place).
Mockups: `claude-at-home-2-artifact-types-mockups.html` §1 (Canvas),
`claude-at-home-2-artifact-surfaces-mockups.html` §2 (the panel's list) and §3 (one artifact open).
Reference implementation (read it, do not copy it): `src/routes/prototype/canvas/` on the throwaway branch
`proto/artifact-canvas` — `_lib/pane-rect.ts`, `_lib/board.ts`, `_lib/annotations.ts`, `_lib/comments.ts`,
`_components/PrototypeCanvas.svelte`, `_components/PrototypeAnnotationLayer.svelte`,
`_components/PrototypeCommentLayer.svelte`, `_notes/review.md`, `_probe.mjs`.

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
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
npx playwright test tests/e2e/artifact-canvas.spec.ts tests/e2e/artifact-canvas-perf.spec.ts \
  tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts
```

Perf is a gate, not a report: `tests/e2e/artifact-canvas-perf.spec.ts` fails the build below 60 fps on the
150-node + 200-stroke board (Task T8).

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
`dependencies` (not `devDependencies`) and commit `package-lock.json` in the same commit.

### The Canvas body

`artifacts.content_text` holds this JSON, and nothing else about the board:

```ts
// src/lib/shared/artifacts/canvas.ts — client-safe, no server imports.
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

export type CanvasNode = {
	id: string;
	type: CanvasBlockData["kind"];
	position: Pt;
	/** Set only when the node lives inside a frame. Always frame-relative. */
	parentId?: string;
	width?: number;
	height?: number;
	data: CanvasBlockData;
};

export type CanvasEdge = {
	id: string;
	source: string;
	target: string;
	label?: string;
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

**The body deliberately does NOT hold comments.** Spec §3's "Canvas → JSON
`{nodes, edges, viewport, annotations, comments}`" line contradicts §3's own `artifact_comments` table and
§2.7 ("Comments are one shared feature across artifact types"). The table wins: comments are rows, the body
carries nodes, edges, viewport and annotations, and a board that stored its own comment list would give the
shared layer a second source of truth. This is recorded in Open questions.

`ArtifactSource` is the existing web-grounding source shape (`src/lib/server/services/web-grounding.ts`,
consumed client-side through the read model); Slice 5 owns its evidence wiring. If Slice 5 is not merged
yet, declare the type in `src/lib/shared/artifacts/sources.ts` and let Slice 5 move it — do not invent a
second source shape (see Risks).

### The block registry

`src/lib/components/artifact/canvas/_lib/block-registry.ts` is the **one** place kind → component +
validator + default size + poster policy lives. Adding a block kind must not edit the board component.

```ts
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
```

Registry rows for this slice, and what each node reuses:

| kind | reuses | needsPoster | notes |
|---|---|---|---|
| `frame` | — | no | group node; `zIndex: -1`; `dragHandle` is the frame label bar |
| `sticky` | — | no | inline-editable text; the only free-text block |
| `text` | — | no | inline-editable, no chrome |
| `chart` | `chat/Chart.svelte` **unchanged** | no | the node passes `code` exactly as the chat does |
| `checklist` | `chat/Checklist.svelte` **unchanged** | no | ticks write back through `update_node` |
| `map` | `chat/MapRouteCard.svelte` **unchanged** | **yes** | MapLibre needs authed tiles + outbound access; offline-honest fallback is the card's own inline SVG |
| `file` | `FileTypeIcon.svelte` + the shared viewer | no | compact row; clicking opens the shared preview, never an inline heavy renderer |
| `app` | Slice 2's sandbox route in `<iframe sandbox="allow-scripts">` | **yes** | `nodrag` + `nowheel` on the frame |
| `photo` | `ui/ImageLightbox.svelte` | **yes** | `imageUrl` values are the existing authed `/api/connections/immich/thumbnail/{assetId}?connectionId=` proxy URLs |
| `liveweb` | the existing evidence/source list rendering | **yes** | stores a snapshot; refresh re-runs the read |

**Reuse, do not fork:** the Chart and Checklist nodes must pass the same props the chat passes and must not
gain canvas-only props. If a block needs a canvas-only behaviour (no chrome, no delete button), that lives
in the **node shell**, not in the reused component. If a reused component turns out to need a change, the
change lands in the shared component and both callers are tested — never a canvas-local copy.

### The board `_lib` modules (exact signatures)

`src/lib/components/artifact/canvas/_lib/pane-rect.ts`

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

`src/lib/components/artifact/canvas/_lib/board.ts`

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

/** The persisted JSON. Drops Svelte Flow's volatile write-backs
 *  (`measured`, `selected`, `dragging`) so a save is a save. */
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
```

`src/lib/components/artifact/canvas/_lib/board-diff.ts`

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

/** Everything except the position moves (those are tweened). */
export function structuralOps(diff: BoardDiff): BoardOp[];
export function moveOps(diff: BoardDiff): { id: string; to: Pt }[];
export function highlightedIds(diff: BoardDiff): string[];
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
   `MAX_BODY_BYTES` (1 MiB).

`add_frame` is sugar for `add_node` with `type: "frame"`; both are kept because the prototype's model
emitted `add_frame` and the eval suite (Slice 5) scores that vocabulary.

`src/lib/components/artifact/canvas/_lib/annotations.ts`

Carries over from the prototype with these exported names and their behaviour unchanged:
`Pt`, `AnnotationKind` (`"pen" | "highlighter" | "line" | "arrow" | "rect" | "ellipse" | "text"`),
`Annotation` (`{id, kind, color, size, points?, from?, to?, at?, text?}`), `Tool` (the 7 shapes plus
`"select" | "pan" | "eraser" | "comment"`), `DRAWING_TOOLS`, `isDrawingTool`, `INKS` / `DEFAULT_INK`
(four inks: blue `#2f6fd0`, red, green, graphite — the blue is the PNG probe's marker, do not change it
without updating the e2e), `baseSize`, `strokePath` (`getStroke` with `simulatePressure: true`,
`streamline: 0.5`, plus the capsule fallback for a stroke too short for an outline), `dabPath`,
`arrowHead`, `normRect`, `textWidth`, `annotationBounds`, `hitTest`, `translate`,
`pickAnnotation`, `normalizeAnnotations`, `describeAnnotation`.

Changes from the prototype, and only these:

- `nextId` moves to a shared `newId(prefix)` in `_lib/ids.ts` so annotations, nodes and pin replies mint
  ids the same way (`${prefix}-${base36 time}-${counter}`).
- `INK_BLUE` becomes the **token** `--artifact-ink-blue` read at render time; the constant stays as the
  fallback the export probe compares against. (The PNG scan reads the exported bitmap; a token that resolves
  to the same value on both themes is what keeps that assertion stable.)
- `normalizeAnnotations` gains a cap: at most `MAX_ANNOTATIONS_PER_BOARD` (600) and at most
  `MAX_POINTS_PER_STROKE` (1200, decimating by distance, not by index).

`src/lib/components/artifact/canvas/_lib/poster.ts`

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

`src/lib/components/artifact/canvas/_lib/comments.ts`

```ts
import type { CommentAnchor, CommentThread } from "$lib/shared/artifacts/comments";

/** The board-space point a thread's pin sits at: the node's top-right corner,
 *  or the raw point. */
export function pinAt(thread: CommentThread, nodes: readonly CanvasNode[]): Pt | null;

/** A node anchor whose node was deleted: the pin is orphaned, not wrong.
 *  Orphaned threads stay in the list, dimmed, with a "the block is gone" row. */
export function isOrphaned(thread: CommentThread, nodes: readonly CanvasNode[]): boolean;

export function pinLabel(threads: readonly CommentThread[], id: string): string;
export function threadSummary(threads: readonly CommentThread[]): string;
export function mentionsAlfy(body: string): boolean;
```

`src/lib/components/artifact/canvas/_lib/export-png.ts`

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

`src/lib/components/artifact/canvas/_lib/ids.ts` — `newId(prefix: string): string`.

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
  onnodedragstop={({ targetNode }) => targetNode && reparentOnDrop(targetNode as CanvasNode)}
/>
```

`reparentOnDrop(node)`:

1. Ignore `type === "frame"` (frames are never children).
2. Measure the dragged node: `getInternalNode(node.id)?.measured ?? { width: NODE_WIDTH, height:
   DEFAULT_NODE_HEIGHT }`.
3. `const at = absoluteOf(node, nodes)` → the board-absolute top-left; take the **centre**.
4. `const host = frameAt(centre, nodes, node.id)`.
5. If `!host && !node.parentId`, return (nothing to do — do not touch the node, so a nudge inside a frame
   is not rewritten).
6. Otherwise `flow.updateNode(node.id, { parentId: host?.id, position: { x: at.x - origin.x, y: at.y -
   origin.y }, extent: undefined })` where `origin` is `absoluteOf(host)` when adopting and `{x: 0, y: 0}`
   when leaving. Clearing `extent` matters: a stale `extent` from an earlier frame keeps clipping the node
   to a box it no longer belongs to.

Rules that come with it:

- **`zIndex: -1` on frame nodes** so a frame never covers its own children.
- **The frame's drag handle is the label bar only** (`dragHandle: ".artifact-frame__handle"`), so dragging
  inside a frame body does not move the frame out from under its children.
- **Reparenting is a structural change** and therefore a version: it goes through the record boundary's
  `updateBody` with the base version (Task T3), exactly like a text edit.
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

One shared comment feature, three anchor kinds (§2.7), of which this slice owns `node` and `point`:

```ts
// src/lib/shared/artifacts/comments.ts — shared with Slice 1's Document type.
export type CommentAnchor =
	| { kind: "text"; blockId: string; quote: string; prefix?: string; suffix?: string }
	| { kind: "node"; nodeId: string }
	| { kind: "point"; x: number; y: number };

export type CommentThread = {
	id: string;
	anchor: CommentAnchor;
	author: "user" | "alfy";
	body: string;
	replies: { id: string; author: "user" | "alfy"; body: string; at: number }[];
	status: "open" | "resolved";
	createdAt: number;
};
```

This is the **client-side projection** of `artifact_comments` rows (Slice 0 owns the table and the
`comments.ts` service). The column names and the mapping are Slice 0's; this slice must not open its own
queries against `artifact_comments`.

Behaviour:

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
  list, dimmed, with the "the block is gone" row; the pin is not drawn.

### The BoardDiff application path

The model emits a `BoardDiff`; the user watches it land. Both the toolbar's "Ask Alfy" result and the
`@Alfy` comment path go through **one** function:

```ts
async function applyBoardDiff(diff: BoardDiff, label: string): Promise<{ applied: number; refused: …[] }>
```

Order, and this order is the contract:

1. `arranging = true` → the **"Alfy is arranging…" pill** appears (a board-space-free overlay in screen
   space, top-centre, with a pulsing dot and the diff's one-line `summary`).
2. Server round-trip first: `POST /api/artifacts/[id]/ops` with `{ baseVersionId, diff }`. The **server**
   validates against the current body (Contracts → validation rules) and persists the accepted ops as one
   new version with `author: "alfy"` and `summary: diff.summary`. The client never applies an unvalidated
   diff.
3. On acceptance, apply the returned accepted ops **structurally first** (everything except `move`), with
   parents before children in the array; then `await tick()`.
4. Then **tween the moves**: 620 ms, `easeInOut`, one `requestAnimationFrame` loop updating positions, so
   the user sees the board rearrange rather than teleport.
5. Then highlight: each touched node gets `highlight: true` (a token-coloured ring), cleared after 3200 ms.
6. `arranging = false`; the response's `refused[]` renders as one dismissible notice listing what was
   skipped and why, so a partial application is visible rather than silent.

A second `applyBoardDiff` while `arranging` is true returns immediately without queueing: two overlapping
arrangements are incoherent, and the model's second diff will be re-derived server-side from the board it
now sees.

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
  canonical `/api/chat/files/{id}/preview` and `/download` routes and needs no new storage.
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

### PNG export

1. Compute `getNodesBounds` for the board, clamp to `width ∈ [800, 2400]`, `height ∈ [600, 1800]`.
2. `getViewportForBounds(bounds, width, height, 0.2, 2, 0.1)`; remember the camera; `setViewport(next,
   { duration: 0 })`; wait one `requestAnimationFrame`.
3. `mountPosters(missing)` — every poster-needing node's live subtree is swapped for its poster image.
4. `toPng(viewportEl, { backgroundColor: --surface-page, width, height, style: { width, height, transform } })`.
5. Restore the camera and `unmountPosters()` in a `finally`, so a failed export cannot leave the board
   rearranged or half-postered.
6. `POST /api/artifacts/[id]/exports/png` with the data URL (as a blob), receive `{ fileId, width, height }`.
7. The panel shows the stored PNG and offers the canonical download. The export also becomes a
   `generated_output` artifact linked to the canvas, so it appears in the chat card and in the library like
   every other produced file (§5: `produce_file` stays the engine; this is the one client-captured case, and
   the reason is that only the browser has the rendered board).

**PDF export of a Canvas is a non-goal for this slice** (the mockup lists `Canvas → PNG · PDF`; PDF is
derived from the PNG in a later pass, through `produce_file`, and is not on this slice's critical path).

### Perf budget

Measured in CI, on the same runner class, by `tests/e2e/artifact-canvas-perf.spec.ts`:

| Number | Threshold | How it is measured |
|---|---|---|
| frame time, 150 notes + 200 strokes | **avg < 16.6 ms** (60 fps) | 80 `requestAnimationFrame` deltas while a scripted viewport pan runs; the first 8 are dropped as warm-up |
| p95 frame time | < 22 ms, and the measured value is printed | same sweep |
| pad hit-coverage at fit view on a ≥ 150-node board | **≥ 95 %** of 144 sample points across the pane | points at `(i/12, j/12)` of the pane, `document.elementFromPoint`, topmost element is the pad |
| stroke commit cost | < 8 ms per stroke end-to-end | 200 real pointer drags through the input pipeline |
| route chunk, canvas editor | ≤ 65 kB gzip | `scripts/check-built-worker-assets.mjs`-style scan of `build/client/_app/immutable/` |
| route chunk, chat route without an artifact open | unchanged by more than 2 kB gzip | same scan |

Notes the test must print, not hide: the number is **DOM-bound** (one component instance and subtree per
node), so it scales linearly with node count and the thresholds above are only meaningful at the stated
board size. If a CI runner cannot hold 60 fps, the test reports the measured average **and fails**; the
escape hatch is a documented decision by the owner (raise the floor, or move the perf job to a dedicated
runner), never a silently loosened assertion.

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

### i18n

New namespace `src/lib/i18n/artifacts.ts`, spread into `src/lib/i18n/index.ts` beside `instructionsDict`.
Keys are `artifacts.<type>.<thing>`; Slice 0 owns `artifacts.card.*` and `artifacts.panel.*`, Slice 1 owns
`artifacts.document.*`, Slice 4 owns `artifacts.slides.*`. **This slice owns `artifacts.canvas.*` and the
shared `artifacts.type.*` names.**

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
| `artifacts.canvas.arranging` | `Alfy is arranging…` | `Alfy épp rendezi…` |
| `artifacts.canvas.arrangeRefused` | `{count} change(s) were skipped: {reasons}` | `{count} módosítás kimaradt: {reasons}` |
| `artifacts.canvas.refusal.unknown_id` | `nothing is at that position any more` | `már nincs ott semmi` |
| `artifacts.canvas.refusal.duplicate_id` | `that id already exists` | `ez az azonosító már létezik` |
| `artifacts.canvas.refusal.unknown_kind` | `unknown block type` | `ismeretlen blokktípus` |
| `artifacts.canvas.refusal.kind_mismatch` | `a block cannot change type in place` | `a blokk típusa nem változhat meg helyben` |
| `artifacts.canvas.refusal.missing_parent` | `the frame it belongs to is missing` | `hiányzik a keret, amihez tartozna` |
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
| `artifacts.canvas.blockMissingKind` | `This block's type is not supported any more.` | `Ez a blokktípus már nem támogatott.` |
| `artifacts.canvas.nodeDeleted` | `Deleted from the board.` | `Törölve a tábláról.` |
| `artifacts.canvas.saved` | `Saved` | `Mentve` |
| `artifacts.canvas.saveFailed` | `Could not save the board.` | `Nem sikerült menteni a táblát.` |
| `artifacts.canvas.stickyPlaceholder` | `Write a note…` | `Írj egy jegyzetet…` |
| `artifacts.canvas.textPlaceholder` | `Write something…` | `Írj valamit…` |
| `artifacts.canvas.frameName` | `Frame name` | `Keret neve` |
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

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | add `@xyflow/svelte`, `@xyflow/system`, `perfect-freehand`, `html-to-image` at the pinned versions |
| `src/lib/shared/artifacts/canvas.ts` | create — the body types |
| `src/lib/shared/artifacts/comments.ts` | create — shared anchors/threads (**co-owned with Slice 1**; land the type file once, first) |
| `src/lib/shared/artifacts/sources.ts` | create if Slice 5 has not landed the source type yet |
| `src/lib/components/artifact/canvas/CanvasEditor.svelte` + test | create — the panel editor (lazy entry) |
| `src/lib/components/artifact/canvas/CanvasBoard.svelte` | create — the `SvelteFlow` host and its event props |
| `src/lib/components/artifact/canvas/NodeShell.svelte` | create — the block chrome (icon, title, meta, selection handles, anchors-on-selection) |
| `src/lib/components/artifact/canvas/nodes/*.svelte` (frame, sticky, text, chart, checklist, map, file, app, photo, liveweb) | create — one per registry row |
| `src/lib/components/artifact/canvas/CanvasToolbar.svelte` | create — `role="toolbar"`: tools, inks, insert menu, undo/redo, Ask Alfy |
| `src/lib/components/artifact/canvas/AnnotationLayer.svelte` | create |
| `src/lib/components/artifact/canvas/CommentLayer.svelte` | create |
| `src/lib/components/artifact/canvas/CommentCard.svelte` | create — **shared with Slice 1**; the Document's margin threads render this same card |
| `src/lib/components/artifact/canvas/_lib/*.ts` + tests | create — `pane-rect`, `board`, `board-diff`, `annotations`, `poster`, `comments`, `export-png`, `ids`, `block-registry` |
| `src/routes/api/artifacts/[id]/ops/+server.ts` + test | create — the BoardDiff endpoint |
| `src/routes/api/artifacts/[id]/exports/png/+server.ts` + test | create |
| `src/routes/api/artifacts/[id]/blocks/[nodeId]/refresh/+server.ts` + test | create — liveweb/map refresh |
| `src/lib/client/api/artifacts.ts` | extend — canvas ops, export, refresh calls (**Slice 0 creates this file**; append, do not restructure) |
| `src/lib/server/services/artifacts/serialize/canvas.ts` + test | create — body ⇄ JSON, the storage-side validator, `MAX_NODES_PER_BOARD` |
| `src/lib/i18n/artifacts.ts` + test | extend — `artifacts.type.*` and `artifacts.canvas.*` |
| `src/lib/i18n/index.ts` | add the dictionary spread |
| `src/app.css`, `tailwind.config.ts` | the four sticky fills, the map-paper tint, the annotation ink tokens, `--artifact-overlay-z` |
| `tests/e2e/artifact-canvas.spec.ts` | create |
| `tests/e2e/artifact-canvas-perf.spec.ts` | create |
| `tests/e2e/artifact-canvas-mobile.spec.ts` | create |
| `tests/cross-cutting/incognito-artifact-containment.test.ts` | extend — the canvas additions |
| `scripts/check-artifact-chunks.mjs` + test | create — the lazy-load chunk guard, modelled on `scripts/check-built-worker-assets.mjs` |

**Serialisation:** `src/lib/shared/artifacts/comments.ts` and
`src/lib/components/artifact/canvas/CommentCard.svelte` are shared with Slice 1 — land the type file and the
card in **this** slice (Slice 3 needs both) and have Slice 1 consume them; if Slice 1 lands first, this
slice rebases onto its files and does not duplicate them. `src/lib/client/api/artifacts.ts` is Slice 0's
file: append to it. `src/lib/i18n/artifacts.ts` is written by Slice 0 first; append.

---

## Tasks

### Task T1: The body model and its normaliser

**Files:** `src/lib/shared/artifacts/canvas.ts`, `_lib/board.ts` + `_lib/board.test.ts`,
`src/lib/server/services/artifacts/serialize/canvas.ts` + test
**Test:** unit

**Interfaces:**
- Produces: `CanvasBody`, `emptyCanvasBody()`, `normalizeCanvasBody(raw)`, `boardJson(body)`,
  `absoluteOf`, `nodeRect`, `frameRect`, `frameAt`.

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips a body through boardJson and normalizeCanvasBody unchanged", ...);
it("drops an unknown node kind and reports it instead of throwing", ...);
it("drops an edge whose endpoint is missing", ...);
it("drops a child whose frame is gone and keeps the child at its absolute position", ...);
it("keeps the first of two nodes with the same id and reports the second", ...);
it("drops Svelte Flow's measured/selected/dragging write-backs from the saved JSON", ...);
it("caps a 5000-point stroke by decimating on distance, not on index", ...);
it("caps the annotation count and reports how many it dropped", ...);
it("tolerates a body with a missing viewport by defaulting to {x:0,y:0,zoom:1}", ...);
it("computes a child's absolute position through two levels of frame nesting", ...);
it("returns the innermost frame containing a point", ...);
it("ignores a node's own frame when hit-testing for reparenting", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/board.test.ts \
  src/lib/server/services/artifacts/serialize/canvas.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the shared types, then `board.ts` as pure functions over plain objects. `normalizeCanvasBody` is a
validator, never a thrower: a snapshot is user-editable JSON and can be a version behind. Then the
serialize module for the server side: it re-uses `normalizeCanvasBody` and adds the size caps
(`MAX_NODES_PER_BOARD = 400`, `MAX_BODY_BYTES = 1 MiB`) as refusals rather than silent truncation.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/shared/artifacts src/lib/components/artifact/canvas/_lib \
  src/lib/server/services/artifacts/serialize
git commit -m "Give the Canvas a body model that survives a reload

A stored board is user-editable JSON and can be a version behind, so the loader
validates instead of trusting: unknown kinds, dangling edges and orphaned
children are dropped and reported rather than crashing the board. Strokes cap by
distance so a long stroke thins instead of losing its end."
```

### Task T2: The board, the registry and the blocks

**Files:** `_lib/block-registry.ts` + test, `CanvasEditor.svelte`, `CanvasBoard.svelte`,
`NodeShell.svelte`, `nodes/*.svelte`, `src/app.css`, `tailwind.config.ts`, `src/lib/i18n/artifacts.ts`
**Test:** component + e2e

**Interfaces:**
- Consumes: Slice 0's panel (`CanvasEditor` is the lazy content for `artifactType === "canvas"`).
- Produces: every registry row, and `CanvasBoard`'s `onchange` callback that reports a structural change.

- [ ] **Step 1: Write the failing tests**

```ts
// block-registry.test.ts
it("has an entry for every CanvasBlockData kind", ...);
it("accepts every kind's own default data through its own schema", ...);
it("rejects data whose kind does not match the node's kind", ...);
it("marks exactly app, map, photo and liveweb as needing a poster", ...);
it("marks frame, sticky and text as structural", ...);

// component
it("renders a Chart block through the chat's Chart.svelte with the same props the chat passes", ...);
it("ticks a Checklist block and reports the change upward", ...);
it("renders a map block with its inline SVG fallback when tiles are unavailable", ...);
it("never renders a heavy document previewer inside a file block", ...);
it("renders an app block in an iframe with sandbox=allow-scripts", ...);
it("puts nodrag and nowheel on the app block's frame", ...);
it("shows no redundant 'Note' header on a sticky and no 'Type' glyph on a text block", ...);
it("shows connection anchors only while the block is selected", ...);
it("shows four corner handles on a selected block", ...);

// e2e (artifact-canvas.spec.ts)
it("opens a canvas artifact in the panel and paints its blocks", ...);
it("inserts each block kind from the Insert menu", ...);
it("closes the Insert menu on Escape and on a click outside, and returns focus to Insert", ...);
it("keeps the board's own content clear of the toolbar and the minimap", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas
npx playwright test tests/e2e/artifact-canvas.spec.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the registry, then the node components. The load-bearing detail: **the reused chat components are
reused unchanged** — `Chart.svelte`, `Checklist.svelte` and `MapRouteCard.svelte` are imported, not copied,
and the node shell owns everything canvas-specific. Add the new design tokens to `src/app.css` and
`tailwind.config.ts` together (the sticky fills read on both themes; the prototype's values are
`#fdf2c4` / `#d8efe0` / `#dbe7f6` light and `#4a4222` / `#22402f` / `#24384d` dark, and a map-paper tint).
Fix the three chrome findings from `_notes/review.md` in the components rather than in the board: no
redundant header on a sticky, no bare type glyph on text, anchors and handles only on selection, the
frame's resize grip only on selection.

The panel's content area is a lazy `import()` of `CanvasEditor.svelte` (Slice 0 owns the dynamic import
site; this slice owns the module it imports).

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then `npx vitest run src/lib/components/chat` to prove the reused components are
untouched in behaviour. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/canvas src/app.css tailwind.config.ts src/lib/i18n
git commit -m "Put a real board in the artifact panel, with the chat's own blocks on it

The chart, the checklist and the map are the chat's components, imported rather
than reimplemented, so a tick on the board is the same tick the chat makes. What
is canvas-specific — no chrome, anchors on selection, the insert menu — lives in
the node shell, which is why the shared components did not need a canvas-shaped
prop. Chart.js and MapLibre keep loading only when their block mounts."
```

### Task T3: Frames, reparenting and connectors

**Files:** `nodes/FrameNode.svelte`, `CanvasBoard.svelte`, `_lib/board.ts`, `_lib/board.test.ts`,
`src/lib/client/api/artifacts.ts`
**Test:** unit + e2e

**Interfaces:**
- Consumes: `absoluteOf`, `frameAt`, `nodeRect`.
- Produces: `reparentOnDrop(node, nodes, measured) → { parentId?: string; position: Pt } | null` (a pure
  function in `_lib/board.ts`, so the hit test is unit-testable without a browser).

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
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/board.test.ts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "frame|edge|marquee"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `reparentOnDrop` as a pure function, then wire it to **`onnodedragstop`** (lowercase; a comment in the
file must say what `onnodeDragStop` does instead — nothing, silently). Add `onbeforeconnect` stamping the
edge id, and `ondelete` pruning exactly the reported ids and re-deriving dangling edges. Add the
`.svelte-flow__selection-wrapper { pointer-events: none }` global, with the reason.

A reparent is a structural change: persist it through the record boundary as a new version with
`author: "user"` and a summary of the shape `"Moved a note into Friday"`.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/canvas src/lib/client/api/artifacts.ts
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

// e2e
it("draws a pen stroke and it lands in the board JSON in board coordinates", ...);
it("keeps the stroke glued to its block across a zoom", ...);
it("does not pan the board while the pen is active", ...);
it("erases a whole annotation with a drag over it", ...);
it("places a text annotation and edits it", ...);
it("moves the camera when the Select tool marquee-drags", ...);
it("pinches with two fingers on empty board and zooms", ...);
it("does not zoom or move a node when the pinch starts on a block", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/pane-rect.test.ts \
  src/lib/components/artifact/canvas/_lib/annotations.test.ts
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
git add src/lib/components/artifact/canvas
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
- Consumes: Slice 0's comment routes and service.
- Produces: `CommentCard.svelte` and `src/lib/shared/artifacts/comments.ts` for Slice 1.

- [ ] **Step 1: Write the failing tests**

```ts
it("pins a node thread at the node's top-right corner", ...);
it("pins a point thread at its board coordinates", ...);
it("marks a thread orphaned when its node is gone and draws no pin for it", ...);
it("numbers pins by list position and keeps a resolved thread's number", ...);
it("prints ? for an id the list does not know, rather than pin 0", ...);
it("detects an @Alfy mention case-insensitively", ...);

// component (CommentCard.svelte — shared with Slice 1)
it("renders the author, the body and every reply", ...);
it("calls onReply with the typed text", ...);
it("calls onResolve and renders the resolved state", ...);
it("renders the orphaned row instead of the anchor when the anchor is gone", ...);

// integration
it("creates a node-anchored thread through the comment route and reads it back", ...);
it("refuses a comment on another user's artifact", ...);
it("keeps a text anchor and a node anchor on the same artifact without collision", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/comments.test.ts \
  src/lib/components/artifact/canvas/CommentCard.test.ts src/routes/api/artifacts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Declare the shared anchor/thread types, then the layer: pins in board space through the portal (z-index 2),
the open card in **screen space** next to the pin (a board-space card is ~83 CSS px wide at 36 % zoom), and
a click-to-place catcher rendered **outside** the portal, where `inset: 0` really is the pane. Wire the
card's `@Alfy` action into the same application path as Task T6.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command, then
`npx playwright test tests/e2e/artifact-canvas.spec.ts -g "comment"`. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/canvas src/lib/shared/artifacts/comments.ts \
  src/lib/client/api/artifacts.ts
git commit -m "Pin comments to blocks and to points, on the shared comment layer

A pin is a board-space mark so it stays where it was left; the open thread is a
screen-space card so it is still readable at the phone's fit zoom, where a
board-space card is about 83 pixels wide. The click-to-place catcher is outside
the portal on purpose: there inset:0 really is the pane, and a pad sized to the
board's box is the bug this slice spends a whole test on."
```

### Task T6: The BoardDiff path and the arranging pill

**Files:** `_lib/board-diff.ts` + test, `src/routes/api/artifacts/[id]/ops/+server.ts` + test,
`CanvasBoard.svelte`, `src/lib/client/api/artifacts.ts`
**Test:** unit + integration + e2e

**Interfaces:**
- Produces: `boardDiffSchema`, `validateBoardDiff`, the ops route
  `POST /api/artifacts/[id]/ops → { versionId, applied, refused }`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit
it("refuses an op touching an id the board does not have", ...);
it("accepts an op touching an id the same batch created earlier", ...);
it("refuses a child whose frame is created later in the same batch", ...);
it("refuses update_node.data.kind that differs from the stored kind", ...);
it("refuses a frame parented to its own descendant", ...);
it("refuses a whole batch over the op cap, without applying part of it", ...);
it("applies the rest when one op in the batch is refused", ...);
it("returns one refusal per rejected op, in batch order", ...);
it("separates structural ops from moves and reports highlighted ids", ...);

// integration
it("persists an accepted diff as one alfy version with the diff's summary", ...);
it("refuses a diff against a stale baseVersionId with a 409", ...);
it("404s an artifact that belongs to another user", ...);
it("never writes a diff into an incognito artifact from another conversation", ...);

// e2e
it("shows the arranging pill for the whole gesture", ...);
it("lands the structural changes before the moves tween", ...);
it("highlights the touched nodes and clears the highlight", ...);
it("lists the skipped ops when a diff is partly refused", ...);
it("ignores a second diff while one is being applied", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/board-diff.test.ts src/routes/api/artifacts
npx playwright test tests/e2e/artifact-canvas.spec.ts -g "arrang"
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Write the schema and validator, then the route (auth → ownership → load → validate → one version row →
respond), then the client path in the documented order: pill, server round-trip, structural ops, `tick()`,
tween, highlight, clear, notice.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```
git add src/lib/components/artifact/canvas src/routes/api/artifacts src/lib/client/api/artifacts.ts
git commit -m "Let Alfy rearrange the board, one validated op at a time

Ids are addresses, not hints: an op touching a missing id is refused rather than
guessed, and the rest of the batch still applies, so a partly-applied diff is
still a coherent board. The client never applies an unvalidated diff — the
server decides, the client animates what came back."
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
it("re-runs the live-web read and writes the new sources back as an update_node", ...);
it("marks a liveweb block stale past its freshness window", ...);

// e2e
it("exports a board and the PNG contains the chart's own colour", ...);
it("exports an app block as its poster, not as an empty box", ...);
it("warns when a block had no poster", ...);
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx vitest run src/lib/components/artifact/canvas/_lib/export-png.test.ts src/routes/api/artifacts
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
git add src/lib/components/artifact/canvas src/routes/api/artifacts
git commit -m "Export the board as a PNG, with a still image where a live block cannot go

A foreignObject clone has no frame document and no canvas bitmap, so an app or a
map would ship as an empty box and nobody would notice. Those blocks carry a
poster, the export substitutes it, and the result names every block that was
drawn as a still image instead of quietly shipping a blank."
```

### Task T8: The perf budget and the lazy-load guard

**Files:** `tests/e2e/artifact-canvas-perf.spec.ts`, `scripts/check-artifact-chunks.mjs` + test
**Test:** perf (a gate)

- [ ] **Step 1: Write the failing tests**

```ts
it("holds 60 fps with 150 notes and 200 strokes on the board", ...);
it("prints the measured p95 frame time", ...);
it("keeps the drawing pad covering at least 95% of the pane at fit view", ...);
it("commits a stroke end-to-end in under 8 ms", ...);
it("keeps the canvas editor chunk under 65 kB gzip", ...);
it("does not grow the chat route chunk by more than 2 kB", ...);
it("does not statically import Chart.js or MapLibre from the canvas editor graph", ...);
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

The sweep follows the prototype's `measureBoard()`: 80 `requestAnimationFrame` deltas while a scripted
viewport pan runs, the first 8 discarded as warm-up, reporting avg, p95 and fps. The chunk guard follows
`scripts/check-built-worker-assets.mjs`: scan `build/client/_app/immutable/` for the chunk that contains
`CanvasEditor`, sum its gzip size, and assert the chat route's own chunk did not grow.

- [ ] **Step 4: Run them to verify they pass**

Run the Step 2 command. Expected: PASS, with the measured numbers printed.

- [ ] **Step 5: Commit**

```
git add tests/e2e/artifact-canvas-perf.spec.ts scripts/check-artifact-chunks.mjs \
  scripts/check-artifact-chunks.test.ts package.json
git commit -m "Hold the board at 60 fps in CI, and keep the editor out of the chat chunk

The prototype measured 8.3 ms per frame at 161 nodes, and the number is
DOM-bound: one component instance per node, so it grows linearly. The pad
coverage assertion is the one that matters most — it is the measured form of
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
npx vitest run src/lib/i18n.test.ts tests/cross-cutting src/lib/server/services/account-data-archive
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Fill both dictionaries, extend the containment suite's PART A behaviours for the canvas (create in
incognito → not in the library, not evidence elsewhere, invisible to a normal chat), extend PART B's guard
list if the canvas adds a file that queries `artifacts` by user, and add the archive/erasure coverage for
the canvas's rows. Incognito's guarantee should already hold through Slice 0's single scope predicate — if
a test fails, the scope is wrong; fix the scope, not the test.

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
- **No changes to `MapRouteCard.svelte`'s or `Chart.svelte`'s public props** without testing the chat
  callers in the same commit.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| The pad is sized from the portal's box | The board silently stops being drawable once the camera zooms out — the failure is invisible at 100 % zoom | `visibleBoardRect` is the only source of the pad's geometry, and the 144-point coverage test fails below 95 % |
| `onnodeDragStop` looks right and does nothing | Reparenting never fires, and no warning is logged | The lowercase prop is in the contract, and an e2e test drags a note into a frame and reads `parentId` out of the board JSON |
| A second edge per handle drag | Boards quietly accumulate doubled edges | The id is stamped in `onbeforeconnect`; the e2e asserts `edges.length` after one drag |
| Portal content styled from its parent | The pen drags nodes instead of drawing | Styles live on portal content; the drawing e2e asserts the camera did not move and the selection did not change |
| Frame children at `z-index: 1` cover the overlays | The pen drags, the pins are unclickable | Explicit `z-index: 2` on both portal layers, with a test that draws over a note inside a frame |
| The reused chat components get canvas-shaped props | The chart grows a canvas branch and the chat path drifts | Registry rows pass the chat's own props; a component test asserts the same props the chat passes |
| Chart.js or MapLibre gets statically imported | The chat route chunk grows by ~475 kB gzip | The chunk guard asserts the canvas editor chunk's size and the chat chunk's delta, and greps the module graph |
| A diff is applied client-side without validation | A malformed op corrupts a board the user cannot undo | `applyBoardDiff` never applies an unvalidated diff; the ops route is the only writer |
| Posters are captured but never refreshed | The export shows a stale board inside a fresh one | Capture is re-run on data change and once more before an export that finds a poster missing |
| CI hardware cannot hold 60 fps | The gate fails for a reason the change did not cause | The test prints the measured number and fails; raising the floor is an owner decision, not a silent loosening |
| Two agents land `comments.ts` differently | The Document and the Canvas get two comment shapes | The types and `CommentCard.svelte` are declared in this slice and consumed by Slice 1; whichever lands first, the other rebases rather than duplicating |

## Verification checklist

- [ ] Every task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean.
- [ ] `npm test` — green, including the i18n key parity test and `_lib` unit suites.
- [ ] `npm run build` — 0 warnings.
- [ ] `npx fallow --no-cache --format json --quiet --score` — no new findings, no new ignores.
- [ ] `npx playwright test tests/e2e/artifact-canvas.spec.ts tests/e2e/artifact-canvas-perf.spec.ts tests/e2e/artifact-canvas-mobile.spec.ts tests/e2e/artifacts-panel.spec.ts tests/e2e/chat.spec.ts tests/e2e/incognito-indicator.spec.ts` — green.
- [ ] The perf test's printed numbers are in the PR body (avg, p95, pad coverage, stroke cost, chunk sizes).
- [ ] **Real-app visual check** against `claude-at-home-2-artifact-types-mockups.html` §1 at **1440×900 and 390×844, light and dark**: the blocks match the mockup's card (no redundant sticky header, no bare type glyph, anchors and handles only on selection), the edge labels are styled and above the nodes, the zoom chip is inside the `Controls` panel, the phone shows one column of chrome with no overflow at the right edge, and every focusable control shows a focus ring.
- [ ] **Staging, real model:** ask for a board ("Put everything for the Vienna trip on one board"), open it in the panel, draw a pen stroke and a highlighter stroke, add a sticky, drag it into a frame and back out, pin a comment on a block and one on empty board, then ask Alfy to "arrange Saturday" → the pill appears, the moves tween, the highlights land, and the version badge reads `v+1 · Alfy`.
- [ ] **Staging:** export the board as PNG → the chart's bars are in the image, the app block is its poster, and the notice names any block that was drawn as a still image.
- [ ] **Staging, on a phone:** open a canvas artifact → the toolbar does not take a third of the viewport, the open comment card is readable and tappable, and drawing works with a finger.
- [ ] **Staging:** the same board inside an **incognito** chat is not listed in the Knowledge library and is not cited by a later normal conversation.
- [ ] Read the staging service journal for new warnings.

## Open questions for the owner

1. **Spec §3 lists `comments` inside the Canvas body JSON, and also defines an `artifact_comments` table
   with the same fields.** This slice treats the table as authoritative (§2.7 says comments are one shared
   feature) and keeps them out of the body. If the body was meant to be a self-contained snapshot for
   export, say so — the export currently reconstructs threads from the record, which is one query more than
   a body copy would be.
2. **Undo covers the drawing layer only.** Board-level undo is artifact versions. If a single Ctrl+Z that
   also reverts the last node move is wanted, that is a different feature (a board-level op log) and it
   changes the version model's role — worth deciding before it is half-built.
3. **The perf gate runs on the CI runner.** If this box cannot hold 60 fps with 150 notes and 200 strokes,
   the honest options are a dedicated runner or a relative threshold against an empty-board baseline. Both
   are owner calls; this slice fails rather than loosening the number.
4. **Photo and live-web blocks are new UI**, not reused chat components (the chat has no photo card and no
   live-web card, only a sources list). They follow the same node-shell pattern, but they are the two
   registry rows with the least reuse and therefore the most to review.
