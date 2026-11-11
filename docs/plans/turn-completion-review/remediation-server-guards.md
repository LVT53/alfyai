# Server outcomes and guard evidence

## 1.5 server fixes

- Original reviewer stopped-file-save repro and A-completion delivery, resumed usage and six invisible-only cases: **9 failed, 1 control passed**, `/tmp/turn-completion-remediation/1.5-server-original-red.log`; **10 passed** after fixes, `1.5-server-original-green.log`.
- Quiet stopped-file persistence failure now emits the exact error/finish/done sequence. Original reviewer assertions were moved unchanged into the existing `stream-completion.test.ts` fixture; its contradictory quiet-stop oracle now requires the explicit error sequence for both stopped and running cases. Durable finalization markers retain their existing structural handling.
- A verified delivery followed only by transport-failed caption/closing retains `delivered`, with one execution. Unknown effects and Stop/pause retain precedence. The pre-existing test that length-truncated later work remains `incomplete` still passes unchanged.
- Resumed output usage covers only the current segment. The full attempt ledger and its accounting inputs remain intact.
- Invisible-only output excludes Unicode Default_Ignorable_Code_Point and braille blank; visible content, including joined emoji, is not rewritten. Documentation checked: MDN JavaScript Unicode property escapes.
- Added native and flattened later-history reproducers: **2 failed** before labeling (`1.5-history-red.log`). Structural stopped/incomplete/failed partial answers now carry an English completion label in later model context; saved content is unchanged and prose words do not determine the label.
- Six affected suites pass **400 tests**, `1.5-server-focused-green.log`. Permanent outcome tests: `normal-chat-completion-review-outcomes.test.ts`; persistence and history tests remain in their owning suites.

## Section 6 guards

- New timer/dispatch/sanitizer and reconnect assertions: **18 passed**, `section6-guards-green.log`.
- Removed each guard temporarily, ran focused tests and restored exact source in `finally`: working deadline timer **1 failed**, first-output timer **1 failed**, unsettled prior-step execution **2 failed**, leading DSML blanking **1 failed**, reconnect heartbeat **1 failed**, reconnect prelude **1 failed**. Every failure was an intended assertion, not setup/compile failure. Logs: `section6-mutation-{working-timer,first-output-timer,unsettled-dispatch,leading-markup,heartbeat,prelude}.log`.
- Permanent tests: `tests/integration/normal-chat-completion-guards.test.ts` and `stream-reconnect.test.ts`. Timers are observed immediately before/at their actual firing boundary; dispatch checks cover both dispatched and uncertain prior work.

## Browser oracle corrections — awaiting release gate

- `turn-completion-contract.spec.ts` checks exact `Reply failed` versus `Answer incomplete`, matching saved completion and reload state, instead of accepting any of five words.
- Completed observer test now sends an authenticated, same-origin observe POST for the original stream ID, requires an answered terminal receipt/replay and unchanged provider request count.
- Reduced-motion variants assert computed active headline animation: `none` versus `thinking-sweep`. Sustained live chunks and immediate withdrawal were added in 2.1.

## Explicitly open

- Live per-token wire bandwidth/duplicate reasoning frames are unchanged; compact replay fixes retention, not bandwidth.
- No overall bound was added around preparation/finalization. The removed idle/outer watchdog is not restored; working and first-output timers are now directly mutation-protected.
- Small-context 8,192-token model/catalogue certification remains open. Browser fixtures retain their larger advertised context.
- No real-provider calls, build or release gate were run by this worker; the orchestrator owns the full gate and staging-only deployment.
