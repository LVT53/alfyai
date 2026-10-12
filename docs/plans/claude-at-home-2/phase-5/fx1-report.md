# FX-1 report (progress, written at the orchestrator's 5-hour-cap warning)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Worktree `art-fx1`, branch `fix/round-chat` (from `feat/artifacts` at `db32912b0`), ports 5400-5409.
Status: **DONE_WITH_CONCERNS** — all eight items done and committed (HEAD `1dd6bca7d`), agent gate run once (summary at the end); the 'What is left' lists below are historical.

## Commits so far (oldest first)

| commit | item | what |
|---|---|---|
| `6a45e3040` | 8 | three stale locators follow the crumb's accessible name ("Back to this chat's items"); red = both tests timed out on `/This chat/` |
| `7f7125d2b` | 1 | a turn's file is in the panel list and header count when the turn ends (cause below) |
| `ed307005d` | 2 | a failed create/edit is a folded, named row: "Nem sikerült szerkeszteni: Bécsi hétvége", "Részletek" behind it, no parameters |
| `95b1d2e83` | 3 | one card per item per reply (`foldArtifactDeliverables`); superseded failed attempts go to the rail |
| `11a319313` | 4 (WIP) | red test only: `tests/e2e/chat-header-room.spec.ts` (title right edge vs count chip, project chat, 1100/1280/1440). Red seen: 1100 px title edge 375 vs chip 356 (19 px under), 1280 px 390 vs 386 (4 px under), 1440 passes |
| `3f26c60da` | 7 (WIP) | `src/lib/components/chat/placeholder-fit.ts` (+ unit test, 6 pass): `fitPlaceholder(text, room, measure)`; not wired in yet |

## Item 1's cause (one line)
The list only has a produced file once the server links it to its reply, which happens in the deferred post-turn projection AFTER the terminal stream frame (`chat-turn/finalize.ts`, ADR-0015); the page's last read of the chat was made when the tool finished (before any link), the final metadata carries no files (receipt + contextStatus, so not even "receipt only"), the jobs are done so the job poll is off, and nothing asked again. NOT the suspects: FB-1's `createdSince` stamp / `origin` filters (cards and exports) and FB-7's card move (create/edit calls only) are not involved; the server's read model is right (a read after the turn lists the file, asserted in the spec).
Fix: `filesWaitingForTheList` (`chat/[conversationId]/_helpers.ts`) + a bounded re-read effect in `+page.svelte` (0.3 s, then less often, 17.7 s in all) while a recent succeeded job of a reply has a file that is not a row.
Proof: `tests/e2e/chat-turn-files.spec.ts` (scripted `produce_file` PDF turn; the fake model pauses 1.5 s before its closing sentence like a real one: without the pause the scripted turn was so fast the page's single read came after the link and hid the defect). Desktop + phone red on the unfixed tree (no count button), green after. Unit: `_helpers.test.ts` (+6).

## Shared test kit I added (for FX-2/FX-3 and the integration gate)
- `tests/fixtures/ai/chat-turn-scenarios.ts` (markers/titles) and `tests/mocks/ai-provider/chat-turn-scripts.ts` (`scriptedChatTurnReply`, returns `{frames, delayMs}`; only the chat's own tool-carrying request is scripted). The fake provider got a 6-line dispatch in `openai-compatible-provider.ts` (first thing in the `stream === true` branch) — the only shared-file edit.
- Scenarios: `AI_SMOKE_PRODUCE_PDF_MARKER` (produce_file source-first PDF); `itemTurnMessage("edit" | "retry" | "giveup")` (create_artifact, read_artifact, then a good edit / a refused edit then a good one / a refused edit and stop).
- `tests/e2e/chat-item-turn-helpers.ts` (`runItemTurn`, `setLanguage`).

## What is left (in this order)
1. **Item 4 fix** (`chat/[conversationId]/+page.svelte`, the `.chat-title-bar`): add `class:chat-title-bar-counted={artifactCount > 0}` on the bar and `.chat-title-bar-counted .chat-title-bar-side { min-width: 4rem; }` (the chip hangs off the right column and the spacer opposite keeps the title centred; the h1 already has `min-w-0` + truncating spans, so it shrinks). Then run `chat-header-room.spec.ts` green, commit (replace the WIP).
2. **Item 7**: wire `fitPlaceholder` in `MessageInput.svelte`: `let textareaWidth = $state(0)` + `bind:clientWidth={textareaWidth}` on the textarea; an `$effect` computing `fittedPlaceholder` from `composerPlaceholder`, `textareaWidth`, `placeholderMeasurer(textarea)`, `fieldTextRoom(textarea)` (null when width 0 / no canvas = jsdom); `placeholder={fittedPlaceholder ?? composerPlaceholder}`; re-fit once `document.fonts.ready`. Shorten the Hungarian App string in `i18n/artifacts.ts` (`artifacts.chat.composerPlaceholderApp`: "Kérd meg Alfyt, hogy módosítsa ezt: {title}" -> "Kérj módosítást: {title}"). The red/green spec (placeholder measured with a canvas against the field's room, Document at 1100/1280/1440, App at 1280, short title stays whole) is saved at `<scratchpad>/p5/fx1-work/chat-header-room.full.spec.ts` (the item-4 part is already in the repo spec; add the placeholder tests from the saved file in the item 7 commit).
3. **Item 6**: `search/SearchModal.svelte` line ~825 `highlightParts(row.conversation.title)` -> `highlightParts(conversationDisplayTitle(row.conversation.title, $t('chat.untitledConversation')))` (`$lib/shared/conversation-title`). Red test in `search-modal.spec.ts` needs the Hungarian UI (`users.uiLanguage = "hu"`, an untitled conversation) — the English label equals the stored default so only Hungarian shows the defect.
4. **Item 5**: after a reload during a first turn that fails the reconnect ends in `onError` with `params.isReconnect` -> `adapters.loadPersistedData()` replaces the list (the server persists the user message only at finalize, so a failed turn leaves nothing) -> empty chat. Plan (`src/lib/client/normal-chat-client-turn-runtime.ts`, final `if (params.isReconnect)` branch): `await adapters.loadPersistedData()` (the page's version ends with `completePollingRecovery()`, which clears `canRetry`, so set state AFTER it), then if no user message with `params.message` is in `adapters.getMessages()` re-append it (`createUserMessage`), set `lastUserMessage = params.message`, `adapters.setSendError(adapters.toFriendlySendError(err))`, `canRetry = true`, `emitState()`. Extend `tests/e2e/stream-reconnect-failure.spec.ts` (FB-8's; the fake provider has `AI_SMOKE_REFUSE_SLOWLY_MARKER`): after the reconnect ends expect the user's message visible, an error notice and a retry button (look at `ErrorMessage.svelte` for the test ids). Runtime unit tests in `normal-chat-client-turn-runtime.test.ts`.
5. **Gate**: `scripts/gates.sh agent <out-dir> --port 5400 --workers 4 tests/e2e/chat-turn-files.spec.ts tests/e2e/chat-failed-tool-row.spec.ts tests/e2e/chat-one-card-per-item.spec.ts tests/e2e/chat-header-room.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/artifact-chat-card.spec.ts tests/e2e/artifact-app.spec.ts tests/e2e/artifact-document.spec.ts tests/e2e/search-modal.spec.ts tests/e2e/project-page.spec.ts tests/e2e/stream-reconnect-failure.spec.ts` once, at the end; put `summary.txt` lines in the final reply. Fallow must add 0 findings (new modules `artifact-deliverables.ts`, `placeholder-fit.ts`, the scripts/fixtures files are all used).
6. **Screenshots** (<= 6, in `<scratchpad>/p5/fx1-shots/`, look at each): already taken in `fx1-work/raw-shots/` and looked at: `fx1-failed-row-1440-folded.png`, `-opened.png`, `fx1-one-card-1440-folded.png`, `fx1-failed-row-390-opened.png` (all fine: red row "Nem sikerült szerkeszteni: Bécsi hétvége  Részletek", opened shows the model's English sentence in red, one card, the superseded failure is a rail step "Elolvasva · Nem sikerült szerkeszteni"). Still to take: header at 1100/1280 after the fix, the one-line placeholder, a search modal row. Copy the good ones into `fx1-shots/`.

## Notes / pitfalls found
- `src/lib/utils/tool-activity.ts` contains two literal NUL bytes (line ~1079, a template-literal separator, committed before this round): `grep` treats it as binary (use `grep -a`); my python edits preserved them (asserted).
- The shell is fish: quote globs (`--include='*.ts'`), no `timeout` binary, no foreground `sleep`. Run Playwright as `E2E_SERVER=dev E2E_PORT=5400 npx playwright test <spec>` directly with `run_in_background` (do not wrap in `( ... ) &`).
- The create-refusal card (`artifact-failed`, a refused `create_artifact`) still prints the model's English reason inside the card (pre-existing Wave 2.5 design, "with the model-facing reason"); not changed — mention to the owner if it matters.
- Item 3's superseded failed attempts move from the reply's rows to the rail while a turn streams (a one-row shift under the text at the moment a retry succeeds); nothing above the text moves.


## Update (after the cap warning): committed since the table above
- `93f4aa228` item 4 done (title column keeps 4rem while the chip is drawn; red 1100 px: title edge 375 vs chip 356, 1280: 390 vs 386; green at 1100/1280/1440).
- `9b2f5ae8d` item 6 done (SearchModal uses `conversationDisplayTitle`; red: the result row read "New Conversation Üzenettalálat ..." in the Hungarian UI; whole `search-modal.spec.ts` 12/12 green).
- item 7 done (HEAD, `docked composer's placeholder fits its field on one line`): `MessageInput.svelte` fits the placeholder (guarded `ResizeObserver`, not `bind:clientWidth`: the unit-test environment has no `ResizeObserver` and `bind:clientWidth` made all 156 MessageInput tests fail; `MessageInput.test.ts` 157 pass), HU App placeholder "Kérj módosítást: {title}". Red: 371 px of text in fields of 286/316/367 px at 1100/1280/1440 and the App; green all five tests in `chat-header-room.spec.ts` (+3 header tests).
- STILL TO DO: item 5, then `scripts/gates.sh agent ...` once, the remaining screenshots (header at 1100 after the fix, the one-line placeholder, the Hungarian search row: take with a throwaway spec like the earlier one, look at each, <= 6 in `fx1-shots/`), and the final reply.

## Update 2: ALL EIGHT ITEMS COMMITTED (HEAD `209a7b3fa`); the agent gate is next
- `209a7b3fa` item 5: the reconnect's failure branch (`normal-chat-client-turn-runtime.ts`, `showFailedReconnectedTurn`) puts the reader's message back, sets the friendly error and canRetry after `loadPersistedData()`; 4 unit tests (53 pass); `stream-reconnect-failure.spec.ts` extended (message + alert + Retry). The e2e could NOT be run red/green on `vite dev` (the page is slower than the provider's 1.5 s window, so it never reconnects: `streamPosts` stays 1 even before my assertions); it must be seen on the production build: the gate runs it.
- The two WIP commits (`11a319313`, `3f26c60da`) are completed by `93f4aa228` and `d28f70ec1`.
- Remaining: `scripts/gates.sh agent` (command in 'What is left' 5 above; add `tests/e2e/stream-reconnect-failure.spec.ts`, already in that list), screenshots, final reply.


## FINAL (read this section; the ones above are history)

Commits `6a45e3040..1dd6bca7d` on `fix/round-chat` (11, two of them WIP commits that `93f4aa228` and `d28f70ec1` complete): items 8 `6a45e3040` (+ format `1dd6bca7d`), 1 `7f7125d2b`, 2 `ed307005d`, 3 `95b1d2e83`, 4 `93f4aa228`, 6 `9b2f5ae8d`, 7 `d28f70ec1`, 5 `209a7b3fa`. Working tree clean.

### Gate (`scripts/gates.sh agent <out> --port 5400 --workers 4 <13 specs>`, once, at `209a7b3fa`, 4m58s; logs `p5/fx1-gate/`)
```
check      0 errors, 17 warnings (the baseline 17)
biome      FAIL at the gate: two long locator lines of my own item-8 edit; fixed in 1dd6bca7d, `npx biome check src scripts tests` clean after
migrations ok
vitest     files 1071 passed | 1 skipped; tests 18,198 passed | 2 skipped
build      unused-css=32 aria=2 (baseline 32/2); chunks ok, editor closure 70.9 kB gzip (unchanged)
fallow     total=124 circular=4 new_vs_baseline=0
playwright 132 passed, 0 skipped, 1 failed, 0 flaky on 4 workers
```
The one failure: `artifact-canvas-review.spec.ts:659` (`@smoke`, a spec I did not touch, FX-3's area): load average 12-13 at the end of the run; **passes alone** on the same build (`fx1-gate/rerun-canvas-review.log`, 8.4 s). `stream-reconnect-failure.spec.ts` (item 5's e2e, which needs the production build) passed in the gate.
Specs in the run in full: chat-turn-files, chat-failed-tool-row, chat-one-card-per-item, chat-header-room, stream-reconnect-failure, chat, streaming, conversation, artifact-chat-card, artifact-app, artifact-document, search-modal, project-page (+ the `@smoke` set).

### Red first, per item (real input, seen failing on the unfixed tree)
1. PDF turn: desktop and phone, no count button (spec `chat-turn-files`). 2. refused edit: "Eszköz <uuid>" with a green tick, opened on raw parameters (spec `chat-failed-tool-row`). 3. 2 cards where 1 expected (spec `chat-one-card-per-item`). 4. title edge 375 vs chip 356 at 1100 px, 390 vs 386 at 1280 (spec `chat-header-room`). 5. unit tests red by construction; the e2e is green on the build (could not reconnect on vite dev). 6. result row read "New Conversation" in the Hungarian UI. 7. 371 px of placeholder in fields of 286/316/367 px. 8. both tests timed out on `/This chat/`.

### Concerns / things the orchestrator should know
- Item 1 is a bounded poll (0.3 s, then less often, 17.7 s in all) rather than a push: if the server links the file later than that the list stays stale until a reload. A server-side alternative (listing the file before the reply link) would also list the owner's old pre-FB-1 exports (they carry the same `unified_produce` origin), so I did not do it.
- Item 3 moves a retried failed attempt from the reply's rows to the rail (the collapsed strip says "Nem sikerült szerkeszteni"); a one-row shift under the text at the moment a retry succeeds while a turn streams.
- A refused `create_artifact` still draws the Wave 2.5 "could not be made" card with the model's English reason inside it (pre-existing design, untouched).
- `src/lib/utils/tool-activity.ts` has two literal NUL bytes (line ~1079, pre-existing): `grep` calls it binary; use `grep -a`.
- Shared files I touched: `tests/mocks/ai-provider/openai-compatible-provider.ts` (6 lines: import + a dispatch at the top of the `stream === true` branch), `src/lib/i18n/chat.ts` and `artifacts.ts` (HU App placeholder shortened to "Kérj módosítást: {title}"), `edit.ts` (artifactTitle on refusals). AGENTS.md not edited (suggest: a bullet that the chat page re-reads until a succeeded job's file is a list row, and that a reply draws one card per item through `foldArtifactDeliverables`).
- Screenshots (6, each looked at): `p5/fx1-shots/` — failed row folded and opened (1440, HU), one card with the retried failure as a rail step, phone failed row opened (390), docked chat at 1100 (title truncating clear of the chip, one-line placeholder "Kérdezz erről: Bécsi hétvégi útiterv…"), the Hungarian search row "Új beszélgetés".
