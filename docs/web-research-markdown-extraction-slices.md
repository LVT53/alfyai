# Web Research Markdown Extraction Slices

This is a local `$to-issues` draft for improving model-facing web search quality. It is written as issue-ready implementation slices, but it is not published to the tracker.

## Goal

Improve Normal Chat and Atlas source quality by keeping SearXNG as the search/discovery layer while replacing the current regex-flattened page fetches with clean, citation-safe Markdown extraction.

The default path is **Option 1: in-process Readability plus HTML-to-Markdown extraction**.

## Documentation Check

Evidence reviewed before drafting:

- SearXNG search API documentation: `/search` can return JSON when enabled, but SearXNG remains a discovery/search API and does not provide clean full-page Markdown content.
- `mozilla/readability`: server-side article extraction returns title, content, text content, metadata, and length-like fields after parsing a DOM.
- Turndown documentation: converts HTML to Markdown and supports custom rules for elements that need preservation.
- Firecrawl self-host documentation was checked as a comparison point, but it is not selected for this plan 

## Current State

SearXNG should stay in place as the discovery provider. The quality gap is later in the pipeline:

- `src/lib/server/services/web-research/index.ts` currently opens result pages and converts HTML to readable text through regex stripping.
- That path removes some useful structure, including code blocks, lists, tables, headings, and source-local anchors.
- `research_web` already builds a compact Markdown answer brief, but that Markdown is assembled from flattened snippets and quote candidates rather than source-derived Markdown.
- Atlas source intake should consume opened source text through Atlas-owned checkpoints and final generated files, so cleaner source text should improve source curation, evidence notes, and citation quality.

## Design Guardrails

- Keep SearXNG as the only search/discovery system in this work.
- Keep durable source opening and quote extraction inside the existing `web-research` boundary.
- Keep model-facing web payload shaping inside `web-grounding`.
- Do not create a second Atlas source lifecycle outside the Atlas boundary.
- Do not use an LLM to rewrite evidence text by default.
- Preserve plain-text exact quote extraction for citation checks.
- Preserve source-derived Markdown structure for summaries, page review, and evidence selection.
- Add SSRF and local-network protections before any new fetch path is reused.
- Add extraction quality signals so fallback decisions are deterministic and auditable.
- Cap fallback usage so slow pages cannot dominate end-to-end chat latency.
- Cache extracted content by URL and extractor version, with freshness-aware bypass for live/exact modes.

## Option 1: Default Local Extractor

Option 1 is the default implementation. It runs in the app process and avoids a new service hop for the common case:

1. Fetch the page with the current timeout and content-type checks.
2. Parse HTML through a DOM parser.
3. Run Readability to identify primary content.
4. Convert the resulting article HTML to Markdown with Turndown.
5. Derive plain text from the Markdown for exact quotes and citation audit.
6. Score extraction quality with deterministic signals.
7. Feed Markdown-derived evidence into Normal Chat and Atlas source curation.

Expected latency impact: small for normal pages because this replaces local regex cleanup with local parsing and conversion. The fetch remains the dominant cost.

## Proposed Configuration

These names are draft-level and should be aligned with the existing config-store naming style during implementation.

- `WEB_RESEARCH_EXTRACTOR_MODE=readability|basic|auto`
- `WEB_RESEARCH_EXTRACT_TIMEOUT_MS=6000`
- `WEB_RESEARCH_EXTRACT_CACHE_TTL_HOURS=24`- `WEB_RESEARCH_LLM_EXTRACTION_REVIEW_ENABLED=false`

## Slice Dependency Order

1. `WRE-01` creates the extractor contract and quality signals.
2. `WRE-02` makes Readability Markdown the default extractor.
3. `WRE-03` routes Markdown-derived evidence through Normal Chat and Atlas source curation.
4. `WRE-04` adds cache, configuration, and diagnostics.
6. `WRE-06` adds quality coverage and regression fixtures.
7. `WRE-07` is optional and only covers local LLM review of extraction quality.

## Issue Drafts

### WRE-01. Add The Markdown Extraction Adapter

Type: AFK  
Blocked by: none  
User stories covered: cleaner web sources, no new external dependency yet

What to build:

- Add a server-side extraction adapter behind the `web-research` boundary.
- Define a source extraction result with `title`, `markdown`, `plainText`, `excerpt`, `links`, `metadata`, `quality`, and `diagnostics`.
- Preserve the existing basic regex/text cleanup as a compatibility extractor.
- Add deterministic extraction quality signals such as content length, link density, boilerplate ratio, title match, repeated text ratio, and blocked/captcha hints.
- Add SSRF and local-network validation before opening arbitrary result URLs.

Likely touched modules:

- `src/lib/server/services/web-research/index.ts`
- new `src/lib/server/services/web-research/extraction.ts`
- new `src/lib/server/services/web-research/extraction.test.ts`

Acceptance criteria:

- Existing search behavior still works with the basic extractor.
- Extraction callers receive both Markdown-capable and plain-text fields.
- Unsafe local/private URLs are rejected before fetch.
- Diagnostics expose extractor name, quality score, fallback eligibility, content type, and content length.
- Tests cover HTML, plain text, blocked pages, unsupported content types, and unsafe URLs.

Verification:

- Run the web-research unit tests.
- Add fixtures proving the adapter does not invent source text when fetch or extraction fails.

### WRE-02. Make Readability Markdown The Default Extractor

Type: AFK  
Blocked by: `WRE-01`  
User stories covered: clean model-facing source content, preserved structure, better code/table/list extraction

What to build:

- Add runtime dependencies for Readability, a DOM parser, and HTML-to-Markdown conversion.
- Use Readability to isolate main article content from boilerplate.
- Convert extracted article HTML to Markdown.
- Add Turndown rules for links, headings, lists, tables, code blocks, preformatted text, images with alt text, and citation-friendly inline anchors.
- Derive normalized plain text from the same extracted Markdown for exact quote checks.
- Fall back to the basic extractor when Readability cannot produce usable content.

Likely touched modules:

- `package.json`
- `src/lib/server/services/web-research/extraction.ts`
- `src/lib/server/services/web-research/index.ts`
- `src/lib/server/services/web-research/extraction.test.ts`

Acceptance criteria:

- Readability is the default extractor for HTML pages.
- Code blocks are preserved instead of being removed.
- Lists and tables remain readable in Markdown.
- Navigation/footer/sidebar boilerplate is materially reduced in fixtures.
- Plain-text quote extraction still works from the Markdown-derived text.
- Production installs include the parser/conversion dependencies needed by the server runtime.

Verification:

- Run unit tests for extraction.
- Add fixtures for a documentation page, a news/article page, a table-heavy page, and a code-heavy page.

### WRE-03. Feed Markdown-Derived Evidence Through Web Grounding

Type: AFK  
Blocked by: `WRE-02`  
User stories covered: better Normal Chat citations, better Atlas source review

What to build:

- Replace model-facing snippets derived from flattened HTML text with snippets selected from extracted Markdown/plain text.
- Keep compact payload behavior in `web-grounding` so long pages do not flood the model context.
- Preserve citation URL extraction and citation audit behavior.
- Persist cleaner `sourceText` for Atlas discovered sources through Atlas-owned state.
- Include enough source-local structure in the answer brief for the model to distinguish headings, lists, tables, and code references.
- Keep failed or sparse extraction out of evidence fields unless it is clearly marked as unavailable.

Likely touched modules:

- `src/lib/server/services/web-research/index.ts`
- `src/lib/server/services/web-grounding.ts`
- `src/lib/server/services/atlas/search.ts`
- `src/lib/server/services/atlas/sources.ts`

Acceptance criteria:

- `research_web` still returns compact `sources`, `evidence`, and diagnostics.
- Source snippets are grounded in extracted content, not search result snippets alone, whenever a page is opened successfully.
- Direct URL mode does not fabricate evidence for unfetchable pages.
- Atlas source review receives cleaner source text without changing its lifecycle contract.
- Citation audit still rejects unsupported claims and bad URLs.

Verification:

- Run web-grounding and citation-audit tests.
- Add a fixture where SearXNG snippet text is weak but opened Markdown contains the answer.
- Add a fixture where opened content is unavailable and evidence remains empty or explicitly unavailable.

### WRE-04. Add Extraction Cache And Operational Diagnostics

Type: AFK  
Blocked by: `WRE-02`  
User stories covered: quality improvement without avoidable latency, admin visibility

What to build:

- Cache extracted page content by canonical URL, extractor version, and freshness policy.
- Use shorter cache TTLs or bypass behavior for live/exact modes where freshness matters.
- Expose extraction config through `config-store` using existing runtime/admin patterns.
- Add English and Hungarian admin labels for new settings.
- Add compact diagnostics to Normal Chat stability snapshots: extractor count, fallback count, cache hit rate, extraction latency, blocked count, and low-quality count.
- Ensure diagnostics do not include raw page content, prompts, user IDs, cookies, or API keys.

Likely touched modules:

- `src/lib/server/config-store.ts`
- `src/lib/server/services/normal-chat-stability-snapshot.ts`
- `src/routes/(app)/settings/+page.svelte`
- `src/routes/(app)/settings/_components/SettingsAdminSystemPane.svelte`
- `src/lib/i18n/settings.ts`
- `src/lib/server/services/web-research/extraction.ts`

Acceptance criteria:

- Repeated research on the same URL can reuse cached extraction when freshness policy allows it.
- Cache entries are invalidated by extractor version changes.
- Admin settings can enable/disable modes without bypassing `config-store`.
- Stability diagnostics show extraction health without leaking source content.
- Hungarian and English labels exist for user-visible settings.

Verification:

- Run config and settings tests if present.
- Add tests for cache hit/miss, extractor version invalidation, and diagnostics redaction.

### WRE-06. Add Atlas Quality Coverage For Markdown Sources

Type: AFK  
Blocked by: `WRE-03`  
User stories covered: measurable source-review improvement, regression protection

What to build:

- Add golden fixtures for source pages that currently suffer from flattened extraction.
- Cover at least documentation, product pages, release notes, tables, code examples, and pages with heavy navigation boilerplate.
- Verify that source review can see the relevant content and reject pages where opened content is still unusable.
- Track quality metrics in tests or fixture snapshots: extracted length, boilerplate ratio, relevant heading presence, evidence snippet count, and fallback usage.
- Add a lightweight benchmark or capped timing assertion if the existing test harness can support it without flakiness.

Likely touched modules:

- `src/lib/server/services/web-research/extraction.test.ts`
- `src/lib/server/services/atlas/sources.test.ts`
- `src/lib/server/services/atlas/pipeline.test.ts`
- fixture files under the existing test fixture location

Acceptance criteria:

- Regression tests prove Markdown extraction improves at least one weak-source fixture.
- Source-review tests still reject blocked/captcha/no-usable-content pages.
- Tests verify that evidence snippets are grounded in opened content.
- Fallback usage remains sparse in fixtures unless explicitly testing fallback behavior.

Verification:

- Run web-research extraction tests.
- Run Atlas source and pipeline tests when present.
- Run a focused Normal Chat research tool test.

### WRE-07. Optional Local LLM Extraction Review

Type: HITL  
Blocked by: `WRE-04`; should wait for `WRE-06` evidence  
User stories covered: optional use of local Qwen only when deterministic extraction is not enough

What to build:

- Add an optional local-model review step for extraction quality only.
- Use Qwen to classify blocks as primary content, boilerplate, unrelated, or citation-risky when deterministic quality signals are inconclusive.
- Do not let the LLM rewrite evidence text.
- Do not let the LLM create citations, titles, source snippets, or quote text.
- Keep the feature disabled by default and behind config.

Likely touched modules:

- `src/lib/server/services/web-research/extraction.ts`
- `src/lib/server/services/normal-chat-control-model.ts` or a narrowly scoped local-model helper, depending on existing boundaries
- `src/lib/server/config-store.ts`

Acceptance criteria:

- The local LLM can only return labels or block IDs.
- Source text used for citations remains source-derived.
- The feature is disabled by default.
- Tests prove that hallucinated LLM text cannot enter evidence snippets.

Verification:

- Add schema validation tests for the LLM response.
- Add tests where invalid or verbose LLM output is ignored.

## Recommended Initial Milestone

Ship `WRE-01` through `WRE-04` first. That delivers the default self-hosted, low-latency improvement without adding another runtime service.

Keep `WRE-07` deferred until deterministic extraction have measurable gaps.

## Review Questions Before Publishing Issues

1. Does `WRE-01` through `WRE-04` feel like the right first milestone
2. Is one fallback source per research turn the right starting cap, or should Atlas allow two while Normal Chat stays at one?
4. Should the optional Qwen review slice remain deferred, or should we add it as an experiment behind a hard-off flag in the first milestone?
