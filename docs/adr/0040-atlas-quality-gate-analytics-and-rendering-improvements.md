# Atlas quality gate, analytics, and rendering improvements

A series of production issues and UX improvements to Atlas after the writer-centered report migration (ADR 0038) and bounded adaptive rounds (ADR 0037) were deployed. Each change is small and independently revertable.

## Quality Gate Softening

The hard quality gate at the end of the Atlas pipeline threw `AtlasPipelineQualityError` for ANY critical audit marker, including model-generated ones like `multiplier_mismatch` and `misleading_comparison`. These markers flag specific claim-level issues that the audit addendum already surfaces as limitations. Throwing the whole job away for a single model-generated critical marker wasted a full research run and left the user with no report.

**Decision:** Only structural critical markers (`atlas_no_sources`) cause a hard pipeline failure. Model-generated critical markers are downgraded to warnings so the pipeline proceeds to render with the audit addendum appended. The `STRUCTURAL_CRITICAL_MARKER_CODES` set is the authority for which codes are structural.

## Render Poll Timeout

The 30-second poll timeout for Atlas output file production was too tight for larger reports (exhaustive profile with 72 accepted sources). Raised to 120 seconds. The poll interval remains 250ms.

## Null Output Detection

When file production succeeded but didn't produce one of the expected mime types (HTML, PDF, Markdown), the output IDs were silently `null`. The pipeline reported `succeeded` but the UI showed no files. Now: a warning log is emitted when any expected output is missing, and a hard error is thrown when ALL outputs are null.

## Failure Context Persistence

When the quality gate throws, the `failureMetadataJson` column now includes a `failureContext` object with profile, stage, source counts, usage, assembled markdown summary (first 1000 chars), claim basis status, and finish reasons. This makes post-mortem diagnosis possible without replaying the pipeline.

## Atlas Analytics Integration

Atlas pipeline costs were tracked only in the `atlas_jobs` table and were invisible in the analytics dashboard and ContextUsageRing. Now: `recordAtlasJobAnalytics()` inserts a `usageEvents` row when a job completes, using the Atlas job ID as the `messageId` (avoiding conflict with the kickoff message's usage event). The model ID is `"atlas"` with display name `Atlas ({profile})`. This automatically flows into `getConversationCostSummary()` and the analytics dashboard without changes to those queries.

## Pro-Action Parent Status Validation

`loadParentLifecycleSeed` did not verify the parent job's status. A Continue/Fork/Revise from a failed or cancelled job would silently load partial seed data from an incomplete pipeline. Now: the parent must have `status: "succeeded"` for the seed to load. The send route also validates this before creating the lifecycle job, returning 409 if the parent is not succeeded.

## Image Search Freshness

Atlas image search did not pass `time_range` to SearXNG and explicitly filtered year tokens from relevance scoring. For freshness-sensitive queries (e.g. "best LLM servers 2026"), this returned irrelevant old images. Now: `computeAtlasImageSearchTimeRange()` maps query freshness signals to SearXNG `time_range` values, year tokens are kept in relevance scoring for freshness-sensitive queries, and `AtlasImageCandidate` carries a `publishedAt` field for date-aware sorting.

## KB Needs Review Colour and Layout

The Needs Review section used warning-yellow colours and a heavy callout box. Redesigned to use the accent colour system, with a clean section heading, accent-tinted count badge, and cards that match the Memory Profile card style with a 2px accent left border. The reason badge was replaced with small muted text to reduce visual noise.

## Report Rendering Improvements

- Sidebar active state: left-edge accent line with subtle background, no wrapping border
- Tables: full content width (fixed default figure margin gap)
- Section titles: reduced bottom margin for uniform spacing
- Basis markers: vertically centered (not super), only in paragraphs (not headings)
- Sidebar: only H2 section titles (not H3 subtitles)

## Guardrails

- The quality gate softening does NOT remove the `atlas_no_sources` hard failure — genuinely broken reports still fail.
- Analytics recording is fire-and-forget with `.catch()` — analytics failures do not block job completion.
- The parent status validation does NOT prevent Fork from a succeeded job in a different family.
- Image search freshness is additive — non-freshness-sensitive queries are unaffected.
