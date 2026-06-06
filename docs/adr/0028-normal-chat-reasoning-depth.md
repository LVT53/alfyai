# Normal Chat Reasoning Depth replaces the Thinking toggle

Accepted. AlfyAI will replace the Normal Chat Thinking toggle and `/thinking` command with **Reasoning Depth** and `/depth`: `Off`, `Auto`, and `Max`. `Off` disables provider-native thinking where supported without blocking required tools or grounding; `Auto` runs an app-owned structured preflight over bounded **Depth Classification Context** and resolves to `standard`, `extended`, or `maximum`; `Max` bypasses classification and applies the highest bounded Normal Chat effort inside the selected **Provider Model** limits. Auto uses the user's selected model by default, but admins may configure a specific available **Depth Classifier Model** for system use to make preflight decisions faster, cheaper, or more consistent.

This stays inside **Normal Chat**. Reasoning Depth may increase provider reasoning effort, context/output ceilings, grounding pressure, and source budgets when useful, but it must not automatically start **Deep Research Mode** or create a **Deep Research Job**. The resolved **Depth Profile** and compact rationale should be persisted as **Depth Metadata**, with **Depth Observability** recording classification and response-start timing so tuning is based on traces rather than fixed timeout guesses.

Extended and maximum profiles should run real **Normal Chat Deliberation Passes** once selected, rather than only changing a single model-call prompt or budget. Extended runs one required deliberation pass and maximum runs two required deliberation passes before the final answer. This makes higher depth a real latency and cost preference: Auto can avoid it by choosing standard for simple turns, but explicit Max should predictably add bounded extra work before the final answer.

Because the previous single-call Extended/Max behavior has not shipped, multi-pass deliberation replaces it directly rather than being hidden behind an admin/runtime rollout flag.

Deliberation passes use the user-selected **Provider Model** for the turn rather than the **Depth Classifier Model** or a separate admin-configured model. They may use a narrow read-only **Deliberation Tool Scope** so higher depth can actually inspect memory, web sources, and selected context when needed. They must not call file-production, write/action, destructive, or Deep Research tools. Deliberation pass model and tool usage counts toward the same **Normal Chat Response Usage** shown and charged for the response, with only the combined total exposed in the chat UI.

The first deliberation pass may receive the selected **Prompt Context** so it can genuinely inspect the same project, memory, document, and source material available to the answer. Maximum's second deliberation pass should receive compact **Deliberation Context** from the first pass and gathered findings rather than blindly replaying every full context item again.

Deliberation should shape answer quality silently. The final answer should follow the same format, style, citation, and uncertainty rules as an ordinary Normal Chat response, without self-narrating that deliberation passes occurred unless the user explicitly asks.

Deliberation failures should degrade gracefully. If a deliberation model call or read-only tool fails, the turn should continue to the final answer when a safe answer is still possible, recording a compact constraint in **Depth Metadata**. The final answer should disclose only user-relevant uncertainty or unverifiable claims, not internal pass failure details.

Full **Normal Chat Deliberation Briefs** should remain transient working material in v1. Completed turns may persist compact Depth Metadata, combined usage, and high-level status steps that already belong in Thought, but should not durably store full assumptions, critique briefs, draft risks, or internal final-answer instructions.

Deliberation belongs inside the existing Normal Chat turn/model-run flow rather than a new top-level subsystem. A chat-turn-owned deliberation runner may sit after Context Selection and before final answer generation, reusing the selected Provider Model, read-only Normal Chat tools, stream/status plumbing, and usage accounting already owned by Normal Chat.

For streaming turns, final answer text should not stream until required deliberation passes are complete. While deliberation is running, the UI may show the Deliberation Status Line, append high-level status steps into Thought, and display provider thinking text when available; normal answer tokens begin only with the final answer pass.

Stopping a turn during deliberation cancels active model/tool work. If no final answer text has streamed, AlfyAI should not persist a blank assistant message just to represent cancelled deliberation; any already-observed usage may remain internal. If final answer text has streamed, existing partial-answer persistence applies with compact Depth Metadata and available combined usage.

Retry preserves explicit Reasoning Depth selections but reruns Auto. A retry of an explicit Max turn should run the Max deliberation path again, while a retry of an Auto turn should rerun Automatic Depth Selection and receive fresh Depth Metadata for the new assistant message.

Passive disconnect or navigation during deliberation should not stop the turn. Reconnect may replay active in-memory deliberation status, Thought/status steps, and provider thinking while the stream is still active, but completed reloads should not recreate the live status line and server restarts should not invent lost deliberation state.

Maximum deliberation should be more proactive about memory, project, document, and selected-context review, but web search remains evidence-gated. Max should use web retrieval when claims are current, external, high-stakes, product/vendor-specific, or materially improved by source-backed evidence, not for every self-contained code, writing, or reasoning task. Completed Thought may include compact human-readable tool milestones where they occurred, but not raw tool payloads, JSON, source diagnostics, candidate lists, or verbose result details.

A **Reasoning Depth Evaluation Harness** should be used before treating the multi-pass path as successful. It should compare standard/extended/maximum Normal Chat behavior on code/debugging, source-grounded, project-context, study/planning, and self-contained prompts, checking that higher depth adds real latency/cost while improving edge-case handling, grounding, context awareness, contradiction handling, or recommendation quality without breaking format discipline or UI cleanliness.

Normal Chat Deliberation Briefs should use small fixed structured schemas rather than freeform hidden essays. The first pass should capture bounded user intent, assumptions, missing context questions, evidence needs, relevant findings, edge cases, and final-answer guidance. Maximum's second pass should capture bounded answer risks, contradictions or tensions, missed user needs, format requirements, must-include items, should-avoid items, and final-answer guidance. Empty lists are valid when nothing matters; filler is not.

If a deliberation pass cannot produce valid structured output, AlfyAI may run one bounded repair attempt with the same selected Provider Model. If repair fails, the pass is recorded as constrained and the turn continues with safe fallback final-answer guidance when possible; it should not switch models, loop indefinitely, or expose schema failure in the chat UI.

Longer-depth turns should use an inline **Deliberation Status Line** in the pending assistant bubble so users can see the current high-level pass without introducing a bulky card or debug surface. The status line appears above the existing thinking disclosure while the response is running, shows one current status at a time, and transitions smoothly as the app moves through real deliberation work such as context review, source checking, edge-case review, or final drafting. It must be fed by actual turn, tool, grounding, or deliberation-pass events, not synthetic percentages or estimated wait times. Thinking Trace text should be persisted when available so previous turns remain auditable, but it remains a secondary trace rather than the official explanation of the answer. The trace should keep the existing inline disclosure pattern under the compact **Thought** label, with no separate "trace saved" status line. Short **Interim Thought Steps** emitted while reasoning should be visually separated instead of glued together. Completed **Deliberation Status Steps** should appear only inside Thought at the point where they occurred, while the completed answer surface and info tooltip remain clean.

**Considered Options**

- Keep the old Thinking toggle as a provider-native on/off switch. Rejected because the desired control also affects Normal Chat effort, context, grounding, and post-response metadata.
- Expose more user-visible modes such as standard or extended. Rejected because `Auto` can use an internal `extended` profile without making the plus menu harder to scan.
- Let the main model escalate itself mid-answer. Rejected because context budgets, tool availability, web prefetch, provider options, and max output tokens must be resolved before the model run starts.
- Use hardcoded keyword rules or a fixed classifier timeout. Rejected because task difficulty is language-dependent and latency varies by provider, model, context, and load.
- Always use the current chat model for classification with no override. Rejected because operators may need a faster, cheaper, or more reliable classifier while preserving the selected model for the actual answer.
- Treat Max as Deep Research. Rejected because Deep Research is an explicit separate job lifecycle with approval, budgets, source ledger, and report outcomes.

**Consequences**

- The user-facing plus-menu label is **Reasoning depth**; `/thinking` is removed rather than kept as a compatibility alias.
- The internal contract should move from `thinkingMode` to `reasoningDepth` across composer state, request payloads, draft restoration, stream/runtime metadata, and assistant-message metadata.
- Higher Depth Profiles should increase reasoning care and completeness, not automatically make final answers longer.
- Final answers should not self-report the deliberation process; the output format should remain a normal chat answer unless the user requests otherwise.
- Extended and maximum profiles should always add real deliberation work once selected; Extended runs one deliberation pass and Max runs two before the final answer.
- Multi-pass deliberation should replace the current single-call Extended/Max behavior directly; no rollout flag is needed before first deployment.
- Deliberation passes should use the same user-selected Provider Model as the final answer.
- Deliberation passes may call read-only Normal Chat tools such as memory and web/source inspection, but they must not call action tools, file production, destructive tools, or Deep Research.
- The first deliberation pass may inspect selected Prompt Context; later deliberation passes should use compact Deliberation Context and gathered findings to avoid unbounded prompt replay.
- Normal Chat response time, token counts, and cost estimates should include deliberation passes rather than counting only the final answer model call; the chat UI should show only combined totals, not per-pass cost rows.
- Full deliberation briefs should not be persisted in v1; persist compact metadata/status only.
- Deliberation briefs should use bounded structured fields rather than freeform internal prose.
- Invalid deliberation brief output may get one repair attempt, then should degrade gracefully with constrained metadata.
- Deliberation should be implemented inside the existing Normal Chat turn/model-run boundaries, not as route-local orchestration or a Deep Research-like subsystem.
- Streaming final answer text should begin only after selected deliberation passes complete; live deliberation uses status/Thought surfaces rather than partial answer prose.
- Stopping during deliberation before answer text exists should not create a blank assistant message.
- Retrying explicit Max should run Max deliberation again; retrying Auto should rerun Automatic Depth Selection rather than reusing stale resolved profiles.
- Reconnect may restore live deliberation status only from active stream state; completed or lost streams should not reconstruct fake status.
- Max should strengthen grounding guidance, but web search remains conditional on the task needing external or current evidence.
- Max should be more proactive about memory, project, document, and selected-context review, while web search remains evidence-gated rather than automatic.
- Longer-depth waits should surface observable app work through an inline, low-height **Deliberation Status Line** instead of relying on a flashing generic thinking label, a row-based timeline, or a bulky dashboard-like card.
- During generation, the Deliberation Status Line appears above the Thought disclosure and shows one current high-level status at a time.
- Completed Deliberation Status Steps should remain available only inside Thought at the point where they occurred; they should not become permanent chat-body rows or info-tooltip process details.
- Completed Thought may include compact human-readable tool milestones, but should not expose raw tool payloads, JSON, source diagnostics, candidate lists, or verbose tool results.
- Completed-turn audit should use the existing assistant-message info tooltip rather than adding a second inline Details surface. The tooltip should stay visually minimal and should not include deliberation pass lists or tool-use summaries.
- Thinking Trace text should be persisted when available and exposed through the existing inline disclosure under the compact **Thought** label, while the final assistant answer remains the primary completed-turn surface.
- Interim Thought Steps should be separated visually during streaming and remain auditable through the persisted Thought trace when present.
- Automatic Depth Selection should return compact structured signals alongside the resolved profile, such as grounding need, context breadth, and output room, so implementation can apply relevant effort changes without treating every profile as an all-or-nothing bundle.
- Depth scaling must clamp to configured **Provider Model** context and output limits, and metadata should record when a requested profile was constrained.
- Auto should usually choose `standard` or `extended`; `maximum` is reserved for clearly hard or high-value turns.
- If Automatic Depth Selection fails, Auto falls back to `standard` and records the failure in Depth Metadata.
- If a selected extended or maximum deliberation pass fails, the turn should continue when safe and record the constrained higher-depth state rather than failing the whole chat turn.
- A focused Reasoning Depth Evaluation Harness should prove that multi-pass higher depth improves representative outcomes enough to justify added latency and cost.
