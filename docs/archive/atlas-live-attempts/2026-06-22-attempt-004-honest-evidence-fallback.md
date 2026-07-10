# Atlas Live Attempt 004 - honest evidence fallback

Date: 2026-06-22
Implementation base: `a73d47bb Reduce Atlas fallback boilerplate repetition`
Deployed commit: `dd8ac242 Replace Atlas fallback writer with honest evidence fallback`
Live base URL: `https://ai.alfydesign.com`
Status: live test completed; awaiting human review

## Trigger

External diagnosis in `docs/atlas-fallback-boilerplate-fix-prompt.md` identified the actual root cause: Atlas still had a deterministic fallback writer that generated fake analysis sections. Previous attempts removed symptoms, but the template writer kept producing new boilerplate.

## Issue

The old fallback path could replace malformed or thin model output with code-generated prose that looked like a report:

- `buildDeterministicFallbackReport`
- `developFallbackSectionText`
- `fallbackValidationSentence`
- section-title matching and query-subject template expansion
- post-audit fallback replacement of the model's audited report

That made reports pass structural diagnostics while still reading as formulaic and underdeveloped.

## Fix Attempted

Replaced the deterministic fallback writer with an honest terminal fallback:

- If assembly repair still yields malformed output, Atlas now emits an evidence listing with `Executive Summary`, `Evidence Summary`, and `Limitations`.
- If writer improvement returns malformed output, Atlas emits the same honest evidence fallback and does not run another repair loop.
- If post-audit report-shape diagnostics find thin/source-dominant output, Atlas keeps the audited model report and appends `Additional Limitations` instead of replacing the report.
- The writer-improvement pass is skipped when the current draft is the honest fallback.
- Malformed-heading sanitization is guarded so it only runs on model output, not the honest fallback.
- Old template-analysis functions and hard-stop fallback code were deleted.

## Local Verification

- `npx vitest run src/lib/server/services/atlas/pipeline.test.ts -t "honest fallback no-evidence|localizes the honest fallback"`: passed, 2 tests.
- `npx vitest run src/lib/server/services/atlas`: passed, 13 files, 145 tests.
- `npm run lint`: passed.
- `npm run check`: passed with 0 errors and 0 warnings.
- `npm test`: passed, 346 files, 3313 tests passed, 1 skipped.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`: passed command execution. Current check report has 4 circular-dependency findings, 0 unused files, 0 unused exports, 0 boundary violations, and 0 policy violations. The circular dependencies do not involve the touched Atlas fallback files.
- Grep for old boilerplate function names and template phrases under `src/lib/server/services/atlas`: no hits.

## Known Scope Note

`src/lib/server/services/atlas/writer-evidence-cards.test.ts` was formatted by Biome because `npm run lint` failed on a pre-existing import-order/format issue in that Atlas test file. This was formatter-only and required for the prompt's lint gate.

## Remote Deployment

- Pushed `dd8ac242` to `origin/main`.
- Remote deploy pulled `dd8ac242`, installed dependencies, verified migrations, applied migrations, built successfully, and restarted `langflow-chat.service`.
- Live health check after restart returned `{"status":"OK"}`.
- Service state after the live test: `active`.
- Remote checkout had pre-existing live-only files before deploy: modified `package-lock.json`, untracked `SELECT`, `eng.traineddata`, `hun.traineddata`, and `nld.traineddata`. They were not removed.
- Journal note: the previous service instance reported `Failed with result 'timeout'` during restart, then a fresh process started cleanly, listened on port 3001, and completed the Atlas job. No application exception was seen in the filtered journal check.

## Live Test Command Shape

```sh
LIVE_AI_BASE_URL=https://ai.alfydesign.com \
LIVE_AI_EMAIL=tester@tester.com \
LIVE_AI_PASSWORD=<redacted> \
LIVE_AI_OUTPUT_DIR=/private/tmp/atlas-live-regression-2026-06-22-dd8ac242 \
LIVE_AI_TIMEOUT_MS=1200000 \
node /private/tmp/atlas-live-regression.mjs
```

## Live IDs And Artifacts

- Conversation: `b953ed44-fecb-4ddf-8db8-8cf3c706c568`
- Atlas job: `48666eae-bfba-4fef-914b-0661a5f020e2`
- File-production job: `49eeaba5-a714-4dd7-ae11-9fba957b1bea`
- Markdown file id: `cb8a990b-daa9-4295-bce4-22e874182845`
- HTML file id: `fabd7af0-25d0-46e6-b3bf-48bdd61433f3`
- PDF file id: `e1d3138b-fd96-4381-9ac9-4c39ae5ca1ff`
- Markdown artifact: `/private/tmp/atlas-live-regression-2026-06-22-dd8ac242/48666eae-bfba-4fef-914b-0661a5f020e2.md`
- HTML artifact: `/private/tmp/atlas-live-regression-2026-06-22-dd8ac242/48666eae-bfba-4fef-914b-0661a5f020e2.html`

## Live Automated Result

- Terminal status: nonzero because the old regression script expected a normal decision report.
- Atlas job status: `succeeded`
- Title: `Self-hosted embedding models for English technical-document retrieval in 2026`
- Accepted sources: 16
- Rejected sources: 82
- Token usage: 127,861 total
- Cost: 20,100 micros
- Top-level sections: 6 including source appendix
- Headings: 7
- Images: 1
- Inline basis markers: 3
- Standalone basis-marker blocks: 1
- Old deterministic fallback phrase: absent
- Honest fallback `Evidence Summary`: present
- `Additional Limitations`: present
- `could not synthesize`: present
- Recommendation heading: absent

The script failed these two assertions:

- `report has no recommendation heading`
- `HTML contains 1 standalone basis marker block(s)`

## Manual Metrics

- Total words: 1,137
- Body words before source appendix: 554
- Source appendix words: 583
- Source share: 51.3%
- Image count: 1

## Manual Assessment

This live test confirms the root fallback change is active in production: Atlas did not manufacture a fake Findings/Tradeoffs/Recommendation report. It emitted the honest fallback shape: `Executive Summary`, `Evidence Summary`, `Limitations`, and `Additional Limitations`.

As a decision-quality report, this output is still not acceptable. It is explicitly a fallback evidence listing and says Atlas could not synthesize the evidence into a report. The source snippets are also noisy: examples include menu/decision-tree residue from Milvus, `Back to Blog Guides` text from FutureAGI, and a typo-like `ixedbread` fragment. The selected image is a generic Unsplash document stack rather than a useful embedding-model visual. The confidence/basis marker placement issue also persists in this fallback output because one marker rendered as a standalone block.

The important difference from attempts 001-003 is that the failure is now honest and visible rather than masked by deterministic template analysis.

## Acceptance

Accepted as verification that the deterministic fallback writer was removed from the production path. Not accepted as a satisfactory Atlas report. Stop here for human review.
