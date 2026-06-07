# Normal Chat Depth Clarification and dynamic deliberation refactor slices

This is the local implementation backlog for the next Reasoning Depth refactor. It extends the product language in `CONTEXT.md` and the decision in `docs/adr/0028-normal-chat-reasoning-depth.md`.

These are local issue drafts for a later orchestration run. They are not published tracker issues.

## Orchestration constraints

- The orchestrator should treat this document as the overseer plan and assign one slice at a time to implementation agents.
- Each code-writing worker should use TDD where practical and add the smallest useful regression checks where strict red-green-refactor is not feasible.
- Workers must use the project glossary: Reasoning Depth, Automatic Depth Selection, Depth Profile, Depth Clarification, Depth Clarification Gate, Depth Clarification Turn, Depth Clarification Carry-forward, Depth Outcome, Depth Assumption, Normal Chat Deliberation Pass, and Reasoning Depth Evaluation Harness.
- New user-facing wording must be localized in English and Hungarian.
- Depth Clarification stays inside Normal Chat. It must not create a Deep Research Job, approval workflow, paused turn, or hidden resumable state.
- Routes stay thin. Durable behavior belongs in existing Normal Chat turn, model-run, stream, message, client runtime, and read-model boundaries.
- High-cost deliberation should only expand after the clarification gate and evaluation harness prove that expensive wrong-target runs are being avoided.
- Full deliberation briefs remain transient working material unless a later ADR explicitly changes that.

## User stories

- U1: As a user, when high-cost reasoning would target the wrong thing, I want AlfyAI to ask one clear localized question before spending time and cost.
- U2: As a Hungarian-speaking user, I want the same clarification behavior and wording quality in Hungarian.
- U3: As a user who selected Max or triggered high-cost Auto, I want my intended depth preserved after I clarify.
- U4: As an operator, I want metadata and analytics to distinguish clarification from completed expensive deliberation.
- U5: As a maintainer, I want deliberation passes to become data-driven and measurable before adding more of them.
- U6: As an evaluator, I want proof that higher depth improves quality enough to justify added latency and cost.

## Summary

| ID | Title | Type | Blocked by | User stories |
| --- | --- | --- | --- | --- |
| DCR-01 | Persist Depth Clarification as a Normal Chat Turn | AFK | None | U1, U2, U4 |
| DCR-02 | Add deterministic Depth Clarification bypasses | AFK | DCR-01 | U1 |
| DCR-03 | Carry forward high-cost depth after clarification | AFK | DCR-01 | U3 |
| DCR-04 | Add cheap structured ambiguity classification | AFK | DCR-01, DCR-02 | U1, U2 |
| DCR-05 | Support proceed-with-assumption depth outcomes | AFK | DCR-04 | U1, U4 |
| DCR-06 | Build the Depth Clarification Evaluation Harness | AFK | DCR-01, DCR-03, DCR-04, DCR-05 | U1, U2, U3, U4, U6 |
| DCR-07 | Refactor deliberation passes into a pass catalogue | AFK | DCR-06 | U5 |
| DCR-08 | Add dynamic high-cost deliberation planning | AFK | DCR-07 | U5 |
| DCR-09 | Introduce evidence and source reconciliation passes | AFK | DCR-08 | U5, U6 |
| DCR-10 | Measure dynamic deliberation quality versus cost | AFK | DCR-09 | U5, U6 |
| DCR-11 | Polish response audit and operator observability | AFK | DCR-06, DCR-09 | U4, U5 |

## DCR-01: Persist Depth Clarification as a Normal Chat Turn

**Type:** AFK
**Blocked by:** None - can start immediately

### What to build

Add the minimal end-to-end path where a high-cost Reasoning Depth decision can produce a Depth Clarification Turn instead of launching expensive Normal Chat deliberation. The ambiguous user request and assistant clarification should persist as ordinary conversation messages. The assistant response should use app-owned English/Hungarian wording and carry compact Depth Outcome metadata showing that expensive deliberation was deferred.

### Acceptance criteria

- [ ] A high-cost ambiguous turn can complete as a visible assistant clarification instead of a substantive final answer.
- [ ] The ambiguous user message is persisted normally.
- [ ] The assistant clarification is persisted normally.
- [ ] The clarification response is localized through app-owned English and Hungarian strings.
- [ ] Depth Metadata records a Depth Outcome for clarification without pretending high-cost deliberation ran.
- [ ] Streaming and non-streaming paths can both produce the same clarification outcome.
- [ ] Retry, refresh, and conversation detail hydration preserve the clarification turn.
- [ ] Tests cover persisted user message, persisted assistant clarification, metadata shape, and English/Hungarian rendering.

### Orchestrator notes

This slice should not implement a complex classifier. It may use a narrow test hook or deterministic trigger to prove the end-to-end turn shape.

## DCR-02: Add deterministic Depth Clarification bypasses

**Type:** AFK
**Blocked by:** DCR-01

### What to build

Add conservative deterministic bypass rules so clear high-cost requests proceed without asking while obviously under-scoped high-cost requests ask before expensive work. The bypass layer runs before any model-based ambiguity classifier.

### Acceptance criteria

- [ ] Clear requests with named targets proceed without Depth Clarification.
- [ ] Current-turn attachments or selected linked sources can make the target explicit enough to proceed.
- [ ] Requests naming concrete technologies, files, products, people, jurisdictions, or goals proceed when the expected work is clear.
- [ ] Self-contained requests proceed when ambiguity affects presentation but not substance.
- [ ] Broad requests with multiple materially different targets can ask before high-cost work.
- [ ] Deterministic bypasses do not run full context selection, web retrieval, memory retrieval, or deliberation passes.
- [ ] Tests cover ask/proceed examples for architecture, auth, comparisons, attachments, and selected sources.

### Orchestrator notes

Keep the rules conservative. The goal is to avoid over-asking, not to solve every ambiguity without the classifier.

## DCR-03: Carry forward high-cost depth after clarification

**Type:** AFK
**Blocked by:** DCR-01

### What to build

Preserve the high-cost Depth Profile that caused a Depth Clarification for exactly one follow-up turn. This includes explicit Max and Auto-resolved high-cost profiles such as extended or maximum. The carry-forward must be cancelled or overridden when the user changes the visible composer depth before replying.

### Acceptance criteria

- [ ] Explicit Max carries forward for one clarified follow-up.
- [ ] Auto-resolved extended carries forward for one clarified follow-up.
- [ ] Auto-resolved maximum carries forward for one clarified follow-up.
- [ ] Carry-forward is consumed after one follow-up turn.
- [ ] Changing the visible composer depth before replying overrides carry-forward.
- [ ] Carry-forward does not create a paused turn, hidden resumable state, or durable user preference.
- [ ] Tests cover explicit Max, Auto extended, Auto maximum, composer override, and one-turn consumption.

### Orchestrator notes

This is product state, not a resumed model run. Prefer compact message metadata or existing client/server turn state patterns over a new lifecycle subsystem.

## DCR-04: Add cheap structured ambiguity classification

**Type:** AFK
**Blocked by:** DCR-01, DCR-02

### What to build

Add a bounded classifier that runs only for high-cost effort after deterministic bypasses have failed to decide safely. It should return structured decisions: proceed, ask_clarification, or proceed_with_assumption. When asking, it may return structured interpretation options that app-owned templates render in English or Hungarian.

### Acceptance criteria

- [ ] The classifier runs only for selected high-cost effort.
- [ ] Deterministic bypasses run before the classifier.
- [ ] Classifier input is bounded and does not include raw large documents or source-heavy retrieval output.
- [ ] Classifier output is schema-validated and normalized.
- [ ] Invalid classifier output falls back conservatively to proceed_with_assumption when a dominant interpretation exists, otherwise safe standard behavior.
- [ ] User-facing clarification wording comes from app i18n templates, not model-authored final prose.
- [ ] Hungarian prompts receive Hungarian clarification wording.
- [ ] Tests cover valid classifier decisions, invalid output fallback, structured options, and localization.

### Orchestrator notes

Use existing control-model patterns where possible. Do not introduce a separate orchestration runtime.

## DCR-05: Support proceed-with-assumption depth outcomes

**Type:** AFK
**Blocked by:** DCR-04

### What to build

Allow the Depth Clarification Gate to proceed when one interpretation is clearly dominant, while adding a brief Depth Assumption to the final answer and recording the outcome distinctly. If the assumption would be weak enough to make the answer likely wrong, the gate should ask instead.

### Acceptance criteria

- [ ] The gate can return proceed_with_assumption.
- [ ] The final answer states only assumptions that materially shaped the answer.
- [ ] The assumption appears near the top of the final answer before recommendations.
- [ ] The assumption text does not mention the gate, pass count, tokens, or internal process.
- [ ] Depth Metadata records an assumption outcome distinct from clarification and completed deliberation.
- [ ] Follow-up corrections can use the corrected scope normally.
- [ ] Tests cover assumption injection, no-internal-language wording, metadata, and correction follow-up behavior.

### Orchestrator notes

Keep assumption text concise. Do not turn this into a verbose preamble generator.

## DCR-06: Build the Depth Clarification Evaluation Harness

**Type:** AFK
**Blocked by:** DCR-01, DCR-03, DCR-04, DCR-05

### What to build

Build the evaluation harness cases that prove Depth Clarification reduces wrong-target expensive runs without materially increasing unnecessary clarification questions. The harness should cover ask, proceed, proceed-with-assumption, Hungarian parity, carry-forward, and analytics classification.

### Acceptance criteria

- [ ] Ambiguous high-cost prompts that should ask are covered.
- [ ] Clear high-cost prompts that should proceed are covered.
- [ ] Dominant-interpretation prompts that should proceed with an assumption are covered.
- [ ] Hungarian prompts verify equivalent decision quality and localized wording.
- [ ] Carry-forward fixtures verify the clarified follow-up receives the intended high-cost profile.
- [ ] Analytics/metadata fixtures verify clarification is not counted as completed Max or Extended deliberation.
- [ ] The harness reports unnecessary-question rate and wrong-target avoidance signals.

### Orchestrator notes

This slice is the guardrail before expanding deliberation cost. Do not start dynamic pass expansion until this harness is in place.

## DCR-07: Refactor deliberation passes into a pass catalogue

**Type:** AFK
**Blocked by:** DCR-06

### What to build

Replace hardcoded deliberation pass count and ordering with data-driven pass specifications while preserving current behavior. Extended should still run the existing context/source review pass. Maximum should still run that pass plus the existing answer-plan critique pass.

### Acceptance criteria

- [ ] Deliberation pass kinds, labels, schemas, tool scopes, output budgets, and tool-step budgets are represented as pass specifications.
- [ ] Extended behavior remains one deliberation pass.
- [ ] Maximum behavior remains two deliberation passes.
- [ ] Existing status events, usage aggregation, repair behavior, constraints, and final-answer guidance behavior are preserved.
- [ ] Tests prove current extended and maximum outputs remain behaviorally equivalent.
- [ ] The pass catalogue is easy to extend without editing loop control logic.

### Orchestrator notes

This is a refactor slice. It should not add new pass types or dynamic selection yet.

## DCR-08: Add dynamic high-cost deliberation planning

**Type:** AFK
**Blocked by:** DCR-07

### What to build

Add a deliberation planner that selects a bounded plan from Depth Profile, Depth Selection Signals, grounding need, context breadth, tool-use signal, force-web-search state, and cost class. The Depth Clarification Gate should attach to high-cost effort generally, not only today's named profiles.

### Acceptance criteria

- [ ] Deliberation planning can select none, single-pass, multi-pass, or synthesis plans within configured limits.
- [ ] Plan selection uses structured signals rather than hardcoded pass count only.
- [ ] High-cost plans still pass through the Depth Clarification Gate before expensive work begins.
- [ ] Plan metadata records attempted and completed passes at a compact level.
- [ ] Plans clamp to Provider Model and runtime limits.
- [ ] Tests cover standard, extended, maximum, source-heavy, broad-context, and force-web-search scenarios.

### Orchestrator notes

Keep this synchronous Normal Chat work. Do not create a Deep Research lifecycle or background job.

## DCR-09: Introduce evidence and source reconciliation passes

**Type:** AFK
**Blocked by:** DCR-08

### What to build

Add new bounded read-only pass types for evidence gaps, source reconciliation, adversarial checks, and workspace synthesis. These passes should use Deliberation Tool Scope only, report compact status steps, aggregate usage, and degrade gracefully with constrained metadata.

### Acceptance criteria

- [ ] Evidence gap pass runs when external or current evidence is useful or required.
- [ ] Source reconciliation pass runs when multiple source-backed claims may conflict.
- [ ] Adversarial or edge-case pass runs only for appropriate high-cost tasks.
- [ ] Workspace synthesis compresses prior briefs and gathered findings instead of replaying full context.
- [ ] New passes use read-only tools only.
- [ ] Tool failures or invalid structured output degrade gracefully and do not fail safe final answers unnecessarily.
- [ ] Tests cover pass selection, schema normalization, repair fallback, status events, usage aggregation, and constrained metadata.

### Orchestrator notes

This is the first slice that intentionally increases cost. It must depend on the harness and pass-catalogue refactor.

## DCR-10: Measure dynamic deliberation quality versus cost

**Type:** AFK
**Blocked by:** DCR-09

### What to build

Run the Reasoning Depth Evaluation Harness and a bounded local live/API or UI evaluation to determine whether dynamic deliberation measurably improves quality enough to justify added latency and cost. Use installed local model options, including KIMI when available, so the evaluator can make the keep/tune/remove decision without human review.

### Acceptance criteria

- [ ] Evaluation results compare standard, existing extended/maximum, and dynamic high-cost plans.
- [ ] Results include quality, latency, cost, wrong-target avoidance, grounding, context awareness, contradiction handling, format discipline, and Hungarian parity.
- [ ] Local live/API or UI evaluation runs are included when configured credentials and models are available.
- [ ] KIMI-backed evaluation is attempted when an installed KIMI model is available.
- [ ] The review identifies any pass type that adds cost without measurable quality benefit.
- [ ] The final recommendation states whether to keep, tune, or remove each new pass type.
- [ ] Follow-up implementation issues are created locally for any required tuning.

### Orchestrator notes

This is AFK because the evaluator can run local harnesses plus live/API or UI checks and judge against explicit quality, latency, cost, wrong-target avoidance, and Hungarian parity signals.

## DCR-11: Polish response audit and operator observability

**Type:** AFK
**Blocked by:** DCR-06, DCR-09

### What to build

Make completed response audit details and operational analytics distinguish standard responses, Depth Clarification Turns, proceed-with-assumption outcomes, constrained deliberation, and completed high-cost deliberation. The UI should stay compact and must not expose full deliberation briefs or private reasoning.

### Acceptance criteria

- [ ] Response audit details show compact Depth Outcome information.
- [ ] Clarification outcomes do not look like completed Max or Extended deliberation.
- [ ] Proceed-with-assumption outcomes are visible at a compact level.
- [ ] Constrained deliberation is distinguishable from successful completed deliberation.
- [ ] Usage and cost totals include work that actually ran and exclude fake pass counts.
- [ ] Analytics can separate clarification, assumption, constrained, and completed outcomes.
- [ ] No raw tool payloads, deliberation briefs, source diagnostics, or private reasoning are exposed.
- [ ] Tests cover audit rows and analytics projection for each Depth Outcome.

### Orchestrator notes

This should run after the main behavior exists so it can polish real metadata rather than inventing speculative rows.

## Open review questions

1. Does this granularity feel right, or should any slices be merged or split?
2. Are the dependency relationships correct?
3. Are DCR-10's AFK benchmark thresholds strict enough to justify higher cost and latency?
4. Should this plan be merged into the older Reasoning Depth backlog, or remain a separate follow-up refactor document?
