# Model-scaled context selection replaces small fixed caps

Normal Chat context selection will use the active model/provider's usable context capacity as the primary sizing policy instead of small fixed document, attachment, evidence, and rerank caps. Max Model Context should be derived from provider/model metadata when available. Third-party API connections must have Max Model Context configured in admin settings before they are considered fully configured, with 150k tokens as the safety fallback for unknown capacity. Target Constructed Context and Compaction Threshold remain admin-facing controls, and unset values should be derived per model/provider, with fixed item-count limits treated as performance safeguards rather than product inclusion rules.

We choose this because AlfyAI's primary models have large context windows, and conservative small-context caps make multi-turn document work unreliable while still charging for powerful model calls. This increases possible prompt usage and cost, but that trade-off should be explicit in model/provider context settings rather than hidden behavior caused by arbitrary constants.

The runtime policy is generous model-scaled behavior. Ordinary users should not need to manage context budgets for normal use, and AlfyAI will not introduce separate generous, balanced, or economy context profiles for v1. Cost control remains through the existing model/provider context settings, where unset values use model-derived defaults and explicit admin values act as overrides.

The immediate correctness track is separate from the V2 source-planning track. False reduced-state indicators, third-party provider context configuration, and unknown-capacity fallback behavior are bug-level correctness work. Source lifecycle promotion, strong-signal carry-forward, and breadth-first depth allocation are V2 upgrades built on the same model-scaled budget foundation.

**Considered Options**

- Keep the current conservative fixed caps and expose more manual evidence controls.
- Remove the context controls and derive all prompt sizing invisibly from provider limits.
- Use model-scaled context selection with configurable derived defaults and compact UI indications when sources are reduced.
- Add an admin/runtime policy mode for generous, balanced, or economy context behavior.
- Treat a large Knowledge Library as active context by default.
- Use model/reranker judgment alone to promote retrieved sources into active carry-forward context.

We chose one generous model-scaled default because the app should stay automatic for users and the existing context-size settings are enough control for v1.

**Acceptance Scenarios**

- On a 1M-context model, a conversation with 12 uploaded or attached text-readable documents promotes all 12 into active Context Sources. If they fit within derived Target Constructed Context, all 12 receive meaningful near-full or structured Prompt Context on the first turn.
- On the next turn, without re-attaching the documents, the same 12 documents remain active Context Sources and are eligible for Prompt Context before generic retrieval or memory.
- The above scenarios must not be constrained by the old 3/4/5 selected-evidence or working-set prompt item caps.
- If those 12 documents do not fit within Target Constructed Context, all 12 remain active Context Sources and Prompt Context preserves breadth first by giving every document a meaningful structured slice before allocating extra depth to the strongest documents.
- When active sources are reduced or compacted, Context Sources shows a subtle reduced/compacted state instead of silently hiding the reduction.
- Context Sources does not show reduced merely because the Knowledge Library is large, memory exists, or the same source appears in multiple source-management groups.
- Retrieved Knowledge Library material may become Message Evidence for the current answer without becoming an active Context Source for later turns.
- Retrieved material becomes an active Context Source only after deterministic source-identity-backed signals such as attachment, explicit mention, opening plus document-directed wording, pinning, correction/refinement, or clear follow-up reference.
- TEI reranking may improve ordering and source relevance, but reranker output alone does not promote a source into active carry-forward context.
- Third-party providers use configured Max Model Context as total input-plus-output context; Max Output Tokens reserve response space and reduce usable prompt capacity.
- The first backend slice should expose stable active-source count and reduction/compaction state through a product Context Sources payload rather than extending ContextDebugState; rendering the final Context Sources UI can follow in a separate slice.
- Once the Context Sources payload replaces the old evidence-manager/debug state for conversation-level source management, the old path must be removed or narrowed to message-level evidence/debug use.
- Tests should assert exact percentage math at the budget-helper boundary, but higher-level tests should assert behavior rather than brittle token totals.
