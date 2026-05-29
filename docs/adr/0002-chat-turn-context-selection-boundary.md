# Chat turns own context selection

Normal Chat context selection will be owned by a dedicated chat-turn service rather than by Honcho, task-state, knowledge retrieval, or Langflow transport code. Those subsystems may supply available context and context signals, but the chat-turn context-selection boundary decides what becomes prompt context, at what inclusion level, and within what budget, so passive workspace state, memory, attachments, and retrieved evidence cannot independently stack into oversized prompts.

**Implementation Status, 2026-05-29:** implemented for Normal Chat prompt construction. `src/lib/server/services/chat-turn/context-selection.ts` now exports `buildConstructedContext()` and owns candidate collection, budgeted section selection, context status updates, and trace sections. `src/lib/server/services/honcho.ts` exposes `loadHonchoPromptContext()` as a narrow session/persona supplier and no longer imports Knowledge, Task-State, TEI, linked-source, fork, working-document, or context-selection policy modules for prompt assembly.

ADR-0017 complements this decision: Working Document Identity may identify the prompt-ready artifact for a Working Document, but Context Selection remains responsible for deciding whether that artifact enters Prompt Context and how much budget it receives.

ADR-0018 complements this decision: Working Document Selection may identify live current-document signals and caller-ready prompt/retrieval/task-evidence views, but Context Selection remains responsible for final Prompt Context inclusion level and budget.

The central model-scaled context budget planner belongs inside the chat-turn boundary. Knowledge, task-state, Honcho, and retrieval services may expose candidates, signals, source metadata, snippets, or estimates, but they should not own final prompt-budget policy.

Web research evidence should eventually use the same prompt-budget policy rather than maintaining a separate small-context selection system. The migration may be sliced separately because web research has source-opening, citation, quote-quality, and audit constraints, but the long-term product behavior should not diverge into two context systems.

For web research, the web-research service owns source discovery, page opening, quote extraction, citation quality, and audit diagnostics. The shared context-selection policy should govern final evidence inclusion and sizing before content is sent to the answer-writing model.

**Considered Options**

- Keep context assembly distributed across Honcho, task-state, knowledge, and Langflow.
- Make Honcho the central prompt-context assembler.
- Create a dedicated chat-turn context-selection boundary.

We chose the chat-turn boundary because context selection is per-turn Normal Chat behavior, while Honcho remains an integration adapter and knowledge/task services remain candidate suppliers rather than generic prompt engines.

ADR-0015 complements this decision: context selection owns what enters the model before a Normal Chat turn, while turn completion owns the durable and response-facing result after the assistant answer.
