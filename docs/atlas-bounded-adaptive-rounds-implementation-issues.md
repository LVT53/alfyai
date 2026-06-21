# Atlas Bounded Adaptive Rounds Implementation Issues

This document is local planning output, not published tracker state. No project issue tracker configuration was present, so this converts the unstaged `CONTEXT.md` Atlas language updates and ADR 0037 into issue-ready implementation waves for future sub-agents.

The plan assumes the current v1 Atlas implementation already exists and should be evolved, not restarted. Future implementation should use `$orchestrate-subagents`; the Orchestrator owns sequencing, review, integration, and final acceptance, while worker sub-agents own bounded code changes.

Generated: 2026-06-21

## Source Decisions / Docs Check

Primary project sources read for this plan:

- `AGENTS.md`: routes are adapters; durable behavior belongs in services; runtime config flows through `config-store.ts`; Drizzle table changes require migrations and `_journal.json`; Atlas must stay inside existing Normal Chat, file-production, document-workspace, knowledge, analytics, privacy, and i18n boundaries.
- Unstaged `CONTEXT.md`, `## Atlas Research Reports`: adds Atlas Evidence Packs, Atlas Coverage Review, Atlas Gap-Fill Round, Atlas Claim Basis, Atlas Basis Marker, Atlas Source Projection, Atlas Report Opening, and Atlas Generated Title terms.
- `docs/adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md`: Atlas is a Normal Chat Turn plus artifact, not a parallel research subsystem.
- `docs/adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md`: chosen architecture is bounded adaptive Atlas rounds, not open-ended ReAct loops or per-profile execution graphs.
- `docs/atlas-normal-chat-turn-implementation-issues.md`: existing local issue plan for the v1 Atlas foundation.
- `/Users/lvt53/.codex/skills/to-issues/SKILL.md`: issues must be independently implementable tracer bullets with behavior-focused acceptance criteria, dependencies, technical notes, and labels.
- `/Users/lvt53/.codex/skills/orchestrate-subagents/SKILL.md`: the future implementation should be orchestrated through bounded worker contracts, reviewed diffs, tracked state, and worker TDD.
- `/Users/lvt53/.codex/skills/tdd/SKILL.md`: code-writing workers must use behavior tests at the highest feasible public interface and report red-green-refactor or why strict test-first was not feasible.
- `/Users/lvt53/.codex/skills/remote-live-testing/SKILL.md`: final acceptance includes local checks, deploy through the live host, service restart, `/api/health`, journal inspection, and live UI smoke tests.

Context7 documentation evidence checked before planning:

- SvelteKit `/sveltejs/kit`: `+server` endpoints export HTTP verb handlers and can return `json(...)`; server-only load data belongs in server load functions. This supports keeping Atlas routes thin and durable logic inside services/read models.
- Drizzle `/drizzle-team/drizzle-orm-docs`: SQLite schema uses `sqliteTable`, `index`, `uniqueIndex`, and JSON can be stored in typed text columns. This supports extending existing Atlas checkpoint JSON without adding stage-local tables unless a later ADR approves them.
- Vercel AI SDK `/vercel/ai`: `generateText` and `streamText` support structured output, tools, usage metadata, and provider abstraction. Atlas stage calls should still go through the app-owned `normal-chat-model` boundary, not new route-local SDK calls.

Current implementation baseline confirmed from source:

- `src/lib/server/services/atlas/` exists with `types.ts`, `config.ts`, `pipeline.ts`, `search.ts`, `quality-gates.ts`, `renderer-output.ts`, `checkpoints.ts`, `read-model.ts`, `job-ledger.ts`, `worker-runner.ts`, and tests.
- `src/lib/server/db/schema.ts` already has the two Atlas-owned tables: `atlas_jobs` and `atlas_round_checkpoints`.
- Current v1 pipeline is `decompose -> search -> curate -> synthesize -> integrate -> assemble -> audit -> render`.
- Current renderer already removes model-authored Sources sections in some cases and appends deterministic source chips.
- Current renderer still emits a final `Honesty markers` section with `confidenceMarker` blocks, while ADR 0037 says Basis Markers should supersede that visible section.
- Current title flow still starts from query/job-derived `job.title`; ADR 0037 requires model-generated Atlas title to become canonical when available and to render once in app-owned report chrome.

## Orchestrator Contract

The future Orchestrator should not implement feature code directly while worker agents can do it. The Orchestrator owns:

- the authoritative task table with owner, scope, status, dependencies, changed paths, blockers, and verification evidence
- worker prompts and disjoint write scopes
- review of every worker diff against ADR 0037 and repository rules
- integration order and conflict resolution
- final local verification, remote deploy, live smoke, and goal completion

Every code-writing worker prompt must include:

```text
You are a worker on a multi-agent task. You are not alone in the codebase.
Do not revert edits made by others. Adjust your implementation to accommodate concurrent changes.
Use $tdd for code development. Report the red-green-refactor loop, or explain why strict test-first work was not feasible and what regression check you added instead.
```

Every worker final report must include:

- Changed paths
- Summary of behavior changed
- Verification run and result
- ADR 0037 drift checks performed
- Blockers or assumptions

## Implementor Codex Goal Directive

The implementation owner must create a Codex Goal before starting code work:

```text
Implement ADR 0037 bounded adaptive Atlas rounds end to end, with no ADR drift or known bugs, and complete only after local verification passes, the change has been deployed to the remote live AlfyAI host, and the live app has been explicitly tested against the spec.
```

The Goal can only be marked complete after all of these are true:

- all planned implementation and repair waves are integrated
- the ADR 0037 drift checklist has no unresolved failures
- local verification gates pass or any pre-existing unrelated failure is documented with exact files and counts
- the branch has been deployed to the live `alfydesign` host through the remote-live-testing workflow
- `langflow-chat.service` is restarted and healthy
- `/api/health` returns `{"status":"OK"}`
- live journal logs show no new Atlas, file-production, chat, or runtime errors from the smoke test
- a live authenticated Atlas smoke test proves kickoff, progress/reload, completion, opening the HTML report, deterministic Sources, Basis Markers, generated title, and downloads work against the ADR 0037 spec

The Goal must not be satisfied by local tests alone.

## Non-Negotiable ADR 0037 Constraints

- The server owns orchestration. The model may identify gaps, but it never decides whether Atlas keeps researching.
- No unbounded loop, recursive planner, hidden subtask runner, or open-ended ReAct agent.
- Overview, In-Depth, and Exhaustive use the same execution graph with different budgets, posture, claim-basis density, and gap-fill caps.
- Do not add stage-local persistence tables for gaps, sources, claims, or markers without a new ADR. Prefer versioned JSON in `atlas_round_checkpoints`.
- Evidence Packs are compact structured stage artifacts, not a second evidence database and not raw search dumps.
- Gap-fill rounds happen inside one Atlas Turn and must not create follow-up Atlas jobs.
- A capped Atlas ships honest Limitations and evidence-derived Basis Markers rather than asking the user to run more jobs manually.
- Claim Basis support levels are exactly `supported`, `partial`, and `unsupported`.
- Basis Markers are evidence-derived; they expose cited support and compact rationale, not hidden chain-of-thought or model certainty.
- Report body Basis Markers are color-only by default: no icon, no visible text, no bulky pill.
- Hover, focus, or tap panel first line is exactly `Supported claim`, `Partially supported claim`, or `Unsupported claim`.
- The panel second line is one compact source-grounded support rationale. It must not expand into source-chip panels, excerpt lists, multiple paragraphs, or confidence scores.
- Atlas Honesty Markers remain a v1/audit-domain concept only. The report body must not fork into separate Honesty Marker and Basis Marker component families.
- The final Honesty Markers report section must be retired by the Basis Marker supersession implementation.
- The final Sources section is deterministic and app-owned. Model-authored Markdown Sources sections, bibliographies, and citation appendices are invalid output.
- The model-generated title is canonical when available. It is emitted as structured metadata, rendered once through app-owned report chrome/header, and not repeated as a body title/subtitle.
- Opening title cleanup is opening-only and must not delete normal headings after Executive Summary.
- Absence of a Basis Marker is not implicit support. Substantive factual sections need basis coverage or explicit limitation language.
- Unsupported claims in ordinary prose should usually be removed, corrected, or reframed as caveats; unsupported markers are mainly for claims that must be discussed as limitations or disputed assertions.

## Wave Index

1. ADR37-01 - Evidence Packs become the model-facing source memory between curation and synthesis
2. ADR37-02 - Coverage Review emits typed, actionable gap proposals under server-owned profile caps
3. ADR37-03 - Gap-Fill Rounds run as bounded reusable Atlas Research Rounds
4. ADR37-04 - Section briefs and generated title metadata feed structured assembly
5. ADR37-05 - Claim Basis generation and basis audit replace confidence-style audit output
6. ADR37-06 - Basis Marker projection and renderers retire the final Honesty Markers section
7. ADR37-07 - Deterministic Source Projection and Report Opening cleanup are hardened
8. ADR37-08 - UI, read models, progress, i18n, and e2e coverage expose the new architecture
9. ADR37-09 - Repair Wave 1: ADR definition drift audit and corrective patches
10. ADR37-10 - Repair Wave 2: bug hardening, full verification, remote deploy, and live spec test

## ADR37-01 - Evidence Packs become the model-facing source memory between curation and synthesis

**Type / triage label:** `feature`, `atlas`, `backend`, `tdd`

**Dependencies:** Existing v1 Atlas pipeline and checkpoint tables.

### Goal

Introduce Atlas Evidence Packs as compact, structured evidence units created from accepted Atlas Web Sources and Atlas Local Sources after curation. Later synthesis, coverage review, gap fill, basis generation, checkpointing, and source projection should consume Evidence Packs rather than raw search-result arrays or unstructured curation prose.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/types.ts`
- new `src/lib/server/services/atlas/evidence-packs.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/checkpoints.ts`
- focused Atlas tests under `src/lib/server/services/atlas/*.test.ts`

Do not change:

- database table count
- `src/routes/**` route behavior
- report renderer UI
- unrelated file-production behavior

### Acceptance criteria

- [ ] `AtlasEvidencePack` type exists with a versioned shape.
- [ ] Each Evidence Pack includes stable id, source refs, source kind (`web` or `local`), authority, supported facets/questions, compact evidence summary or excerpt, conflicts/limitations, freshness metadata when known, and optional affected section hint.
- [ ] Evidence Packs are generated from current accepted local and web sources after the existing curation stage.
- [ ] Evidence Packs are compact enough for model-facing use and do not persist raw fetched page dumps.
- [ ] Explicit user-provided local sources retain highest authority in pack metadata.
- [ ] Parent Atlas seed evidence can be represented but is not silently treated as fresh current evidence.
- [ ] Evidence Packs are written into `atlas_round_checkpoints` JSON using the existing checkpoint row, not a new table.
- [ ] Synthesis and later stages receive Evidence Packs, not just raw source arrays or prose curation text.
- [ ] Existing v1 Atlas behavior remains functional if no packs can be built; the fallback records a limitation instead of fabricating packs.
- [ ] Conversation read models do not expose raw pack internals or source text beyond existing safe job/card fields.

### Technical notes

- Use Drizzle JSON-in-text discipline already present in checkpoint fields. Do not add `atlas_evidence_packs`.
- Keep pack creation deterministic where possible: source normalization, authority assignment, duplicate collapse, and stable ids should not require an LLM.
- If an LLM helps summarize evidence, route it through `runAtlasModelStage` or a dedicated function behind `normal-chat-model`, not route-local SDK calls.
- Preserve the current local/web source count accounting on `atlas_jobs`.
- Add a checkpoint version note or `evidencePacksVersion` field so future migrations can interpret stored JSON.

### Suggested tests

- Red test: running a fake Atlas pipeline writes Evidence Packs to checkpoint JSON and passes them to synthesis.
- Pack-builder tests for local explicit source, automatic working document source, web source, duplicate URL/title, stale parent seed, and empty source pool.
- Regression test proving no additional Atlas tables are added.
- `npm run check`.

### Worker prompt note

Ask the worker to report the public interface they chose for Evidence Pack creation and why tests verify behavior rather than private helper order.

## ADR37-02 - Coverage Review emits typed, actionable gap proposals under server-owned profile caps

**Type / triage label:** `feature`, `atlas`, `backend`, `model-stage`, `tdd`

**Dependencies:** ADR37-01.

### Goal

Add Atlas Coverage Review after Evidence Pack creation. The model may judge missing angles, weak evidence, contradictions, and freshness needs, but it must return typed gap proposals. The server owns whether any proposal qualifies for a Gap-Fill Round.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/types.ts`
- `src/lib/server/services/atlas/config.ts`
- new `src/lib/server/services/atlas/coverage-review.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/model-stage.ts`
- Atlas tests

Do not change:

- search transport behavior beyond preparing inputs for later wave
- renderer output
- UI cards except maybe progress enum types if unavoidable

### Acceptance criteria

- [ ] `AtlasCoverageReview` and `AtlasGapProposal` types exist.
- [ ] Gap proposal schema includes `missingQuestion`, `whyCurrentEvidenceIsWeak`, `targetSearchQuery`, `desiredEvidenceType`, `affectedSection`, and `priority`.
- [ ] Proposal priority is bounded to explicit values, for example `critical`, `high`, `medium`, `low`.
- [ ] Coverage Review prompt compares intended report questions/outline against Evidence Packs.
- [ ] Server-side validation rejects broad or non-actionable proposals such as "research more competitors" unless narrowed by the schema.
- [ ] Server-side filtering requires a concrete search target, a critical/high-value gap, remaining profile budget, and evidence weakness tied to a report question or section.
- [ ] Profile runtime config gains gap-fill caps without changing execution graph:
  - Overview: 0 or 1 small gap-fill round, chosen explicitly by product tuning
  - In-Depth: 1 gap-fill round
  - Exhaustive: up to 2 gap-fill rounds with early stop
- [ ] Coverage Review has an early-stop result when current Evidence Packs are sufficient.
- [ ] The model output never controls continuation directly; it only emits proposals.
- [ ] Invalid/unparseable review output records a limitation and proceeds without a gap-fill round.

### Technical notes

- Prefer structured model output through the app-owned model-stage boundary. If the current boundary only returns text, parse strict JSON at the Atlas boundary and test malformed cases.
- Keep profile topology identical. A profile can set `maxGapFillRounds`, query budget, accepted-source cap, and claim-basis density, but not skip or reorder architecture stages.
- Avoid naming this "plan approval" or "self-reflection" in code or UI copy.

### Suggested tests

- Red test: a coverage review with a high-priority concrete target triggers a server-approved gap candidate.
- Tests for vague proposal rejection, low-priority skip, cap exhausted skip, no-evidence critical gap, freshness-sensitive stale evidence, and malformed review JSON.
- Config tests proving all profiles expose the same architecture fields with different caps only.
- `npm run check`.

### Worker prompt note

Tell the worker to make continuation a pure server decision and to include a grep result showing no model-owned `continueResearch` or similar control flag drives a loop.

## ADR37-03 - Gap-Fill Rounds run as bounded reusable Atlas Research Rounds

**Type / triage label:** `feature`, `atlas`, `search`, `checkpoint`, `tdd`

**Dependencies:** ADR37-01, ADR37-02.

### Goal

Implement reusable bounded Gap-Fill Rounds inside one Atlas Turn. A Gap-Fill Round uses approved gap proposals to search, curate, update Evidence Packs, and write another Atlas Research Round checkpoint. It must stop when caps or usefulness conditions say stop.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/search.ts`
- `src/lib/server/services/atlas/evidence-packs.ts`
- `src/lib/server/services/atlas/checkpoints.ts`
- `src/lib/server/services/atlas/job-ledger.ts` only if progress/status fields need updates
- Atlas pipeline/search tests

Do not change:

- Atlas job creation/idempotency
- lifecycle actions creating new Atlas jobs
- renderer output

### Acceptance criteria

- [ ] Initial evidence gathering and each Gap-Fill Round share a reusable round function or deep module; logic is not duplicated stage by stage.
- [ ] Gap-fill runs inside the same `atlas_jobs` row and same Atlas Turn.
- [ ] Gap-fill never creates a new Atlas job unless the user explicitly invokes Continue, Fork, or Revise.
- [ ] The server enforces max rounds from profile config.
- [ ] The loop condition is deterministic and server-owned. No `while` loop may ask the model whether to continue.
- [ ] Each approved round consumes concrete target search queries from Coverage Review, with per-round query and accepted-source budgets.
- [ ] New web sources are deduped against existing accepted sources by URL/canonical identity and evidence content where possible.
- [ ] If a round adds no accepted source, no materially new excerpt, or only duplicate/low-authority material, Atlas stops further gap fill even when cap remains.
- [ ] Contradictions discovered during gap fill are preserved in Evidence Packs and later Basis Markers/Limitations; Atlas does not search indefinitely to force a winner.
- [ ] Freshness-sensitive gaps can spend a bounded round on current sources; if still stale, the limitation is explicit.
- [ ] `atlas_round_checkpoints` stores one checkpoint per completed Atlas Research Round, including round number, coverage review, approved gaps, Evidence Packs, source pool, usage, and quality diagnostics.
- [ ] Cancellation still stops the worker and does not resume cancelled partial state.

### Technical notes

- Current checkpoint unique key on `jobId, roundNumber` supports multiple rounds. Use it.
- Round 1 should remain the initial research round. Gap-fill rounds should be round 2+.
- Progress labels should stay human-readable. Do not expose literal repeated internal stage labels if that makes UI noisy.
- Search rate limiting from v1 still applies. Gap-fill should not bypass batch delay, backoff, or failure limits.

### Suggested tests

- Pipeline test where Exhaustive runs two useful gap-fill rounds and then stops by cap.
- Pipeline test where In-Depth stops after one useful gap-fill round.
- Pipeline test where second allowed round is skipped because previous round added no useful evidence.
- Pipeline test where contradiction is preserved as partial/unsupported basis input rather than causing endless search.
- Cancellation/stale recovery regression tests.
- `npm run check`.

### Worker prompt note

Require the worker to include a "no unbounded loop" note in the final report with exact files searched and the condition that stops each round.

## ADR37-04 - Section briefs and generated title metadata feed structured assembly

**Type / triage label:** `feature`, `atlas`, `model-stage`, `title`, `tdd`

**Dependencies:** ADR37-01 through ADR37-03.

### Goal

Move final assembly toward structured report metadata: model-generated title, Executive Summary, section briefs, limitations, and source/basis associations. The model-generated title becomes canonical when valid and the body begins with Executive Summary, not a duplicate title block.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/types.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/model-stage.ts`
- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/atlas/job-ledger.ts`
- `src/lib/server/services/atlas/read-model.ts`
- Atlas output/pipeline tests

Do not change:

- source projection final renderer details beyond title/opening data needed for this wave
- chat UI except title display from read model if needed

### Acceptance criteria

- [ ] Assembly stage can return structured metadata with `generatedTitle`.
- [ ] Valid `generatedTitle` updates the Atlas job title, document source title, file label/request title, and completion card title.
- [ ] Query-derived/job-derived title remains only a fallback when no valid generated title exists.
- [ ] The model is instructed not to emit an H1/H2 title, subtitle, or alternate report name in body Markdown.
- [ ] If the body still begins with a title-like block cluster, opening cleanup removes it.
- [ ] Opening cleanup is limited to the opening region before Executive Summary or the first substantive section.
- [ ] Opening cleanup does not delete normal section headings later in the report.
- [ ] First accented report body section after app-owned title is Executive Summary when the generated output contains one.
- [ ] Section briefs preserve Evidence Pack and source association metadata for later Claim Basis generation.
- [ ] Parent Continue/Revise/Fork seed context does not overwrite the new generated title unless explicitly selected by the current assembly output.

### Technical notes

- Current `generateAtlasJobTitle(query)` is still useful for queued jobs and fallback labels.
- Consider a safe `applyAtlasGeneratedTitle(jobId, title)` ledger function instead of direct DB updates in pipeline code.
- The standard report HTML renderer already renders `source.title` as the H1; keep title ownership there.
- Body cleanup belongs before `appendMarkdownBlocks` or immediately after block parse in `renderer-output.ts`.

### Suggested tests

- Output test proving duplicate opening `# Same Title` is removed and Executive Summary is first body heading.
- Output test proving a later `## Product Title` heading after Executive Summary is not removed.
- Pipeline test proving generated title replaces query-derived title after assembly.
- Fallback test proving invalid/empty generated title keeps query-derived title.
- Read-model/card test proving completion shows generated title.
- `npm run check`.

### Worker prompt note

Ask the worker to explicitly report how title cleanup is constrained to the opening region.

## ADR37-05 - Claim Basis generation and basis audit replace confidence-style audit output

**Type / triage label:** `feature`, `atlas`, `quality`, `evidence`, `tdd`

**Dependencies:** ADR37-01 through ADR37-04.

### Goal

Introduce Atlas Claim Basis as the fine-grained evidence support object for factual claims or dense factual passages. Basis audit should produce `supported`, `partial`, or `unsupported` support levels and compact rationales grounded in accepted evidence. v1 Honesty Marker data should fold into Basis Markers and Limitations instead of a competing final marker section.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/types.ts`
- new `src/lib/server/services/atlas/claim-basis.ts`
- `src/lib/server/services/atlas/quality-gates.ts`
- `src/lib/server/services/atlas/pipeline.ts`
- `src/lib/server/services/atlas/checkpoints.ts`
- Atlas quality tests

Do not change:

- visual marker rendering in this wave unless needed for schema compatibility
- source chips/source projection layout

### Acceptance criteria

- [ ] `AtlasClaimBasis` type exists with stable id, claim locator, support level, cited Evidence Pack/source refs, compact support rationale, and optional audit concern code.
- [ ] Support level is exactly `supported`, `partial`, or `unsupported`.
- [ ] Thin, stale, contested, and ambiguous evidence map to `partial` or `unsupported` based on severity.
- [ ] Hallucinated facts or made-up logical connections map to `unsupported`, not `partial`.
- [ ] Adjacent claims may share one Claim Basis only when they rely on the same evidence and same support rationale.
- [ ] A paragraph with distinct factual claims can receive multiple Claim Basis objects.
- [ ] Important mid-sentence facts can be represented by a claim locator that allows mid-sentence marker placement later.
- [ ] Claim Basis generation uses accepted Evidence Packs and Atlas Basis checks, not hidden chain-of-thought or model self-confidence.
- [ ] Audit concerns currently represented as Honesty Markers are transformed into partial/unsupported Claim Basis data and Limitations content where they affect report claims.
- [ ] If Claim Basis generation fails, Atlas may ship with source chips and Limitations, but it must not fabricate markers to make the report look complete.
- [ ] Quality diagnostics in checkpoints include basis generation status, failure reason when applicable, and coverage density by section.

### Technical notes

- Keep `auditAtlasBasis` as a compatibility wrapper if needed, but make new code produce claim-basis-oriented output.
- Avoid naming UI or data fields `confidence`.
- If `GeneratedDocumentSource` cannot yet carry markers, checkpoint Claim Basis first and let ADR37-06 project it.
- Do not store hidden chain-of-thought. Store only compact support rationales suitable for user display.

### Suggested tests

- Quality test for supported claim with direct evidence.
- Quality test for partial claim with stale/thin/contested evidence.
- Quality test for unsupported hallucinated fact.
- Quality test for contradiction becoming partial/unsupported basis plus limitation.
- Failure test proving no fabricated markers when basis generation fails.
- Repo search test or assertion that new Atlas code does not introduce `confidence` naming except legacy compatibility paths scheduled for removal.
- `npm run check`.

### Worker prompt note

Require the worker to include example Claim Basis JSON in the final report, with no raw source dumps and no model-certainty wording.

## ADR37-06 - Basis Marker projection and renderers retire the final Honesty Markers section

**Type / triage label:** `feature`, `atlas`, `file-production`, `ui`, `accessibility`, `tdd`

**Dependencies:** ADR37-05.

### Goal

Project Claim Basis data into compact Atlas Basis Markers in the rendered report body. Retire the final Honesty Markers section and avoid separate visual component families for v1 Honesty concerns versus ordinary claim support.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/file-production/source-schema.ts`
- `src/lib/server/services/file-production/renderers/standard-report-html.ts`
- `src/lib/server/services/file-production/renderers/standard-report-pdf.ts`
- `src/lib/server/services/file-production/renderers/standard-report-markdown.ts`
- `src/lib/server/services/file-production/renderers/standard-report-docx.ts` if the schema surface requires it
- `src/lib/server/services/atlas/renderer-output.ts`
- file-production fixtures/tests
- Atlas output tests

Do not change:

- Atlas search/gap-fill loop logic
- chat composer UI
- unrelated generated document block types

### Acceptance criteria

- [ ] Generated document source schema can represent Atlas Basis Markers or a generalized basis marker block/span without using confidence terminology.
- [ ] Marker states are exactly `supported`, `partial`, and `unsupported`.
- [ ] HTML report body marker default is color-only: a small colored dot/blob/swatch with no icon and no visible text.
- [ ] Marker uses existing success/warning/danger palette.
- [ ] Marker has keyboard focus and tap behavior equivalent to hover.
- [ ] Marker panel first line is exactly one of:
  - `Supported claim`
  - `Partially supported claim`
  - `Unsupported claim`
- [ ] Marker panel second line is exactly one compact source-grounded support rationale.
- [ ] Panel does not include source-chip panels, excerpt lists, multiple paragraphs, hidden chain-of-thought, or model certainty scores.
- [ ] Basis Markers are placed by logical claim content, not paragraph length alone.
- [ ] Nearby claims can share one marker only when the support rationale is the same.
- [ ] Final `Honesty markers` or `Oszintesegi jelolesek` section no longer appears in Atlas reports after Basis Marker supersession.
- [ ] v1 audit concerns render as partial/unsupported Basis Markers or Limitations text, not a separate final report section.
- [ ] PDF/Markdown projections preserve useful support context without bloating the reading flow. If true interactive markers are HTML-only, PDF/Markdown need a deterministic compact fallback.
- [ ] Existing non-Atlas generated reports continue to render supported block types.

### Technical notes

- This is the highest-risk renderer wave. Assign one worker to schema plus renderers, not several overlapping workers.
- The current `confidenceMarker` block is legacy. Either migrate it to a new `basisMarker` shape or keep backward-compatible parsing while Atlas stops emitting it.
- Do not add icons to Basis Markers. Existing source favicons already carry icon weight.
- Use renderer tests and visual fixtures. HTML output should be inspected for CSS class names and text contract.

### Suggested tests

- Source schema tests for valid/invalid support states and compact rationale.
- HTML renderer test proving marker is color-only in default text flow and has accessible focusable trigger.
- HTML renderer test proving exact panel first-line strings.
- HTML renderer test proving no icon markup inside Basis Marker.
- Atlas output test proving no final Honesty Markers section.
- PDF/Markdown renderer tests for compact basis fallback.
- Playwright or rendered HTML screenshot check when this wave is integrated.
- `npm run check`.

### Worker prompt note

Require screenshots or rendered HTML snippets in the final report only as summaries, not huge copied documents.

## ADR37-07 - Deterministic Source Projection and Report Opening cleanup are hardened

**Type / triage label:** `feature`, `atlas`, `renderer`, `quality`, `tdd`

**Dependencies:** ADR37-04, ADR37-06.

### Goal

Harden deterministic Atlas Source Projection and opening cleanup against model drift. The model may emit structured source rationale and claim/source associations, but the final Sources section and source chips are app-owned. The model-generated title renders once.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/renderer-output.ts`
- `src/lib/server/services/atlas/claim-basis.ts`
- `src/lib/server/services/file-production/source-schema.ts`
- `src/lib/server/services/file-production/renderers/standard-report-html.ts`
- Atlas/file-production output tests

Do not change:

- worker queue or job ledger
- search transport
- unrelated document-workspace preview behavior

### Acceptance criteria

- [ ] Final Sources section is generated only from accepted Atlas Web Sources, Atlas Local Sources, and validated structured metadata.
- [ ] Model-authored Markdown Sources section, bibliography, citation appendix, or prose source list is removed or repaired before rendering.
- [ ] Source chip rendering uses accepted sources and validated association metadata, not freeform model URLs.
- [ ] Source grouping preserves `Web Sources` and `Your Library` with explicit user-provided source indicator.
- [ ] Model-emitted source associations that reference unknown/unaccepted sources are discarded and recorded as a limitation/diagnostic.
- [ ] Duplicate source sections cannot survive above or beside deterministic Source Projection.
- [ ] Opening cleanup removes duplicate title, subtitle, or alternate report name before Executive Summary.
- [ ] Opening cleanup does not delete headings after Executive Summary.
- [ ] Generated title remains canonical across HTML, PDF, Markdown, document workspace label, and completion card.
- [ ] Existing current tests for canonical Sources still pass or are updated to stricter ADR 0037 behavior.

### Technical notes

- Current `removeModelAuthoredSourcesSections` is a starting point, but ADR 0037 requires stricter duplicate-source protection and structured source validation.
- Consider adding a `sourceProjectionDiagnostics` field to checkpoint summary rather than exposing raw diagnostics in read models.
- Keep English/Hungarian source chrome parity.

### Suggested tests

- Model-authored `## Sources`, `## Bibliography`, `## References`, `## Forrasok`, and numbered prose source appendices are removed.
- A legitimate analytical section that mentions "sources" in prose is not removed unless it is an actual source section.
- Unknown source association is discarded.
- Duplicate opening title block is removed; later headings survive.
- Completion card and generated files use the model-generated title.
- `npm run check`.

### Worker prompt note

Ask the worker to report examples of source-section false positives they guarded against.

## ADR37-08 - UI, read models, progress, i18n, and e2e coverage expose the new architecture

**Type / triage label:** `feature`, `atlas`, `frontend`, `i18n`, `e2e`

**Dependencies:** ADR37-01 through ADR37-07.

### Goal

Expose the bounded adaptive architecture to users without leaking internal stage noise. Progress, completion cards, document workspace opening, report viewer, and localized copy should reflect Evidence Packs, gap-fill, Basis Markers, generated title, deterministic Sources, and limitations.

### Owned scope

Preferred worker scope:

- `src/lib/server/services/atlas/read-model.ts`
- `src/lib/client/api/atlas.ts`
- `src/lib/components/chat/AtlasCard.svelte`
- `src/lib/components/chat/AtlasCard.test.ts`
- chat page route adapter files only if needed for polling/opening
- i18n files
- `tests/e2e/atlas*.spec.ts` or existing relevant e2e suites

Do not change:

- Atlas pipeline internals
- file-production renderer internals
- unrelated sidebar behavior except Atlas badge state if required

### Acceptance criteria

- [ ] Progress messages cover coverage review and bounded gap-fill without showing noisy repeated internal stages.
- [ ] Human-readable progress can show sanitized research questions and gap-fill focus only when safe.
- [ ] UI copy uses Atlas Basis Marker language, not "confidence marker".
- [ ] Completion card displays generated title, profile name, duration, source count, and cost summary.
- [ ] Open remains the only text action on completion card.
- [ ] Download, Continue, Fork, and Revise remain icon-only with accessible labels/tooltips.
- [ ] Sidebar unseen-completion badge still works with new generated title/read-model data.
- [ ] Document Workspace opens the HTML Atlas by default.
- [ ] EN/HU chrome strings are added or updated for coverage review, gap fill, Basis Marker, limitations, and source projection states.
- [ ] No user-facing report or UI copy calls Atlas "deep research", "confidence marker", "research loop", or "agent loop".
- [ ] E2E covers an Atlas that runs a bounded gap-fill round and then completes.
- [ ] E2E covers reload during gap fill and confirms progress restores.
- [ ] E2E covers generated title and no duplicate opening body title.
- [ ] E2E covers deterministic Sources and absence of final Honesty Markers section.
- [ ] E2E covers Basis Marker hover/focus/tap accessibility at least in HTML report preview.

### Technical notes

- Keep reusable fetch logic in `src/lib/client/api/atlas.ts`.
- Keep cross-page orchestration in the chat page/client runtime, not in `MessageInput.svelte`.
- Do not expose raw Evidence Packs, raw excerpts, raw prompts, or hidden audit payloads through read models.

### Suggested tests

- Component tests for AtlasCard progress and completion labels.
- i18n parity checks for all new keys.
- Playwright Atlas e2e using fake model/search where possible for deterministic timing.
- Mobile and desktop visual checks for marker panels and title/source layout.
- `npm run check`.

### Worker prompt note

Require the worker to include screenshots or Playwright trace references for mobile/desktop marker and title states when feasible.

## ADR37-09 - Repair Wave 1: ADR definition drift audit and corrective patches

**Type / triage label:** `repair`, `atlas`, `architecture`, `verification`

**Dependencies:** ADR37-01 through ADR37-08.

### Goal

Run a full implementation drift audit against ADR 0037 and repair any mismatches. This wave exists because the architecture has many negative constraints that normal feature tests can miss.

### Orchestrator approach

Start with a read-only explorer agent, then dispatch narrow repair workers only for confirmed drift. Do not let the explorer edit files.

Explorer prompt:

```text
Answer this specific codebase question without editing files:
Does the current Atlas ADR37 implementation drift from docs/adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md or the Atlas section of CONTEXT.md?

Inspect Atlas pipeline, model-stage prompts, config, checkpoint JSON, renderer-output, file-production source schema/renderers, UI copy, i18n, tests, and docs touched by implementation.

Return:
- Direct answer
- Drift findings grouped by ADR rule
- File paths and line references
- Suggested repair owner/scope for each finding
- Risks or unknowns
```

### Acceptance criteria

- [ ] Explorer audit covers every item in the ADR 0037 `Implementation Drift Checks` section.
- [ ] No model-owned continuation loop exists.
- [ ] No new Atlas-specific model runner bypasses `normal-chat-model`.
- [ ] Overview, In-Depth, and Exhaustive do not have separate execution graphs.
- [ ] No unauthorized durable stage-local tables were added.
- [ ] UI copy does not call Basis Markers "confidence markers" or present support level as model certainty.
- [ ] Report body Basis Markers are not bulky visible text pills.
- [ ] Basis Markers contain no icons.
- [ ] Basis Marker panels do not expand into source-chip panels, excerpt lists, or multiple paragraphs.
- [ ] There are not more than three marker states in the report body.
- [ ] There are not separate visual component families for Basis Markers and Honesty Markers.
- [ ] Final Honesty Markers section is gone after supersession.
- [ ] Model-authored Markdown Sources sections cannot survive beside deterministic Sources.
- [ ] Generated titles are not query-derived when model-generated title exists.
- [ ] Duplicate model-authored title/subtitle blocks cannot survive under app-owned title.
- [ ] Title cleanup does not delete non-opening section headings after Executive Summary.
- [ ] Gap-fill rounds cannot create additional Atlas jobs without user lifecycle actions.
- [ ] Source count increases are not treated as quality improvement without checking coverage.
- [ ] Every confirmed drift has a repair patch, test, or explicitly documented follow-up only if the user accepts deferral.

### Suggested repair workers

- Drift Repair A: pipeline/config/model-stage drift
- Drift Repair B: renderer/schema/UI terminology drift
- Drift Repair C: title/source projection drift
- Drift Repair D: tests/docs drift

Each repair worker gets only the paths needed for its finding. If findings overlap, the Orchestrator serializes those workers.

### Verification

- Targeted tests from repaired areas.
- `rg -n "confidence marker|confidenceMarker|Honesty markers|deep research|research loop|agent loop|continueResearch|while .*research|Sources|Bibliography|References" src docs tests`
- Manual review of any remaining hits with exact justification.
- `npm run check`.

## ADR37-10 - Repair Wave 2: bug hardening, full verification, remote deploy, and live spec test

**Type / triage label:** `repair`, `testing`, `release`, `ops`, `remote-live`

**Dependencies:** ADR37-09.

### Goal

Find and fix bugs after drift repair, run the complete local verification matrix, deploy the integrated change to the live host, and prove the live app works against the ADR 0037 spec. This wave is the release gate and the only point where the Implementor Codex Goal may be marked complete.

### Orchestrator approach

Use at least two validation agents before remote deploy:

1. Bug Hunter explorer: read-only, focuses on runtime edge cases, tests, UI states, migrations, and failure handling.
2. Live Readiness explorer: read-only, checks deploy scripts, config gates, SearXNG assumptions, fake/live test strategy, and data safety.

Dispatch repair workers for confirmed bugs. Then run verification from the Orchestrator context.

### Acceptance criteria

- [ ] No known failing targeted Atlas tests remain.
- [ ] No known failing renderer/source-schema tests remain.
- [ ] No known failing client/UI Atlas tests remain.
- [ ] No known failing Playwright Atlas e2e remains.
- [ ] Fresh DB prep works.
- [ ] Upgrade DB prep works.
- [ ] Migration check passes.
- [ ] Fallow has no new unexplained findings.
- [ ] Typecheck is clean: 0 errors and 0 warnings.
- [ ] Build is clean: 0 warnings.
- [ ] Live deployment succeeds through the remote-live-testing workflow.
- [ ] `langflow-chat.service` restarts and stays active.
- [ ] `/api/health` returns `{"status":"OK"}` on the live host.
- [ ] Journal logs from deploy and live smoke show no new Atlas, file-production, chat, SvelteKit, migration, or runtime errors.
- [ ] Live authenticated smoke uses a timestamped harmless Atlas prompt.
- [ ] Live smoke confirms send-route kickoff, progress, reload restoration, bounded gap-fill progress when enabled, completion, generated title, no duplicate body title, Open action, HTML report in Document Workspace, Basis Marker panel, deterministic Sources, PDF/Markdown downloads, and no final Honesty Markers section.
- [ ] If Web Push is configured, push behavior is tested non-destructively; if not configured, polling/sidebar badge still works and push absence is documented.
- [ ] No destructive production actions are run without explicit approval.

### Local verification gates

Run these from the Orchestrator context before remote deploy:

```bash
git status --short --branch
npm run check:migrations
npm run db:prepare
npm run check
npm run lint
npm test
npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-atlas-adr37-fallow.json
```

Focused Playwright matrix:

```bash
npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts
npx playwright test tests/e2e/search-modal.spec.ts tests/e2e/knowledge.spec.ts
npx playwright test tests/e2e/atlas.spec.ts
```

The exact Atlas e2e filename can differ, but equivalent coverage is required.

### Remote live pass

Use the remote-live-testing workflow after local gates pass and the deploy branch is ready.

Remote health commands:

```bash
ssh alfydesign
cd ~/apps/langflow-chat
git status --short --branch
./scripts/deploy.sh
sudo systemctl restart langflow-chat.service
sudo systemctl is-active langflow-chat.service
sudo systemctl status langflow-chat.service --no-pager -n 20
curl -s http://localhost:3001/api/health; printf '\n'
journalctl -u langflow-chat.service --since '15 minutes ago' --no-pager -n 160
journalctl -u langflow-chat.service --since '15 minutes ago' --no-pager -n 160 | grep -Ei 'error|failed|warn|ATLAS|CHAT_STREAM|FILE_PRODUCTION|MEMORY_MAINTENANCE|Listening|Started' || true
timeout 60s journalctl -u langflow-chat.service -f --no-pager
```

Live UI smoke:

- Open `https://ai.alfydesign.com/login`.
- Sign in with the configured test account from the remote-live-testing skill. Do not print the password in final reports.
- Confirm app shell loads.
- Confirm Atlas availability reflects live SearXNG/config state.
- If Atlas is enabled, submit a timestamped harmless prompt such as:

```text
Atlas ADR37 live smoke 2026-06-21T00:00:00Z: create an Overview Atlas about the public history of SvelteKit routing documentation, with current source limitations stated explicitly.
```

- Verify kickoff is send-route/fire-and-forget, not a long-held stream.
- Reload during running job and verify progress restores.
- Let the job complete using Overview or a controlled short live profile if available.
- Open the generated HTML Atlas in Document Workspace.
- Verify generated title appears once in app-owned report chrome/header.
- Verify body begins with Executive Summary or localized equivalent, with no duplicate title/subtitle block.
- Verify compact Basis Marker hover/focus/tap panel with exact first line and one compact rationale.
- Verify deterministic Sources section with accepted Web Sources and Your Library when applicable.
- Verify no final Honesty Markers section survives.
- Verify PDF and Markdown sibling downloads work.
- Check journal logs for errors and for unexpected memory/Honcho enrichment around Atlas content.
- Confirm `/api/health` remains OK after the run.

### Goal completion rule

Only after this wave passes can the Implementor mark the Codex Goal complete. If live deploy or live smoke is blocked by credentials, host access, SearXNG unavailability, or production safety, the Goal must remain active or be marked blocked according to Codex Goal rules. It must not be marked complete based on local verification alone.

## Cross-Wave Sequencing

Recommended Orchestrator sequence:

1. Dispatch ADR37-01 first. Evidence Packs are the data foundation.
2. Dispatch ADR37-02 after Evidence Packs are available. Coverage Review depends on pack shape.
3. Dispatch ADR37-03 after server-approved gaps exist. This is the first wave that changes runtime duration.
4. Dispatch ADR37-04 and ADR37-05 serially unless the Orchestrator can isolate section/title work from claim-basis work cleanly.
5. Dispatch ADR37-06 after Claim Basis shape is stable. Renderer/schema churn is too broad to parallelize heavily.
6. Dispatch ADR37-07 after renderer and title behavior are mostly stable.
7. Dispatch ADR37-08 after backend/read-model outputs are stable.
8. Run ADR37-09 as a mandatory drift repair wave.
9. Run ADR37-10 as mandatory bug/live repair and release gate.

Potential parallelism:

- ADR37-01 tests and pack-builder implementation can be one worker.
- ADR37-02 config/schema and coverage-review parser can be one worker after ADR37-01.
- ADR37-04 title/opening and ADR37-05 claim basis may be parallel only if their write scopes do not overlap in `pipeline.ts`; otherwise serialize.
- ADR37-06 should be a single worker or a tightly coordinated pair because schema/renderers/tests overlap.
- ADR37-08 UI/e2e can begin exploratory test design earlier but should not patch until data contracts stabilize.

## Cross-Wave Verification Themes

Every wave should include focused checks for:

- non-Atlas chat send/stream behavior remains unchanged
- Atlas remains send-route kickoff and does not hold a stream slot
- no raw source dumps, prompts, API keys, or hidden chain-of-thought leak into read models or rendered reports
- EN/HU parity for any user-facing string
- Svelte 5 style in touched components: `$props()`, modern event attributes, no new legacy slots or event modifiers
- Lucide icons only for UI icon additions
- no new direct `process.env` reads in override-aware runtime services
- no new database table without matching ADR, migration, and journal entry
- no new Fallow findings unless justified as intentional public/dynamic boundaries

## Final Orchestrator Report Shape

The future Orchestrator final response after implementation should include:

- waves completed and workers used
- key changed paths grouped by backend, renderer, UI, tests, docs
- local verification commands and results
- Fallow result and any justified findings
- remote deploy commit/branch and live health result
- live smoke prompt timestamp and observed outcome
- explicit statement that ADR 0037 drift checklist passed
- explicit statement that the Implementor Codex Goal was marked complete only after remote live deploy and live spec test, or why it remains blocked

