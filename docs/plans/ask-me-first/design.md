# Ask me first: design

Date: 2026-11-03. Status: the owner approved the design in conversation (mockups v2 plus one change); this document turns it into something a builder can plan from. Nothing built.
Mockups: [`mockups.html`](./mockups.html) in this folder (v2, with the owner's last change folded in).
Backlog: item 5 of the owner's ranked backlog ("Ask me first").

## 1. Why

The owner's words for the backlog item were "Ask me first." Today Alfy has no structured way to ask the person anything. When a request forks, it guesses, or it writes the question into its prose and ends the reply; the person's answer then starts a new reply.

The owner's point when we picked it up (2026-11-03): in harnesses like dsh, an ask tool makes one turn "more meaningful because the model can just carry on with the answer, rather than stopping there and the next reply being round 2", which is "good for forks in a conversation or when you're discussing ideas and probably a LOT LOT more".

There is a technical reason the same-reply shape matters more here than in dsh. Within one turn the model holds the full results of every tool it called. Later turns replay earlier tool calls only as bounded digests (`normal-chat-tools/tool-result-digest.ts`, replayed by `chat-turn/conversation-history.ts`). So asking and then carrying on keeps everything Alfy found before it asked; stopping and starting a new reply means working from digests or doing the lookups again.

Prior art: Open WebUI's `ask_user` tool (v0.11.1; the question survives a reload since v0.12.4) takes 1 to 3 questions, each with a short header and 2 to 3 options (a label and a one-line description), the recommended option first, an optional free-text answer, and a 60 to 240 s timeout. Claude Code's AskUserQuestion holds the run open until the person answers.

AlfyAI is a private, self-hosted assistant for the owner's family. The owner's standing rules apply: few choices in the UX; every user-facing string in English and Hungarian (short, natural Hungarian that fits a 360 px row); self-hostable; no cross-account sharing.

## 2. Goals, non-goals, anti-goals

Goals:

- G1. In the middle of a Normal Chat reply, Alfy can stop and ask the person 1 to 3 questions with answers to click.
- G2. The same reply carries on from the answer, still holding everything Alfy found before it asked.
- G3. The person can pick an answer, write their own, leave it to Alfy, or close the question.
- G4. A waiting question survives a reload, another device, a sign-out and a server restart. There is no timer.
- G5. From anywhere in the app, the person can see which chat is waiting for them.
- G6. All of it works on a phone, in English and Hungarian.

Non-goals for this version:

- Pictures as answers ("which of these photos?"). Answers are text.
- Changing an answer after it is sent. Retry runs the whole reply again.
- A push or email notification when Alfy asks.
- Asking from anywhere but a Normal Chat reply: Atlas runs, App building, the @Alfy comment paths in Documents and Canvases, and background jobs do not ask.
- A timer, or a default answer taken when the person does not answer.
- A limit on when or how often Alfy may ask (owner).
- Replacing the permission card for connector writes. A write still waits for its own confirm card; asking is for choices.

Anti-goals. The work fails, even if it runs, when:

- Alfy interrogates: it asks what it could find out itself, or asks the same thing again after the person closed it. With no hard limit (owner), the tool's description and the meaning of the X carry this.
- the words being read move: nothing is inserted above prose that is streaming (rule F16 in `src/lib/components/chat/AGENTS.md`);
- an answer is lost (a reload, another device, a double tap) or applied twice;
- the person has to use the message box to answer (owner: typing goes into the card);
- a waiting question leaves the chat stuck with no way out (the X is always there);
- the card grows chrome: labels, banners, timers (the owner called the sidebar label "ugly").

## 3. Constraints

- **A reply cannot be held open.** A model run has a time cap and an idle cap (`chat-turn/stream-orchestrator.ts`: idle is min(150 s, timeout / 2)), a phone locks, a tab closes, the server restarts. The pause is saved state, not an open stream.
- **The tool catalogue has a tripwire.** `CATALOGUE_TOKEN_CEILING` (5,357 estimated tokens of descriptions) and `PER_TOOL_TOKEN_CEILING` (566) in `normal-chat-tools/index.test.ts`; schemas are not counted but cost about as much again. `tool-catalogue.en.snapshot.txt` is the cached prompt prefix, so adding a tool re-reads the prefix once for everyone.
- **Everything the app writes into a model request is English** (ruling 79, `chat-turn/AGENTS.md`). The questions and answers themselves are the model's words, in the chat's language; the app's own words sent back with an answer are English.
- **Send and stream are one contract** (root AGENTS.md, Known Traps): the route, `chat-turn/*`, the browser stream consumer and their tests move together.
- **Nothing above streaming prose** (F16): what Alfy does after the answer is drawn below the question's line.
- **Drafts are precious.** Words typed in the composer during a running reply survive it (`createDraftPersistence`, two callers: the chat page and `HomeSurface.svelte`). Turning the composer off must keep its draft.
- **Hungarian copy** must read naturally and fit a 360 px row.

## 4. What the person gets (decided)

The mockups show each state; this is the behaviour behind them.

**The card.** It sits inside the reply, right after the words Alfy wrote before asking, in the shell of the artifact and permission cards (border, 8 px radius, small shadow). It holds 1 to 3 questions. Each question has 2 to 3 answers, each a label with an optional one-line note, and the question's own words. Every card has:

- an X at the top right, which closes it without an answer;
- an "Other" row under each question, which opens a line inside the card;
- "Decide for me", which leaves every question on the card to Alfy.

**Recommended.** A question with one pick always has exactly one answer marked Recommended, and Alfy chooses which (owner). On a question with several picks the mark is optional and may sit on several answers or none (owner). The mark stays where Alfy put it in the list (my call), so an order like small, medium, large keeps its sense.

**Answering.**

- One question with one pick: a click on an answer sends it at once.
- Several questions, or a question with several picks: the person picks, then Send. Send works once every question has an answer.
- Own words: typed in the card's own line, never in the message box (owner). Enter sends it on a one-question card; on a larger card it is that question's answer and Send sends the card.
- "Decide for me": every question goes to Alfy's judgment, which is its Recommended answer where there is one.
- X: the question is closed without an answer. Alfy is told the person closed it, that the question may have been off, and that it should carry on with its best guess or ask differently, never the same thing again (owner: the X "would signal to the model that it's wrong or to guess").

**While it waits.** The reply's own buttons (copy, Retry and the rest) wait until the reply is finished. The message box is off: it is dimmed, takes no typing, and keeps any draft it holds; what the person types goes into the card's own line (owner). An answer or the X turns the box back on. There is no timer: the question waits for as long as it takes (owner).

**After the answer.** The card folds into one line, drawn like a finished tool step: a tick, the question in muted text, the answer in normal text. The line quotes an own answer, adds "· left to Alfy" after "Decide for me", and after the X shows a muted cross and "· closed". A press opens it to show each question with its answer. The answer is shown only there, never as a message bubble of its own (my call). It cannot be changed (owner). Alfy carries on below that line, with its own "Thought for" row if it thinks again, and the reply's buttons come back at the very end. Retry runs the whole reply again, question included (owner).

**More than once.** Alfy may ask as often as the conversation needs (owner: "I wouldn't limit 6 like that"), so one reply can hold several folded lines and, at its end, at most one waiting card.

**Somewhere else.** A chat that waits for the person shows a small question-mark icon (Lucide `MessageCircleQuestion`, accent colour) before its title in the sidebar, in the slot of the fork and incognito marks, until the question is answered or closed. No words on screen (owner: the label was "ugly"; "the icon to the left of the title is more than enough"); a screen reader hears "Waiting for your answer". Opening the chat on any device, or after a reload, shows the same waiting card.

**On a phone.** The card stays in the reply (no sheet over the words it asks about); answers are full-width rows at least 44 px tall; the X has a 44 px target.

**Small states.**

- Just appeared: for a moment the answers take no tap, as on the permission card, so a tap meant for something else cannot answer it.
- An answer that does not go through: one plain line in the card ("Couldn't send your answer. Try again."), not red, and the card stays answerable.

**The words the app adds** (questions and answers are Alfy's own):

| Where | English | Magyar |
|---|---|---|
| Mark on the recommended answer | Recommended | Javasolt |
| The row for own words (owner, 2026-11-05, after trying the card; was "Type my own..." / "Saját válasz...") | Other | Egyéb |
| Beside a question with several picks | Pick any | Több is lehet |
| Leave it to Alfy (owner, 2026-11-05, after trying the card; was "Up to you"; "Rád bízom" stays, shorter than "Döntsd el helyettem" in a 360 px row) | Decide for me | Rád bízom |
| Send (several questions or picks) | Send | Küldés |
| The X (screen readers) | Close the question | Kérdés bezárása |
| Folded line, several questions | {n} questions | {n} kérdés |
| Folded line, after "Decide for me" | left to Alfy | Alfyra bízva |
| Folded line, after the X | closed | bezárva |
| Sidebar icon (screen readers) | Waiting for your answer | A válaszodra vár |
| An answer that did not go through | Couldn't send your answer. Try again. | Nem sikerült elküldeni a válaszodat. Próbáld újra. |
| The card (screen readers) | Alfy's question / Alfy's questions ({n}) | Alfy kérdése / Alfy kérdései ({n}) |
| The recommended answer (screen readers) | {answer}, recommended | {answer}, javasolt |

## 5. How it works

The code facts below were read on 2026-11-03 (`ai@6.0.193`); line numbers drift, names do not.

### 5.1 A reply in segments (my call)

Today nothing is saved while a turn runs. The person's message and Alfy's reply are written together, at the end, by `finalizeChatTurn` (`chat-turn/finalize.ts`, called from `completeStreamTurn` in `chat-turn/stream-completion.ts`); a turn that dies leaves no rows. The turn's working state (the reply text, thinking, tool-call records, thought steps, the per-turn caps, URL provenance) lives inside one orchestrator call (`chat-turn/stream-orchestrator.ts`), and full tool results are dropped after the run: `messages.tool_calls` keeps only a digest of at most 1,500 characters per call. The `messages` table has no status column.

So a reply that pauses is built from segments:

- **The first segment is an ordinary turn that ends early.** Its run stops right after the ask call and is finalized like any turn: both rows are written, and the title, memory and summaries run as today. Two things differ: it gets no follow-up chips, and its ask is saved as a waiting question.
- **The answer (or the X) starts a resume run.** It is a turn without a new message from the person. Its model input carries the reply so far in full (the first segment's text, tool calls and full tool results, as captured at the pause) plus the answer as the ask call's result. Its output is saved as the next segment: an assistant row that names the row it continues.
- **The browser draws a reply's segments as one reply:** the first segment's words and cards, the ask's folded line, the next segment's words and cards, and the reply's buttons once, at the end.

Why not one row written across several runs: that needs a durable half-finished row (nothing writes one today), every reader of messages taught to handle it (title, summaries, search, export, fork, compression, the memory judge), a finalize that updates an existing row, and the per-run state merged by hand. Segments reuse the turn pipeline as it is, and each segment keeps the reply's existing shape (thinking rail, words, then what it made, rule F16).

### 5.2 The tool

One model-facing tool; `ask_user` is the obvious name. Its input is `questions`: 1 to 3 of `{ question, multiple?, options }`, where `options` holds 2 to 3 of `{ label, note?, recommended? }`. Validation runs the full zod schema at execution (the compact schema the model sees keeps the item counts but not refinements; `compactToolInputSchema` in `normal-chat-tools/shared.ts`):

- a single-pick question has exactly one recommended option (owner); a multi-pick question has any number, none included (owner);
- short length caps on the question, labels and notes, set by the builder so a card fits a phone;
- an invalid call returns a short English error and does not pause, so the model fixes it in the same run.

Its description (English, ruling 79) says when to ask: whenever a choice is truly the person's to make, before making something, at a fork in a conversation, or while talking an idea through; never for what Alfy can find out or decide itself; never the same question again after the person closed it. It says to write the questions and answers in the conversation's language, to mark the recommended answer, and that the reply pauses after the call until the person answers. It carries the "Do not use" case the hygiene test requires.

Cost: the description is paid by a measured raise of `CATALOGUE_TOKEN_CEILING`, the `make_image` precedent (my call, put to the owner on 2026-11-03, not objected to). It must also fit `PER_TOOL_TOKEN_CEILING` (566). The tool is registered on every turn, because the catalogue may not vary by message or account (`tests/integration/reply-language.test.ts`). The other tests that move with a new tool are in `normal-chat-tools/index.test.ts` (the name list, a `TOOL_TIMEOUTS_MS` row or `ENVELOPE_EXEMPT_TOOLS`, the frozen `tool-catalogue.en.snapshot.txt`, rewritten with `-u` in the same commit) and `NON_PROVENANCE_RESULT_TOOLS` in `url-provenance/turn.ts`.

What the model gets back as the ask call's result, in fixed English and never in the person's interface language: for each question, the picked labels, the person's own words, or that it was left to Alfy; after the X, that the person closed the question without answering, that the question may have been off, and that Alfy should carry on with its best judgment or ask differently, never the same thing again. The exact words are the builder's, inside ruling 79's scans (`reply-language.test.ts`, `english-request-purity.test.ts`); the person's words and the model's labels are data, listed as fixtures there.

### 5.3 The pause

- The run stops right after the ask call. The seam is a stop condition beside `doneAfterAnswer` in `normal-chat-model/index.ts` (`hasToolCall` on the ask tool). The ask's `execute` validates and records the call and returns at once; it never waits for the person, because the tool envelope's timeout and the turn caps would end it.
- What a resume needs is captured at the stop: the run's cumulative `response.messages` from `onStepFinish` (it holds the full tool outputs; today `onStepFinish` only logs), together with the continuation the run was itself given, for a later ask in the same reply. It is saved with the question.
- The terminal path gets a paused branch ahead of the whole-generation fallback in `chat-turn/stream-terminal.ts`. Today a finish with no visible text after a completed tool call starts a second, non-stream generation, which must not happen here. The paused branch sends its terminal frame before the buffer is cleared (`chat-turn/AGENTS.md`).
- The browser receives the question in the stream, and the stream ends with the reply paused.

### 5.4 Storage

A new table for questions, modelled on `connection_pending_writes`: id; user; conversation; the assistant row it belongs to (stamped at finalize, as pending writes are); the tool call id; the questions as the model sent them; a status (waiting, answering, answered, closed, discarded); the answer; the captured resume messages; times.

- The answer is kept on the question and also as the ask call's result digest in the segment's `tool_calls`, so history replays the question and its answer as a native tool call and result.
- The captured messages are kept until the segment that answers them is saved (a resume that dies needs them again, 5.5), and they go with the chat. For that time they may hold connector data at rest: the person's own data on their own server. Each captured tool result keeps the tool it came from, so a resume can gate it for each model attempt (5.5).
- A continuation row names the row it continues (a column or `metadata_json`, the builder's choice), so history and the browser can group a reply's segments.

### 5.5 The answer and the resume

- The answer or the X is posted to a route under the conversation, beside `pending-writes`. One conditional UPDATE claims the question (waiting to answering), as `claimPendingWrite` does, so one answer wins across devices and double taps. The loser is told it was already answered and draws the folded line.
- The claim starts the resume run through the same capacity gate as a send (one stream per person by default, `PER_USER_STREAM_LIMIT`). An answer starts a turn, so its refusals follow ADR-0054 as amended on 2026-11-03 ("An Update During A Turn" in `src/lib/components/chat/AGENTS.md`), through the client runtime's `startStream` refusal handling rather than a plain fetch:
  - refused for an update (`reason: "draining"`, or the proxy's 502, 503 or 504): the card keeps the answer, says the app is updating as a waiting message does, and sends it again when `/api/health` answers and is not draining, giving up after 8 minutes;
  - refused because another of the person's replies is running (`user_limit`) or the server is full (`global_limit`): the send's three-step backoff;
  - anything else, or a give-up: the question goes back to waiting, and the card shows "Couldn't send your answer. Try again." with the answer still in it.
- **A resume that dies is never run again by itself** (my call, following ADR-0054: tools may have run, so sending it again is the person's choice). If the resume fails or is cut off (a provider error, a cap, a crash or a restart) before its segment is saved, the question goes back to waiting: the card comes back with the error line, the picks still selected and the person's own words still in their line. A question left "answering" with no resume running for that chat (after a restart, say) reads as waiting when the questions are read, so a crash never leaves a chat stuck without a card or an X.
- **Privacy on failover** (the existing connector rule, not a new one): a resume attempt on a model that is not on the person's server receives connector results only as a turn on that model would, as the local summary or the digest (`normal-chat-tools/connector-distill.ts`), never raw text the person's setting keeps local. Today each failover attempt is rebuilt from the original messages (`messagesForAttempt` in `normal-chat-model/index.ts`); a resume's original messages are the captured ones, so they are gated for each attempt the same way. A cloud attempt then sees less than the full results, which is the price of the rule.
- "Answer now" is not offered during a resume in this version (my call): its retry path needs a person's message right before the reply (`findRetryTarget` in `chat-turn/retry.ts`, `handleRegenerate` on the page). Stop works as for any turn.
- The resume has its own turn origin (`chat-turn-origin.ts`). It must not be regenerate or edit-resend, which finalize counts as "the answer was wrong". It reuses Retry's way of running without saving a new message (`skipPersistUserMessage`, `chat-turn/retry.ts`).
- The streaming run gets a continuation slot, fed with the captured messages and the answer's tool result. Today only the non-stream fallback takes `continuationMessages`, with digests and tools off (`chat-turn/stream-fallback.ts`); `prefetchedToolMessages` in `normal-chat-context.ts` already has the shape with a full payload. Providers in flatten mode need a text form.
- The resume streams like any turn, so a reconnect joins it as today.
- Carried across a reply's segments: its sources for the citation gate, so a later segment may cite what an earlier one found (`stream-completion.ts`; today the gate sees only its own run's tool calls and would strip such links); and URL provenance, where the person's own answer counts as their words and an earlier segment's tool results as tool results (read `url-provenance/AGENTS.md` first). Kept per segment, as for any turn: model, usage, duration, and the per-turn caps (file and artifact counts, the one instruction offer), since each resume is started by the person (my call).

### 5.6 Around it

- Post-turn work runs per segment, as for any turn: the title after the first segment; the memory judge, summaries and the rest after each. A paused segment gets no follow-up chips.
- Retry runs the whole reply again (owner): it deletes from the reply's first segment, questions and later segments with it, and starts again from the person's message.
- Editing the person's message works as today; the reply's segments and questions go with it.
- While a question waits, the server refuses a new message in that chat. The composer is off, so only a stale page (another device) hits this, and the refusal makes it reload and show the card.
- Deleting a chat deletes its questions. Stop and delete during a resume end it like any turn.
- Failover and the control model work per run, as today; a resume may fail over like any run, with its captured connector results gated for each attempt (5.5).

### 5.7 The card in the browser

- **The card comes from the question rows, not from the stream.** The rows are loaded with the chat beside pending writes (`src/routes/(app)/chat/[conversationId]/+page.ts`), so the card survives a reload and shows on another device. During a turn the ask call already reaches the browser as a `data-tool-call` part with its input; on it the page reads the questions again, as it reads pending writes after a connector tool call (`refreshPendingWrites`, with its latest-read-wins counter). No new stream part type is needed, which matters because older tabs drop unknown `data-*` parts silently (`src/lib/services/streaming.ts`).
- **The end of a paused segment says so.** Its terminal metadata carries one new field naming the waiting question, so the page knows at once that the reply paused rather than finished. Today `onEnd` and `pollForCompletion` treat any new non-empty assistant row as the end of the reply; for a paused segment they do the segment's own work (as any turn's end) but not the reply's (the action row, follow-up chips, the queue).
- **Segments are drawn as one reply.** The page groups an assistant row with the rows that continue it. Each segment keeps its own thinking rail, words and cards; the question's card, or its folded line, sits after the segment that asked; the action row and follow-up chips appear once, after the last segment, and only when no question waits. Retry from that row aims at the reply's first segment. Today `MessageBubble.svelte` draws one rail, one block of prose and one row of cards per message, and has no way to put a card between two runs of prose; grouping rows avoids text offsets, which citation repair and the "Stopped" substitution rewrite.
- **The folded line is a `ToolActivityRow`** with a new body kind for the questions and answers (`src/lib/utils/tool-activity.ts`), the way `WriteConfirmCard.svelte` folds into a settled row.
- **The answers wake after 400 ms**, the permission sheet's read-before-answer lock (`WriteConfirmSheet.svelte`).
- **The card's own line keeps what was typed** across a reload on the same device, through `src/lib/client/conversation-session.ts` (the root AGENTS.md allows no new raw `sessionStorage` protocol). Its text is 16 px on phones, so iOS does not zoom.

### 5.8 The composer while a question waits

- One derived `questionOpen` on the chat page joins the composer's `disabled` (today `isConversationReadOnlyForChat || isEditResendPending`) and every page guard that starts a turn: send, regenerate, the Atlas action, chips, starting an edit, a file drop. This is the precedent "nothing starts a turn while an edit is open" (`src/lib/components/chat/AGENTS.md`). `disabled` leaves the composer's words and saved draft untouched.
- Typing goes into the card (owner): while a question waits, a printable key pressed when no field has focus moves focus to the card's own line, so letters never land in the composer. A one-question card's line is where the keys go; on a larger card, the first question that has no answer yet.
- A message queued during the first segment is not sent when it pauses. It goes back into the composer's draft, the way a Stop puts it back (`drainPostTurnQueue` in `src/lib/client/normal-chat-client-turn-runtime.ts` restores only on `wasStopped` today), so no new turn starts under an open question (my call). The finalize step that clears the sent message's draft must not clear the restored one.

### 5.9 The sidebar

`ConversationListItem` gains a flag for a waiting question, filled in `listConversations` (`src/lib/server/services/conversations.ts`) by one query on the question table, as the Atlas badge is. `ConversationItem.svelte` draws it in its mark slot: Lucide `MessageCircleQuestion`, 13 px, accent colour, with an `aria-label` and no visible words. The open chat sets the flag locally when it asks or is answered; other devices see it at the sidebar's next refresh (focus or visibility). The collapsed rail shows nothing new (my call).

### 5.10 Words

Chat strings go in `src/lib/i18n/chat.ts`, held in both locales by `chat.test.ts`. The sidebar string goes in `common.ts`, whose `sidebar.` keys the parity test audits only when listed in `AUDITED_PREFIXES` (`src/lib/i18n.test-helpers.ts`): list the new one.

## 6. Owner decisions, in order

| Date | Decision |
|---|---|
| 2026-10-25 | "Ask me first" is item 5 of the ranked backlog. |
| 2026-11-03 | The analysis in the backlog notes is right; the same reply carries on after the answer instead of a second round. |
| 2026-11-03 | A card holds 1 to 3 questions with 2 to 3 answers each and an optional note; a question may take several picks; "Type my own" is always there; a way to leave it to Alfy; no timer; an answered card folds into one line and cannot be changed; Retry reruns the whole reply; a chat that waits is marked in the sidebar. |
| 2026-11-03 | No limit on when or how often Alfy asks. |
| 2026-11-03 | The sidebar shows only the icon, with no label. Own words are typed in the card's own line, not the message box. An X at the card's top right closes it and tells the model the question was off, or to guess. Every question has a Recommended answer that the model marks. |
| 2026-11-03 | The Recommended mark is not mandatory on a question with several picks. The design (mockups v2) is approved. |
| 2026-11-05 | After trying the card: "Up to you" is now "Decide for me" and "Type my own..." is now "Other" (Hungarian: "Egyéb"; "Rád bízom" stays). |

## 7. My calls, for the owner to check

1. A reply that pauses is stored as segments, each an ordinary turn, drawn as one reply (5.1).
2. The answer shows only in the folded line, never as a message bubble.
3. One question with one pick answers on a click; several questions, or several picks, need Send.
4. The Recommended mark stays where Alfy put it in the list.
5. The answers wake after 400 ms, as on the permission sheet.
6. The sidebar mark is `MessageCircleQuestion` in the fork and incognito marks' slot, not the Atlas dot; nothing new on the collapsed rail.
7. A question has no short heading of its own, which saves words for Alfy to write and for the tool list to carry.
8. On a phone the card stays in the reply; no sheet.
9. "Decide for me" (drawn as "Up to you" in the approved mockups until the owner renamed it on 2026-11-05) and "Rád bízom" stay; they matter most on a question with several picks and no Recommended answer.
10. The tool is paid for by a measured raise of `CATALOGUE_TOKEN_CEILING`.
11. A message queued before the pause goes back into the composer's draft.
12. Per-turn caps count per segment; the citation gate's sources and URL provenance carry across a reply.
13. While a question waits, the server refuses a new message in that chat.
14. The card's own line keeps its typed text across a reload on the same device.
15. The captured full messages are kept until the segment that answers them is saved.
16. No new stream part; one new field in the terminal metadata.
17. Only Normal Chat replies ask.
18. Not in this version: pictures as answers, changing an answer, a notification when Alfy asks.

From the builder check (2026-11-03), settled without a question to the owner:

19. A resume that dies is never run again by itself: the question goes back to waiting, with the answer still in the card (my call, following ADR-0054).
20. A resume on a model off the person's server gets connector results gated for each attempt, as any turn's are (the existing connector rule).
21. An answer refused for an update waits for it and is sent again, as a message is (ADR-0054 as amended on 2026-11-03).
22. "Answer now" is not offered during a resume.
23. The real-model check is a measurement reported to the owner, not a gate (section 10).

## 8. Left to the builder

- The tool's name, schema details, length caps and description wording, within ruling 79 and both ceilings.
- The question table's columns and migration, and whether the continuation link is a column or a `metadata_json` field.
- The answer route's path and body, and the resume's turn-origin name.
- How the captured messages are stored, and their text form for providers in flatten mode.
- How history renders a reply's segments for later turns (`renderHistoryTurn` in `chat-turn/conversation-history.ts` pairs a person's message with one reply today), with the ask call and its answer as a native tool call and result.
- How the page groups segments, and how printable keys reach the card's own line.
- The vitest and Playwright coverage. The fake OpenAI-compatible provider already scripts tool calls (`tests/mocks/ai-provider/chat-turn-scripts.ts`: `toolCallFrames`, a next request recognised by its tool result, `provider.requests()` to check what the resume sent), so an ask flow is deterministic. At least: a click answer, an own answer, "Decide for me", the X, a reload while waiting, two answers racing, Retry on a reply that asked, and a message queued before the pause.

## 9. Where it lands

Read each folder's AGENTS.md before changing code there. This changes the send and stream contract, so the route, `chat-turn/*`, the browser stream consumer and their tests move together.

Server:

- `src/lib/server/services/normal-chat-tools/`: the tool (a module of its own, like `suggest-instruction.ts`), its registration in `index.ts` (`TOOL_TEXT`, `createNormalChatTools`) and the catalogue tests; `url-provenance/turn.ts` (`NON_PROVENANCE_RESULT_TOOLS`).
- `src/lib/server/services/normal-chat-model/index.ts`: the stop condition and the capture in `onStepFinish`.
- `src/lib/server/services/chat-turn/`: `stream-terminal.ts` (the paused branch), `stream-completion.ts` (no chips on a pause; the terminal field; sources across segments), `finalize.ts` (stamp the question's assistant row), `streaming-normal-chat-model-run.ts` (the continuation slot), a resume entry beside `retry.ts` and a third caller of the `chat-turn/index.ts` facade, `chat-turn-origin.ts`, `conversation-history.ts`.
- `src/lib/server/db/schema.ts` and a migration; the new table registered in `account-lifecycle/user-scoped-tables.ts`, as pending writes are.
- `src/lib/server/services/conversations.ts` (`listConversations`) for the sidebar flag.
- Routes: a GET for a chat's questions and a POST for an answer, beside `src/routes/api/conversations/[id]/pending-writes`; `src/routes/api/chat/stream` refuses a new message while a question waits.

Browser:

- `src/lib/client/api/` for the questions client; the chat page's `+page.ts` and `+page.svelte` (load, refresh, `questionOpen`, guards, the queue on a pause); `normal-chat-client-turn-runtime.ts`; `src/lib/services/streaming.ts` for the terminal field.
- `src/lib/components/chat/`: a new card component, the folded line's body kind, segment grouping in `MessageArea.svelte` and `MessageBubble.svelte`.
- `src/lib/components/sidebar/ConversationItem.svelte` and `src/lib/stores/conversations.ts`.
- `src/lib/i18n/chat.ts`, `common.ts` and `AUDITED_PREFIXES`.

Tests: a new e2e spec on the fake provider, plus the chat, streaming and conversation specs (root AGENTS.md, Mandatory Verification).

## 10. Done when

- In the owner's own kind of conversation, talking an idea through, Alfy asks at a real fork. Answering by a click, by own words, by "Decide for me" and by the X each carry the same reply on, and the reply uses what Alfy found before it asked (for example, it cites a source it read before the question).
- A reload while a question waits, or the same chat on a phone, shows the same card; an answer there folds it on the other device at its next load.
- Two answers racing: one wins, and the other device shows the folded line.
- Retry on a reply that asked runs the whole reply again.
- A message queued before the pause is in the composer's draft, not sent.
- The sidebar icon shows while the question waits and goes when it is answered or closed.
- An answer given while the server updates waits and is sent afterwards; a resume cut off by a restart brings the card back with the answer in it.
- Alfy's judgment is measured, not gated (my call): before release, one replay against the real model (the replay probe) on ten fixed prompts, five that fork and five clear requests, plus one X, is reported to the owner with the transcripts. The builder may rewrite the description once if it clearly asks too much or too little, measured and paid for like any catalogue change; whether to ship is the owner's call on that report.
- `scripts/gates.sh agent` passes with the new spec and the chat, streaming and conversation specs; the catalogue raise is recorded in the test's comments.
