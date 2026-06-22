# Atlas Live Attempt 004 - honest evidence fallback

Date: 2026-06-22
Implementation base: `a73d47bb Reduce Atlas fallback boilerplate repetition`
Status: local verification passed; remote live testing pending

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

## Pending

- Commit and push to `main`.
- Deploy and run remote live testing against production models.
- Update this log with live conversation/job/artifact IDs and manual report assessment.
