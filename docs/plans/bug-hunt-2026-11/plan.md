# Bug hunt November 2026 — fix plan

Spec: [`findings.md`](./findings.md). Four counted bugs, each with the test that
proves it. The plan is the implementation argument; the findings are the authority.

## Goal

Four user-visible defects stop happening:

1. **Regenerate/Retry never deletes a reply it then refuses to regenerate.** The
   turn's read-only gate is asked before the cleanup and the delete, so a
   refusal leaves the conversation as it was.
2. **A permission card can no longer stay busy forever.** An executor that
   throws marks its pending write `failed` and the confirm route answers a
   refusal instead of 500, and the settled card's note no longer promises that
   nothing was changed when the write may have gone through.
3. **The landing page's first message survives Cancel on the cloud-connector
   warning.** The words go back into the composer and the chat stops saying it
   is starting a conversation.
4. **The only admin cannot delete their own account.** The self-service erasure
   refuses when the account is the last admin, before any data is purged, with
   an English and a Hungarian sentence in Settings.

## Non-goals

- The unverified incognito-upload dedup lead and the "small slips" listed in the
  findings (project delete cache, artifact body type check, Document version tab
  strip). They are explicitly below the bar for this pass.
- No schema migration, no new top-level service, no route-local turn logic.
- No change to the admin panel's own last-admin guard or to
  `eraseUserAccountAsAdmin`'s behaviour.
- No full-suite or build runs inside worker subagents; the orchestrator runs the
  repository gate once at the end.

## Global constraints

- Every task starts with a failing test for the stated reason (report RED/GREEN).
- TDD error text and codes are part of the contract; do not "improve" them
  beyond what the task names.
- New user-facing strings exist in both `en` and `hu` dictionaries in the same
  patch. No inline `<svg>`; Svelte 5 runes only.
- One focused commit per task. `git add` only the task's files; the worktree
  holds unrelated untracked files that must not be committed.
- Focused verification only: `npx vitest run <file>`. Do not run
  `npm run build`, `npm test` (whole suite), or `npm run check` — the
  orchestrator owns the single repository gate.

---

## Task 1: Regenerate asks the turn's gate before it deletes

**Files:** `src/lib/server/services/chat-turn/retry.ts`,
`src/lib/server/services/chat-turn/retry.test.ts` (test only otherwise).

**Current behaviour:** `prepareRetryChatTurn` resolves the stored turn's choices,
checks forked-source confirmation, then runs `cleanupFailedTurn` and
`deleteMessages(trailingMessageIds)`. Only afterwards does it call
`preflightStoredTurn`, and a refusal there returns with the reply already gone.
`findings.md` §1.

**Required fix:** ask the read-only gate before the cleanup and the delete, using
the choices `resolveStoredTurnChoices` already produced:

- Build the same synthetic body/request `preflightStoredTurn` builds (factor the
  parse step into one helper used by both, so they cannot drift).
- Call `checkChatTurn({ userId, request })` (exported by `preflight.ts`; it runs
  `admitChatTurn` + `checkTurnInputs`, reads and writes nothing). A refusal is
  returned in the stream-json shape, exactly as `preflightStoredTurn`'s is.
- Keep `preflightStoredTurn` after the delete: it still covers what can change
  between the gate and the turn (the resend's own checks) and the skill/depth.
- The gate must run before `cleanupFailedTurn`, before `deleteMessages`, and
  before the early `!precedingUserMsg.content.trim()` return that follows them.

**Test (RED first):** in `retry.test.ts`, add a case where `checkChatTurn`
refuses (422 `not_text_readable`, the same shape the route answers) for a stored
reply. Assert the result is that refusal and that neither `cleanupFailedTurn`
nor `deleteMessages` ran. Add the gate mock to the file's existing
`vi.mock(".../preflight")` seam; keep every existing test passing (the mock
defaults to accepting).

**Acceptance:** the refusal path fails before the fix and passes after; the
success path still deletes exactly as before and `preflightStoredTurn` still
refuses after the delete for the cases that only it can see.

---

## Task 2: A throwing write executor settles its card as failed

**Files:** `src/lib/server/services/connections/pending-writes.ts`,
`src/lib/server/services/connections/pending-writes.write-executor-dispatch.test.ts`,
`src/lib/i18n/connections.ts`,
`src/lib/components/chat/WriteConfirmCard.test.ts` (it asserts the old
`note.failed` sentence at about line 408; update that expectation to the new
sentence).

**Current behaviour:** after `claimPendingWrite`, `confirmPendingWrite` awaits
`executor.execute(...)` with no try/catch. A thrown network/timeout error (e.g.
Google Calendar through `providerFetch`) leaves the row `executing` and the
confirm route answers 500; every later press is 409 `in_progress` and the card
is busy forever. `findings.md` §2.

**Required fix:**

- Wrap `executor.execute` in try/catch. On a throw: log it, call
  `markPendingWriteFailed(userId, id)`, and return
  `{ ok: false, status: 409, reason: "may_not_have_gone_through" }` (the same
  status the executor's returned `{ok:false}` path uses). The row must end
  `failed`, never `executing`.
- The honest reason has to survive the card settling. The card notes come from
  `write.status`, not from the transient confirm error, so change
  `connections.writeConfirm.note.failed` in both languages from
  "nothing was changed" to a sentence that is true when the request may have
  reached the provider: EN "This may not have gone through. Check the connected
  account before trying again.", HU "Lehet, hogy nem ment át. Nézd meg a
  csatlakoztatott fiókot, mielőtt újra próbálod." (Keep it one line each.)
- Do not change each provider executor: the chokepoint now covers Apple CalDAV,
  Nextcloud, Immich and Google alike. A returned `{ok:false}` keeps its reason
  and its existing note behaviour.

**Test (RED first):** in `pending-writes.write-executor-dispatch.test.ts`,
register an executor whose `execute` rejects. Assert `confirmPendingWrite`
resolves `{ok:false, status:409, reason:"may_not_have_gone_through"}` and the row
status is `failed`. The test fails before the fix with the rejection escaping.

**Acceptance:** no path after a successful claim leaves the row `executing` when
the executor throws; the existing dispatch/claim tests stay green; EN and HU
`note.failed` say the same thing.

---

## Task 3: Cancel on the cloud warning keeps the landing message

**Files:** `src/routes/(app)/chat/[conversationId]/+page.svelte`,
`src/routes/(app)/chat/[conversationId]/page-runtime.test.ts`.

**Current behaviour:** `maybeSendPendingInitialMessage` consumes the pending
message (`consumePendingConversationMessage`) and sets
`initialStreamPending = true`, then `if (!proceed) return;` when
`prepareTurn()` resolves false (Cancel on the cloud-connector warning). The
words exist nowhere and `initialStreamPending` stays true, so the empty chat
shows `starting-conversation` for good. `findings.md` §3.

**Required fix:** in the `!proceed` branch, put the consumed payload back into
the composer with `restorePayloadToDraft` (give it `pendingAttachments: []`,
the current `conversationId`, and the pending message's `linkedSources` /
`pendingSkill` defaults) and set `initialStreamPending = false`. Keep the
`finally` that calls `handOffEnded()`. Do not send anything on Cancel.

**Test (RED first):** next to the existing cloud-warning bootstrap test in
`page-runtime.test.ts`: store a pending message with
`storePendingConversationMessage("conv-1", {...})`, use `cloudModelPageData()`,
set `checkCloudWarningMock` to `{ shouldWarn: true }`, let the bootstrap send
reach the modal, press Cancel, then assert `message-input` holds the message and
`starting-conversation` is gone. Before the fix the composer is empty and the
starting mark remains.

**Acceptance:** Cancel restores the words and clears the loading mark; Continue
still sends exactly once; the existing landing-handoff tests stay green.

---

## Task 4: The last admin cannot delete their own account

**Files:** `src/lib/server/services/privacy-controls/index.ts`,
`src/lib/server/services/privacy-controls/privacy-controls.test.ts`,
`src/lib/server/services/account-lifecycle/index.ts`,
`src/routes/api/settings/account/+server.ts`,
`src/lib/i18n/settings.ts`.

**Current behaviour:** `DELETE /api/settings/account` runs `requireAuth` then
`eraseUserAccount`, which checks the password and erases. The last-admin guard
(`ensureNotLastAdmin`, `user-admin.ts:61`) only runs on the admin panel's paths,
so the only admin can erase the last admin and leave zero admins.
`findings.md` §4.

**Required fix:** make the self-service erasure refuse a last admin, before any
destructive work:

- In `account-lifecycle/index.ts`, add a read helper
  `isLastAdminAccount(userId)` (role + admin count, one transaction) and a
  `LastAdminAccountError`. The row-deleting transaction in
  `deleteUserRowAndExplicitAnalytics` re-checks the same invariant when the
  erasure asks it to (`eraseUserAccountData(userId, { refuseLastAdmin: true })`)
  and throws the typed error, so the identity delete cannot race past the guard.
  The default path (admin panel's `eraseUserAccountAsAdmin`) is unchanged.
- In `privacy-controls/index.ts`, `AccountErasureResult` gains
  `{ status: "last_admin" }`. `eraseUserAccount` checks after the password
  (never before: a wrong password must not reveal account state) and before
  `eraseUserAccountData`; it also catches `LastAdminAccountError` from the erase
  and returns the same refusal.
- The route answers 409 `{ error: "...", errorKey: "settings_lastAdminCannotDelete" }`
  (the Settings page already localizes `errorKey` through
  `accountErrorMessage`). Add the EN and HU sentences to `settings.ts`, next to
  the other `settings_*` delete-account strings.

**Test (RED first):** in `privacy-controls.test.ts`, with the existing
single-admin `seedPrivacyUser()`, call `eraseUserAccount("user-1",
"correct-password")`. Assert `{status:"last_admin"}` and that the user row (and
its conversations) is still present. The fix must also keep the existing
"deletes the account" test meaningful: seed a second admin there so the allowed
deletion still deletes. Before the fix the new test gets `{status:"deleted"}`.

**Acceptance:** one admin is refused with the row intact; two admins still
delete; the admin panel's `eraseUserAccountAsAdmin` tests are unchanged; the
Settings error is localized in EN and HU.

---

## Verification (orchestrator)

```bash
npx vitest run \
  src/lib/server/services/chat-turn/retry.test.ts \
  src/lib/server/services/connections/pending-writes.write-executor-dispatch.test.ts \
  'src/routes/(app)/chat/[conversationId]/page-runtime.test.ts' \
  src/lib/server/services/privacy-controls/privacy-controls.test.ts

scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610 \
  tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts \
  tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts
```

Then a whole-branch review, then staging deploy (`dev`, ai.dev), live smoke, then
production (`main`, ai.alfydesign).
