# Lower-severity client/UI remediation — 2026-11-11

Docs checked: official Svelte `$derived` (https://svelte.dev/docs/svelte/$derived) and Vitest fake timers (https://vitest.dev/api/vi.html#vi-usefaketimers).

## Observation and Stop

Original C pending-stop/noop-stop/errorline/duplicate/observation-decode/erased-end: 8 failed,1 passed before changes (`/tmp/turn-completion-remediation/1.5-client-original-red.log`). Pending-stop's eventual navigation was already repaired by1.4e; its missing immediate reader receipt was independently RED after adding an immediate-ready assertion while retaining the original eventual assertion (`1.5-pending-receipt-red.log`).

- A pending re-read updates the retained parameter identity, so its abort end is accepted as the retired reader's receipt.
- A no-op Stop cannot retire an owned finalizing read; detached network recovery still loses its epoch, preserving existing cancellation tests.
- Successful private Stop observation does not clear an error another action wrote.
- Malformed terminal observations remain explicitly unavailable without needing a finalization marker. A reconnect with neither observation nor saved identity cannot drain the queue as success.
- Canonical adoption replaces a racing duplicate durable row while preserving the placeholder render identity.

Original Stop subset green4 (`1.5-stop-green.log`); original malformed/duplicate subset green5 (`1.5-observation-green.log`). Original client harnesses consolidated unchanged into `normal-chat-review-client.test.ts` (plus immediate receipt assertion); decoder cases in `normal-chat-observation-decode.test.ts`. Focused compatibility initially found4 detached-recovery regressions; corrected the no-op guard, then394 runtime/review/reply-text tests passed (`1.5-focused-correction.log`). The other339 related helper/transport/display tests passed in `1.5-focused.log`; that earlier run had12 old status-prefix oracles contradicted by this review and the4 recovery regressions, not a green overall run.
