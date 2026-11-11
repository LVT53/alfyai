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

## Answer text is not a status label

Original D8 + K1/K2 RED: empty marker became nonempty text, kept document title came from English status, and empty caption created a document (`1.5-content-original-red.log`). All original assertions GREEN (`1.5-content-original-green.log`). Copy/Open/title/Markdown now retain exact canonical bytes without an app status prefix, and empty/whitespace-only captions stay empty. Existing localized message status UI remains the status owner. Contract spec and selected durable-file-linkage policy amended accordingly. Twelve existing reply-text cases encoded the defect; their exact expected strings were replaced by exact canonical bytes or empty strings, preserving both Copy/Markdown parity and source immutability assertions. Original review assertions were never weakened.

D-reducer's other cases were not adopted here: D1–D5 exercise adversarial ordering/identity outside this assigned memo item; D6/D7 concern sanitizer behavior owned by the protocol slice. The original file remains unchanged in the main checkout; only D8 is retained in this slice.
