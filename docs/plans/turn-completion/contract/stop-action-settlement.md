# R2b: Stop command settlement ownership

Status: Astra SPEC PASS and controller ACCEPTED; TDD implementation authorized (2026-11-11).
Base inspected: `635e0270b` (2026-11-11). Controller confirmed gate 10 FINISHED with no active build/full gate. Astra SPEC PASS and controller ACCEPTED authorized TDD implementation. Boole released its browser slot; this worker has run no browser, build, full gate, commit, push or deployment.

## Intent and evidence

Preserve R2's immediate Stop UI, composer release and queue-to-draft behavior while giving dependent commands an explicit runtime-owned settlement fact. Deepen the existing ClientTurnRuntime module; add no module, store or page polling loop. This is a functional caller-contract correction within the existing runtime owner, not the later architecture phase.

Exact evidence: `/tmp/alfyai-completion-contract-gates-10/vitest.log` reports 25,834 passing tests, two failures and three skipped. `page-runtime.test.ts:886` receives client placeholder `9d44e698-8cb6-4c9a-8ef0-523d1429e500` instead of `assistant-stopped-1`; line 943 sees `/` navigation before the old reader's `onEnd`. These expectations remain meaningful. `waitForRuntimeIdle` polls `isSending` every 20 ms for up to four seconds, but R2 `stop()` synchronously calls `completeTurn()` before aborting the reader. Original `onEnd` then fails `ownsStream()` and loses the identity receipt.

Local idle, reader settlement, authoritative message identity and structural completion are different facts. In particular `{ wasStopped: true, assistantMessageId, userMessageId }` from the captured original callback is a valid identity receipt, not permission to expose retained prose/activity as structurally complete. The existing R2 terminal evidence guard remains binding.

## Declared write scope and adapter gap

Initial authorized implementation paths, after controller confirms gate 10 finished AND Astra SPEC PASS:

- `src/lib/client/normal-chat-client-turn-runtime.ts`
- `src/lib/client/normal-chat-client-turn-runtime.test.ts`
- `src/routes/(app)/chat/[conversationId]/+page.svelte`
- `src/routes/(app)/chat/[conversationId]/page-runtime.test.ts`
- This specification.

Controller and Astra approved the following narrow additional scope:

- `src/lib/components/chat/MessageInput.svelte`: command-specific settlement request and navigation veto/permit consumption only.
- `src/lib/components/chat/MessageInput.test.ts`: direct command-versus-button callback contract, unavailable/stale veto, immediate Stop and duplicate/navigation cases.
- `src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte`: explicit `onStop` callback forwarder type, only as required by the changed contract. Its existing `ChatComposerPanel.test.ts` receives explicit intent/veto forwarding coverage, declared before that edit.

No new top-level type/state module: put any shared callback type at the existing owning runtime/interface seam or derive it from the existing component props. No quiet expansion to another forwarder or test; enumerate any concrete TypeScript-required path before editing.

`tests/e2e/streaming.spec.ts` belongs to the other worker; no overlap. No original R2 UI guard, backend or transport changes are proposed. No build, full gate, browser, commit, push or deployment in this slice.

**Concrete adapter gap for review:** `MessageInput.svelte:3188–3194` unconditionally navigates after `await stop()`. Its `onStop`/`stop` contract is `void | Promise<void>`; it cannot consume a stale/unavailable veto. A bounded result must not masquerade as settlement, an unresolved promise must not retain a command forever, and rejecting the current fire-and-forget command produces an unhandled rejection. Therefore the full navigation fence requires a narrow additional write scope: `src/lib/components/chat/MessageInput.svelte`, changing only the stop result type and `/new` continuation to honor an explicit `false` veto or a returned runtime permit (`isCurrent`, `release`; legacy `void` still allows existing callers). The command checks the permit immediately before navigation and releases it in `finally`; the Stop button does not acquire a navigation permit. Add the corresponding stale/unavailable page integration coverage in `page-runtime.test.ts`. Controller accepted this narrow addition and Astra passed the callback shape; do not quietly claim the original four source/test paths suffice.

## Alternatives considered and selected ownership shape

**A — retain ordinary active-reader ownership until abort end, then reconcile.** This is cheaper if Stop keeps the old sending/active state until the abort microtask. It naturally restores the old poll’s ordering in the two known mocks. It is valid to preserve the original reader owner; synchronous fake reader completion is not required for immediate UI. However, preserving only that owner does not solve the actual missing-ID abort receipt: `wasStopped` alone still leaves a placeholder, so regeneration must wait for canonical identity independently. Keeping ordinary active ownership also allows post-Stop token/error/end paths to execute unless individually fenced, and ties composer/queue release back to the reader. Decoupling UI state and disabling those effects is already a distinct retained ownership mode. Keeping the page poll would additionally leave command correctness outside the runtime.

**B — retain the original reader as a receipt owner inside the existing Stop handoff, expose owned command settlement. Selected proposal.** Stop releases UI immediately but does not assert the original reader ended. Its narrowly retained owner captures late original receipts, including synchronous abort callbacks. On ordinary fast abort, begin read-only reconciliation after that local receipt. Also schedule a zero-delay fallback through the existing runtime scheduler: the normal abort microtask gets first opportunity, while a reader that never ends cannot block canonical observation. Whichever path starts reconciliation cancels the other start; both remain within the existing ten-second handoff budget. The existing observer remains the only missing-ID/terminal evidence path. Both cases use one handoff and one deadline, with no competing observers. This preserves A’s useful ordering without letting the old reader remain the ordinary stream owner.

**Deletion test:** deleting this runtime behavior would force every command adapter to reproduce receipt capture, identity reconciliation, cancellation, deduplication and deadlines. Those belong behind the runtime interface. Page polling and page settlement/duplicate-action flags are deleted/avoided; page adapters retain only existing policy decisions and validate the runtime-issued action permit before effects.

## Proposed small runtime interface

Keep `stop(): boolean` synchronous and compatible. Add one method:

```ts
settleStoppedAction(request: {
  purpose: 'navigate' | 'regenerate';
  messageId?: string; // required for regenerate; captured click target
}): Promise<
  | { status: 'ready'; assistantMessageId?: string; userMessageId?: string;
      isCurrent(): boolean; release(): void }
  | { status: 'unavailable' | 'superseded' }
>;
```

Calling this method synchronously captures the relevant turn/handoff and requests Stop through the existing runtime path if needed. Both methods share ONE private handoff, one upstream Stop invocation, one bounded observation and its existing scheduler/deadline. Further requests reuse the same evidence acquisition; command admission/priority below determines which one may continue. They never stop or observe again. Runtime settlement returns evidence and an action permit, never invokes navigation or regeneration itself. The permit is claimed synchronously at method entry and held through caller policy awaits; a duplicate request cannot obtain a second ready permit. A navigation claim supersedes regeneration, while regeneration cannot supersede navigation. Duplicate navigation requests are rejected as superseded. Observation acquisition is shared independently of these command claims. Types should discriminate the regenerate success branch with a required authoritative assistant ID in implementation.

For navigation, `ready` means the captured original reader delivered its end/error receipt, or a correctly scoped canonical terminal observation established that the prior request ended. Navigation is immediately ready only when the runtime has neither an active turn NOR a retained unresolved stopped fact. Observer teardown is not evidence that there is nothing to settle. A pending observation, local Stop intent or a timeout is not ready. Retain the last stopped fact (reader settlement, authoritative identity and terminal evidence independently) under the existing runtime owner even after observation finishes unavailable. A subsequent `/new` must still return unavailable while that fact lacks reader/terminal settlement; it must not take an idle fast path because `stopHandoff` was cleared. A late scoped original receipt may still establish the missing reader/identity facts within the retained owner. It cannot restart expired observation or extend its deadline. An unsent update wait can settle immediately after cancellation. A stopped unaccepted question resume preserves its existing quiet card recovery and must not invent a segment.

For regeneration, `ready` additionally requires the exact authoritative assistant identity, with the original user receipt when provided or canonical saved-row linkage otherwise. Never return the placeholder as an authoritative ID. An original late end with IDs may supply identity even without structural completion. An end without IDs establishes reader settlement only; continue the existing canonical R2 observation for regeneration identity. A canonical result must pass existing stream/conversation/turn/segment checks and exact durable-row resolution; an absent or mismatched saved row, finalization failure without a valid retry target, unavailable observation or exhausted bound cannot authorize a retry. Navigation does not wait for accounting refresh.

The ready result carries a runtime-owned action permit: adapters call `isCurrent()` after every await and immediately before effects, then `release()` in `finally`. The predicate compares the captured existing runtime owner ordinal/turn epoch and command claim with the current owner, as well as lifecycle/conversation validity. A same-chat new turn that begins AND ends while `prepareTurn` is pending still invalidates it, even though `isSending` is false again and the conversation ID is unchanged. New turns, detach/reset/dispose, conversation changes and superseding commands invalidate that permit and pending waits. Duplicate-action ownership stays in the runtime, including during page policy awaits; add no page pending-action flag/token. Starting the permitted retry consumes/invalidates the permit through the existing new-turn fence; it does not prevent that retry from entering normally.

## Explicit UI intent contract

Use an explicit optional intent argument on the existing host callback; do not infer navigation from `isSending`, `canStop`, the presence of an observer, or whoever awaits its promise. Proposed callback shape (types live at the existing seam, no new module):

```ts
type StopCommandPermit = {
  isCurrent(): boolean;
  release(): void;
};
type StopIntent = { purpose: 'navigate' };
type StopHostResult = undefined | false | StopCommandPermit;
// MessageInput onStop and ChatComposerPanel forwarder agree on this type:
// (intent?: StopIntent) => void | StopHostResult | Promise<void> | Promise<StopHostResult>
```

- Ordinary page/composer Stop controls call `handleStop()` / `onStop?.()` with **no intent**. This branch calls `runtime.stop()` synchronously and returns void; it never calls `settleStoppedAction`, acquires an action permit, or sets navigation priority. Merely stopping cannot block later toolbar Regenerate. The retained Stop receipt/observation fact is evidence ownership, not a navigation claim.
- Actual `/new` calls `onStop?.({ purpose: 'navigate' })` directly, even when `canStop` is false. Preserve the existing disabled-composer policy, but do not let the ordinary Stop button’s `canStop` early return skip host command settlement. This branch alone acquires the navigation action permit, awaits settlement, honors false/stale veto and releases the permit in `finally` after the navigation attempt. Existing hosts returning void remain compatible.
- Answer now and toolbar regeneration claim `purpose: 'regenerate'` through the runtime method. An ordinary Stop creates no competing navigation claim; only an actual `/new` may supersede regeneration. Callback forwarders preserve the explicit argument and result unchanged.
- DOM event handlers invoke the no-argument Stop adapter explicitly; an event object is not a command intent. Direct `onclick` bindings must not accidentally become the navigation branch. Check the literal discriminant `intent?.purpose === 'navigate'` rather than argument truthiness.

## Runtime implementation responsibilities

1. Extend the existing private Stop handoff to retain original request/placeholder identity, captured original callback ownership, settlement subscribers and independently recorded reader/identity/terminal facts. Install it BEFORE `completeTurn()` and `handle.stop()` so synchronous abort callbacks are captured. Preserve the existing post-Stop epoch convention and the original stream ID. No new parallel recovery subsystem.
2. Original `onEnd`/`onError` first offers a narrowly scoped receipt to that captured handoff before the normal `ownsStream()` early return. It cannot resume ordinary token/error/finalization handling after ownership was retired. Reject receipts from a different stream incarnation or epoch, wrong chat/target, detached lifecycle, or conflicting previously known identity. A transport error alone never supplies message identity or structural completion.
3. Apply valid late server IDs to the retained row/client-user row through the existing message-list finalize seam while preserving the render key and existing partial view. Pass identity fields only: no receipt text, `finalContent`, fabricated completion, fake terminal disclosure or warning removal. Keep structural projection exclusively behind the current R2 `settleObservation` evidence guard. Publish readiness only after identity application is complete.
4. Reuse `reconcileStoppedTurn` and `settleObservation` for missing original identity and canonical completion. Keep reconnect-only, read-only observation, maximum five reads, 250 ms pending spacing, each read at most two seconds and the entire handoff at most ten seconds including row read. Do not reset the deadline when a command joins. Observation handles detach, never Stop; replay never triggers generation, queue drain, retry or tool execution.
5. Identity settlement can release regeneration before structural disclosure; it does not clear or fabricate completion. A later explicit terminal observation may hydrate the old row only while its owner still matches. Starting the authorized retry invalidates the old handoff and prevents late old writes. A terminal observation may release navigation even if the abandoned original reader never produces a callback. Preserve unavailable warnings/partial content when canonical evidence is absent.
6. Invalidation resolves pending action waits as `superseded`, clears runtime timers and detaches observation. Completion/unavailability resolves each waiter once. Releasing an action permit or detaching an observer does not erase the retained stopped fact. Keep that fact in the same existing runtime owner/handoff record (with observation resources optionally retired), not a separate store or module. A timeout/unavailable disposition is retained and subsequent action calls fail closed on whichever required facts are still absent; they do not silently reset the observation budget. Clear it only through safe owner invalidation (new turn, lifecycle detach/reset/dispose/conversation change), or replace its unresolved disposition with independently validated late receipt/canonical evidence. Repeated idle `stop()` must neither erase it nor advance its owner ordinal. Repeated idle Stop does not invalidate a valid prior handoff. New sends/retries/resumes/reconnects fence it through the existing runtime epoch/lifecycle owner. No settled waiter can mutate a newer turn's state or errors.

## Caller adapters and all Stop consumers

Production runtime Stop consumers found: the page's `handleRegenerate` and `handleStop`; the runtime itself owns the upstream handle Stop. Other `.stop()` names are unrelated pollers/watchers/jobs/editors. MessageInput Stop controls call the page through `onStop`; `/new` awaits that callback and then navigates. Existing runtime tests also assert synchronous boolean Stop compatibility.

- Delete `waitForRuntimeIdle` and its inaccurate ownership comment. The Stop button continues to release UI immediately and ignores the command promise; no sending/polling flag is held for settlement.
- `handleStop` distinguishes plain Stop from command settlement through a minimal optional command argument on the existing callback. Plain Stop calls synchronous runtime `stop()` only; `/new` explicitly requests navigation settlement. The command branch returns the ready runtime permit, or `false` on unavailable/superseded. `/new` checks the permit immediately before navigation and releases it in `finally`. An ordinary Stop followed by `/new` must still join the outstanding handoff even though sending/canStop is already false: MessageInput's current `canStop` short circuit must not bypass the host settlement callback for `/new`. Use a command-specific host call in `/new`, leaving button gating intact.
- Answer now requests a runtime-owned command permit synchronously before awaiting settlement, including the locally idle/pending-handoff window. Validate the clicked target against the runtime-owned target. A second click cannot take the ordinary idle regenerate path. ALL identity-dependent regeneration enters this runtime method, including ordinary toolbar Regenerate after Stop with `isSending=false` and no `reasoningDepthOverride`. Do not condition settlement only on Answer now or `isSending`. For an already durable historical row with no relevant unresolved stopped fact, the runtime may validate the known authoritative row identity and issue the permit immediately. If the target is the retained stopped placeholder/renderKey, unknown identity remains unavailable regardless of toolbar/button origin. Regenerate only with returned authoritative identity, resolving the row by ID/renderKey as appropriate. An unavailable/superseded result performs no optimistic slice and dispatches no retry.
- Keep `prepareTurn`, fork/privacy confirmation, editing/question/read-only guards and attachment preservation as page policy. After settlement AND after `prepareTurn`/any other await, recheck route identity, runtime permit validity, target identity and runtime admissibility before slicing or sending. A new send, route switch, detach/unmount or newer competing command makes the old continuation inert. Release the runtime permit in `finally`; releasing an obsolete permit cannot release another command’s claim.
- Navigation supersedes a pending Answer now rather than permitting a retry after leaving. An Answer now cannot supersede a pending navigation and dispatch first. No queued follow-up auto-drains; queued text remains restored to the original draft.

## Test plan and handoff

Use the existing real runtime interface and page harness; deferred original callbacks, canonical observation fixtures and runtime scheduler/fake timers prove ordering. Assert effects and identities, not private record structure or timer implementation.

1. Retain both exact gate-10 failures as regressions: no early `/new`; late original IDs produce retry IDs `assistant-stopped-1` / `user-1`.
2. Immediate Stop still clears sending/canStop, restores queued draft and calls upstream Stop once while settlement remains pending. Repeated Stop and concurrent dependent callers share acquisition; no queue auto-drain.
3. Original callback fires synchronously during Stop and asynchronously afterwards: exact receipt captured once, authoritative IDs applied before readiness, prose/terminal guard unchanged.
4. Original end without IDs permits navigation after reader settlement but never placeholder regeneration. Existing Answer now tests whose fixture supplies only `wasStopped` must provide canonical observation/row evidence for the positive retry case; add an explicit unavailable negative case rather than weakening identity assertions.
5. No original receipt: canonical pending then terminal plus exact saved row releases identity-dependent retry; pending alone, wrong scope, missing row, unavailable, rejection, timeout or finalization failure without retry identity never dispatch placeholder retry. Canonical terminal permits navigation without a hung reader receipt.
6. Double-click Answer now across immediate-idle transition sends exactly once, including while `prepareTurn` is pending. Stop then Answer now joins old handoff and resolves the right target. Duplicate `/new` navigates once. Stop then `/new` cannot bypass settlement through `canStop=false`.
7. Ordinary toolbar Regenerate after Stop while local idle/no reasoning override waits for exact identity; unavailable cannot dispatch retry. After observer teardown/deadline, invoke toolbar Regenerate and `/new` again: unknown identity/reader facts remain unavailable, with no fresh generation, duplicate Stop or reset observation budget. A valid late original receipt can supply only its actual facts without structural disclosure.
8. New send, different target, conversation switch, navigation, detach/reset/dispose, and same-chat newer turn invalidate old waiters. Late original receipt/observer/row-read cannot mutate the new row, errors, costs, draft or command continuation. Test a context change during `prepareTurn`, not just while the observer waits.
9. Direct MessageInput tests distinguish intent: Stop invokes the host with no command intent and does not acquire navigation priority; toolbar Regenerate after plain Stop remains eligible for identity settlement. `/new` supplies the explicit navigation intent and awaits its permit even with `canStop=false`; false/stale veto prevents navigation, and argument/result forwarding is preserved.
10. Preserve fork/privacy cancellations and preparation order: no slice or retry before settlement plus approval; canceled policy leaves timeline and draft intact. Preserve pending-observation Stop, cut-reply Stop, accepted/unaccepted ask resumes and immediate Stop UI regressions.

After implementation authorization, run focused existing runtime (~331) and page (~246) tests plus these regressions. Controller owns later full clean typecheck, fast/default gates, full gates and three-model review before any production decision. No tests/build/browser started by this worker in this specification-only phase. Add direct MessageInput focused tests to the runtime/page validation after approval. A local page command token, if required solely for UI duplicate/navigation policy, is permitted; it must never replace runtime-owned settlement or owner-ordinal revalidation, nor require scattered invalidation across page entry points.

Docs checked without available Context7/Svelte MCP tools: official [Svelte lifecycle hooks](https://svelte.dev/docs/svelte/lifecycle-hooks), [$effect](https://svelte.dev/docs/svelte/$effect), and [Vitest vi utilities](https://vitest.dev/api/vi.html). Apply runes lifecycle cleanup and deferred/fake-timer testing without relying on page polling.

## Implementation evidence and controller handoff

The existing runtime now retains stopped reader/identity/terminal facts independently of observation resources, owns command priority and exposes `settleStoppedAction` with a discriminated ready result and `isCurrent`/`release`. Ordinary Stop remains synchronous and claims no navigation priority. All regeneration crosses the identity seam; `/new` explicitly requests navigation settlement even when Stop is hidden. The page's polling loop was removed. No top-level state owner, backend/transport or original terminal-prose guard changed.

The permit revalidates the exact authoritative assistant row as well as the owner epoch/claim/chat. Removing its target or replacing it with a conflicting canonical ID makes `isCurrent()` false without a runtime notification or side effect; reloading that exact authoritative row without the client render key remains valid. A retired unresolved placeholder cannot become an authoritative retry ID merely because a newer turn cleared its old handoff.

The raw unavailable-key diagnosis was in the page's existing `setSendError` adapter: it translated update/fork/skill keys but forwarded this key unchanged. It now uses the existing English/Hungarian dictionary entries. No dictionary edits.

TDD red evidence:

- `/tmp/alfyai-r2b-red.log`: missing settlement interface, missing explicit `/new` intent and untranslated unavailable key; includes original gate-10 regressions.
- `/tmp/alfyai-r2b-red-2.log`: duplicate receipts, conflicting canonical identity, chat-switch waiter and older retry ordering.
- `/tmp/alfyai-r2b-red-3.log`: a retired unresolved placeholder incorrectly became a historical retry ID.
- `/tmp/alfyai-r2b-target-red.log`: ready permit incorrectly remained valid after target removal/conflicting replacement; `/tmp/alfyai-r2b-target-green.log` verifies the correction and legitimate same-ID reload.

The two original semantic assertions remain: retry assistant/user IDs equal the late original receipt; `/new` has not navigated before the reader end. The no-ID positive Answer now fixtures now supply canonical read-only observation and exact saved-row evidence, and count model requests separately from observation requests.

Controller owns clean full typecheck, Fallow/default/full gates and three-model review. This slice is a focused-test handoff, not a release approval. Final frozen focused command exited 0: **885 passed, 0 failed, 0 skipped**, four files, 39.41 seconds. The exact original gate-10 regressions both pass.

- `src/lib/client/normal-chat-client-turn-runtime.test.ts`: 347 passed, 0 failed.
- `src/lib/components/chat/MessageInput.test.ts`: 276 passed, 0 failed.
- `src/routes/(app)/chat/[conversationId]/page-runtime.test.ts`: 252 passed, 0 failed.
- `src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.test.ts`: 10 passed, 0 failed.

Evidence: `/tmp/alfyai-r2b-focused-frozen.log`, `/tmp/alfyai-r2b-focused-frozen.json`; scoped Biome `/tmp/alfyai-r2b-biome-frozen.log` exited 0 with no warnings/errors or changes; `git diff --check` exited 0. Application/test source is frozen for controller/Astra review. Full typecheck/Fallow/gates remain deliberately deferred to the controller.
