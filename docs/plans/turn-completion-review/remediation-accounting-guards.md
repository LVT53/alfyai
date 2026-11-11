# Accounting and audit guard remediation — 2026-11-11

Scope: memo 1.5 accounting lookup diagnostics/model identity and unknown page totals; section 6 exact batch/dedup bounds and seven staging audit guards. No live model calls, staging actions, production changes, or historical report edits.

## Accounting and UI defects

- Original `tests~integration~zz-review-E-identity.test.ts.txt` ran unchanged: **2 passed** before fixes (`/tmp/accounting-original-E.log`). E1 measures the defect by asserting loss of `ChatMessage.modelId` despite durable `depthMetadata.modelId`. After the fix its original lost-ID assertion fails, as expected; E2 still passes (`/tmp/accounting-original-E-after.log`). Original source remains untouched in the main checkout.
- Separate desired invariants initially failed: both ledger/usage fault identity cases, missing safe diagnostic, and omitted page totals becoming zero (**4 failed, 11 passed**, `/tmp/accounting-defects-red.log`). Persisted validated depth metadata now supplies model identity when enrichment is unavailable; optional accounting logs a fixed message and selected-row count without raw errors, identifiers or content. Financial data remains unknown.
- The loader preserves missing totals. The old sparse-detail test's exact expected totals changed from invented zero to `undefined`; assertions were retained. Explicit zero and positive totals still have distinct tests.
- Rendered tests first failed for a loaded chat inventing `$0.0000` and a ring unable to render an unavailable measurement (**2 failed**, `/tmp/accounting-ui-red.log`). Page initial/reset state carries `null` through the composer to the ring, which shows localized `Unavailable` / `Nem érhető el`. Known zero with known tokens still displays a zero cost. Both rendered tests pass (`/tmp/accounting-ui-green.log`). Other callers' omitted props retain the empty-chat defaults.

## Mutation evidence

New tests inspect real SQLite statement bindings, not only query counts. Duplicate input IDs spanning batches must produce exactly `[500, 500, 1]` bindings, once per unique ID, on each applicable ledger/history query.

| Minimal mutation | Target assertion | Result |
|---|---|---|
| Ledger reader batch 500 → 503 | Exact bound | Failed |
| Ledger reader removes Set | Unique bindings and batch counts | Failed |
| Optional reader batch 500 → 503 | Exact bound | Failed |
| Optional reader removes Set | Unique bindings and batch counts | Failed |

Each mutation ran separately, then the original source was restored in `finally`. Logs: `/tmp/accounting-mutation-{ledger,optional}-{bound,dedup}.log`.

The verifier code already had all seven guards; only tests were missing. Seven synthetic corrupt audits now assert their specific rejection, alongside an accepted healthy fixture. Each corresponding `need(...)` was individually removed from an isolated temporary copy, and each run failed its corresponding test. The real verifier was never modified. Logs `/tmp/audit-mutation-1.log` through `-7.log`:

1. Generated turn missing from audit.
2. Unscoped attempt.
3. Accounting not ready (outside the existing explicit pending-stop exception).
4. Durable outcome differs from receipt.
5. Duplicate terminal segment.
6. Unknown final attempt token count.
7. Rows outside generated identities.

## Validation and limits

Focused tests: six files / 171 assertions, plus the two rendered regressions. Final result recorded in `/tmp/accounting-slice-final.log`; rendered result in `/tmp/accounting-ui-green.log`. `npm run check` found no diagnostics in this slice; at that checkpoint it reported one unrelated concurrent `normal-chat-retained-stop.test.ts:167` mock return-type error and zero warnings. Parent owns the final full release gate.

Official API checks: Vitest `vi.spyOn` documentation and Svelte `$props` fallback/nullable-value documentation. Existing service, route and component boundaries retained.

Read-only findings handed to the browser owner: closing-error/empty/truncated browser tests should assert each exact outcome rather than a five-word regex; the second observer test should actually issue an observe request and count provider calls; reduced-motion variants need animation/duration assertions; an 8,192-token fake-model case should exercise context exhaustion with the actual catalogue and restore its model override. These browser changes are outside this accounting slice. E2's incognito arbitrary-ID measurement and nullable attempt outcome/stop-cause audit facts are also not changed here.
