# Ask Me First, Part 3: End to End, Release and the Real-Model Measurement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every flow the design's "Done when" names in a real browser against the production build and the fake provider, write the rules down where the next builder will read them, pass the gates, and measure Alfy's judgment against the real model for the owner.

**Architecture:** The fake OpenAI-compatible provider scripts the ask (`tests/mocks/ai-provider/chat-turn-scripts.ts`), recognising the resume request by the ask call's tool result; one spec, `tests/e2e/ask-me-first.spec.ts`, drives the real routes.

**Tech Stack:** as `plan.md`.

**Spec:** `design.md` section 10; `plan.md` applies. Parts 1 and 2 are done.

**Folder rules to Read first (with the Read tool):** `tests/AGENTS.md`; for Task 3 every AGENTS.md it edits.

---

### Task 1: The fake model's ask, and the answer flows

**Files:**
- Modify: `tests/fixtures/ai/chat-turn-scenarios.ts` (the ask scenario's constants)
- Modify: `tests/mocks/ai-provider/chat-turn-scripts.ts` (`askTurnReply`, wired into `scriptedChatTurnReply`)
- Create: `tests/e2e/ask-me-first.spec.ts` (the first `describe`)

**Interfaces:**
- Consumes: the provider harness (`createOpenAICompatibleProviderHarness`), `createTemporaryFakeProviderModel`, `updateUserModelPreference`, `snapshotUserModelPreference`, `deleteTemporaryProvider` (`artifact-live-edit.helpers.ts`), `setLanguage` (`chat-item-turn-helpers.ts`), `login`, `createEmptyConversation`, `sendMessage`, `waitForHydration`, `waitForStableBoundingBox` (`helpers.ts`).
- Produces:

```ts
export const AI_SMOKE_ASK_MARKER = "Fake model step: ask me first before you answer.";
export type AskTurnMode = "one" | "many" | "twice" | "slow" | "slowresume" | "read";
export function askTurnMessage(mode: AskTurnMode): string;          // `${AI_SMOKE_ASK_MARKER} ask:${mode}`
export function decodeAskTurnMode(text: string): AskTurnMode | null;
export const AI_SMOKE_ASK_INTRO = "The biggest fork is the shape of the day itself, so let's settle that first.";
export const AI_SMOKE_ASK_AFTER_PREFIX = "Carrying on with: ";
export const AI_SMOKE_ASK_CALL_ID = "call_ask_1";
export const AI_SMOKE_ASK_SECOND_CALL_ID = "call_ask_2";
export const AI_SMOKE_ASK_READ_TAIL = "The lake path is closed on Sundays."; // ends a Document body of about 2,000 characters, past the 1,500-character digest
export const AI_SMOKE_ASK_ONE: AskQuestion[];   // mockup section 1: "Which way should we take it?", three options, the first Recommended, notes as drawn
export const AI_SMOKE_ASK_MANY: AskQuestion[];  // mockup section 2: "Who's coming?" (multiple, Adults / Kids / Grandma, none Recommended), "How should the list be split?" (One shared list Recommended / A list per person)
export const AI_SMOKE_ASK_SECOND: AskQuestion[]; // mockup section 7: "Inside or in the garden?", the second option Recommended
```

The script: for `read`, the first request gets a `create_artifact` call (a Document whose body ends with `AI_SMOKE_ASK_READ_TAIL`), the request answering it a `read_artifact` call (`detail: "blocks"`), and only the request answering that gets the ask: the create-then-read chain the item-turn reply already scripts. Otherwise, a request whose current turn names the marker and answers neither call gets `toolCallFrames("ask", AI_SMOKE_ASK_INTRO, { callId: AI_SMOKE_ASK_CALL_ID, name: "ask_user", args: { questions } })` (for `slow`, held until the test releases it); a request answering `AI_SMOKE_ASK_CALL_ID` gets, for `twice`, a second ask (`AI_SMOKE_ASK_SECOND_CALL_ID`), else `textFrames` of `AI_SMOKE_ASK_AFTER_PREFIX` plus what the result says (the picked labels joined by ", ", the own words, `left to me`, or `closed`), for `slowresume` held until the test releases it; a request answering the second call gets the same text for it. The holds are the harness's (`ScriptedChatTurnReply.hold`, `release(name)`; `reset()` and `stop()` let go of every hold), never a fixed delay (Ruling 43: a fixed delay ties a test to the machine's speed).

Every test logs in, puts a temporary fake-provider model on the e2e admin and restores it, its language and the provider in `afterEach`; it opens a chat with `createEmptyConversation` and sends `askTurnMessage(mode)`.

- [ ] **Step 1: Write the script, the constants and these tests:**

```ts
test("a click on an answer carries the same reply on", { tag: "@smoke" }, async ({ page }) => {
  // the card: article "Alfy's question"; three option rows; "Recommended" on "A party at home"; "Other"; "Decide for me"; button "Close the question"
  // the composer is disabled while it waits
  // click "A party at home" (expect.poll until the option is enabled: the 400 ms wake)
  // the folded line: "Which way should we take it?" and "A party at home"; no article left
  // the reply carries on below it: text "Carrying on with: A party at home"
  // one action row for the reply (one Regenerate button), at its end; the composer is enabled again
  // the provider got two chat requests; the second ends in a tool message for call_ask_1 whose JSON has status "answered" and picked ["A party at home"]
  // and holds, after the person's message, an assistant message with AI_SMOKE_ASK_INTRO and the call_ask_1 call right before it (the continuation, not history)
});
test("the reply carries on with everything Alfy read before it asked", ...)
  // mode read: answer the card; the resume request's read_artifact tool message holds AI_SMOKE_ASK_READ_TAIL, which a history digest would have cut (design G2 and section 10)
test("letters typed with nothing focused go into the card's own line, and Enter sends them", ...)
  // keyboard.type("Smaller, maybe a picnic by the lake") with the body focused -> the line holds it; the composer holds nothing
  // Enter -> folded line shows “Smaller, maybe a picnic by the lake”; the request's ownWords is that text
test("Decide for me leaves the choice to Alfy", ...)       // folded "A party at home" "· left to Alfy"; status "left_to_you"
test("the X closes the question and the reply carries on", ...)
  // folded line with "· closed" and no chevron; request status "closed" and its note; text "Carrying on with: closed"
test("a card of several questions needs Send", ...)
  // mode many: Send disabled; pick Adults and Kids; type own words on question 2; Send -> folded "2 questions" "Adults, Kids · “One list, with a section for the kids' things”"; a press opens both pairs
test("Alfy asks again later in the same reply, under the first folded line", ...)
  // mode twice: answer the first card -> a second card under the folded line; answer it -> two folded lines, one reply, one action row
test("the words above the card do not move when it folds or when the reply carries on", ...)
  // the intro paragraph's top edge (waitForStableBoundingBox) is the same before the click and after the carried-on text arrives (F16)
test("on a phone the answers are 44 px rows and the X a 44 px target", ...)
  // viewport 390x844; each option's box height >= 44; the X's box >= 44x44; the own line's computed font-size is 16px
test("a Hungarian reader gets the app's words in Hungarian", ...)
  // setLanguage("hu"): Javasolt, Egyéb, Rád bízom, aria-label "Kérdés bezárása"
```

- [ ] **Step 2: Build and run the spec.** `npm run build`, then `E2E_PORT=5470 E2E_WORKERS=2 npx playwright test tests/e2e/ask-me-first.spec.ts`. Expected: PASS. A failure is a bug in the app or the test, never a retry or a longer timeout (root AGENTS.md).

- [ ] **Step 3: Commit** the fixtures, the script and the spec ("Prove the answer flows in a browser against the fake model").

---

### Task 2: The reply across reloads, devices, Retry, the queue, the sidebar and updates

**Files:**
- Modify: `tests/e2e/ask-me-first.spec.ts` (a second `describe`; it drains and undrains the worker's server, so its `afterEach` puts the drain back, as `server-update.spec.ts` does)

**Interfaces:**
- Consumes: Task 1; `POST /api/admin/drain` (`server-update.spec.ts`'s `setDraining`); `db` and `askQuestions` from the schema for one seeded state (`tests/e2e/sqlite-immediate.cjs` is loaded by the harness).

- [ ] **Step 1: Write these tests:**

```ts
test("a reload while a question waits shows the same card, and a second tab that answers late gets the folded line", ...)
  // reload -> the card again; a second page in the same context shows it too
  // answer in page A; then click an answer in page B -> no error line; B shows the folded line and the carried-on reply (it joined, or loaded)
test("a reload while the answer's reply streams shows the folded line and the reply joining under it", ...)   // Review Focus 1
  // mode slowresume: click; reload while the resume is held; the folded line, never an article; "Carrying on with: A party at home" arrives under it; one reply
test("Retry on a reply that asked runs the whole reply again", ...)
  // after the reply ends, Regenerate on its last segment -> the folded line and the carried-on text go; a new card appears
  // the third chat request carries no tool message (the reply started again from the person's message)
test("a message queued before the pause waits in the composer's draft and is not sent", ...)
  // mode slow: type and queue a message while the first segment runs; the card appears; the composer is disabled and holds the queued words
  // no third chat request; after a reload the draft still holds them; answer -> the composer is enabled with them, still unsent
test("the sidebar marks the chat while its question waits, and drops the mark once it is answered", ...)
  // getByTestId("conversation-waiting-mark") with aria-label "Waiting for your answer" on the chat's row; gone after the answer;
  // a fresh page (server snapshot) shows no mark either
test("an answer given while the server updates waits and goes once it is back", ...)
  // setDraining(true); click -> the card keeps the answer, nothing is answerable; "AlfyAI is being updated. Waiting for it to come back…" under it
  // setDraining(false) -> the folded line and the carried-on text arrive by themselves
test("a reply cut off by a restart brings the card back with the answer in it", ...)
  // after the card appears, set its row to status "answering" with the picked answer and no stream (db update); reload
  // the card waits again, "A party at home" selected, the line "Couldn't send your answer. Try again."; a click carries the reply on
```

- [ ] **Step 2: Build and run the spec.** As Task 1 Step 2. Expected: PASS.

- [ ] **Step 3: Commit** ("Prove the reply that asked survives reloads, a second device, Retry, a queued message and an update").

---

### Task 3: The rules, written where the next builder reads them

**Files:**
- Modify: `src/lib/server/services/chat-turn/AGENTS.md` (a section "Asking The Person": the tool and its one-ask rule; the stop on the pause result; the capture and when it is read; the paused branch before the fallback; the question's statuses, stamping and discards; the resume turn, its input, its gate and provenance; the refusal of a new message and of a Retry (Ruling 12); the answer route's order: the taken check, the capacity gate, the body, the question read, the claim, the preparation, the orchestrator, and its releases (Rulings 14, 44); Plan's calls 5, 10 to 12, 15, 17, 19 to 23, 34; gathered with the ask bullets already in the file under the new heading, never beside them (Ruling 34))
- Modify: `src/lib/components/chat/AGENTS.md` (a section "Questions In A Reply": the card from the rows, never the stream; the wake; the folded line; segments drawn as one reply; the composer and the keyboard while a question waits; the queue on a pause; Plan's calls 24 to 30, 32, 33 (the sidebar mark: icon only, no title, a local flag until the next snapshot, nothing on the rail), 35; the card's contract (one answer per busy; it draws its own folded line, owns its margins and is keyed by `question.id`; it sits after the asking segment's write cards: Rulings 21, 22, 25); the page's rules (Rulings 23, 27-30: the guard list, `isQuestionOpen` and the held-row rule with the once-per-question chat read, `atGate`, Retry hidden by `!questionOpen`, the pre-turn gate, the connection rule with `CAPABILITIES_LOAD_MAX_MS`, the bounded questions read, the read at an answering turn's end, polling giving the queue back); the thread's end is a waiting card's top when the card does not fit (Ruling 41: `thread-end-target.ts`, `endScrollTop`); the answer is a turn through `streamChat`'s `questionAnswer`, not a `client/api` call, and `conversation-session.ts` owns `ask-line-draft:<questionId>`; the sentence that names the entry points clearing `detached` gains `answerQuestion` (Ruling 36))
- Modify: `src/lib/server/services/AGENTS.md` (one line in Rules In Other Files: `ask_user`, the pause and the resume: `chat-turn/AGENTS.md`)
- Modify: `tests/AGENTS.md` (a Where to Look row for `tests/e2e/ask-me-first.spec.ts`; the fake provider's holds, `ScriptedChatTurnReply.hold` and `release(name)`, for a test that must act while a reply is held (Ruling 43); the smoke tier's count, counted with `npx playwright test --list --grep @smoke` after Task 1, not assumed (Ruling 35))
- Modify: `AGENTS.md` (Mandatory Verification: "asking the person (`ask_user`, the card, the folded line, the resume): `tests/e2e/ask-me-first.spec.ts`")
- Modify: `CHANGELOG.md` ([Unreleased], Added: Alfy can stop in the middle of a reply to ask you 1 to 3 questions, and the same reply carries on from your answer; you can click an answer, type your own, leave it to Alfy or close the question; a chat that waits shows a question mark in the sidebar)

- [ ] **Step 1: Write the sections** with the writing-for-agents skill: short, one rule a sentence, each rule naming its file and its test.

- [ ] **Step 2: Check them against the code.** Every file and function the sections name exists (`git grep` each name). Expected: all found.

- [ ] **Step 3: Commit** ("Write down how a reply asks, waits and carries on, for whoever changes it next").

---

### Task 4: The final verification

**Files:** none (a fix found here goes in a commit of its own, in the task that owns the code).

- [ ] **Step 1: Run the agent gate once, at the end.** `scripts/gates.sh agent <scratchpad>/gates-ask-me-first --port 5480 tests/e2e/ask-me-first.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/server-update.spec.ts tests/e2e/conversation-forks.spec.ts` (an absolute path in your scratchpad, written out). The last two are named because Part 2 Task 2 adds branches to the runtime's update wait and Part 1 Task 6 changes how a fork copies every message. Expected: every step 0; `check` 0 errors and 0 warnings; `biome` clean; `migrations` clean; `vitest` all pass; `build` 0 warnings; `chunks` clean; `fallow` no finding beyond the baseline's four cycles; `playwright` the six specs in full and every other file's `@smoke` tests pass.

- [ ] **Step 2: Report** the screen's numbers, the catalogue's measured total and new ceiling, and whether the four Fallow cycles are unchanged.

---

### Task 5: The real-model measurement (needs the owner's go-ahead; not a gate)

**Files:**
- Create: `docs/plans/ask-me-first/results-real-model.md` (the report)
- Create: `docs/plans/ask-me-first/real-model-transcripts/` (one JSON file per prompt: the request, the streamed deltas joined, the tool calls)
- Throwaway, deleted before any gate: `tests/integration/ask-probe-capture.test.ts`, a replay script in your scratchpad

**Interfaces:**
- Consumes: `tests/integration/language-capture.ts` (`installFakeProvider`, `seedWorld`, `capture`, `driveChat`), `buildAskAnswerRecord` (Part 1 Task 8), the replay probe recipe: capture the app's exact chat request, replay it against the production model's OpenAI-compatible endpoint with `stream: true`, and push the deltas through the app's own parsers.

- [ ] **Step 1: Ask the owner before anything is sent.** This calls a real model endpoint with a key from the owner's machine. Say what will be sent (eleven requests built from the fixed prompts below, no personal data: the capture's seeded world) and wait for a yes in chat.

- [ ] **Step 2: Capture the eleven requests.** A throwaway integration test drives `runPlainNormalChatSendModel` (through `driveChat`) with the production model's served name on the override provider, so its sampling profile applies, and writes each request body that carries `tools` to the scratchpad. The ten prompts, each in a fresh chat:

| # | Kind | Prompt |
|---|---|---|
| 1 | fork | I'd like to do something special for my dad's 60th in March. Can you help me think it through? |
| 2 | fork | Make me a packing list PDF for our family weekend in Vienna. |
| 3 | fork | Szeretnék új laptopot venni, segíts dönteni. |
| 4 | fork | Let's plan the garden for next spring together. |
| 5 | fork | Segíts kitalálni, hova menjünk idén nyáron nyaralni. |
| 6 | clear | What is the capital of Australia? |
| 7 | clear | Convert 72 Fahrenheit to Celsius. |
| 8 | clear | Írj egy rövid születésnapi üdvözletet Anna néninek. |
| 9 | clear | Summarize the plot of Hamlet in three sentences. |
| 10 | clear | Mennyi 15% borravaló egy 12 400 forintos számlára? |

  The eleventh is the X: prompt 1's request, plus the real model's assistant message from Step 3 (its words and its `ask_user` call), plus a tool message carrying `buildAskAnswerRecord(questions, { kind: "closed" }).result`.

- [ ] **Step 3: Replay each request once** against the production endpoint, `stream: true`, keeping every delta; never print the key. Read the tool calls with the app's parsers.

- [ ] **Step 4: Write the report** in `results-real-model.md`: per prompt, whether Alfy asked, its questions and options, whether the Recommended rule held (a refused call counts as asked and fixed or not), what it wrote before asking; for the X, whether it carried on without asking the same question again; the totals (forks asked out of 5, clear requests asked out of 5). Save the transcripts.

- [ ] **Step 5: At most one rewrite of the description.** Only if it clearly asks too much (2 or more of the 5 clear requests) or too little (2 or fewer of the 5 forks): rewrite the description once, within ruling 79's scans; measure it and move `CATALOGUE_TOKEN_CEILING` to the exact new total with a dated comment, as Part 1 Task 3 did; rewrite the snapshot with `-u`; replay all eleven again and report both runs side by side. Otherwise change nothing.

- [ ] **Step 6: Delete the throwaway files, run the gate again if the description changed** (Task 4's command), and commit the report, the transcripts and any description change ("Measure Alfy's asking against the real model, for the owner's ship call"). Whether to ship is the owner's call on the report.
