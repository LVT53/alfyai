# Canvas agent S3-P · the board body and the ops protocol (Slice 3 T1 + T6's server half)

You build the Canvas's **server/pure core**: the board body model and its canonical hash, the one shared ops mechanism
(ruling 14), the Canvas op vocabulary, the type-dispatching ops envelope, its thin route and its client call. **No UI and
no model tool** — the next two agents build on your exports: S3-B (the board UI) and S3-T (the `create/read/edit_artifact`
handlers for Canvas plus the canvas eval, which advertise *your* schemas to the model). An Opus review will examine this
protocol, so make every rule a test.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3p`, branch
  `feat/artifacts-s3-protocol` (from `feat/artifacts`), e2e port **5400**, label `s3p`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3p-report.md`
- **Agent S4-D runs at the same time** on another branch (`feat/artifacts-slides`): the Slides deck model
  (`src/lib/shared/artifacts/slides*.ts`, `components/artifacts/slides/`, `serialize/slides.ts`), the Slides entry in
  `normal-chat-tools/artifact-tools/create.ts` and `kind-prose.ts`, and `scripts/eval-artifact-contracts/`. Stay out of
  those. Files you both append to — keep your additions in their own block: `services/artifacts/serialize/index.ts`
  (one registry line), `services/artifacts/index.ts` (one export block), `src/lib/i18n/artifacts.ts`.

## Read first

`docs/plans/claude-at-home-2/wave-3/common.md` (rules, gates, report). Rulings (`decisions.md`): 1, 12, 13, 14, 39
(amended: `requireApiUser`, which overrides the spec's `requireAuth` at `slice-3.md:799`), 47, 49, 51, 53, **62, 63, 64**.
`slice-3.md` by range: 9–40 (architecture), 42–82 (constraints), 106–136 (review focus; 7 is yours), 171–360 (the body,
canonical JSON, the hash test), 361–397 (the block registry — read it with ruling 64, which moves the schemas), 584–670
(`board-ops.ts` and the validation order), 740–848 (routes, the envelope, the client call — but see below), 984–1023
(the diff path; you build the server half), 1109–1182 (limits, failure modes), 1390–1463 (T1), 1791–1878 (T6).

## Step 1 · The body model (T1)

- `src/lib/shared/artifacts/canvas.ts` — the body types exactly as the spec's contract (the `StoredCanvasNode` / live
  `CanvasNode` split). `src/lib/shared/artifacts/canvas-blocks.ts` — ruling 64: one zod data schema per block kind,
  the kind list, and the five model-creatable kinds (`frame`, `sticky`, `text`, `checklist`, `chart`) as their own
  exported discriminated union. `map`'s data keeps the existing `ToolCallMapData` shape (type-only import, as the spec
  says); `liveweb` sources reuse the existing web-grounding source shape (spec 295–301), never a second shape.
- Server-imported code lives in `src/lib/shared/artifacts/` (ruling 64's rule, applied to the body too): put the
  canonical serialiser `boardJson` and the validate-never-throw `normalizeCanvasBody` (with its `dropped` report) in
  `src/lib/shared/artifacts/canvas-body.ts`, not under `components/`; `serialize/canvas.ts` re-uses them and adds
  `canvasBodyHash`, `MAX_NODES_PER_BOARD` (400) and `MAX_BODY_BYTES` (1 MiB) as refusals, and registers `canvas` in the
  serializer registry. A canvas version's `body_hash` is the canonical-JSON hash (ruling 12): wire it through the same
  seam the Document uses, so `updateArtifactBody` never hashes raw client JSON.
- Tests: T1's list (1400–1422), including ruling 12's round-trip test verbatim and the float-noise case. The client-only
  geometry helpers (`absoluteOf`, `nodeRect`, `frameRect`, `frameAt`) are built by the board agents who use them;
  create only what a non-test module needs now (Fallow counts an unused export).

## Step 2 · The ops mechanism and the Canvas vocabulary (T6, pure)

- `src/lib/shared/artifacts/ops.ts` — the generic half (ruling 14): parse the `{ baseVersionId, diff }` envelope,
  validate it against a vocabulary the caller hands in, apply the accepted ops in order, return per-op `applied` /
  `refused` with a reason. It knows nothing about boards, has no route, no database handle and no kind union — Slides'
  `deck-ops.ts` will plug into it unchanged.
- `src/lib/shared/artifacts/board-ops.ts` — `boardOpSchema` (a zod discriminated union on `op`, the eight ops of the
  spec's contract), **`boardOpsArraySchema` (min 1, max 40) exported for S3-T to advertise** (ruling 62: the model sees
  exactly what you parse), `boardDiffSchema`, `validateBoardDiff` in the spec's rule order (584–670), `applyOp`,
  `refusalLabelKey` (exhaustive), `structuralOps`, `moveOps`, `highlightedIds`, `BoardRefusalReason`. Ruling 64: an
  `add_node`/`add_frame` whose type is outside the five model-creatable kinds is `unknown_kind`; `update_node` validates
  the merged data against that node's own kind schema. Each refusal carries the op index, the op name and the target id,
  so S3-T can tell the model exactly what to fix.
- Tests: T6's unit list (1806–1818) plus: an `add_node` of `map` is `unknown_kind`; a batch whose later op names an id an
  earlier op removed; the empty diff; a `highlight` naming an id the same batch created.

## Step 3 · The envelope, the route and the client call (T6, server)

- `src/lib/server/services/artifacts/ops.ts` — `applyArtifactOps` (spec 761–797): the facade's ownership scope →
  load → `baseVersionId` check (stale → 409 with the current version) → dispatch through `OPS_BRANCHES` (register
  `canvas`; a kind with no branch is a 400) → validate → **one** `updateArtifactBody` with `author: "alfy"` and
  `summary: diff.summary` → `{ applied, refused }`. When every op is refused, write nothing. Export it from the facade
  (`services/artifacts/index.ts`, its own block): S3-T's `edit_artifact` handler calls it in-process — the envelope is
  the one path for a diff, whether it comes from the tool or the route.
- `src/routes/api/artifacts/[id]/ops/+server.ts` — thin: `requireApiUser`, read the JSON body (size-capped),
  `applyArtifactOps`, map to `{ ok: true, versionId, version, applied, refused }` / `{ ok: false, reason, … }`;
  `?conversationId=` for an incognito item (ruling 51).
- Client: append `applyArtifactOps(artifactId, baseVersionId, diff, conversationId?)` to `src/lib/client/api/artifacts.ts`
  in the file's existing style, and **announce the version it returns** through the file's version announcement
  (`subscribeArtifactChanges`), as `saveArtifactBody` does. Do not add a `saveCanvasBody` (ruling 64): the board saves
  through `saveArtifactBody`.
- Tests: T6's integration list (1821–1827), the route's 401 at the HTTP layer (ruling 19), a foreign and a missing id
  with byte-identical 404 bodies, an incognito item without and with its `conversationId`, and the client call's
  announcement. `tests/cross-cutting/incognito-artifact-containment.test.ts` must stay green with
  `ALLOWED_WITHOUT_SCOPE` unchanged.

## Proof

No UI, so no screenshots. The full gates once at the end (`common.md`), Playwright included — you change no page, but the
artifact suites prove you broke none. In the report's hand-off, list every export S3-B and S3-T will use, with its
signature, and the exact model-facing shape of one valid diff (it becomes S3-T's worked example).
