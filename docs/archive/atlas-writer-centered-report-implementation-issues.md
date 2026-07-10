# Atlas Writer-Centered Report Implementation Issues

This document is local planning output, not published tracker state. It converts ADR 0038 and the new Atlas vocabulary in `CONTEXT.md` into issue-ready implementation waves. The user explicitly requested a local implementation plan rather than tracker issue creation.

The plan assumes the current Atlas implementation should be evolved, not restarted. The codebase already contains the ADR 0037 foundation: Evidence Packs, Coverage Review, bounded Gap-Fill Rounds, Claim Basis, Basis Marker projection, deterministic source chips, image filtering, generated titles, checkpoints, and Atlas output tests. ADR 0038 is the next product-quality correction: the published report must become a useful synthesis instead of a thin body plus a large source dump.

Generated: 2026-06-22

## Source Decisions / Docs Check

Primary project sources read for this plan:

- `AGENTS.md`: Atlas work must stay inside existing server service, file-production, document-workspace, TEI, config-store, and Normal Chat boundaries. Routes remain adapters. TEI embedding and reranking must use shared services, not Atlas-specific vector tables.
- `CONTEXT.md`, `## Atlas Research Reports`: adds or updates `Atlas Writer Evidence Card`, `Atlas Published Report`, `Atlas Evidence Appendix`, and the compact `Atlas Source Projection` contract.
- `docs/adr/0038-atlas-publishes-writer-centered-reports-not-source-dumps.md`: chooses a writer-centered Atlas report, compact source projection, one bounded improvement pass, and TEI as a selection aid only.
- `docs/adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md`: keeps the server-owned bounded architecture from drifting into a hidden autonomous loop.
- `docs/atlas-bounded-adaptive-rounds-implementation-issues.md`: prior local issue-plan style and the ADR 0037 baseline.
- `/Users/lvt53/.codex/skills/to-issues/SKILL.md`: local issues should be tracer-bullet slices with behavior-focused acceptance criteria, dependencies, labels, and implementation notes.

Current implementation source paths inspected for this plan:

- `src/lib/server/services/atlas/types.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/evidence-packs.ts`
- `src/lib/server/services/atlas/coverage-review.ts`
- `src/lib/server/services/atlas/quality-gates.ts`
- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/atlas/image-quality.ts`
- `src/lib/server/services/atlas/checkpoints.ts`
- `src/lib/server/services/atlas/output.test.ts`
- `src/lib/server/services/atlas/pipeline.test.ts`
- `src/lib/server/services/tei-reranker.ts`
- `src/lib/server/services/semantic-ranking.ts`
- `src/lib/server/services/tei-observability.ts`
- `src/lib/server/services/tei-embedder.ts`

Context7 note:

- This is a documentation/planning change only. It does not prescribe new Svelte, SvelteKit, Drizzle, Playwright, or Vitest API usage beyond existing project patterns. Code-writing workers must still perform the mandatory Context7/Svelte docs check before touching framework or library surfaces.

## Current Implementation Baseline

The current Atlas pipeline is no longer the deleted Deep Research subsystem. It is a Normal Chat-adjacent long-running Atlas job with server-owned stages and file-production outputs.

Confirmed code facts:

- `src/lib/server/services/atlas/pipeline.ts` currently runs `decompose -> search/curate/research rounds -> synthesize -> integrate -> assemble -> audit -> render`.
- `runAtlasResearchRound(...)` already builds Evidence Packs and Coverage Review data per round.
- `buildAssemblePrompt(...)` still feeds the final assembly step `curatedEvidence`, `synthesis`, `outline`, `imageCandidates`, Evidence Packs, Coverage Review, and lifecycle data. It asks for a complete report, but it is still an assembly prompt rather than a dedicated writer contract.
- `buildAtlasDocumentSource(...)` already removes model-authored source sections, converts authored takeaways to callouts, filters image blocks against accepted candidates, inserts deterministic images, applies Claim Basis markers, and appends deterministic source chips.
- Current deterministic source chips accept `source.reasoning`; the pipeline currently passes web source snippets as reasoning. When snippets contain fetched-page excerpt text, the published Markdown can become source-dominated even when the report body is thin.
- `image-quality.ts` already rejects likely logos, icons, devicons, SVG/vector-ish assets, very small images, and weak query-overlap candidates. ADR 0038 image work should validate and harden this rather than duplicate it.
- `tei-reranker.ts` exposes `rerankItems(...)` and `rerankTexts(...)` for ephemeral item ranking. `semantic-ranking.ts` currently ranks persisted semantic embedding subjects, so arbitrary web-source/evidence-card routing should prefer reranker first unless a shared ephemeral embedding helper is added deliberately.
- `tei-observability.ts` currently has compact TEI diagnostics scopes for documents, persona prompt, and task routing. Atlas TEI diagnostics should extend that shared vocabulary intentionally rather than introducing route-local logs.

## Problem Statement

The live failure behind ADR 0038 had a valid-looking artifact but a bad product result:

- roughly 17,826 Markdown words total
- about 219 words of synthesized report content
- roughly 97% source appendix/source-projection material
- many sections with one-sentence content
- a recommendation section that did not make a real recommendation
- a large deterministic source dump that made the report look substantial while hiding weak synthesis

This is not mainly an LLM model-quality failure. The system asked the final stage to assemble an artifact from broad evidence and then rendered too much evidence material into the published report. The fix is to shape the final writing context better, give the writer more responsibility for synthesis, and move raw source material out of the default published report.

## Orchestrator Contract

Future implementation should use `$orchestrate-subagents` if more than one worker is used. The Orchestrator owns:

- authoritative task state and dependency sequencing
- worker prompts and disjoint write scopes
- verification that worker diffs match ADR 0038 and do not regress ADR 0037
- integration of worker output
- local verification gates
- remote live testing and final push to `main`

Every code-writing worker prompt should include:

```text
You are a worker on a multi-agent task. Do not revert edits made by others.
Use the repository's existing Atlas boundaries unless this issue explicitly changes them.
Use $tdd for code development. Report the red-green-refactor loop, or explain why strict test-first was not feasible and what regression check you added instead.
Before touching framework or library surfaces, perform the repo-required current-docs check.
```

Every worker final report must include:

- Changed paths
- Behavior changed
- Tests or checks run
- ADR 0038 drift checks performed
- ADR 0037 regression checks performed where relevant
- Blockers or assumptions

## Implementor Goal Directive

The implementation owner should create a Codex Goal before starting code work:

```text
Implement ADR 0038 writer-centered Atlas reports end to end, with compact published source projection, bounded writer improvement, no ADR 0037 drift, local verification gates passing, remote live testing completed with real production models, and final code pushed on main.
```

The goal can only be marked complete after all of these are true:

- the published Atlas report body is decision-quality on the regression query, not a sparse wrapper around sources
- the default Markdown/HTML/PDF report no longer appends long fetched-page excerpts by default
- raw excerpts and source diagnostics, if preserved, live in an Evidence Appendix or diagnostic surface rather than the Published Report
- final writing uses compact Writer Evidence Cards or an equivalent structured writer input, not a giant raw source dump
- report-shape diagnostics are soft and bounded; they may trigger one improvement pass but not repeated cancellation loops
- local TEI usage, if implemented, is limited to selection, routing, dedupe, or evidence alignment and never becomes visible confidence/truth
- Claim Basis and Basis Marker behavior continues to express support as `supported`, `partial`, or `unsupported`
- image rendering remains sparse and relevant
- `npm run check` passes with 0 errors and 0 warnings, or exact pre-existing unrelated diagnostics are documented
- Fallow is run and new findings are treated as regressions unless intentionally documented
- remote live testing is performed against the live AlfyAI host with real models
- live logs show no new Atlas, file-production, chat, or runtime errors from the smoke test
- the final branch is pushed to `main`

## Non-Negotiable ADR 0038 Constraints

- Published report quality is judged by useful synthesis, not source count.
- Do not make report/source word ratio a hard cancellation gate.
- Do not render long fetched-page excerpts in the default Published Report.
- Do not add a hidden autonomous writer loop.
- Do not create a second Atlas job for one bounded improvement pass.
- Do not make every report obey a generic skeleton when the user asked for a decision-specific answer.
- Do not let the model write freeform Markdown Sources, bibliographies, or citation appendices into the final body.
- Do not treat embedding or rerank scores as claim support, confidence, or truth.
- Do not add Atlas-specific vector tables.
- Do not route TEI reranking through chat-completion control models.
- Do not regress ADR 0037 bounded rounds, Claim Basis, Basis Marker, generated-title, or deterministic source-projection contracts.
- Do not commit a user's downloaded failed report as a test fixture unless it is explicitly sanitized and approved.

## Quality Bar For This Plan

The target is not "shorter reports." The target is "the report body carries the value."

For a model/hardware-selection query like "find the most intelligent with minimal latency cost self-hostable on a single RT-class GPU," an acceptable Atlas Published Report should normally include:

- an Executive Summary that answers the question directly
- ranked shortlist or recommendation tiers
- decision criteria tied to the user request
- hardware fit and VRAM/latency/cost tradeoffs
- multilingual or domain-specific performance discussion when relevant
- what to avoid
- limitations and evidence gaps
- tables where comparison helps
- compact sources that identify where facts came from without dominating the artifact

These are quality expectations, not a rigid heading skeleton.

## Wave Index

0. ADR38-00 - Baseline reproduction and report-shape diagnostics
1. ADR38-01 - Compact Source Projection becomes the default Published Report behavior
2. ADR38-02 - Writer Evidence Card contract and deterministic builder
3. ADR38-03 - Optional TEI-assisted card routing, dedupe, and shortlist selection
4. ADR38-04 - Atlas Writer Pass replaces the generic assembly prompt
5. ADR38-05 - Soft report-shape diagnostics and one bounded improvement pass
6. ADR38-06 - Evidence Appendix separation for raw excerpts and diagnostics
7. ADR38-07 - Image relevance and density hardening validation
8. ADR38-08 - Claim Basis, Basis Marker, and source association regression hardening
9. ADR38-09 - Checkpoints, lifecycle seeding, read-model metadata, and progress/i18n
10. ADR38-10 - Regression suite, local gates, remote live test, and push to main

## ADR / CONTEXT Traceability Matrix

This matrix is the guard against implementation drift. Each new ADR 0038 or `CONTEXT.md` concept must land in a concrete implementation slice, with a public verification point and an explicit anti-scope.

| Decision or vocabulary | Implementation slice | Public verification point | Anti-scope |
| --- | --- | --- | --- |
| Atlas Published Report is the reader-facing artifact, not the research scratchpad | ADR38-01, ADR38-04, ADR38-05 | Markdown/HTML/PDF body contains substantive synthesis before the deterministic Sources projection | Do not render fetched-page excerpts or source diagnostics in the main report body |
| Atlas Source Projection is deterministic and compact | ADR38-01 | Source chips show title, URL, source type/authority, and concise relevance note | Do not let the model write Markdown Sources, Bibliography, References, or Citation Appendix sections |
| Atlas Writer Evidence Cards are the model-facing bridge from Evidence Packs to final writing | ADR38-02, ADR38-04 | Final writer prompt includes bounded cards with facts, limitations, conflicts, and source refs | Do not pass raw fetched pages or giant `curatedEvidence` dumps to the writer |
| Writer-centered final phase is not an autonomous agent loop | ADR38-04, ADR38-05 | Pipeline still runs one server-owned Atlas Turn with bounded parse/repair/fallback behavior | Do not create a second Atlas job, ReAct loop, or unbounded writer retry cycle |
| Report-shape diagnostics are soft and bounded | ADR38-00, ADR38-05 | Thin/non-decisive drafts can trigger at most one improvement pass and then continue honestly | Do not cancel jobs merely because source/body ratio or body length is weak |
| Evidence Appendix separates audit material from the Published Report | ADR38-06 | Raw excerpts and accepted/rejected source diagnostics are checkpointed or rendered only in a separate diagnostic/appendix surface | Do not make the appendix the main Sources section or block report publication unless required main outputs fail |
| Local TEI embedding/reranking may improve routing and selection | ADR38-03 | Cards can be ranked/routed with `tei-reranker` when available and deterministic fallback when unavailable | Do not expose TEI scores as confidence, truth, or Claim Basis support |
| Claim Basis and Basis Markers remain evidence-derived | ADR38-08 | Support levels remain exactly `supported`, `partial`, and `unsupported`, and markers attach near claims | Do not revive a separate Honesty Marker report section or confidence-circle scoring model |
| Images should be sparse and relevant | ADR38-07 | Logo/devicon/SVG-ish/decorative candidates are rejected; sparse reports get few or no images | Do not use image count as proof of report quality |
| Checkpoints and lifecycle should carry compact writer state | ADR38-09 | Continue/Fork/Revise seed from compressed findings, cards, source summaries, and section briefs | Do not seed future writer context from raw appendix excerpts by default |
| Atlas remains a bounded Normal Chat-adjacent artifact stored through file production | ADR38-09, ADR38-10 | Existing job cards, generated files, document workspace, and resume behavior still work | Do not introduce a parallel Deep Research-style subsystem or Atlas-specific artifact store |

## Dependency Graph

The implementation is intentionally ordered so the highest-risk product failure is fixed before optional quality aids:

```text
ADR38-00 diagnostics
  -> ADR38-01 compact source projection
  -> ADR38-02 writer evidence cards
  -> ADR38-04 writer pass
  -> ADR38-05 one bounded improvement pass
  -> ADR38-08 basis/marker regression hardening
  -> ADR38-10 local + live verification

ADR38-03 TEI card routing depends on ADR38-02 and can be integrated before or after ADR38-04.
ADR38-06 Evidence Appendix depends on ADR38-01 and should not block the published-report repair.
ADR38-07 image hardening can run in parallel with ADR38-01 or ADR38-08.
ADR38-09 checkpoint/read-model/lifecycle work depends on the final shape of ADR38-02 through ADR38-06.
```

The critical path is compact source projection plus writer-centered synthesis. TEI routing and Evidence Appendix are valuable, but they must not delay the first user-visible repair unless a verification run proves the report is still sparse without them.

## Cross-Slice Definition Of Done

Every implementation slice is done only when it satisfies its local acceptance criteria and the following cross-cutting checks:

- It preserves the ADR 0037 bounded Atlas architecture: server-owned stages, bounded rounds, deterministic rendering, no open-ended agents.
- It preserves the ADR 0038 product correction: the Published Report body carries the value, and source material does not dominate the artifact.
- It has a focused regression test at the highest practical seam. Pure helpers get unit tests; pipeline changes get pipeline tests; renderer behavior gets output/file-production tests.
- It has at least one negative test for the failure mode it is preventing, such as raw excerpts leaking into Published Report output or TEI scores becoming support levels.
- It documents or checkpoints enough diagnostic metadata to explain live behavior without logging raw prompts, API keys, hidden chain-of-thought, or private unrelated user context.
- It does not add schema, route, or UI churn unless the issue explicitly calls for it and the existing boundary cannot satisfy the behavior.
- It does not push unrelated dirty files into the final commit.

## Model-Quality Versus System-Quality Boundary

The latest bad report could look like an LLM failure because the prose was weak, but ADR 0038 treats it as a system-quality failure first. The implementation should therefore change the conditions under which the model writes:

- Give the writer a clear synthesis job, not a source-compilation job.
- Give the writer compact cards with facts and limitations, not raw pages.
- Allow request-specific structure, especially for recommendation and comparison prompts.
- Let one bounded improvement pass repair thin drafts.
- Keep final rendering deterministic and source projection app-owned.

Do not solve this by only switching models, raising token budgets, increasing source counts, or adding stricter cancellation gates. Those can mask the symptom while preserving the broken boundary.

## ADR38-00 - Baseline reproduction and report-shape diagnostics

**Type / triage label:** `quality`, `atlas`, `tests`, `diagnostics`, `tdd`

**Dependencies:** Existing Atlas output and pipeline tests.

### Goal

Create a deterministic way to detect the exact class of bad report that motivated ADR 0038: a sparse synthesized body wrapped in an oversized source projection. This slice is diagnostic and test-support work. It must not become a production hard-cancellation gate.

### User-visible value

Future changes can be verified against the real failure mode instead of relying on impressions. Implementors get a measurable baseline for "body carries the value" without recreating the old Deep Research habit of cancelling work because a gate disliked the draft.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/quality-gates.ts`
- new or existing Atlas diagnostic helper under `src/lib/server/services/atlas/`
- `src/lib/server/services/atlas/pipeline.test.ts`
- `src/lib/server/services/atlas/output.test.ts`
- possibly `docs/atlas-live-baseline-2026-06-21.md` for human baseline notes only

Do not change:

- database schema
- production failure behavior
- user-facing report rendering
- live pipeline stage ordering

### Implementation details

Add a pure helper that accepts assembled Markdown or a `GeneratedDocumentSource` and returns report-shape metrics:

```ts
type AtlasReportShapeDiagnostics = {
  bodyWordCount: number;
  sourceWordCount: number;
  totalWordCount: number;
  sourceWordShare: number;
  substantiveSectionCount: number;
  oneSentenceSectionCount: number;
  imageCount: number;
  hasDecisionOrRecommendationSignal: boolean;
  warnings: Array<{
    code: string;
    message: string;
  }>;
};
```

The helper should be conservative and deterministic. It should:

- identify app-owned source blocks separately from report body blocks
- estimate words after Markdown/source conversion without needing the renderer
- count headings with little or no following paragraph/list/table content
- detect whether a recommendation/decision section contains a concrete decision signal
- count images after image filtering/capping
- return warnings, not throw

This helper is allowed to flag issues such as:

- `atlas_report_body_too_thin`
- `atlas_source_projection_dominates_report`
- `atlas_recommendation_not_decisive`
- `atlas_too_many_images_for_body_size`

The pipeline must treat these as diagnostics until ADR38-05 wires one bounded improvement pass.

### Acceptance criteria

- [ ] A pure diagnostic helper exists and is covered by unit tests.
- [ ] The helper can distinguish body words from deterministic source-projection words.
- [ ] The helper flags a synthetic report with about 200 body words and thousands of source words.
- [ ] The helper does not throw or fail a job.
- [ ] The helper can be called from tests without model, web, DB, or file-production dependencies.
- [ ] The helper does not require checking in the user's downloaded failed report.
- [ ] If a sanitized fixture is added, it contains no private user data and is small enough to maintain.

### Suggested tests

- Red test: a Markdown report with five one-sentence sections and a long Sources appendix returns `atlas_source_projection_dominates_report`.
- Red test: a compact but substantive report with short source chips does not warn.
- Regression test: report-shape diagnostics do not affect `AtlasPipelineResult.status`.
- Regression test: image count warning is only a warning.

### ADR drift checks

- Verify this helper is not used as a hard cancellation condition.
- Verify it does not reintroduce the old "quality gate cancels the job" failure mode.

## ADR38-01 - Compact Source Projection becomes the default Published Report behavior

**Type / triage label:** `feature`, `atlas`, `renderer`, `file-production`, `tdd`

**Dependencies:** None. This is the fastest direct fix for the latest bad Markdown shape.

### Goal

Make the default Atlas Published Report render a compact deterministic source projection. Source chips should identify sources and explain concise relevance. They must not include long fetched excerpts, raw page text, rejected-source diagnostics, or research scratchpad material by default.

### User-visible value

The Markdown, HTML, and PDF reports stop being dominated by source dumps. Even before the writer pass improves the body, the artifact becomes readable and honest about where sources are without burying the report.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/evidence-packs.ts`
- `src/lib/server/services/atlas/output.test.ts`
- file-production generated-document tests if source-chip rendering needs coverage

Do not change:

- file-production schema
- source-chip block contract unless absolutely required
- model-authored source removal behavior except to make it stricter
- Claim Basis source refs

### Implementation details

Introduce a compact source projection function, likely near `renderer-output.ts` or a new `source-projection.ts`:

```ts
type AtlasCompactReportSource = {
  title: string;
  url: string | null;
  authority: string | null;
  typeLabel: string;
  relevanceNote: string;
};
```

Build `relevanceNote` from the best compact material available, in this priority:

1. Writer Evidence Card relevant fact or supports-section note, after ADR38-02 exists.
2. Evidence Pack summary.
3. Existing curated source reason/snippet after truncation and raw-excerpt cleanup.
4. Generic fallback such as "Accepted web evidence gathered by Atlas."

Clamp each `relevanceNote` to a small maximum, for example 160-240 characters. The exact length can be tuned, but the test should prove raw fetched excerpts cannot dominate the artifact.

Raw cleanup should remove or avoid phrases that indicate page-dump material:

- `Fetched page excerpt`
- `Accepted source excerpt`
- long quoted paragraphs
- repeated boilerplate navigation text
- many consecutive sentences from the same page

In `pipeline.ts`, stop passing unbounded `source.snippet` directly as `reasoning` to `auditSources` for published rendering. Preserve raw-ish material only in checkpoints or the future Evidence Appendix.

The source projection still must:

- separate Web Sources and Your Library
- preserve source title and URL
- preserve explicit/provided source distinction
- remain deterministic and app-owned
- remove model-authored Markdown source sections before appending canonical sources

### Acceptance criteria

- [ ] Published `sourceChips` reasoning is compact by construction.
- [ ] A long web source snippet cannot render as a long source-chip paragraph in Markdown/HTML/PDF.
- [ ] The deterministic Sources section still appears when accepted sources exist.
- [ ] Web and library sources remain separated.
- [ ] Source title and URL are preserved.
- [ ] Existing model-authored `## Sources`, `## Bibliography`, `## References`, and similar sections are removed.
- [ ] The source projection remains app-owned; the writer cannot smuggle a second source appendix into the body.
- [ ] Claim Basis audit still receives enough source/evidence context and is not broken by published-source truncation.
- [ ] Checkpoints may still preserve richer evidence for debugging, but the Published Report does not render it by default.

### Suggested tests

- Renderer test: a source with a 2,000-word snippet produces a source chip with a short relevance note.
- Renderer test: model-authored source appendices are removed even when nested below `### Citation Appendix`.
- Pipeline test: `auditSources` passed to `buildAtlasDocumentSource` use compact source projection fields, not raw fetched excerpts.
- Regression test: source chips still include URL and title.
- Regression test: library sources still render under the library subsection.

### ADR drift checks

- Verify no source/body ratio check fails the job.
- Verify raw excerpts are absent from Published Report output by default.
- Verify source projection is deterministic, not model-authored.

## ADR38-02 - Writer Evidence Card contract and deterministic builder

**Type / triage label:** `feature`, `atlas`, `backend`, `model-stage`, `tdd`

**Dependencies:** Existing Evidence Packs. ADR38-01 can be done before or after this.

### Goal

Create `AtlasWriterEvidenceCard` as the compact model-facing unit for final writing. Cards distill Evidence Packs into facts, limitations, conflicts, authority, and section support without handing the writer raw fetched pages or a giant source pile.

### User-visible value

The final writer gets enough evidence to write a useful report, but not so much raw source text that it collapses into source-summary fragments or source-derived headings.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/types.ts`
- new `src/lib/server/services/atlas/writer-evidence-cards.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/pipeline.test.ts`
- `src/lib/server/services/atlas/evidence-packs.test.ts`

Do not change:

- database schema
- accepted source search behavior
- renderer output except where source projection consumes cards

### Implementation details

Add a versioned type:

```ts
export const ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION =
  "atlas.writer-evidence-card.v1";

export type AtlasWriterEvidenceCardAuthority =
  | "official"
  | "benchmark"
  | "vendor"
  | "analysis"
  | "community"
  | "user_provided"
  | "library"
  | "parent_seed"
  | "unknown";

export interface AtlasWriterEvidenceCard {
  version: typeof ATLAS_WRITER_EVIDENCE_CARD_SCHEMA_VERSION;
  id: string;
  sourceTitle: string;
  url: string | null;
  authority: AtlasWriterEvidenceCardAuthority;
  sourceRefs: AtlasEvidencePackSourceRef[];
  relevantFacts: string[];
  limitations: string[];
  conflicts: string[];
  supportsSections: string[];
  evidencePackIds: string[];
  freshnessNote: string | null;
}
```

The exact exported shape can differ, but it must carry the ADR fields and enough ids for Claim Basis and source projection to trace back to Evidence Packs.

The builder should be deterministic at first:

- one card per high-value Evidence Pack or compact cluster
- stable ids derived from evidence pack ids/source refs
- authority mapped from Evidence Pack authority and URL/title cues
- facts extracted from `evidence.summary`, `supportedFacets`, and compact excerpt
- limitations/conflicts carried forward
- section support from `affectedSectionHint`, Coverage Review, or integrate/section brief hints when available

Avoid overfitting authority:

- Official/vendor/community classification can be heuristic.
- If uncertain, use `unknown`.
- Do not let authority become a truth score.

### Acceptance criteria

- [ ] `AtlasWriterEvidenceCard` type exists and is versioned.
- [ ] A deterministic builder converts Evidence Packs into cards.
- [ ] The builder preserves traceability to Evidence Pack ids and source refs.
- [ ] Cards include relevant facts, limitations, conflicts, source title, URL, authority, and supported sections.
- [ ] Card text is compact and bounded.
- [ ] Parent seed cards are labeled so they are not treated as fresh current evidence.
- [ ] Empty Evidence Packs produce a clear diagnostic rather than fabricated cards.
- [ ] Cards are checkpointed for final rounds, or a documented compact summary is checkpointed if full cards are considered too verbose.
- [ ] Later writer prompts receive cards rather than raw source dumps.

### Suggested tests

- Builder test: official-looking source becomes an official/vendor/unknown card without raw excerpt bloat.
- Builder test: conflicts and limitations from Evidence Packs survive into cards.
- Builder test: duplicate source refs do not duplicate card facts.
- Pipeline test: final writer stage prompt contains `writerEvidenceCards` and does not contain raw fetched page text.
- Checkpoint test: final checkpoint records card count and diagnostics.

### ADR drift checks

- Verify cards are writer inputs, not rendered appendices.
- Verify cards do not create a new persistence subsystem.
- Verify card authority does not become a reader-visible confidence score.

## ADR38-03 - Optional TEI-assisted card routing, dedupe, and shortlist selection

**Type / triage label:** `feature`, `atlas`, `tei`, `backend`, `quality`, `tdd`

**Dependencies:** ADR38-02.

### Goal

Use local TEI embedding and reranking models to improve evidence-card selection and routing when configured, while preserving deterministic fallback behavior and never treating TEI scores as truth.

### User-visible value

Reports should use the most relevant evidence for each section, avoid repetitive cards from near-duplicate sources, and fit writer context better when there are 50-100 sources.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/writer-evidence-cards.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/tei-reranker.ts` only if a small reusable change is needed
- `src/lib/server/services/semantic-ranking.ts` only if adding a generic ephemeral embedding helper is justified
- `src/lib/server/services/tei-observability.ts`
- Atlas tests for TEI fallbacks

Do not change:

- TEI raw transport semantics in `tei-client.ts`
- `semantic_embeddings` schema unless a separate ADR approves durable Atlas embeddings
- Claim Basis support levels
- reader-visible basis/confidence UI

### Implementation details

Preferred initial TEI use:

- Use `rerankItems(...)` from `tei-reranker.ts` for ephemeral card ranking.
- Query text should be section-specific when possible, for example user request plus section title/brief.
- Limit candidate count using existing config maximums.
- When reranker is unavailable, use deterministic ordering from card authority, source recency, Evidence Pack order, and section hints.

Use TEI for:

- routing cards to likely sections
- selecting top cards when writer context is tight
- suppressing near-duplicate cards after deterministic duplicate checks
- picking which raw excerpts are worth preserving in Evidence Appendix later
- preselecting likely support candidates before Claim Basis audit

Do not use TEI for:

- "supported" vs "partial" vs "unsupported"
- confidence circles
- deciding whether a claim is true
- deciding whether the Atlas job succeeds

If embedding-based duplicate clustering is needed, add a small shared helper rather than hiding vector math in Atlas:

```ts
rankEphemeralTextsByQuery(...)
clusterEphemeralTextsBySimilarity(...)
```

This helper should be generic and live in a shared TEI/semantic module only if it has a clean boundary. Otherwise, keep v1 to reranking only.

Extend `tei-observability.ts` only if useful:

- add `scope: "atlas"` deliberately
- log compact counts and fallback reasons only
- never log raw source text, prompts, user ids beyond existing safe fields, or API keys

### Acceptance criteria

- [ ] Atlas can rank or route Writer Evidence Cards with TEI reranker when configured.
- [ ] Atlas produces the same kind of report when TEI is unavailable.
- [ ] TEI diagnostics are compact and routed through shared observability.
- [ ] TEI scores are not rendered to users.
- [ ] TEI scores are not stored as Claim Basis support levels.
- [ ] No Atlas-specific vector table is added.
- [ ] No durable web-source embedding persistence is added without a new ADR.
- [ ] Tests cover reranker unavailable, reranker returns results, and reranker returns empty results.

### Suggested tests

- Mock `rerankItems(...)` and prove section A receives the most relevant cards.
- Mock reranker unavailable and prove deterministic fallback order.
- Test that `supportLevel` is unaffected by reranker score.
- Test diagnostics include fallback reason without raw text.

### ADR drift checks

- Verify TEI remains a selection/routing aid only.
- Verify no new Atlas vector store exists.
- Verify no chat-completion control model is used for reranking.

## ADR38-04 - Atlas Writer Pass replaces the generic assembly prompt

**Type / triage label:** `feature`, `atlas`, `model-stage`, `backend`, `tdd`

**Dependencies:** ADR38-02. Benefits from ADR38-03 but must work without it.

### Goal

Replace the final generic assembly prompt with a writer-centered pass that receives user intent, profile, section briefs, constraints, limitations, conflicts, image candidates, and Writer Evidence Cards. The writer should produce a useful Published Report body, not a process report or source dump.

### User-visible value

The report should answer the user's actual question with rankings, tradeoffs, recommendations, caveats, and tables where useful. It should no longer look like a list of source summaries.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/pipeline.ts`
- possibly new `src/lib/server/services/atlas/writer.ts`
- `src/lib/server/services/atlas/types.ts`
- `src/lib/server/services/atlas/pipeline.test.ts`
- model-stage fixtures or helpers if present

Do not change:

- route entrypoints
- worker-runner job orchestration
- file-production output contract
- the bounded research-round architecture

### Implementation details

Preserve the external stage string `assemble` unless there is a strong reason to add a public `writer` stage. Renaming pipeline stages can create avoidable UI/progress/read-model churn. Internally, the code can use writer naming:

- `buildAtlasWriterPrompt(...)`
- `parseAtlasWriterOutput(...)`
- `AtlasWriterOutput`

Writer prompt input should include:

- detected language
- current date
- original user query
- profile and posture
- report intent derived from decompose/integrate
- section briefs or intended sections from integrate
- Writer Evidence Cards
- compact Coverage Review result
- search limitations
- conflicts and limitations summary
- lifecycle family/seed caveat
- image candidates that survived quality filtering
- source-projection rule: do not write Markdown Sources
- title rule: generated title only in structured metadata

Writer output should remain strict JSON:

```ts
type AtlasWriterOutput = {
  generatedTitle: string | null;
  bodyMarkdown: string;
  sectionBriefs: AtlasSectionBrief[];
  limitations: string[];
  sourceAssociations?: Array<{
    sectionTitle: string;
    evidenceCardIds: string[];
    evidencePackIds: string[];
    sourceRefs: AtlasEvidencePackSourceRef[];
    relevance: string;
  }>;
};
```

The writer should be instructed to choose a useful structure for the request. Required obligations should be broad:

- Executive Summary when appropriate
- evidence-grounded recommendation or decision when the request asks for one and evidence supports it
- limitations/evidence gaps
- tables for comparisons when helpful

Avoid forcing headings like `Findings`, `Purpose and Scope`, `Integrated Report`, or generic `Recommendation` if the user asked for a concrete decision.

For decision queries, the prompt should explicitly allow structures such as:

- ranked shortlist
- decision criteria
- hardware fit
- latency/cost tradeoffs
- language/domain coverage
- recommended stack
- what to avoid
- evidence gaps

### Acceptance criteria

- [ ] The final writing stage prompt is writer-centered and uses Writer Evidence Cards.
- [ ] The prompt does not include raw source dumps by default.
- [ ] The writer output stays strict JSON with generated title, body Markdown, section briefs, and limitations.
- [ ] The writer is allowed to choose request-specific structure.
- [ ] The writer is explicitly prohibited from writing Markdown Sources, bibliographies, or citation appendices.
- [ ] Generated title remains structured metadata, not a body heading.
- [ ] Image instructions remain source-backed and candidate-limited.
- [ ] Pipeline tests prove the writer prompt contains cards and report intent.
- [ ] Existing assembly parse/repair/fallback behavior is either preserved or replaced with equivalent writer parse/repair/fallback behavior.

### Suggested tests

- Prompt test: for a hardware/model selection query, writer instructions mention decision quality and do not force generic headings.
- Prompt test: raw fetched excerpt sentinel is absent from final writer prompt.
- Pipeline test: model output with structured title becomes canonical title and body starts at Executive Summary or the first content section.
- Repair test: invalid writer JSON triggers bounded repair and not an unbounded loop.
- Fallback test: if writer output remains unusable, deterministic fallback ships compact limitations and does not restore source dumps.

### ADR drift checks

- Verify no second Atlas job is created for writing.
- Verify no autonomous writer loop exists.
- Verify model-authored sources are invalid and removed.

## ADR38-05 - Soft report-shape diagnostics and one bounded improvement pass

**Type / triage label:** `feature`, `atlas`, `quality`, `model-stage`, `tdd`

**Dependencies:** ADR38-00 and ADR38-04.

### Goal

Use report-shape diagnostics to run at most one writer improvement pass when the draft is clearly thin or non-decisive. This is a bounded improvement mechanism, not a hard quality gate.

### User-visible value

Atlas can recover from a bad first draft by expanding it into a more useful report, without returning to the old behavior of repeatedly failing or cancelling long-running research jobs.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/quality-gates.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/pipeline.test.ts`
- checkpoint/read-model metadata as needed

Do not change:

- job failure behavior except for existing critical audit failures
- search/gap-fill loop counts
- file-production renderer behavior

### Implementation details

After the writer pass and before Claim Basis audit, calculate report-shape diagnostics. If warnings indicate a serious body problem, run one improvement pass:

```text
The draft is too thin relative to the accepted evidence. Rewrite it into a decision-quality report. Preserve grounded claims, add rankings, tables, tradeoffs, and a definitive recommendation where supported. Do not add sources.
```

The actual prompt should be structured JSON and include:

- original query
- current draft
- Writer Evidence Cards
- limitations/conflicts
- report-shape diagnostics
- clear constraints not to add new sources or unsupported claims
- same output schema as the writer pass

Only one improvement pass is allowed. After that:

- continue to Claim Basis audit
- ship with limitations and Basis Markers if source basis is trustworthy
- fail only for existing critical reasons such as no accepted sources or render/storage failure

Store diagnostics in checkpoint/read-model metadata so live debugging can see why the pass did or did not run.

### Acceptance criteria

- [ ] Report-shape diagnostics run after the first writer draft.
- [ ] A clearly thin draft triggers at most one improvement pass.
- [ ] A substantive draft does not trigger the pass.
- [ ] The improvement pass uses Writer Evidence Cards and does not receive raw source dumps.
- [ ] The improvement pass cannot add new web searches or create a new Atlas job.
- [ ] If the improvement pass returns invalid output, the pipeline uses bounded repair/fallback and proceeds honestly.
- [ ] Diagnostics are checkpointed as warnings, not job failure reasons.
- [ ] Existing critical audit failure behavior remains intact.

### Suggested tests

- Pipeline test: thin report triggers exactly one additional `runModelStage` call for assembly/writer improvement.
- Pipeline test: repeated thin output still proceeds to audit after one improvement pass.
- Pipeline test: good report does not trigger improvement.
- Pipeline test: improvement pass prompt contains "Do not add sources" or equivalent structured constraint.
- Regression test: report-shape warning alone does not throw `AtlasPipelineQualityError`.

### ADR drift checks

- Verify this is not a hard source/body ratio gate.
- Verify it cannot loop.
- Verify it does not create a follow-up Atlas job.

## ADR38-06 - Evidence Appendix separation for raw excerpts and diagnostics

**Type / triage label:** `feature`, `atlas`, `file-production`, `read-model`, `privacy`, `tdd`

**Dependencies:** ADR38-01. Can start after compact source projection is in place.

### Goal

Preserve auditability without stuffing raw evidence into the Published Report. Raw fetched excerpts, accepted/rejected source diagnostics, and search scratchpad material should live in an optional Evidence Appendix or diagnostic surface.

### User-visible value

The main report stays readable. Power users and developers can still inspect what Atlas collected when debugging a report or validating source coverage.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/checkpoints.ts`
- `src/lib/server/services/atlas/read-model.ts`
- `src/lib/server/services/file-production/` only if producing a companion artifact
- `src/routes/api/chat/files/...` only if an existing route needs to expose a companion generated file
- tests under Atlas and file-production

Do not change:

- Published Report source projection
- default report body
- generated-document source schema unless needed for a companion artifact
- private source text exposure rules

### Implementation details

There are two acceptable implementation options. Choose the smallest one that satisfies product needs:

Option A - diagnostic checkpoint/read-model only:

- Store richer evidence diagnostics in `atlas_round_checkpoints`.
- Expose only admin/developer-safe summary metadata in the read model.
- Do not create a user-visible companion file in v1.

Option B - companion Evidence Appendix generated file:

- Create a separate Markdown or HTML generated file linked from Atlas job metadata.
- Title it clearly as "Atlas Evidence Appendix".
- Include accepted sources, compact raw excerpts, rejected-source reasons, and search query diagnostics.
- Keep it separate from the Published Report's HTML/PDF/Markdown files.
- Consider admin-only or user-visible access deliberately.

Option B should use existing file-production/generated-file infrastructure. It should not create an Atlas-specific artifact store.

Both options must:

- avoid leaking API keys, prompts, hidden chain-of-thought, private unrelated memory, or raw provider diagnostics
- keep explicit user-provided local source privacy intact
- mark parent seed evidence as stale/non-current where relevant
- keep raw excerpts bounded

### Acceptance criteria

- [ ] Raw fetched excerpts no longer need to appear in the Published Report for auditability.
- [ ] Evidence Appendix data is clearly separate from Published Report data.
- [ ] If a companion artifact is created, it has separate generated-file ids/metadata and does not replace the main Atlas outputs.
- [ ] If only diagnostic metadata is created, the read model exposes safe summaries and not raw private source text.
- [ ] Evidence Appendix content is bounded and deterministic.
- [ ] Rejected-source diagnostics, if included, do not dominate the main report.
- [ ] Tests prove Published Report output does not contain appendix raw excerpts.

### Suggested tests

- Checkpoint test: accepted/rejected source diagnostics are stored separately from `assembledMarkdown`.
- Read-model test: public job card does not expose raw source text unexpectedly.
- File-production test if companion artifact exists: main Markdown has compact Sources; appendix Markdown has bounded evidence details.
- Privacy regression test: hidden prompts and API keys are not serialized into appendix data.

### ADR drift checks

- Verify Evidence Appendix does not become the main Sources section.
- Verify no Atlas-specific persistence subsystem is introduced.
- Verify appendix creation does not block report publishing unless storage fails for required main outputs.

## ADR38-07 - Image relevance and density hardening validation

**Type / triage label:** `quality`, `atlas`, `renderer`, `images`, `tdd`

**Dependencies:** Existing `image-quality.ts`. Can run in parallel with source projection work.

### Goal

Confirm and harden Atlas image selection so Published Reports do not include too many pictures, logos, devicons, SVG-ish assets, or weakly relevant decorative images.

### User-visible value

Reports feel curated and readable. Images support the content rather than overwhelming sparse sections.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/image-quality.ts`
- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/atlas/output.test.ts`
- image-search adapter tests if present

Do not change:

- general image search provider
- file-production image rendering contract unless required

### Implementation details

Current code already rejects:

- logos/icons/devicons by text and URL pattern
- SVG/ICO-ish file URLs
- tiny images below useful report size
- candidates without strong query relevance

This issue should verify the existing behavior against the user-reported failure and strengthen missing cases:

- source page title relevance should count, but not overrule logo/icon patterns
- captions should require meaningful overlap with query or target section
- deterministic insertion should avoid placing images before every sparse section
- authored Markdown images should only survive if URL matches a usable candidate
- max image count should consider body size and section count

If source relevance needs a stronger rule, add a small scoring function that compares:

- user query
- section title/brief
- candidate title
- candidate caption
- source title
- source page URL tokens

The score should remain deterministic and testable. Do not use an LLM to judge images in the renderer.

### Acceptance criteria

- [ ] Logo/icon/devicon/SVG-ish candidates are rejected in tests.
- [ ] Weakly related decorative images are rejected even if HTTPS.
- [ ] Usable source-backed images with strong caption/source relevance still render.
- [ ] Deterministic image insertion is capped by both profile limit and report density.
- [ ] Sparse reports do not receive multiple images.
- [ ] Authored Markdown images are filtered against usable candidates.
- [ ] Selected image candidate ids are checkpointed as before.

### Suggested tests

- Existing logo/devicon fixture rejected.
- SVG/ICO URL fixture rejected.
- Candidate with relevant title but logo URL rejected.
- Candidate with relevant caption/source title and normal image URL accepted.
- Sparse two-section report with five candidates renders at most one image.
- Dense report respects profile `maxRenderedImages`.

### ADR drift checks

- Verify image filtering does not become a report quality gate.
- Verify images are not invented by the model.
- Verify images remain source-backed.

## ADR38-08 - Claim Basis, Basis Marker, and source association regression hardening

**Type / triage label:** `quality`, `atlas`, `basis-markers`, `renderer`, `tdd`

**Dependencies:** ADR38-04 and ADR38-05 for writer body changes.

### Goal

Ensure the writer-centered report still feeds Claim Basis audit and Basis Marker projection correctly. The richer body should not break support-level assignment, source associations, or marker layout.

### User-visible value

More substantive reports remain trustworthy. Basis Marker dots stay attached to the claims they explain, and support levels still come from evidence audit rather than model confidence.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/claim-basis.ts`
- `src/lib/server/services/atlas/quality-gates.ts`
- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/file-production/source-schema.ts`
- relevant Svelte/CSS renderer components only if marker line placement is a frontend issue
- Atlas and file-production tests

Do not change:

- support level vocabulary
- source-chip panel shape unless required by a renderer bug
- Claim Basis into confidence-score UI

### Implementation details

The writer pass should preserve enough section metadata for Claim Basis:

- `sectionBriefs`
- `sourceAssociations`
- Evidence Pack ids
- Writer Evidence Card ids if added
- limitations/conflicts

The audit prompt should receive:

- final improved markdown
- Evidence Packs
- Writer Evidence Cards or enough mapping back to packs
- section briefs/source associations
- compact source list
- search limitations

Basis Marker projection should:

- anchor to matching claim text where possible
- fall back to nearest paragraph in section when exact quote fails
- avoid standalone markers floating before or after a paragraph when the paragraph can carry inline markers
- preserve the UI requirement that marker circles appear on the same line as the related text where renderer layout allows

If the "confidence marker circles on their own line" bug is in generated-document rendering rather than Atlas service projection, fix it in the file-production renderer component/CSS and add the smallest visual/unit regression available.

### Acceptance criteria

- [ ] Claim Basis audit still runs after writer improvement.
- [ ] Claim Basis receives enough evidence-card/pack/source mapping to support claims.
- [ ] Support levels remain exactly `supported`, `partial`, `unsupported`.
- [ ] TEI/rerank scores never map to support levels.
- [ ] Basis Markers attach to paragraph text when anchors are found.
- [ ] Fallback markers attach to nearby paragraph text when possible rather than rendering as separate lonely blocks.
- [ ] Marker circles render on the same line as the related text in the Published Report UI.
- [ ] Unsupported or partial claims produce limitation language or visible marker state, not hidden confidence.

### Suggested tests

- Pipeline test: writer output source associations reach audit input.
- Claim Basis test: evidence-card ids can map back to Evidence Pack ids/source refs.
- Renderer test: unlocatable basis falls back to a nearby paragraph marker before standalone block insertion.
- File-production render test or component test: marker dot is inline with paragraph text.
- Regression test: no `confidence` score is emitted from TEI into Basis Marker blocks.

### ADR drift checks

- Verify old Honesty Marker final section does not reappear as a second marker system.
- Verify support levels stay three-state.
- Verify marker UI remains compact and source-grounded.

## ADR38-09 - Checkpoints, lifecycle seeding, read-model metadata, and progress/i18n

**Type / triage label:** `feature`, `atlas`, `read-model`, `lifecycle`, `i18n`, `tdd`

**Dependencies:** ADR38-02 through ADR38-06.

### Goal

Thread the writer-centered architecture through durable checkpoints, continue/fork/revise lifecycle seeds, job read models, progress metadata, and localized UI text without leaking raw evidence into the main report.

### User-visible value

Atlas jobs remain resumable and inspectable. Continue/Fork/Revise use the improved report representation without accidentally feeding raw appendices back into writer context. UI labels remain coherent in English and Hungarian.

### Owned scope

Preferred files:

- `src/lib/server/services/atlas/checkpoints.ts`
- `src/lib/server/services/atlas/read-model.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/worker-runner.ts` only if progress details need adjustment
- chat/file-production read-model surfaces if Atlas metadata is displayed there
- locale files/components if user-visible labels are added

Do not change:

- job table schema unless unavoidable
- conversation route adapter logic
- Normal Chat completion semantics

### Implementation details

Final round checkpoints should preserve:

- writer evidence card count and schema version
- writer evidence cards or a compact safe summary
- report-shape diagnostics
- whether improvement pass ran
- compact source projection summary
- Evidence Appendix pointer/status if implemented
- selected image candidate ids
- Claim Basis coverage summary

Lifecycle seeding should:

- seed future Atlas Continue/Fork/Revise from compressed findings, section briefs, compact source/card summaries, and curated source pool
- not seed from raw Evidence Appendix text by default
- mark parent seed evidence as not fresh
- keep same-family vs new-family behavior from ADR 0037

Read-model/user-visible metadata should:

- expose safe diagnostic summary, not raw prompt/source text
- possibly show "report improved after draft diagnostics" only if there is a product-approved UI place
- keep progress messages human-readable, not literal low-level stages
- localize any new visible strings in English and Hungarian

### Acceptance criteria

- [ ] Final checkpoints include writer/card/report-shape metadata.
- [ ] Continue/Fork/Revise do not use raw appendix text as default writer context.
- [ ] Parent seed evidence remains marked stale/non-current.
- [ ] Read models do not expose raw source dumps accidentally.
- [ ] Any new user-visible labels are localized in English and Hungarian.
- [ ] Existing Atlas cards still show status, outputs, usage, and source counts.
- [ ] Existing reload/resume behavior remains stable.

### Suggested tests

- Checkpoint test: final checkpoint contains writer diagnostics and compact source summary.
- Lifecycle test: child Atlas seed includes compressed findings/card summaries but not raw appendix excerpts.
- Read-model test: public job card omits raw evidence text.
- i18n test if applicable: new labels exist in both locales.
- Regression test: existing Atlas job completion card still links HTML/PDF/Markdown outputs.

### ADR drift checks

- Verify no new stage-local source/gap/claim tables are introduced.
- Verify raw appendix material is not promoted to default writer memory.
- Verify Atlas remains a Normal Chat Turn artifact, not a parallel subsystem.

## ADR38-10 - Regression suite, local gates, remote live test, and push to main

**Type / triage label:** `verification`, `atlas`, `e2e`, `remote-live-testing`, `release`

**Dependencies:** All prior implementation issues.

### Goal

Run an explicit bug and ADR drift hunt after implementation, then verify locally and on the live remote host with real production models before pushing `main`.

### User-visible value

The implementation is not considered complete just because unit tests pass. It must prove the actual Atlas workflow works in production-like conditions and fixes the exact report-quality failure.

### Owned scope

Preferred files:

- no feature files unless bugs are found
- test files and docs may be updated for final regression evidence
- remote-live-testing notes may be added to an internal/local doc if useful

### Required local verification

Run the relevant targeted tests first, then full gates:

```bash
npm run check
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Also run targeted Atlas tests, for example:

```bash
npm test -- src/lib/server/services/atlas/pipeline.test.ts
npm test -- src/lib/server/services/atlas/output.test.ts
```

Use the repository's actual test command names if they differ.

### Required manual/local inspection

Generate or inspect at least one Atlas output for a representative decision query:

```text
Find the most intelligent model with minimal latency and cost that can be self-hosted on a single RT-class GPU. Compare practical options and recommend a stack.
```

The output must be checked for:

- body is substantive and useful
- recommendation is concrete where evidence supports it
- sources are compact
- no long fetched excerpts in Published Report
- no duplicate model-authored Sources section
- images are sparse and relevant
- Basis Markers are inline/near claims
- generated title appears once
- limitations are honest
- downloads/opening the HTML report work

### Required remote live testing

Use `$remote-live-testing` exactly as the final acceptance workflow, not as an optional check. The live test should include:

- deploy/pull final code to the remote AlfyAI host
- restart the service
- confirm `/api/health` returns OK
- inspect journal logs before and after the test
- authenticate in the live app
- submit a real Atlas query using production model settings
- wait for progress and completion
- open the generated HTML report
- download or inspect Markdown/PDF where feasible
- verify compact source projection and substantive report body
- verify no new Atlas/file-production/chat/runtime errors appear in logs

### Push requirement

Only after local gates and remote live testing succeed:

```bash
git add ...
git commit -m "Implement writer-centered Atlas reports"
git push origin main
```

Use the actual branch/mainline state at implementation time. Do not push unrelated user changes. If unrelated dirty files exist, isolate the commit.

### Acceptance criteria

- [ ] All code slices are integrated.
- [ ] Targeted Atlas tests pass.
- [ ] `npm run check` passes with 0 errors and 0 warnings, or exact unrelated pre-existing diagnostics are documented.
- [ ] Fallow has no new regressions, or intentional findings are documented with a real public/dynamic boundary reason.
- [ ] ADR 0038 drift checklist is clean.
- [ ] ADR 0037 regression checklist is clean.
- [ ] Remote live deployment succeeds.
- [ ] Live `/api/health` is OK.
- [ ] Live Atlas job completes with real models.
- [ ] Live report fixes the source-dump failure class.
- [ ] Live logs show no new relevant errors.
- [ ] Code is committed and pushed to `main`.

### ADR 0038 drift checklist

- [ ] Published Report is not a raw source dump.
- [ ] Source Projection is compact and deterministic.
- [ ] Writer receives compact cards, not raw pages.
- [ ] Improvement pass is soft, bounded, and single-pass.
- [ ] No source/body ratio hard cancellation gate exists.
- [ ] No autonomous writer/research loop exists.
- [ ] No second Atlas job is created for improvement.
- [ ] TEI is selection/routing only.
- [ ] No Atlas vector table exists.
- [ ] Source count is not treated as quality.

### ADR 0037 regression checklist

- [ ] Server still owns orchestration.
- [ ] Coverage Review and Gap-Fill remain bounded.
- [ ] Evidence Packs remain compact model-facing artifacts.
- [ ] Claim Basis support levels remain `supported`, `partial`, `unsupported`.
- [ ] Basis Markers supersede visible confidence/honesty-marker sections.
- [ ] Generated title is canonical and rendered once.
- [ ] Model-authored source sections are removed.
- [ ] Checkpoints use existing Atlas checkpoint vocabulary.
- [ ] Atlas remains stored and previewed through file-production/document-workspace infrastructure.

## Suggested Parallelization

Good worker splits:

- Worker A: ADR38-00 and ADR38-01, because diagnostics and compact source projection are closely related and provide the fastest safety fix.
- Worker B: ADR38-02 and ADR38-04, because card contract and writer prompt need tight coordination.
- Worker C: ADR38-03, because TEI routing can be optional and fallback-safe after cards exist.
- Worker D: ADR38-07 and ADR38-08, because image and marker rendering are renderer-quality concerns.
- Worker E: ADR38-06 and ADR38-09, because appendix separation, checkpoints, lifecycle, and read-models share persistence/read-model concerns.
- Orchestrator only: ADR38-10 final drift hunt, local gates, remote live testing, commit, and push.

Avoid parallel edits to `src/lib/server/services/atlas/pipeline.ts` without clear merge ownership. Most slices touch the pipeline, so the Orchestrator should serialize those integrations or assign one pipeline integrator.

## Minimum Viable Repair Sequence

If implementation time must be constrained, do this order:

1. ADR38-00 diagnostics.
2. ADR38-01 compact source projection.
3. ADR38-02 Writer Evidence Cards.
4. ADR38-04 writer pass.
5. ADR38-05 one bounded improvement pass.
6. ADR38-08 Claim Basis/Basis Marker regression.
7. ADR38-10 local and remote verification.

ADR38-03 TEI routing and ADR38-06 Evidence Appendix can improve quality and auditability, but the critical user-visible bug is fixed by compact source projection plus writer-centered synthesis.
