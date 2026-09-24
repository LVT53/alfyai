# Feature 2 · Artifacts — implementation spec

Owner decisions 2026-09-24, recorded in [ADR-0066](../adr/0066-artifacts-are-a-family-of-five-types.md),
which **amends** [ADR-0065](../adr/0065-living-documents-are-edited-in-place.md): that ADR's rule reversal
(editing in place) still stands, and Living Documents become the **Document** type of a five-type family.
Feature 2 is the second item of
[ADR-0064](../adr/0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md).

Feasibility evidence (all three prototypes found the work doable):
[`claude-at-home-2-prototype-findings.md`](./claude-at-home-2-prototype-findings.md), with throwaway
branches `proto/artifact-apps-quality`, `proto/artifact-document-editor-r2`, `proto/artifact-canvas-agent`.
Design target: [`claude-at-home-2-artifacts-mockups.html`](./claude-at-home-2-artifacts-mockups.html) (App,
File) and [`claude-at-home-2-artifact-types-mockups.html`](./claude-at-home-2-artifact-types-mockups.html)
(Canvas, Document, Slides).

## 1. What an artifact is

An artifact is something AlfyAI makes that lives **beside** the conversation, keeps its state, and that both
the user and Alfy edit over time. It is not a message, and it is not a finished file.

| Type | What it is | First proof |
|---|---|---|
| **Document** | Rich text the user and Alfy edit in place (tabs, checklists, tables, tracker chips) | prototype: 9/9 behaviours |
| **App** | A small self-contained program that runs live in the panel | prototype: 10/10 generated apps worked |
| **Canvas** | A free board: sticky notes, frames, arrows, drawing, and live blocks | prototype: board + drawing + comments |
| **Slides** | A deck with layouts, present mode and PPTX export | not prototyped (lower risk) |
| **File** | A finished PDF/DOCX/XLSX/PPTX — today's `produce_file` output, unchanged | exists |

Everything else already in the chat (charts, checklists, the map card, CSV tables, images, live web results)
becomes a **block** that can be placed inside a Canvas or a Document rather than only appearing in a
message.

**Scope: one user.** No sharing, no permissions, no real-time co-editing. This removes the hardest part of
Claude's equivalent (multi-user merge) and is the owner's explicit decision.

## 2. Decisions (do not reopen)

1. **Alfy decides the shape by content, and every reply can be kept.** Checklists, plans, itineraries,
   letters and drafts become Documents when the user will come back to them; "give me a PDF" still goes to
   `produce_file`; interactive tools become Apps; boards become Canvas; decks become Slides. Every assistant
   reply also offers "Open as document".
2. **The card and the panel are shared.** One card component in the chat, one panel beside it
   (the Document Workspace, rebuilt), with versions, Open, Keep/Undo, export, expand and close.
3. **Tickable in the card.** A checklist card shows the first five items, tickable in place, "+N more".
4. **Edits are visible and reversible.** Alfy's change arrives highlighted with an inline `Alfy · Keep ·
   Undo`; undo restores exactly; history keeps every state.
5. **Your words win.** A patch addressed to a block the user changed after Alfy last read it is **refused**,
   with a visible notice, while the other patches still apply.
6. **Block ids persist with the document**, as invisible markers in the Markdown
   (`<!--b:xxxx-->`), so addressing survives reloads. Cost: about 17 characters per block (+14%).
   A load path must mint or absorb ids immediately after parse — before hashing, snapshotting or rendering.
7. **Comments are one shared feature** across artifact types: `{id, anchor, author, body, replies[], status}`
   where `anchor.kind` is `text` (document), `node` or `point` (canvas). `@Alfy` in a comment produces an
   edit plus a reply in the thread.
8. **Comments are how you talk to Alfy inside the artifact**, and Alfy leaves its own comment when it makes
   a judgement call it is unsure about.
9. **Apps are generated with thinking OFF.** With thinking on, the model spent the entire 24,000-token
   budget reasoning and returned an empty answer, twice.
10. **Facts are verified before an App is shown.** 3 of 10 generated apps shipped a quiet content bug
    (a wrong quiz key, a cumulative table labelled per-year). Apps with factual, numeric or counting content
    get a verification pass.
11. **The App contract forbids agentic behaviour:** the answer is the app and nothing else; no file
    exploration, no clarifying questions. (One call returned `finish_reason=tool_calls` with no tools
    declared.)
12. **Canvas drawing is a real layer:** pen (velocity pressure), highlighter, line, arrow, rectangle,
    ellipse, text and eraser, in board coordinates, in the PNG export, one tab stop.
13. **The Canvas owns its own frame reparenting** (Svelte Flow has none) and must size any pointer-capturing
    overlay from the **visible board rect** (`[-pan/zoom, (-pan+paneSize)/zoom]`), not the board's box — a pad
    sized to the board caught 6 of 144 sample points at 163 nodes.
14. **Poster frames:** an embedded App or a live map cannot be exported or rendered offline, so those blocks
    carry a poster image and export as the poster.
15. **Heavy editors are lazy-loaded.** The route chunk must stay small; the Document editor's 147 kB gzip
    loads only when an artifact of that type is opened.
16. **No sharing, ever** (owner: "a whole different can of worms"). Do not design for it, and do not list it
    as a future option.

## 3. The artifact record

One new artifact family on the existing `artifacts` backbone. **No parallel document store.**

```sql
-- artifacts gains one type value: 'artifact'
-- and keeps: conversation_id, name, metadata_json, content_text, created_at, updated_at

CREATE TABLE artifact_versions (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,            -- 'user' | 'alfy'
  summary       TEXT NOT NULL,            -- "Alfy shortened the Saturday paragraph"
  body          TEXT NOT NULL,            -- the whole serialised artifact at this point
  body_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX artifact_versions_artifact_idx ON artifact_versions(artifact_id, created_at);

CREATE TABLE artifact_comments (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES artifact_comments(id) ON DELETE CASCADE, -- a reply
  anchor_json   TEXT NOT NULL,            -- {kind:'text',blockId,quote,prefix,suffix} | {kind:'node',nodeId} | {kind:'point',x,y}
  author        TEXT NOT NULL,            -- 'user' | 'alfy'
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  created_at    INTEGER NOT NULL
);
CREATE INDEX artifact_comments_artifact_idx ON artifact_comments(artifact_id, created_at);

CREATE TABLE artifact_kv (
  artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, key)
);
```

`artifact_kv` is what an App's `window.alfy.storage` maps to (the prototype used localStorage).

**Bodies.** `content_text` holds the serialised artifact:
- Document → Markdown with `<!--b:id-->` markers
- Canvas → JSON `{nodes, edges, viewport, annotations, comments}`
- App → the HTML document
- Slides → JSON `{layouts, slides[]}`

`metadata_json` holds `{artifactType, title, idIndex?}` plus type-specific config. Add
`artifacts.artifact_type` as a **generated/derived** value only if querying needs it; prefer
`metadata_json.artifactType` to avoid a second source of truth. (Decide at implementation; if a column is
added it needs a migration and a `_journal.json` entry, like everything else here.)

**Where the code lives.** A new `src/lib/server/services/artifacts/` boundary behind one facade
`artifacts.ts`, mirroring the `knowledge/` and `file-production/` shape:
- `record.ts` — create/read/update, type registry, ownership checks
- `versions.ts` — append, list, restore
- `comments.ts` — threads, anchors, resolve, the `@Alfy` hook
- `serialize/` — one module per type: `document.ts` (Markdown ⇄ blocks, id minting/absorbing),
  `canvas.ts` (board ⇄ JSON, the BoardDiff), `slides.ts`
- `read-model.ts` — what the panel and the conversation detail need

Do **not** extend `file-production/` with artifact logic, and do **not** grow `knowledge.ts`.

## 4. How Alfy makes and edits artifacts

New tools in `normal-chat-tools/` (usage guidance lives in the tool interface, ADR-0055):

| Tool | Input | Notes |
|---|---|---|
| `create_artifact` | `{artifactType, title, body}` | Documents and Apps take a body; Canvas may start empty or from a BoardDiff |
| `edit_artifact` | `{artifactId, patches[]}` for documents; `{artifactId, ops[]}` for canvas | Patches are **block-addressed with the hash the model last read**; ops are the id-addressed BoardDiff |
| `read_artifact` | `{artifactId}` | Returns the same shape the model writes, with ids and hashes |
| `suggest_instruction` | (Feature 1) | unchanged |

Rules the server enforces (not the prompt):
- **App generation is a separate call with thinking off** and the App contract as its prompt. It does not
  share the chat turn's sampling. A verification pass follows for Apps whose content is factual, numeric or
  counting.
- Every document patch carries `baseHash` per block; refusal is a server decision, returned per-op
  (`{applied: n, refused: [{blockId, reason}]}`) so the model can react.
- Canvas ops are id-addressed and validated against the current board; an op touching a missing id is
  refused, not guessed.
- Artifacts are conversation-scoped on creation, may be linked to a project (Feature 1's bundle), and are
  never created across users.

**Model-contract evaluation (new, required).** P1 prototyped the App contract only. Add
`scripts/eval-artifact-contracts/` following P1's pattern (prompts → model → automated checks → gallery),
covering:
1. App generation (the P1 suite, rerun as a regression gate; thinking off, verification pass on)
2. **Document patches**: a real document + a real request → does the patch apply, refuse correctly on an
   edited block, and stay inside the requested scope?
3. **Canvas diffs**: a real board + "arrange Saturday" → does the diff parse, apply, and produce a board a
   human would accept?
4. **Slides**: a request → valid slide JSON, correct language, no invented facts.
5. **Fact verification**: does the verification pass catch the three known bug classes (wrong key,
   mislabelled aggregate, wrong unit/gloss)?

This eval is a gate for each type's slice, not a one-off.

## 5. The panel, the card, and the sandbox

- **Panel:** rebuild `document-workspace/DocumentWorkspace.svelte` into the artifact panel (same shell that
  generated files, attachments, library opens and search opens already use). Its content area becomes
  type-aware, and each type's editor is a lazy `import()`.
- **Card:** one `ArtifactCard.svelte` in chat replacing the type-specific cards: header row (icon, title,
  type · subtitle), a type-specific body preview (checklist ticks, first lines, a board thumbnail, a slide
  thumbnail), and Open. `FileProductionCard` becomes the `file` variant rather than a separate card.
- **Sandbox:** an App is served from an authenticated route with a strict CSP and rendered in
  `<iframe sandbox="allow-scripts">`. The model's contract stays `window.alfy.storage.get/set`; the served
  HTML gets a small bootstrap that proxies those calls to the parent over `postMessage`, so the artifact
  never receives a privileged global. Blocks inside a Canvas iframe carry `nodrag`/`nowheel` so board
  panning does not steal clicks.
- **Export:** `produce_file` stays the engine. Document → PDF/DOCX/Markdown, Slides → PPTX/PDF,
  Canvas → PNG (with poster frames for App/map blocks), App → a single `.html`.

## 6. Slices

Each slice lands as its own branch off `dev`, TDD, reviewed before merge (the owner's standard cycle).

**Slice 0 — the artifact spine.** Record, versions, comments tables (+ migration and `_journal.json`
entry), the `artifacts/` service boundary, the panel shell and the card, and the `File` type moved onto
them. No new model-facing behaviour. Proves: existing generated files render through the new card and panel
with no regression.

**Slice 1 — Document.** Markdown body with id markers, `read_artifact` / `edit_artifact` with per-block
hashes and refusal, versions and restore, the panel editor, comments with `@Alfy`, tracker chips, tabs, the
mobile toolbar (its own layout — the prototype's toolbar ate 29% of a 390 px viewport), lazy loading, and
export. Reuse the prototype's `ensureBlockIds` trap fix: ids minted immediately after parse.

**Slice 2 — App.** The generation path (thinking off), the fact-verification pass, the sandbox and the
storage bridge, the App card with Preview/Code, download as `.html`, and the eval suite from §4 wired as a
regression gate.

**Slice 3 — Canvas.** Svelte Flow board, the block registry (chart, checklist, map, file, app, photo, live
web), real chat components reused as blocks, frames with app-level reparenting, connectors with
`onbeforeconnect`, the drawing layer, comment pins, the BoardDiff "Alfy arranges" path, poster frames,
PNG export, and the perf budget (the panel must stay responsive at 150+ nodes; measure frame time in CI).

**Slice 4 — Slides.** Layouts, present mode, speaker notes, PPTX export through `produce_file`, the
"ask about this slide" action.

**Slice 5 — Alfy's side.** Prompt guidance for choosing a type and when to offer an artifact, and the
message evidence rows so an artifact's sources are visible through the existing Sources surface
(`decisions.md` ruling 6 — no new popover row); the project bundle (Feature 1) listing a project's
artifacts.

**Slice 6 — first-open tours.** The three-slide tour per new type (Document, App, Canvas, Slides — File gets
none), seeded as system content, its text editable through the campaign machinery with a new `summary`
layout, triggered on the first open of that type, once per user per type, replayable from the panel, with the
tour's one-line summary reused as that type's empty state. See `decisions.md` rulings 4, 8, 32 and 33 for the
override, the count, the replay host and the incognito rule.

Cross-cutting in every slice: EN + HU strings, account data archive and erasure coverage (ADR-0029–0032),
migrations, telemetry that never carries artifact content, and `npm run check` / `npm test` / `npm run build`
/ lint / Fallow gates.

## 7. Testing

- **Unit:** serialisation round-trips (document Markdown ⇄ blocks with ids; canvas JSON), id minting and
  absorption, hash refusal per op, comment anchoring (exact / moved / orphaned), version restore, `artifact_kv`
  isolation per artifact and per user.
- **Integration:** tool call → artifact row → version row → conversation detail payload; ownership checks
  (user A cannot read, edit, comment on or export user B's artifact); incognito containment.
- **E2E (Playwright):** create each type from chat; tick a checklist in the card; Alfy edit + Keep + Undo;
  reload and confirm ids and refusal still work; comment → `@Alfy` → applied change; draw on a canvas and
  export; open a Document artifact on a phone.
- **Perf budget:** 150 notes + 200 strokes stay above 60 fps; a Document of 6,000 words stays under
  2 ms/keystroke; route chunk sizes asserted (editor lazy).
- **Eval harness (§4)** as the model-facing regression gate.

## 8. Risks

1. **Model quality per type is only proven for Apps.** Document patches, Canvas diffs and Slides are
   unproven against the real model — the prototypes canned them. §4's eval must run before each type's slice
   is called done, and a weak result should change the design (for example: Alfy proposes a diff the user
   approves) rather than be argued away.
2. **Canvas scale is DOM-bound.** Every node is a component; heavy live blocks need threshold rendering.
3. **Two traps from the prototypes:** portal content cannot be styled from its parent (frame children carry
   `z-index: 1`, overlays need `2`), and a pointer-capturing overlay must be sized to the visible pane.
4. **Svelte Flow v1's API differs from React Flow's** in ways that fail silently. Read the v1 docs; do not
   code from React Flow memory.
5. **Editing is now user-facing in a way it never was.** ADR-0065 is the record of that reversal; the
   Knowledge Library rules in AGENTS.md stay binding for uploaded and generated files.
6. **Cost.** Apps and Slides cost a generation call plus a verification call; a Canvas diff is one call.
   Artifact generation should be visible in the existing cost display, not hidden.

## 9. Open questions for the owner

1. **Slides prototype** — this spec treats Slides as lower-risk (fixed layouts + an export we already own).
   Say so if you want it prototyped before Slice 4.
2. **An artifact list** — should the Knowledge page gain an "Artifacts" listing beside Documents, or are
   artifacts reached only from their chat and their project bundle?
3. **Naming in the UI.** "Artifact" is Claude's word. Hungarian has no natural equivalent; the UI could say
   "Munkafelület" / "Dokumentum" per type and avoid the word entirely.
