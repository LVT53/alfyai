# Interim status concatenation: read-only reproduction and identity trace

Workspace: `/Users/lvt53/.codex/worktrees/turn-completion/alfyai`.
Scope: reproduction/root cause only; implementation must wait for the controller's spec judge. No tracked files edited, agents spawned, services started, credentials read, full checks/build/gates run, push or deploy performed. Root and applicable folder AGENTS were consulted (services, chat-turn, shared services, client, stores, components/chat, routes, DB, tests). No framework implementation was written, so no framework API documentation check was needed.

## Verdict and important qualification

**Confirmed:** the actual browser transport concatenates `Let me check.` and `## Result` into exactly `Let me check.## Result`, even when SSE gives them distinct block IDs and closes/opens the blocks properly.

**Confirmed on the real server chunk runtime → SSE → real browser transport:** after already-visible prose in the same text run, `Let me check.` survives the server's heuristic cleanup; a tool call/result between that preface and the final heading does not remove it or insert a text boundary. The result is `Hello. Let me check.## Result`. The exact bad substring also survives real clipboard and Markdown-export functions.

**Negative control:** a clean leading `Let me check.` followed by `## Result` is currently stripped correctly on the server, producing only `## Result` and one transient tool-progress activity. Do not claim that this clean leading server case fails. The bare exact-string reproduction at the browser seam assumes those text deltas reach the browser. No production/provider trace was captured here.

## Actual commands and output

Commands run with Node 22, login shell disabled, from the workspace. These scripts import real checked-out functions and stub only fetch/input events; they do not copy the implementation. Exit 1 below is the intentional red spec assertion, after confirming the bad actual output.

### alfyai-interim-repro.ts

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import tsx /tmp/alfyai-interim-repro.ts
```

```text
{"case":"one server text ID","tokens":["Let me check.","## Result"],"text":"Let me check.## Result"}
{"case":"distinct SSE block IDs","tokens":["Let me check.","## Result"],"text":"Let me check.## Result"}
CONFIRMED: both same-ID and distinct-ID streams concatenate interim prose into final answer.
spec expectation: interim prose must not become final answer
+ actual - expected

+ 'Let me check.## Result'
- '## Result'

Exit: 1
```

### alfyai-interim-server-repro.ts

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import tsx /tmp/alfyai-interim-server-repro.ts
```

```text
server fullResponse: "Hello. Let me check.## Result"
server segments: [{"type":"tool_call","name":"web_search","input":{"query":"test"},"status":"done","outputSummary":null,"resultDigest":null,"sourceType":null,"map":null}]
server text frames: ["data: {\"type\":\"text-start\",\"id\":\"answer\"}","data: {\"type\":\"text-delta\",\"id\":\"answer\",\"delta\":\"Hello. \"}","data: {\"type\":\"text-delta\",\"id\":\"answer\",\"delta\":\"Let me check.\"}","data: {\"type\":\"text-delta\",\"id\":\"answer\",\"delta\":\"## Result\"}"]
browser onEnd: "Hello. Let me check.## Result"
clipboard: "Hello. Let me check.## Result"
export contains bad join: true
CONFIRMED: actual server runtime -> SSE -> browser, copy and export retain the bad join.
SPEC FAIL: interim status remains in answer
Exit: 1
```

### alfyai-interim-runtime-matrix.ts

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import tsx /tmp/alfyai-interim-runtime-matrix.ts
```

```text
{"chunks":["Let me ","check.","## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
{"chunks":["Let ","me check.","## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
{"chunks":["Let me check",".","## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
{"chunks":["Let me check.","## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
{"chunks":["Hello. ","Let me check.","## Result"],"fullResponse":"Hello. Let me check.## Result","thinking":"","activities":[]}
{"chunks":["## Intro\n","Let me check.","## Result"],"fullResponse":"## Intro\nLet me check.## Result","thinking":"","activities":[]}
{"chunks":["Let me check.## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
{"chunks":["Let me check.\n\n","## Result"],"fullResponse":"## Result","thinking":"","activities":[{"id":"tool-progress:1","kind":"tool","status":"running","label":"Let me check."}]}
Exit: 0
```

The tsx CLI initially failed to create its IPC pipe (`listen EPERM`); `node --import tsx` avoids that CLI pipe and successfully executes the same harness. No escalation was needed.

## Identity trace and exact loss boundaries

All source locations below are workspace-relative, using observed line numbers in the investigated checkout.

1. **SDK → neutral model-run events is the first irreversible loss.** `src/lib/server/services/normal-chat-model/index.ts:384-392` defines text/reasoning events with only `type` and `text`. At `:1811-1820`, SDK `text-delta` / `reasoning-delta` are projected to `{type: "text_delta"|"reasoning_delta", text: part.text}`: SDK block ID is dropped. SDK start/end block events and start-step events have no cases and disappear at `:1925-1926`. `finish-step` at `:1874-1890` updates aggregate count/usage/model bookkeeping but emits no step boundary. `onStepFinish` at `:1767-1788` receives stepNumber, logs it, and passes response.messages through onStepMessages; it does not preserve step/block identity on the public text event stream. Tool call IDs ARE retained at `:1840-1845`; this is specifically a text/step identity hole, not universal identity loss.

2. **Neutral events → answer handling assumes every text delta is answer text.** `src/lib/server/services/chat-turn/stream-orchestrator.ts:1520-1551` dispatches text_delta (outside file-production capture) to emitChunkWithOutputHandling and stops the thought-step classifier immediately (`:1546`). No step/block role survives to tell interim assistant commentary from final answer output. This also means an early unfiltered commentary delta can stop later reasoning enrichment prematurely. Reasoning is separately fed to the classifier at `:652`; persisted steps come from the session at `:1013`.

3. **Server accumulation / SSE manufactures a single answer block.** `src/lib/server/services/chat-turn/stream.ts:77` fixes the text ID to `answer`; `:280-300` creates all text-start/delta/end events using it. `:599-606` starts one text block and emits every answer chunk through it; `:699-701` blindly appends retained text to fullResponse and emits it. A tool event flushes held output then resets answerStarted / diagnostic state (`:873-898`), but cannot retract text already appended or create a new answer-text identity. The preface and heading concatenate across the call.

   The existing mitigation is lexical, not structural: `:650-679` strips leading tool narration with `leading = !answerStarted`; `src/lib/services/stream-protocol.ts:390-391` recognizes the English/Hungarian narration pattern, and `:1532-1554` only applies that narration logic at the start of a text run. Once `Hello. ` is visible, later `Let me check.` in that same run is retained. The matrix proves both positive and negative cases.

   Do not mistake `serverSegments` for ordered answer blocks: `stream.ts:619-631` appends *reasoning* text to those segments; tool records are also interleaved there. Visible answer text lives in the separate flattened fullResponse. The server harness's segments contain only the tool call, while fullResponse contains all three visible chunks.

4. **Reconnect preserves flattened text, not original SDK identity.** `stream-orchestrator.ts:639-642` buffers tokens as `{text: chunk}`. `src/lib/server/services/chat-turn/stream-reconnect.ts:132-139` and `:189-192` reconstruct text-start/delta events with the same fixed answer helpers. Original step/block identity cannot be recovered on replay.

5. **Browser transport independently discards even supplied IDs.** `src/lib/services/streaming.ts:1009-1027` reads only delta/text, ignoring part.id, then sends strings to emitInlineChunk. `:699-704` appends every visible string into fullText; `:754-762` ends with that string. Text-start/end events fall through the switch's default (`:1110`). `StreamCallbacks` at `:137-141` exposes onToken(chunk) and onEnd(fullText), with no block/step channel. The distinct-ID reproduction proves this independent loss directly; merely fixing server IDs will not solve the end-to-end contract.

6. **Client state and rendering have only the accumulated string.** `src/lib/client/normal-chat-client-turn-runtime.ts:1809-1816,1855-1860` buffers tokens and emits appendToken events. `src/routes/(app)/chat/[conversationId]/+page.svelte:1102-1106` delegates to `src/routes/(app)/chat/[conversationId]/_helpers.ts:913-929`, whose update is `content: message.content + chunk`. `src/lib/components/chat/MessageBubble.svelte:1334-1338` passes message.content directly to MarkdownRenderer. Thus `##` after a period is inside the same Markdown paragraph, not a heading boundary. No renderer-only spacing change could identify which prose was interim.

7. **Persistence and reload retain the flattened content.** `src/lib/server/services/chat-turn/stream-completion.ts:357-366` uses fullResponse for citation repair/finalResponse, `:662-665` selects persistedAssistantResponse, and `:797-799` forwards it plus reasoning/tool segments to finalize. `src/lib/server/services/chat-turn/finalize.ts:674-683` persists assistantResponse as assistant content. `src/lib/server/services/messages.ts:539-551` projects row.content unchanged and reads thinkingSegments separately. Citation repair's finalContent channel (`stream-completion.ts:367-381`) is a text-replacement precedent, not a block-identity mechanism or an interim/final classifier. DB write/reload were inspected, not executed; no production or workspace DB was mutated by the reproduction.

8. **Copy and export read the same answer body.** `src/lib/components/chat/MessageBubble.svelte:350-354,911-915` uses getClipboardText(message.content), or the reply's copyText for ask/resume row chains. `src/lib/shared/reply-text.ts:17-22` strips thinking tags and trims only; it cannot remove ordinary interim prose. `src/lib/components/chat/reply-segments.ts:247-248` joins already-flattened row content for multi-row replies; those ask/resume segments are not SDK blocks. `src/lib/server/services/conversation-export.ts:14-24` additionally renders action-implying durable thought steps as tool summaries, then `:36` appends message.content unchanged. The export route `src/routes/api/conversations/[id]/export.md/+server.ts:33-34` uses listMessages and renderConversationMarkdown. Both copy and exporter functions were executed in the harness; reload follows the inspected persistence path.

## ADR-0056 overlap: use the existing durable boundary carefully

- `docs/adr/0056-interim-thought-steps-are-durable-turn-state.md:3-5,31-43,61-65`: Interim Thought Steps are durable completion-owned turn state, projected by the existing conversation read model, append-only, anchored to the persisted Thinking Trace, separate from raw reasoning and final answer content. They ride existing activity stream payloads; the ADR adds no new UI stream part names.
- The August amendment (`:88-100`) supersedes class-only wording and the original full-trace disclosure UX: constrained entity-grounded paraphrase is allowed, anchored-span reveal is primary, full reasoning is explicit opt-in. Its faithfulness enable gate is >=95% faithful, zero contradictions, zero fabricated action claims; no live per-step judge. Do not implement against the superseded wording.
- Current data shape: `src/lib/response-activity-types.ts:191-205,220+` has stable step id, source, activity class, action flag and anchor offsets into SAME-turn messages.thinking. `chat-turn/thought-steps.ts:49-61` reads metadataJson.thoughtSteps. `stream-completion.ts:523-530,827-831` emits/persists steps; `messages.ts:408-427` projects them on reload. `ThinkingBlock.svelte:338+` filters usable anchored steps and `:1171-1194` renders disclosure/anchor reveal. This is already a real durable path, not a proposed separate pipeline.
- **Important distinction:** `stream.ts:1003-1013` converts stripped model narration to a `tool-progress:N` activity (`kind: tool`, label: original text). It does not create an anchored InterimThoughtStep, persist the preface as thinking, or establish a model block identity. The server negative control produces no thinking text at all, so inventing an anchor for that string would violate the existing contract.
- Consequently, identity preservation and the policy for routing ordinary assistant commentary need explicit spec judgment. Do not silently rename arbitrary commentary to ADR-0056 steps, infer action truth from prose, or add shadow persistence. A newline patch would address only typography and leave answer/copy/export contamination intact.

## Evidence to give the spec judge before implementation

1. Distinguish assistant commentary text from reasoning deltas, actual tool events, transient acknowledgments/status, anchored durable thought steps, and final answer text. Decide the rule from structured step/block facts; do not use English/Hungarian prose guesses as the new authority.
2. Establish which identity (step, text block, attempt) is preserved and who decides interim/final classification before any consumer flattens it. IDs alone cannot classify prose; both source facts and downstream handling must be specified.
3. Judge live rendering, terminal state, reconnect, saved content, reload, copy and export against the same content contract. Require the actual bad join to be absent everywhere it must be absent, while legitimate answer prose remains intact.
4. Preserve the passing clean-leading case and cover the confirmed non-leading preface/tool/final-heading case. Include distinct-ID and multiple-delta cases so a server-only fix or Markdown-only separator cannot pass by accident.
5. State how the existing ADR-0056 anchor/provenance and durable completion ownership apply if commentary is retained as navigable activity. This investigation does not authorize changing those semantics or adopting a new pipeline.

## Workspace preservation

Initial git status was clean. Final status showed `?? docs/plans/turn-completion/contract/`, created concurrently by another worker/controller; this investigator did not create, read for task content, modify, stage or remove it. Investigator outputs are only the report and ephemeral reproduction scripts under /tmp. No product patch is claimed complete; full gates/check/build were intentionally not run under the requested scope.
