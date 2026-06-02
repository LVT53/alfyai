# Migrate context selection in production TDD slices

Normal Chat context selection will be migrated through independently testable production slices rather than a broad rewrite. Each slice must start from behavior tests, ship with enough fallback and observability to run in production, and remove the context-selection debt it replaces.

**Slice Order**

1. Add compact `[CONTEXT_TRACE]` logs and consolidate overlapping success-path context, attachment, and TEI logs.
2. Introduce a central model-scaled context budget helper and use it in one vertical behavior slice rather than raising scattered constants.
3. Derive target constructed context and compaction threshold from the active model/provider by default.
4. Replace fixed document, attachment, evidence, and rerank item-count caps with model-scaled budgets and performance safeguards.
5. Treat current-turn attachments as active Context Sources that receive near-full prompt context when model-scaled budget allows.
6. Preserve breadth across explicitly supplied or active source sets before giving deep context to the strongest sources.
7. Persist active Context Sources across turns until a clear topic shift, reset, exclusion, or task boundary change.
8. Treat open workspace documents as weak context signals unless paired with explicit user wording or selection intent.
9. Replace `essential` prompt sections with protected-but-budgeted inclusion levels.
10. Normalize generated outputs and recent conversation turns so recency alone cannot promote large body text.
11. Normalize pinned/preferred evidence so preference affects ranking and protection without forcing full body inclusion.
12. Introduce the chat-turn context-selection boundary as the single source of truth for candidate promotion and inclusion levels.
13. Apply the budget ladder across reserved, core, support, and awareness context.
14. Rename and reframe the conversation-level Evidence Manager surface as Context Sources after the backend state reflects carried-forward sources.
15. Unify web research final evidence inclusion with the shared model-scaled budget policy while leaving source discovery, page opening, quote extraction, and citation audit in the web-research service.
16. Remove replaced distributed prompt assembly, duplicated budget logic, stale latest-output heuristics, obsolete diagnostics, and old web-research evidence budgeting once their replacements own the behavior.

We chose this order because trace-first gives production visibility, but the immediate reliability failure is that small fixed limits override large-model context capacity. Model-scaled backend selection must come before UI reframing so Context Sources can display real carried-forward state rather than decorating the old dropped-document behavior.

The first implementation slices should reuse existing persistence such as conversation working-set items and task evidence links before adding schema. New tables are only justified when a missing Context Sources concept cannot be represented cleanly by the existing boundaries.

Each replacement slice must remove or disable the older path it replaces in the same slice. Leaving parallel budget or selection behavior behind is Context Selection Debt, not a valid intermediate endpoint.

**Implementation Status, 2026-05-29:** slice 12 is complete for Normal Chat prompt construction. The replaced Honcho-owned `buildConstructedContext()` path was removed from `honcho.ts`; Normal Chat prompt assembly now calls the chat-turn context-selection boundary directly, and Honcho supplies only Honcho session/persona context. Later AI SDK migration work retired the Langflow Normal Chat runtime, so this ADR should be read as context-selection history rather than Langflow deployment guidance.
