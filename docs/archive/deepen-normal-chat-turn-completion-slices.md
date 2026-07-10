# Deepen Normal Chat Turn Completion Slices

**Status:** Implemented
**Last reviewed:** 2026-05-29

This document is the archival status note for the local `$to-issues` slices that came out of the Normal Chat Turn Completion architecture review. It is not a live implementation backlog.

The requested boundary has been implemented through the shared chat-turn pipeline:

- `src/routes/api/chat/send/+server.ts` remains the `/send` HTTP adapter. It parses and preflights the request, calls Langflow, normalizes assistant output, and then delegates durable completion to `finalizeChatTurn`.
- `src/lib/server/services/chat-turn/stream-completion.ts` keeps stream-specific concerns such as SSE end framing, reconnect/stop behavior, stream buffer cleanup, and file-production stream handoff, then delegates durable completion to `finalizeChatTurn`.
- `src/lib/server/services/chat-turn/finalize.ts` is the shared durable completion boundary for post-turn persistence and fan-out: user and assistant messages, attachment linking, Skill Control operations, evidence summaries, web citation audit metadata, task-state and working-set updates, Honcho mirroring, memory events, conversation summaries, and background maintenance.
- `src/lib/server/services/chat-turn/normalizer.ts` remains the shared assistant-output normalization boundary for visible text and Skill Control envelope cleanup.

The chat-turn local engineering map in `src/lib/server/services/chat-turn/AGENTS.md` now matches this boundary: routes should not add post-turn persistence directly; new post-turn side effects belong in `finalize.ts`.

## Completion Status

| Slice | Original intent | Current status |
| --- | --- | --- |
| NCTC-01 | Capture the normal chat completion contract before refactor | Implemented. Coverage exists around `finalizeChatTurn`, send, stream completion, normalization, and stream orchestration. |
| NCTC-02 | Extract the shared durable send completion core | Implemented. `/send` delegates durable completion to `finalizeChatTurn`. |
| NCTC-03 | Return a completion result contract for send metadata | Implemented. `FinalizeChatTurnResult` carries assistant/user message ids, turn state, context sources, evidence task, post-turn task, and attachment task. |
| NCTC-04 | Reuse the shared durable core from stream completion | Implemented. `completeStreamTurn` delegates durable completion to `finalizeChatTurn` while keeping stream-specific behavior local. |
| NCTC-05 | Preserve generated-file lifecycle while sharing completion core | Implemented. Stream completion still owns file-production job assignment and generated-file memory sync around the shared durable completion result. |
| NCTC-06 | Prove retry, stop, and passive disconnect still hold | Implemented through focused stream completion, stream orchestrator, stream fallback, active-stream, and retry cleanup coverage. |
| NCTC-07 | Review and document the final boundary | Implemented here and in `src/lib/server/services/chat-turn/AGENTS.md`. |

## Current Verification Targets

Use focused tests for future changes in this area:

- `npx vitest run src/lib/server/services/chat-turn/finalize.test.ts`
- `npx vitest run src/lib/server/services/chat-turn/stream-completion.test.ts`
- `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
- `npx vitest run src/lib/server/services/chat-turn/normalizer.test.ts`
- `npx vitest run src/routes/api/chat/send/send.test.ts`

## Guidance For Future Agents

Do not reopen these slices as pending implementation work. If a new issue is found in normal chat turn completion, create a new focused slice that starts from the current boundary:

- request parsing and preflight in `request.ts` and `preflight.ts`
- route transport in `/api/chat/send`
- stream lifecycle and SSE framing in `stream-orchestrator.ts` and `stream-completion.ts`
- shared durable completion in `finalize.ts`
- assistant output normalization in `normalizer.ts`

Keep file-production facade reshaping, working-document selection, and finalize memory behavior out of this document unless a new review explicitly scopes them in.
