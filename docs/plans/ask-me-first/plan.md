# Ask Me First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Plan's calls

The design (`design.md`, section 8 and the gaps it leaves) lets the builder decide these. This plan fixes them; each is marked "Plan's call N" where a task uses it.

1. The tool is `ask_user`, the catalogue's last tool (after `done`), so the cached prompt prefix moves only at its end.
2. Its description is fixed text (Part 1 Task 3): 541 characters, 136 estimated tokens at the test's 4.0 characters a token. It says "Phrase questions and options in the conversation's language": the design's "write the questions and answers in the conversation's language" trips ruling 79's scan (`write ... language`, `answers ... language`).
3. Caps: 1 to 3 questions, 2 to 3 options; a question at most 160 characters, a label 50, a note 100, own words 500. zod checks shape and caps; `checkAskQuestions` in `execute` checks the Recommended rule and returns a short English error.
4. One `ask_user` call per run: a second is refused (`already_asked`), so every question of a pause is on one card.
5. The tool writes the question row at execution (`waiting`, no message id) and returns `{ status: "waiting_for_user" }`. The stop condition `askedTheUser` fires on that result only; `hasToolCall` would also stop on an invalid or refused call.
6. Only the streaming Normal Chat run can pause (`canPause`). Everywhere else (the plain send route, the non-stream fallback when it has tools) the same tool answers `not_available` and the model goes on, so the catalogue never varies.
7. The shared vocabulary (types, caps, checks, the pause marker) is one leaf module, `src/lib/shared/ask-user.ts`, imported by the model run, the tools, the routes and the browser; the four Fallow cycles stay four.
8. Table `ask_questions`: `id`, `user_id`, `conversation_id`, `assistant_message_id` (null until stamped, cascades with the row), `tool_call_id`, `questions_json`, `status` (`waiting`, `answering`, `answered`, `closed`, `discarded`), `answer_json`, `resume_json`, `created_at`, `answered_at`, `settled_at`.
9. The store is `src/lib/server/services/chat-turn/ask-questions.ts`; the pure model-input shapes are `chat-turn/ask-capture.ts`; the resume entry is `chat-turn/ask-resume.ts`, beside `retry.ts`. All three reach routes only through the `chat-turn/index.ts` facade.
10. `resume_json` is `{ v: 1, messages, results }`: what follows the person's message in the model input (the first segment's prefetched `fetch_url` exchange, each earlier segment's capture with its answer, this run's cumulative `response.messages`), and one row per tool result (`toolCallId`, `toolName`, `localDistilled`, `digest`). It is written in the same UPDATE that stamps the message id at finalize and cleared when the question settles or is discarded.
11. An unstamped question is shown only while its chat's stream runs. A turn that ends without saving, or stopped, discards its question in the orchestrator's `finally`; every turn start discards its chat's unstamped leftovers (a crash).
12. `answering` with no live resume reads as `waiting`, carrying the answer that did not go through: the card shows it with the error line, after a reload or a restart too. The store keeps the live resumes in an in-process set of question ids: a won claim adds its id in the same synchronous step as its UPDATE (no `await` between them), release and settle always take it out, and a restart empties it. A claim releases only an `answering` row that is not in the set, so a second device's answer can never undo a first one whose stream has not registered yet (the route prepares the turn between the claim and the stream, and the chat's stream registry, `getOrphanedStream`, says nothing during that window). Every path after a won claim ends in a release or a settle (the route's errors and throws, the orchestrator's `finally`), or the chat would refuse new messages with no card until a restart.
13. The continuation link is `metadata_json.continuesMessageId` on each resume segment (no column), projected as `ChatMessage.continuesMessageId`. A fork remaps it to the copied row.
14. The terminal metadata field is `waitingQuestionId`, set only when the stamp landed.
15. The turn origin is `ask_resume` (in `ChatTurnOrigin`, not in `RETRY_ORIGINS`). It runs with `skipPersistUserMessage`, no regeneration appendix and no instant acknowledgment.
16. Routes: `GET /api/conversations/[id]/questions` answers `{ questions: AskQuestionDto[] }` (never the capture). `POST /api/conversations/[id]/questions/[questionId]/answer` takes `{ answer, streamId, model?, reasoningDepth?, personalityProfileId?, enabledConnectionCapabilities?, activeDocumentArtifactId? }` and answers the resume's stream, or JSON: 503 (capacity or draining, the send's body), 400 `INVALID_ANSWER`, 404, 409 `QUESTION_ALREADY_ANSWERED`.
17. A new message while a question waits is refused 409 `QUESTION_WAITING` by `/api/chat/stream` (a fresh send; a reconnect and an edit's resend pass) and by both branches of `/api/chat/send`. The page then reads the questions and the chat again and puts the words back in the draft.
18. The answer is `{ kind: "answered", answers: [{ picked: number[], ownWords: string | null }] }`, `{ kind: "left_to_alfy" }` or `{ kind: "closed" }`. Own words replace that question's picks; picking again clears them.
19. The model's result for an answer is fixed English JSON (`answered`, `left_to_you`, `closed`, each with a `note`, Part 1 Task 8). When the answering segment is saved, the same record replaces the paused digest of the ask call in the asking row's `tool_calls`.
20. The resume's input: history ends before the person's message (`historyBeforeMessageId`); the person's message and its guidance are rebuilt as a regenerate rebuilds them; the web prefetch is skipped; the continuation follows. The non-stream fallback carries the same continuation.
21. History: a segment that asked renders its other calls and results, then one assistant message `[its words, the ask call]`, then the ask's result (its answer); the next segment follows as any reply. Flatten mode says `[asked the user: ...]` and `[the user's answer: ...]`.
22. `gateMessagesForAttempt` replaces each captured raw connector result (`isConnectionToolName`, not already a local summary) with its digest on an attempt whose provider does not run on the person's box, when they keep connector data local (`hasLocalDistillEnabled`).
23. Across a reply's segments: the citation gate sees the earlier segments' tool calls; URL provenance is seeded with the captured results (`noteToolResult`) and the person's own words (`userTexts`).
24. Browser grouping is the pure `src/lib/components/chat/reply-segments.ts`. A continuation draws no depth chip and no "Answer now". Copy on the reply's last row copies every segment's words, joined by a blank line. Retry on any row of a reply regenerates its first. The jump rail and the later-turn counts count a reply once.
25. The card, or its folded line, is the last thing in the asking segment's body (after deliverables, warnings, skill drafts and write cards). The ask call itself leaves the rail (`isAskToolCall`), as artifact calls do.
26. The folded line is a `ToolActivityRow`: iconType `ask` (no tool icon, as the mockup draws it), a new status `closed` (a muted `X`), a new muted `objectSuffix` ("· left to Alfy", "· closed"), and a body kind `ask` with each question and its answer (none on a closed card, as the mockup draws no chevron there). Own words are quoted with the reader's marks, `chat.ask.ownAnswerQuote` (“…” / „…”), the one string not in the design's table.
27. Card states: waking (options, Up to you and the X off for 400 ms after it appears, and until its segment is saved), waiting, sending (the answer shown, everything off), the error line, and folded from `answering` on. The X is always drawn.
28. Keyboard: while a card waits and is awake, a capture-phase window `keydown` takes a printable key (not Space, not with Ctrl, Meta or Alt, not while composing) when no input, textarea, select or contenteditable has focus. It opens the target own line (the only question, else the first without an answer), focuses it without `preventDefault`, so the character lands there, and stops propagation, so the composer's `/` shortcut never sees it.
29. The own lines are kept through `conversation-session.ts` (`readAskLineDrafts`, `storeAskLineDrafts`, keys `ask-line-draft:<questionId>`), cleared on sign-out and when the card folds.
30. The runtime reports through one adapter, `onAskEvent` (`paused`, `answerAccepted`, `answerNotSent`, `alreadyAnswered`, `refusedWhileWaiting`). `answerQuestion` is a page entry point (it clears `detached`). Past the update wait and the capacity backoff, every failure of a resume goes through `settleAnswerThatDidNotLand` (join the chat's running stream, else `answerNotSent`), never the send's "what the server holds" judge, which looks for a reply after a user message.
31. The resume runs on the model, depth and personality the composer has selected when the answer is sent.
32. While a question waits, MessageArea draws the messages read-only (no pencil, regenerate, fork, chips or Atlas actions), as during an open edit; the card stays live.
33. Sidebar: `ConversationListItem.waitingForAnswer?: true`, `updateConversationWaitingForAnswerLocal(id, waiting)` in the store; the mark is `MessageCircleQuestionMark` (the installed Lucide's name for `MessageCircleQuestion`, now a deprecated alias) with `role="img"`, an `aria-label` and no `title`.
34. A stop asked before the paused branch runs wins: the segment is saved stopped, the question discarded, and the ask call saved as "The user stopped the reply before answering." so later turns do not read a question still open.
35. The composer dims to opacity 0.5 through ChatComposerPanel's `waitingForAnswer`, as the mockup draws it.
36. The e2e spec is `tests/e2e/ask-me-first.spec.ts` on the fake provider (marker `AI_SMOKE_ASK_MARKER`), with one test tagged `@smoke`.
37. The migration is `drizzle/1777140000123_ask_questions.sql`, journal idx 136 (read the newest number and idx first; `dev` may have moved).
38. The real-model measurement's "clearly too much" is asking on 2 or more of the 5 clear requests, "clearly too little" asking on 2 or fewer of the 5 forks (Part 3 Task 5); its ten prompts are fixed there.

**Goal:** In a Normal Chat reply, Alfy can stop and ask the person 1 to 3 questions with answers to click, and the same reply carries on from the answer with everything it found before it asked: survives reloads, other devices and restarts, marks the waiting chat in the sidebar, in English and Hungarian, on a phone too.

**Architecture:** A reply that pauses is stored as segments, each an ordinary turn (design 5.1). The `ask_user` tool records the question; a stop condition ends the run after it; the run's cumulative `response.messages` are captured and saved with the question when the segment is finalized. The answer route claims the question atomically and starts a resume turn (origin `ask_resume`) whose model input is the person's message plus the captured messages with the answer as the ask call's result; its output is the next segment, which names the row it continues. The browser draws a reply's segments as one reply, the card from the question rows (never from the stream), and the folded line as a `ToolActivityRow`.

**Tech Stack:** SvelteKit 2 with Svelte 5.56 runes, TypeScript, SQLite with hand-written Drizzle 0.45 migrations, `ai` 6.0.193 (`@ai-sdk/provider-utils` 4.0.27), zod 4, Vitest 4, Playwright 1.59, `@lucide/svelte` 1.17.

**Spec:** `docs/plans/ask-me-first/design.md` (approved 2026-11-03; its decisions are binding) and `docs/plans/ask-me-first/mockups.html` (v2, the approved look). Executors read both.

## Three plans, in this order

| # | Plan | Tasks | What works when it is done |
|---|---|---|---|
| 1 | [`plan-part-1-server.md`](./plan-part-1-server.md) | 9 | Server: the shared vocabulary; the `ask_questions` table and store; the `ask_user` tool and its measured catalogue raise; the stop condition and the capture; the paused segment (no fallback, no chips, `waitingQuestionId`); segments in storage, history and forks; the resume's model input (history cut, continuation slot, per-attempt connector gate, provenance seeds); the resume turn (claim, origin, settle, citation gate across segments); the routes, the refusal of new messages and the sidebar flag. A chat can ask, pause and resume through the API, tested in vitest. |
| 2 | [`plan-part-2-browser.md`](./plan-part-2-browser.md) | 7 | Browser: the answer through the stream transport and the runtime (refusals, waits, the queue on a pause); the folded line; the card with its states, keyboard routing and own lines; a reply drawn in segments; the sidebar mark; the chat page (load, `questionOpen`, guards, Retry, the composer). |
| 3 | [`plan-part-3-e2e-release.md`](./plan-part-3-e2e-release.md) | 5 | The fake model's ask scenarios and the e2e spec in two halves; the folder rules and the changelog; the final gates; the real-model measurement (needs the owner's go-ahead). |

Order: Part 1, then Part 2, then Part 3; inside each, tasks in order (each leaves the tree green). Work on branch `feat/ask-me-first` in a worktree cut from local `dev` (`1f3b64648` when this plan was written), made with superpowers:using-git-worktrees. Commits are small, one logical change each, with messages that say why; nothing is pushed, merged or deployed.

## Global Constraints

Every task includes these.

- Every user-facing string exists in English and Hungarian. The design's section 4 table is the copy, verbatim (`Type my own...` with three ASCII dots, `Rád bízom`, `Nem sikerült elküldeni a válaszodat. Próbáld újra.`, and the rest); the one addition is Plan's call 26's quote marks. Hungarian must fit a 360 px row.
- Ruling 79: everything the app writes into a model request is ASCII English (the description, field descriptions, results, notes, errors, the flatten lines). The questions, labels, notes and the person's own words are data. Read `src/lib/server/services/chat-turn/AGENTS.md` before writing any of it.
- Svelte 5 runes as the root AGENTS.md says: `$props()`, callback props, event attributes, snippets, `$state` for `bind:this` refs read later, non-passive touch listeners only through an action. Lucide icons only (`@lucide/svelte`), never an inline `<svg>`; colours, radius and spacing from `src/app.css` tokens.
- F16: nothing is inserted above prose that is streaming. The card and the folded line sit below the asking segment's words; what Alfy does after the answer is drawn below the folded line.
- Send and stream are one contract: the route, `chat-turn/*`, the browser stream consumer and their tests move together.
- Routes are adapters: they parse, call one service through the `chat-turn/index.ts` facade, and map the answer. No new raw `sessionStorage` key outside `src/lib/client/conversation-session.ts`. No store fetches.
- No timer, no default answer and no limit on how often Alfy asks (owner).
- Phone: answers are full-width rows at least 44 px tall, the X has a 44 px target, the own line's text is 16 px below 768 px.
- Fallow: no new findings; the four baseline cycles unchanged. `ask-user.ts` (shared) and `ask-questions.ts` (store) import no service that could close a cycle (Part 1 Tasks 1 and 2 say what each may import). An export a later task consumes may show as unused until that task lands; the last task of each part shows none.
- Gates: `npm run check` 0 errors and 0 warnings; `npm run build` 0 warnings; in the worktree `npx biome check src scripts tests`, never `npm run lint`. Never run `npm run check` or `npm test` while `npm run build` runs.
- Commands: every npm, npx, vitest, svelte-check, build and Playwright command runs with the literal prefix `env PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, with literal paths and no `$VAR`. The tasks write `npx …` for short; add the prefix when running.
- Migrations are hand-written and expand-only; every new table gets a `CREATE TABLE` migration, a `_journal.json` entry, a line in `scripts/prepare-db.ts`'s `requiredExistingTables` and a `USER_SCOPED_TABLES` row.
- Read each folder's AGENTS.md with the Read tool before changing code in it (list in Part 1 Task 1). New rules land in the folder's AGENTS.md in the task that makes them, short, with the writing-for-agents skill.
- Commit messages explain why and end with the attribution line your session gives. Never push.

## Review Focus

The five inputs most likely to bite a person that the spec implies and no flow test exercises by itself. Each has its test in the task named.

1. A reload, or a second device, while the answer's reply streams: the folded line stays folded and the reconnected reply groups under it; a waiting card never comes back (Part 3 Task 2, "a reload while the answer's reply streams").
2. A double tap, Enter and a click, or two devices answering within the same moment: one answer is taken and one resume runs, never two (Part 2 Task 4, "a busy card takes no second answer"; Part 1 Task 2, "never lets a second claim undo a first whose stream has not started").
3. Typing while another field has focus (the search modal, a Document in the side panel, another question's line): the card takes nothing (Part 2 Task 4, the keyboard test's negative cases).
4. A long first segment (a big page read before the question): the resume's continuation is counted in the prompt estimate the context ring shows (Part 1 Task 7, "counts the continuation in the prompt estimate").
5. A Hungarian chat: accented own words and Hungarian labels reach the resume request only as data, and the English scaffold around them is the same for both UI languages (Part 1 Task 8, the two integration tests).

## What the AI SDK docs and the installed package say

Checked on 2026-11-03 for this plan. ai-sdk.dev documents the latest major (it shows `isStepCount`, `onStepEnd`, `responseMessages`); the v6 pages (`ai-sdk.dev/v6/docs/agents/loop-control`, `.../reference/ai-sdk-core/stream-text`) and `node_modules/ai` 6.0.193 are what this code runs on:

- `stopWhen` takes one condition or an array (any one stops); built-ins `stepCountIs(n)`, `hasToolCall(toolName)`, `isLoopFinished()`; a custom condition is `StopCondition<TOOLS> = ({ steps }) => boolean | PromiseLike<boolean>`, evaluated after a step whose tool calls have all executed.
- `hasToolCall(name)` is `steps.at(-1).toolCalls.some(call => call.toolName === name)` (`dist/index.mjs`): any call of that name, valid or not. Hence Plan's call 5.
- `onStepFinish` gets a `StepResult` whose `response.messages` is cumulative, `[...previousSteps, ...thisStep]`, tool results in full (`dist/index.mjs`, the `finish-step` branch). The v6 reference page does not list `response.messages` on the callback; the installed source is the authority.
- Ordering: the stream consumer receives `finish-step` before `onStepFinish` runs, and `finish` only after the last step's `onStepFinish` has resolved (`await stepFinish.promise`). Read the captured messages at `finish`, never at `finish-step`.
- A tool result inside a `ModelMessage` is `{ type: "tool-result", toolCallId, toolName, output: { type: "json", value } | { type: "text", value } | … }` (`@ai-sdk/provider-utils` 4.0.27). The v6 reference page still says `result`; it is `output`.

## Where the design was read one way

- **The seam.** Design 5.3 names `hasToolCall` as the stop condition; it would also stop on an invalid call, which 5.2 says must not pause. The plan's condition checks the ask's result for the pause marker (Plan's call 5).
- **The description's language clause.** "write the questions and answers in the conversation's language" fails I1's scan; the plan says "Phrase questions and options …" (Plan's call 2).
- **When the row exists.** 5.7 has the page read the questions on the ask's `data-tool-call`, which finds a row only if the tool wrote it. The plan writes it at execution and stamps it at finalize (5.4's "stamped at finalize, as pending writes are"), and adds the discard rules a written-early row needs (Plan's call 11).
- **The resume's input.** 5.5 gives the continuation slot; two more things are needed so the reply is not fed twice: history must end before the person's message (it would hold the reply's own segments as digests, and the message itself), and the web prefetch must not run again (the first segment's prefetched exchange is part of "the continuation the run was itself given") (Plan's call 20). The non-stream fallback must carry the continuation too, or a fallback would answer without the answer.
- **Readers of consecutive assistant rows.** Besides those 5.1 lists, four places assume one assistant row per reply and are adjusted: `handleRegenerate` (a user message right before the row), `laterTurnCount` and `countLaterReplies`, the jump rail, and the fork copy of `metadata_json` (Plan's calls 13 and 24).
- **Refusal handling in the runtime.** 5.5 sends the answer through `startStream`. Its died-before-content and network-drop give-ups judge "landed" by a reply right after a user message, which a continuation never is; a resume goes through its own settle (Plan's call 30).
- **The queue's draft.** 5.8's "the finalize step that clears the sent message's draft must not clear the restored one" already holds (the server clears only a draft equal to the sent text, The Draft rules); the plan pins it with a test instead of changing finalize.
- **Copy and icon names.** The mockup's several-question card labels the X "Close the questions"; the design's table has one string, which the plan uses. `MessageCircleQuestion` is a deprecated alias in the installed `@lucide/svelte` 1.17; the plan uses `MessageCircleQuestionMark`, the same glyph.
