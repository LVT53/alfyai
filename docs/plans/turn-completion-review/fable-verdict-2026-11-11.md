# Independent adversarial review: Normal Chat completion and recovery

Reviewer: Claude Fable 5.2, 2026-11-11. Review only: no fixes, no deploys, no new model or browser runs, no database writes.

How it was done: I read the contracts, the engine and the saved evidence myself, and ran six slice reviewers in parallel (three Opus 5.5, three Sonnet 5.5) on isolated copies of the validated commit. Every reviewer finding listed here has a reproducer that I reran myself, or a code trace I checked. All six reports are in.

## Verdict: not ready for owner production approval

What held under attack: one engine decides completion for both transports; closing is one tools-off call per segment with no retry and no failover inside it; Stop and pause win over closing; reconnect cannot start a generation or rerun a tool; the saved row is adopted exactly; accounting failures no longer erase history. The typecheck is clean and gate 14's numbers are real.

What stands in the way:

1. **Every reply stores one event per streamed token** (2.16 MB of metadata for a 9.5 KB answer on staging), and every read returns it.
2. **An answer that opens with a JSON code block can be erased whole**, and the turn then ends "incomplete".
3. **Ordinary answers no longer stream.** They appear at once when the model stops. The contract accepted this; the owner ruled on 2026-11-11 that it is a regression and must be fixed.
4. **A file job that fails after submission ends the turn with an empty answer.** The model can no longer correct its program. The owner ruled the same day that this is a regression too.
5. **The closing phase, the actual fix for preamble-only turns, has never run against a real provider**: 0 of 223 recorded staging turns.
6. A set of smaller confirmed defects, three of which I would fix before production (section 7).

This verdict never authorizes deployment.

## 0. What was reviewed

| Item | Value |
|---|---|
| Worktree | `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`, branch `fix/turn-completion` |
| `git status --short --branch` | `## fix/turn-completion...origin/dev [ahead 118, behind 3]`, nothing changed or untracked |
| `git rev-parse HEAD` | `495282bf44cee258427e03fefdd618cccd3d3cad` |
| Validated revision | `29e51551f`; the two later commits touch 13 files, all under `docs/` |
| Staging | `current -> releases/29e51551f` (read-only check today) |
| Production | `40f2d74fc`, untouched |

Scope: the handoff's baseline `24823203b` is not what production runs. Production is 30 commits behind it, so a deploy also ships the earlier fast-route work: 72 non-test source files (+7,432/−3,477). The branch is 3 commits behind `origin/dev` (CI and test fixes).

## 1. Application defects

### 1.1 High: one saved event per streamed token, returned on every read

- **Where.** `normal-chat-model/completion.ts:292-300` keeps every emitted event; `:782-796` emits one `block_delta` per SDK delta, each with five IDs of 64 to 95 characters. `chat-turn/finalize.ts:583-595` saves the list unchanged as `normalChatOutput.events`. `services/messages.ts:432-437` returns it on every message (`:427` parses the same string twice). The browser replays it (`client/normal-chat-output-view.ts:27-37`).
- **Invariant.** Spec, "Persistence and telemetry": "versioned additive metadata for output blocks/completion". Blocks, not deltas.
- **Trigger.** Any reply.
- **Measured** with the real engine, schema and readers:

| Reply | Answer text | Saved metadata |
|---|---|---|
| 300 answer tokens | 1.5 KB | 162 KB |
| 1,200 reasoning + 1,957 answer tokens | 9.8 KB | 1.68 MB |
| 2,000 reasoning + 4,000 answer tokens | 20 KB | 3.19 MB |

  A conversation of 50 such replies (100 messages, the default window) stores 84.2 MB. `listMessageWindow` takes 160 ms instead of 3 ms; `listMessages`, which runs for every turn's prompt context (`chat-turn/context-selection.ts:1314`), 158 ms instead of 1 ms; the payload sent to the browser is 84.2 MB instead of 17 KB.
- **On staging (read-only, lengths only).** The Natural probe's reply: 9,540 characters of content, **2,157,813 bytes of metadata**. The 223 replies this feature wrote average 184 KB of metadata (largest 3.23 MB); the 869 older replies average 6.5 KB.
- **Impact.** About half a kilobyte of database per generated token; tens of megabytes per conversation open; synchronous parsing on the one Node thread; rows stay large until rewritten, so shipping first leaves a migration behind. The output-display reviewer found the same independently (5,009 events, 2.6 MB for a 15 KB answer).
- **Smallest fix.** Save one event per block plus the step, settlement and completion events (the reducer accepts a delta of any length); add a test that bounds metadata against answer length.

### 1.2 High: an answer that opens with a JSON code block is erased

- **Where.** `shared/normal-chat-output.ts:67` returns an empty string for the whole text when `startsWithToolCallMarkup` is true. That test (`services/stream-protocol.ts:1015-1040`) needs only a first line of ```` ``` ```` or ```` ```json ```` and two of 23 ordinary keys anywhere after it: `text`, `content`, `language`, `query`, `mode`, `filename`, `markdown`, `urls` and others (`:908-932`).
- **Invariant.** Spec: "No text-length, punctuation, language, or content heuristics determine commentary versus answer."
- **Trigger.** "Return this as JSON" where the reply starts with the fence, for example `{"language": "hu", "text": "..."}`. Prose after the block is lost too.
- **Impact.** The step is refused as an answer (`completion.ts:1226-1232`), a closing call is spent, its reply starts the same way, and the turn ends `incomplete` with no text. Production removed only the block and kept the rest.
- **Reproducers.** `tests/integration/zz-review-A-completion.test.ts`, "keeps a legitimate answer that opens with a JSON code block": two requests, `{"phase":"closing","outcome":"incomplete"}`, text `""`. Also `src/lib/shared/zz-review-D-sanitize.test.ts` (3 of 3 fail). Found by two reviewers independently.

### 1.3 High, narrow window: a generation can start after Stop

- **Where.** `client/normal-chat-client-turn-runtime.ts:2704-2712`: after a capacity refusal the runtime schedules `startStream` again in 0.5 to 2 s. The timer checks no turn epoch, and `startStream` checks only that the page is attached.
- **Invariant.** Stop contract: "never set sending/active true again ... start a generation"; "Every scheduled action ... checks captured epoch".
- **Trigger.** A send is refused for capacity (the per-user limit is one stream, so a turn still finishing elsewhere is enough), the person presses Stop during the backoff, the timer fires.
- **Impact.** The message is sent and answered after Stop reported success; the new stream writes into the bubble marked stopped while the composer shows idle. In production Stop simply did nothing in this window.
- **Reproducer.** `src/lib/client/zz-review-C-capacity.test.ts`: `fresh POSTs after Stop: 2`.

### 1.4 Medium: defects with reproducers

| # | Defect | Where | Trigger and impact | Reproducer |
|---|---|---|---|---|
| a | Replay is lost after about 300 streamed tokens, and the browser gives up after 120 s | `chat-turn/stream-replay-journal.ts:8-16` (200,000 wire bytes); `stream-reconnect.ts:163-168`; runtime `:2394-2437` (60 tries, 2 s apart) | Reload or a dropped connection in any longer turn: no live progress afterwards, and "status unavailable" if the turn runs 120 s more, while the server still saves the reply. One real Kimi turn was 2.49 MB on the wire, 12 times the bound. Production keeps 100,000 characters. | `zz-review-main-journal-overflow` (overflow at token 297 to 336) |
| b | A finished turn of an incognito chat cannot be observed | `completion-lifetime.ts:72-86`; no ledger row for incognito (`turn-ledger.ts:250`) | Stop or reconnect in an incognito chat once replay is gone: "status unavailable" although the reply was saved. No test covers it. | `zz-review-main-incognito-observation` |
| c | An answered turn whose reply could not be saved is observed as a clean success | `completion-lifetime.ts:113-150`, `:237-264`; runtime `:2083-2085`, `:2166-2171` | Save fails while a client is observing: no error shown, and the queued follow-up is sent into a chat that lacks the answer. | `zz-review-B-unsaved-answer-observation`, `zz-review-B-unsaved-answer-client` |
| d | A turn can stay "sending" for ever | runtime `onEnd`, `:2462-2467` | An observation for another stream or chat, or a pending one delivered as an end, returns without ending the turn. After 10 minutes: still sending, no error, queued message not restored. How often the server produces this is not established. | `zz-review-C-scope` (3 cases) |
| e | An unresolved Stop silently blocks `/new` and every Regenerate | runtime `:3788`, `:3813`; `MessageInput.svelte:3191-3192` | After a Stop whose observation ended unavailable (see a and b), the typed `/new` and Regenerate on any row do nothing, with no message, until a new send, a chat switch or a reload. The header and sidebar New chat buttons bypass the guard. | `zz-review-C-retained` |
| f | Tool-call JSON repair is gone on this path | `completion.ts:934-970` has no `experimental_repairToolCall`; the old paths keep it (`normal-chat-model/index.ts:1515`, `:1954`) | A call with slightly broken JSON arguments used to be repaired and run; now it does not run. Matters most for the local model. | "keeps the production tool-call JSON repair" |
| g | Failover after partial output sends the first provider's partial text and reasoning to the second | `completion.ts:358-364`, `:1207-1225` | A stream dies after some output and before any tool ran: the fallback request ends with the failed attempt's partial assistant message. Production did not fail over once anything had been emitted. | first test in `zz-review-A-completion` |
| h | Closing can fail without a network call | `completion.ts:662-693`, `:1091-1107` | A step is lost after an invalid or unoffered tool call: the closing request holds a tool call with no result, the SDK refuses it, and the one closing allowance is spent. Outcome `failed`. | "never sends closing an assistant tool call without its tool result" |
| i | Tool markup after a visible sentence is saved as an answer | `stream-protocol.ts:1037` checks only the start | "Let me search." followed by DeepSeek call markup ends `answered`, in the working phase and in closing. Spec step 6: "raw tool markup ... never answered". | two "does not promote raw DSML" cases |
| j | A connection error before any output now produces an answer without tools | `completion.ts:1207-1225`, `:1281-1287`; `stream-fallback.ts` was deleted | The first request fails and no fallback model is set: production reran the turn with its tools; now the one closing call answers with tools removed and the turn is `answered`, with no error and no Retry. A research turn can silently become a reply from memory. | `zz-review-F-transient` (probe: both transports end `answered`, no tools in request 2) |

### 1.5 Lower severity, all reproduced unless marked

| Defect | Where |
|---|---|
| A stopped turn that called `produce_file` and then fails to save ends as a quiet stop with no error (production reported the error) | `chat-turn/stream-completion.ts:968-972` |
| A turn whose file was delivered is reported `failed` when only the caption step and the closing fail, which invites a Retry and a duplicate file | `completion.ts:1254-1262`, `:1278` |
| A resumed segment's usage event counts the paused segment's tokens again (cost is not doubled; token analytics are) | `completion.ts:1303`, `:1325-1350` |
| A pending-observation Stop drops the reader receipt of the re-read it aborts | runtime `:2424-2435`, `:3669` |
| A command's no-op `stop()` bumps the epoch and abandons a normal observation, leaving the turn in "finalizing" (UI trigger not confirmed) | runtime `:3742`, `:4082` |
| A successful Stop settlement clears an error it did not set | runtime `:2129` |
| Canonical adoption can show a saved reply twice after a reload race | `chat/[conversationId]/_helpers.ts:1182-1195` |
| A malformed terminal observation without a marker is treated as a clean end and the queue is sent | `services/streaming.ts:386` |
| Copy, Open as document and the document title use the status label as content; the label is English only | `shared/reply-text.ts:66`, `:86-92` |
| Disclosed activity shows inline `<think>` text raw | `ThinkingBlock.svelte:717-742` |
| Replies made only of invisible characters other than U+200B are promoted to answers | `stream-protocol.ts:591` |
| The page shows $0 when the server omits a total it could not read | `chat/[conversationId]/+page.ts:126-127` |
| A failed accounting lookup leaves no log line, and the model icon disappears with it | `analytics.ts:3077-3080`; `messages.ts:338-356` |
| The wire carries about 600 bytes per token and reasoning twice (one 30 s turn: 2.49 MB) | `stream-orchestrator.ts:967-971` |
| A later prompt receives an interrupted partial as a complete assistant turn (trace only) | `chat-turn/context-selection.ts:199-216` |
| The 150 s idle timer and the 300 s outer watchdog are gone. A provider stream that stalls is cut only at the working deadline (240 s by default; probe `zz-review-F-hung-stream`), and no test fails when that timer never fires. Preparation and finalization have no overall bound (no concrete hang found). `onToolActivity` is left with no producer, and `images/AGENTS.md:39` still describes the old timer. | deleted `stream-idle-timeout.ts`; `completion.ts:714-721`; `stream-orchestrator.ts:997-999` |

## 2. Regressions the contract accepted (owner ruling, 2026-11-11: fix both)

Both behaviors follow the written contract. The owner has ruled that both are regressions against production and must be fixed before approval. The documents that accepted them have to change with the code.

### 2.1 High: ordinary answers appear only when the model stops

- **Where.** In the working phase the engine yields no answer text until the step has ended cleanly, then one `text_delta` with the whole answer (`completion.ts:1010-1013`, `:1226-1243`; measured: one per reply). The browser shows provisional text nowhere while a turn is live (`ThinkingBlock.svelte:1232-1235`).
- **Evidence.** The controller's probe (`.superpowers/sdd/implementation-plan/progress.md:203`): first text at 8.2 s, answer shown at 25.3 s. Natural probe: 1,957 answer deltas over 30 s, none displayed until the end.
- **Who accepted it.** `spec-review.md:5`: "Delayed ordinary answer placement ... explicitly accepted", by the spec judge. The recorded owner report is "prose shown in thinking before final answer; preserve old thought-step UI". Hiding the prose removed that symptom and did not bring live streaming back.
- **Why it happened.** No rule on words may tell commentary from answer, and a step's text is known to be the answer only once the step ends without a tool call. The contract chose to show nothing until then.
- **Required fix.**
  - The text of the step being generated streams into the answer area as it arrives, as in production.
  - If that step then calls a tool, its text is working commentary: it leaves the answer area at that moment and never reaches the saved answer, Copy, export, reload or a later prompt. The owner confirmed this on 2026-11-11: the text is withdrawn, not kept on screen as a separate working line.
  - Only the step's structure decides this (a tool call, or a clean stop), never its words, length or punctuation.
  - The thinking block shows no answer text, and the thought-step UI stays as it is in production.
  - No extra model call and no change to how completion is decided.
- **Size of the change.** The provisional deltas already reach the browser live, so this is a display change. `spec.md`, `thinking-display-amendment.md`, the 2026-11-11 amendments of ADR-0026 and ADR-0056, and `src/lib/components/chat/AGENTS.md` accepted the delay and have to be amended; the browser tests that assert hidden live prose change with them.

### 2.2 High: a file job that fails after submission ends the turn

- **Where.** `chat-turn/prepared-normal-chat-turn.ts:316-328` counts a tool result as succeeded only when its row is `done`; `normal-chat-tools/produce-file.ts:3100` records a failed job as `failed`; the engine treats that as uncertain and ends the turn without closing (`completion.ts:328-334`, `:1202-1205`).
- **Proof.** The project's own test asserts it (`normal-chat-tools/produce-file-patch-mode.test.ts:1482-1489`: one generation, `incomplete`, `uncertain_execution`, no closing). Staging has one such turn (2026-11-10 22:29:54): `produce_file` failed, the answer is empty. A reviewer's reproducer with the real tool shows one generation where three were expected.
- **Why it matters.** The tool returns `retryable` and allows two submissions per turn so the model can correct its program; production does that. Staging's file jobs fail 11 times in 160.
- **Document conflict.** Spec: "After completed or uncertain execution, automatic recovery/failover is tools-disabled continuation only." ADR-0026's amendment: "uncertain execution do not authorize closing." A job the ledger reports as failed is a known outcome.
- **Required fix.**
  - A tool result with a known outcome is not uncertain. When `produce_file` returns its failure, the model receives it and the working phase continues, within the tool's own limit of two submissions per turn.
  - Effects that are really unknown stay uncertain: a throw, an abort, a timeout, a call still in flight.
  - The existing test at `produce-file-patch-mode.test.ts:1482-1489` asserts the old behavior and is replaced, not kept. `zz-review-A-prepared` states the new expectation: three generations, two submissions, an answer.
  - `produce-file-refusal-certainty.md`, the spec and ADR-0026 are brought into agreement, including on closing after an execution that is really uncertain.

## 3. Unsupported claims and evidence gaps

| Claim | What I found |
|---|---|
| Real-model matrix covers closing (spec, required evidence) | Every staging audit shows `phase = working`, `closing_attempted = 0`. The staging ledger holds 223 turns: 195 answered, 14 stopped, 13 paused, 1 incomplete, **0 with a closing attempt**. The old tools-off recovery on these providers returned 3 empty replies, 3 lone zero-width characters, 2 blocks of tool markup, 1 `\begin{}` and 3 real answers out of 12 (`recovery-reply-samples.json`). |
| Attempt audit records outcome and stop cause (spec; ADR-0047 amendment) | Never written: `completion-lifetime.ts:196-206`, `:225-233`. All 223 staging attempt rows are NULL in both columns. A failed attempt cannot be told from a good one. |
| "The same 21 historical replies" | They are this feature's own output from `8fed848dd`; the report says "No legacy preservation claim". Evidence for production-format replies on staging is one message's cost. |
| Wide matrix: the Qwen failure is only formatting | The saved record also carries `contract: contract-or-transport-failure` and no answer text, so the file cannot settle it. I did not read the conversation. |
| "Failover after completed work also continues it" (spec) | Not implemented: failover is blocked after any tool occurrence (`completion.ts:1210`), and closing stays on the provider that just failed. |
| Destination-specific prefetch form on each attempt (spec) | Chosen once for the selected provider (`shared-normal-chat-model-run-helpers.ts:483-485`); not redone per destination. Trace only. |
| Model history uses the same labeled answer ownership (spec) | History takes `content` only, with no completion state. |
| "It cannot become zero" (ADR-0022 amendment) | True on the server; the page turns the omission into 0. |
| "One canonical output reducer ... not parallel flattened text" (architecture alignment) | Saved `content` is built from the legacy text channel (`stream-orchestrator.ts:1071-1075`), not from the reducer. They agree on simple shapes. |
| No caller-managed cleanup ladder (alignment row 04) | `finish()` must be called on four paths (`prepared-normal-chat-turn.ts:461`, `:474`, `:481`; `stream-orchestrator.ts:1280`); a missed call leaves observers at "pending" until restart. |
| README | Still says of the ledger: "lifecycle integration is a separate implementation slice." |

The three watchdog reports (Stop v8, Natural v10, the read-only addendum) are FAILED and should stay recorded as failed. The Natural probe's `ERR_ABORTED` remains unexplained; my reading agrees that the app has no abort on the success path (`services/streaming.ts:1324-1329`; runtime `:4141-4150`; `stream-completion.ts:963-965`).

## 4. Model-quality limits (not defects of this change)

- Qwen's Hungarian case answered 391 without the requested `PRODUCT=391` line.
- A model that writes "Let me check." and stops without a tool call is `answered`. The contract accepts this.
- What DeepSeek, Kimi and Qwen write in a closing call is unknown (section 3, first row).

## 5. What held, by question

| Question | Result |
|---|---|
| 1. One bounded policy, one closing | Held: no re-preparation, one closing per segment, no tools in closing, Stop and pause first; a sweep of 46 timings found no fallback beside a running tool. Exceptions: 1.4 h and i. |
| 2. Effective model, failover, reasoning, attempt facts | Fresh tool pack per effective model; reasoning passed back, nothing fabricated; usage summed once, unknown stays null. Exceptions: 1.4 f and g; attempt facts always null. |
| 3. Identities and roles | The original `Let me check.## Result` defect is fixed across steps and attempts; replay is idempotent; activity reaches neither Copy, export nor history. Exception: 1.2. |
| 4. Display | No ordinary prose while live, collapsed or expanded; disclosure follows turn, segment and outcome; canonical re-adoption keeps it. Exception: inline `<think>` (1.5). |
| 5. Reconnect | An observe intent never registers a stream; a reused identity is refused before any preparation; scoping by user and conversation holds. Replay is truthful but short (1.4 a). |
| 6. Durable completion | File linkage is awaited before the receipt on both transports; only exact job IDs are trusted; the migration is additive and survives a rollback to `40f2d74fc`. Exceptions: 1.4 c and the quiet stop (1.5). |
| 7. Canonical recovery | Exact row by ID and role, absent fields cleared, render key kept, Stop always needs saved structural completion, permits rechecked after awaits. Exceptions: 1.3, 1.4 d and e. |
| 8. Accounting | Held under 14 deliberate mutations: no accounting join in the core query, privacy failure rejects, incognito resolved first, all-or-nothing batches, strict endpoints unchanged. Exception: the page's $0. |
| 9. Module shape | Next section. |

## 6. Tests, gates and module shape

**Verified by me.** `npm run check` on a clean export of `29e51551f`: 9,098 files, 0 errors, 0 warnings. Gate 14's `summary.txt`: ran at `29e51551f`, every step exit 0, 25,914 unit and 1,590 browser tests passed, 3 and 75 skipped, 0 failed, 0 flaky; one unrelated quarantined test. Resting on saved evidence only: the two matrices, the reply hashes, the three watchdogs.

**Gate 13's corrected query-count test** is not a loosened oracle. A reviewer ran it against 11 deliberate regressions: it caught 7 (a per-message loop, a second history scan, a missing LIMIT, an accounting join in the core query, enrichment of user rows or of the whole conversation); the fault-injection integration tests caught the other 4.

**Test-oracle defects.**

- `completion-lifetime-durable.test.ts:566` asserts "answered with no saved row" as a correct terminal (1.4 c).
- `stream-completion.test.ts:2542` accepts the quiet stop (1.5).
- `stream-protocol.test.ts:1056-1073` pins the fence as markup and never tests a block followed by prose (1.2).
- No test observes an incognito turn (1.4 b).
- The 500-ID batch bound and the ID de-duplication are unpinned: changing 500 to 503 or dropping the de-duplication passes all 132 slice tests.
- Guards that no test protects (each was removed in a copy and 3,138 focused tests still passed): the working-deadline timer, the first-output timer, the check that blocks a tool while another execution is unsettled, the blanking of leading tool markup, the reconnect heartbeat and prelude.
- The staging verifier: its tests leave 7 of 16 audit guards unprotected (missing audit rows, unscoped attempts, `accounting_status` ready, durable outcome equals receipt, duplicate terminal segment, known attempt tokens, rows outside the generated IDs). The committed verifier has all 16, so today's "audit PASS" is not empty. `--inspect` does not know what a complete matrix is; "30 of 30" is read by a person.
- The browser contract spec: the three failing-closing cases accept any of five words with `.first()`, so they cannot tell failed from incomplete; "another observer after completion cannot start tools again" never sends an observe request (the unit tests do cover it); hidden live prose is checked at one instant; the two reduced-motion variants assert nothing that differs.
- The fake models went from an 8,192 to a 131,072-token context in five places. No browser test now runs a small-context model, and the documents say 8k catalogues are not certified.

**Gate 14 from its raw files (reviewer, and `summary.txt` by me).** All counts confirmed. Retries are 0 and every test has one result. The 75 skipped browser tests are screenshot and recording helpers; the 3 skipped unit tests are gated on a model file, Docker and a benchmark flag; none touches this feature. Two limits: the gate does not record whether the tree was clean, and its build step counts only two kinds of warning, so "zero warnings" rests on a manual scan of `build.log` (which found none).

**Behaviors that no longer exist** (their tests were deleted with them): the idle watchdog, the tools-on rerun after a transport error (1.4 j), the `recovery` metadata (now always "none"), the tool-activity touch, cleanup of a stale orphan buffer. `stream-orchestrator.ts` keeps three dead variables from them (`recovery`, `_latestUpstreamAttempt`, `_attemptedNonStreamFallback`).

**Focused suites rerun by a reviewer on the export:** completion SDK and integration 55 passed; prepared turn, durable lifetime and ledger 75; the three accounting fault-injection files 28; client runtime 362; a 106-file slice baseline 3,138. No failures.

**Module shape.**

- `completion.ts` earns its interface: without it the attempt loop, closing allowance, failover rule and execution ledger return to two transports, and four modules were deleted when it arrived. Its cost is one 1,100-line closure with about thirty mutable variables.
- The per-message usage policy in `analytics.ts`, `turn-ledger.ts` and the client's `settleStoppedAction` (it replaced a 20 ms polling loop in the page) also pass the deletion test.
- What earns nothing: `authorizeExecution` (an execution ID embeds the new attempt ID, so the answer is always "new" and the reuse branch cannot run); `runPlainNormalChatSendModel`, `runStreamingNormalChatSendModel` and the 9-line `normal-chat-failover.ts`; the ten dependencies injected into `doReconnect`, always the same registry functions; `allocateTurnIdentity` and `observeTurn`, used only by tests.
- What still leaks to callers: the four `finish()` call sites; the prepared turn deciding success by looking up rows by call ID and name (2.2 comes from there); `settleStoppedAction` calling `stop()` itself (a cause in 1.5).

**ADRs.** 0015, 0041, 0056 and 0060 match the code as far as attacked, with the exceptions above (0015 against 1.4 c; 0060 against 1.3 and 1.4 e). 0026 is accurate, including the delayed answer, and contradicts the spec on closing after uncertain execution (2.2). 0025 states the replay bound and not its reach (1.4 a). 0047 overstates the attempt audit. 0022 holds on the server and not on the page.

## 7. Minimum before the owner is asked to approve

1. Stop saving and serving per-token events (1.1).
2. Stop erasing answers that open with a JSON block (1.2).
3. Fence the capacity-backoff timer by turn epoch (1.3).
4. Restore tool-call repair on the completion path (1.4 f).
5. Make "answered, nothing saved" a failure for observers (1.4 c).
6. Bring live answer streaming back (2.1; owner ruling).
7. Let the model see a failed file job and continue (2.2; owner ruling).
8. One real-provider proof of closing. Proposed, not run: staging, DeepSeek Flash only, one synthetic conversation per case, at most two model calls each, read-only audit afterwards. Case A: a working step budget of one with a prompt that needs one tool call. Case B: a small working output cap so the step ends on `length`. Expected: one closing attempt with no tools in the request, `closing_attempted = 1`, the answer streamed from closing, no second tool run, two priced attempts. Needs the owner's authorization and a staging-only way to set the budget.

Next in line, not blocking on their own: 1.4 a, b, d, e, g, h, i and j, then 1.5 and the unprotected guards in section 6.

## Appendix: reproducers

`docs/plans/turn-completion-review/reproducers/` holds 33 files saved as `.txt` so no tool picks them up. Most fail on `29e51551f` and show a defect; the `zz-review-main-persisted-events-size`, `-read-cost`, `-journal-overflow`, `zz-review-E-*` and `zz-review-F-*` files pass and print or assert the measured behavior. A `~` in a name stands for `/` in the path the file belongs at. To run one: export `29e51551f`, copy the file to that path without `.txt`, and run `npx vitest run <path>` on Node 22. Files named `zz-review-main-*` go to `tests/integration/`, except `zz-review-main-incognito-observation`, which goes to `src/lib/server/services/chat-turn/`.

Staging reads used `?mode=ro` with `query_only`, and returned lengths, counts, tool names and statuses only: no message content, reasoning or credentials.
