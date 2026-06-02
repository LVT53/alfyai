# Context Access v1 Slices

This plan breaks ADR 0011 into independently testable, verifiable, and separately committable production slices. Each slice should land only after its acceptance criteria and verification pass. Do not create GitHub issues from this document unless explicitly asked.

## Scope

Context Access v1 makes AlfyAI reliably discover, select, and use relevant memory, history, project, and document context without requiring low-level manual setup from the user.

The production target is not a demo memory tool. The final slice set must prove:

- A Honcho-led Baseline Memory Profile is present before tool use.
- `memory_context` replaces `project_context` as the single model-facing memory retrieval tool.
- `memory_context` supports `project`, `persona`, and `history` modes.
- Memory and document retrieval limits scale with configured model/runtime capacity instead of small hidden constants.
- Semantically strong Library Document matches can enter one-turn Prompt Context without exact filenames or manual `/document`.
- Selected documents receive intent-based depth.
- Reductions and omitted results are visible in audit/context surfaces.

## Slice 1: Honcho-Led Baseline Memory Profile

**Type**: AFK
**Blocked by**: None
**Commit boundary**: One commit that replaces newest-N raw conclusion prompt memory with a Honcho-led Baseline Memory Profile.

### What to build

Every Normal Chat turn should start with a compact Honcho-generated Baseline Memory Profile before the model decides whether to use tools. The profile should be generous for this small trusted deployment, model-scaled, cached briefly, and protected-but-budgeted. It must not be a newest-dozen raw conclusion list.

### Acceptance criteria

- [ ] A chat turn with Honcho enabled includes a Baseline Memory Profile generated through Honcho synthesis or representation-oriented recall, not by slicing raw conclusions.
- [ ] The profile budget derives from model-scaled context with a generous floor and configurable ceiling.
- [ ] The profile is protected context but can shrink under genuine budget pressure before being omitted.
- [ ] Honcho unavailable/timeout paths degrade gracefully without blocking core chat.
- [ ] Context Trace or equivalent diagnostics identify the profile source and whether it was reduced or omitted.

### Verification

- Unit tests for profile budget derivation across small, 250k, and 1M context settings.
- Service tests proving raw conclusion list serialization no longer slices to 12 for prompt memory.
- AI SDK tool/context-construction test proving the profile appears before tool use when Honcho succeeds.
- Fallback test proving chat proceeds when Honcho profile generation times out or fails.

## Slice 2: `memory_context` Tool Shell Replaces `project_context`

**Type**: AFK
**Blocked by**: None
**Commit boundary**: One commit that removes the old model-facing project tool and exposes the new memory tool shell with project mode.

### What to build

Replace the model-facing `project_context` tool with the app-backed AI SDK `memory_context` tool. The first mode may delegate to the current project retrieval behavior so the end-to-end tool path is real immediately. Do not keep `project_context` as a model-facing alias.

### Acceptance criteria

- [ ] The AI SDK Normal Chat tool registry exposes a model-facing tool named `memory_context`.
- [ ] The old model-facing `project_context` node/tool guidance is removed.
- [ ] `memory_context(mode: "project")` returns the current project/folder/continuity summary shape, renamed under the new tool contract.
- [ ] The tool runtime still resolves conversation/user scope from the active session or signed service assertion, not model-provided ids.
- [ ] Prompt guidance mentions only `memory_context`, not both `memory_context` and `project_context`.

### Verification

- AI SDK tool contract test asserting `memory_context` name, modes, model-facing fields, and endpoint.
- Repository search test or static assertion proving `project_context` is not exposed as a model-facing tool.
- Route/service tests for authenticated and signed service calls.
- Tool marker test proving emitted events use `memory_context`.

## Slice 3: Model-Scaled Project Memory Retrieval

**Type**: AFK
**Blocked by**: Slice 2
**Commit boundary**: One commit that removes small project-context caps as product behavior.

### What to build

Upgrade `memory_context(mode: "project")` so project sibling summaries and detail retrieval scale with configured model/runtime capacity. The old small limits such as 5 siblings and 10 detail messages may remain only as configurable or derived operational safeguards, with applied limits and omitted counts in the response.

### Acceptance criteria

- [ ] Project summary mode can return substantially more than 5 sibling/linked conversations when model/runtime capacity allows.
- [ ] Detail mode can return substantially more than 10 relevant messages when model/runtime capacity allows.
- [ ] Responses include applied limits and omitted counts for siblings, messages, and deep-research results where applicable.
- [ ] Large projects preserve breadth first through summaries before adding deep content.
- [ ] Existing Project Folder and Project Continuity authority rules are preserved.

### Verification

- Service tests for small, medium, and large target context settings proving applied limits scale.
- Regression tests for Project Folder Awareness and Project Continuity Awareness authority.
- Detail-mode tests proving over-limit results are disclosed, not silently hidden.

## Slice 4: Honcho Persona Recall Mode

**Type**: AFK
**Blocked by**: Slice 2
**Commit boundary**: One commit that adds query-specific Honcho persona recall through `memory_context`.

### What to build

Add `memory_context(mode: "persona")` for deeper query-specific persona recall. The tool should let the model ask Honcho specific questions about the user, preferences, behavior patterns, and personal facts without introducing local persona clustering, salience, or contradiction systems.

### Acceptance criteria

- [ ] The model can ask a specific persona-memory question through `memory_context(mode: "persona")`.
- [ ] The response is Honcho-led and source-attributed as persona memory.
- [ ] Returned output is bounded by model/runtime policy and reports applied limits or truncation.
- [ ] Persona recall does not use or recreate local persona-memory tables, clusters, salience scores, or supersession logic.
- [ ] Persona recall degrades clearly when Honcho is disabled or unavailable.

### Verification

- Service tests with mocked Honcho success, timeout, disabled, and error paths.
- Tool contract tests for persona mode input and output shape.
- Regression test proving persona mode does not call deleted local persona-memory boundaries.

## Slice 5: Account-Wide History Recall Mode

**Type**: AFK
**Blocked by**: Slice 2
**Commit boundary**: One commit that adds summary-first account-wide conversation history recall.

### What to build

Add `memory_context(mode: "history")` so the model can search older non-project chats. Start with existing durable conversation summaries and bounded message search. Return broad conversation-level results first, with detail retrieval for one selected conversation. Do not add a new memory store in this slice.

### Acceptance criteria

- [ ] History mode searches across the current user's conversations, not only Project Folder or Project Continuity siblings.
- [ ] Summary mode ranks by conversation title, durable summary, and bounded message snippets.
- [ ] Detail mode can retrieve deeper clipped dialogue for one selected conversation from summary results.
- [ ] Results include applied limits and omitted counts.
- [ ] If a topic appears in multiple older chats, multiple relevant conversations can be returned.

### Verification

- Service test for the “bike in old chats” scenario with at least five older non-project conversations and multiple relevant hits.
- Detail-mode test proving one selected historic conversation can be expanded.
- Ownership tests proving other users' conversations are excluded.
- No-new-schema verification for the first history slice.

## Slice 6: Memory Tool Evidence And Context Sources Integration

**Type**: AFK
**Blocked by**: Slices 2, 3, 4, 5
**Commit boundary**: One commit that makes `memory_context` outputs visible and auditable in existing chat surfaces.

### What to build

Normalize `memory_context` tool outputs into message evidence and Context Sources so users can see what memory/history/project context supported an answer. This should preserve the distinction between one-turn evidence and carried-forward active sources.

### Acceptance criteria

- [ ] `memory_context` project/persona/history outputs can produce memory evidence candidates.
- [ ] Message Evidence shows specific memory/history candidates only when they materially support the answer.
- [ ] Context Sources can show compact memory/context groups with reduced or omitted counts.
- [ ] Tool-call UI and stream markers no longer special-case the old `project_context` name.
- [ ] Existing web, file-production, and image tool evidence behavior remains unchanged.

### Verification

- Tool marker parser tests for `memory_context` candidates.
- Message evidence tests for project, persona, and history candidates.
- Context Sources payload/component tests for reduced/omitted memory context.
- Regression test proving old `project_context` candidates are no longer required.

## Slice 7: Semantic One-Turn Library Document Promotion

**Type**: AFK
**Blocked by**: None
**Commit boundary**: One commit that fixes document eligibility without changing long-term active source lifecycle.

### What to build

Allow semantically strong Library Document matches to enter one-turn Prompt Context and Message Evidence even when the user does not quote the exact filename or manually select `/document`. Cross-conversation eligibility should consider semantic and rerank confidence, not only lexical token overlap. This does not make the document an active carried-forward Context Source by itself.

### Acceptance criteria

- [ ] A topic-only document query can retrieve a relevant Library Document through semantic/rerank confidence.
- [ ] Cross-conversation document eligibility is not blocked solely because lexical token overlap is weak.
- [ ] The retrieved document can enter one-turn Prompt Context and Message Evidence.
- [ ] The retrieved document does not become an active carried-forward Context Source unless a follow-up, open, pin, explicit selection, or other strong source-continuity signal occurs.
- [ ] Existing source ownership and conversation-boundary rules still prevent stale or unauthorized artifacts from leaking.

### Verification

- Knowledge retrieval tests for weak lexical but strong semantic/rerank matches.
- Cross-conversation eligibility tests covering lexical-only, semantic-only, rerank-only, and weak-noise cases.
- Context-selection test proving one-turn document evidence is not automatically carried forward.
- Regression test for unauthorized/stale artifact exclusion.

## Slice 8: Intent-Based Document Context Depth

**Type**: AFK
**Blocked by**: Slice 7
**Commit boundary**: One commit that replaces tiny default document excerpts with intent-based model-scaled depth.

### What to build

When documents are selected automatically or explicitly, choose Reference, Excerpt, or Task Context based on user intent and configured model budget. Direct attachments, `/document` selections, explicit document titles, and current workspace focus with document-directed wording should receive near-full or structured full content when they fit.

### Acceptance criteria

- [ ] Weak document matches receive Reference Context or small excerpts.
- [ ] Strong answer-seeking document matches receive meaningful Excerpt Context larger than the old tiny default when budget allows.
- [ ] Document-shaped tasks such as summarize, compare, extract, review, check, rewrite, or “what does it say about X” receive Task Context when budget allows.
- [ ] Multiple plausible documents preserve breadth before one document receives deep context.
- [ ] If partial context materially affects trust, the assistant has enough metadata to produce a Context Limitation.

### Verification

- Budget-helper tests for intent-based document depth across small, 250k, and 1M context settings.
- Context-construction tests for weak, strong answer-seeking, and task-shaped document turns.
- Multi-document tests proving breadth-before-depth behavior.
- Regression test proving direct `/document` and attachment flows remain high-certainty and high-depth.

## Slice 9: Context Sources Reduction And Omission Visibility

**Type**: AFK
**Blocked by**: Slices 1, 6, 8
**Commit boundary**: One commit that exposes memory/document context reductions as product state.

### What to build

Expose when Baseline Memory Profile, memory tool results, or document context were reduced, truncated, or omitted because of budget or retrieval limits. Users should not silently get a less personal or less document-grounded answer without Context Sources or evidence reflecting that reduction.

### Acceptance criteria

- [ ] Context Sources can represent reduced/omitted Baseline Memory Profile.
- [ ] Context Sources or message evidence can represent applied limits and omitted counts from `memory_context`.
- [ ] Context Sources can indicate when selected documents were included only partially.
- [ ] A large Knowledge Library or large raw memory count alone does not create a false reduced state.
- [ ] Existing compact Context Sources behavior remains scan-friendly.

### Verification

- Context Sources payload tests for memory profile, memory tool, and document reduction states.
- UI/component tests for compact reduced/omitted rendering.
- Regression test proving no false reduced state appears merely because many memories or Library Documents exist.

## Slice 10: Context Access v1 End-To-End Acceptance Harness

**Type**: AFK
**Blocked by**: Slices 1 through 9
**Commit boundary**: One commit that codifies the north-star product scenarios as regression tests and smoke checks.

### What to build

Add an end-to-end or high-level integration harness for the three non-negotiable Context Access scenarios: baseline personalization, historic bike recall, and fuzzy document recall. This slice should not introduce new behavior; it proves the production slice works as a coherent product path.

### Acceptance criteria

- [ ] In a fresh or unrelated chat, the assistant receives a Honcho-led Baseline Memory Profile before tool use.
- [ ] A user asking what AlfyAI knows about their bike can retrieve multiple relevant older non-project conversations through `memory_context(mode: "history")`.
- [ ] A user asking about a Library Document by topic rather than exact filename receives document-grounded context and evidence.
- [ ] The harness verifies applied limits, omitted counts, and reduction states where relevant.
- [ ] The old `project_context` model-facing path is absent from the tested runtime toolset.

### Verification

- Integration tests with seeded users, conversations, summaries, messages, and Library Documents.
- Mocked Honcho tests for deterministic Baseline Memory Profile and persona recall.
- Optional Playwright smoke test for visible tool/evidence/context-source surfaces if the UI changes in Slices 6 or 9.

## Dependency Summary

1. Slice 1 can start immediately.
2. Slice 2 can start immediately.
3. Slices 3, 4, and 5 depend on Slice 2.
4. Slice 6 depends on Slices 2 through 5.
5. Slice 7 can start immediately.
6. Slice 8 depends on Slice 7.
7. Slice 9 depends on Slices 1, 6, and 8.
8. Slice 10 depends on all previous slices.

## Granularity Check

These slices are intentionally thin enough for independent verification but broad enough to be demoable. The highest-risk merge points are Slice 2, where the model-facing tool contract changes, and Slice 8, where document context depth can affect prompt size and cost. If implementation reveals excessive coupling, split those slices around tool contract tests and budget-helper tests before changing behavior.
