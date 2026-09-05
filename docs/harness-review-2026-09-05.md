# AlfyAI agent-facing harness review (2026-09-05)

Scope: what the chat model receives on a normal turn, how the turn executes, and what it gets back from tools and memory. Sources: code on `dev` at `c82dc394`, production analytics for the last 30 days (63–70 assistant turns, one user), and three targeted code walks (prompt assembly, turn loop, tool/memory feedback). File references are to the current tree.

## 1. Production baseline

| Metric (30 days) | Value |
|---|---|
| Prompt tokens per turn, summed over tool-loop steps: p50 / p90 / max | 23,198 / 98,698 / 323,080 |
| Prompt per model step: no-tool turns / tool turns (avg) | 13,563 / 16,909 |
| Fixed overhead floor (turn 2, single step, short history) | 6,600–7,200 |
| Constructed user packet estimate (avg / max) | 2,700 / 9,703 |
| Reasoning tokens / completion tokens (avg) | 2,589 / 3,130 |
| First byte from provider, p50 | 0.99 s |
| First visible token: p50 / p90 / avg no-tool / avg tool turns | 13.4 s / 54.9 s / 24.6 s / 34.5 s |
| Generation time: p50 / p90 | 28 s / 67 s |
| Turns using tools | 43 of 70 (61%) — research_web 69 calls, fetch_url 20, map_route 3, memory_context 2 |
| Compaction applied | 0 turns (a 15+-turn conversation reached 323k prompt tokens) |
| Depth profile | standard/auto 67, maximum 3 |

What the numbers say:

- **The constructed context packet is a minority of the prompt.** Roughly 2.7k of a 13–17k-token step. The rest is the system prompt (~4k tokens), tool descriptions and schemas (~4–5k tokens), flattened history, and tool results that accumulate across loop steps.
- **First-token latency is reasoning, then prefill.** The provider answers in ~1 s; the model then thinks for ~2.6k tokens (≈24 s on Flash-Next, 2–3× that on the previous 27B) before the first visible token. Prefilling 13–17k tokens per step is the second cost and is paid again on every tool-loop step.
- **Long conversations grow without bound.** Compaction never fired in 30 days; the mid-turn "automatic compression" stage is dead wiring in production (see §3.5), and the rolling post-turn summary exists but is not what limits the prompt.

## 2. What the model receives

### 2.1 System prompt (`normal-chat-context.ts:341-466`, `prompts.ts`)

Order: model header → optional gpt-oss "Reasoning: high" → base prompt (10.7k chars: mission, working style, reliability rules, tool table and per-tool prose, stop rules, content preservation, answer shape) → `## User Profile` → `## Retrieved Context Discipline` (1,050 chars, every logged-in turn) → `## Runtime Guidance` (date context, response-language guard 670 chars, JSON formatting rules 673 chars, rich-block syntax guide 2,087 chars, reasoning-depth contract 650–1,200 chars, connections framing guard 794 chars when a connection exists) → optional `## Response Style` (personality, uncapped). About 16k chars / 4k tokens on a typical turn.

### 2.2 Tool descriptions (`normal-chat-tools/index.ts:191-273`)

16 English descriptions totalling 16.4k chars (produce_file 2,023, research_web 1,934, memory_context 1,447), plus Zod schemas. Sent on every turn that has tools, in the language detected for the turn.

### 2.3 The user turn (`utils/prompt-context.ts:498-600`, `context-selection.ts:1519-1747`)

One user message containing an intro line, up to 13 titled sections (project folder, folder awareness, sibling context, task state, attachments, linked/attached sources, conversation files, retrieved evidence, compression snapshot, session summary, session context, baseline memory profile) and `## Current User Message`. **All prior turns are flattened into "Session Context" as `ROLE: content` text**; the model call carries a single user message (`streaming-normal-chat-model-run.ts:215-219`, `plain-normal-chat-model-run.ts:247-249`). Prior tool calls and results are not preserved as structured turns; only their rendered text survives.

After preparation, three more blocks may be spliced in: `## Current Web Research` (forced prefetch), `## Your calendar & mail (live)` (proactive connector context), and, uniquely placed **after** the user's own words, `## Normal Chat Deliberation Guidance` with "use these notes silently" meta-instructions (`deliberation-runner.ts:1203-1221`).

### 2.4 Redundancy and confusion inventory

- Tool usage rules are stated three times: the tool table and `### Web Research` / `### Files And Artifacts` prose in `prompts.ts:49-91`, and again in each tool's description. Citation and "web unavailable" wording is duplicated near-verbatim.
- Formatting guidance appears twice with different detail (`## Answer Shape` in the base prompt vs `RICH_BLOCK_SYNTAX_GUIDE` in runtime guidance).
- The "don't put persona facts into documents" rule appears in three files.
- Meta-instructions ride inside the user turn (compaction intro, prefetch and connector headers, deliberation notes), where the model can echo them or weigh them as user intent.
- `Retrieved Context Discipline` and `JSON_FORMATTING_RULES` are injected even on turns with no memory content and no tool call.
- Personality prompt text is injected uncapped and declared a hard override 250 lines away from the working-style rules it overrides.

## 3. How a turn executes (`stream-orchestrator.ts`, `shared-normal-chat-model-run-helpers.ts`)

### 3.1 Pipeline

SSE setup → reconnect arbitration → fire-and-forget turn acknowledgment and thought-step classifier session → context preparation (9-stage DAG, timed) → deterministic depth selection → clarification gate (no classifier wired) → tool pack → deliberation (if depth ≠ standard) → `streamText` loop → completion → finalize with post-turn tail.

### 3.2 Model calls per turn

| Call | When | Model | Blocking? |
|---|---|---|---|
| Main generation (`streamText`, up to 20 tool steps) | always | turn model | yes |
| Deliberation passes | depth `maximum`: 1–9 calls (+1 repair each); `extended`: 0 | turn model | **yes, before first token, sharing the main timeout** |
| Turn acknowledgment | every turn | model2 | no (800 ms cap) |
| Thought-step classifier | sampled during reasoning | model2 | no |
| Rail summary, rolling conversation summary, memory judge | post-turn | model2 / summarizer | no, unobservable from the client |
| Internal first-output failover | on timeout before any output | failover model | replaces attempt |
| Non-streaming fallback | stream connect/read failure or idle timeout | same model | **re-runs the entire pipeline including deliberation and tools** |

### 3.3 Two stacked failover systems

The `streamText` layer retries with a model switch on first-output timeout (`normal-chat-model/index.ts:1330-1482`); the orchestrator separately falls back to a full non-streaming re-run (`stream-fallback.ts`). A slow provider can pay both. The fallback carries prior tool calls only as truncated text (`stream-orchestrator.ts:117-153`), so tools with side effects (`produce_file`, write-capable connectors) can execute twice.

### 3.4 Deliberation

Of 11 catalogued passes, 6 are deterministic. At `maximum`, up to 9 model calls run before the first token with no budget of their own. The output is appended to the user turn as prose notes; nothing about the passes is visible to the user except an activity label.

### 3.5 Dead seams that still run

`automatic_compression` runs and is timed every turn but always exits "not possible" because no production caller sets `compressionControlMessageSender` (`normal-chat-context.ts:1022-1028`). The depth clarification classifier has no live caller. Both look active in stage lists and activity streams.

### 3.6 Observability gaps

Post-turn work races one tick past the response (`finalize.ts:800-810`) and then fails silently into logs. Reconnect replay lives in an in-memory buffer. Per-turn cost is recorded only as totals; there is no persisted breakdown of system prompt vs tools vs history vs tool results per step, and no per-pass deliberation timing.

## 4. What the model gets back

- **research_web / fetch_url** return `answerBriefMarkdown` (up to 30k chars), sources (≤8), evidence (≤12), a `diagnostics` object of operational telemetry, and an instruction string repeated on every call (`web-grounding.ts:107-178`).
- **memory_context** returns a ~15-key payload shaped for three modes at once, mostly empty per call, plus a per-call caution string (`memory-context.ts:165-198`).
- **Connection tools** return a prose "Found N events." sentence plus the raw array it summarizes.
- **Memory** is injected every turn as a protected "Baseline Memory Profile" (95 active items on production) using the same engine as the tool, and again if the model calls `memory_context`. Project-awareness sections fire whenever a folder is set, regardless of the message.
- **Citation audit** classifies unsupported or missing citations and only logs a warning; nothing is corrected or fed back (`web-citation-audit.ts:156-163`).
- **Thought steps and rail summary** are UI-only; deliberation briefs are the only reasoning fed back to the main model.

## 5. Proposals

Ordered by expected effect on quality and latency per unit of effort. Each lists the mechanism, the expected gain, and the risk.

### P1. Native message history instead of a flattened packet (high impact, medium-high effort)

Send the conversation as real turns: one system message, then alternating user/assistant messages for the last N turns, with prior tool calls and tool results preserved as structured parts (they are already stored per message in `messages.tool_calls`), and a single summary message for anything older. The constructed sections (attachments, task state, evidence) stay in the current user turn.

Gains: the model sees its own prior answers and tool results as what they were, so follow-ups ("do the same for Cork") work without re-searching; instruction hierarchy is correct (no meta text in the user turn); and, because system prompt plus prior turns become a byte-stable prefix, vLLM's prefix cache (already enabled) skips most of the 13–17k-token prefill on every step and every turn. Risk: the reranker/compaction logic in `prompt-context.ts` operates on sections and needs a turn-based replacement (P3 covers this).

### P2. Prompt diet: one source of truth per rule (high impact, low effort)

Remove `### Web Research`, `### Files And Artifacts` and the tool table's per-tool prose from the base prompt; tool descriptions are the single place a tool is explained. Merge `## Answer Shape` and `RICH_BLOCK_SYNTAX_GUIDE` into one formatting section. State the persona-in-documents rule once. Inject `Retrieved Context Discipline` only when memory or documents are actually in the packet, and `JSON_FORMATTING_RULES` only when tools are present. Cap personality text (e.g. 1,500 chars) and place it adjacent to working-style rules. Strip per-call instruction strings from tool results (they duplicate the description). Target: fixed overhead from ~7k to ~3.5–4k tokens, which is 25–30% of a typical no-tool step.

### P3. Real compaction with a hard prompt cap (high impact, medium effort)

Keep the last N turns verbatim (by token budget, e.g. 40% of the window), represent older turns by the existing rolling conversation summary, and refuse to exceed ~60% of the model window before the turn starts. Either wire `compressionControlMessageSender` to the summarizer endpoint or delete the mid-turn stage and rely on the post-turn rolling summary plus turn-based truncation. Today a 323k-token prompt reaches a 131k-window model only because the provider truncates or the request fails.

### P4. Tool result hygiene (medium impact, low effort)

Drop `diagnostics` from model payloads (keep it in the recorder entry for the admin view). Normalize every tool to `{ ok, summary, items, sources }`, omit empty keys, and use markdown for prose-heavy results (research briefs) instead of JSON-wrapped markdown. Lower the research brief cap from 30k chars to roughly 10–12k; the p90 prompt of 99k tokens is mostly stacked briefs across tool steps. Give `memory_context` one shape per mode.

### P5. Deliberation budget and placement (medium impact, low-medium effort)

Give deliberation its own time budget (e.g. 20% of the request timeout, hard cap 25 s), run model-backed passes concurrently with a per-pass timeout, and degrade to the deterministic briefs when the budget is spent. Move the notes into the system prompt as a "planning notes" block (or a prior assistant turn under P1) rather than after the user's words. Consider collapsing the model-backed passes into a single structured "plan and risks" call: on production, `maximum` was used on 3 turns in 30 days, so 9 calls of machinery serves almost nobody.

### P6. One failover policy, no re-execution (medium impact, medium effort)

Keep the first-output-timeout model switch; on mid-stream failure resume with a non-streaming call that receives the already-completed tool calls as structured tool results (not a text digest), never re-runs deliberation, and treats side-effect tools (`produce_file`, connector writes) as non-repeatable within a turn. Remove the second, independent fallback path.

### P7. Memory as retrieval, not broadcast (medium impact, low-medium effort)

Replace the every-turn baseline profile with a message-scored shortlist (top 8–12 facts by embedding similarity to the current message plus a small always-on core such as name, language, location). Inject project awareness only on the first turn of a conversation or when the message references the project. Make `memory_context` the escalation path for depth, so the same facts are not delivered twice through two budgets.

### P8. A dedicated control model on GPU1 (medium impact, low effort, ops)

Acknowledgment, thought-step classifier, rail summary, title, rolling summary and (after P3) compaction all go to "model2", which today is the same Flash-Next instance serving the main turn, competing for its 16 sequence slots and adding first-token latency. GPU1 has ~25 GB free. A small instruct model (a 4–8B Qwen3 in FP8) on GPU1 with its own alias would remove the contention, make the control calls faster and cheaper, and make P3's compaction affordable. This also fixes the class of outage found this week, where a renamed alias silently killed every control call.

### P9. Reasoning length control (medium impact, low effort)

First-token time is dominated by reasoning tokens. Map depth profiles to provider reasoning effort explicitly (standard → low/medium, extended → high, maximum → xhigh) instead of xhigh by default on the local model row, and add a per-turn reasoning token cap where the provider supports it. Combined with P1's prefix caching this is the largest latency lever available without changing models.

### P10. Turn inspector and trace (observability, low-medium effort)

Persist a per-turn trace: system prompt tokens, tool schema tokens, history tokens, packet tokens, per-step tool result tokens, deliberation pass timings and outcomes, side-call outcomes, fallback events. Show it on an admin "Turn inspector" page next to the existing Tool health and Effective configuration views, and surface post-turn tail failures there instead of only in logs. Every proposal above becomes measurable with this in place.

### P11. Citation repair instead of warn-only (quality, low effort)

When the audit finds unsupported citations, either strip the unsupported links before persisting or run one short correction call on the affected paragraph. Today the user receives fabricated-looking links and only the log knows.

### P12. Delete dead seams (hygiene, low effort)

Remove the unwired clarification classifier and either wire or remove the mid-turn compression stage; collapse the stream/send post-turn scheduling into one path; move the in-process concurrency caps into a single scheduler module so future multi-instance deployment cannot silently exceed them.

## 6. Suggested phasing

- **Phase 1 (1–2 days):** P2 prompt diet, P4 tool result hygiene, P5 deliberation budget, P9 reasoning mapping, P12 dead seams. Low risk, immediate token and latency savings, measurable with the existing analytics.
- **Phase 2 (3–5 days):** P1 native message history and P3 compaction together, since both replace the flattened packet. Validate against prefix-cache hit rate from vLLM metrics and the per-step prompt tokens from P10.
- **Phase 3 (2–4 days):** P8 control model on GPU1, P6 unified failover, P7 memory retrieval, P10 turn inspector, P11 citation repair.

Expected outcome after Phase 2: typical no-tool step from ~13.5k to ~6–7k prompt tokens, most of which is cache-hit prefix; first visible token driven only by the chosen reasoning effort; long conversations bounded; one place per rule in the prompt.
