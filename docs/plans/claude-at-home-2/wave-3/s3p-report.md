# S3-P report · the board body and the ops protocol (Slice 3 T1 + T6's server half)

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3p`, branch `feat/artifacts-s3-protocol`.
Commits `89ecc07d..19f0592b` (5): `3378a971` body model + save seam, `44f08028` ops mechanism + Canvas
vocabulary, `430e27d4` envelope + route + client call, `bc87217d` export trim (Fallow) + facade gate export,
`19f0592b` the review marker (ruling 63) bootstrapped by the envelope.
No UI, no model tool, no migration, nothing outside my files touched (S4-D's files untouched).

## What I built, per step

### Step 1 · the body model (T1)

| File | What |
|---|---|
| `src/lib/shared/artifacts/canvas-blocks.ts` | Ruling 64: one zod schema per block kind (`BLOCK_DATA_SCHEMAS`), `BLOCK_KINDS`, `isBlockKind`, and the five model-creatable kinds as strict variants (`MODEL_CREATABLE_DATA_SCHEMAS`, `MODEL_CREATABLE_KINDS`, `isModelCreatableKind`, `modelCreatableBlockDataSchema` = their discriminated union). `map` mirrors `ToolCallMapData` and the `liveweb` source mirrors `GroundedWebPayloadSource`; a compile-time `Equal<>` pin fails `npm run check` the day either drifts (mutation-checked: I broke `attribution` and saw the error). `CanvasBlockData` is `z.infer` of the schemas, so types and schemas cannot disagree. |
| `src/lib/shared/artifacts/canvas.ts` | The body types (`CanvasBody`, `StoredCanvasNode`/live `CanvasNode`, `CanvasEdge`, `Annotation`, `Pt` + `ptSchema`, `ANNOTATION_KINDS`); re-exports `BlockKind`/`CanvasBlockData`. |
| `src/lib/shared/artifacts/sources.ts` | `ArtifactSource` = type alias of `GroundedWebPayloadSource` (spec 295-301; Slice 5 had not created it). |
| `src/lib/shared/artifacts/canvas-body.ts` | `emptyCanvasBody`, the validate-never-throw `normalizeCanvasBody(raw) → { body, dropped }`, the canonical `boardJson(body)`, and the caps (`MAX_NODES_PER_BOARD` 400, `MAX_BODY_BYTES` 1 MiB, `MAX_ANNOTATIONS_PER_BOARD` 600, `MAX_POINTS_PER_STROKE` 1200). Linear-time frame settling (parent must be an existing frame, cycles broken at the earliest member, parents before children), distance-based stroke decimation. |
| `src/lib/server/services/artifacts/serialize/canvas.ts` | `canvasBodyHash` (= the family's one hasher over the canonical JSON, `hash.ts` says never a second), `prepareCanvasBoard(raw)` (parse, normalise, refuse past caps, canonical JSON + hash + `dropped`), `canvasSerializer`, registered in `serialize/index.ts` (one line). |
| `src/lib/server/services/artifacts/canvas-ops.ts` | `saveCanvasBoard(...)`: the Document's `saveDocumentBody` seam for a board. The body route's new `canvas` branch calls it, so **`updateArtifactBody` never hashes raw client JSON**: it stores `prepareCanvasBoard(...).json` and the row's `body_hash` is `canvasBodyHash` of exactly that string (pinned by a DB test that compares the stored body, the version row's hash and the returned hash). Returns `dropped` counts. |
| `src/routes/api/artifacts/[id]/body/+server.ts` | canvas branch; `invalid_body` answers the existing 400 `invalid_patch`; a save that had to leave something out adds `dropped: {nodes, edges, annotations}` to `{ ok: true, version, bodyHash }` (only when non-zero). The existing test that used `kind: "canvas"` as "a kind with no special path" now uses `app`. |

Tests: T1's whole list (ruling 12's round-trip test verbatim, the reordered-live-fields case, the float-noise case), plus
fixed-point on a hand-edited body, cycles, parents-first, non-frame parents, non-finite numbers, the two URL rules, checklist cap,
stroke cap by distance (5000 points: 4500 lingering + 500 flick keeps ~all of the flick), annotation cap, the 150-note + 200-stroke
budget (`boardJson` ≤ 512 kB, ruling 9), the caps as refusals, the raw-payload guard, and the save seam against a real in-memory DB
(canonical stored, hash pinned, foreign/missing/incognito, stale version, coalescing still works).

### Step 2 · the ops mechanism and the Canvas vocabulary (T6, pure)

| File | What |
|---|---|
| `src/lib/shared/artifacts/ops.ts` | The generic half (ruling 14). No board, no route, no DB, no kind union. `parseOpsEnvelope`, `runOps(vocabulary, doc, rawDiff)`, `OpsVocabulary`, `OpRefusal`, `OpsDiff`. The mechanism enforces the contract itself: every op accounted for (accepted + refused = batch), refusal indices unique and in range, refusals returned in batch order; a vocabulary that breaks it throws. An unreadable diff answers `invalid_diff` with the zod issues by path (`ops[2].node.data.tone: ...`) and always ends with `Valid ops: ...`. Proven with a toy stack vocabulary, so Slides' `deck-ops.ts` can plug in unchanged. |
| `src/lib/shared/artifacts/board-ops.ts` | `boardOpSchema` (the eight ops, described fields), `boardOpsArraySchema` (min 1, max 40), `boardDiffSchema`, `BOARD_OP_NAMES` (derived from the schema), `validateBoardDiff`, `applyOp`, `BOARD_REFUSAL_REASONS`/`refusalLabelKey` (exhaustive switch, i18n-tested in EN+HU), `structuralOps`, `moveOps`, `highlightedIds`, `boardOpsVocabulary`, `BOARD_OPS_EXAMPLE`. |
| `src/lib/i18n/artifacts.ts` | Own block, EN+HU: `artifacts.canvas.invalidDiff` and the nine `artifacts.canvas.refusal.*` (the spec's strings). |

Validation is a simulation: each op is judged against the board as the accepted ops before it left it (`applyOp` is the only mutator), so
"an id an earlier op removed", "a child whose frame comes later", "an id a refused op would have created" all fall out without special
cases. Each refusal carries `index`, `op`, `id` (the target, or the missing end for an edge) and an English `detail` that names what
would have been valid (ids on the board, the five kinds, the fields of the kind, the frames). Sample of what a model reads:
`"map" is not a block you can add. Add one of: frame, sticky, text, checklist, chart.` /
`A text has no field "colour". Fields of text: kind, text.` /
`parentId "nowhere" is not a frame on the board. Frames: frame-a. A frame created in this change must come earlier in the list than what goes inside it.`

Tests (`board-ops.test.ts`, 50): T6's unit list, plus the brief's four (map is `unknown_kind`; a later op naming an id an earlier op removed;
the empty diff; a highlight naming an id the same batch created), plus every reason, the three caps (op count refuses the whole batch
without applying part of it, node cap, 24 new nodes per batch, the byte cap), `applyOp` purity on a deep-frozen board, the JSON schema the
model sees (the five kinds' `const`s present, the other five absent, `maxItems: 40`), and the worked example parsed through the executed schema and landed on a real fixture.

### Step 3 · the envelope, the route and the client call (T6, server)

| File | What |
|---|---|
| `src/lib/server/services/artifacts/ops.ts` | `applyArtifactOps({ userId, artifactId, payload, conversationId?, includeIncognito? })`: ownership scope → load → `baseVersionId` must be the newest version's id (else 409 with the real version) → dispatch through `OPS_BRANCHES` (`canvas` registered; a kind with no branch is 400 `unsupported_kind`) → judge → **one** `updateArtifactBody` (`author: "alfy"`, `summary: diff.summary`, `baseHash` = the hash it read, so a save landing between read and write is a 409 too) → `{ ok, versionId, version, applied, refused, changed }`. **Ruling 63:** the first Alfy write also bootstraps ruling 61's review marker in the same transaction (`metadata.review = { throughVersion: <the version it landed on top of>, keptBlockIds: [] }`, only when absent or invalid; the same shape and rule as `applyDocumentPatch`), so a pending change can survive a reload. A diff that changes nothing (every op refused, or only a highlight / a move to where the node already is) writes nothing and names the current version (`changed: false`). Exported from the facade with its types; S3-T's `edit_artifact` calls it in-process. |
| `src/routes/api/artifacts/[id]/ops/+server.ts` | Thin: `requireApiUser` (401 at the HTTP layer), content-length cap (512 KiB → 413 without reading), `applyArtifactOps`, `{ ok: true, versionId, version, applied, refused, changed }` / `{ ok: false, reason, version?, detail? }`. The 404 body is exactly `{"ok":false,"reason":"not_found"}` for a foreign and a missing id (asserted byte for byte). |
| `src/lib/client/api/artifacts.ts` | `applyArtifactOps(artifactId, baseVersionId, diff, conversationId?, fetchImpl?)`; announces the version through `announceArtifactVersion` (changed just now when `changed`, otherwise the version with no time; the conflict's version with no time). No `saveCanvasBoard`/`saveCanvasBody`: the board saves through `saveArtifactBody`, whose ok-result type gained the optional `dropped`. |

Tests: `services/artifacts/ops.test.ts` (15, real DB: one Alfy version with the diff's summary and canonical body, never merges into the user's
version, partial batches, all-refused / highlight-only write nothing, stale and never-existed base, a save injected between the read and the write is refused and
stands, foreign/missing/incognito/other-conversation, no-branch kind, unreadable diffs, an unreadable stored board), route (11, real DB and two users),
client (8), body route (5 new). `tests/cross-cutting/incognito-artifact-containment.test.ts` is green with `ALLOWED_WITHOUT_SCOPE` unchanged (my service files only go through the facade's scoped reads).

## Gates (all on the final tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (= the pre-existing ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2201 files |
| `npm test` | 922 files passed (1 skipped), 14,386 tests passed (2 skipped); ~168 of them are new |
| `npm run build` | passes (final tree); 32 `Unused CSS selector` + 2 `must have an ARIA role` = baseline, nothing new |
| Playwright (port 5400): every `artifact*.spec.ts`, `artifacts-*.spec.ts`, `knowledge`, `chat`, `conversation` | 177 passed, 0 failed, 0 flaky (8.6 min, one run): all 15 `artifact*.spec.ts`/`artifacts-*.spec.ts` files plus `chat` (11), `conversation` (11), `knowledge` (14). This change touches no page; the run proves no artifact suite broke. It ran on `bc87217d`; the one commit after it (`19f0592b`, the marker) changes only `services/artifacts/ops.ts`, which no e2e path reaches (only the new ops route calls it), and every other gate below was re-run on the final tree. |
| Fallow | 124 issues, 4 circular = baseline exactly; my first run had 4 findings (unused exports `boardOpSchema`, `STICKY_TONES`, and the types `StickyTone`, `PosterRef`), removed in `bc87217d`. Test imports count as use (exports only tests import were not flagged). |
| `npm run check:migrations` | passes unchanged (no migration) |

Screenshots: none (no UI).

## Deviations from the spec, and why

1. **Unknown block kind: dropped and reported** (T1's test list, and the "Tests as files" row), not kept as a `blockMissingKind` card (the failure-modes table and a T2 component test say "kept in the body"). The specs contradict each other; T1 is the one that defines the normaliser. Consequence for S3-B: `blockMissingKind` can only show for a kind that is in `BLOCK_DATA_SCHEMAS` but has no component. Keeping unknown kinds would need a decision on their canonical form (unknown data has no key order); a one-line change in `readNode` if the owner prefers it.
2. **A child whose frame is gone is kept**, taken out of the frame at the position it was stored with, and is NOT in `dropped.nodes` (T1's "keeps the child at its absolute position"; the "Tests as files" row says "dropped"). Reporting it would make S3-B's notice say "left out" about a block that is still on the board.
3. **`remove_node` of a frame moves its children up a level** (to the frame's own parent, or the board) at the place they sat, instead of deleting them. The spec does not say; a frame removed to tidy up should not take a reader's notes with it.
4. **A diff over 40 ops is a 400 `invalid_diff` on the route**, not "200 with the batch refused as `limit_exceeded`" (failure-modes table): ruling 62 puts `max 40` in the schema the model sees, and the schema is what is parsed. `validateBoardDiff` still refuses a whole batch over the cap with one `limit_exceeded` per op for a caller that bypasses the schema.
5. **`add_node`'s `data` is the strict union of the five** (ruling 62 + 64 literally). So `{type: "map", data: {kind: "map", ...}}` is refused by the schema (`invalid_diff`, `ops[0].node.data.kind: not a known kind`), and `unknown_kind` (per op, batch continues, names the five kinds) is what a wrong `type` string with valid data, and every direct `validateBoardDiff` caller, gets. I kept `type: z.string()` (not an enum) so the refusal can name the kinds; making it an enum would make `unknown_kind` unreachable.
6. **Extra response fields**, additive: `changed` on the ops response; `id` and `detail` on each refusal; `detail` on 400s; `dropped` on a canvas body save.
7. **`canvasBodyHash` calls `hashArtifactBody`** instead of the spec snippet's own `createHash` (`hash.ts` and the Document's `hashBody` say the family has one hasher).
8. **`baseVersionId` semantics**: it is compared with the newest version's *id*. A user save that coalesces in place (ruling 47) keeps its version id, so the id check cannot see it; what protects a diff is (a) every op's ids are validated against the CURRENT body, and (b) the write carries `baseHash`, which a coalesced save changes. Documented in the envelope; tested for the injected-save case.
9. **Nested frames are allowed by the protocol** (`add_node` type `frame` with a `parentId`), because rule 8 (`cycle`) and T1's "two levels of frame nesting" assume them, although the contract also says `frameRect` treats frames as top-level. S3-B decides how to draw a nested frame.

Security additions (not in the spec): a photo's `imageUrl` must be a same-origin path (`/...`, not `//`), a `liveweb` source `url` must be http(s). A board is the one place a model can write a URL the browser will fetch on its own, so the schema refuses an address from outside the app; `update_node` goes through the same schemas, so it cannot smuggle one in.

## Open questions

1. **Ruling 63, what is still S3-B's.** The envelope now writes the review marker; the READ side is not built: the touched-node computation (each unreviewed Alfy version's touched node ids against its parent version, from `metadata.review.throughVersion`), the review state route for a canvas (`GET /api/artifacts/[id]/review` answers `not_a_document` for a board today), and the acknowledge write (Keep advances `throughVersion` to the latest Alfy version; Undo writes the parent body back as a user version with `summaryKind: "undid_alfy_change"`). `keptBlockIds` stays `[]` for a board (no per-node Keep in v1).
2. **`update_node` works on every kind (ruling 64), so it can rewrite `fileId` / `artifactId` of an existing file/App node** to another id the same user owns. Foreign URLs are impossible (rules above) and the ids resolve through the owner-scoped routes, so I judge it acceptable; if the owner wants reference fields locked, it is one allow-list per kind in `stepUpdateNode`.
3. **Text limits are drops on save.** The block schemas cap text (label 500, sticky/text 20,000, checklist 200 items × 1,000, chart code 100,000 characters). `normalizeCanvasBody` drops a node past them, and the body route reports it in `dropped`. S3-B must enforce the same numbers at input (`maxlength`) so a paste never loses a block; the constants are module-private now (export what you use, Fallow counts unused exports).
4. **`AGENTS.md`'s Artifacts section** needs a paragraph when Canvas ships (`shared/artifacts/{canvas,canvas-blocks,canvas-body,ops,board-ops}`, `services/artifacts/{ops,canvas-ops}`, the one-envelope rule). I did not touch it (conflict-prone, and it is the orchestrator's merge).

## Expected merge friction with S4-D

- `services/artifacts/serialize/index.ts`: one import + one registry line each; `serialize/index.test.ts`: I changed the "no serializer yet" list to `["app", "slides"]`, S4-D will make it `["app", "canvas"]`; the merge wants `["app"]`.
- `services/artifacts/index.ts`: my block is at the top (before the catalogue block); `i18n/artifacts.ts`: my block is the last of each language.
- `services/artifacts/ops.ts`: S4-D's `slides` branch goes into `OPS_BRANCHES`; nothing else there changes.

## Hand-off

### For S3-B (the board UI)

Import from `$lib/shared/artifacts/...` (all client-safe, no server import at runtime):

- `canvas`: types `CanvasBody`, `CanvasNode` (live), `StoredCanvasNode`, `CanvasEdge`, `Annotation`, `AnnotationKind`, `Pt`, `BlockKind`, `CanvasBlockData`; `ptSchema`, `ANNOTATION_KINDS`.
- `canvas-blocks`: `BLOCK_DATA_SCHEMAS` (kind → zod schema; the registry's `schema` field is `BLOCK_DATA_SCHEMAS[kind]`), `BLOCK_KINDS`, `isBlockKind(v)`, `MODEL_CREATABLE_KINDS`, `isModelCreatableKind`, `MODEL_CREATABLE_DATA_SCHEMAS`, `modelCreatableBlockDataSchema`. Not exported (add when you use them): `STICKY_TONES`, `StickyTone`, `PosterRef`, the text limits.
- `canvas-body`: `emptyCanvasBody(): CanvasBody`, `normalizeCanvasBody(raw: unknown): { body: CanvasBody; dropped: { nodes: string[]; edges: string[]; annotations: string[] } }`, `boardJson(body: CanvasBody): string` (compare THIS, not object identity, before deciding a save is needed; it includes the camera, so a bare pan must not be saved by itself), `MAX_NODES_PER_BOARD`, `MAX_BODY_BYTES`, `MAX_ANNOTATIONS_PER_BOARD`, `MAX_POINTS_PER_STROKE`. `decimateStroke` is module-private; export it if the live pen needs the same rule.
- `board-ops`: `BoardOp`, `BoardDiff`, `BoardRefusal`, `BoardRefusalReason`, `applyOp(body, op): CanvasBody` (pure), `validateBoardDiff(diff, body): { accepted: BoardOp[]; refused: BoardRefusal[] }`, `structuralOps(diff)`, `moveOps(diff): { id: string; to: Pt }[]`, `highlightedIds(diff): string[]`, `refusalLabelKey(reason): string` (keys exist in EN+HU), `MAX_OPS_PER_DIFF`, `MAX_NEW_NODES_PER_DIFF`. The client never needs `validateBoardDiff`; the server decided. To animate a landed diff: `accepted = diff.ops` without the indices in `refused[].index`, then `structuralOps({ops: accepted})`, `tick()`, tween `moveOps(...)`, ring `highlightedIds(...)` plus the ids of the ops that added/moved/updated.
- `ops`: `OpRefusal`, `OpsDiff`.
- Client: `applyArtifactOps(artifactId, baseVersionId, diff, conversationId?, fetchImpl?)` → `ApplyArtifactOpsResult` (`{ok: true, versionId, version, applied, refused, changed}` | `{ok: false, reason: "version_conflict", version}` | `{ok: false, reason: "invalid_diff" | "unsupported_kind" | "not_found" | "too_large", detail?}`). It announces the version itself. **`baseVersionId` is a version ID**: take `versions[0].id` from `fetchArtifact(...)` / `fetchArtifactVersions(...)` (newest first); `saveArtifactBody` returns only a number, so after your own save re-read the ids (or use the `versionId` of the last ops answer).
- Board saves: `saveArtifactBody(id, boardJson(body), expectVersion, conversationId)`; the ok-result may carry `dropped: {nodes, edges, annotations}` (show the `blockDropped` notice).
- Semantics you build on: a node's `position` is frame-relative when `parentId` is set; a frame's size lives on the node AND in `data` (`width`/`height`), the ops keep the two equal, keep them equal when the user resizes; nodes come parents-first; `move`'s `to` is in the node's own space; a highlight changes nothing on the board; a removed frame's children are re-homed up one level keeping their place on screen; text fields are plain text, never render them as HTML.
- Not built (yours): `absoluteOf`, `nodeRect`, `frameRect`, `frameAt`, `reparentOnDrop`, the review-state computation and the acknowledge write (the marker itself is written by the envelope; see open question 1), `defaultDataFor`.

### For S3-T (the three tools + the canvas eval)

- Advertise `boardOpsArraySchema` (`$lib/shared/artifacts/board-ops`) as `ops` (min 1, max 40) in `buildEditArtifactModelInputSchema` when canvas is advertised, and validate with the same object (ruling 62). Measured: its JSON schema is 5.5k characters, about 1.6k tokens (the Document's patches schema is about 0.8k), so budget the catalogue ceiling accordingly (ruling 23's measurement is yours).
- `edit_artifact` handler for canvas: build `{ id: randomUUID(), summary, ops }` and call `applyArtifactOps({ userId, artifactId, conversationId, payload: { baseVersionId, diff } })` from the facade (`$lib/server/services/artifacts`). `baseVersionId` for a model call is the newest version's id: `(await listVersions({ userId, artifactId, conversationId, limit: 1 }))[0].id` (a model has no version id to quote; op-level id validation is its staleness guard). Map `OpsEnvelopeResult`: `ok` → `{ applied, refused, changed }` (tell the model which ops were skipped from `refused[].detail`, it already names what is valid); `invalid_diff` → `detail` names the valid ops; `version_conflict` → re-read and retry once; `unsupported_kind`/`not_found`/`too_large`. If you validate ops yourself before calling (as the Document handler does), `runOps(boardOpsVocabulary, body, diff)` is the same mechanism without the write.
- `create_artifact` handler for canvas: build the board, then `prepareCanvasBoard(JSON.stringify(raw))` (facade; refuses past the caps, returns the canonical `json` and its `hash`) and `createArtifact({ id: artifactId /* Regenerate */, kind: "canvas", body: prepared.json, author: "alfy", versionSummary })`. Never store a body that did not go through `prepareCanvasBoard`/`boardJson(normalizeCanvasBody(...).body)`.
- The exact model-facing shape of one valid diff (`BOARD_OPS_EXAMPLE`, exported and tested; embed `JSON.stringify(BOARD_OPS_EXAMPLE)` so the description cannot drift; the tool's top-level `summary` is the diff's summary). It lands with zero refusals on `sampleBoard()` from `src/lib/shared/artifacts/canvas-fixtures.test-helpers.ts`, which is the fixture body for your ruling-62 test (nodes `frame-a`, `note-1`, `note-museum`, `text-1`, ... and edge `edge-1`):

```json
{
  "summary": "Planned Sunday",
  "ops": [
    { "op": "add_frame", "id": "frame-sunday", "label": "Sunday", "position": { "x": 40, "y": 480 }, "size": { "width": 360, "height": 260 } },
    { "op": "add_node", "node": { "id": "note-brunch", "type": "sticky", "parentId": "frame-sunday", "position": { "x": 20, "y": 60 }, "data": { "kind": "sticky", "text": "Brunch at 10:30", "tone": "yellow" } } },
    { "op": "move", "id": "note-museum", "to": { "x": 500, "y": 140 } },
    { "op": "add_edge", "edge": { "id": "edge-brunch", "source": "note-brunch", "target": "note-museum", "label": "then" } },
    { "op": "update_node", "id": "text-1", "data": { "text": "Weekend plan (updated)" } },
    { "op": "highlight", "ids": ["frame-sunday"] }
  ]
}
```

- Things the description must say (they are what the refusals will otherwise teach one call at a time): the model chooses the ids of what it creates (nodes and edges are separate id namespaces, at most 128 characters); a node goes inside a frame with `parentId`, the frame must be created EARLIER in the list, and `position` is then relative to the frame's top-left corner; `type` must equal `data.kind` and be one of frame, sticky, text, checklist, chart (a map, file, App, photo or web block cannot be added by the model, only moved, updated or removed); a sticky needs `tone` (yellow, mint, blue, plain), a checklist item needs `id`, `text`, `done`; `update_node.data` holds only the fields to change and cannot change `kind`; at most 40 ops and 24 new nodes per change; an op naming an id that does not exist is skipped and the rest still apply.
- `read_artifact` for canvas can return `boardJson(body)` (every node and edge already carries its id); `canvasSerializer` is registered (`getArtifactSerializer("canvas")`).
- The refusal `detail` strings are English on purpose (model-facing); the reader's language comes from `refusalLabelKey(reason)`.
