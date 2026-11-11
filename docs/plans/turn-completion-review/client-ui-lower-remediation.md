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

## Disclosed inline thinking

Original D-thinking X1 RED exposed PRIVATE-REASONING-MARKER; GREEN after the shared explicit-control sanitizer is applied only to the display projection. Raw structural blocks remain unchanged. Regression additionally requires visible narration to survive;2 tests passed with retained Stop type fix (`1.5-disclosure-green.log`). Existing ThinkingBlock suite passed in `1.5-focused.log`. X2/X3 batched prop flips are outside the memo's X1 defect and were not adopted; X4/X6 are separate native-reasoning disclosure expectations, and X5 pins pre-regression live-provisional behavior, so none were silently promoted into release requirements. Original complete producer remains in the main checkout.

Retained-stop test mock now returns Promise<ServerUpdateKind>, correcting the reported check diagnostic without any assertion change. Full release check remains orchestrator-owned.

## Release gate correction

First full release Vitest log `/tmp/turn-completion-release-20261111/vitest.log` exposed18 failures in this slice:2 genuine display regressions (literal trailing `<` discarded),15 obsolete status-prefix expectations across Copy/keep/export, and1 obsolete `/new` blocking expectation. The source now uses the existing inline-thinking parser and, at a final boundary outside a recognized thinking region, preserves its unconsumed literal prefix. Original ThinkingBlock.output assertions stayed unchanged; explicit private-thinking and tool syntax guards remain.

Updated downstream exact clipboard/kept-content/chain strings to canonical bytes and exports to exclude the app-written status prefix, preserving all private-data and once-only assertions. EN/HU finalization status assertions remain; live/reload canonical Copy and resumed Stop also assert separate visible status. The page test now requires the unresolved row's Regenerate to leave streams unchanged, then exactly one independent `/new` navigation with only the original2 streams and one Stop.

Affected8 suites:572 passed and1 failure in an added assertion that used the legacy stopped-chip selector for a structural receipt (`gate-client-correction.log`). Corrected that new selector to normal-chat-output-status, then both normal/Stop cases pass (`gate-client-status-green.log`,2 passed). No original assertion was weakened. All logs are under `/tmp/turn-completion-remediation/`. Full release gate rerun remains orchestrator-owned.
