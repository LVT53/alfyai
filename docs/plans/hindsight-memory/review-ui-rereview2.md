# Second UI fix review

**The nine original reproduction cases are fixed. Two new P1 issues remain in the native composer command.** They affect which project receives a note and whether a note can be submitted during an incognito transition. Neither requires the native infrastructure work to wait.

## Native `/remember` findings

1. **P1 — switching landing projects during conversation creation can write the first project's note into the second project.** `src/lib/components/chat/MessageInput.svelte:3252–3269` captures the statement at command activation, then accepts whatever chat ID the asynchronous draft preparer returns. In `src/lib/components/home/HomeSurface.svelte:973–975`, an in-flight creation that outlives its scope is explicitly replaced by a conversation from the new scope. The server correctly resolves that second conversation's project at `src/lib/server/services/memory-profile/curation-actions.ts:387–395`. Start a note in project A, hold its create response, navigate to project B, then release it. The note from A is submitted with B's authorized ID. Bind this command to the original scope/visit and cancel it if that identity changes. Verify the race with a deferred creation and assert zero note writes to B.
2. **P1 — a visibly incognito landing chat can admit a memory before its privacy PATCH finishes.** With an existing prepared chat, arm Incognito and hold the PATCH from `HomeSurface.svelte:599–609`. The composer receives the armed flag at line 1390, but `MessageInput.svelte:2909–2915,3251–3269` still accepts `/remember` and immediately posts using that chat ID. Ordinary send waits for the PATCH at `HomeSurface.svelte:1035`. During the gap the server sees the previous normal chat and can accept the note. Refuse the command when the current composer is incognito or changing into incognito, and recheck after asynchronous conversation preparation. Test a previously normal prepared chat with the PATCH held and assert that no note POST occurs.

For a stable authorized conversation the server derives project scope from that conversation and checks current memory eligibility. The native command sends a request ID, stores only request identity for recovery, and waits for applied before announcing success. The legacy synchronous response remains supported. Those behaviors do not close the two origin/consent races above.

## Original finding dispositions

| Prior finding | Result on the reviewed checkout |
| --- | --- |
| 1. Completed work reopening a view | Fixed. The coordinator consumes applied IDs before navigation and checks the submitting view's epoch. Tests cover blur/focus after Back and a cancelled queued edit. |
| 2. Restored unknown acknowledgement blocking writes | Fixed. Metadata-only restored requests reconcile separately. Repeated lookup 404 retains identity, enables unrelated writes, and does not resubmit the mutation. |
| 3. Cached rows and quotations surviving a refused list/detail read | Fixed for the reported paths. List/detail 401, 403 and 404 invoke the discard path for the cached page, detail and draft. Transient read errors preserve the accepted page. |
| 4. Introductory dismissal trapping normal use offline | Fixed. Decline closes locally before the request, suppresses the prompt for the visit, and retains its request ID for retry. A durable decision arriving from another tab closes the stale introduction. |
| 5. Source page failures and cross-chat request reuse | Fixed in code. Non-advancing, unexhausted history is retryable, exhausted history is unavailable, and pending page reads are keyed to the conversation. The browser race still needs execution. |
| 6. Contradictory cleanup status | Fixed. The general settings strip omits the pending claim, the cleanup component owns the current status, and its timer recovers after a transient failed poll while cleanup is pending. |
| 7. Stalled background refresh | Fixed. A transient failure reschedules status reconciliation, and the failed-status alert no longer offers a write retry that merely rereads the page. |
| 8. Previous scope visible during restore | Fixed. Restore clears previous content before applying scope and serializes post-load focus/scroll against the current navigation. |
| 9. Heading focus | Fixed. The explicit heading lookup precedes the fallback, and the component test asserts actual DOM focus. |

## Verification

Independently ran all seven scoped suites under Node 22 on the current checkout. **392 tests passed in 7 suites.** The runner also printed jsdom pseudo-element and Svelte `derived_inert` diagnostics in composer tests; the run exited zero. This checkpoint did not execute a build, full gate, browser acceptance, native service, deployment or real-data operation. The two reported races are source-traced and need dedicated regression cases and product browser verification.
