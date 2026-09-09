# Atlas's content pipeline is rebuilt on the harness's research tools, behind a pipeline flag

> Keeps [ADR-0036](0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md) (Atlas is a Normal Chat Turn + one in-process worker), [ADR-0037](0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md) (bounded rounds), and [ADR-0052](0052-replace-searxng-web-research-with-parallel-search.md) (Parallel backend). It **replaces** the content pipeline that [ADR-0038](0038-atlas-publishes-writer-centered-reports-not-source-dumps.md) and [ADR-0040](0040-atlas-quality-gate-analytics-and-rendering-improvements.md) describe (writer-centered assembly, claim-basis markers, model-graded honesty markers) for jobs that run on pipeline v2. [ADR-0053](0053-atlas-post-migration-deepening.md)'s module seams stay as they are for v1.

## Context

Atlas was verified on staging on 2026-09-08 against the local model. The **job infrastructure worked**: the job ledger, claiming, heartbeats, checkpoints, cancel, idempotent kickoff, Continue/Revise/Fork lineage, admin config, analytics, and rendering through file production all behaved. An overview-profile run finished in 16 minutes over 28 sources for 185k input / 106k output tokens and produced Markdown, HTML and PDF.

The **content was poor**, in ways that are all pipeline-shaped rather than model-shaped:

1. Every paragraph carried `(Basis: Partial)`. That string is the Markdown rendering of the `basisMarkers` paragraph annotation — basis *prose* substituted for citations.
2. **Zero inline citations.** Nothing in the report tied a figure to a source; the reader had a source list and a wall of assertions.
3. The source list contained a `301 Moved Permanently` stub, a LinkedIn company page, the same article three times through CDN and staging hostnames, and a stock image from a vendor blog.
4. Heading levels were inconsistent, because ~1,600 lines of report-shape repair heuristics were reconstructing document structure out of free-form model Markdown.

The root cause is that v1 asks one model call to produce a whole well-formed report from a prose evidence brief, and then spends most of its code repairing that output. Nothing in the pipeline can answer "does the number in this sentence appear in the source it cites?", because no sentence is attached to a source in the first place.

Meanwhile the normal-chat harness already has the pieces a research report needs: `research_web` (Parallel search + in-call `readPages` extraction) behind a per-conversation result cache, `canonicalizeGroundedWebUrl` for URL identity, `web-citation-audit` for citation resolution, `run_python` for arithmetic, and file production's `documentSource` block schema for deterministic rendering.

## Decision

**Keep the job infrastructure. Rebuild the content pipeline on the harness's tools, as `atlas-v2`, selected per job by an `ATLAS_PIPELINE` flag (`v1` | `v2`, default `v1`) recorded on the job row as `pipeline_version`.**

The flag is an env key and an admin-config key; the send route resolves it at kickoff and stamps the job, and the worker dispatches on the stamped value, so a flag flip never changes the pipeline of an already-queued job and Continue/Revise/Fork keeps a family on one pipeline.

v2 replaces free-form report Markdown with a **structured, sentence-level contract between the writer and the verifier**. The writer emits sentences with citation numbers; nothing else in the pipeline has to guess where a claim starts or which source it came from. That single change is what makes citation density, number checking, corroboration, and contradiction detection possible at all, and it removes the need for report-shape repair.

### Stages

Each stage is a durable checkpoint, resumable, cancellable through the existing heartbeat, and reports progress in the contract shape below.

1. **Plan** — one control-model call. 4–8 research questions (overview 6, in-depth 10, exhaustive 16) plus a flat section outline. Continue/Revise/Fork seed the plan and the evidence index from the parent job's stored checkpoint.
2. **Research** — bounded rounds (overview 1, in-depth 2, exhaustive 3). Per question, the **same `research_web` path chat uses**: Parallel search plus `readPages` page extraction (overview 2 pages, in-depth 3, exhaustive 4), fanned out at the existing search concurrency limit, through the existing per-conversation tool result cache. Between rounds a one-call coverage check names thin questions and proposes targeted queries; the exhaustive profile's last round searches specifically for contradicting figures. A question that already has `ATLAS_V2_COVERAGE_SUFFICIENT_SOURCES` (3) indexed sources is never re-researched, whatever the coverage model says.
3. **Evidence index** — deterministic, no model. Capped at the profile's source budget (`ATLAS_V2_MAX_SOURCES_*`: 20 / 40 / 80) before anything is written, dropping sources round-robin across the research questions so every question keeps representation, then renumbered 1..k. Canonicalise with `canonicalizeGroundedWebUrl`; drop redirect and HTTP-status stubs, social profiles, nav-boilerplate-only snippets, duplicate canonical URLs, and the same article reached through CDN/staging hostnames (title + path-slug identity). Keep title, host, publisher organisation, date, snippets and page excerpts; number the sources; build a per-question snippet index; record `filteredCount`.
4. **Write sections** — one writer call per section, three in parallel. Input is the outline, that section's numbered evidence, and a **sentence budget** derived from the profile's word budget. Output is JSON paragraphs of sentences, each with its citation numbers. Rules: every figure, date, name or quantity carries `[n]`; at most two citations per sentence; a sentence carrying no factual claim carries no citation. No images. **No basis prose.** An executive summary is written LAST from the finished sections and becomes the assistant message text; its first sentence must answer the core question, and it is re-run once if it cites none of that question's evidence.
5. **Verify** — deterministic first, model only where deterministic checking cannot reach.
   - every `[n]` resolves to an indexed source;
   - every number and date in a cited sentence appears in that source's snippet or page text, matched across unit and format variants (`8 GW` / `8GW` / `8,000 MW` / `8 gigawatts`);
   - only an actual **quantity** is checked: years, full dates, model/version tokens and ordinals are recognised as such and never hunted for in a source, and a mismatch names the closest figure the source does state;
   - non-numeric cited claims get a yes/no entailment check against the snippet, **batched** at `ATLAS_V2_ENTAILMENT_BATCH` (10) claims per audit-model call with a strict JSON array answer, falling back to one call per claim whenever the array does not parse;
   - a failure goes back to the writer **once** with the exact mismatch, then the sentence is **cut**;
   - confidence per claim: `corroborated` (the same figure from ≥2 sources in different organisations, grouped by publisher with a small syndication/aggregator table), `single`, `inferred` (no direct source — allowed only in explicitly hedged synthesis sentences the writer marks, and only when no number sits in them);
   - contradictions: only the sources the sentence itself cites are compared, and only when the competing figure carries the same unit and sits in a passage sharing keywords, entity and year with the figure's own context in the sentence. Never a pairwise scan of the whole index. Limitations reports at most `ATLAS_V2_MAX_CONTRADICTION_LINES` (3), each naming the quantity and what each source says the figure is;
   - recency: statistics from sources older than `ATLAS_STALE_MONTHS` (default 18) are listed in Limitations automatically;
   - derived arithmetic comes from `run_python` with its inputs cited, else the sentence is marked `inferred`.
6. **Render** — the existing file-production `documentSource` path. A **length post-cap** runs first: sentences past the profile's word budget are dropped, each section's lead sentence and then the cited sentences kept before the uncited ones, so a writer that ignores its sentence budget still cannot publish an over-length report. Title (from the plan stage, at most 70 characters, with a deterministic word-boundary fallback derived from the request — never a mid-clause truncation), Executive summary, sections, auto-generated Limitations (thin questions, stale sources, contradictions), and numbered Sources as `title — host, date`. Outputs unchanged: HTML primary, PDF and Markdown siblings.

### Citation confidence marks

Confidence rides **inside the paragraph text**, as a Unicode superscript key after each citation group — `ᶜ` corroborated, `ˢ` single, `ⁱ` inferred — with a legend under the executive summary. This renders in all three outputs without touching `file-production`: the HTML renderer already turns `[n]` in paragraph text into a linked, numbered source chip, and the PDF and Markdown renderers pass the text through.

The alternative — reusing the `basisMarkers` paragraph annotation, which the HTML renderer already draws as a coloured tooltip button — is rejected because the Markdown and PDF renderers turn the same annotation into `(Basis: Partial)` prose, which is the defect this ADR exists to remove. Coloured dots in HTML and PDF need a new inline `citation` annotation in `file-production/source-schema.ts` and its three renderers; that is a follow-up in file production's own module, not in Atlas.

### Contract with the UI

`progress_details_json` on the job row, projected by `sanitizeAtlasJobProgressDetails` onto the `AtlasJobCard`:

```
details: {
  pipelineVersion: 2,
  phase: "plan"|"research"|"index"|"write"|"verify"|"render",
  plan: [{ id, question, status: "queued"|"running"|"done", sourceCount, confidence?: "corroborated"|"single"|"mixed"|"thin" }],
  round: { current, total },
  sourcesRead: number,
  next: string,
  phaseDurationsMs?: { plan?, research?, coverage?, index?, write?, verify?, summary?, render? },
  evidence?: { corroborated, single, inferred, cut, filteredCount, sources: [{ n, title, host, date, cited, snippet }] }
}
```

`evidence` appears once verify has run. The `snippet` field on each source is what lets the evaluation harness check number matches offline without re-fetching the web. v1's `{ queries, roundKind, focus }` details keep working unchanged; the sanitizer dispatches on `pipelineVersion`.

The assistant message linked to a succeeded v2 job gets its `content` set to the executive summary Markdown, so chat follow-ups have the report's substance in context.

## Considered Options

1. **Rebuild the content pipeline behind a flag, keep the job infrastructure (chosen).** The infrastructure is the part that was verified working; the content pipeline is the part that produced junk. A flag plus a stamped `pipeline_version` lets v2 be evaluated against v1 on the same queries on the same box before it becomes the default, and lets a bad run be rolled back by one config value.
2. **Patch v1 in place** — add inline citations to the writer prompt, filter junk sources in `search.ts`, drop the basis markers. Rejected: the citation and number checks need sentence-level structure, and v1's contract with the writer is a Markdown blob. Every check would be a regex over repaired prose, which is how v1 got its 1,600 lines of repair heuristics.
3. **Replace v1 outright, no flag.** Rejected: no way to measure the rebuild against the thing it replaces, and no rollback for in-flight families.
4. **Keep the `basisMarkers` annotation and fix the Markdown renderer.** Rejected as the primary mechanism: it puts Atlas's citation design inside file production's renderers, which Atlas does not own, and basis markers are per-paragraph while confidence is per claim.

## Consequences

- Two content pipelines exist while the evaluation runs. They share the ledger, checkpoints, lifecycle, analytics and rendering; they share no content code. v1 is deleted once v2 is the default and no v1 family is live.
- `atlas_jobs` gains one nullable column, `pipeline_version`. No table is added; `atlas_round_checkpoints` carries v2's phase checkpoints in its existing shape.
- v2 makes many more, smaller model calls (one per section, one per entailment check) instead of a few large ones. Per-call latency and prefix-cache behaviour on the local model matter more than they did; the evaluation harness measures wall time and tokens for both pipelines so the trade is visible rather than assumed.
- The entailment check is the only place a model decides whether a claim stands. It is batched but ordered, logged, and its failure mode is a rewrite-then-cut, so a wrong "no" loses a sentence rather than corrupting the report. A batch whose answer does not parse costs one call per claim instead of being trusted.
- Cutting is a real outcome: a v2 report can be shorter than a v1 report on the same query because unsupported sentences are removed instead of hedged. Limitations says what was cut.
- Images are off in v2. The stock-image defect is fixed by not having the feature until it can cite a source.
- `scripts/atlas-eval.ts` runs both pipelines against a live deployment over 10 hand-checkable queries and reports wall time, tokens, citation resolution, number match, corroboration, junk-source count, citation density, words against the profile budget, section count, disagreement lines, per-phase durations, and whether the executive summary answered the query's `coreAnswerRegex`. v1 reports 0 where a metric does not apply to it, honestly, rather than being excluded.

## First live evaluation, 2026-09-08, and what it changed

Ten queries, all succeeded, every citation resolved. It also exposed six defects, all of them budget- or scope-shaped rather than model-shaped, and all now fixed in the stages above:

1. **The contradiction scan compared everything with everything.** `v2-energy-statistics.md` never stated the additions figure the user asked for; its Limitations carried 256 "sources disagree" lines, and `v2-fast-moving-tech.md` carried 3,065. Every GW figure in every source was compared as if it were the same quantity, and the rewrite-then-cut pass removed the sentences carrying the real answer. Contradictions now come only from cited sources, matched by unit, adjacent keywords, entity and year, and are capped at three lines.
2. **The report answered the wrong question.** The energy report opened with Germany as the leading member state. Plan question 1 is now the request itself, sections are ordered by how directly they answer it, and the summary is re-run once if it rests on none of that question's evidence.
3. **Nothing bounded length or sources.** Word counts ran from 430 to 33,212 and one report read 189 sources. Per-profile budgets (700-1,100 / 1,800-2,800 / 3,500-5,500 words; 20 / 40 / 80 sources) are now enforced twice: as a sentence cap in the writer prompt, and as a deterministic post-cap.
4. **Wall time was 15-34 minutes.** One audit call per claim was the largest cost. Entailment is batched ten claims to a call, sections are written three at a time, coverage re-research is skipped for answered questions, and per-phase durations are reported so the next run can be attributed rather than guessed at.
5. **Number matching produced false positives.** "2025", "January 21, 2026", "13 9343" and "GPT-5.6" were all reported as figures the source did not carry. Only quantities are checked now, on both the server and the harness side.
6. **Citation density ran at 12-18 per 100 words, and titles were the request cut at 80 characters** ("...and how does that"). A sentence may now cite at most two sources, and the title comes from the plan stage with a word-boundary fallback.
