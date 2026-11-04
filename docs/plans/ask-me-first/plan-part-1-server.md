# Ask Me First, Part 1: the Server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alfy can ask in a Normal Chat reply, the reply pauses as a saved segment, and an answer posted to the conversation resumes the same reply with the full continuation; all of it through the API, tested in vitest.

**Architecture:** See `plan.md`. This part owns everything under `src/lib/server`, `src/lib/shared/ask-user.ts`, `drizzle/`, the new routes and the refusal in the chat routes.

**Tech Stack:** as `plan.md`.

**Spec:** `docs/plans/ask-me-first/design.md` sections 5.1 to 5.6, 5.9 and 9; `plan.md` (Plan's calls, Global Constraints, Review Focus) applies to every task.

**Folder rules to Read first (with the Read tool):** the root `AGENTS.md`; `src/lib/server/services/AGENTS.md`; `src/lib/server/services/chat-turn/AGENTS.md`; `src/lib/server/services/url-provenance/AGENTS.md`; `src/lib/server/db/AGENTS.md`; `src/routes/AGENTS.md`; `tests/AGENTS.md`. The tool folder `normal-chat-tools/` and the model run `normal-chat-model/` have no file of their own; `services/AGENTS.md` covers them.

---

### Task 1: Worktree, docs check, and the shared vocabulary

**Files:**
- Create: `src/lib/shared/ask-user.ts`
- Test: `src/lib/shared/ask-user.test.ts`

**Interfaces:**
- Consumes: nothing. The module imports nothing from `$lib/server`, `$lib/client` or a component (a leaf: Fallow).
- Produces:

```ts
export const ASK_USER_TOOL_NAME = "ask_user";
export const ASK_PAUSE_STATUS = "waiting_for_user";
export const ASK_LIMITS = { minQuestions: 1, maxQuestions: 3, minOptions: 2, maxOptions: 3,
  questionChars: 160, labelChars: 50, noteChars: 100, ownWordsChars: 500 } as const;
export type AskOption = { label: string; note?: string; recommended?: boolean };
export type AskQuestion = { question: string; multiple?: boolean; options: AskOption[] };
export type AskAnswer =
  | { kind: "answered"; answers: Array<{ picked: number[]; ownWords: string | null }> }
  | { kind: "left_to_alfy" }
  | { kind: "closed" };
export type AskQuestionStatus = "waiting" | "answering" | "answered" | "closed";
export type AskQuestionDto = {
  id: string; conversationId: string; assistantMessageId: string | null; toolCallId: string;
  questions: AskQuestion[]; status: AskQuestionStatus;
  /** waiting: the answer that did not go through, else null; otherwise the answer given. */
  answer: AskAnswer | null;
  createdAt: number; // ms
};
export function isAskPauseOutput(output: unknown): boolean;
export function checkAskQuestions(questions: readonly AskQuestion[]): { ok: true } | { ok: false; message: string };
export function parseAskQuestions(value: unknown): AskQuestion[] | null;
export function parseAskAnswer(value: unknown): AskAnswer | null;
export function checkAskAnswer(questions: readonly AskQuestion[], value: unknown): { ok: true; answer: AskAnswer } | { ok: false };
export function isAskToolName(name: string): boolean;
```

- [ ] **Step 1: Make the worktree and read the rules.** With superpowers:using-git-worktrees: `git worktree add .claude/worktrees/ask-me-first -b feat/ask-me-first dev`, then `env PATH=… npm ci` inside it. Read the folder AGENTS.md files listed above.

- [ ] **Step 2: Check the current docs and note what they confirm in the task report.**
  - AI SDK 6: `ai-sdk.dev/v6/docs/agents/loop-control` and `ai-sdk.dev/v6/docs/reference/ai-sdk-core/stream-text` (`stopWhen`, `hasToolCall`, `StopCondition`, `onStepFinish`, `prepareStep`), then the installed truth in `node_modules/ai/dist/index.d.ts` (`StopCondition`, `StepResult.response.messages`) and `dist/index.mjs` (`hasToolCall`, the `finish-step` branch, `await stepFinish.promise`), and `ToolResultPart.output` in `node_modules/@ai-sdk/provider-utils/dist/index.d.ts`. Expect the facts in `plan.md`, "What the AI SDK docs and the installed package say"; stop and report if any differs.
  - Svelte 5 runes (Svelte MCP docs, else `svelte.dev/docs/svelte`): `$state`, `$derived`, `$effect`, `$props`, snippets and `{@render}`, event attributes, `<svelte:window>`, actions (`use:`).
  - SvelteKit: `+server.ts` `RequestHandler`, `PageLoad` with `fetch` and `depends`.
  - Drizzle 0.45 SQLite: `sqliteTable`, `update().set().where()` and the `changes` count, `inArray`, `isNull`; this repo writes migrations by hand (`db/AGENTS.md`).
  - Vitest 4 (`vi.mock`, fake timers), Playwright 1.59 (`page.context().newPage()`, `page.request`, `keyboard`), `@lucide/svelte` 1.17 (`MessageCircleQuestionMark`, `PenLine`, `CircleAlert`, `Send`, `X`, `Check` exist under these names).

- [ ] **Step 3: Write the failing tests** in `src/lib/shared/ask-user.test.ts`:

```ts
const card: AskQuestion[] = [{ question: "Which way should we take it?", options: [
  { label: "A party at home", note: "Easiest to organise, and the whole family can come", recommended: true },
  { label: "Dinner out, just close family" }, { label: "A weekend away together" }] }];
it("takes the mockup's card", () => expect(checkAskQuestions(card)).toEqual({ ok: true }));
it("refuses a one-pick question with no Recommended option, or two", () => {
  expect(checkAskQuestions([{ ...card[0], options: card[0].options.map((o) => ({ ...o, recommended: false })) }]))
    .toEqual({ ok: false, message: "Question 1 takes one pick: mark exactly one of its options recommended." });
  // two recommended: the same message
});
it("takes a several-pick question with any number of Recommended options, none included", ...);
it("takes an answer that fits the questions", () => {
  expect(checkAskAnswer(card, { kind: "answered", answers: [{ picked: [0], ownWords: null }] }).ok).toBe(true);
  expect(checkAskAnswer(card, { kind: "answered", answers: [{ picked: [], ownWords: "Smaller, maybe a picnic by the lake" }] }).ok).toBe(true);
  expect(checkAskAnswer(card, { kind: "left_to_alfy" }).ok).toBe(true);
  expect(checkAskAnswer(card, { kind: "closed" }).ok).toBe(true);
});
it("refuses an answer that does not fit", () => {
  for (const bad of [
    { kind: "answered", answers: [{ picked: [0, 1], ownWords: null }] },   // two picks on one pick
    { kind: "answered", answers: [{ picked: [3], ownWords: null }] },      // no such option
    { kind: "answered", answers: [{ picked: [0], ownWords: "and this" }] }, // own words replace picks
    { kind: "answered", answers: [{ picked: [], ownWords: null }] },       // no answer
    { kind: "answered", answers: [] },                                     // a question left out
    { kind: "answered", answers: [{ picked: [], ownWords: "x".repeat(501) }] },
    { kind: "maybe" }, null, "closed",
  ]) expect(checkAskAnswer(card, bad).ok).toBe(false);
});
it("knows the pause result", () => {
  expect(isAskPauseOutput({ status: "waiting_for_user", note: "…" })).toBe(true);
  expect(isAskPauseOutput({ ok: false, errorCode: "already_asked" })).toBe(false);
  expect(isAskPauseOutput("waiting_for_user")).toBe(false);
  expect([isAskToolName("ask_user"), isAskToolName("done")]).toEqual([true, false]);
});
it("reads stored questions and answers back, and nothing else", () => {
  expect(parseAskQuestions(JSON.parse(JSON.stringify(card)))).toEqual(card);
  expect(parseAskQuestions([{ question: "x", options: [] }])).toBeNull();
  expect(parseAskAnswer({ kind: "closed" })).toEqual({ kind: "closed" });
});
```

- [ ] **Step 4: Run them to see them fail.** `npx vitest run src/lib/shared/ask-user.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 5: Implement `src/lib/shared/ask-user.ts`.** Own words are trimmed before the cap; `checkAskAnswer` parses with `parseAskAnswer`, then checks one answer per question, picks unique and in range, at most one pick on a one-pick question, exactly one of picks or own words. Messages are ASCII English and name the question by its 1-based number.

- [ ] **Step 6: Run the tests.** Same command. Expected: PASS.

- [ ] **Step 7: Commit.** `git add src/lib/shared/ask-user.ts src/lib/shared/ask-user.test.ts` and commit ("Give the question Alfy asks one vocabulary the model run, the tools and the browser share").

---

### Task 2: The `ask_questions` table and its store

**Files:**
- Modify: `src/lib/server/db/schema.ts` (a new `askQuestions` table after `connectionPendingWrites`)
- Create: `drizzle/1777140000123_ask_questions.sql`; Modify: `drizzle/meta/_journal.json` (idx 136, `when` 1777140000123, tag `1777140000123_ask_questions`)
- Modify: `scripts/prepare-db.ts` (`requiredExistingTables` gains `"ask_questions"`)
- Modify: `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` (a row like `connection_pending_writes`: `erasure: "cascade"`, `resets: []`)
- Create: `src/lib/server/services/chat-turn/ask-questions.ts`; Test: `src/lib/server/services/chat-turn/ask-questions.test.ts`
- Modify: `src/lib/server/db/AGENTS.md` (one line under Core Tables: `ask_questions` - the questions a reply asked, its captured continuation, cascades with the chat and the asking row)

**Interfaces:**
- Consumes: Task 1's types and `parseAskQuestions`, `parseAskAnswer`.
- Produces (the store imports only `drizzle-orm`, `$lib/server/db`, `$lib/server/db/schema`, `$lib/shared/ask-user`, `./active-streams` for `getOrphanedStream`, and types from `ai` and `./conversation-history`):

```ts
export type AskQuestionRow = typeof askQuestions.$inferSelect;
export type AskCapturedResult = { toolCallId: string; toolName: string; localDistilled: boolean; digest: HistoryToolDigest };
export type AskResumeCapture = { v: 1; messages: ModelMessage[]; results: AskCapturedResult[] };
export function recordAskQuestion(p: { userId: string; conversationId: string; toolCallId: string; questions: AskQuestion[] }): Promise<{ id: string }>;
export function stampAskQuestion(p: { userId: string; questionId: string; assistantMessageId: string; capture: AskResumeCapture }): Promise<boolean>;
export function discardAskQuestion(p: { userId: string; questionId: string }): Promise<void>;
export function discardStaleAskQuestions(p: { userId: string; conversationId: string }): Promise<number>;
export function getAskQuestion(p: { userId: string; conversationId: string; questionId: string }): Promise<AskQuestionRow | null>;
export type AskClaimResult = { ok: true; row: AskQuestionRow; claim: string } | { ok: false; reason: "not_found" | "not_waiting" };
export function claimAskQuestion(p: { userId: string; conversationId: string; questionId: string; answer: AskAnswer }): Promise<AskClaimResult>;
export function releaseAskQuestion(p: { userId: string; questionId: string; claim: string }): Promise<boolean>;
export function settleAskQuestion(p: { userId: string; questionId: string; claim: string }): Promise<AskQuestionRow | null>;
export function readAskCapture(row: AskQuestionRow): AskResumeCapture | null;
export function listConversationAskQuestions(p: { userId: string; conversationId: string }): Promise<AskQuestionDto[]>;
export function listWaitingAskConversationIds(p: { userId: string; conversationIds: readonly string[] }): Promise<Set<string>>;
export function hasWaitingAskQuestion(p: { userId: string; conversationId: string }): Promise<boolean>;
```

Rules the store holds (Plan's calls 8, 10 to 12):
- `stampAskQuestion` is one UPDATE `SET assistant_message_id, resume_json WHERE id AND user_id AND status='waiting' AND assistant_message_id IS NULL`; true when one row changed.
- `discardAskQuestion` and `discardStaleAskQuestions` touch only `status='waiting' AND assistant_message_id IS NULL`, set `discarded`, `settled_at`, `resume_json = NULL`.
- The store keeps a module-level set of live resumes, by question id (Plan's call 12).
- `claimAskQuestion`: a row that is `answering` and not in the live-resume set is first released; then one conditional UPDATE `waiting -> answering` (stamped rows only) writes `answer_json` and `answered_at`, and a won claim adds the id to the set in the same synchronous step. No row: `not_found`; no change: `not_waiting`.
- `releaseAskQuestion`: `answering -> waiting`, the answer kept. `settleAskQuestion`: `answering -> answered`, or `closed` for a `closed` answer, `resume_json = NULL`, `settled_at`. Ruling 6 (built in `76ccee3fb`): the live set is a Map of question id to a claim token; a won claim returns its token as `claim`; release and settle act only for the live claim's token (a second or stale call changes neither the row nor the map), and the holder always clears it, whether or not its UPDATE changed a row.
- Lists: `discarded` never shown; unstamped `waiting` shown only while the chat's stream runs (`getOrphanedStream`); `answering` with no live resume reads `waiting` with its answer; `listWaitingAskConversationIds` and `hasWaitingAskQuestion` count stamped rows only (`waiting`, or `answering` with no live resume, for the sidebar; `waiting` or `answering` for the refusal).

- [ ] **Step 1: Write the failing tests** in `ask-questions.test.ts`, on a temporary database migrated from `./drizzle` (the pattern of `connections/pending-writes.test.ts`), with `./active-streams` mocked (`getOrphanedStream` returns null unless a test says otherwise):

```ts
it("records a waiting question with no message id, shown only while its chat's stream runs", ...
  // listConversationAskQuestions -> [] ; with getOrphanedStream -> "stream-1": [{ status: "waiting", assistantMessageId: null }]
it("stamps the message id and the capture in one update, once", ...
  // first stampAskQuestion -> true; second -> false; readAskCapture(row) equals the capture
it("lets one of two claims win", async () => {
  const [a, b] = await Promise.all([claimAskQuestion({ ...ids, answer: picked0 }), claimAskQuestion({ ...ids, answer: closed })]);
  expect([a.ok, b.ok].sort()).toEqual([false, true]);
  expect((a.ok ? b : a)).toEqual({ ok: false, reason: "not_waiting" });
});
it("claims nothing unstamped", ...)                         // -> { ok: false, reason: "not_waiting" }
it("never lets a second claim undo a first whose stream has not started", ...)
  // claim A wins; claim B right after, getOrphanedStream still null -> { ok: false, reason: "not_waiting" }; the row keeps A's answer
it("releases a stale answering question before a claim when no resume is live for it (a restart)", ...)
  // the row set to answering directly in the database, not through a claim
it("puts a released question back to waiting with its answer, which the list reports", ...)
  // list -> [{ status: "waiting", answer: picked0 }]
it("settles an answer as answered and the X as closed, and drops the capture", ...)
  // row.status, row.resumeJson === null, row.settledAt set
it("discards only unstamped waiting questions; the turn-start sweep clears a chat's leftovers", ...)
it("goes with the asking row and with the chat", ...)       // delete messages row / conversation -> 0 rows
it("marks for the sidebar a stamped waiting question, and an answering one only when no resume is live for it", ...)
it("refuses while a stamped question waits or answers", ...)  // hasWaitingAskQuestion true / false
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/chat-turn/ask-questions.test.ts`. Expected: FAIL (no table, no module).

- [ ] **Step 3: Write the schema, the migration and the journal entry.** Columns as Plan's call 8: text `id` primary key; `user_id` references `users.id` cascade; `conversation_id` references `conversations.id` cascade; `assistant_message_id` nullable, references `messages.id` cascade; `tool_call_id`, `questions_json` not null; `status` not null default `'waiting'`; `answer_json`, `resume_json` nullable; `created_at` integer timestamp default `(unixepoch())`; `answered_at`, `settled_at` nullable timestamps. Indexes `ask_questions_conversation_created_idx (conversation_id, created_at)`, `ask_questions_assistant_message_idx (assistant_message_id)`, `ask_questions_user_status_idx (user_id, status)`. The SQL file opens with a comment in the style of `1777140000120_image_files.sql`. Add the `prepare-db.ts` line, the `USER_SCOPED_TABLES` row and the `db/AGENTS.md` line.

- [ ] **Step 4: Implement the store** with the signatures and rules above.

- [ ] **Step 5: Run the store test, the lifecycle guard and the migration check.** `npx vitest run src/lib/server/services/chat-turn/ask-questions.test.ts src/lib/server/services/account-lifecycle/account-lifecycle.test.ts src/lib/server/db/schema.test.ts` and `npm run check:migrations`. Expected: PASS.

- [ ] **Step 6: Commit** the schema, migration, journal, `prepare-db.ts`, registry row, store, test and `db/AGENTS.md` ("Keep a reply's question, its answer and what the resume needs in a table that goes with the chat").

---

### Task 3: The `ask_user` tool

**Files:**
- Create: `src/lib/server/services/normal-chat-tools/ask-user.ts`; Test: `src/lib/server/services/normal-chat-tools/ask-user.test.ts`
- Modify: `src/lib/server/services/normal-chat-tools/index.ts` (`TOOL_TEXT.ask_user`; `CreateNormalChatToolsContext.canPause`; the tool registered after `done`; `getTurnAsk` in the returned object)
- Modify: `src/lib/server/services/normal-chat-tools/shared.ts` (`TOOL_TIMEOUTS_MS.ask_user: 10_000`, with a one-line comment: one insert, nothing leaves the process)
- Modify: `src/lib/server/services/url-provenance/turn.ts` (`NON_PROVENANCE_RESULT_TOOLS` gains `"ask_user"`: its result is the model's labels coming back; the person's own words reach provenance as their words, Task 7)
- Modify: `src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts` (`NormalChatSendModelBaseParams.canPause?: boolean`, passed by `createToolPack`; `ToolPack.getTurnAsk`)
- Modify: `src/lib/server/services/normal-chat-tools/index.test.ts`, `src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt` (rewritten with `-u`)

**Interfaces:**
- Consumes: Task 1 (`ASK_USER_TOOL_NAME`, `ASK_PAUSE_STATUS`, `ASK_LIMITS`, `checkAskQuestions`), Task 2 (`recordAskQuestion`).
- Produces:

```ts
export const askUserInputSchema; // z.object({ questions: z.array(z.object({ question, multiple?, options: z.array(z.object({ label, note?, recommended? })).min(2).max(3) })).min(1).max(3) }), strings .min(1).max(cap)
export type TurnAsk = { questionId: string; toolCallId: string; questions: AskQuestion[] };
export type AskUserModelPayload =
  | { status: "waiting_for_user"; note: string }
  | { status: "not_available"; note: string }
  | { ok: false; errorCode: "invalid_questions" | "already_asked" | "ask_user_failed"; message: string };
export function createAskUserTool(ctx: { userId: string; conversationId: string; canPause: boolean;
  recorder: ToolCallRecorder; text: { description: string; errorPrefix: string } }):
  { tool: RequiredExecuteTool<z.infer<typeof askUserInputSchema>, AskUserModelPayload>; getTurnAsk: () => TurnAsk | null };
// index.ts
CreateNormalChatToolsContext.canPause?: boolean;          // default false
createNormalChatTools(ctx) => { tools; recorder; getToolCalls; getTurnAsk: () => TurnAsk | null };
ToolPack.getTurnAsk: () => TurnAsk | null;
```

The exact text (Plan's call 2; every sentence passes ruling 79's scans):

- `TOOL_TEXT.ask_user.description`: `Ask the user 1-3 questions, each with 2-3 options, when the choice is truly theirs: before you make something, at a fork in the conversation, or while talking an idea through. Your reply pauses here until they choose, then goes on in the same reply with their choice as this call's result. Mark exactly one option recommended on a one-pick question (any number with multiple: true). Phrase questions and options in the conversation's language. Do not use it for what you can find out or decide yourself, or to ask again what the user closed.`
- `errorPrefix`: `Asking the user failed`
- Field descriptions: `questions` "1-3 questions, in the order to ask them."; `question` "The question itself, one short sentence."; `multiple` "true when the user may pick several options."; `options` "2-3 options, in the order to show them."; `label` "The option, a few words."; `note` "Optional one-line note on what this option means."; `recommended` "Your recommendation."
- Payload notes: pause `Asked. The reply pauses here until the user chooses.`; not available `Asking is not available in this reply. Go on with your best judgment.`; already asked `One card per pause: put every question into a single ask_user call.`; invalid: `checkAskQuestions`'s message.

Behaviour: `execute` checks `canPause`, then the turn's one-ask flag (set synchronously before any await, so two calls in one step cannot both record), then `checkAskQuestions`; refusals are recorded calls (`recorder.record`, status `done`, `metadata.ok: false`) like `suggest_instruction`'s; a good call runs in `executeToolWithEnvelope` (`toolName: "ask_user"`, `TOOL_TIMEOUTS_MS.ask_user`), calls `recordAskQuestion`, records `{ name: "ask_user", input: { questions }, status: "done", outputSummary: "Asked the user; the reply paused for the answer.", sourceType: "tool", metadata: { paused: true, questionId } }`, and returns the pause payload. The tool is registered on every turn; the streaming run sets `canPause` in Task 5, so until then it answers `not_available` everywhere.

- [ ] **Step 1: Write the failing tests.** In `ask-user.test.ts` (store mocked):

```ts
it("records the question and pauses when the turn can pause", async () => {
  const { tool, getTurnAsk } = createAskUserTool({ ...ctx, canPause: true });
  expect(await tool.execute({ questions: card }, opts("call-1"))).toEqual({ status: "waiting_for_user", note: "Asked. The reply pauses here until the user chooses." });
  expect(recordAskQuestion).toHaveBeenCalledWith({ userId: "user-1", conversationId: "conv-1", toolCallId: "call-1", questions: card });
  expect(getTurnAsk()).toEqual({ questionId: "q-1", toolCallId: "call-1", questions: card });
});
it("answers not_available and records nothing when the turn cannot pause", ...)
it("refuses a one-pick question without exactly one Recommended option, records nothing, and does not pause", ...)
  // payload { ok: false, errorCode: "invalid_questions", message: "Question 1 takes one pick: mark exactly one of its options recommended." }; getTurnAsk() === null
it("refuses a second ask in the same turn, even in the same step", async () => {
  const [a, b] = await Promise.all([tool.execute(input, opts("a")), tool.execute(input, opts("b"))]);
  expect(recordAskQuestion).toHaveBeenCalledTimes(1);
  expect([a, b]).toContainEqual({ ok: false, errorCode: "already_asked", message: "One card per pause: put every question into a single ask_user call." });
});
it("answers ask_user_failed when the store fails", ...)
```

In `index.test.ts`: add `"ask_user"` to the full-catalogue name list; then

```ts
it("ask_user says what it is for and what it is not for, within the per-tool ceiling", () => {
  const entry = buildFullToolCatalogue().find((c) => c.name === "ask_user");
  expect(entry?.description).toContain(NEGATIVE_CASE_MARKER);
  expect(estimateTokens(entry?.description ?? "")).toBeLessThanOrEqual(PER_TOOL_TOKEN_CEILING); // 136 today
});
it("ask_user is the catalogue's last tool", () => expect(Object.keys(buildFullToolSet()).at(-1)).toBe("ask_user"));
it("ask_user waits inside a 10 s envelope", () => expect(TOOL_TIMEOUTS_MS.ask_user).toBe(10_000));
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/normal-chat-tools/ask-user.test.ts src/lib/server/services/normal-chat-tools/index.test.ts`. Expected: FAIL (no module; the name list, the timeout row, the ceiling and the snapshot fail).

- [ ] **Step 3: Implement the module and register the tool** (`ask_user: askUser.tool` after `done` in the `tools` object; `getTurnAsk` on the returned object and on `ToolPack`; `canPause` threaded from `NormalChatSendModelBaseParams` through `createToolPack`).

- [ ] **Step 4: Pay for the description, measured.** Run the catalogue tests and read the new total. Raise `CATALOGUE_TOKEN_CEILING` from 5357 to exactly the measured total (5493 if nothing else moved), with a comment under the 2026-10-30 entry in the same style: `// 2026-11-0x: ask_user (docs/plans/ask-me-first, design 5.2) adds 136 measured tokens, paid by a measured raise (design my call 10, put to the owner on 2026-11-03). No margin.` `PER_TOOL_TOKEN_CEILING` stays 566 (ask_user is 136). Rewrite the snapshot: `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts -u`, and check its diff changes only the end of the `tools` array (the new tool after `done`).

- [ ] **Step 5: Run the tool, provenance, turn and ruling 79 tests.** `npx vitest run src/lib/server/services/normal-chat-tools/ src/lib/server/services/url-provenance/ src/lib/server/services/chat-turn/ tests/integration/`. Expected: PASS (the new description passes I1 and I3; the catalogue is the same for every message and account; a test that lists a turn's tools by name gains `ask_user`, and only that).

- [ ] **Step 6: Commit** the module, its test, the registration, the timeout row, the provenance list, the ceiling raise with its comment and the snapshot, saying the snapshot was rewritten on purpose ("Give Alfy a way to ask: the ask_user tool, recorded and paid for").

---

### Task 4: The stop condition and the capture in the model run

**Files:**
- Modify: `src/lib/server/services/normal-chat-model/index.ts`
- Test: `src/lib/server/services/normal-chat-model/index.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ASK_USER_TOOL_NAME`, `isAskPauseOutput`). Import from `$lib/shared/ask-user` only; the model run must not import `normal-chat-tools` (cycle: the tools reach the model run through `connections/locality`).
- Produces:

```ts
function askedTheUser(): StopCondition<ToolSet>; // last step's toolResults hold an ask_user result whose output isAskPauseOutput
// buildToolStopWhen(max) => [doneAfterAnswer(), askedTheUser(), stagnantProgress(), stepCountIs(max)]
StreamingNormalChatModelRunParams.onStepMessages?: (messages: ModelMessage[]) => void;
StreamingNormalChatModelRunParams.gateMessagesForAttempt?: (messages: ModelMessage[], provider: NormalChatModelRunProvider) => ModelMessage[];
PlainNormalChatModelRunParams.gateMessagesForAttempt?: (messages: ModelMessage[], provider: NormalChatModelRunProvider) => ModelMessage[];
```

`onStepMessages` is called from the existing `onStepFinish` with `event.response.messages` (cumulative per attempt). `messagesForAttempt(messages, provider)` becomes `gate(stripped, provider)` when a gate is given, in both the plain loop and the streaming failover, so every attempt is rebuilt through it from the original messages.

- [ ] **Step 1: Write the failing tests** (the file's scripted-provider pattern):

```ts
it("stops right after the step whose ask_user result is the pause", ...)
  // step 1: text "The biggest fork is the shape of the day itself." + ask_user call; tool returns { status: "waiting_for_user", note }
  // expect one model request, then a finish event; no second step
it("goes on after an ask_user call that was refused", ...)
  // tool returns { ok: false, errorCode: "invalid_questions", message }; expect a second request
it("hands onStepMessages the attempt's cumulative response messages, the ask's result in full", ...)
  // last call: [assistant(text, tool-call ask_user), tool(tool-result ask_user, output { type: "json", value: { status: "waiting_for_user", … } })]
it("rebuilds each attempt's messages through gateMessagesForAttempt, with that attempt's provider", ...)
  // primary fails before output, fallback attempt; the gate is called twice, with the primary and then the fallback provider
it("passes the plain run's attempts through the gate too", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `askedTheUser`, the two params and the gate in `messagesForAttempt`'s callers.

- [ ] **Step 4: Run the model-run tests.** `npx vitest run src/lib/server/services/normal-chat-model/`. Expected: PASS.

- [ ] **Step 5: Commit** ("End the model run right after Alfy asks, and hand the turn what the run said and read").

---

### Task 5: The paused segment

**Files:**
- Create: `src/lib/server/services/chat-turn/ask-capture.ts`; Test: `src/lib/server/services/chat-turn/ask-capture.test.ts`
- Modify: `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts` (`canPause: true` on its base params; `onStepMessages`; three new result members)
- Modify: `src/lib/server/services/chat-turn/stream-terminal.ts` (the paused branch)
- Modify: `src/lib/server/services/chat-turn/stream-orchestrator.ts` (wires the branch; the turn-start sweep; the `finally` discard)
- Modify: `src/lib/server/services/chat-turn/stream-completion.ts` (no chips on a pause; `waitingQuestionId`; `ask.pause` to finalize)
- Modify: `src/lib/server/services/chat-turn/finalize.ts` (stamp before the receipt)
- Tests: `stream-terminal.test.ts`, `stream-completion.test.ts`, `finalize.test.ts`, `stream-orchestrator.test.ts`, `streaming-normal-chat-model-run.test.ts` (all in `chat-turn/`)

**Interfaces:**
- Consumes: Task 2 (`stampAskQuestion`, `discardAskQuestion`, `discardStaleAskQuestions`, `AskResumeCapture`, `AskCapturedResult`), Task 3 (`TurnAsk`, `ToolPack.getTurnAsk`), Task 4 (`onStepMessages`), `buildHistoryToolDigest` (`conversation-history.ts`).
- Produces:

```ts
// ask-capture.ts (pure; imports types, conversation-history, $lib/shared/ask-user)
export function buildAskResumeCapture(p: { continuationGiven: ModelMessage[]; responseMessages: ModelMessage[];
  toolCalls: ToolCallEntry[]; priorResults: AskCapturedResult[]; askToolCallId: string }): AskResumeCapture;
// streaming-normal-chat-model-run.ts
StreamingNormalChatSendModelResult.getTurnAsk: () => TurnAsk | null;
StreamingNormalChatSendModelResult.getResponseMessages: () => ModelMessage[]; // the last onStepMessages, read at finish
StreamingNormalChatSendModelResult.continuationGiven: ModelMessage[];       // prefetched tool messages (+ Task 7's continuation)
// stream-terminal.ts
StreamTerminalDeps.isPaused: () => boolean;
StreamTerminalDeps.runCompleteStreamTurn: (args: { wasStopped: boolean; streamClosedWithoutFinish: boolean; paused: boolean }) => Promise<void>;
StreamTerminal.completeSuccess(wasStopped?: boolean, options?: { streamClosedWithoutFinish?: boolean; paused?: boolean }): Promise<void>;
// stream-completion.ts
CompleteStreamTurnParams.askPause?: { questionId: string; capture: AskResumeCapture } | null;
// finalize.ts
FinalizeChatTurnParams.ask?: { pause?: { questionId: string; capture: AskResumeCapture } };
FinalizeChatTurnDurableReceipt.waitingQuestionId?: string; // set only when the stamp changed a row
// the terminal data-stream-metadata payload gains: waitingQuestionId?: string (from the receipt)
```

Rules:
- `buildAskResumeCapture`: `messages = [...continuationGiven, ...responseMessages]`; `results = [...priorResults, ...]` one row per tool-result part in `messages` not already in `priorResults` and not the ask call, from the matching `ToolCallEntry` (`digest: buildHistoryToolDigest(entry)`, `localDistilled: entry.metadata?.localDistilled === true`); `toolCalls` is the prefetched calls plus `getNormalChatToolCalls()`.
- Terminal: after the stop check and before the visible-answer check, `isPaused()` (the model run's `getTurnAsk()` is set and the captured response messages hold the ask's tool result, `holdsAskResult`, Ruling 8) completes with `paused: true`. The whole-generation fallback never runs for a paused turn. A stop asked first wins (Plan's call 34). The fallback runner's own success is never a pause.
- Completion with `askPause`: no follow-up chips; finalize gets `ask.pause`; `sendEndAndClose` takes `receipt.waitingQuestionId` into `data-stream-metadata` and sends it before the buffer is cleared, as every ending does.
- Finalize: `stampAskQuestion` right after the assistant row exists, next to the pending-write stamp, before `onDurableReceiptReady`; a stamp that throws is logged and leaves `waitingQuestionId` unset, never failing the turn.
- Orchestrator: on the main stream path, before the model run, `discardStaleAskQuestions({ userId, conversationId })` (best-effort); in `finally`, when the model run recorded an ask, `discardAskQuestion` (a no-op once stamped).
- A turn that had asked but does not pause saves its ask call settled, as `outputSummary` only (no `resultDigest`): `The user stopped the reply before answering.` when stopped, `The reply ended before the user answered.` for every other ending, so a later turn's history does not read a question still open; both whole-generation fallback inputs leave out ask_user calls; the turn-start sweep runs only for the main stream (Ruling 8, built in `ed0d12044`).

- [ ] **Step 1: Write the failing tests.**

```ts
// ask-capture.test.ts
it("keeps the prefetched exchange and the response messages, and one result row per tool result with its digest", ...)
  // fetch_url prefetched + research_web in the run; the ask call has no row
it("marks a result a local model summarised", ...)            // entry.metadata.localDistilled -> localDistilled: true
it("keeps an earlier capture's rows and adds only new ones", ...)
// stream-terminal.test.ts
it("completes a paused run as paused, before the whole-generation fallback", async () => {
  // isPaused true, hasVisibleAssistantAnswerOutput false, hasCompletedNonFileToolCall true
  expect(runCompleteStreamTurn).toHaveBeenCalledWith({ wasStopped: false, streamClosedWithoutFinish: false, paused: true });
  expect(fallbackRunner).not.toHaveBeenCalled();
});
it("lets a stop asked before the pause win", ...)              // paused: false, wasStopped: true
// stream-completion.test.ts
it("gives a paused segment no follow-up chips and names its question in the terminal metadata", ...)
  // generateFollowUpSuggestions not called; finalize ask.pause; data-stream-metadata.waitingQuestionId === "q-1"
it("sends the paused ending before it clears the stream buffer", ...)
it("leaves waitingQuestionId out when the stamp did not land", ...)
it("saves a stopped turn's ask call as stopped before an answer, and pauses nothing", ...)
// finalize.test.ts
it("stamps the paused question with its message id and capture before the receipt", ...)
  // call order: createMessage(assistant) < stampAskQuestion < onDurableReceiptReady; receipt.waitingQuestionId === "q-1"
it("finishes the turn when the stamp fails", ...)
// stream-orchestrator.test.ts (model run mocked: text_delta, tool_call ask_user, tool_result, usage, finish; getTurnAsk returns an ask)
it("ends a run that asked as a paused segment: no fallback, and the question named at the end", ...)
it("discards the question of a run that failed after asking", ...)   // an error event after the tool result -> discardAskQuestion
it("discards a chat's stale unstamped questions when a turn starts", ...)
// streaming-normal-chat-model-run.test.ts
it("lets the streaming run pause, and returns the turn's ask, its response messages and the continuation it was given", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/chat-turn/ask-capture.test.ts src/lib/server/services/chat-turn/stream-terminal.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/finalize.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** with the interfaces and rules above.

- [ ] **Step 4: Run the whole chat-turn folder.** `npx vitest run src/lib/server/services/chat-turn/`. Expected: PASS.

- [ ] **Step 5: Commit** ("Save a reply that asked as a paused segment, with what its resume needs, and never regenerate it from scratch").

---

### Task 6: Segments in storage, history and forks

**Files:**
- Modify: `src/lib/server/services/messages-types.ts` (`ChatMessage.continuesMessageId?: string`)
- Modify: `src/lib/server/services/messages.ts` (`PersistedMessageMetadata.continuesMessageId`; `projectMessageMetadata`; a new writer)
- Modify: `src/lib/server/services/chat-turn/conversation-history.ts` (`renderHistoryTurn`)
- Modify: `src/lib/server/services/conversation-forks.ts` (ids made before the insert; `copyMetadata` remaps the link)
- Tests: `src/lib/server/services/messages.test.ts`, `src/lib/server/services/chat-turn/conversation-history.test.ts`, `src/lib/server/services/conversation-forks.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isAskToolName`).
- Produces:

```ts
ChatMessage.continuesMessageId?: string; // the assistant row this one continues (Plan's call 13)
export function updateAssistantToolCallResult(p: { conversationId: string; messageId: string; callId: string;
  outputSummary: string; resultDigest: string }): Promise<boolean>; // messages.ts: rewrites one tool_call segment of tool_calls
```

History (Plan's call 21): for an assistant message whose tool calls include an `ask_user` call that paused the reply (`askCallPausedTheReply` in `$lib/shared/ask-user`, Ruling 9; refused and unfinished ask calls render as any call), `renderHistoryTurn` emits `assistant(other tool calls)`, `tool(their digests)` (both only when there are other calls), then `assistant([text part when there is text, the ask tool-call part])`, then `tool(the ask's digest)`. Flatten mode: the other calls' `[used …]` lines, the text, then `[asked the user: <questions joined by " / ">]` and `[the user's answer: <the digest's summary>]`, each within `MAX_FLATTENED_TOOL_LINE_CHARS`. A message with no ask renders as today.

- [ ] **Step 1: Write the failing tests.**

```ts
// conversation-history.test.ts
it("renders a segment that asked: its other calls first, then its words with the ask call, then the answer as the call's result", ...)
  // roles: assistant(tool-call research_web), tool, assistant([text, tool-call ask_user]), tool(ask digest)
it("renders the next segment as any reply, after one user message", ...)
it("says the question and the answer as lines in flatten mode", ...)
  // "[asked the user: Which way should we take it?]" and "[the user's answer: The user picked: A party at home]"
// messages.test.ts
it("projects continuesMessageId from the message's metadata", ...)
it("rewrites one tool call's result in the stored timeline and leaves the others alone", ...)
// conversation-forks.test.ts
it("points a copied continuation at the copied row it continues", ...)
it("drops the link when the continued row was not copied", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/messages.test.ts src/lib/server/services/chat-turn/conversation-history.test.ts src/lib/server/services/conversation-forks.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the projection, the writer, the rendering and the remap.

- [ ] **Step 4: Run them, and the fork and history neighbours.** `npx vitest run src/lib/server/services/messages*.test.ts src/lib/server/services/conversation-forks*.test.ts src/lib/server/services/chat-turn/conversation-history.test.ts src/lib/server/services/chat-turn/stream-fallback.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** ("Keep a reply in segments readable to later turns, and to forks of the chat").

---

### Task 7: The resume's model input

**Files:**
- Modify: `src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts` (new base params; `prepareOutboundContext` and `createToolPack` pass them; `estimateTurnPromptTokens` counts the continuation)
- Modify: `src/lib/server/services/normal-chat-context.ts` (`PrepareOutboundChatContextParams.historyBeforeMessageId`, `skipWebPrefetch`; `runForcedWebPrefetchStage` returns nothing when skipped)
- Modify: `src/lib/server/services/chat-turn/context-selection.ts` (`buildConstructedContext({ historyBeforeMessageId })`; `loadSessionPromptContext` takes the cut, and both of its callers, `buildShallowConstructedContext` and the full build, pass it)
- Modify: `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts` (the continuation slot; the gate to the run; `continuationGiven` includes it)
- Modify: `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts` and `src/lib/server/services/chat-turn/stream-fallback.ts` (the fallback keeps the continuation before its own; the gate)
- Modify: `src/lib/server/services/normal-chat-tools/index.ts`, `src/lib/server/services/url-provenance/index.ts`, `src/lib/server/services/url-provenance/turn.ts` (provenance seeds)
- Modify: `src/lib/server/services/chat-turn/ask-capture.ts` (the gate and the provenance results)
- Tests: `chat-turn/context-selection.test.ts`, `normal-chat-context.test.ts`, `chat-turn/streaming-normal-chat-model-run.test.ts`, `chat-turn/stream-fallback.test.ts`, `chat-turn/ask-capture.test.ts`, `url-provenance/turn.test.ts`, `normal-chat-tools/index.url-provenance.test.ts`

**Interfaces:**
- Consumes: Task 4's `gateMessagesForAttempt`; Task 2's `AskCapturedResult`; `providerRunsLocally` (`vision/provider-vision.ts`); `isConnectionToolName` (`$lib/utils/tool-calls`).
- Produces:

```ts
NormalChatSendModelBaseParams.continuationMessages?: ModelMessage[];   // exists; the streaming run now reads it too
NormalChatSendModelBaseParams.historyBeforeMessageId?: string;
NormalChatSendModelBaseParams.skipWebPrefetch?: boolean;
NormalChatSendModelBaseParams.gateMessagesForAttempt?: (messages: ModelMessage[], provider: NormalChatModelRunProvider) => ModelMessage[];
NormalChatSendModelBaseParams.resumeProvenance?: { userTexts: readonly string[]; priorResults: readonly ToolResultObservation[] };
CreateNormalChatToolsContext.resumeProvenance?: same;
createTurnUrlProvenance(p: { userId; conversationId; requestText?; userTexts?: readonly string[] }): TurnUrlProvenance;
TurnUrlProvenanceParams.userTexts?: readonly string[];                 // counted like the request text
export function gateCapturedConnectorResults(p: { results: readonly AskCapturedResult[]; keepConnectorDataLocal: boolean }):
  (messages: ModelMessage[], provider: NormalChatModelRunProvider) => ModelMessage[];
export function capturedProvenanceResults(capture: AskResumeCapture): ToolResultObservation[];
export function renderAskContinuationAsText(messages: ModelMessage[]): ModelMessage[]; // flatten providers (Plan's call 21's lines)
```

Rules (Plan's calls 20, 22, 23): the streaming run's messages are `[...history, currentUserMessage, ...prefetchedToolMessages, ...continuationMessages]`, the continuation passed through `renderAskContinuationAsText` when `resolveHistoryToolMessagesMode(runtime.provider)` is `"flatten"` (`normal-chat-model/provider-compatibility.ts`); `historyBeforeMessageId` drops that message and every later row from the stored messages the history is built from; `skipWebPrefetch` reads no page; the gate leaves messages alone when `keepConnectorDataLocal` is false or `providerRunsLocally(provider)`, and otherwise replaces the `output` of each captured connector result that is not `localDistilled` with `{ type: "json", value: digest }`; `createNormalChatTools` notes each `priorResults` entry with `noteToolResult` right after it makes the turn's provenance.

- [ ] **Step 1: Write the failing tests.**

```ts
it("ends the history before historyBeforeMessageId: that message and every later row are left out", ...)   // context-selection
it("reads no page for a pasted address when the turn skips the web prefetch", ...)                         // normal-chat-context
it("puts the continuation after the current message and the prefetched exchange", ...)                    // streaming run
it("counts the continuation in the prompt estimate", ...)                                                 // Review Focus 4
  // estimatedPromptTokens grows by estimateHistoryMessagesTokens(continuation, estimateTokenCount)
it("keeps the continuation before the fallback's own messages", ...)                                     // stream-fallback
it("folds the continuation into text for a provider that takes no tool messages", ...)                   // ask-capture + streaming run
it("gives an attempt off the person's box each raw connector result as its digest when they keep connector data local", ...)
it("leaves a local attempt, a local summary and a result that is not a connector's as they are", ...)       // ask-capture
it("knows an address the user wrote in an answer", ...)                                                  // url-provenance turn
it("knows an address a captured result carried", ...)                                                    // index.url-provenance
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/stream-fallback.test.ts src/lib/server/services/chat-turn/ask-capture.test.ts src/lib/server/services/url-provenance/turn.test.ts src/lib/server/services/normal-chat-tools/index.url-provenance.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the params through each layer (optional, so every existing caller is unchanged).

- [ ] **Step 4: Run the same files and the ruling 79 tests.** Add `tests/integration/reply-language.test.ts tests/integration/english-request-purity.test.ts tests/integration/ui-language-stream.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** ("Let a run go on from a saved continuation: the history stops before the reply, nothing is read twice, and connector data stays where the person keeps it").

---

### Task 8: The resume turn

**Files:**
- Modify: `src/lib/chat-turn-origin.ts` (`ChatTurnOrigin` gains `"ask_resume"`)
- Modify: `src/lib/server/services/chat-turn/retry.ts` (extract two exported helpers, no behaviour change)
- Modify: `src/lib/server/services/normal-chat-tools/ask-user.ts` (`buildAskAnswerRecord`)
- Modify: `src/lib/server/services/chat-turn/ask-capture.ts` (`buildAskResumeContinuation`, the `AskResumeInput` type)
- Create: `src/lib/server/services/chat-turn/ask-resume.ts`; Test: `src/lib/server/services/chat-turn/ask-resume.test.ts`
- Modify: `src/lib/server/services/chat-turn/stream-orchestrator.ts` (`StreamOrchestratorOptions.resume`)
- Modify: `src/lib/server/services/chat-turn/stream-completion.ts`, `src/lib/server/services/chat-turn/finalize.ts` (`askResume`; settle before the receipt)
- Modify: `src/lib/server/services/chat-turn/index.ts` (facade)
- Modify: `tests/integration/language-capture.ts` (`driveChat` takes `{ continuationMessages? }`), `tests/integration/reply-language.test.ts`, `tests/integration/english-request-purity.test.ts`
- Tests: `retry.test.ts`, `ask-user.test.ts`, `ask-capture.test.ts`, `stream-completion.test.ts`, `finalize.test.ts`, `stream-orchestrator.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// retry.ts (moved out of prepareRetryChatTurn unchanged; retry calls them in its old order)
export function resolveStoredTurnChoices(p: { userId: string; conversationId: string;
  userMessage: { id: string; content: string; metadataJson: string | null }; replyMetadataJson: string | null;
  body: { attachmentIds?: unknown; pictureRefs?: unknown; imageMarks?: unknown; activeDocumentArtifactId?: unknown; userIntent?: unknown } }):
  Promise<{ pendingSkill: PendingSkillSelection | null; forceWebSearch: boolean; attachmentIds: string[]; pictureRefs: unknown; imageMarks: unknown }>;
export function preflightStoredTurn(p: { userId: string; runtimeConfig: RuntimeConfig; conversationId: string; message: string;
  choices: Awaited<ReturnType<typeof resolveStoredTurnChoices>>;
  body: { activeDocumentArtifactId?: unknown; streamId?: unknown; model?: unknown; reasoningDepth?: unknown;
          personalityProfileId?: unknown; enabledConnectionCapabilities?: unknown } }):
  Promise<{ ok: true; turn: ChatTurnPreflight } | { ok: false; error: RetryPreparationError }>;
// ask-user.ts
export type AskAnswerResult =
  | { status: "answered"; answers: Array<{ question: string; picked?: string[]; ownWords?: string }>; note: string }
  | { status: "left_to_you"; answers: Array<{ question: string; recommended?: string[] }>; note: string }
  | { status: "closed"; note: string };
export function buildAskAnswerRecord(questions: readonly AskQuestion[], answer: AskAnswer):
  { result: AskAnswerResult; outputSummary: string; resultDigest: string };
// ask-capture.ts (the type lives here, not in ask-resume.ts, so the orchestrator, completion and finalize
// import it without importing the resume entry, which imports the orchestrator's types)
export function buildAskResumeContinuation(capture: AskResumeCapture, askToolCallId: string, result: AskAnswerResult): ModelMessage[];
export type AskResumeInput = { questionId: string; claim: string; askedMessageId: string; askToolCallId: string; userMessageId: string;
  continuation: ModelMessage[]; capturedResults: AskCapturedResult[]; userTexts: string[];
  priorSegmentToolCalls: ToolCallEntry[]; keepConnectorDataLocal: boolean;
  answerDigest: { outputSummary: string; resultDigest: string } };
// ask-resume.ts
export function prepareAskResumeTurn(p: { userId: string; runtimeConfig: RuntimeConfig; conversationId: string;
  claimed: AskQuestionRow; claim: string; body: Record<string, unknown> }):
  Promise<{ ok: true; value: { orchestratorInput: Pick<StreamOrchestratorOptions, "turn" | "upstreamMessage" | "isReconnect" | "pendingSkillInstructions" | "resume"> } }
        | { ok: false; error: RetryPreparationError }>;
export function findWaitingQuestionRefusal(p: { userId: string; conversationId: string }): Promise<ChatTurnRequestError | null>;
// stream-orchestrator.ts
StreamOrchestratorOptions.resume?: AskResumeInput;
// stream-completion.ts / finalize.ts
CompleteStreamTurnParams.askResume?: Pick<AskResumeInput, "questionId" | "claim" | "askedMessageId" | "askToolCallId"
  | "priorSegmentToolCalls" | "userTexts" | "answerDigest"> | null;
FinalizeChatTurnParams.ask?: { pause?: …; resume?: Pick<AskResumeInput, "questionId" | "claim" | "askedMessageId" | "askToolCallId" | "answerDigest"> };
```

The answer result's fixed English (Plan's call 19): `answered` note `The user answered. Go on with the same reply from where it paused; do not repeat what is already written.`; `left_to_you` note `The user left these choices to you: take your recommended option where you marked one, else your best judgment, and go on with the same reply.`; `closed` note `The user closed the question without answering. It may have been off. Go on with your best judgment or ask differently, and never ask the same thing again.` `outputSummary`: `The user picked: <labels joined by ", ">` (one question), `The user answered in their own words`, `The user left it to Alfy`, `The user closed the question`, and for several questions `The user answered <n> questions`. `resultDigest` is `deriveToolResultDigest(result)` (`tool-result-digest.ts`).

`prepareAskResumeTurn` (Plan's calls 15, 20, 23, 31): reads the asking row and walks `continuesMessageId` back to the reply's first segment; the user row right before it is the person's message (none: 409 `QUESTION_NOT_WAITING`, Ruling 14); `resolveStoredTurnChoices` with the first segment's metadata for the intent and the person's message for attachments and pictures; `preflightStoredTurn` with the body's choices; `turn.turnOrigin = "ask_resume"`; `askToolCallId = claimed.toolCallId`; with `record = buildAskAnswerRecord(questions, answer)`, `continuation = buildAskResumeContinuation(readAskCapture(claimed), claimed.toolCallId, record.result)` and `answerDigest = { outputSummary: record.outputSummary, resultDigest: record.resultDigest }`; `userTexts` = every own-words answer of the reply's questions so far, this one included; `priorSegmentToolCalls` = the tool calls stored on the reply's segments; `keepConnectorDataLocal = await hasLocalDistillEnabled(userId)`; `claim` (the won claim's token) goes into `AskResumeInput.claim` unchanged. No regeneration appendix.

Orchestrator with `resume`: the model run gets `continuationMessages: resume.continuation`, `historyBeforeMessageId: resume.userMessageId`, `skipWebPrefetch: true`, `gateMessagesForAttempt: gateCapturedConnectorResults({ results: resume.capturedResults, keepConnectorDataLocal: resume.keepConnectorDataLocal })`, `resumeProvenance: { userTexts: resume.userTexts, priorResults: capturedProvenanceResults({ v: 1, messages: resume.continuation, results: resume.capturedResults }) }`; no instant acknowledgment; completion gets `askResume`; `finally` calls `releaseAskQuestion({ userId, questionId: resume.questionId, claim: resume.claim })` (a no-op once the question settled, Ruling 6). A pause inside a resume captures with `continuationGiven = resume.continuation` and `priorResults = resume.capturedResults`.

Completion and finalize with `askResume`: `assistantMetadata.continuesMessageId = askedMessageId`; the citation gate's `toolCalls = [...priorSegmentToolCalls, ...toolCallRecords]` and `userMessage = [normalizedMessage, ...userTexts].join("\n")`; finalize, before the receipt, `settleAskQuestion({ userId, questionId, claim })` and `updateAssistantToolCallResult({ conversationId, messageId: askedMessageId, callId: askToolCallId, ...answerDigest })`; both best-effort and logged. A resume that asks again settles the answered question first and stamps the new one after it.

- [ ] **Step 1: Write the failing tests.**

```ts
// retry.test.ts: the existing tests stay green with the extraction (no new assertions).
// ask-user.test.ts
it("tells the model the picked labels, own words, a choice left to it, or the X, in fixed English", ...)
  // { status: "answered", answers: [{ question: "Which way should we take it?", picked: ["A party at home"] }], note: … }
  // left_to_alfy -> answers[0].recommended === ["A party at home"]; closed -> { status: "closed", note: … }
// ask-capture.test.ts
it("replaces the paused result with the answer and keeps every other result in full", ...)
// ask-resume.test.ts
it("resumes a claimed question on the person's message, without saving it again, as ask_resume", ...)
  // turn.normalizedMessage === the stored user text; turn.skipPersistUserMessage true; turn.turnOrigin "ask_resume"
it("ends the history before the person's message and skips the web prefetch", ...)
it("carries the reply's earlier tool calls, the captured results and the person's own words", ...)
it("asks for the person's local-only connector setting once", ...)
it("refuses with QUESTION_WAITING while a stamped question waits or answers", ...)   // { status: 409, code: "QUESTION_WAITING" }
// stream-orchestrator.test.ts
it("runs a resume with its continuation and no instant acknowledgment, and gives its question back when it ends unsaved", ...)
it("captures a second question asked inside a resume on top of the first answer", ...)
// stream-completion.test.ts
it("names the row a resume segment continues and lets it cite what the reply found earlier", ...)
  // a link to a source from priorSegmentToolCalls survives the citation repair
// finalize.test.ts
it("settles the question and writes the answer into the asking row's tool call before the receipt", ...)
// tests/integration/english-request-purity.test.ts (Review Focus 5)
it("sends an answered question to the resume only as data, in the same English scaffold for both UI languages", ...)
  // Hungarian labels and accented own words are AUTHORED fixtures; the request has no other letter above U+007F; en and hu worlds byte-identical
// tests/integration/reply-language.test.ts
it("writes no reply-language instruction into a resume request", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run src/lib/server/services/chat-turn/ src/lib/server/services/normal-chat-tools/ask-user.test.ts tests/integration/reply-language.test.ts tests/integration/english-request-purity.test.ts`. Expected: the new tests FAIL; the retry tests PASS before and after the extraction.

- [ ] **Step 3: Extract the two retry helpers first** and run `npx vitest run src/lib/server/services/chat-turn/retry.test.ts` (PASS); then implement the rest.

- [ ] **Step 4: Run the same command.** Expected: PASS.

- [ ] **Step 5: Commit** in two commits: the retry extraction alone ("Share the way a turn runs again on a stored message, before a second caller needs it"), then the resume ("Carry the same reply on from the person's answer, with everything it found before it asked").

---

### Task 9: The routes, the refusal and the sidebar flag

**Files:**
- Create: `src/routes/api/conversations/[id]/questions/+server.ts`; Test: `src/routes/api/conversations/[id]/questions/questions.test.ts`
- Create: `src/routes/api/conversations/[id]/questions/[questionId]/answer/+server.ts`; Test: `src/routes/api/conversations/[id]/questions/[questionId]/answer/answer.test.ts`
- Modify: `src/routes/api/chat/stream/+server.ts`, `src/routes/api/chat/send/+server.ts` (the refusal); Tests: `src/routes/api/chat/stream/stream.test.ts`, `src/routes/api/chat/send/send.test.ts`
- Modify: `src/lib/server/services/conversations.ts` (`ConversationListItem.waitingForAnswer?: true`; `listConversations`); Test: `src/lib/server/services/conversations.test.ts`
- Modify: `src/lib/server/services/chat-turn/index.ts` (exports: `listConversationAskQuestions`, `getAskQuestion`, `claimAskQuestion`, `releaseAskQuestion`, `prepareAskResumeTurn`, `findWaitingQuestionRefusal`)
- Modify: `src/routes/AGENTS.md` (the two rows in the Where to Look table)

**Interfaces:**
- Consumes: Tasks 2 and 8; `refuseTurnWhenOverCapacity`, `createStreamJsonErrorResponse`, `runChatStreamOrchestrator`, `getCurrentMemoryResetGeneration` (as the retry route uses them).
- Produces: the routes of Plan's call 16; `ConversationListItem.waitingForAnswer`.

The answer route, in order: auth; `refuseTurnWhenOverCapacity(user.id, "CHAT_ASK_ANSWER")`; JSON body (400 `INVALID_BODY`), with a `streamId` (400 `STREAM_ID_REQUIRED`: without one the orchestrator skips the arbiter, the registration and the sweep); `getAskQuestion` (none: 404; never a refusal on its raw `status`: an `answering` row a restart left must reach the claim); `checkAskAnswer(questions, body.answer)` (fails: 400 `{ error, code: "INVALID_ANSWER" }`); `claimAskQuestion` with the answer `checkAskAnswer` returned (`not_found` 404, `not_waiting` 409 `QUESTION_ALREADY_ANSWERED`); `prepareAskResumeTurn` with the claim's token (an error releases the claim with its token and answers like the retry route does); `runChatStreamOrchestrator({ user, ...orchestratorInput, downstreamAbortSignal, requestStartTime, startedResetGeneration })`, where a throw before it returns its stream releases the claim too (Plan's call 12: every path after a won claim ends in a release or a settle). The stream route calls `findWaitingQuestionRefusal` for a send that is neither a reconnect nor an edit's resend, after its capacity check; the send route calls it in both branches and answers `json({ error, code }, { status: 409 })`; the retry route calls it before it prepares (Ruling 12). Both routes map a preparation refusal through one `createPreparationErrorResponse` (chat-turn/stream.ts).

- [ ] **Step 1: Write the failing tests.**

```ts
// questions.test.ts
it("lists the chat's questions without what the resume needs", ...)        // body has no resume_json / capture
it("answers 404 for another person's chat", ...)
// answer.test.ts
it("answers the capacity refusal and claims nothing while the server drains", ...)   // 503, reason "draining"; claimAskQuestion not called
it("answers 400 INVALID_ANSWER for an answer that does not fit, and claims nothing", ...)
it("answers 409 QUESTION_ALREADY_ANSWERED to the second of two answers", ...)
it("gives the claim back when the resume cannot be prepared", ...)                     // releaseAskQuestion called
it("gives the claim back when the orchestrator throws before it streams", ...)         // releaseAskQuestion called; the answer is a 500
it("streams the resume of a good answer", ...)                                         // runChatStreamOrchestrator called with resume
// stream route
it("refuses a new message with 409 QUESTION_WAITING while a question waits, and lets a reconnect and an edit's resend through", ...)
// send route
it("refuses an Atlas kickoff and a plain send while a question waits", ...)
// conversations.test.ts
it("marks a chat whose question waits, and not once it is answered", ...)
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run 'src/routes/api/conversations/[id]/questions' src/routes/api/chat/ src/lib/server/services/conversations.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the routes as thin adapters, the refusals and the flag (one query: `listWaitingAskConversationIds` over the visible chats).

- [ ] **Step 4: Run Part 1's whole server suite and the static checks.** `npx vitest run src/lib/server src/lib/shared src/routes tests/integration` and `npm run check`, `npx biome check src scripts tests`, then the Fallow step alone: `scripts/gates.sh agent <scratchpad>/gates-ask-part-1 --skip check,biome,migrations,vitest,build,chunks,playwright`. Expected: PASS; check 0 errors and 0 warnings; Fallow no new findings, four cycles.

- [ ] **Step 5: Commit** in two commits: the routes and refusal ("Let the person answer from any device, and keep a waiting chat from taking a new message"), then the flag ("Tell the sidebar which chats are waiting for an answer").
