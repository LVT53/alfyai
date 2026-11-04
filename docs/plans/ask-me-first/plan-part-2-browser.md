# Ask Me First, Part 2: the Browser

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person sees the card in the reply, answers by a click, own words, "Up to you" or the X, watches the same reply carry on below the folded line, finds the waiting chat in the sidebar, and keeps every draft, on a phone too, in English and Hungarian.

**Architecture:** See `plan.md`. The card comes from the question rows (Part 1 Task 9's GET), read with the chat and again on the ask's `data-tool-call`; the answer goes through the stream transport and the client runtime like any turn; the page groups a reply's rows with the pure `reply-segments.ts`.

**Tech Stack:** as `plan.md`.

**Spec:** `design.md` sections 4, 5.7 to 5.10; `mockups.html` (sections 1 to 8). `plan.md` (Plan's calls, Global Constraints, Review Focus) applies to every task. Part 1 is done.

**Folder rules to Read first (with the Read tool):** `src/lib/services/AGENTS.md`; `src/lib/client/AGENTS.md`; `src/lib/stores/AGENTS.md`; `src/lib/components/AGENTS.md`; `src/lib/components/chat/AGENTS.md`; `src/routes/(app)/AGENTS.md`. The sidebar folder has no file of its own; `components/AGENTS.md` covers it.

---

### Task 1: The answer on the wire, the questions client and the own lines

**Files:**
- Modify: `src/lib/services/streaming.ts` (`StreamChatOptions.questionAnswer`; `StreamMetadata.waitingQuestionId` and its line in `buildStreamMetadata`); Test: `src/lib/services/streaming.test.ts`
- Create: `src/lib/client/api/ask-questions.ts`; Test: `src/lib/client/api/ask-questions.test.ts`
- Modify: `src/lib/client/conversation-session.ts` (two helpers; the prefix in `clearConversationSessionState`); Test: `src/lib/client/conversation-session.test.ts`

**Interfaces:**
- Consumes: Part 1's routes and `AskAnswer`, `AskQuestionDto` (`$lib/shared/ask-user`).
- Produces:

```ts
StreamChatOptions.questionAnswer?: { questionId: string; answer: AskAnswer };
// streamChat with questionAnswer POSTs to /api/conversations/<id>/questions/<questionId>/answer with
// { answer, streamId, model, reasoningDepth, personalityProfileId, enabledConnectionCapabilities, activeDocumentArtifactId }
StreamMetadata.waitingQuestionId?: string;
export function fetchConversationQuestions(conversationId: string, fetchImpl?: FetchLike): Promise<AskQuestionDto[]>;
export function readAskLineDrafts(questionId: string): Record<number, string>;
export function storeAskLineDrafts(questionId: string, drafts: Record<number, string> | null): void; // key `ask-line-draft:<questionId>`
```

- [ ] **Step 1: Write the failing tests.**

```ts
// streaming.test.ts
it("posts an answer to its question's route with the turn's choices", ...)
  // fetch called with "/api/conversations/conv-1/questions/q-1/answer"; body.answer, body.streamId, body.model
it("keeps waitingQuestionId from the terminal metadata", ...)   // onEnd metadata.waitingQuestionId === "q-1"
it("reports a refused answer with its status, code and reason, like any refused request", ...)
  // 409 { code: "QUESTION_ALREADY_ANSWERED" } -> onError error.status 409, error.code; 503 { reason: "draining" } -> isServerUpdateRefusal true
// ask-questions.test.ts
it("reads a chat's questions, and an empty list when there are none", ...)
// conversation-session.test.ts
it("keeps a card's own lines per question through a reload of the tab, and forgets them on sign-out", ...)
it("drops a question's lines when they are stored as null", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/services/streaming.test.ts src/lib/client/api/ask-questions.test.ts src/lib/client/conversation-session.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `fetchConversationQuestions` uses `requestJson` (`api/http.ts`) like `fetchConversationPendingWrites`; the session helpers use the file's `getSessionStorage()` and wrap parse failures like `readComposerMarks`.

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** ("Carry an answer to the server as a turn, and keep what the person typed in a card through a reload").

---

### Task 2: The answer in the client turn runtime

**Files:**
- Modify: `src/lib/client/normal-chat-client-turn-runtime.ts`
- Test: `src/lib/client/normal-chat-client-turn-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1; `isAskToolName` (`$lib/shared/ask-user`); the runtime's own `startStream`, `holdRefusedRequestForUpdate`, `recoverNetworkDroppedStream`, `findRunningStream`, `joinRunningStream`, `restoreQueuedTurnToDraft`.
- Produces:

```ts
export type AskRuntimeEvent =
  | { type: "paused"; questionId: string; assistantMessageId: string | null }
  | { type: "answerAccepted"; questionId: string }
  | { type: "answerNotSent"; questionId: string; quiet: boolean }
  | { type: "alreadyAnswered"; questionId: string }
  | { type: "refusedWhileWaiting" };
NormalChatClientTurnRuntimeAdapters.onAskEvent?: (event: AskRuntimeEvent) => void;
NormalChatClientTurnRuntimeAdapters.refreshQuestions?: () => void;
NormalChatClientTurnRuntimeAdapters.getAnsweringQuestionMessageId?: () => string | null;
NormalChatClientTurnRuntimeAdapters.getEnabledConnectionCapabilities?: () => string[] | undefined; // the composer's connections, for the turn an answer starts
runtime.answerQuestion(p: { questionId: string; answer: AskAnswer; continuesMessageId: string; userMessage: string }): Promise<void>;
```

Rules (Plan's calls 30 and 31; design 5.5 and 5.8):
- `answerQuestion` is an entry point: it clears `detached` first; it does nothing while a turn runs, the chat is read-only, an edit is open or an edit's resend is pending. It appends an assistant placeholder carrying `continuesMessageId` and starts a stream with `questionAnswer` and the composer's model, depth, personality, capabilities and open item. It never touches `lastSend`, `canRetry` or the send error.
- The first event of a resume's stream (`onToken`, `onThinking`, `onToolCall`, `onResponseActivity`) reports `answerAccepted` once.
- `onEnd` with `metadata.waitingQuestionId` (any turn) reports `paused`, runs a queued compression, gives a queued message back with `restoreQueuedTurnToDraft()` and drains nothing.
- A resume's `onError`: an update refusal waits (`holdRefusedRequestForUpdate`; its give-up reports `answerNotSent` with `quiet: false`, a Stop during the wait `quiet: true`, and neither shows `chat.updateStillRunning` nor Retry); `user_limit` and `global_limit` back off three times as a send does; 409 `QUESTION_ALREADY_ANSWERED` removes the placeholder and reports `alreadyAnswered`; a drop after content recovers as a send does; everything else, and every give-up, goes through `settleAnswerThatDidNotLand` (a running stream of the chat is joined under the same placeholder, else the placeholder goes and `answerNotSent` is reported).
- A send refused 409 `QUESTION_WAITING` removes its bubbles, gives its words back with `restorePayloadToDraft`, sets no send error and reports `refusedWhileWaiting`. A Retry or regenerate refused so takes its placeholder away with no send error and no Retry and reports `refusedWhileWaiting`; a Retry of a message the server never got gives its words back too (Rulings 16 and 19).
- Every join of a resume carries its answer and its asking row; a resume joined with no answer in hand (the mount join) reads the chat and the questions, with no second bubble and no Retry; a hidden tab's cut keeps the answer pending until the tab is seen again. `answerNotSent` can follow `answerAccepted` (Ruling 18).
- `onToolCall` for `ask_user` with status `done` or `failed` calls `refreshQuestions`.
- A reconnect's placeholder carries `continuesMessageId = getAnsweringQuestionMessageId()` when it returns an id (the stream being joined is that question's resume).

- [ ] **Step 1: Write the failing tests** (the file's fake adapters and fake `streamChat`):

```ts
it("streams an answer under a placeholder that continues the asking row, with the composer's choices", ...)
  // appendAssistantPlaceholder.placeholder.continuesMessageId === "seg-1"; streamChat options.questionAnswer; modelId from getSelectedModel()
it("says the answer was accepted on the resume's first event, once", ...)
it("gives a queued message back to the draft when a reply ends paused, and sends nothing", ...)
  // onAskEvent { type: "paused", questionId: "q-1", assistantMessageId: "seg-1" }; restorePayloadToDraft called; streamChat called once
it("waits for an update, then sends the answer again when health says up", ...)
it("gives an answer up after the update wait with answerNotSent, and quietly on Stop", ...)
it("backs an answer off three times when another reply is running, then says answerNotSent", ...)
it("says alreadyAnswered to a 409 and takes the placeholder away", ...)
it("joins the chat's running stream when a resume's connection died, else says answerNotSent", ...)
it("gives a refused send's words back when a question waits", ...)          // refusedWhileWaiting; setSendError not called with a message
it("asks the page to read the questions when an ask_user call is done", ...)
it("continues the answering question's row with a reconnect's placeholder", ...)
it("does nothing for an answer while a turn runs or an edit's resend is pending, and clears detached when it starts", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/client/normal-chat-client-turn-runtime.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `answerQuestion`, the branches above and `settleAnswerThatDidNotLand` (`findRunningStream(conversationId, STREAM_QUESTION_MAX_MS)` then `joinRunningStream`, as Retry joins).

- [ ] **Step 4: Run the runtime and the page-runtime tests.** `npx vitest run src/lib/client/normal-chat-client-turn-runtime.test.ts 'src/routes/(app)/chat/[conversationId]/page-runtime.test.ts'`. Expected: PASS.

- [ ] **Step 5: Commit** ("Send an answer as a turn: wait out an update, back off a busy server, and never lose the answer or a queued message").

---

### Task 3: The folded line

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (status `closed`; `ToolActivityItem.objectSuffix`; body `{ kind: "ask" }`); Test: `src/lib/utils/tool-activity.test.ts`
- Modify: `src/lib/utils/tool-calls.ts` (iconType `ask` for `ask_user`; `isAskToolCall`); Test: `src/lib/utils/tool-calls.test.ts`
- Modify: `src/lib/components/chat/ToolActivityRow.svelte` (a muted `X` for `closed`, the suffix after the object, the `ask` body), `src/lib/components/chat/ToolActivityIcon.svelte` (draws nothing for `ask`); Test: `src/lib/components/chat/ToolActivityRow.test.ts`
- Create: `src/lib/components/chat/ask-card-view.ts`; Test: `src/lib/components/chat/ask-card-view.test.ts`
- Modify: `src/lib/i18n/chat.ts` (the keys the line uses, en and hu: `chat.ask.questionCount`, `chat.ask.leftToAlfy`, `chat.ask.closed`, `chat.ask.ownAnswerQuote`)

**Interfaces:**
- Consumes: Task 1's DTO; `Translate` (`tool-evidence-presentation.ts`).
- Produces:

```ts
export type ToolActivityStatus = "running" | "done" | "failed" | "skipped" | "closed";
ToolActivityItem.objectSuffix?: string;                                         // muted, right after the object
ToolActivityBody |= { kind: "ask"; pairs: Array<{ question: string; answer: string }> };
ToolCallIconType |= "ask";
export function isAskToolCall(segment: ThinkingSegment): segment is ThinkingSegment & { type: "tool_call" }; // every ask_user call by name, refused ones included (Ruling 15)
export function askAnswerText(question: AskQuestion, answer: AskAnswer, index: number, t: Translate): string;
export function buildAskFoldedItem(question: AskQuestionDto, t: Translate): ToolActivityItem;
```

The line (Plan's call 26; mockup section 3): key `ask-<id>`; status `closed` for a closed card, else `done`; verb the question's words (one question) or `chat.ask.questionCount` (several); object the answers, several joined by " · ", picks by ", ", own words through `chat.ask.ownAnswerQuote`, "Up to you" as the Recommended labels (empty when there are none); `objectSuffix` "· " + `chat.ask.leftToAlfy` or "· " + `chat.ask.closed`; body `ask` with one pair per question, `null` for a closed card; `pinned: true`, `alwaysOpen: false`. A closed card is one whose answer is `{ kind: "closed" }`, while it is `answering` too. `meta` is empty, `summaryLabel` the verb, `title` the line's text. A question left to Alfy with no Recommended option reads `chat.ask.leftToAlfy` as its pair's answer (Ruling 17).

The strings (design section 4 table; Plan's call 26 adds the quote):

| key | en | hu |
|---|---|---|
| `chat.ask.questionCount` | `{count} questions` | `{count} kérdés` |
| `chat.ask.leftToAlfy` | `left to Alfy` | `Alfyra bízva` |
| `chat.ask.closed` | `closed` | `bezárva` |
| `chat.ask.ownAnswerQuote` | `“{text}”` | `„{text}”` |

- [ ] **Step 1: Write the failing tests** (`ask-card-view.test.ts` with a fake translator; values from the mockup):

```ts
it("folds a pick into one line: the question muted, the answer after it", () => {
  const item = buildAskFoldedItem(answered(card, [0]), t);
  expect(item).toMatchObject({ status: "done", iconType: "ask", verb: "Which way should we take it?", object: "A party at home", body: { kind: "ask", pairs: [{ question: "Which way should we take it?", answer: "A party at home" }] } });
  expect(item.objectSuffix).toBeUndefined();
});
it("quotes own words in the reader's marks", ...)       // en "“Smaller, maybe a picnic by the lake”", hu "„Kisebbet, talán egy piknik a tónál”"
it("says a choice was left to Alfy after its Recommended answer", ...)   // object "A party at home", objectSuffix "· left to Alfy"
it("says a closed card was closed, with nothing to open", ...)           // status "closed", object "", objectSuffix "· closed", body null
it("folds several questions into a count and their answers", ...)
  // verb "2 questions", object "Adults, Kids · “One list, with a section for the kids' things”", two pairs
// tool-calls.test.ts
it("knows the ask call and gives it the ask icon type", ...)
// ToolActivityRow.test.ts
it("draws a closed row with a muted X and its suffix after the object", ...)
it("lists each question with its answer in an ask body", ...)
it("draws no tool icon for an ask row", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/components/chat/ask-card-view.test.ts src/lib/utils/tool-activity.test.ts src/lib/utils/tool-calls.test.ts src/lib/components/chat/ToolActivityRow.test.ts src/lib/i18n/chat.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The `closed` glyph is Lucide `X` at the `skipped` style (muted); the suffix is a `span.act-object-suffix` in `--text-muted`; the `ask` body renders `.act-ask-pair` rows (question in `--text-muted`, answer in `--text-primary`), the mockup's `.rp` look.

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** ("Fold an answered question into the line every finished step is drawn as").

---

### Task 4: The card

**Files:**
- Create: `src/lib/components/chat/AskQuestionCard.svelte`; Test: `src/lib/components/chat/AskQuestionCard.test.ts`
- Modify: `src/lib/i18n/chat.ts` (the card's keys, en and hu)

**Interfaces:**
- Consumes: Tasks 1 and 3 (`readAskLineDrafts`, `storeAskLineDrafts`, `buildAskFoldedItem`), `ToolActivityRow`, `checkAskAnswer` for Send.
- Produces:

```ts
// AskQuestionCard.svelte props
{ question: AskQuestionDto; busy?: boolean; failed?: boolean;
  onAnswer?: (questionId: string, answer: AskAnswer) => void }
```

What it draws (mockup sections 1, 2, 4, 6, 7; Plan's calls 18, 27, 28, 29):
- `status !== "waiting"`: the folded `ToolActivityRow` (closed by default; a press opens it) and the question's own lines are dropped from the session.
- Waiting: an `<article>` in ArtifactCard's shell (1px `--border-default`, `--radius-lg`, `--surface-page`, `--shadow-sm`) labelled `chat.ask.cardLabel` or `chat.ask.cardLabelMany`; the X (Lucide `X`, 28 px, 44 px below 768 px) at the top right with `aria-label` `chat.ask.close`; each question's words (600 weight; its number in `--text-muted` on a card of several; `chat.ask.pickAny` beside a several-pick question); each option, in the order Alfy gave (a Recommended option is never moved up), a full-width row (a radio dot or a check box, the label, the note in `--text-muted`, the Recommended pill on the label, `aria-hidden`, the option's accessible name `chat.ask.recommendedOption` when marked, the note as its description); a "Type my own..." row (Lucide `PenLine`) that opens the question's line (the `.own-field` look: an accent border and ring; on a one-question card a small accent send button, Lucide `Send`, `aria-label` `chat.ask.send`); a footer with `chat.ask.upToYou` (quiet) and, on a card of several questions or a several-pick question, `chat.ask.send` (accent), on only when `checkAskAnswer` takes the answer.
- One question with one pick: a click sends at once. Own words replace that question's picks; a pick clears them; Enter in a line sends a one-question card and only sets the answer on a larger one.
- Waking: options, Up to you and the X are off (opacity 0.5) until 400 ms after the card appears and until `question.assistantMessageId` is set. Busy: everything off, the chosen answer still shown. Failed (or a waiting question with an `answer`): the picks and own words come back from the answer, and a plain line `chat.ask.sendFailed` (Lucide `CircleAlert`, `--warning-text`, `role="alert"`) sits under the questions; the card stays answerable.
- Keyboard (Plan's call 28): a capture-phase `window` `keydown` listener, added in an `$effect` only while the card waits, is awake and is not busy. It opens the line inside `flushSync` (from `svelte`), so the input exists when `focus()` runs, still within the keydown.
- The own lines' text is saved per question through `storeAskLineDrafts` on input and read back on mount; the line's font is 16 px below 768 px.

The strings:

| key | en | hu |
|---|---|---|
| `chat.ask.recommended` | `Recommended` | `Javasolt` |
| `chat.ask.typeOwn` | `Type my own...` | `Saját válasz...` |
| `chat.ask.pickAny` | `Pick any` | `Több is lehet` |
| `chat.ask.upToYou` | `Up to you` | `Rád bízom` |
| `chat.ask.send` | `Send` | `Küldés` |
| `chat.ask.close` | `Close the question` | `Kérdés bezárása` |
| `chat.ask.sendFailed` | `Couldn't send your answer. Try again.` | `Nem sikerült elküldeni a válaszodat. Próbáld újra.` |
| `chat.ask.cardLabel` | `Alfy's question` | `Alfy kérdése` |
| `chat.ask.cardLabelMany` | `Alfy's questions ({count})` | `Alfy kérdései ({count})` |
| `chat.ask.recommendedOption` | `{answer}, recommended` | `{answer}, javasolt` |

- [ ] **Step 1: Write the failing tests** (jsdom, `@testing-library/svelte`, fake timers; `WriteConfirmCard.test.ts` is the pattern):

```ts
it("draws the question, its options in Alfy's order, Recommended where Alfy put it, Type my own..., Up to you and the X", ...)
  // mockup section 7: the second option Recommended stays second
it("draws the Hungarian labels in a Hungarian UI", ...)        // Javasolt, Saját válasz..., Rád bízom, aria-label "Kérdés bezárása"
it("takes no press for 400 ms after it appears, and none before its segment is saved", ...)
it("answers a one-question, one-pick card on a click", ...)
  // onAnswer("q-1", { kind: "answered", answers: [{ picked: [0], ownWords: null }] })
it("needs Send on a card of several questions, on only once every question has an answer", ...)
it("lets own words replace a question's picks, and sends a one-question card on Enter", ...)
it("answers left_to_alfy for Up to you and closed for the X", ...)
it("takes a printable key pressed with nothing focused into the own line, and only then", async () => {
  // keydown "s" on document.body -> the line is open and focused; the composer's window listener saw nothing
  // not taken: Space, Ctrl+s, a key while an <input> elsewhere has focus, a key while composing, a key while busy   (Review Focus 3)
});
it("a busy card takes no second answer", ...)                    // two clicks, Enter after a click -> onAnswer called once (Review Focus 2)
it("shows the line for an answer that did not go through and keeps the picks and own words", ...)
it("keeps typed own words through a remount", ...)
it("folds once the question is answering, and forgets its own lines", ...)
it("names itself for a screen reader", ...)                      // "Alfy's question", "Alfy's questions (2)", "A party at home, recommended"
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/components/chat/AskQuestionCard.test.ts src/lib/i18n/chat.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the component** in runes (`$props`, `$state` for picks, own words, the open line and the input refs, `$derived` for awake and Send, `$effect` for the timer and the listener), Lucide icons only, tokens only.

- [ ] **Step 4: Run them.** Same command, then `npm run check`. Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit** ("Draw Alfy's question as a card in the reply: answers to click, a line for own words, Up to you and the X").

---

### Task 5: A reply drawn in segments

**Files:**
- Create: `src/lib/components/chat/reply-segments.ts`; Test: `src/lib/components/chat/reply-segments.test.ts`
- Modify: `src/lib/components/chat/MessageArea.svelte` (props `questions`, `askActionState`, `onAnswerQuestion`; each row's place); Test: `src/lib/components/chat/MessageArea.test.ts`
- Modify: `src/lib/components/chat/MessageBubble.svelte` (props `replyPlace`, `askQuestion`, `askState`, `onAnswerQuestion`); Test: `src/lib/components/chat/MessageBubble.test.ts`
- Modify: `src/lib/components/chat/jump-rail.ts`; Test: `src/lib/components/chat/jump-rail.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4; `ChatMessage.continuesMessageId` (Part 1 Task 6).
- Produces:

```ts
export type ReplyPlace = { firstMessageId: string; continuesAbove: boolean; continuedBelow: boolean;
  question: AskQuestionDto | null; copyText: string | null };
export function placeReplySegments(messages: readonly ChatMessage[], questions: readonly AskQuestionDto[],
  streamingMessageId: string | null): Map<string, ReplyPlace>;
export function replyFirstMessageId(messages: readonly ChatMessage[], messageId: string): string;
export function replyEndIndex(messages: readonly ChatMessage[], index: number): number;
export function personMessageOfReply(messages: readonly ChatMessage[], messageId: string): ChatMessage | null;
```

Rules (Plan's calls 24, 25, 32):
- A row continues the row above when its `continuesMessageId` is the id of the previous row; a link to a row that is not loaded starts a reply of its own.
- A question belongs to the row whose id is its `assistantMessageId`, or, unstamped, to the streaming row when it was made no earlier than a second before that row (the pending-write rule, `getPendingWritesForMessage`).
- A row is continued below when the next row continues it or its question waits or answers. On a continued row the bubble draws no action row, no follow-up chips and no provenance line. A continuation draws no depth chip, no "Answer now" and no top gap (`pt-0`).
- `copyText` is set on a reply's last row when the reply has more than one row: each row's words, the empty ones left out, joined by a blank line; Copy uses it.
- The ask call leaves the rail (`isAskToolCall` beside `isArtifactToolCall`). The card, or its folded line, is drawn right after `write-confirm-list`.
- The jump rail counts and lists a reply once (rows with `continuesMessageId` are skipped).

- [ ] **Step 1: Write the failing tests.**

```ts
// reply-segments.test.ts
it("places a reply of two segments: the first continued, the second continuing it with the reply's words to copy", ...)
  // copyText === "The biggest fork is …\n\nA party at home it is. …"
it("keeps a row continued while its question waits", ...)
it("starts a new reply when the continued row is not loaded", ...)
it("puts an unstamped question on the streaming row only", ...)
it("finds a reply's first row, its last index and the person's message", ...)
// MessageBubble.test.ts
it("draws no action row and no follow-up chips on a continued segment", ...)
it("draws no depth chip and no Answer now on a continuation", ...)
it("leaves the ask call out of the rail and draws the card last in the segment", ...)
it("copies every segment's words from the reply's last segment", ...)
// MessageArea.test.ts
it("draws a reply's segments as one reply and hands each its question", ...)
// jump-rail.test.ts
it("counts a reply in segments once", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/components/chat/reply-segments.test.ts src/lib/components/chat/MessageBubble.test.ts src/lib/components/chat/MessageArea.test.ts src/lib/components/chat/jump-rail.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the helper and the wiring; `MessageArea` computes the places once per render (`$derived`) from `dedupedMessages`, `questions` and `currentStreamingAssistantMessageId`.

- [ ] **Step 4: Run the chat components' tests.** `npx vitest run src/lib/components/chat/`. Expected: PASS.

- [ ] **Step 5: Commit** ("Draw a reply that paused as one reply: its segments, its question, and its buttons once, at the end").

---

### Task 6: The sidebar mark

**Files:**
- Modify: `src/lib/components/sidebar/ConversationItem.svelte`; Test: `src/lib/components/sidebar/ConversationItem.test.ts`
- Modify: `src/lib/stores/conversations.ts`; Test: `src/lib/stores/conversations.test.ts`
- Modify: `src/lib/i18n/common.ts` (`sidebar.waitingForAnswer`: en `Waiting for your answer`, hu `A válaszodra vár`), `src/lib/i18n.test-helpers.ts` (`AUDITED_PREFIXES` gains `"sidebar.waitingForAnswer"`)

**Interfaces:**
- Consumes: `ConversationListItem.waitingForAnswer` (Part 1 Task 9).
- Produces: `export function updateConversationWaitingForAnswerLocal(id: string, waiting: boolean): void;` (a local value until the next snapshot, which wins, like `updateConversationMemoryIncognitoLocal`).

The mark (Plan's call 33; mockup section 5): in the mark slot before the title, with the fork and incognito marks, `<span class="fork-indicator waiting-mark" data-testid="conversation-waiting-mark" role="img" aria-label={$t("sidebar.waitingForAnswer")}>` around Lucide `MessageCircleQuestionMark` (size 13, stroke 2.2, `aria-hidden`) in `--accent`; no `title`, no visible words; nothing new on the collapsed rail.

- [ ] **Step 1: Write the failing tests.**

```ts
it("draws the question mark before the title with an aria-label and no title text", ...)   // ConversationItem
it("draws nothing for a chat that does not wait", ...)
it("shows a local waiting flag at once, and the next snapshot's value wins", ...)        // store
// src/lib/i18n.test.ts, the parity test over AUDITED_PREFIXES, now covers sidebar.waitingForAnswer (no new test)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/components/sidebar/ConversationItem.test.ts src/lib/stores/conversations.test.ts src/lib/i18n.test.ts`. Expected: the two new tests FAIL; the parity test FAILS until both languages have the key.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** ("Mark a chat that waits for the person in the sidebar, with an icon and no words").

---

### Task 7: The chat page

**Files:**
- Modify: `src/routes/(app)/chat/[conversationId]/+page.ts` (`loadQuestions`, beside `loadPendingWrites`); Test: `page-load.test.ts`
- Modify: `src/routes/(app)/chat/[conversationId]/+page.svelte`
- Modify: `src/routes/(app)/chat/[conversationId]/_helpers.ts`; Test: `_helpers.test.ts`
- Modify: `src/routes/(app)/chat/[conversationId]/lifecycle-guards.ts` (`laterTurnCount`); Test: `lifecycle-guards.test.ts`
- Modify: `src/routes/(app)/chat/[conversationId]/_components/ChatComposerPanel.svelte` (`waitingForAnswer`); Test: `ChatComposerPanel.test.ts`
- Test: `src/routes/(app)/chat/[conversationId]/page-runtime.test.ts`

**Interfaces:**
- Consumes: everything above; `fetchConversationQuestions`; `updateConversationWaitingForAnswerLocal`; `placeReplySegments` helpers.
- Produces (in `_helpers.ts`):

```ts
export function isQuestionOpen(questions: readonly AskQuestionDto[], actionState: Record<string, { busy?: boolean }>): boolean;
export function withQuestionAnswering(questions: readonly AskQuestionDto[], questionId: string, answer: AskAnswer): AskQuestionDto[];
export function withQuestionStamped(questions: readonly AskQuestionDto[], questionId: string, assistantMessageId: string): AskQuestionDto[];
export function landedAssistantRow(row: ChatMessage, questions: readonly AskQuestionDto[]): boolean; // words, or a question of its own
// countLaterReplies counts replies, not segments
// laterTurnCount(messages, assistantIdx) counts the rows after the reply's last segment
```

The page (design 5.7 to 5.9; Plan's calls 30, 32, 35):
- State: `questions` from `data.questions` (replaced when `data.questions` changes, like `pendingWrites`), `askActionState`, `refreshQuestions()` with a latest-read-wins counter, called wherever `refreshPendingWrites()` is called and by the runtime's `refreshQuestions` adapter; `questionOpen = $derived(isQuestionOpen(questions, askActionState))`; all of it reset on a chat switch.
- Adapters: `onAskEvent` (`paused`: read the questions, stamp locally, sidebar flag on; `answerAccepted`: `withQuestionAnswering`, busy off, sidebar flag off; `answerNotSent`: busy off, `failed` unless quiet, read the questions, and load the chat (`loadPersistedData`) when the read says the question no longer waits; `alreadyAnswered`: busy off, read the questions, then `normalChatRuntime.checkForOrphanedStreamOnMount()` to join the winner's reply, else `loadPersistedData()`; `refusedWhileWaiting`: read the questions and `loadPersistedData()`), `refreshQuestions`, `getAnsweringQuestionMessageId` (the `assistantMessageId` of the question that is `answering`), `getEnabledConnectionCapabilities` (the composer's active capabilities). A `paused` with a null `assistantMessageId` stamps nothing locally. The questions are read again when a turn that answered a question ends, so a local `answering` never outlives its resume (a later turn's reconnect would continue the old asking row). `answerQuestion`'s `userMessage` is the stored text of the person's message (the runtime's join compares it with the running stream's).
- `handleAnswerQuestion(questionId, answer)`: refuses on a sealed chat, an open edit, an edit's resend or a running turn; sets busy; calls `normalChatRuntime.answerQuestion` with the question's `assistantMessageId` and `personMessageOfReply(...)`'s text.
- Guards: `questionOpen` joins `handleSend`, `handleRegenerate`, `handleRetry`, `handleAtlasLifecycleAction`, `handleSendFollowUp`, `handleStartEdit` and the drop (`fileDragRejected`, `handleDrop`); the composer's `disabled` becomes `isConversationReadOnlyForChat || isEditResendPending || questionOpen` (its words and saved draft untouched); `ChatComposerPanel waitingForAnswer={questionOpen}` dims it (opacity 0.5); `MessageArea readOnly={isConversationReadOnlyForChat || questionOpen}` plus `questions`, `askActionState`, `onAnswerQuestion`.
- `handleRegenerate` aims at `replyFirstMessageId($messages, payload.messageId)`, and the later-turn warning counts from the reply's last segment.
- `pollForCompletion` takes a row as landed with `landedAssistantRow`, reads the questions, and when the new row's question waits gives the queue back (`normalChatRuntime.restoreQueuedTurnToDraft()`) instead of draining it.

- [ ] **Step 1: Write the failing tests.**

```ts
// page-load.test.ts
it("loads the chat's questions beside its pending writes, and an empty list when the read fails", ...)
// _helpers.test.ts
it("opens a waiting question and gives the composer back while its answer is out", ...)
it("folds a question locally once its answer is accepted, and wakes it once stamped", ...)
it("counts a reply in segments once among the later replies", ...)
it("takes a paused row with no words as landed when it has a question", ...)
// lifecycle-guards.test.ts
it("counts later turns from a reply's last segment", ...)
// ChatComposerPanel.test.ts
it("dims the composer while a question waits", ...)
// page-runtime.test.ts
it("starts nothing while a question waits: send, regenerate, Retry, chips, Atlas actions, an edit, a drop", ...)
it("regenerates a reply that asked from its first segment", ...)
it("gives a queued message back to the draft when polling finds a paused segment", ...)
it("keeps the composer's draft through the pause and the answer", ...)
it("reads the questions and the chat again when a send is refused because a question waits", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run 'src/routes/(app)/chat/[conversationId]/'`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the load, the state, the adapters, the handler, the guards and the props.

- [ ] **Step 4: Run the browser suites and the check.** `npx vitest run 'src/routes/(app)' src/lib/components src/lib/client src/lib/services src/lib/stores src/lib/utils src/lib/i18n` and `npm run check`, `npx biome check src scripts tests`. Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 5: Commit** in two commits: the page's questions and guards ("Turn the message box off while Alfy waits for an answer, and keep everything that starts a turn away from it"), then Retry and polling ("Retry a reply that asked from its start, and treat a paused reply found by polling as a pause").
