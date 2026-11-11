# Client and incognito observation remediation — 2026-11-11

## 1.4 d — Invalid terminal observations

- Original C-scope RED: all three cases remained sending after ten minutes (wrong stream, wrong conversation, pending delivered as end).
- Ended invalid readers now settle as explicitly unavailable using this turn's own identity; foreign receipts are never adopted. Queue restoration tested with a follow-up queued after observation starts.
- GREEN: 368 tests across scoped observation and runtime suites. Logs: `/tmp/turn-completion-remediation/1.4d-original-red.log`, `1.4d-green.log`.
