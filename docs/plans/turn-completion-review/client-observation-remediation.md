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
