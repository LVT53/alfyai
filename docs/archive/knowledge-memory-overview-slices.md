# Knowledge Memory Overview Deepening Slices

Local `$to-issues` implementation plan for the architecture-review section
`Deepen Knowledge Memory Overview`. These are not tracker issues.

## Scope

Move Knowledge Memory Overview cleanup, source semantics, status semantics, and
bullet shaping out of the Knowledge page and into a server-side deep module. The
Knowledge page should receive app-ready overview bullets and status fields rather
than raw Honcho overview text. Honcho remains the memory integration and persona
authority; the new module only translates Honcho/persona overview material into
the user-facing Knowledge Memory Overview contract.

## Slice 1: Server-Owned Overview Contract

**Type:** AFK

**Blocked by:** None

**Implementation Status, 2026-05-31:** Implemented. Server overview shaping now
lives in `src/lib/server/services/knowledge/memory-overview.ts`, with
`memory.ts` returning app-ready `KnowledgeMemorySummary.overviewBullets` plus
source/status/timestamp metadata.

**What to build:** Introduce a server-side Knowledge Memory Overview module that
accepts raw Honcho overview text, durable persona count, Honcho availability,
and source/attempt information, then returns app-ready overview text, bullets,
source, status, updated-at, last-attempt, and durable-count fields.

**Acceptance criteria**

- [x] Overview bullet normalization, provenance-noise stripping, sensitive-value
      softening, de-duplication, and bullet limits live in the server module.
- [x] `getKnowledgeMemory(...)` and `getKnowledgeMemoryOverview(...)` return
      app-ready bullets and status from the module.
- [x] Empty, disabled, live-success, cached/fallback, and temporarily unavailable
      states are represented without making the Knowledge page infer Honcho
      quirks.
- [x] Existing persona, task, and focus-continuity payload behavior remains
      stable.

**Verification**

- Unit tests for timestamped Honcho observations, markdown/section labels,
  sensitive values, duplicates, bullet limits, disabled state, empty state, and
  temporary-unavailable status.
- Existing Knowledge Memory service and route tests still pass.

## Slice 2: Knowledge Page Consumes App-Ready Overview

**Type:** AFK

**Blocked by:** Slice 1

**Implementation Status, 2026-05-31:** Implemented. The Knowledge page and
`KnowledgeMemoryView.svelte` consume server-provided overview bullets/status
directly.

**What to build:** Retarget the Knowledge page and `KnowledgeMemoryView` to
consume server-provided overview bullets/status directly. The page may still own
loading, polling, retry, and modal state, but it should not normalize or redact
raw overview content.

**Acceptance criteria**

- [x] `_helpers.ts` no longer contains Knowledge Memory Overview normalization or
      sensitive-value softening logic.
- [x] `+page.svelte` derives display state from `summary.overviewBullets` rather
      than calling a page-local normalizer.
- [x] `KnowledgeMemoryView.svelte` renders app-ready bullets and status/source
      notices without needing raw Honcho text.
- [x] Component tests prove the view renders bullets as plain list items and does
      not render raw markdown/provenance sections.

**Verification**

- Focused Svelte component tests for `KnowledgeMemoryView`.
- Focused helper tests remain only for workspace-document helper behavior.

## Slice 3: Remove Stale Memory Overview Debt

**Type:** AFK

**Blocked by:** Slices 1-2

**Implementation Status, 2026-05-31:** Implemented. The old route-local overview
normalizer and tests were removed; overview normalization tests now live with the
server module.

**What to build:** Remove stale tests, exports, dead helpers, and unused imports
left behind by the old page-local overview normalization path.

**Acceptance criteria**

- [x] No page-local memory overview normalizer remains.
- [x] Tests reference the new server module instead of duplicated Svelte-route
      helpers.
- [x] Repository search does not find stale `memory-markdown`, raw Honcho
      overview rendering, or unused overview helper imports.
- [x] TypeScript and Vitest do not report unused symbols or obsolete tests.

**Verification**

- `npm run check`
- Focused Vitest tests for memory service, memory routes, server overview module,
  and Knowledge Memory view.
- Repository search for stale helper names and unused files.

## Slice 4: Document The Deep Module And Mark Review Status

**Type:** AFK

**Blocked by:** Slices 1-3

**Implementation Status, 2026-05-31:** Implemented. The deep module is
`src/lib/server/services/knowledge/memory-overview.ts`; `memory.ts` calls it and
returns `KnowledgeMemorySummary.overviewBullets` with source/status metadata.
The Knowledge page and `KnowledgeMemoryView.svelte` now render server-provided
bullets/status/source, while `_helpers.ts` remains focused on workspace-document
helpers.

**What to build:** Update `CONTEXT.md`, relevant ADRs, and the architecture
review HTML so future agents understand that Knowledge Memory Overview is a
server-side deep module and do not reintroduce page-local Honcho cleanup.

**Acceptance criteria**

- [x] `CONTEXT.md` defines the Knowledge Memory Overview deep module, its
      server-owned responsibilities, and the page's adapter role.
- [x] ADR-0011 reflects the implemented overview boundary while preserving the
      Honcho-led memory architecture.
- [x] The architecture-review HTML section is marked finished with an
      implementation status and the implemented module boundary.
- [x] Documentation stays consistent with AGENTS.md, Context Access terminology,
      and the removed local persona-memory pipeline.

**Verification**

- [x] Re-read the architecture-review HTML section and confirm every requirement is
  implemented.
- [x] Search docs for contradictory guidance that tells pages to clean raw Honcho
  overview text.

Focused verification already passed for the implementation slice: 25 tests
across memory overview, service, routes, and Knowledge view, plus
`npm run check` with 0 errors and the existing tsconfig warning.
