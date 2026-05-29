# Honcho-led Memory Context replaces project-only retrieval

AlfyAI will make Context Access a first-class Normal Chat capability, starting with Honcho-led baseline personalization plus one consolidated model-facing `memory_context` retrieval tool. Honcho remains the authority for persona and relationship memory; AlfyAI extends that memory with app-owned project and conversation-history retrieval without rebuilding a parallel local persona-memory system.

**Implementation Status, 2026-05-29:** Honcho-led memory remains intact, but prompt selection no longer lives in Honcho. Honcho now supplies session/persona candidates to `chat-turn/context-selection.ts`; the chat-turn boundary decides whether the Baseline Memory Profile, Honcho session context, task state, attachments, linked sources, and retrieved evidence enter Prompt Context and how much budget they receive.

The existing project-only `project_context` tool will be removed from the model-facing toolset rather than kept as a compatibility alias. Its project and continuity behavior will move under `memory_context(mode: "project")`, alongside Honcho-backed persona recall and account-scoped conversation-history recall. This keeps the model from choosing between overlapping memory tools and makes one tool responsible for answering "what durable context do we already have?"

Baseline personalization will use a Honcho-generated profile or representation-oriented answer instead of a newest-N raw conclusion list. That profile is Protected Context but not unlimited: it should be generous for this small trusted deployment and scale from the configured model/context budget, shrinking under genuine budget pressure before disappearing. Deeper persona recall belongs in `memory_context(mode: "persona")`.

Memory retrieval limits are product behavior, not arbitrary constants. Small fixed caps such as 5 project siblings, 10 detail messages, or 12 persona conclusions should not define what AlfyAI can remember in production. Any remaining limits must be operational guardrails with applied limits and omitted counts in the result, and should scale with configured model/runtime capacity where practical.

Historic chat recall will start from existing durable conversation summaries and bounded message search before adding new persistent memory structures. If that first slice still misses known user-history cases, AlfyAI may add a conversation-summary embedding subject to the existing `semantic_embeddings` substrate and refresh pipeline rather than creating a new memory store.

This is a production Context Access slice, not a memory-tool demo. Existing Knowledge Library and document context selection must be made reliable in the same slice: low-level users should not need exact filenames or manual `/document` selection for obvious document intent. Document retrieval should remain in Context Selection rather than being folded into `memory_context`, but it must stop depending on small fixed caps, lexical-only cross-conversation gates, or tiny excerpts when model-scaled context can support broader/deeper inclusion.

**Considered Options**

- Keep `project_context` and add separate persona/history tools.
- Keep `project_context` as a compatibility alias after introducing `memory_context`.
- Rebuild a local persona-memory clustering and salience system.
- Use Honcho-led baseline memory plus one consolidated `memory_context` tool.

We chose the consolidated Honcho-led path because a previous local persona-memory implementation was reverted after growing into a replacement for Honcho. Separate or aliased tools would increase model confusion, while newest-N prompt memory underuses Honcho's representation and chat surfaces. The app should let Honcho do the hard memory synthesis and use local retrieval only to expose app-owned historical context that Honcho does not own directly.

Context Access v1 should ship as one coherent feature branch with verifiable sub-slices rather than a giant untestable patch. The implementation should prove baseline Honcho profile injection, `memory_context` replacement of `project_context`, project/persona/history retrieval modes, semantic one-turn document promotion, intent-based document depth, and visible applied/omitted limits before treating the slice as production-ready.

**Acceptance Scenarios**

- In a fresh or unrelated chat, the assistant receives a Honcho-led Baseline Memory Profile that includes meaningful stable user facts and preferences before deciding whether to call a retrieval tool; this profile is not limited to the newest dozen raw conclusions.
- When the user asks what AlfyAI knows about a topic such as their bike, and that topic was discussed across multiple older non-project chats, `memory_context(mode: "history")` returns multiple relevant conversation summaries or snippets and can retrieve deeper detail for a selected conversation.
- When the user asks about a Library Document by topic rather than exact filename, automatic Context Selection can find the relevant document semantically, include enough content to answer according to intent-based depth, and expose it as document evidence; manual `/document` selection improves certainty but is not required for obvious cases.
