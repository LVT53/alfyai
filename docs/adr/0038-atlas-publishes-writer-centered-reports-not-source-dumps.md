# Atlas publishes writer-centered reports, not source dumps

> **Historical (v1) — superseded by [ADR-0063](0063-atlas-v3-reasons-from-an-evidence-bank-not-from-search-excerpts.md)'s v3-only consolidation (Phase B, 2026-09-23).** The writer-centered mechanics this ADR describes — the source-appendix/report-body split, and the Writer Evidence Card concept it motivated — are v1's, and their modules (`renderer-output.ts`'s repair heuristics, `writer-evidence-cards.ts`) were deleted with the rest of the v1 pipeline. v3 solves the same "don't publish the research scratchpad" problem structurally instead: the writer reads only its own section's evidence ids from the bank and never sees raw fetched pages (ADR 0063). The **"Local Embedding And Reranking Use" section below still applies as written** — Atlas's TEI embedding/reranking guidance (shared `tei-embedder`/`tei-reranker`/`semantic-ranking`/`tei-observability` boundaries, no Atlas-specific vector tables, no reader-visible confidence markers) is pipeline-agnostic and binds v3 too.

Atlas reports must be judged by the usefulness of the published synthesis, not by how much raw evidence the pipeline collected. A live report inspected on 2026-06-22 had about 17,826 words total, but only about 219 words of actual synthesized report content; roughly 97% of the Markdown was a deterministic Sources appendix with long fetched excerpts. The report was structurally valid enough to render, but it did not answer the user well: it had one-sentence sections, source-derived headings, a non-recommendation "Recommendation" section, and a huge source dump that made the artifact look thorough while hiding a thin analysis.

This is not mainly an LLM capability problem. It is a product and pipeline boundary problem. Atlas is currently too willing to publish its research scratchpad. The next quality step is to give the model a clearer final writing job with enough room, while making the renderer keep raw evidence separate from the reader-facing report.

## Considered Options

1. **Writer-centered Atlas report (chosen)** - keep broad search and evidence collection internally, then feed a final writer pass compact evidence cards and report intent. The writer owns the user-facing synthesis, structure, decision framing, rankings, tradeoffs, and recommendations. The rendered report includes compact source projection, not raw fetched excerpts. Raw evidence may be available as a separate evidence appendix or debug artifact.

2. **More hard quality gates (rejected)** - add stricter fail conditions for short reports, bad headings, source/body ratio, missing tables, and weak recommendations. Rejected because the deleted Deep Research pipeline already failed by over-indexing on "this fails the gate" behavior. Atlas should improve a weak draft once, not cancel long-running jobs because the first draft was thin.

3. **More sources and larger profiles (rejected)** - increase search breadth, accepted source caps, or output budgets. Rejected because the observed failure already had enough sources. More collection without a better writer boundary would make the source dump bigger and the report only marginally better.

4. **Let the model write arbitrary citations and appendices (rejected)** - trust the final writer to include whatever source section it wants. Rejected because Atlas Source Projection is already app-owned for good reasons: duplicate model-authored Sources sections and freeform bibliographies are unreliable. The model may write source rationale as structured data, but projection stays deterministic.

5. **Use local embedding/reranking as the main quality judge (rejected)** - score report quality by semantic similarity between the report and sources. Rejected because embedding and reranking models are selection aids, not truth evaluators or writers. They can improve evidence routing, but they cannot decide whether the final report is useful, decisive, or well explained.

## Decision

Atlas should evolve toward a writer-centered final phase:

```text
decompose
  -> search
  -> curate
  -> build evidence packs
  -> coverage review / bounded gap-fill rounds
  -> section-aware synthesis
  -> build writer evidence cards
  -> Atlas writer pass
  -> soft report-shape diagnostics
  -> optional one-pass expansion/improvement
  -> basis audit / basis marker projection
  -> deterministic compact source projection
  -> deterministic render
```

The Atlas writer pass is not another autonomous agent loop. It is a final LLM stage inside the existing Atlas Turn. Its input should be the user request, report intent, current date, profile, constraints, section briefs, conflicts, limitations, and compact writer evidence cards. It should not receive a giant raw source dump.

A writer evidence card should be compact and model-facing:

```ts
type AtlasWriterEvidenceCard = {
  sourceTitle: string;
  url: string | null;
  authority: "official" | "benchmark" | "vendor" | "analysis" | "community" | "unknown";
  relevantFacts: string[];
  limitations: string[];
  conflicts: string[];
  supportsSections: string[];
};
```

The writer should be allowed to choose a useful report structure for the request. Atlas may require a few product-level obligations, such as Executive Summary, Limitations, and source-grounded recommendations where evidence supports them, but it should not force every report through generic headings such as Findings, Tradeoffs, Recommendation, Integrated Report, and Purpose and Scope when the user asked for a decision. For a hardware/model-selection query, a better structure is often ranked shortlist, decision criteria, hardware fit, latency/cost tradeoffs, multilingual coverage, recommended stack, what to avoid, and evidence gaps.

Report-shape diagnostics should be soft and bounded. If the body is clearly too thin, the recommendation lacks a decision, or the source appendix dwarfs the body, Atlas may run one expansion/improvement pass:

```text
The draft is too thin relative to the accepted evidence. Rewrite it into a decision-quality report. Preserve grounded claims, add rankings, tables, tradeoffs, and a definitive recommendation where supported. Do not add sources.
```

After that one pass, Atlas ships the best honest report it can produce if it has a trustworthy source basis and rendering succeeds. It does not enter a repeated fail/retry/cancel loop.

## Source Projection Contract Update

The published Atlas report should contain a compact deterministic source list by default:

- source title
- URL
- short source type or authority label when known
- one concise relevance note

The published report must not append long fetched page excerpts by default. Full fetched excerpts, accepted/rejected source diagnostics, and search scratchpad material belong in a separate evidence appendix, diagnostic artifact, or debug view. They are useful for inspection, but they should not dominate the main reader-facing report.

The source projection should remain app-owned. The model may emit structured source rationale and claim/source associations for validation and rendering, but the renderer decides how much source material is visible in the final artifact.

## Local Embedding And Reranking Use

Atlas can use local TEI embedding and reranking models to improve quality, but only as selection and routing aids:

- shortlist relevant source snippets for each report question or section
- cluster duplicate or near-duplicate source excerpts before evidence-card creation
- route evidence cards to the sections they best support
- pick the strongest evidence cards when the writer context budget is tight
- align drafted claims with likely supporting evidence before basis audit
- reduce appendix size by ranking which source excerpts are worth preserving in the separate evidence appendix

Atlas must use the existing shared TEI boundaries (`tei-embedder`, `semantic-ranking`, `tei-reranker`, and `tei-observability`) rather than creating an Atlas-specific embedding store or routing reranking through chat-completion control models. If Atlas persists embeddings, they must go through the shared `semantic_embeddings` substrate. Per-job web-source scoring can stay ephemeral unless a later ADR justifies durable Atlas source embeddings.

Embedding and reranking results are not support levels. They should never render as "confidence" or decide claim truth by themselves. Claim support remains an Atlas Basis concern: evidence-derived, audited, and expressed as supported, partial, or unsupported.

## Guardrails

- Do not make report-source word ratio a hard cancellation gate.
- Do not render raw fetched excerpts inside the published report by default.
- Do not add a new autonomous writer loop or a second Atlas job for expansion.
- Do not make the writer obey a generic section skeleton when the user request calls for a decision-specific structure.
- Do not treat source count as a quality metric. Source coverage matters only when it improves the final synthesis.
- Do not use embedding/rerank scores as reader-visible confidence markers or truth verdicts.
- Do not create Atlas-specific vector tables. Use shared TEI and semantic embedding boundaries.

## Consequences

- Atlas reports should become shorter in total Markdown when raw sources move out of the main artifact, but substantially richer in actual report body.
- The LLM gets more trust where it is strongest: writing a useful synthesis from compact evidence.
- The system still owns orchestration, budgets, source projection, and basis audit, preserving the bounded Atlas architecture.
- Quality improves through better context shaping and one bounded expansion pass rather than repeated hard-gate failures.
- Local embedding and reranking can improve evidence selection without turning Atlas into another brittle quality-control machine.
