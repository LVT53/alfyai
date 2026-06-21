# Atlas uses bounded adaptive rounds, not autonomous research loops

Atlas should improve report quality through better intermediate evidence artifacts and bounded repair rounds, not by becoming a free-form deep research agent. Public research and product signals point in two useful directions:

- Alibaba Tongyi DeepResearch's open ReAct inference shows true multi-turn model-controlled tool use, while its WebWeaver work emphasizes dynamic outlines, source memory, and section-level synthesis. The exact Tongyi "Heavy" product mode is not fully open-sourced.
- Parallel's public Task API exposes a Research Basis contract: atomic outputs can carry citations, excerpts, confidence, and compact reasoning. Its internal agent architecture is proprietary, but the output contract is directly useful for Atlas.

We choose a bounded Atlas architecture: the server owns orchestration, profiles own budgets, and the model contributes semantic judgment inside typed stages. Atlas may run adaptive coverage review and gap-fill rounds inside one Atlas Turn, but those rounds are capped and cannot recursively decide to keep researching.

## Considered Options

1. **Bounded adaptive Atlas rounds (chosen)** - keep Atlas as a Normal Chat Turn plus background artifact job. Add structured Atlas Evidence Packs, Coverage Review, profile-capped Gap-Fill Rounds, section-aware synthesis, and future Atlas Claim Basis / Atlas Basis Markers. The model identifies missing evidence and writes content; the server controls round count, search budgets, source curation, audit, rendering, and stop conditions.

2. **Open-ended ReAct-style Atlas agent (rejected)** - let the model repeatedly decide whether to search, visit pages, run tools, revise the outline, and continue until it feels done. Rejected because it recreates the failure mode of the deleted Deep Research subsystem: hard-to-test orchestration, unpredictable runtime, unclear persistence boundaries, and a model-owned loop that can skip or overrun product constraints.

3. **Full WebWeaver-style dual-agent clone (rejected for now)** - split Atlas into planner/search and writer agents with dynamic outline optimization and section-by-section retrieval. This is directionally useful, but too large a first refactor. Atlas can borrow the evidence-pack and outline-refinement ideas without introducing a second agent framework.

4. **Purely deterministic one-round gap fill (rejected)** - use hardcoded rules to decide missing coverage and run a single repair search. Rejected because it suppresses the LLM strength we actually want: semantic judgment about missing angles, weak evidence, contradictions, and better search targets.

5. **Fourth higher-budget profile (rejected)** - add a larger profile with more sources or tokens. Rejected because current profile timing is already similar in practice, and the quality issue is not just hard caps. More budget without better evidence structure would mostly make the same pipeline produce a longer report.

6. **Visible text support badges throughout the report (rejected)** - render a label such as "Supported" or "Partially supported" beside every factual claim. Rejected because claim support must become abundant, and visible text badges would make Atlas reports visually bloated. Dense support belongs in compact Atlas Basis Markers with details on hover, focus, or tap.

7. **Model-authored Markdown Sources sections (rejected)** - let the model append its own Sources section, bibliography, or citation appendix before the backend appends the canonical Sources section. Rejected because it creates duplicate source sections and lets prose formatting compete with the deterministic source projection. The model may emit structured source rationale and claim/source associations; Atlas renders accepted sources deterministically.

8. **Model title rendered as a body heading (rejected)** - let the model open the report body with its own H1/H2 title or subtitle under a query-derived app title. Rejected because it creates a double-title reading experience and because query-derived titles may be truncated. The model-generated title is the canonical Atlas title, but it must be emitted as structured metadata and rendered once by app-owned chrome/header. The first accented content section should be Executive Summary.

## Decision

Atlas quality work should evolve toward this fixed shape:

```text
decompose
  -> search
  -> curate
  -> build evidence packs
  -> coverage review
  -> bounded gap-fill rounds
  -> section briefs / section-aware synthesis
  -> assemble
  -> basis audit
  -> basis marker projection
  -> deterministic source projection
  -> deterministic report opening cleanup
  -> deterministic render
```

The first implementation should be incremental. Evidence Packs and Atlas Claim Basis are the lowest-risk foundation. Gap-fill should be implemented as one reusable round function and configured by profile, for example:

- Overview: 0 or 1 small gap-fill round
- In-Depth: 1 gap-fill round
- Exhaustive: up to 2 gap-fill rounds, with early stop

Those values are product tuning, not new architecture. Profiles must remain the same execution graph with different caps and posture.

## Guardrails

- The model may identify gaps, but it must not own continuation.
- Gap-fill uses a strict schema: missing question, why current evidence is weak, target search query, desired evidence type, affected section, and priority.
- Atlas continues only when there is a critical or high-value gap, a concrete search target, remaining budget, and the previous round added useful evidence.
- No unbounded loop, recursive planner, hidden subtask runner, per-profile topology, or separate research job family.
- A capped Atlas that still has gaps ships honest Limitations and evidence-derived Atlas Basis Markers rather than asking the user to manually run more Atlas jobs.
- Atlas Claim Basis markers must be evidence-derived. They expose cited support and a compact support rationale, not hidden chain-of-thought or model self-confidence.
- Atlas renders Sources deterministically from accepted sources and structured metadata. Model-authored Markdown Sources sections are invalid output.
- Atlas renders the model-generated report title once through app-owned report chrome/header. Query-derived titles are fallback labels only.
- Atlas Research Rounds remain the durable checkpoint vocabulary. Do not add stage-local persistence unless a later ADR justifies it.

## Atlas Basis Marker UI Contract

Atlas Claim Basis is the fine-grained support data contract. Atlas Basis Marker is the reading-surface affordance and should become the umbrella marker UI for both ordinary claim support and audit-concern states. Atlas Honesty Marker remains only the v1/audit-domain term for gaps, contradictions, language drift, and critical audit findings; the supersession implementation should retire the separate Honesty Marker section and fold audit concerns into Basis Marker states plus Limitations text.

- Basis Markers have exactly three states: supported, partial, and unsupported.
- Visual treatment uses the current success/warning/danger palette. The default report body marker is color-only: a small colored dot/blob/swatch with no icon and no visible text.
- Hover, focus, or tap opens a compact panel. First line is exactly one of: "Supported claim", "Partially supported claim", or "Unsupported claim". Second line: one compact LLM-written support rationale grounded in the relevant excerpt or accepted source, for example "Source X states this, so the claim is supported/partial/unsupported."
- The panel should stay compact. It must not expand into source chips, excerpt lists, a second paragraph, hidden chain-of-thought, or a model-certainty score.
- Marker placement follows logical claim content, not paragraph length. A paragraph can have several markers when it contains several distinct factual claims, and an important fact may receive a mid-sentence marker.
- Adjacent claims can share one Basis Marker only when they rely on the same evidence and the same support rationale. Grouping is for logical sameness, not visual convenience.
- Thin, stale, contested, and ambiguous evidence fold into partial or unsupported based on severity. A hallucinated fact or made-up logical connection is unsupported, not partial.
- Audit concerns that v1 calls Atlas Honesty Markers should render as unsupported or partial Basis Markers when they appear in the report body. The inline marker system should not fork.
- Accessibility is part of the contract: keyboard focus and tap must reveal the same basis detail as hover.

## Atlas Report Opening Contract

- The model-generated title is the canonical Atlas report title.
- The model should emit the title as structured report metadata, not as an H1/H2 body block.
- Atlas renders that generated title once through app-owned report chrome/header.
- Query-derived or job-derived titles are fallback labels only when no valid generated title exists.
- The rendered report body must not begin with a title, subtitle, or alternate report name. If one appears anyway, remove the leading title-like block cluster before rendering.
- The first accented content section after the app-owned generated title should be Executive Summary.
- Duplicate title cleanup is opening-only. It must not delete normal section headings later in the report.

## Atlas Source Projection Contract

- The final Sources section is deterministic and app-owned.
- The model must not emit a Markdown Sources section, bibliography, or citation appendix in the assembled report body.
- The model may emit structured source rationale, source grouping hints, claim/source associations, and desired marker metadata.
- Atlas validates those structured hints against accepted sources before rendering source chips, the canonical Sources section, and Basis Marker panels.
- If the model emits a prose Sources section anyway, the renderer should remove it or the assembly stage should repair it before rendering.

## Edge Cases Locked

1. **Vague gap proposal** - if Coverage Review proposes a broad or non-actionable gap, such as "research more competitors," Atlas does not run a gap-fill search for it. The gap is either narrowed by the stage schema or recorded as a limitation.

2. **No useful evidence added** - if a gap-fill round runs but adds no accepted source, no materially new excerpt, or only duplicate/low-authority material, Atlas stops further gap filling even if the profile cap allows another round.

3. **Contradiction discovered during gap fill** - Atlas should not keep searching indefinitely to force a winner. It records the contradiction in Evidence Packs, marks the affected claim or section with low/contested support, and lets the final report explain the conflict.

4. **Freshness-sensitive claims** - if current-date-sensitive evidence is required and the accepted sources are stale, Atlas may spend a bounded gap-fill round on freshness. If freshness still cannot be established, the report must state the date limitation instead of presenting stale evidence as current.

5. **Parent Atlas seeds** - Continue, Revise, and Fork may use parent compressed findings and curated sources as seed context, but gap-fill decisions must not treat parent evidence as fresh by default. Stale parent evidence can guide searches; it cannot silently satisfy a current factual claim.

6. **Explicit local sources** - user-provided Atlas Local Sources retain highest authority when readable, but a local source alone should not suppress web gap fill when the requested report clearly needs current or external corroboration.

7. **Profile cap reached** - when Overview, In-Depth, or Exhaustive reaches its configured gap-fill cap, Atlas stops. It does not create a follow-up Atlas Turn, ask the model whether to continue, or silently upgrade the profile.

8. **Marker overload** - if a section would receive many markers with the same support basis, Atlas groups nearby claims under a shared Atlas Basis Marker only when the logical support rationale is the same. It does not render a badge after every sentence, but it also does not hide distinct claims just because they appear in one paragraph.

9. **Marker absence** - absence of an Atlas Basis Marker must not be treated as implicit supported status. Substantive factual sections should either have basis coverage or explicit limitation language.

10. **Basis generation failure** - if fine-grained Claim Basis generation fails, Atlas may still ship with section-level source chips and Limitations text, but it must not fabricate support markers to make the report look complete.

11. **Duplicate Sources section** - if the assembled report includes a model-authored Sources section above the deterministic Sources section, Atlas removes or repairs the model-authored section and renders only the canonical Atlas Source Projection.

12. **Duplicate title block** - if the assembled report begins with a title, subtitle, or alternate report name, Atlas removes that opening body title block because the generated title should already be projected into app-owned chrome/header. Executive Summary becomes the first accented content section.

13. **Unsupported claim in normal prose** - unsupported claims should usually be removed, corrected, or reframed as explicit caveats. Unsupported Basis Markers should appear mainly when the report must discuss an unsupported claim, failed assertion, or limitation rather than allowing bad claims to remain in ordinary explanatory prose.

## Implementation Drift Checks

Future implementation should be considered off-course if any of these appear:

- a while loop where the model decides whether Atlas should keep researching
- a new Atlas-specific model runner instead of the existing Normal Chat model boundary
- separate execution graphs for Overview, In-Depth, and Exhaustive
- durable stage-local tables for every gap, source, claim, or marker without a new ADR
- UI copy that calls Basis Markers "confidence markers" or presents support level as model certainty
- report-body markers implemented as bulky visible text pills
- icons inside Basis Markers
- Basis Marker tooltips expanding into source-chip panels, excerpt lists, or multiple paragraphs
- separate visual component families for Basis Markers and Honesty Markers in the report body
- more than three marker states in the report body
- a final Honesty Markers section surviving the Basis Marker supersession implementation
- model-authored Markdown Sources sections surviving beside the deterministic Sources section
- generated titles derived from the user query when a model-generated title exists
- model-authored duplicate title/subtitle blocks surviving under the app-owned title
- title cleanup that deletes non-opening section headings after Executive Summary
- gap-fill rounds that can create additional Atlas jobs without user lifecycle actions such as Continue, Fork, or Revise
- source count increases treated as quality improvement without checking whether accepted evidence actually covers report questions

## Consequences

- Atlas can improve single-job satisfaction without making the user orchestrate several Atlas jobs for one report.
- Quality gains come from source memory, coverage repair, and fine-grained basis markers rather than just larger token/source caps.
- Runtime may increase for In-Depth and Exhaustive profiles, but it stays bounded and explainable.
- The implementation remains testable because the server still controls the pipeline and every adaptive step has typed inputs and outputs.
- Overview can stay fast by using fewer or zero gap-fill rounds while preserving the same architecture and non-negotiable quality gates.

## Sources That Informed The Decision

- Tongyi DeepResearch GitHub: https://github.com/Alibaba-NLP/DeepResearch
- Tongyi DeepResearch FAQ: https://github.com/Alibaba-NLP/DeepResearch/blob/main/FAQ.md
- Tongyi WebWeaver: https://github.com/Alibaba-NLP/DeepResearch/tree/main/WebAgent/WebWeaver
- Parallel Task API: https://parallel.ai/products/task
- Parallel Research Basis docs: https://docs.parallel.ai/task-api/guides/access-research-basis
- Parallel processor docs: https://docs.parallel.ai/task-api/guides/choose-a-processor
