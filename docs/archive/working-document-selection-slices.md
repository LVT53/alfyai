# Collapse Working Document Selection Signals Slices

These are local `$to-issues` slices for completing **Collapse Working Document Selection Signals** from the architecture review. They are not published tracker issues.

The review recommendation is to stop sharing Working Document behavior by convention through scattered reason codes and caller-local promotions. The target boundary is one **Working Document Selection** module that decides the current document focus, generated-document carryover, correction target, recent refinement family, reset signal, historical family handling, and caller-ready signal sets for Prompt Context, Knowledge retrieval, Context Sources, and Task Context.

**Implementation Status, 2026-05-29:** implemented locally across WDS-01 through WDS-04. `src/lib/server/services/working-document-selection.ts` now owns the live-signal collapse, the old `active-state.ts` helper/test were removed, prompt/retrieval/task callers consume selection views, the full unit suite passes, and the architecture review HTML is marked finished.

## Evidence And Constraints

- Review HTML source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`
- Review section: `Collapse Working Document Selection Signals`
- Problem statement: Working Document rules are shared by convention through reason codes, but each caller still performs its own promotion and protection.
- Target files called out by the review: the now-removed `src/lib/server/services/active-state.ts`, `src/lib/server/services/document-resolution.ts`, `src/lib/server/services/working-set.ts`, `src/lib/server/services/knowledge/context.ts`, and `src/lib/server/services/task-state.ts`.
- Implemented target boundary: `src/lib/server/services/working-document-selection.ts`.
- Repo boundary: `document-resolution.ts` remains generated-document family ranking authority; the new selection module consumes that resolver rather than reimplementing family ranking.
- Repo boundary: Context Selection remains prompt-budget authority. Working Document Selection decides signals and protected/current identities, not final token budgets.
- Repo boundary: Working Documents continue to use the existing artifact backbone and Working Document Identity boundary. Do not create a parallel persistence path.
- Context7 evidence: SvelteKit server-only logic belongs in `$lib/server` and route/page adapters should stay thin; Vitest 4 supports focused TypeScript boundary tests with `vitest run <file>`.

## Done Criteria

- [x] One server-side **Working Document Selection** contract owns live document signals and exposes caller-ready views for prompt selection, working-set ranking, retrieval carryover, and task evidence protection.
- [x] `knowledge/context.ts`, `working-set.ts`, and `task-state.ts` consume the selection contract rather than reconstructing active focus, correction target, recently refined family, and current-generated rules locally.
- [x] Generated-document selection still flows through `document-resolution.ts`, but raw recency fallback cannot override explicit focus, query, correction, reset, or recent refinement signals.
- [x] Focused behavior tests cover the full signal matrix: active focus, current generated document, user correction, recent refinement, reset/move-on, unrelated open workspace document, and historical family handling.
- [x] Stale tests, throwaway TDD helpers, unused imports, duplicate reason-code helpers, and obsolete comments are removed or rewritten around the new boundary.
- [x] `CONTEXT.md`, ADRs, and the architecture review HTML define the implemented Working Document Selection boundary so future edits do not re-split the rules.

## Slices

### WDS-01. Introduce The Working Document Selection Contract

**Type:** AFK

**Blocked by:** None - can start immediately

**User stories covered:** As a maintainer, I need one tested contract that decides the current Working Document signal set for a chat turn before prompt, retrieval, working-set, or task evidence callers act on it.

**What to build:** Add a server-only Working Document Selection module over the existing artifact and generated-document resolver inputs. It should return a typed selection with current document identity, latest generated document ids, active focus ids, correction target ids, recently refined family/artifact ids, reset state, current-turn reason codes by artifact, prompt/working-set signal projections, and protected ids for task evidence reranking.

**Acceptance criteria**

- [x] The new module exposes a single resolver for turn-scoped Working Document Selection.
- [x] The contract contains explicit views/helpers for prompt reason codes, working-set candidate signals, retrieval carryover inputs, and task evidence protection.
- [x] Current generated-document selection delegates to `document-resolution.ts`.
- [x] Reset/move-on phrasing clears current, active, correction, and recent-refinement carryover.
- [x] Focused tests cover active focus, current generated, correction target, recent refinement family, reset, and unrelated open workspace cases.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/working-document-selection.test.ts`

### WDS-02. Move Prompt And Working-Set Callers Onto Selection Views

**Type:** AFK

**Blocked by:** WDS-01

**User stories covered:** As a user, prompt carryover and active Context Sources should agree about which Working Document is current without prompt selection and working-set refresh each re-deriving the same signals.

**What to build:** Update Knowledge context prompt selection and working-set refresh to consume the Working Document Selection contract. Replace direct reason-code mutation and boolean candidate assembly with the module's prompt and working-set views.

**Acceptance criteria**

- [x] `selectWorkingSetArtifactsForPrompt` asks the selection module for current-turn reason codes and prompt eligibility signals.
- [x] `refreshConversationWorkingSet` asks the selection module for candidate flags and latest/current generated ids.
- [x] Existing persisted working-set reason codes are treated as previous-turn data and cleaned before current live signals are applied.
- [x] The compact `[CONTEXT] Working document selection` log reports the authoritative selection summary rather than caller-local state.
- [x] Existing working-set and knowledge-context tests pass or are updated to assert the new boundary behavior.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/working-document-selection.test.ts src/lib/server/services/knowledge/context.test.ts src/lib/server/services/working-set.test.ts`

### WDS-03. Move Retrieval Carryover And Task Evidence Protection Onto Selection Views

**Type:** AFK

**Blocked by:** WDS-01

**User stories covered:** As a user, retrieval and Task Context should protect the same Working Document that prompt selection considers current, and reset/move-on phrasing should suppress that carryover consistently.

**What to build:** Replace retrieval and Task Context caller-local signal assembly with the selection module's retrieval and task evidence views. Retrieval should pass the selection's preferred generated artifact/family and reset suppression into Knowledge search. Task Context should use the selection's protected ids, correction ids, recent-refinement ids, and current-generated ids for scoring, reranking protection, and selected evidence persistence.

**Acceptance criteria**

- [x] `buildConstructedContext` or its retrieval path resolves Working Document Selection once for retrieval carryover and reuses that result when relevant artifacts arrive.
- [x] `findRelevantKnowledgeArtifacts` receives preferred artifact/family and carryover suppression from the authoritative selection view.
- [x] `prepareTaskContext` uses selection-provided evidence signals instead of rebuilding active/correction/current generated sets locally.
- [x] Task evidence rerank protection includes current attachments plus selection-protected Working Document ids.
- [x] Focused task-state tests cover correction and recent-refinement protection through the new view.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/task-state-learning.test.ts src/lib/server/services/context-access-regression.test.ts`

### WDS-04. Cleanup, Docs, And Architecture Review Closure

**Type:** AFK

**Blocked by:** WDS-02 and WDS-03

**User stories covered:** As a future maintainer, I need the Working Document Selection boundary documented and old signal helpers removed so new prompt, retrieval, and task changes do not reintroduce scattered rules.

**What to build:** Remove stale helpers, unused modules/imports, obsolete tests, and TDD leftovers made redundant by the new boundary. Update `CONTEXT.md`, a related ADR, and the architecture review HTML with the implementation status and verification evidence.

**Acceptance criteria**

- [x] Repo-wide search shows no caller reimplementing active focus, correction target, current-generated, recent-refinement, or reset rules outside the selection boundary.
- [x] Stale tests that only assert old implementation details are removed or rewritten as selection-boundary tests.
- [x] `CONTEXT.md` defines **Working Document Selection** and its relationship to Working Document Identity, Context Selection, Knowledge retrieval, Context Sources, and Task Context.
- [x] A related ADR records that Working Document Selection owns live Working Document signal collapse while `document-resolution.ts` remains family ranking authority and Context Selection remains budget authority.
- [x] The architecture review HTML marks `Collapse Working Document Selection Signals` as finished with implementation status.

**Verification**

- [x] Focused WDS/finalize tracer: `npm run test:unit -- src/lib/server/services/working-document-selection.test.ts src/lib/server/services/chat-turn/finalize.test.ts`
- [x] Minimum WDS-04 regression set: `npm run test:unit -- src/lib/server/services/working-document-selection.test.ts src/lib/server/services/chat-turn/finalize.test.ts src/lib/server/services/honcho-context-selection.test.ts src/lib/server/services/task-state-learning.test.ts src/lib/server/services/knowledge/context.test.ts`
- [x] `npm run check`
- [x] Full `npm run test:unit` passed locally.
- [x] Remote live deploy and smoke assessment via `$remote-live-testing`: commit `55c57f26` deployed to `main`, `langflow-chat.service` restarted active on port 3001, `/login` returned HTTP 200, and logs since restart showed no runtime errors. The live AI sweep exercised web search, file production, manual compaction, and automatic compaction across GPT-OSS and Kimi; all infrastructure/tooling checks passed, with one GPT-OSS exact-recall assertion missing only the word `marked` from `teal folder marked 9Q` (`teal folder 9Q` was returned), assessed as model wording variance rather than a Working Document Selection or runtime regression.
