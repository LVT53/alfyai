# Client and incognito observation remediation — 2026-11-11

## 1.4 d — Invalid terminal observations

- Original C-scope RED: all three cases remained sending after ten minutes (wrong stream, wrong conversation, pending delivered as end).
- Ended invalid readers now settle as explicitly unavailable using this turn's own identity; foreign receipts are never adopted. Queue restoration tested with a follow-up queued after observation starts.
- GREEN: 368 tests across scoped observation and runtime suites. Logs: `/tmp/turn-completion-remediation/1.4d-original-red.log`, `1.4d-green.log`.

## 1.4 e — Retained Stop only protects its own uncertain reply

- Original C-retained RED: independent historical Regenerate returned unavailable (`1.4e-original-red.log`).
- A finished unavailable observation no longer blocks navigation. Historical durable rows can receive independent Regenerate permits; the unresolved stopped row still cannot. Epoch, row identity and single-permit ownership checks remain.
- Updated two old tests that explicitly accepted the regression. Fixtures release newly granted navigation/historical permits before requesting another, as real command callers must; the original historical-ready assertion is unchanged.
- GREEN: 367 tests across retained Stop, runtime and unsaved observation suites (`1.4e-green.log`).

## 1.4b — saved incognito observation

Original incognito reproducer: red (expected terminal, received unavailable), `/tmp/turn-completion-remediation/1.4b-original-red.log`; unchanged assertions green2 in `1.4b-original-green.log`. Saved incognito replies retain a structural receipt in existing message metadata; owner/conversation/request/turn scoped observation survives lifetime-module restart without writing accounting turns or attempts. Deleted replies become unavailable. Focused lifetime/incognito/unsaved tests green9 (`1.4b-focused-green.log`). No raw answer content is loaded for observation; no incognito ledger introduced.

## 1.4a — bounded pending client observation

The original saved review replay-overflow producer is owned by the server replay slice; it has no client polling harness. Added the missing client invariant first: pending saved answer at140s RED (`1.4a-client-red.log`, isSending false at122s), then GREEN (`1.4a-client-green.log`). The runtime now uses the server's absolute working+closing model deadline plus30s persistence grace. An older server with no deadline gets one finite330s window, never reset on each poll. Observed server deadlines cannot drift later on subsequent reads. Reconnect remains observe-only; tests complete at140s and400s without generation, and explicitly expire both server-deadline and old-server windows. Lifetime publishes snapshot.deadlineAt only while owned and clears it at settlement. Wire decoder validates the optional positive finite deadline.

Focused runtime, lifetime, incognito and stream transport suites:482 passed (`1.4a-focused-green.log`); added wire deadline preservation test green1 (`1.4a-decoder-green.log`). Full release gate remains orchestrator-owned.
