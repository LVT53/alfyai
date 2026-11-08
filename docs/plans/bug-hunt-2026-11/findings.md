# Bug hunt, November 2026

Live code when searched: `a265c475f` (= origin/dev = origin/main). Nothing here is fixed yet.

How each finding was checked: a Sonnet subagent traced it through the current code, and the orchestrating session re-read the decisive lines. None is proven by a failing test yet. Each entry names the test that would prove it; a fix starts with that test failing for the stated reason.

## Round 1 (2026-11-07): code changed in the last three weeks

Three areas: chat in the browser, chat on the server, and recent features outside chat (permission cards, pictures, sidebar multi-select, ChatGPT import, two-step sign-in, Immich, Home).

### 1. Regenerate and Retry delete replies for good, then refuse (fix first)

- **Where:** `src/lib/server/services/chat-turn/retry.ts`, `prepareRetryChatTurn`. `cleanupFailedTurn` and `deleteMessages(trailingMessageIds)` run at about lines 216-243. `preflightStoredTurn` runs only afterwards, at about 249-263, and `if (!preflight.ok) return preflight;` returns with the messages already gone.
- **Trigger:** send a photo with a model that can see images. Switch the picker to a model that cannot, or delete a library document the turn used. Press Regenerate. The gate refuses (422 `not_text_readable`, `attachment_not_ready` or `not_available`), but the reply and every later message are already deleted. After a reload the chat ends on the user message.
- **Impact:** permanent loss of replies through an ordinary action.
- **Fix:** run the read-only gate before the cleanup and delete, with the turn's resolved choices (`resolveStoredTurnChoices` already runs first). The gate is `checkChatTurn` → `checkTurnInputs` in `chat-turn/preflight.ts`, which the edit flow already calls through `POST /api/chat/turn-check`; see "An edit meets the turn's gate before its delete" in `src/lib/components/chat/AGENTS.md`. Keep `preflightStoredTurn` after.
- **Test:** `src/lib/server/services/chat-turn/retry.test.ts` already mocks `preflightChatTurn`, `deleteMessages` and `cleanupFailedTurn`. Make the gate refuse, then assert neither `cleanupFailedTurn` nor `deleteMessages` ran.

### 2. A permission card can stay stuck as "executing" forever

- **Where:** `src/lib/server/services/connections/pending-writes.ts`, `confirmPendingWrite`. After `claimPendingWrite` (about line 467) it awaits `executor.execute(...)` (about 491) with no try/catch. Only a returned `{ok:false}` reaches `markPendingWriteFailed`, whose own comment calls a row left "executing" forever a bug.
- **Why a throw is possible:** `providerFetch` (`connections/provider-http.ts`) rethrows a network error and turns a timeout into a thrown error. The Google Calendar executor (`providers/google-calendar.ts`, about 564-581, 741, 796, 841, 871-911) does not catch it.
- **What the person sees:** the confirm route (`src/routes/api/connections/writes/[id]/confirm/+server.ts`) has no try/catch, so the press answers 500. Every later press answers 409 `in_progress`, and `WriteConfirmCard.svelte` stays busy.
- **Trigger:** Google Calendar with writes on. Press Save on a card while Google is unreachable, or takes longer than the 15 s timeout. A vault key that fails to decrypt does the same.
- **Impact:** a dead card that spins for good. After a timeout the event may exist at Google with nothing recording it. Rare.
- **Fix:** catch around `execute`, call `markPendingWriteFailed`, and return a reason the card shows in English and Hungarian. After a timeout, "may not have gone through" is more honest than "failed". Check the Apple CalDAV, Nextcloud and Immich executors too; IMAP send already catches SMTP errors.
- **Test:** in `pending-writes.write-executor-dispatch.test.ts`, register an executor whose `execute` rejects. Assert `confirmPendingWrite` resolves `{ok:false}` and the row is "failed".

### 3. A first message from the landing page is lost on Cancel of the cloud warning

- **Where:** `maybeSendPendingInitialMessage` in `src/routes/(app)/chat/[conversationId]/+page.svelte`. `consumePendingConversationMessage` removes the message from the tab, and `initialStreamPending = true` is set. Then `if (!proceed) return;` gives the words back nowhere and never resets `initialStreamPending`; only the runtime's `send` resets it. So `showInitialLoading` stays true and the empty chat shows "starting conversation". `handleCloudWarningCancel`'s comment promises that callers keep their state; this caller does not.
- **Trigger:** a cloud (provider) model with a connector on, and the one-time warning never accepted. Send from the landing page, then press Cancel on the warning.
- **Impact:** the message is lost. Rare.
- **Fix:** in the `!proceed` branch, `restorePayloadToDraft` with the consumed payload and set `initialStreamPending = false`. Keep the `finally` that ends `landingMessageOnItsWay` (`627cbbf6f`).
- **Test:** in `page-runtime.test.ts`, next to the cloud-warning bootstrap test (about 7752-7800). Store a pending message, set `checkCloudWarningMock` to `{shouldWarn: true}`, use cloud model page data, and press Cancel. Assert the composer holds the message and `starting-conversation` is gone.

### Checked in round 1 and found sound

- Sidebar batch delete, move and pin, and their user scoping
- Two-step sign-in
- Immich `enable-writes`
- Picture take routes
- The "Ask me first" answer route: claim, give-back, settle
- Draft PUT and DELETE
- Messages DELETE
- Conversation PATCH and DELETE
- The edit's `turn-check`
- `DraftKeeper` and draft-save ordering
- The runtime's send, queue, stop, detach and answer paths
- That email and album permission cards send what they show

One oddity not counted: a ChatGPT import whose message insert fails leaves the empty chat behind. It needs an insert failure (probably 3.6k+ messages in one chat).

## Round 2 (2026-11-08): big bugs in the areas round 1 did not cover

Three areas, each looking only for big bugs: data lost, another person's data reached, a security hole, data sent where it should not go.
- Knowledge, uploads, generated files and memory
- Documents, Apps, Canvases, Slides and projects
- Security and accounts: sessions, Origin checks, admin routes, settings, proxies and fetchers, the sandbox, HTML sanitizing

**No big bug found.** All three came back clean on:
- user scoping, deletes and the App sandbox
- admin checks (all 39 admin routes require an admin), sessions and Origin checks
- the favicon, Immich and map proxies, URL provenance and the sandbox
- the HTML sanitizers

### 4. The only admin can delete their own account (low)

- **Where:** `DELETE /api/settings/account` (`src/routes/api/settings/account/+server.ts`) runs only `requireAuth`. It then calls `eraseUserAccount` (`src/lib/server/services/privacy-controls/index.ts`, about lines 87-96), which checks the password and then calls `eraseUserAccountData`. The last-admin guard `ensureNotLastAdmin` (`user-admin.ts:61`) runs only on the admin panel's paths (lines 362 and 440). The Settings page shows "Delete account" to admins too: there is no `isAdmin` gate in `SettingsProfileTab.svelte`.
- **Trigger:** the only admin deletes their own account from Settings, with their password.
- **Impact:** zero admins are left. User management, config, providers and drain are unreachable until the database is edited by hand. No data leak. It is self-inflicted, behind a password and a confirmation, so unlikely.
- **Fix:** refuse when the account is the last admin, counting admins in the same transaction as the erase, and say why in English and Hungarian.
- **Test:** in `privacy-controls.test.ts`, seed one admin and call `eraseUserAccount(adminId, password)`. Expect a refusal with the user row still present.
- **Checked:** the orchestrator re-read the route, `eraseUserAccount`, the guard's callers and the Settings tab.

### Unverified lead (not counted)

An incognito-first upload that is reused in a normal chat.
- Upload a file in an incognito chat, then the same bytes in a normal chat. The dedup (`findExistingArtifactByBinaryHash`, `knowledge/store/core.ts`, about lines 226-247) reuses the row, whose `conversation_id` stays the incognito chat.
- The strict ownership scope (`knowledge/ownership.ts`, about lines 64-89) leaves incognito chats out.
- Whether the normal chat can then read or ground the file was not traced (`resolvePromptAttachmentArtifacts`). The agent put it at about 25%.
- Test: upload in an incognito chat, upload the same bytes in a normal chat, send a message, and check what the model receives.

### Small slips, below the bar

- Deleting a project does not call `invalidateHomeSummary`, though PATCH does. Its card can stay on the new-chat page for up to 30 s and give a 404.
- `PATCH /api/artifacts/[id]/body` checks only App bodies (the audit) and Canvas bodies (normalized). An owner can overwrite their own Image or Slides item with plain text.
- Restoring an older Document version keeps the current tab strip. A tab added after that version shows empty; no content is lost.

### Known or documented, not counted

- The connection URL guard checks literal hosts only, as documented in `host-locality.ts`.
- Browser push posts to any endpoint: the known "SSRF gap".
- A push endpoint's owner can be reassigned, but only with that person's secret endpoint URL.

### Not read in round 2 (where a next pass would look)

- App rebuild: `app/regenerate.ts`, `generate-and-verify.ts`.
- Alfy's comment reply: `comments.ts`.
- History: `history.ts`, `moments/derive.ts`. Also `canvas-ops.ts` and `chat-blocks.ts`.
- The MinerU client and the extraction runner.
- The file-production runner and renderers.
- The memory judge and consolidation.
- `upload-intake.ts` and `resolvePromptAttachmentArtifacts`.

## Recommendation

1. Fix 1 (Regenerate) first: it loses replies for good through a normal action.
2. Then 2 (the stuck permission card) and 3 (the landing message lost on Cancel); both fixes are small.
3. Fold 4 (last admin) in alongside them: it is one guard.

Round 2 found no big bug, so nothing else is urgent. Each fix starts with its test failing.
