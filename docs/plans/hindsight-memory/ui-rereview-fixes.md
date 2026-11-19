# UI second-review fixes — implementer handoff

## Finding-by-finding

1. Applied requests are consumed before completion navigation. A submission navigation epoch prevents a later acknowledgement from reopening a cancelled editor. Regression: applied edit → Back → focus makes no further operation read; cancelled queued edit stays on list. The editor's button labelled Back to memories now actually returns to that list; Cancel still returns to detail.
2. Restored metadata-only requests reconcile independently of the active editor. Repeated 404 is not interpreted as nonapplication. Their request identities survive visit snapshots while unrelated writes remain available; eventual applied/terminal acknowledgement consumes the identity without replaying the statement. Regression covers repeated 404, enabled Add and eventual acknowledgement with zero mutation POSTs. Backend confirms there is no authoritative nonapplication state in lookup404.
3. 401/403/404 on accepted list/detail clears cached rows, quoted sources, actionable draft and selected detail. Transient transport failures retain accepted content. Parameterized regression covers all three access-loss statuses.
4. Introductory decline immediately closes the modal and suppresses that introduction for the visit, retaining the same unacknowledged decline request ID. Retry uses that ID. A newer durable cross-tab choice closes an open introductory modal. Regression covers rejected offline decline, no modal/no repeated banner, same-ID retry and cross-tab eligibility loss.
5. Authorized source traversal distinguishes retryable failure/nonadvancing unexhausted windows from exhausted unavailable history. The chat offers the existing toast Retry action and retains the source URL on failure. Older-page promises are owned by conversation identity, so another conversation cannot await the departed chat's promise. Helper regression covers failure then successful retry. Browser race execution remains outstanding.
6. The settings success strip no longer permanently stores a pending-cleanup claim: the live cleanup component owns pending/completion. Its polling continues after transient transport failure. Scheduled regression observes pending → failed GET → verified completion without focus/manual retry. Full Profile/browser integration remains outstanding.
7. Background status reconciliation reschedules after a transport failure. Failed background status no longer advertises an update Retry when the only supported action is a read. Scheduled regression observes working → rejected GET → ready without focus.
8. Snapshot restore discards previous scope content before waiting for the new read. Scroll/focus applies only if the restore navigation is still current. Regression delays project loading after accepted personal content and asserts personal rows disappear immediately.
9. New-view focus explicitly queries the heading first, with a separate fallback. Regression asserts actual heading focus.

## /remember integration

The native notes client carries conversationId/requestId and accepts the native operation response alongside the legacy compatibility response. The composer establishes its existing draft conversation when necessary, retaining project context, and announces Saved only after applied. Request-only metadata lives in the existing conversation-session boundary, is removed on signout, and survives navigation/reload for reconciliation. No statement drafts enter this storage. Unknown acknowledgement does not block chatting. Component regression observes queued/offline status without a Saved toast, then authoritative applied and removal of the stored identity. API regression checks exact submitted context and unaltered operation response. Failed draft-conversation establishment reports the existing save error instead of becoming an unhandled rejection.

## Evidence and limits

- `/tmp/ui-rereview-red.txt`: 4 failures/22 passes before fixes. **Two failures were invalid initial test selectors**, subsequently corrected; the two valid red cases reproduced offline intro trapping and cross-scope cached rows. Do not count the selector failures as production regressions.
- `/tmp/ui-rereview-green3.txt`: 314 passes/1 failure. The valid failure showed Back to memories from the pending editor actually selected detail. Fixed the label/behavior mismatch.
- `/tmp/ui-rereview-final.txt`: **392 tests passed, 7 suites passed**, including coordinator, intro, cleanup, source traversal, memory-notes client, MessageInput and conversation-session. Afterwards only a guarded draft-conversation error handler and formatting changed.
- Scoped Biome: clean, `/tmp/ui-rereview-biome.txt` and `/tmp/ui-rereview-biome-last.txt`.
- Latest typecheck `/tmp/ui-rereview-check.txt`: **5 errors, 0 warnings**, all in sibling-owned backend files: memory-context/native.ts (3), memory-profile/native-read.ts (1), memory-profile/curation-runner.ts (1). No UI diagnostics in that run; later added tests need the next coordinated check.
- Browser source test now asserts the real highlight class. Mobile test switches the actual application locale to HU and waits for long Hungarian content before measurement, restoring EN in finally. Browser tests have not run. Multi-source/project-scroll and cross-chat delayed-read browser coverage still require completion/verification; no claim that fixture tests establish native acceptance.

No build, full gate, Fallow, deployment or real-account migration was run. Independent rereview and coordinated native/browser acceptance remain necessary.
