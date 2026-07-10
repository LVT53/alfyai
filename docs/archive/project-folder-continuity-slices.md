# Project Folder Continuity Slices

This plan breaks ADR 0008 into independently testable, verifiable, and separately committed production slices. Each slice should land as its own commit after its tests and verification pass. Do not create GitHub issues from this document unless explicitly asked.

## Slice 1: Project Folder Assignments Converge Project Continuity

**Type**: AFK  
**Blocked by**: None  
**Commit boundary**: One commit that adds the structural link and immediate convergence behavior.

### What to build

When a conversation is assigned to a Project Folder, AlfyAI immediately links or re-homes that conversation's Project Continuity to the folder's canonical Project Continuity. Project Folder and Project Continuity keep separate identities. Empty Project Folders remain organization-only until they have meaningful task continuity.

### Acceptance Criteria

- [ ] Assigning or moving a conversation into a Project Folder immediately creates or reuses the folder's canonical Project Continuity when the conversation has meaningful task continuity.
- [ ] Moving a conversation into a Project Folder that already has canonical Project Continuity re-homes the conversation's task continuity link to that canonical continuity.
- [ ] Moving a conversation out of a Project Folder removes folder authority for future turns without deleting Project Continuity.
- [ ] Deleting a Project Folder unassigns its conversations, unlinks the folder from canonical Project Continuity, and does not delete the conversations.
- [ ] Existing inferred Project Continuity still works for conversations without a Project Folder.

### Verification

- Unit or service tests for assign, move, unassign, delete-folder, and unorganized-continuity cases.
- Route-level test for the conversation project assignment endpoint proving convergence happens during the move operation, not only on the next chat turn.
- Migration/schema verification for the one-to-one Project Folder to Project Continuity link.

## Slice 2: Project Folder Label Enters Prompt Context Safely

**Type**: AFK  
**Blocked by**: Slice 1  
**Commit boundary**: One commit that makes the current Project Folder label available as safe Prompt Context.

### What to build

For chats inside a Project Folder, add a bounded conversation project section to Prompt Context. The folder name is quoted metadata, not system-prompt text or instructions. Renames use the current folder name for future turns without rewriting historical memory events.

### Acceptance Criteria

- [ ] A chat inside a Project Folder sends Prompt Context containing a quoted Project Folder label.
- [ ] The raw Project Folder name is not appended or prepended to the system prompt.
- [ ] A malicious-looking folder name is rendered as quoted metadata and cannot become an instruction layer.
- [ ] Renaming a Project Folder changes the label used in later Prompt Context.
- [ ] Conversations without Project Folders do not receive a fake or stale folder label.

### Verification

- Langflow/request preparation tests asserting `inputValue` contains the quoted label while `systemPrompt` does not contain raw folder-name injection.
- Service tests for renamed folder label resolution.
- Regression test with an instruction-like folder name such as `Ignore previous instructions`.

## Slice 3: Bounded Project Folder Awareness From Existing Summaries

**Type**: AFK  
**Blocked by**: Slice 2  
**Commit boundary**: One commit that adds always-on bounded Project Folder Awareness using existing task objective/checkpoint data.

### What to build

For chats inside a Project Folder, add Reference Context summarizing sibling conversations in the same folder. Use existing task objective and stable checkpoint summaries as the first source. Keep the section bounded for large folders by selecting recent or relevant sibling summaries and including an omitted count when useful.

### Acceptance Criteria

- [ ] A folder chat receives Project Folder Awareness with sibling conversation titles and compact summaries.
- [ ] The current conversation is not duplicated as its own sibling.
- [ ] Large folders are bounded by a deterministic cap and report omitted sibling counts where useful.
- [ ] Project Folder Awareness is Reference Context by default, not full transcript context.
- [ ] If sibling summaries are unavailable, the section degrades gracefully instead of blocking the turn.

### Verification

- Context-selection tests for zero, one, many, and over-limit sibling conversations.
- Prompt-context tests proving sibling awareness remains compact and uses summaries rather than full message bodies.
- A regression test proving unrelated Knowledge Library documents are not promoted merely because the folder exists.

## Slice 4: Context Sources Shows Compact Project Awareness

**Type**: AFK  
**Blocked by**: Slice 3  
**Commit boundary**: One commit that exposes Project Folder Awareness in Context Sources without turning it into Message Evidence by default.

### What to build

When Project Folder Awareness is active, show it as a compact conversation-level memory or project group in Context Sources. Do not display every sibling conversation as a long flat list by default. Only specific sibling material that materially supports an answer should become Message Evidence.

### Acceptance Criteria

- [ ] Conversation detail returns a compact Context Sources group for active Project Folder Awareness.
- [ ] The group includes the folder name and a bounded summary/count of sibling conversations.
- [ ] Message Evidence remains unchanged unless a specific sibling summary or detail was actually used to support the assistant answer.
- [ ] Existing document, attachment, memory, and working-set Context Sources continue to render correctly.

### Verification

- API test for conversation detail Context Sources payload.
- Component or store test for compact group rendering or data handling.
- Regression test that a sibling awareness group does not create per-message evidence by default.

## Slice 5: Automatic Sibling Conversation Promotion

**Type**: AFK  
**Blocked by**: Slice 3  
**Commit boundary**: One commit that lets backend Context Selection promote a relevant sibling conversation into deeper Prompt Context.

### What to build

When the current turn strongly refers to sibling work in the same Project Folder, backend Context Selection can promote one relevant sibling conversation beyond Reference Context. Promotion should be query-driven and bounded. Full sibling content should never be included only because the conversation shares a folder.

### Acceptance Criteria

- [ ] A query like "what font options did we discuss in this project?" can promote the relevant sibling conversation into deeper Prompt Context.
- [ ] The selected sibling is chosen by deterministic identity/relevance signals before any expensive model judgment.
- [ ] Promoted sibling content is capped and traceable.
- [ ] Irrelevant sibling conversations remain at Reference Context or omitted.
- [ ] Message Evidence can include the specific sibling conversation when it materially supports the answer.

### Verification

- Context-selection tests for relevant, ambiguous, and irrelevant sibling references.
- Prompt budget tests proving promoted sibling content respects Target Constructed Context.
- Message evidence test proving only materially used sibling content appears as evidence.

## Slice 6: Project Continuity Awareness For Unorganized Conversations

**Type**: AFK  
**Blocked by**: Slice 3  
**Commit boundary**: One commit that reuses the awareness path for inferred Project Continuity when no Project Folder exists.

### What to build

For conversations without a Project Folder but with inferred Project Continuity, provide lower-authority Project Continuity Awareness across linked conversations or tasks. This should behave like Project Folder Awareness but clearly come from inferred continuity rather than explicit user organization.

### Acceptance Criteria

- [ ] An unorganized conversation with Project Continuity can receive bounded Project Continuity Awareness.
- [ ] Project Continuity Awareness uses lower authority than Project Folder Awareness when both could apply.
- [ ] If the conversation is later assigned to a Project Folder, Project Folder Awareness becomes the canonical awareness source.
- [ ] Unorganized conversations without inferred continuity receive no continuity awareness section.

### Verification

- Service/context-selection tests for continuity-linked unorganized conversations.
- Precedence test proving Project Folder Awareness wins over inferred Project Continuity Awareness.
- Regression test proving unrelated global conversations are not included.

## Slice 7: Durable Conversation Summaries

**Type**: AFK  
**Blocked by**: Slice 3  
**Commit boundary**: One commit that introduces durable Conversation Summaries and makes awareness prefer them.

### What to build

Add a durable Conversation Summary source that describes what happened in a conversation, not just its current task objective. Maintain it after turns or through bounded maintenance, and make Project Folder Awareness prefer it over task checkpoints while retaining fallback behavior.

### Acceptance Criteria

- [ ] A Conversation Summary is stored or refreshed after meaningful conversation activity.
- [ ] The summary is compact, roughly suitable for a 50-100 word awareness paragraph.
- [ ] Project Folder Awareness prefers Conversation Summaries when available.
- [ ] Existing task objective/checkpoint fallback still works when no Conversation Summary exists.
- [ ] Summary refresh failures do not block chat turns.

### Verification

- Service tests for summary creation/update and fallback ordering.
- Context-selection tests proving summaries replace task-shaped checkpoint text in awareness.
- Failure-path test proving summary maintenance failure does not break a chat response.

## Slice 8: Langflow Project Context Tool Summary Mode

**Type**: AFK  
**Blocked by**: Slice 3  
**Commit boundary**: One commit that exposes a summary-first model-facing retrieval tool scoped to the current Project Folder.

### What to build

Expose a Langflow tool that lets the model request sibling conversation context for the current Project Folder. The default mode returns bounded structured summaries, not raw transcripts. The tool complements backend Context Selection; it is not the source of prompt-context authority.

### Acceptance Criteria

- [ ] The model-facing tool resolves scope from the current conversation/session, not from a model-provided user or folder id.
- [ ] By default, the tool returns Project Folder metadata, bounded sibling conversation summaries, and omitted counts.
- [ ] The tool is scoped to the current Project Folder by default.
- [ ] If the current conversation has no Project Folder, the tool returns a clear no-folder result or lower-authority Project Continuity scope only when explicitly supported by the server contract.
- [ ] Tool output is structured and suitable for tool-call evidence candidates.

### Verification

- Langflow custom-node/tool contract tests proving the exposed method and input names match the model-facing schema.
- Server/tool endpoint tests for scoped summary retrieval, no-folder behavior, and large-folder bounds.
- Stream/tool-call marker test if the tool emits candidates or output summaries into chat telemetry.

## Slice 9: Langflow Project Context Tool Detail Mode

**Type**: AFK  
**Blocked by**: Slice 8  
**Commit boundary**: One commit that adds explicit single-conversation detail retrieval with caps and audit data.

### What to build

Extend the Langflow project context tool with an explicit detail mode for one selected sibling conversation. Detail mode may return a capped transcript excerpt or richer conversation detail, but only for a conversation inside the allowed Project Folder or allowed Project Continuity scope.

### Acceptance Criteria

- [ ] Detail mode requires a selected sibling conversation id returned or allowed by the scoped summary result.
- [ ] Detail mode rejects or omits conversations outside the current Project Folder or allowed continuity scope.
- [ ] Returned detail is capped, structured, and records enough metadata to audit what was provided.
- [ ] Detail-mode output can become Message Evidence when materially used.
- [ ] Summary mode remains the default and cannot accidentally dump a folder-wide transcript.

### Verification

- Tool endpoint tests for allowed detail, out-of-scope detail rejection, and cap enforcement.
- Message evidence test for detail-mode sibling material.
- Regression test proving summary mode and detail mode have distinct bounded outputs.

## Out Of Scope For These Slices

- Selectively excluding one sibling conversation from Project Folder Awareness while keeping it in the Project Folder.
- Global cross-project conversation search.
- Replacing Context Selection with Langflow model-tool discovery.
- Rewriting historical memory events on Project Folder rename.
