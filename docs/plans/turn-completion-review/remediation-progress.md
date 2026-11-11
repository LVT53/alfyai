# Review remediation — 2026-11-11

Baseline: `495282bf4` (validated code `29e51551f`, later documentation only). No provider calls, push or deployment in these fixes.

## 1.1 — Compact stored and read output events

- Original `zz-review-main-persisted-events-size` probe ran unchanged and passed its measurement oracle. Before: 307 / 3,166 / 6,009 stored events; 161,564 / 1,683,676 / 3,193,580 bytes for 1,500 / 9,785 / 20,000 answer characters (latter two include reasoning).
- Added desired invariant in `tests/integration/normal-chat-output-size.test.ts`: metadata <= total text bytes + 8,000 fixed overhead; <= 12 events for these one-step cases. RED: 161,564 was not < 9,500. Legacy-read test RED: 157,419 was not < 7,000.
- Compact snapshot journal combines each scoped block's deltas, preserves all structural events/first sequence and leaves live callbacks untouched. Finalize compacts defensively; message readers compact old per-token metadata without changing stored rows.
- GREEN: 6 focused files, 208 tests (`normal-chat-output-size`, shared reducer, finalize, messages, completion, completion SDK). Replay/scope/interleaving/idempotency/input-immutability covered.
- Logs: `/tmp/turn-completion-remediation/1.1-original-before.log`, `1.1-invariant-red.log`, `1.1-focused-green.log`.
- Existing oversized database rows are not rewritten here; reads serve compact output, but disk space/parse cost needs an explicit migration if desired.
- Docs checked: official Vitest CLI (https://vitest.dev/guide/cli.html), AI SDK generation guide (https://ai-sdk.dev/docs/ai-sdk-core/generating-text); no SDK API changed.

## 1.2 — Preserve JSON code-block answers

- Ran the original D sanitizer cases and A completion JSON case before changes: 4 failed (13 unrelated A cases filtered out). Log: `/tmp/turn-completion-remediation/1.2-original-red.log`.
- Explicit DSML remains control syntax; a JSON fence and ordinary property names do not determine output ownership. Structured final normalization and incremental prefix cleanup preserve fenced examples too; legacy nonstructural cleanup is unchanged.
- The old JSON-is-markup test oracle was corrected to require preservation, as identified in review section 6. Original exact-text assertions retained in permanent tests; additionally assert final normalized content exactly equals the entire answer.
- Original cases GREEN: 4 passed (`1.2-original-green.log`). Seven affected suites GREEN: 164 tests (`1.2-focused-green.log`), including explicit DSML/private-thinking protection and metadata size coverage.
- No new model calls, changes to completion policy or interpretation of prose words.

### 1.2 independent-review follow-up — generic JSON payloads

- Reviewer found structured final normalization still erased a valid `{version:1, blocks:[...]}` example through the legacy document-payload scanner.
- Added bare/fenced regressions for version/blocks, documentSource blocks/template and program/sourceCode, plus four incomplete JSON-prefix cases. RED: 8 failed, 4 passed (`/tmp/turn-completion-remediation/1.2-payload-red.log`).
- Restricted generic document/program payload scanning and prefix buffering to legacy leading cleanup. Structural answers keep these JSON shapes; explicit DSML and private-thinking removal still pass.
- GREEN: 3 suites, 110 tests (`/tmp/turn-completion-remediation/1.2-payload-green.log`). No changes to completion/UI files owned by the concurrent worker.
