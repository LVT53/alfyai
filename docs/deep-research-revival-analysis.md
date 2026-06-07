# Deep Research Revival: Comprehensive Analysis & Fix Guide

**Date:** 2026-06-07
**Status:** Analysis Phase — No Code Edits
**Scope:** Full audit of current Deep Research state, integration plan with Normal Chat, Qwen comparison, and future vision (Visual HTML output).

---

## 1. Executive Summary

AlfyAI's Deep Research is a **large, well-architected bounded subsystem** (~120+ files, 16 DB tables, ~3,000 LOC workflow engine) that was designed as a background research pipeline with its own worker, model runner, and evidence chain. It was paused mid-development — the infrastructure is largely complete but it was never fully wired into the new Normal Chat pipeline that was built concurrently.

The subsystem has significant architectural value: a sophisticated pass-based workflow (Discovery → Review → Synthesis → Citation Audit → Report), three-tier evidence outcomes (Research Report / Limited Research Report / Evidence Limitation Memo), and plan-health recovery for poisoned research plans. However, it currently **completely bypasses** Normal Chat's model execution, streaming, and finalization infrastructure, using its own parallel LLM runner (`model-runner.ts`) and its own concurrency/state management.

The recommended revival strategy is **not** to throw away this infrastructure. Instead, we should:

1. **Clean up** dead code paths and reconnect what already works
2. **Rewire** Deep Research as a **first-class Normal Chat tool** (`deep_research` tool in `normal-chat-tools/`) rather than a composer-level bypass
3. **Adopt** key Qwen innovations (IterResearch workspace model, forced-synthesis on context exhaustion)
4. **Evolve** the output format to include interactive HTML reports while keeping Markdown as the fallback

---

## 2. Current State Audit

### 2.1 Architecture Overview

Deep Research is designed as a **background job subsystem** with six lifecycle stages:

```
User Sends (with depth) → Job Shell Created → Research Plan Draft
  → Plan Edit Loop → Plan Approval → Background Worker Execution
  → Report Generation → Report Boundary (conversation sealed)
```

**Directory Structure:**
```
src/lib/server/services/deep-research/     (55 files)
  ├── index.ts          — Public facade (job start, approval, completion, report actions)
  ├── workflow.ts       — Core workflow engine (3020 LOC) — pass orchestration
  ├── worker.ts         — Tick-based background scheduler with concurrency control
  ├── model-runner.ts   — Deep Research LLM caller (parallel to normal-chat-model)
  ├── model-config.ts   — Per-role model ID resolution
  ├── planning.ts       — Plan generation/editing with structured output
  ├── planning-context.ts — Knowledge library + conversation context assembly
  ├── plan-health.ts    — Poisoned-plan detection and recovery
  ├── discovery.ts      — Web source discovery via SearXNG
  ├── source-review.ts  — Source triage, extraction, topic-relevance scoring
  ├── source-quality.ts — Quality signal scoring (independence, freshness, directness)
  ├── sources.ts        — Source CRUD, deduplication, citation marking
  ├── tasks.ts          — Research task creation, claiming, execution, barrier check
  ├── llm-steps.ts      — LLM step helpers (plan drafting, task execution, source review)
  ├── synthesis.ts      — Synthesis pass: distills evidence into findings
  ├── synthesis-claims.ts — Claim persistence, conflict detection
  ├── evidence-notes.ts — Evidence note persistence
  ├── citation-audit.ts — Citation verification against sources
  ├── citation-audit-verdicts.ts — Audit verdict persistence
  ├── coverage.ts       — Coverage gap detection across passes
  ├── pass-state.ts     — Pass checkpoint lifecycle
  ├── resume-points.ts  — Resume capability for interrupted jobs
  ├── report-writer.ts  — Final report generation + Markdown rendering
  ├── evaluation.ts     — Report quality scoring
  ├── timeline.ts       — Timeline event generation
  ├── usage.ts          — Usage record aggregation
  ├── diagnostics.ts    — DB integrity diagnostics
  └── language.ts       — Research language detection
```

**Database Tables (16):**
| Table | Purpose | Status |
|-------|---------|--------|
| `deep_research_jobs` | Main job state | Active |
| `deep_research_plan_versions` | Plan drafts/approvals | Active |
| `deep_research_timeline_events` | Activity log | Active |
| `deep_research_usage_records` | Cost tracking | Active |
| `deep_research_sources` | Discovered/reviewed/cited sources | Active |
| `deep_research_tasks` | Research task queue | Active |
| `deep_research_pass_checkpoints` | Pass-level state | Active |
| `deep_research_coverage_gaps` | Gap tracking | Active |
| `deep_research_resume_points` | Resume/retry state | Active |
| `deep_research_evidence_notes` | Extracted evidence | Active |
| `deep_research_synthesis_claims` | Synthesized claims | Active |
| `deep_research_claim_evidence_links` | Claim-evidence graph | Active |
| `deep_research_citation_audit_verdicts` | Citation audit results | Active |
| (Source quality signals) | JSON columns on sources | Active |
| (Topic relevance) | Columns on sources | Active |
| (Comparison axes) | JSON columns on plans | Active |

### 2.2 What Works (Functional Parts)

- **Job shell creation** — Fully functional via `startDeepResearchJobShell()`. Creates job, generates first plan draft via LLM, persists timeline.
- **Plan lifecycle** — Edit, approve, cancel all work. Plan versions are persisted and immutable after approval.
- **Concurrency/limit enforcement** — `assertCanStartDeepResearchJob()` checks conversation/user/global limits correctly.
- **Worker scheduler** — Tick-based worker with stale recovery, global/user concurrency, and step-by-step advancement.
- **Pass orchestration** — `workflow.ts` implements a sophisticated pass manager:
  - Discovery pass → Source review pass → Research task pass → Synthesis pass → Citation audit → Report assembly
  - Coverage assessment between passes with gap-based continuation
  - Repair passes for failed citation audits
  - Plan revision recovery for poisoned plans
- **Evidence pipeline** — Full chain from source discovery → topic-relevance scoring → evidence extraction → claim synthesis → citation audit → audited report.
- **Report rendering** — Markdown generation from structured report blocks with proper citation placement.
- **Three evidence outcomes** — Research Report, Limited Research Report, Evidence Limitation Memo with distinct handling.
- **Conversation sealing** — Completion of a valid report seals the conversation.
- **Report actions** — "Discuss Report" (spawns Normal Chat) and "Research Further" (extends the job) work via dedicated routes.
- **Admin config surface** — All worker/model/depth settings admin-overridable through `config-store.ts`.
- **i18n** — English and Hungarian strings for all timeline events, card labels, and plan UI.
- **Tests** — ~40 test files covering services, routes, components, and integration points.

### 2.3 What's Broken or Incomplete

1. **Stream route gap** — The `/api/chat/stream` endpoint does **not** handle `deepResearchDepth`. The streaming payload carries it, but the stream orchestrator has no branching logic for deep research. Sending a deep research request via stream would likely fall through to normal model execution (undefined behavior).

2. **Bypass of `finalizeChatTurn()`** — Deep Research turns skip `finalize.ts` entirely. This means:
   - No memory sync (Honcho mirroring)
   - No task-state updates
   - No analytics ingestion
   - No context compression integration
   - No evidence status linkage

3. **Duplicated model runner** — Deep Research has its own `model-runner.ts` with role-based model selection, while Normal Chat uses `normal-chat-model/`. These are parallel implementations with different failover, timeout, and usage recording logic. Consolidation would reduce maintenance burden.

4. **No streaming progress** — The worker advances jobs silently. The client polls for updates via `advanceDeepResearchWorkflow()` but there's no SSE push. Users see delayed progress updates.

5. **No tool integration** — Deep Research is NOT a Normal Chat tool. It's a composer-level mode switch. This prevents:
   - The model from autonomously deciding to do deep research
   - Composition with other tools (e.g., web search before deep research)
   - Graceful fallback to normal chat when deep research fails

6. **Isolated config surface** — Deep Research has its own model role assignments (`DEEP_RESEARCH_PLAN_MODEL`, etc.) separate from Normal Chat model config. This creates operational confusion.

7. **No client progress polling** — The client calls `advanceDeepResearchWorkflow()` manually but there's no automatic polling loop for job progress. The Research Card must be manually refreshed.

8. **`deep-research-models.ts` divergence** — Model role definitions are partially duplicated between `src/lib/deep-research-models.ts` and `src/lib/types.ts`, with slightly different structures.

9. **Legacy `src/lib/client/api/deep-research.test.ts`** — Browser API tests exist but may not reflect current endpoint contracts.

10. **Missing env var documentation** — No `.env.example` entries for any Deep Research environment variables despite `env.ts` parsing 15+ of them.

### 2.4 Integration Points with Normal Chat

| Integration Point | File | How it Works | Status |
|---|---|---|---|
| Send route fork | `api/chat/send/+server.ts` (lines 104-154) | When `deepResearchDepth` is set, bypasses Normal Chat entirely. Creates user message + job shell. | ✅ Working |
| Request parsing | `chat-turn/request.ts` | Parses `deepResearchDepth` from request body, forces `pendingSkill: null` | ✅ Working |
| Preflight bypass | `chat-turn/preflight.ts` | Skips linked-sources, skill-session, depth-clarification checks for DR | ✅ Working |
| Depth selection bypass | `chat-turn/depth-selection.ts` | Returns `constraintNote: "deep_research_bypass"` | ✅ Working |
| Client runtime adapter | `normal-chat-client-turn-runtime.ts` | `shouldStartDeepResearchJob()` / `startDeepResearchTurn()` hooks | ✅ Working |
| Conversation detail | `conversation-detail/read-model.ts` | Hydrates `deepResearchJobs` into conversation payload | ✅ Working |
| Streaming payload | `streaming.ts` | Carries `deepResearchDepth` in `StreamChatOptions` | ✅ Working |
| Conversation cleanup | `cleanup/conversation-cleanup.ts` | Cancels active DR jobs on conversation deletion | ✅ Working |
| Worker bootstrap | `hooks.server.ts` | Starts `ensureDeepResearchWorkerScheduler` on app boot | ✅ Working |
| **Stream route** | `api/chat/stream/+server.ts` | **NO deep research handling** | ❌ Gap |
| **Normal Chat tools** | `normal-chat-tools/` | **NO deep research tool** | ❌ Gap |
| **Finalize** | `chat-turn/finalize.ts` | **Bypassed entirely** | ❌ Gap |
| **Model runner** | `normal-chat-model/` | **Not used by Deep Research** | ❌ Separate |

---

## 3. Deep Research Pipeline Deep Dive

### 3.1 Job Lifecycle

```
[User Message Sent with Depth]
  → startDeepResearchJobShell()
    → assertCanStartDeepResearchJob()        (limit checks)
    → INSERT deep_research_jobs               (status: "awaiting_plan")
    → createFirstResearchPlanDraft()          (calls draftResearchPlanWithLlm)
    → saveResearchPlanDraft()                 (INSERT deep_research_plan_versions)
    → saveResearchTimelineEvent()             (plan_generation event)
    → saveResearchUsageRecord()               (cost tracking)

[Plan Edit]  ← editDeepResearchPlan()
  → createRevisedResearchPlanDraft()          (calls draftResearchPlanWithLlm with role="plan_revision")
  → INSERT new plan version                   (version incremented)

[Plan Approval]  ← approveDeepResearchPlan()
  → UPDATE plan_version SET status="approved"
  → UPDATE job SET status="approved", stage="plan_approved"
  → persistApprovedPlanSourceScope()          (if plan includes source scope)

[Worker Execution]  ← runDeepResearchWorkflowStep()
  → Resolves current stage from job state
  → Dispatches to appropriate pass handler
  → Each pass updates stage, creates resume points, saves timeline events
  → Completion callback: completeDeepResearchJobWithAuditedReport()
  → Seals conversation on report completion

[Report Actions]
  → Discuss: creates new conversation with report context as Normal Chat seed
  → Research Further: starts new Deep Research job seeded by report context
```

### 3.2 Worker Model

```
ensureDeepResearchWorkerScheduler()  [hooks.server.ts]
  → setInterval runDeepResearchWorkerTick (default: 60s)
    → recoverStaleDeepResearchJobs()  (jobs stuck >30min → reset to "running")
    → runNextDeepResearchWorkflowWorkerStep()
      → SELECT next eligible job (approved/running, respecting concurrency)
      → runDeepResearchWorkflowStep(job) 
        → Resolves current stage → dispatches pass handler
```

Key worker behaviors:
- **Global concurrency**: `DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY` (default: 2)
- **Per-user concurrency**: `DEEP_RESEARCH_WORKER_USER_CONCURRENCY` (default: 2)
- **Stale recovery**: Jobs in "running" state without updates for `staleTimeoutMs` (default: 30min) are reset
- **Runtime limit**: `DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS` (default: 2 hours) — exceeded jobs are cancelled
- **Resume points**: Every significant step is journaled; worker can resume from last checkpoint

### 3.3 Pass Architecture

The workflow engine (`workflow.ts`, 3020 LOC) implements a multi-pass iterative research cycle:

1. **Discovery Pass** (`runPublicWebDiscoveryPass`)
   - Uses existing SearXNG infrastructure from `research_web` tool
   - Discovers web sources based on plan key questions
   - Persists discovered sources with deduplication

2. **Source Review Pass** (`triageAndReviewSources`)
   - Topic-relevance scoring: is this source actually about the plan's topic?
   - Source quality signals: independence, freshness, directness, authority
   - Full-text extraction and LLM summarization (via `reviewSourceWithLlm`)
   - Off-topic sources are rejected with reason

3. **Research Task Pass**
   - Coverage gaps generate research tasks
   - Tasks are claimed, executed (via `executeResearchTaskWithLlm`), completed
   - Pass barrier: are all critical tasks done? Are coverage gaps addressed?
   - Failed tasks generate new coverage gaps for next pass

4. **Coverage Assessment** (`assessResearchCoverage`)
   - Evaluates whether key questions are sufficiently answered
   - Generates coverage gaps for missing evidence
   - Decides: continue with another pass or proceed to synthesis

5. **Synthesis Pass** (`buildSynthesisNotesWithLlm`)
   - Distills reviewed evidence notes into structured findings
   - Generates synthesis claims linked to source evidence
   - Identifies central claims vs. supporting claims

6. **Citation Audit Pass** (`auditAndPersistDeepResearchClaimGraph`)
   - Verifies each claim against its cited sources
   - Classifies verdicts: supported, unsupported_source, unsupported_claim, needs_repair
   - Failed claims trigger repair passes (up to `repairPassCeiling`)
   - If no supported claims remain → Evidence Limitation Memo

7. **Report Assembly Pass** (`writeResearchReportWithLlm`)
   - Generates structured report blocks from verified claims
   - Renders audited Markdown from structured blocks
   - Creates artifact with document family metadata
   - Seals conversation on completion

### 3.4 Evidence Outcome Model

Three distinct completion grades (ADR 0014):

| Outcome | Trigger | Behavior |
|---|---|---|
| **Research Report** | Sufficient supported evidence for full scope | Full report, conversation sealed |
| **Limited Research Report** | Partial evidence, narrowed scope possible | Report with explicit limitations, sealed |
| **Evidence Limitation Memo** | No useful synthesized answer possible | Memo explaining why, conversation NOT sealed |

### 3.5 Plan Health Recovery

When a run produces zero topic-relevant sources despite high review counts:

1. Plan Health Check detects plan poisoning (fake entities, domain mismatch, imperative-as-entity)
2. Creates "Research Plan Revision Needed" outcome with corrected plan draft
3. User reviews/approves corrected plan through same approval interface
4. Approved corrected plan continues SAME job with clean execution state
5. Poisoned run's sources/tasks retained as diagnostic history only

---

## 4. Normal Chat Integration Analysis

### 4.1 Current Bypass Pattern

The current integration is a **hard fork** at the composer/send level:

```
User types query → Selects "Deep Research: Standard" → Sends
  ↓
chat/send/+server.ts detects deepResearchDepth
  ↓
BYPASSES: runPlainNormalChatSendModel, stream-orchestrator, finalizeChatTurn
  ↓
Directly: creates user message → startDeepResearchJobShell → returns job
```

**Advantages:**
- Clean separation — no risk of Normal Chat accidentally doing deep research
- DR-specific limits enforced at the right boundary
- No streaming confusion

**Disadvantages:**
- Model can't autonomously choose deep research (it's a human UI toggle only)
- No composition with other tools (can't search web first, then deep research)
- Duplicated LLM execution — `deep-research/model-runner.ts` vs. `normal-chat-model/`
- No memory sync, analytics, or task-state updates for DR turns
- Bypasses web grounding, citation quality gate, and evidence family infrastructure
- Streaming path is entirely untested for DR

### 4.2 Gap Analysis

| Gap | Severity | Impact |
|-----|----------|--------|
| Stream route no DR handling | High | `/api/chat/stream` would crash or behave unpredictably with DR depth |
| No finalize integration | Medium | Memory, analytics, task-state not updated for DR turns |
| Duplicated model runner | Medium | Maintenance burden, inconsistent failover behavior |
| No client polling | Medium | User sees stale Research Card until manual refresh |
| No tool composition | Low | Model can't chain tools before/after DR |

### 4.3 Proposed Integration Strategies

**Strategy A: Keep Bypass, Fix Gaps (Minimal)**
- Fix stream route to handle DR depth (reject or redirect to send-like behavior)
- Add minimal finalize call for DR turns (memory sync only)
- Add client-side polling to ResearchCard

**Strategy B: Tool Integration (Recommended)**
- Add `deep_research` as a Normal Chat tool in `normal-chat-tools/`
- Model autonomously decides to use deep research via tool call
- Tool execution: `deep_research` tool → starts job shell → returns job reference
- DR job execution remains in background worker (unchanged)
- DR job completion → injects result as tool output → model can respond
- Benefits: model agency, tool composition, unified execution path

**Strategy C: Full Pipeline Merge (Ambitious)**
- Replace DR's `model-runner.ts` with `normal-chat-model/` for all LLM calls
- Thread DR passes through `stream-orchestrator.ts` for streaming progress
- Use `finalize.ts` for all persistence/sync
- Massive refactor, high risk

**Recommendation:** Start with Strategy A (fix immediate gaps), then implement Strategy B (tool integration) as the primary architecture. Strategy C is deferred as a long-term cleanup after proving Strategy B.

---

## 5. Qwen DeepResearch Comparison

### 5.1 Architecture Comparison

| Dimension | AlfyAI Deep Research | Qwen (Tongyi) DeepResearch |
|-----------|---------------------|----------------------------|
| **Model approach** | Any OpenAI-compatible model, role-specific assignments | Specialized 30B MoE model (Qwen3-based, 3.3B active/token) |
| **Training** | Prompt engineering + structured output | End-to-end: CPT → SFT → RL (GRPO) with synthetic data flywheel |
| **Inference paradigm** | Explicit pass-based workflow (7 named passes) | ReAct loop + IterResearch (Heavy Mode) |
| **Context management** | Fixed budgets per pass | 128K context, 110K hard limit, forced synthesis on exhaustion |
| **Web search** | SearXNG (self-hosted) + crawl/extract | Serper.dev API + Jina AI Reader |
| **Page reading** | Local Readability + optional Crawl4AI fallback | Jina AI → LLM extraction with retry + truncation |
| **Source quality** | Multi-signal scoring (independence, freshness, directness, authority) | Relies on LLM extraction quality + implicit authority from Serper ranking |
| **Evidence verification** | Formal citation audit with per-claim verification | Implicit via IterResearch workspace reconstruction |
| **Output** | Structured report blocks → Markdown rendering | ReAct: `<answer>` tags; Heavy Mode: structured reports with streaming phases |
| **Resume/retry** | Full resume-point journal with pass checkpoints | Relies on external process management |
| **Parallel execution** | Research tasks run in parallel within a pass | Multiple parallel Research Agents with Fusion Agent for synthesis |
| **Deployment** | Single Node.js process + SQLite | Python + vLLM (8x GPU) or OpenRouter API |
| **License** | Proprietary (this codebase) | Apache 2.0 |

### 5.2 Key Qwen Innovations Worth Adopting

#### 5.2.1 IterResearch Workspace Model

Qwen's "Heavy Mode" solves the core long-context problem elegantly:

```
Round N:   [Question] + [Previous Report] + [Last Interaction] → Think → Report → Action
Round N+1: [Question] + [Updated Report]   + [Last Interaction] → Think → Report → Action
```

The **Report** is an evolving synthesis document carried forward as central memory. The **Think** block is private (not passed forward). The **Workspace** stays lean because only the synthesized report (not raw search results) propagates.

**Adaptation for AlfyAI:**
Instead of passing all reviewed source notes between passes, synthesize a **Pass Report** after each pass. The next pass receives only the Pass Report + the key question it needs to answer, not the full evidence dump. This would:
- Keep per-pass context within budget
- Reduce "cognitive suffocation" from too many raw notes
- Enable more passes without context explosion

#### 5.2.2 Forced Synthesis on Context Exhaustion

When Qwen's agent hits the 110K token ceiling, it is **forced** to produce a synthesis rather than continuing to search. This prevents infinite loops.

**Adaptation for AlfyAI:**
Add a hard context limit per pass. When the current evidence + notes approach the budget, force a synthesis pass rather than continuing discovery/review.

#### 5.2.3 Multi-Agent Parallel Execution

Qwen runs multiple parallel Research Agents exploring different angles, then fuses results with a dedicated Fusion Agent.

**Adaptation for AlfyAI:**
Our parallel research tasks already exist, but they're question-scoped. Add a **Fusion Synthesizer** step that takes outputs from all parallel tasks and produces a unified synthesis, detecting conflicts and complementarity.

#### 5.2.4 Round-Based Decomposition

Heavy Mode explicitly decomposes research into discrete rounds with clear purpose per round.

**Adaptation for AlfyAI:**
Our pass system already does this, but passes are fixed (discovery → review → synthesis → audit). Consider making passes more flexible: model-driven round planning where each round has a specific research question to answer.

### 5.3 What NOT to Adopt

- **Custom model training** — Qwen's 30B MoE with CPT/SFT/RL is a massive investment. We use general-purpose models.
- **Serper.dev dependency** — We already have SearXNG self-hosting. Keep it.
- **Jina AI dependency** — We have local Readability + Crawl4AI.
- **vLLM GPU serving** — We're a Node.js app, not a Python ML serving stack.
- **Synthetic data flywheel** — Overkill for our scope; we don't need to generate training data.

### 5.4 The "Adapt vs. Revive" Verdict

**Adapt Qwen's IDEAS, revive our INFRASTRUCTURE.**

Our pass-based workflow, evidence pipeline, citation audit, and three-tier outcome model are already superior in several ways (formal verification, topic relevance, plan health recovery). Qwen's strengths are in:
- The IterResearch workspace model (solves context explosion)
- Forced synthesis triggers (prevents infinite loops)
- Multi-agent fusion (better parallel exploration)

These are architectural patterns we can implement on top of our existing infrastructure without replacing it.

---

## 6. Revival Strategy & Fix Guide

### Phase 1: Clean Up & Reconnect (Week 1-2)

**Goal:** Get Deep Research into a functional, testable state with minimal Normal Chat integration.

#### 1.1 Fix Critical Gaps

| Task | Files | Description |
|------|-------|-------------|
| **Stream route DR handling** | `api/chat/stream/+server.ts`, `chat-turn/stream-orchestrator.ts` | Detect `deepResearchDepth` in stream requests. Return `400 Bad Request` with "Deep Research requires the send endpoint, not streaming" error code. Or: fork into the same job-shell path as send route. |
| **Add minimal finalize call** | `api/chat/send/+server.ts` (DR branch), `chat-turn/finalize.ts` | After `startDeepResearchJobShell`, call a simplified finalize that records analytics and triggers memory maintenance. Don't create an assistant message. |
| **Fix `.env.example`** | `.env.example` | Add all 15+ `DEEP_RESEARCH_*` env vars with defaults and descriptions. |
| **Consolidate type definitions** | `src/lib/types.ts`, `src/lib/deep-research-models.ts` | Move model role definitions to single location. Keep `deep-research-models.ts` for budget policy and normalization helpers only. |

#### 1.2 Remove Legacy/Dead Code

| Task | Files | Description |
|------|-------|-------------|
| **Remove model-runner duplication** | `deep-research/model-runner.ts` | Audit: does this add value over `normal-chat-model/`? If not, migrate DR to use normal-chat-model with role-specific model selection passed as parameter. If yes, document why. |
| **Remove duplicated config parsing** | `deep-research/model-config.ts` | This wraps `config-store.ts` — verify it doesn't duplicate env parsing logic already in `env.ts`. |
| **Clean up test files** | `src/lib/client/api/deep-research.test.ts` | Verify tests match current contracts. Remove tests for deleted endpoints. |
| **Remove `llm-json.ts` if redundant** | `deep-research/llm-json.ts` | Check if this duplicates `src/lib/server/utils/json.ts`. Consolidate if so. |

#### 1.3 Add Client-Side Polling

| Task | Files | Description |
|------|-------|-------------|
| **Auto-poll Research Card** | `ResearchCard.svelte`, chat page | Add `setInterval` polling of `advanceDeepResearchWorkflow()` while job is active. Update card on each response. Stop polling on completion/failure/cancellation. |
| **Worker SSE push (optional)** | `worker.ts`, chat page | Emit SSE events on job stage transitions. Client subscribes via EventSource. Better UX than polling but more complex. |

### Phase 2: Rewire as Normal Chat Tool (Week 3-5)

**Goal:** Deep Research becomes a model-callable tool, not a UI toggle.

#### 2.1 Create `deep_research` Tool

```typescript
// New file: src/lib/server/services/normal-chat-tools/deep-research.ts

import { z } from "zod";

export const deepResearchInputSchema = z.object({
  depth: z.enum(["focused", "standard", "max"]).default("standard"),
  researchQuestion: z.string().min(10).describe(
    "The specific research question to investigate deeply"
  ),
  contextSummary: z.string().optional().describe(
    "Brief summary of what's already known, to avoid redundant research"
  ),
});

export type DeepResearchInput = z.infer<typeof deepResearchInputSchema>;
```

#### 2.2 Tool Execution Envelope

```
Model calls deep_research(depth="standard", researchQuestion="...")
  ↓
Tool executor in normal-chat-tools/shared.ts
  ↓
Creates Deep Research job via startDeepResearchJobShell()
  ↓
Returns job reference to model:
  {
    jobId: "...",
    status: "awaiting_approval",
    planSummary: { ... },
    message: "I've drafted a research plan. Review and approve it to begin investigation."
  }
  ↓
Model responds to user: "I've created a Deep Research plan to investigate [topic]. 
Please review and approve the plan in the Research Card below."
  ↓
Research Card appears in chat (same component, new integration point)
  ↓
User approves → Worker executes → Report generated
  ↓
Report artifact linked to conversation, visible in Research Card
```

#### 2.3 Integration Points to Modify

| File | Change |
|------|--------|
| `normal-chat-tools/index.ts` | Register `deep_research` tool (gated by `deepResearchEnabled` config) |
| `normal-chat-tools/shared.ts` | Add tool execution envelope for deep research (different lifecycle from normal tools) |
| `normal-chat-context.ts` | Add tool description to system prompt when deep research is enabled |
| `api/chat/send/+server.ts` | **Remove** the hard fork for DR. Let it flow through normal model execution. The model calls the tool, tool starts the job. |
| `chat-turn/finalize.ts` | Add DR-specific finalization: associate job ID with assistant message |
| `ResearchCard.svelte` | Support rendering from tool-call context (not just from page-level `deepResearchJobs` array) |

#### 2.4 Deprecate Composer Depth Selector

The existing depth selector in `MessageInput.svelte` becomes:
- **Option A:** A convenience shortcut that pre-fills a `deep_research` tool call in the system prompt ("The user wants to use Deep Research at Standard depth for this query. Call the deep_research tool.")
- **Option B:** Removed entirely; the model decides based on the user's natural language request

Recommendation: Keep as a shortcut (Option A) for power users, but let the model decide autonomously when not pre-selected.

### Phase 3: Qwen-Inspired Improvements (Week 6-8)

#### 3.1 IterResearch Workspace Model

Modify the pass system to use a compressed "Pass Report" as central memory rather than raw evidence dumps:

```
Current:    Pass N sees ALL reviewed source notes from ALL previous passes
Proposed:   Pass N sees Pass Report from Pass N-1 + its own discovered sources
```

**Implementation:**
- After each pass, generate a structured Pass Report (key findings, open questions, evidence gaps)
- Store Pass Report in `deep_research_pass_checkpoints`
- Next pass's LLM prompt includes only the latest Pass Report, not raw notes from earlier passes
- Raw notes remain accessible for citation audit but not passed to the LLM

#### 3.2 Forced Synthesis Trigger

Add hard context limits per pass:

```typescript
// In workflow.ts, before each LLM call:
const currentContextTokens = estimateTokens(prompt);
const maxPassTokens = plan.researchBudget.maxPassContextTokens ?? 80000;

if (currentContextTokens > maxPassTokens) {
  // Force synthesis instead of continuing discovery
  return transitionToSynthesisPass(job, plan, "context_exhausted");
}
```

#### 3.3 Multi-Agent Fusion

After parallel research tasks complete, add a Fusion Synthesizer step:

```
Task 1 (Architecture patterns) → Output A
Task 2 (Performance benchmarks) → Output B
Task 3 (Security considerations) → Output C
  ↓
Fusion Synthesizer:
  - Detects conflicts between outputs (e.g., A says X is fast, B says X is slow)
  - Identifies complementary findings
  - Produces unified synthesis with conflict annotations
  ↓
Unified Synthesis → Citation Audit → Report
```

#### 3.4 Round-Based Planning

Allow the model to plan research rounds dynamically rather than fixed passes:

```typescript
type ResearchRound = {
  roundNumber: number;
  purpose: string;  // "Investigate architecture patterns for microservices"
  keyQuestions: string[];
  expectedOutputs: string[];
};

type DynamicResearchPlan = {
  rounds: ResearchRound[];
  maxRounds: number;
  stoppingCriteria: string[];
};
```

### Phase 4: Visual HTML Reports (Week 9-12)

**Goal:** Interactive HTML website output from Deep Research, with Markdown as optional fallback.

#### 4.1 Design Principles

- **Reading-first, not dashboard-like** — Keep the AlfyAI design language (serif body text, generous spacing, quiet chrome)
- **Progressive enhancement** — HTML adds interactivity (collapsible sections, sortable tables, filterable comparisons) but works without JavaScript
- **Self-contained** — Single HTML file with inline CSS (no external dependencies)
- **Printable** — Print stylesheet for PDF-quality output
- **Accessible** — Semantic HTML, ARIA labels, keyboard navigable

#### 4.2 Output Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deep Research: [Title]</title>
  <style>
    /* Inline CSS with AlfyAI design tokens */
  </style>
</head>
<body>
  <article class="research-report" data-report-kind="research_report">
    <!-- Title & Metadata -->
    <header class="report-header">
      <h1 class="report-title">[Title]</h1>
      <div class="report-meta">
        <span class="report-depth">Standard Depth</span>
        <span class="report-date">June 2026</span>
        <span class="report-sources">42 sources reviewed, 18 cited</span>
      </div>
    </header>

    <!-- Executive Summary (always visible) -->
    <section class="executive-summary" id="summary">
      <h2>Executive Summary</h2>
      <div class="key-finding">
        <span class="finding-label">Key Finding:</span>
        <p>[Primary finding from research]</p>
      </div>
    </section>

    <!-- Recommendation (if applicable) -->
    <section class="recommendation" id="recommendation">
      <h2>Recommendation</h2>
      <div class="recommendation-card">
        <div class="recommendation-choice">[Primary recommendation]</div>
        <div class="recommendation-rationale">[Why this is recommended]</div>
        <div class="recommendation-confidence">
          Confidence: <span class="confidence-badge confidence-high">High</span>
        </div>
      </div>
    </section>

    <!-- Comparison Matrix (interactive) -->
    <section class="comparison-matrix" id="comparison">
      <h2>Comparison</h2>
      <div class="matrix-controls">
        <button class="matrix-sort" data-sort="name">Sort by Name</button>
        <button class="matrix-sort" data-sort="score">Sort by Score</button>
        <button class="matrix-filter" data-filter="highlight">Highlights Only</button>
      </div>
      <table class="comparison-table">
        <thead>
          <tr>
            <th>Aspect</th>
            <th>Option A</th>
            <th>Option B</th>
            <th>Option C</th>
          </tr>
        </thead>
        <tbody>
          <!-- Comparison rows with color-coded cells -->
        </tbody>
      </table>
    </section>

    <!-- Detailed Findings (collapsible) -->
    <section class="findings" id="findings">
      <h2>Detailed Findings</h2>
      <details class="finding-section" open>
        <summary>
          <h3>Architecture Patterns</h3>
          <span class="source-count">8 sources</span>
        </summary>
        <div class="finding-content">
          <!-- Rich text with inline citations -->
        </div>
      </details>
    </section>

    <!-- Evidence Table (sortable, filterable) -->
    <section class="evidence-table" id="evidence">
      <h2>Evidence Summary</h2>
      <div class="table-toolbar">
        <input type="search" placeholder="Filter evidence..." class="evidence-search">
        <select class="evidence-topic-filter">
          <option value="all">All Topics</option>
          <!-- Topic options -->
        </select>
      </div>
      <table class="evidence-rows">
        <thead>
          <tr>
            <th class="sortable">Source</th>
            <th class="sortable">Claim</th>
            <th class="sortable">Support</th>
            <th class="sortable">Quality</th>
          </tr>
        </thead>
        <tbody>
          <!-- Evidence rows -->
        </tbody>
      </table>
    </section>

    <!-- Source Ledger (collapsible appendix) -->
    <section class="source-ledger appendix" id="sources">
      <h2>Sources</h2>
      <details>
        <summary>18 Cited Sources</summary>
        <ol class="source-list">
          <li class="source-item" data-source-id="src_001">
            <a href="[URL]" class="source-link" target="_blank" rel="noopener">
              <span class="source-number">[1]</span>
              <span class="source-title">[Title]</span>
            </a>
            <span class="source-type">Academic Paper</span>
            <span class="source-date">2025</span>
            <div class="source-note">[Citation context]</div>
          </li>
        </ol>
      </details>
    </section>

    <!-- Limitations -->
    <section class="limitations appendix" id="limitations">
      <h2>Limitations</h2>
      <ul>
        <li>[Limitation with explanation]</li>
      </ul>
    </section>

    <!-- Citation Audit (collapsible appendix) -->
    <section class="citation-audit appendix" id="audit">
      <details>
        <summary>Citation Audit Results</summary>
        <!-- Per-claim verdicts -->
      </details>
    </section>

    <footer class="report-footer">
      <p>Generated by AlfyAI Deep Research · [Date] · [Duration]</p>
    </footer>
  </article>

  <script>
    // Minimal vanilla JS for interactivity (sortable tables, collapsible sections, search/filter)
    // All functionality degrades gracefully without JS
  </script>
</body>
</html>
```

#### 4.3 Technical Implementation

**Server-side (report-writer.ts modifications):**

```typescript
// New function in report-writer.ts
export function renderResearchReportHtml(
  draft: DeepResearchReportDraft,
  auditedReport: AuditedReport,
  sources: ResearchSource[],
  researchLanguage: string,
): string {
  // 1. Build HTML document structure from structured report blocks
  // 2. Apply AlfyAI design tokens as inline CSS
  // 3. Embed minimal vanilla JS for interactivity
  // 4. Return self-contained HTML string
}

// Modify existing artifact creation to store BOTH formats:
await createArtifact({
  // ... existing fields
  contentText: auditedMarkdown,        // Markdown (always generated)
  contentHtml: auditedHtml,            // HTML (new, primary viewing format)
  extension: "html",                   // Primary extension is HTML
  mimeType: "text/html",
  metadata: {
    // ... existing metadata
    deepResearchOutputFormats: ["html", "markdown"],
    deepResearchPrimaryFormat: "html",
  },
});
```

**Client-side (new component):**

```svelte
<!-- New file: src/lib/components/document-workspace/DeepResearchReportViewer.svelte -->
<script lang="ts">
  // Renders the HTML report in a sandboxed iframe for security
  // Provides tabs: "Interactive Report" (HTML) | "Plain Text" (Markdown)
  // Includes print button, download button, share button
</script>
```

#### 4.4 Viewing Experience

The report can be viewed three ways:

1. **Embedded in Research Card** — Collapsible preview with "Open Full Report" button
2. **Full-screen viewer** — Opens in DocumentWorkspace with the HTML rendered in a sandboxed iframe
3. **Downloaded as HTML file** — Self-contained file, openable in any browser

The Markdown version remains available:
- As a fallback when HTML rendering is unavailable
- For users who prefer plain text
- For programmatic consumption (API access)

#### 4.5 Design Tokens for Reports

Reports should use the same design tokens as the main app:

```css
:root {
  /* From src/app.css */
  --font-body: 'Libre Baskerville', Georgia, serif;
  --font-ui: 'Nimbus Sans L', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  
  /* Semantic surfaces */
  --surface-default: #ffffff;
  --surface-subtle: #f8f9fa;
  --surface-emphasis: #f0f1f3;
  
  /* Semantic text */
  --text-primary: #1a1a2e;
  --text-secondary: #4a4a6a;
  --text-tertiary: #6b7280;
  
  /* Status colors for evidence strength */
  --status-supported: #10b981;
  --status-partial: #f59e0b;
  --status-unsupported: #ef4444;
  
  /* Spacing scale */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;
}
```

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DR worker deadlocks on high load | Medium | High | Concurrency limits already in place; add circuit breaker for LLM timeouts |
| Context explosion in long DR passes | High | Medium | Implement Qwen-style forced synthesis trigger (Phase 3.2) |
| Model doesn't use `deep_research` tool reliably | Medium | Medium | Keep composer depth selector as shortcut (Phase 2.4 Option A) |
| Tool integration breaks Normal Chat | Medium | High | Feature-flag DR tool behind `deepResearchEnabled`; gradual rollout |
| HTML reports don't render on all devices | Low | Medium | Use semantic HTML5 + CSS Grid (well-supported); test on major browsers |
| Duplicated model runners cause cost confusion | Medium | Low | Migrate to unified model execution (Phase 3+) |
| Migration from bypass to tool breaks existing DR flows | High | Medium | Maintain backward compatibility during transition; deprecate old path after tool path proven |

---

## 8. Implementation Order (Priority-Ordered)

### Immediate (Now — unblocks everything)

1. **Fix `.env.example`** with all `DEEP_RESEARCH_*` env vars
2. **Fix stream route** to handle `deepResearchDepth` (return error, don't crash)
3. **Add client-side auto-polling** to ResearchCard

### Short-term (Next sprint)

4. **Add minimal finalize call** for DR turns
5. **Consolidate type definitions** (`types.ts` + `deep-research-models.ts`)
6. **Audit `model-runner.ts`** — document or remove duplication
7. **Fix/update test files** for current contracts

### Medium-term (1-2 months)

8. **Implement `deep_research` Normal Chat tool** (Phase 2.1-2.3)
9. **Implement IterResearch workspace model** (Phase 3.1)
10. **Implement forced synthesis trigger** (Phase 3.2)

### Long-term (2-3 months)

11. **Multi-agent fusion synthesizer** (Phase 3.3)
12. **Round-based dynamic planning** (Phase 3.4)
13. **Visual HTML reports** (Phase 4)
14. **Document Workspace integration** for HTML report viewing

---

## Appendix A: File Inventory Reference

### Source files (~120 files)

```
src/lib/server/services/deep-research/
  index.ts, workflow.ts, worker.ts,
  model-runner.ts, model-config.ts, model-config.test.ts, model-runner.test.ts,
  planning.ts, planning.test.ts, planning-context.ts, planning-context.test.ts,
  plan-health.ts,
  discovery.ts, discovery.test.ts,
  source-review.ts, source-review.test.ts, source-quality.ts,
  sources.ts, sources.test.ts,
  tasks.ts, tasks.test.ts,
  llm-steps.ts, llm-steps.test.ts, llm-json.ts, llm-json.test.ts,
  synthesis.ts, synthesis-claims.ts, synthesis-claims.test.ts,
  evidence-notes.ts, evidence-notes.test.ts,
  citation-audit.ts, citation-audit.test.ts,
  citation-audit-verdicts.ts, citation-audit-verdicts.test.ts,
  coverage.ts, coverage.test.ts,
  pass-state.ts, pass-state.test.ts,
  resume-points.ts,
  report-writer.ts, report-writer.test.ts, report-completion.test.ts,
  report-readability-fixtures.test.ts,
  evaluation.ts, evaluation.test.ts,
  timeline.ts, timeline.test.ts,
  usage.ts, usage.test.ts,
  diagnostics.ts, language.ts, language.test.ts,
  index.test.ts, workflow.test.ts, worker.test.ts

src/routes/api/deep-research/
  jobs/[id]/cancel/+server.ts, cancel.test.ts
  jobs/[id]/plan/approve/+server.ts, approve.test.ts
  jobs/[id]/plan/edit/+server.ts, edit.test.ts
  jobs/[id]/workflow/advance/+server.ts, advance.test.ts
  jobs/[id]/worker/advance/+server.ts, advance.test.ts
  jobs/[id]/report-actions/discuss/+server.ts, discuss.test.ts
  jobs/[id]/report-actions/research-further/+server.ts, research-further.test.ts
  deep-research-dev-control.test.ts

src/lib/
  types.ts (DeepResearch types), deep-research-models.ts
  client/api/deep-research.ts, deep-research.test.ts

src/lib/components/chat/
  ResearchCard.svelte, ResearchCard.test.ts
  MessageInput.svelte, MessageInput.test.ts
  MessageArea.svelte, MessageArea.test.ts

src/routes/(app)/chat/[conversationId]/
  +page.svelte, _helpers.ts, _helpers.test.ts
  _components/ChatMessagePane.svelte, ChatComposerPanel.svelte

src/lib/server/
  env.ts (15+ DEEP_RESEARCH_* vars)
  config-store.ts (runtime overrides)
  hooks.server.ts (worker scheduler bootstrap)
  db/schema.ts (12 deep research tables)

src/lib/i18n/
  chat.ts, settings.ts (DR UI strings, EN/HU)

docs/
  deep-research-roadmap.md, deep-research-quality-slices.md
  deep-research-stabilization-slices.md, deep-research-stabilization-review.md
  adr/0001-deep-research-bounded-subsystem.md
  adr/0007-structured-deep-research-report-rendering.md
  adr/0014-deep-research-three-evidence-outcomes.md
```

### Database migrations (16 files)

```
drizzle/1777140000012_deep_research_jobs.sql
drizzle/1777140000013_deep_research_plan_versions.sql
drizzle/1777140000014_deep_research_timeline_usage.sql
drizzle/1777140000015_deep_research_report_artifact.sql
drizzle/1777140000016_deep_research_sources.sql
drizzle/1777140000017_deep_research_tasks.sql
drizzle/1777140000018_deep_research_quality_metadata.sql
drizzle/1777140000019_deep_research_topic_relevance.sql
drizzle/1777140000020_deep_research_pass_state.sql
drizzle/1777140000021_deep_research_resume_points.sql
drizzle/1777140000022_deep_research_evidence_notes.sql
drizzle/1777140000023_deep_research_source_quality_signals.sql
drizzle/1777140000024_deep_research_synthesis_claims.sql
drizzle/1777140000025_deep_research_citation_audit_verdicts.sql
drizzle/1777140000026_deep_research_comparison_axes.sql
drizzle/1777140000027_deep_research_drop_active_conversation_unique.sql
```

---

## Appendix B: Qwen Comparison Quick Reference

| Feature | AlfyAI DR | Qwen DR | Adapt? |
|---------|----------|---------|--------|
| IterResearch workspace | ❌ Not implemented | ✅ Core feature | **Yes** — Phase 3.1 |
| Forced synthesis trigger | ❌ Not implemented | ✅ At 110K tokens | **Yes** — Phase 3.2 |
| Multi-agent fusion | ⚠️ Parallel tasks, no fusion | ✅ Fusion Agent | **Yes** — Phase 3.3 |
| Round-based planning | ❌ Fixed passes | ✅ Dynamic rounds | **Optional** — Phase 3.4 |
| Citation audit | ✅ Formal per-claim verification | ❌ Implicit via workspace | **Keep ours** |
| Topic relevance scoring | ✅ Multi-signal quality check | ❌ Relies on LLM extraction | **Keep ours** |
| Plan health recovery | ✅ Plan revision for poisoned plans | ❌ Not implemented | **Keep ours** |
| Three evidence outcomes | ✅ Report / Limited / Memo | ❌ Binary pass/fail | **Keep ours** |
| Synthetic data training | N/A | ✅ CPT + SFT + RL | **Skip** |
| Self-hosted search | ✅ SearXNG | ❌ Serper.dev API | **Keep ours** |
| Streaming progress | ❌ Polling only | ✅ SSE phases | **Add** — Phase 1.3 |

---

*This document was generated by Sisyphus on 2026-06-07 after a comprehensive codebase audit, exploration of all Deep Research files, analysis of Normal Chat integration points, and thorough comparison with Qwen (Tongyi) DeepResearch. No code was edited during this analysis phase.*
