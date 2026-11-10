# Proposed runner audit exception for expected user-stop unknown usage

Status: judge review required before implementation. Runner/tests only; no app/accounting-policy change.

A deliberately cancelled generation may end durably `stopped/user_stop` with missing final provider usage. Pending accounting and NULL cost are correct unknowns, not free execution. Ordinary answered/delivered segments must still be ready with final known usage/cost. This exception must not be selected by broad `allowedOutcomes`, an observed outcome alone, or an arbitrary pending row.

## Narrow admission

Carry the fixed scenario key and control result into the generated exact-ID audit identity: `scenario:"stop-control"`, `control:"stopped-after-tool"`, plus receipt `outcome:"stopped"`, `stopCause:"user_stop"`. They come from the runner's selected synthetic scenario and actual parsed completion, not an auditor option. Strengthen the HTTP stop oracle to require explicit receipt user_stop.

A pending segment is eligible only when every matching identity carries that exact expected stop policy and the actual durable row independently has `outcome:"stopped"`, `stop_cause:"user_stop"`. Preserve exact conversation/turn/segment/message agreement, including explicit unsaved NULL message, selected requested model, duplicate rejection, exact attempt manifest and every-attempt actual provider/model/canonical name checks.

For eligible pending stop segments:

- Require at least one manifest child with `usage_final:0` and **cost_usd_micros strictly NULL**. Missing cost field or zero is not an unknown-cost representation and fails.
- Non-final token fields may be NULL or actual nonnegative integer partial observations; do not invent zero/final usage or calculate an estimated price.
- Any final-known child still requires complete valid token counts and nonnegative integer cost, and contributes exactly once to the known-cost subtotal. NULL/unknown final-known costs still fail.
- Ready rows continue to require every child final/known. Pending rows without genuinely non-final children fail; no ordinary pending answered/delivered/paused/failed segment is admitted.
- Pending-stop rows cannot claim an ordinary ready message aggregate. A supplied numeric final aggregate for an eligible unknown-cost segment fails rather than being compared with a partial subtotal.

## Explicit result limits

Return counts for pending stop segments and non-final usage attempts, the sum of known final-attempt costs, `fullyPriced:false` whenever pending remains, and `costUsdMicros:null` rather than presenting the known subtotal as the complete total. Fully priced audits preserve the existing numeric total.

`--inspect` may return successful structural/durable verification for the allowed controls, but uses a distinct report status `verified-http-and-audit-with-pending-stop-usage`, never the fully priced `verified-http-and-audit` status. Report clearly states cancellation usage remains pending and full pricing was not established. HTTP audit-pending exit3 and all ordinary failure behavior remain unchanged. Judge to confirm this distinct successful status/exit0 is appropriate for intentional stop acceptance.

Old partial reports lacking the explicit scenario/control/receipt-cause identity do not acquire the exception by guessing. Existing generated records may be re-extracted by the controller only with their exact corresponding stop receipt and fixed scenario manifest; otherwise rerun the controlled scenario. No DB changes, broad queries or invented receipt fields.

## Focused TDD

Positive: exact expected user_stop pending child with NULL cost; mixture of one known final attempt plus one NULL-cost non-final cancellation attempt, each manifest-counted once; ordinary all-ready behavior unchanged. Negative: ordinary success pending; paused/failed pending; stop without fixed scenario/control; receipt/durable cause mismatch; unexpected model/name; wrong IDs or manifest; pending without non-final children; unknown cost zero/missing; final-known usage/cost missing; supplied priced aggregate on unknown total. Verify explicit report pending counts and no complete-price claim.

All tests synthetic/offline. No production patch, remote execution, full gate, build or browser. Existing metadata-file least-privilege controls and all exact-ID/name audit requirements remain binding.
