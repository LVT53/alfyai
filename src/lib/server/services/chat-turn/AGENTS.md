# Chat-Turn Pipeline

## OVERVIEW

Request parsing through post-turn persistence for chat send/stream endpoints. All turn logic lives here; routes stay thin.

## STRUCTURE

```
request.ts → preflight.ts → [send route | stream-orchestrator.ts] → finalize.ts
                              │                  │
                              └────────┬─────────┘
                                       ▼
normalizer.ts

normal-chat-context.ts → context-selection.ts (constructed prompt context)
stream-orchestrator.ts → active-streams.ts (lifecycle/buffer)
stream-orchestrator.ts → stream-completion.ts (terminal event + persistence)
stream-orchestrator.ts → stream-reconnect.ts (buffer replay + live subscription)
stream-orchestrator.ts → stream.ts (AI SDK UI stream runtime helpers)
stream.ts / stream-reconnect.ts / browser transport → $lib/services/ai-sdk-ui-stream-contract.ts
failures → retry-cleanup.ts
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Parse body, model, attachments | `request.ts` |
| Validate conversation, check attachment readiness | `preflight.ts` |
| Build constructed prompt context for Normal Chat | `context-selection.ts` |
| Assistant output normalization | `normalizer.ts` |
| Stream lifecycle orchestration, neutral model-run event adaptation, active-stream registration | `stream-orchestrator.ts` |
| AI SDK UI stream runtime helpers, thinking cleanup | `stream.ts`, `thinking-normalizer.ts` |
| AI SDK UI stream frame grammar, terminal detection, metadata extraction | `src/lib/services/ai-sdk-ui-stream-contract.ts` |
| Stream terminal persistence and `data-stream-metadata` / `finish` payloads | `stream-completion.ts` |
| Reconnect replay and live stream subscription | `stream-reconnect.ts` |
| Post-turn persistence fan-out orchestration (one ordered sequence) | `finalize.ts` |
| Post-turn side-effect steps (turn-state, evidence, attachments, memory tasks) | `finalize-steps.ts` |
| The language the person writes in, named after the reply, for what follows it (chips, rail headline, title, the message's `conversationLanguage` and `replyLanguage`, the `[LANGUAGE]` line and its counters) | `reply-language.ts` (asks `conversation-language.ts`, one small control-model call; falls back to `../language.ts`'s `afterReplyLanguage`; nothing decides a reply's language before the reply) |
| Stream lifecycle, explicit stop handling | `active-streams.ts` |
| Idempotent cleanup on turn failure | `retry-cleanup.ts` |
| Shared types | `types.ts` |
| Interim Thought Step / Thought Step Anchor read model (ADR-0056, P3a) — dormant until P3b emits steps | `thought-steps.ts` |

## CONVENTIONS

- `context-selection.ts` owns constructed prompt-context assembly for Normal Chat, including memory/session/task/document candidate selection and budgeting. Keep prompt-context ranking here, not in routes.
- Context-window target and compaction defaults come from `src/lib/model-context-defaults.ts`, while provider-specific prompt-limit projection comes from `provider-model-runtime-defaults.ts`. Do not duplicate provider context ratio math in chat-turn helpers.
- `stream-orchestrator.ts` owns the live streaming lifecycle: active-stream registration, upstream model-run invocation, neutral event adaptation, model-preserving non-stream transport recovery, phase timing, heartbeat/prelude scheduling, and delegation to completion/reconnect helpers. Provider-attempt policy, timeout failover, and rate-limit fallback belong in `normal-chat-model/`.
- `stream.ts` and its submodules own AI SDK UI stream runtime helpers, neutral event cleanup, thinking tags, and structured tool-call markers. Shared AI SDK UI stream frame encoding/complete-block decoding, terminal detection, and metadata extraction belong in `src/lib/services/ai-sdk-ui-stream-contract.ts`, not in routes or browser-local parsers.
- `stream-completion.ts` owns terminal stream completion: final persistence through `finalize.ts`, generated-file assignment, and the `data-stream-metadata` / `finish` payload shape.
- `stream-reconnect.ts` owns reconnect replay from `active-streams.ts` buffers and live subscription until terminal AI SDK UI stream completion (`finish` / `[DONE]`) or failed stream closure. A reconnect never outlives its stream's record: the listener hangs on the buffer, so a terminal frame is always emitted BEFORE the buffer is cleared (`stream-terminal.ts`'s `failStream`, the completion path), and a connection whose buffer has gone without a terminal event ends itself with `data-waiting` (the client then reads the saved turn). Clearing first left a reload-then-failure reconnect open on heartbeats for ever (FB-8, FG's finding 1).
- `active-streams.ts` owns active stream and replay-buffer ownership. Status, buffer, stop, reconnect, stream completion, and context-compression callers must pass authenticated `userId` plus conversation context when reading active stream or replay-buffer state.
- `finalize.ts` is the single fan-out point after any turn (stream or non-stream). `finalizeChatTurn` runs ONE ordered post-turn sequence — skill-control ops → assistant turn-state → evidence → generated-output reconciliation, then `runPostTurnTasks` as the deferred tail. The send path runs it eagerly and returns the durable result; the stream path passes `deferPostTurnProjection: true` to get its terminal receipt first and run the same sequence in the background via `createPostTurnTask`. There is no second copy of the sequence: add a new post-turn side effect in exactly one place here (or as a step in `finalize-steps.ts`), not in route files and not behind a `deferPostTurnProjection` fork.
- The post-turn step functions (`persistAssistantTurnState`, `persistAssistantEvidence`, `persistUserTurnAttachments`, `runPostTurnTasks`) live in `finalize-steps.ts` as the mockable module seam. `finalizeChatTurn` calls them directly — they are not injectable through the public params. Tests seam by mocking `finalize-steps.ts`, not by passing function overrides.
- `normalizer.ts` normalizes assistant text through the same stream-protocol helpers so `/send`, `/stream`, retry, and title generation return the same visible content shape.
- `retry-cleanup.ts` runs idempotent cleanup for evidence links, checkpoints, work capsules, generated outputs, and the assistant message itself on failure.
- Routes import from this pipeline; they do not duplicate turn logic.

## ANTI-PATTERNS

- Do not duplicate AI SDK UI stream framing, terminal detection, tool-call handling, or thinking extraction between `stream-orchestrator.ts`, `stream.ts`, browser transport, reconnect, and route files.
- Do not put terminal stream payload changes in the route or orchestrator without updating `stream-completion.ts` and its focused tests.
- Do not rebuild prompt-context selection in routes or tests; call `context-selection.ts` through the Normal Chat context boundary and keep its budget/trace contract coherent.
- Do not add post-turn persistence directly in `/api/chat/send` or `/api/chat/stream`; route through `finalize.ts`.
- Do not collapse user-requested stop and passive disconnect into one generic abort. Use `active-streams.ts` for explicit stops; let navigation/unmount detach locally without marking the turn stopped.
- Do not read active stream or replay-buffer state by `streamId` or `conversationId` alone; owner context is part of the registry contract.
- Do not inline new persistence side effects inside `stream.ts` closures that only one endpoint can see.

## Reply Language, Short Texts And Follow-Up Chips

- **The model chooses the reply language, under one rule; nothing guesses it** (owner decision, 2026-10-13: "English language users should NEVER be affected"). No code reads a message, a history or an account and decides the language of a Normal Chat reply before the reply: the word-list detectors, the per-turn resolver and everything that carried its answer (the routes, the stream orchestrator, `prepareOutboundContext`, `createToolPack`, completion, finalize) are gone, and `tests/integration/reply-language.test.ts` fails on their names if one comes back. Every turn's guidance (`buildTurnGuidance`, after the current user message: the placement that was measured) carries `REPLY_LANGUAGE_RULE`, defined once in `normal-chat-context.ts`: reply in the language of the person's latest message, judged by its own words; in the language they have been writing in when the message has none of its own (a short "ok", a number, a link, code); in the one they ask for, in the message or in their standing instructions (Your Instructions, Project Instructions); a requested piece of writing in another language is written in it and the model's own words stay in theirs; and nothing else sets it (who they are, remembered facts even one about the language they use, documents, files, tool or search results, its own earlier replies). The Baseline Memory Profile section opens with one line saying its facts never set the reply language, and the memory judge records no fact about the language a person speaks. Change the rule's words only against a real-model run (the measured failures were a Hungarian memory pulling English prompts to Hungarian and a Hungarian display name). Five invariants, each held by a test:
  - **I1 nothing guesses**: the language text in any turn's guidance is `REPLY_LANGUAGE_RULE`, byte for byte, whatever the message or the account, and nothing else the app writes into the chat request tells the model a reply language: every sentence of the request (the base prompt, the instructions framing, the memory, the skills, the tool catalogue, the guidance), with what the person and the model wrote blanked, is scanned for a reply-language instruction and for the names of the two languages, and only the rule's five lines and the memory section's note pass (`tests/integration/reply-language.test.ts`).
  - **I2 the UI language reaches no model request but the status line's** (and the nightly persona summary, a screen and not a turn): the same data with `uiLanguage` "en" and "hu" produces byte-identical requests for the chat call, the language call, and every call after the reply (chips, rail headline, title), after blanking ids and times (`tests/integration/english-request-purity.test.ts`; the chat call is also driven through the stream orchestrator, where the UI language lives in a turn: `tests/integration/ui-language-stream.test.ts`). A thought-step status line is written while Alfy thinks, before any reply text exists, so it follows the account's UI language (`createThoughtStepClassifierSession`'s `targetLanguage`); the Atlas kickoff message and its errors are chrome and follow it too. One exception after a reply is by design: when the language call (I4) fails AND the reply says nothing by itself AND nothing was recorded on the conversation, the account's UI language names the language of the chips, the rail headline and the title (`tests/integration/reply-language.test.ts`).
  - **I3 one English scaffold**: everything the app writes into a model request is English and holds no Hungarian text, example or name: the tool catalogue (`TOOL_TEXT`, one snapshot, `tool-catalogue.en.snapshot.txt`, one token ceiling), the skill catalogue (system packs under their English names), the artifact tools' prose, the App contract and the generator's closing line, the memory judge's examples, `edit_artifact`'s `summary` field ("in the conversation's language", no example in a language). The purity test scans every request of every model call, for an account shown in each language, for a letter above U+007F, for a dozen words only Hungarian has spelt without accents, and for the language named (the language call is the one request that names the two it chooses between), and holds the source in `src/lib/server`, `src/lib/shared` and `src/routes`: a Hungarian letter in code needs a line in `HUNGARIAN_BY_DESIGN` with its reason, a new file that calls a model (under any import alias) needs one in `MODEL_CALLERS`.
  - **I4 after the reply, texts are in the language the person writes in, which the model names**: the follow-up chips, the rail headline and a generated title are written in the language the person WRITES in (a chip is sent verbatim as their next message; a title sits in their sidebar). That is not always the language of the reply: a requested email in another language, a translation, a pasted text and an explicit "answer in …" change what the reply is written in without changing who is writing, and an explicit request for the replies in a language does not flip the chips, the headline or the title either (the real-model check of the call showed the model ignoring a clause that said otherwise, in both directions, so the question has none: a person who asks for Hungarian replies and writes English gets English chips). A reader of the reply's words cannot tell these apart without reading the request, which no code does (the deterministic chain reads 15 of the 23 turns in `chat-turn/language-probes.test-helpers.ts`, review RV-L's rows and both directions of an explicit request, wrong, both ways: an English writer who asked for a Hungarian email got Hungarian chips). So ONE small control-model call after the reply names it: `chat-turn/conversation-language.ts` (`readConversationLanguage`) is asked "which language is this conversation in for the person: the language they write in?" (ignoring any piece of writing they asked for and any text they pasted), is shown the person's latest message (1,500 characters, start and end), the one before it (300) and the start of the reply (400), and answers `en` or `hu` (a machine-read verdict at temperature 0, listed in `sampling.test.ts`, cut short after 4 s). `chat-turn/reply-language.ts` (`resolveTurnReplyLanguage`) is the one place a turn asks, once, for the chips, the rail headline and the record on the message (`conversationLanguage`); `generateTitle` takes the recorded value (the title route reads it), and the person's `titleLanguage` ("en"/"hu") still wins for titles. If the call fails, is cut short or answers anything else, the deterministic chain decides (`language.ts`'s `afterReplyLanguage`: the person's message when the reader can name it and the reply says nothing or holds at least two of its words, else the reply's own words, else the language recorded on the conversation's previous reply, else the account's UI language); it is a fallback, and it cannot tell a requested piece from the person's own, which is why the model is asked first. The reader (`readReplyLanguage`: closed-class word lists that leave out every English/Hungarian homograph (`language.test.ts` takes each such word alone), code, URLs, addresses and quotes stripped, at least 4 witnesses and a 3:1 lead, else "unknown"; model-written text only; it reads the first 100 000 characters and no pattern in it may backtrack over a long run, because it runs on the server's one thread over every reply, a blob included, and the same test holds its cost on hostile input) serves the chain, the log and the record; a title, a headline or a status line is `readShortTextLanguage`'s (below). Do not add a second reader or a word list beside them, and take any new word from real model output, in a test, in both directions (`language.test.ts`; the review's probe table, both ways, with the call faked, is `chat-turn/language-probes.test-helpers.ts`, used by `chat-turn/reply-language.test.ts` and `tests/integration/reply-language.test.ts`).
  - **I5 observability**: one content-free line per turn, `[LANGUAGE] ui=<en|hu> conversation=<en|hu> reply=<en|hu|unknown>` (`conversation` is the language the turn named, `reply` what the reply's own words read as), a warning line when the model answered a person writing English with a reply that reads as Hungarian (`conversation=en`, `reply=hu`, whatever the account is shown in: the owner's own case is an account shown in Hungarian), both stored on the assistant message (`conversationLanguage`, read back by `getLastConversationLanguage` as the fallback of a later turn whose call fails and whose reply says nothing; `replyLanguage`, the record), and counters in `normal-chat-stability-snapshot.ts` (`replyLanguage`: turns, replies that said nothing, turns the chain had to decide, and the warning case as `englishWriterHungarianReplyCount`) (`chat-turn/reply-language.test.ts`).
  - Content the server has the model write on its own follows the person's words, not a language it guessed: an App's labels are written in the language of the person's message (`buildAppRequestMessage` shows the generator those words, `requestText`; a change keeps the App's language unless it asks for another; the panel's and the chat card's regenerate send no language); an Atlas report is in the language of the question, which the model reads once at job start (`atlas-v3/question-language.ts`, kept on the ask checkpoint; the account's UI language then English if it cannot).
- `src/lib/server/services/chat-turn/short-local-text.ts` is the one place that cleans a short text a person reads (a title, a thought-step status line, a rail headline): a stray think block (`stripLeakedThinking`; one extra request for an unclosed one through `askWithThinkingRetry`), leaked reasoning and request restatements in English and Hungarian (`isReasoningLeak`, `isRequestRestatement`), and JSON-wrapped answers. Do not add a second cleanup beside it, and take any new phrase it should catch from real model output, in a test, in both directions. Few-shot examples for such a call travel as text in the one user message, never as earlier assistant turns (the chat template renders each with an empty think block and the model then re-opens one: 19% of titles). The status line is written in the account's UI language (it is written before any reply text exists); the rail headline and the follow-up chips are written in the language the turn named for the conversation after its reply (`resolveTurnReplyLanguage`, carried by `completeStreamTurn` and `finalizeChatTurn`), never in a fresh read of the latest message. The parity check that drops a line in the other language than asked for is `readShortTextLanguage` (a title is content words, so it counts a word spelt the Hungarian way, two accented letters or one in a word of seven letters or more and not on a short list English borrows, as well as the closed-class words: Hungarian needs two witnesses and a 3:1 lead, English one closed-class word and nothing Hungarian) and drops a line only when it is plain about it: a single name ("Zürich", "Béla Bartók"), the homographs ("Van Gogh Biography", "Chevy Volt Review") and a line of English content words pass.
- `src/lib/server/services/chat-turn/follow-up-chip.ts` says what a follow-up chip is and is the one check for it: a chip is the person's NEXT MESSAGE to Alfy (a tap sends its text, verbatim, as the user's own message through `handleSendFollowUp`), so it is an instruction or the person's own question about something the reply names, one short plain sentence in the language of the conversation for the person. It is never Alfy offering (`Szeretnéd, ha…?`, `Would you like me to…?`, `Írjam le…?`), a question put to the person (`Mennyi a kereted?`), a statement about the person (an invented fact in their mouth), or a generic push (`Tell me more`). `follow-up-suggestions.ts` owns the prompt that asks for it, and the prompt's examples must pass the same check. Take any new phrase the check should catch from real model output, in a test, in both directions. The chips' language is the conversation's for the person (the invariant above: the model's answer to one question after the reply), never the reply's by default and never a flip made by code reading the message for a request: `Hogy mondják angolul, hogy alma?` and `Írj egy e-mailt angolul a kollégámnak` leave the conversation in Hungarian (the person writes Hungarian; the email is the piece), `Write an email to my colleague in Hungarian` leaves it in English, and `Válaszolj angolul` or `Answer in Hungarian` leave it where it is: the person still writes the language they write, and a chip is their next message. A chip is also held to the language by the chip check itself (`isInLanguage`): besides the words only the other language has, it asks the reader of short texts (`readShortTextLanguage`) and, for an English turn, drops a sentence of four words or more that has no English word in it and a word spelt the Hungarian way (`Fejtsd ki részletesebben a két szakaszt` was kept under an "in English" request on the real model), while English chips that carry a Hungarian name, `Van Gogh` or `volt` stay.

## Chat Flow

- Route entrypoints:
  - [`src/routes/api/chat/send/+server.ts`](../../../../routes/api/chat/send/+server.ts)
  - [`src/routes/api/chat/stream/+server.ts`](../../../../routes/api/chat/stream/+server.ts)
  - [`src/routes/api/chat/stream/stop/+server.ts`](../../../../routes/api/chat/stream/stop/+server.ts)
- Shared pipeline:
  - [`src/lib/server/services/chat-turn/index.ts`](index.ts)
    - The single entrypoint into chat-turn (F1). The `send`, `stream`, and `retry` routes drive a Normal Chat turn through this facade and import chat-turn only from it, rather than reaching into individual submodules. It is a facade *inside* this module directory, not a new top-level `services/*.ts` boundary. Stream-lifecycle/capacity utilities used by auxiliary routes (`stream/stop|status|buffer`, `admin/drain`, `health`) still import `active-streams` directly.
  - [`src/lib/server/services/chat-turn/request.ts`](request.ts)
  - [`src/lib/server/services/chat-turn/preflight.ts`](preflight.ts)
  - [`src/lib/server/services/chat-turn/normalizer.ts`](normalizer.ts)
    - Canonical assistant-output normalization for send, stream, retry, and title generation.
  - [`src/lib/server/services/chat-turn/stream-orchestrator.ts`](stream-orchestrator.ts)
    - Orchestrates the full chat-turn streaming pipeline: neutral Normal Chat model-run events, tool-call marker handling, token/thinking framing, stream buffer management.
    - Imported by the `stream` and `retry` routes via the `chat-turn/index.ts` facade (F1).
  - [`src/lib/server/services/chat-turn/stream.ts`](stream.ts)
    - Re-export hub for stream sub-modules:
      - [`thinking-normalizer.ts`](thinking-normalizer.ts)
  - [`src/lib/server/services/chat-turn/active-streams.ts`](active-streams.ts)
  - [`src/lib/server/services/chat-turn/finalize.ts`](finalize.ts)
  - [`src/lib/server/services/chat-turn/types.ts`](types.ts)

Do:

- put shared request parsing, attachment preflight, model normalization, stream framing, and finalization in `chat-turn/`
- let `src/lib/server/services/chat-turn/stream-orchestrator.ts` and the stream submodules own shared upstream event parsing, tool-call marker handling, downstream token/thinking framing, and leading-output cleanup
- let `src/lib/server/services/chat-turn/normalizer.ts` normalize assistant text through the shared stream-protocol helpers so `/send`, `/stream`, retries, and title generation use the same visible content shape
- use `src/routes/api/chat/stream/stop/+server.ts` plus `chat-turn/active-streams.ts` for explicit user-requested aborts; do not overload passive disconnect handling for that purpose
- keep route files thin and transport-oriented
- preserve AI SDK UI stream part names and payload expectations unless the parser/UI/tests are intentionally updated together

Do not:

- duplicate turn logic between `send` and `stream`
- add new AI SDK UI stream part shapes casually; this touches browser parsing and tests
- hide persistence side effects inside route-local closures that only one endpoint can see
- couple provider transport details directly into page components
- duplicate stream-tag parsing or inline-thinking extraction between the browser stream consumer and `api/chat/stream/+server.ts`
- scatter freshness-sensitive search guards outside `normal-chat-context.ts`
