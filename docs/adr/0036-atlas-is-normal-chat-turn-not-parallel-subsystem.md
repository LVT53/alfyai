# Atlas is a Normal Chat Turn + artifact, not a parallel background subsystem

The previous Deep Research feature was a massive parallel background subsystem — 16 database tables, 7 configurable LLM roles, a 60-second-tick worker, a duplicated model runner, and a human-in-the-loop plan approval gate. It bypassed Normal Chat Turn Completion entirely, never integrated with streaming, and "literally never worked reliably and always showed bullshit." We are replacing it with **Atlas**: a durable report artifact produced by a special kind of Normal Chat Turn that runs an enforced multi-stage research pipeline through the existing `normal-chat-model`, `research_web`, `produce_file`, and `finalizeChatTurn` infrastructure. The research pipeline runs as a background job (reusing the file-production job pattern), but the Atlas Turn itself flows through Normal Chat Turn Completion like any other turn. There are 2 new tables (not 16), no duplicated model runner, no plan approval gate, and no parallel subsystem.

## Considered Options

1. **Atlas as a Normal Chat Turn + artifact (chosen)** — the turn creates a job, the job runs the 7-stage pipeline in the background, the turn completes through `finalizeChatTurn`, the artifact is stored via file-production. The server orchestrates a fixed stage sequence (decompose → search → curate → synthesize → integrate → assemble → audit); the model fills in content within each stage. Quality gates replace plan approval. 2 tables. Reuses 80% of existing infrastructure.

2. **Fixed background worker subsystem (rejected)** — keep the old architecture but fix the 10 identified failure modes (wire streaming, use `normal-chat-model`, integrate `finalizeChatTurn`, make it a tool). Rejected because the subsystem complexity itself was a root cause of failure: 16 tables, 7 model roles, 15 env vars, plan-approval state machine, duplicated runner. Fixing all of that while keeping the shape would still leave a maintenance burden and integration surface that a Normal Chat Turn does not have.

3. **Atlas as a Skill Session (rejected)** — a persistent skill that changes model behavior for research-heavy conversations, with the report emitted via `produce_file` at session end. Rejected because skills shape prompts and session behavior, not multi-step tool loops with enforced stage sequences. The skill system is about instruction injection, not pipeline orchestration.

## Consequences

- Atlas cannot run as a fully synchronous streamed turn for long research (10-30 minutes). It creates a background job instead, which means the user can leave the page. This is a deliberate trade: we lose in-stream token streaming but gain fire-and-forget UX and avoid holding a stream slot for 20 minutes.
- The server-orchestrated fixed pipeline means the model cannot deviate from the stage sequence. This is the feature, not a limitation — model deviation (rabbit-holing, skipping curation, early stopping) is exactly what produced "bullshit" in the old pipeline and in naive deep research agents.
- Quality gates can extend the pipeline beyond the profile's target goals. Even the quickest profile (Overview) cannot ship if the audit finds unverified claims. This means a "quick" Atlas might take longer than expected — but it will never ship gibberish.
- The anti-hallucination architecture uses a different model family for the citation audit than for synthesis. Same-model audit was theatre in the old pipeline. This adds one model configuration requirement.
- No plan approval gate means the user cannot edit sub-queries before research starts. They can cancel and restart with a more specific query if the direction is wrong. The decompose stage's sub-queries are visible in the progress indicator for transparency.
- The code-execution harness approach (Parallel's architecture, where the model writes Python that calls search primitives) was evaluated and noted as a future evolution. It was not chosen for v1 because it works best with models trained for code-based research orchestration; with general-purpose LLMs, a fixed server-orchestrated pipeline is more reliable and testable.

## To Be Grilled (open design branches)

The following branches have not yet been resolved through the grilling session. Each will be addressed one at a time, and resolved decisions will be recorded in CONTEXT.md and/or additional ADRs as needed.

1. ~~Failure, cancellation, and resume~~ — **RESOLVED**: auto-retry transient failures (max 2, backoff), manual retry resumes from last completed research round (Atlas Resume), cancel = discard partial state, stale recovery via heartbeat timeout (10min) like file-production.
2. ~~Cost & limits~~ — **RESOLVED**: per-Atlas cost tracking (accumulate token usage from all model calls, store on atlas_jobs), user-facing cost shown after completion in response audit details, budget-aware graceful degradation, 1 active Atlas per user, global admin-configurable limit (default 2), no per-day/month quotas in v1.
2. Cost & limits — per-Atlas cost tracking, user-facing cost display, per-user/per-day limits, graceful budget degradation behavior.
3. Concurrency — how many Atlas jobs per user, globally, and what happens when limits are exceeded.
4. Which models — synthesis model vs audit model configuration, admin-configurability, relationship to user's selected chat model.
5. SearXNG dependency — Atlas behavior when SearXNG is not configured (it's optional in the app).
6. Knowledge library integration — whether Atlas searches the user's uploaded documents and memory in addition to the web.
7. Privacy & data lifecycle — how long Atlas jobs/state persist, Clear Workspace Data / Account Erasure behavior, data archive inclusion.
8. Completion notification — how the user learns an Atlas finished while they were away.
9. Report structure — who decides section headings/outline, fixed template vs freeform, intent-specific shapes.
10. Language — report language detection, localized research prompts, EN/HU parity.
11. Graceful "not enough evidence" outcome — partial report with Limitations vs a distinct "insufficient evidence" output.
12. HTML renderer JS — hand-written deterministic template (safe, our code) vs model-generated HTML (needs sandbox, security risk).
