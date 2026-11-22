# Actual AlfyAI baseline: runnable evaluation seams

2026-11-18. Source review only; no product changes or inference calls. Read the memory-profile, server-services and DB AGENTS before this review. This is a route to evaluating the real pipeline, not a replacement extractor or an already-run result.

## Run against an isolated database

Use an absolute scratch `DATABASE_PATH`, a synthetic `SESSION_SECRET`, and only synthetic user/provider rows. Set all environment values **before dynamic imports** because DB/env/config modules initialize at import time. `scripts/prepare-db.ts` runs actual migrations and loads `.env` with dotenv; explicit environment wins, but explicitly disable model 2 and unused network integrations so local `.env` cannot silently add them. Preparation also seeds default provider rows from the environment. Inspect the resulting rows/config without printing secrets.

Suggested process environment: `MODEL_1_BASEURL=http://127.0.0.1:<approved-proxy>/v1`, `MODEL_1_NAME=qwen3-6-27b`, synthetic `MODEL_1_API_KEY`, `MODEL_2_ENABLED=false`, `MEMORY_JUDGE_MODEL=model1`, `MEMORY_CONSOLIDATION_MODEL=model1`, `MEMORY_JUDGE_DRY_RUN=false`. Set TEI deliberately: blank TEI means the real implementation falls back to all active facts instead of semantic top-K, which must be reported; a production-configured semantic arm needs the actual embedding path/backfill. Do not import real account/provider/admin rows.

Run `DATABASE_PATH=<scratch> ... npm run db:prepare`, then a throwaway runner via `npx tsx --tsconfig <repo>/tsconfig.json <scratch-runner.ts>` using absolute imports into the repository. `env.ts` reads `process.env`, not Svelte virtual env modules. This route is source-supported; runtime module-resolution/dependency checks still belong to the runner. Call `refreshConfig()` and record resolved non-secret model/settings. Built-in model IDs prefer matching provider-table records, so checking environment alone is insufficient.

## Use actual ingestion and maintenance

1. Seed synthetic users/projects. Persist each frozen conversation with `createConversation(userId, title, {projectId})` and each source message with `createMessage(conversationId, role, content)`. This preserves real message sequence allocation. `createConversation` opportunistically starts an asynchronous judge flush; explicitly drain before beginning the next session to avoid races.
2. For a complete recorded turn, call `judgeFinishedTurn({userId,conversationId,userMessage,userMessageId,assistantMessageId,assistantResponse})`, the same finalizer dispatch used by the app. It chooses explicit/marathon/idle, marks dirty work and calls the real judge. If the frozen input contains user messages only, document the synthetic assistant placeholder convention or run the genuine segment path without inventing rich assistant evidence. Never replace it with a prompt copied from the judge.
3. Await `flushPendingJudgeRuns(userId)` at the benchmark's session boundary (accelerated idle completion), then `sweepDirtyConversations(userId)` while pending backlog remains. Verify `countUnjudgedMessages` reaches zero for each session and inspect telemetry/return statuses. A swallowed failure is not a successful empty-memory result. The loader processes oldest-first, at most 50 messages per pass.
4. Invoke `runUserMemoryConsolidation(userId, "synthetic benchmark day boundary")` at the frozen day boundaries. It executes the actual spine: dirty sweep, expiry/renewal, reconcile/merge, persona summary, then writes a report. Record succeeded/failed/skipped status; it catches errors rather than throwing them. No ordinary-user review acceptances should be fabricated. Review-queued items remain unavailable unless the fixture explicitly authorizes acceptance.

The actual call stack is `memory-control-model.ts → sendJsonControlMessage → normal-chat-model provider resolution`. Current memory code explicitly sets thinking off and uses its own token/schema/reasoning-fallback rules. Preserve these for the as-built baseline; borrowing Hindsight's reasoning setting would be a separate tuned AlfyAI arm.

## Retrieve through actual owners

The public tool entry is `getMemoryContext({userId,conversationId,mode:"persona",query,userDisplayName})` in `memory-context.ts`; it enforces memory controls and returns actual sanitized summary+facts at an 8,000-token base budget. Its semantic top-K activates above 12 facts only when TEI can produce a shortlist. The conversation's real project ID selects scope. Do not hand-pick profile rows or rescue omissions with the raw benchmark history.

Normal Chat's passive injection is different: `retrievePersonaMemory({userId,applicableScopes,includeSummary:false,applyShortlist:false,baseBudget})`, with budget from `deriveModelContextBudget` and `deriveBaselineMemoryProfileBudget`. It is facts-only. Capture both surfaces without extra inference. For comparison against Hindsight's forced recall, a labeled **actual AlfyAI persona-tool retrieval** arm is reasonable; it does not prove the live chat model would elect to call the tool. An actual full-chat benchmark would additionally need Normal Chat/tool selection and prompt assembly. Do not conflate those two questions.

Use the same frozen answer-model prompt/model/generation settings as the Hindsight arm if comparing memory evidence quality, while replacing only evidence with the real AlfyAI retrieval output. This keeps answer-model effects controlled; label it a service-level pipeline benchmark, not a deployed UI/whole-app score.

## Clock and fairness traps

- The frozen source chronology must be reflected in expiry, revision and consolidation timestamps. JS `Date.now/new Date` and SQLite `unixepoch()` defaults are separate clocks. Faking only JS Date can leave report timestamps later than all fact updates, causing false consolidation skips. Use a coherent synthetic-clock harness for both, or clearly disclose a narrower non-temporal test. Preserve session order and explicit reference dates exactly.
- `scripts/memory-judge-eval.ts` is a prompt/schema fixture evaluator with no real projection/consolidation/retrieval. It is not this baseline.
- Existing AlfyAI memory may reject or review a fact that Hindsight retains. Record stored/active/review/rejected states and admission telemetry, not only final answer score, so the comparison explains why.
- Do not insert expected answers or benchmark labels into memory. Keep users/projects isolated. Query only after the corresponding frozen history prefix, not after all future sessions.

## Owning source pointers

- `src/lib/server/services/memory-judge/dispatch.ts:52`, `runner.ts:78`, `segment.ts:58`, `index.ts:75`
- `src/lib/server/services/memory-consolidation/index.ts:169`, `spine.ts:31`
- `src/lib/server/services/memory-control-model.ts:75`
- `src/lib/server/services/memory-context.ts:38`, `memory-context/persona.ts:93`
- `src/lib/server/services/chat-turn/context-selection.ts:388`, `context-budget.ts:502`
- `src/lib/server/services/messages.ts:1011`, `conversations.ts:73`
- `src/lib/server/services/normal-chat-model/index.ts:490`, `src/lib/server/config-store.ts:1396`
- `scripts/prepare-db.ts:730`, `src/lib/server/db/index.ts:7`

## Project continuity and user-only sources — clarified follow-up

For a user-only fixture with no persisted assistant response, do **not** force `refreshConversationSummary`: the real post-turn tail calls it only when both user and assistant strings are nonempty. A neutral synthetic acknowledgement is a possible explicit benchmark convention, but it changes the fixture and must be disclosed; do not silently fabricate a substantive answer. With that convention, call the real service and let its own 40-character meaningful-turn threshold decide.

The minimal real task-state update needs no assistant row and accepts empty assistant prose:

```ts
await updateTaskStateCheckpoint({
  userId, conversationId, message: sourceText, assistantResponse: "",
  attachmentIds: [], promptArtifactIds: [],
  userMessageId, assistantMessageId: null,
});
```

This is the same service invoked by `persistAssistantTurnState`, with real routing/tracking, model-or-deterministic state update and checkpoint persistence. It does not need Knowledge work-capsule/artifact ingestion for these text-only continuity questions. `attachContinuityToTaskState` is currently a no-op. Configure `CONTEXT_SUMMARIZER_URL`, `CONTEXT_SUMMARIZER_API_KEY` and `CONTEXT_SUMMARIZER_MODEL` deliberately if testing the model-backed task-state path; leaving it unavailable selects the real deterministic fallback and must be reported.

Actual project summary reads project-folder siblings and prefers conversation summaries, falling back to their latest stable/micro task checkpoint or objective. It does not need all other memory/artifact ingestion to function. In contrast, project `detail` and `report` modes load actual persisted messages. Public `getMemoryContext({mode:"project", query})` chooses summary/report from its existing query rules; explicit detail requires a returned sibling ID. Do not force report mode or inject known answer-bearing source IDs merely because the fixture is tagged `project_continuity`.

History reads real persisted raw message snippets even without task-state/summaries, but intentionally excludes project-folder conversations. It therefore cannot be used as a generic fallback that searches every project's messages. Persona retrieval includes applicable global/current-project facts; cross-project personal facts work only if intake correctly made them globally applicable.

Normal Chat also has actual automatic sibling promotion, `selectProjectFolderSiblingPromotion`, ranking task/title/checkpoint evidence for the query and reading one matching sibling's recent messages. **It is only invoked in the deep constructed-context tier.** Unconditionally calling it would give short/simple turns capabilities they do not automatically receive. If passive Normal Chat fidelity is required, use `buildConstructedContext({userId,conversationId,message,modelId:"model1",attachmentIds:[]})` and retain its actual selection/budgets. Otherwise label the service-level retrieval arm as tool-assisted, with a frozen routing policy based on query and current project—not benchmark categories or expected answers.

Relevant owners: `chat-turn/finalize-steps.ts:178` / `:430`; `task-state.ts:1422`; `task-state/continuity.ts:248` / `:520` / `:868`; `memory-context/history.ts:201`; `memory-context/project.ts:440`; `chat-turn/context-selection.ts:1470` / `:1844` / `:1995`.
