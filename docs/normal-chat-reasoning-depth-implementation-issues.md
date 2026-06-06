# Normal Chat Reasoning Depth implementation issues

This is the local implementation backlog for the Reasoning Depth design captured in:

- `CONTEXT.md`
- `docs/adr/0028-normal-chat-reasoning-depth.md`

The slices below are written as independently grabbable tracer bullets for a later `$orchestrate-subagents` run. They are local issue drafts, not published tracker issues.

## Orchestration constraints

- Every code-writing worker must use `$tdd` or explain why a strict red-green-refactor loop is not feasible and still add the smallest useful regression check.
- Workers must not revert or overwrite concurrent edits.
- Routes stay thin. Durable behavior belongs in the existing chat-turn, normal-chat-context, normal-chat-model, normal-chat-tools, messages, config-store, and client runtime boundaries.
- New user-facing composer labels, commands, errors, empty states, and accessibility strings must be localized in English and Hungarian.
- Svelte changes must follow the repo's Svelte 5 rules.
- Reasoning Depth stays inside Normal Chat and must not auto-start Deep Research.
- Live activity rows are not arbitrarily capped. They should stay compact and disappear after completion.
- The completed-turn audit surface is the existing assistant-message info tooltip, which may grow modestly into a minimal response-details popover.
- The existing thinking disclosure remains inline and is renamed to the compact completed label `Thought`; it should not become a second completed audit surface.

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| RD-01 | Replace Thinking with Reasoning Depth in the composer contract | AFK | None | Composer UI, commands, client request payloads, server request parsing |
| RD-02 | Persist and hydrate Depth Metadata for completed turns | AFK | RD-01 | DB/message persistence, conversation detail, baseline info tooltip rows |
| RD-03 | Add Automatic Depth Selection with a bounded classifier | AFK | RD-01, RD-02 | Control-model service, depth selection context, chat-turn preflight |
| RD-04 | Add admin-configured Depth Classifier Model | AFK | RD-03 | Runtime config, admin settings UI, classifier model resolution |
| RD-05 | Apply Depth Profiles to Normal Chat effort budgets | AFK | RD-03 | Provider options, context/output limits, grounding/tool budget application |
| RD-06 | Stream a live Response Activity Timeline | AFK | RD-02, RD-05 | Server stream events, browser stream contract, client runtime, activity UI |
| RD-07 | Clean up Thought rendering and interim thought steps | AFK | RD-01 | ThinkingBlock, thought display normalization, completed-state cleanup |
| RD-08 | Upgrade the existing info tooltip into Response Audit Details | AFK | RD-02, RD-06, RD-07 | MessageBubble info surface, compact audit projection |
| RD-09 | Harden lifecycle behavior for stop, reconnect, retry, queue, and landing handoff | AFK | RD-01, RD-02, RD-06 | Chat client runtime, stream reconnect, retry/send semantics |
| RD-10 | Final visual and behavioral acceptance pass | HITL | RD-01 through RD-09 | Orchestrator verification, screenshots, focused regressions |

## RD-01: Replace Thinking with Reasoning Depth in the composer contract

**Type:** AFK  
**Blocked by:** None - can start immediately

### What to build

Replace the current Normal Chat Thinking toggle with the user-facing **Reasoning depth** composer setting: `Off`, `Auto`, and `Max`. The completed slice should let a user choose a depth in the plus menu, use `/depth`, send from landing and chat routes, queue follow-up turns, and retry messages without the old `thinkingMode` vocabulary leaking through user-visible UI.

This slice should preserve baseline behavior rather than implement the full Auto classifier. `Off` maps to the current reasoning-off path, `Auto` maps to current normal/default behavior, and `Max` maps to the strongest currently available provider-native reasoning setting until later slices add richer depth profiles.

### Acceptance criteria

- [ ] The plus-menu label is `Reasoning depth` with visible options `Off`, `Auto`, and `Max`.
- [ ] `/thinking` is removed after the rename and `/depth` opens or applies the new Reasoning Depth control.
- [ ] Client payloads and server request parsing use `reasoningDepth` as the canonical contract, with any temporary compatibility shim hidden from user-facing code.
- [ ] Landing-to-chat handoff preserves the selected Reasoning Depth for the first message.
- [ ] Queued turns snapshot Reasoning Depth at queue time.
- [ ] Retry preserves explicit `Off` and `Max`; `Auto` remains rerunnable for later classifier behavior.
- [ ] English and Hungarian labels/descriptions are updated.
- [ ] Focused tests cover command parsing, composer state, request parsing, queued turn payloads, and retry payload behavior.

### Orchestrator notes

Own only the rename/contract path. Do not implement the classifier, activity timeline, or expanded audit tooltip in this slice.

## RD-02: Persist and hydrate Depth Metadata for completed turns

**Type:** AFK  
**Blocked by:** RD-01

### What to build

Persist compact **Depth Metadata** on assistant turns and hydrate it back into conversation detail so completed responses can show which depth was requested and which baseline profile was applied. This should work for streaming and non-streaming completion paths, including partial assistant messages that are actually saved after a stop.

At this stage, metadata can be minimal: requested `reasoningDepth`, applied profile (`off`, `standard`, or `maximum`), whether a fallback occurred, model/provider identifiers already available to the message, and any constraint note that can be derived without the later classifier.

### Acceptance criteria

- [ ] Completed assistant messages persist compact Depth Metadata.
- [ ] Conversation detail hydrates Depth Metadata back into `ChatMessage`.
- [ ] Streaming and plain send paths use the same metadata shape.
- [ ] If a stopped turn creates a persisted partial assistant message, that message gets Depth Metadata; if no assistant message exists, only operational logs may record the attempt.
- [ ] Fork/copy paths that already preserve thinking/message metadata do not drop Depth Metadata.
- [ ] The existing info tooltip can display a minimal `Reasoning depth` row without adding a second completed-answer detail surface.
- [ ] Focused persistence/read-model tests cover completed, stopped-with-message, and no-message cases.

### Orchestrator notes

Coordinate carefully with RD-08, which owns the richer tooltip layout. RD-02 should expose the data and a minimal row only.

## RD-03: Add Automatic Depth Selection with a bounded classifier

**Type:** AFK  
**Blocked by:** RD-01, RD-02

### What to build

Implement **Automatic Depth Selection** for `Auto`. Before the Normal Chat model run starts, an app-owned structured classifier should inspect bounded **Depth Classification Context** and resolve `standard`, `extended`, or `maximum`. The classifier must never choose reasoning-off behavior. Failure falls back to `standard` and records that fallback in Depth Metadata.

The default classifier model is the user's selected Provider Model. The classifier should return compact structured signals such as grounding need, context breadth, output room, and confidence/uncertainty, not freeform hidden reasoning.

### Acceptance criteria

- [ ] `Auto` runs a structured preflight before context/output/tool budgets are finalized.
- [ ] Explicit `Off` and `Max` bypass the classifier.
- [ ] Depth Classification Context is small and capped, using current user request, compact recent exchange context, and bounded metadata about selected sources, attachments, active documents, model capability, and composer state.
- [ ] The classifier output is validated and normalized into `standard`, `extended`, or `maximum`.
- [ ] Classifier failure falls back to `standard` and is visible in Depth Metadata.
- [ ] `maximum` is reserved for clearly hard or high-value turns by prompt/schema design.
- [ ] The classifier does not trigger heavy retrieval by itself.
- [ ] Tests cover successful profile selection, invalid JSON/schema fallback, explicit bypass, and bounded context construction.

### Orchestrator notes

This worker should use existing `normal-chat-control-model.ts` patterns where possible. Do not add a hidden orchestration runtime.

## RD-04: Add admin-configured Depth Classifier Model

**Type:** AFK  
**Blocked by:** RD-03

### What to build

Let admins configure a specific available **Depth Classifier Model** for system use, with the default remaining the user's selected Provider Model. The setting should flow through runtime config and the admin System pane using the existing Provider Model list and config-store patterns.

### Acceptance criteria

- [ ] Admin System settings expose an optional Depth Classifier Model selector.
- [ ] Leaving the setting unset uses the user's selected Provider Model.
- [ ] Setting a classifier model forces Automatic Depth Selection to use that model while preserving the selected chat model for the final answer.
- [ ] Depth Metadata records whether the classifier used the selected chat model or the admin-configured classifier model.
- [ ] Invalid/deleted/unavailable configured models fall back safely to the selected chat model and record a compact fallback reason.
- [ ] English and Hungarian admin labels/help text are added.
- [ ] Tests cover config persistence, layout/admin hydration, classifier model resolution, and fallback.

### Orchestrator notes

Keep this separate from RD-03 so the classifier can land first without admin UI churn.

## RD-05: Apply Depth Profiles to Normal Chat effort budgets

**Type:** AFK  
**Blocked by:** RD-03

### What to build

Make resolved **Depth Profiles** materially affect Normal Chat effort within the selected Provider Model limits. Higher profiles should give the model more room to reason about edge cases, implicit user needs, hard constraints, and key details without automatically making the final answer longer.

This includes provider-native reasoning effort where supported, prompt/context/output budget choices, stronger grounding instructions where useful, and conditional source/tool budget adjustments. It must clamp to configured Provider Model limits and record constraints in Depth Metadata.

### Acceptance criteria

- [ ] `off`, `standard`, `extended`, and `maximum` map to bounded provider options through the existing provider compatibility layer.
- [ ] Higher profiles may reserve more output room and broader context only within configured model limits.
- [ ] Max strengthens grounding guidance but does not force web search every turn.
- [ ] Extended and maximum may increase web/source budgets only when classifier/tool signals indicate external or current evidence is useful.
- [ ] Deep Research Mode is never auto-started by Reasoning Depth.
- [ ] Depth Metadata records applied profile, major effort dimensions changed, and any clamp/constraint.
- [ ] Tests cover provider options, context/output clamps, grounding/tool-budget changes, and Deep Research non-escalation.

### Orchestrator notes

This slice touches shared runtime defaults, provider compatibility, context budgeting, and tool budgets. It should not change UI beyond metadata that other slices consume.

## RD-06: Stream a live Response Activity Timeline

**Type:** AFK  
**Blocked by:** RD-02, RD-05

### What to build

Add a live **Response Activity Timeline** above the existing thinking/Thought disclosure while an assistant response is running. It should show real app-owned work as compact rows: depth selection, context preparation, attachment checks, web search, source reading, drafting, and similar pipeline/tool/source events.

Rows should not be arbitrarily capped. The UI should remain compact while the turn is running and disappear after completion. It must not show fake percentages or guessed ETA.

### Acceptance criteria

- [ ] Server stream events expose compact activity events for real pipeline/tool/source milestones.
- [ ] Browser stream parsing and reconnect replay preserve activity timeline state during active turns.
- [ ] The pending assistant bubble renders the Activity Timeline above the thinking disclosure.
- [ ] Activity rows remain visible for the full live process without arbitrary truncation.
- [ ] Source/context previews use concrete titles/domains when available.
- [ ] The Activity Timeline is removed from the main message surface after completion.
- [ ] Focused tests cover stream parsing, reconnect replay, UI rendering order, and completed-state cleanup.

### Orchestrator notes

Coordinate with RD-07 so tool/source rows move out of completed Thought clutter and into live activity plus completed audit metadata.

## RD-07: Clean up Thought rendering and interim thought steps

**Type:** AFK  
**Blocked by:** RD-01

### What to build

Keep the existing inline thinking disclosure, but align it with the new design. During generation it remains the thinking enclosure below the Activity Timeline. After completion it uses the compact label `Thought`. Completed Thought should focus on the persisted trace text, not replay completed tool calls or source activity.

Short **Interim Thought Steps** emitted without separators should be visually separated during streaming and in the opened Thought view, while preserving the raw stored trace. These snippets should not remain as status clutter outside Thought after completion.

### Acceptance criteria

- [ ] Completed thinking disclosure label is `Thought`.
- [ ] No `Thinking trace saved`, `Thought available`, or similar status clutter is shown.
- [ ] Completed Thought hides tool-call/source rows; those belong to live Activity Timeline and the info tooltip.
- [ ] Interim thought snippets such as `gonna search the Web.I am digging deeper.` render with readable separation.
- [ ] Display normalization does not rewrite the raw persisted Thinking Trace.
- [ ] Copy-message behavior excludes Thought by default.
- [ ] Tests cover active label, completed label, hidden completed tool calls, interim step separation, and copy behavior.

### Orchestrator notes

This is mostly a component/display slice and can proceed in parallel with server-side classifier work after RD-01.

## RD-08: Upgrade the existing info tooltip into Response Audit Details

**Type:** AFK  
**Blocked by:** RD-02, RD-06, RD-07

### What to build

Expand the existing assistant-message info tooltip into the single completed-turn **Response Audit Details** surface. It may grow modestly into a minimal response-details popover, but it should remain visually restrained and predictable.

The popover should include compact depth, activity, source/context, response-time, token, and cost facts when available. It should not duplicate the Thought trace body; Thought remains the inline disclosure.

### Acceptance criteria

- [ ] The existing info button remains the completed-turn audit entry point.
- [ ] The tooltip/popover shows `Reasoning depth`, resolved profile for Auto, fallback/constraint notes, and classifier source when available.
- [ ] It summarizes completed activity and source/context usage compactly.
- [ ] It continues to show model/provider, response time, token counts, and cost.
- [ ] It does not add an inline completed `Details` row under the answer.
- [ ] It does not duplicate raw Thought text.
- [ ] Layout remains usable on mobile and desktop.
- [ ] Tests cover rows shown/hidden for simple answers, source-backed answers, Max turns, classifier fallback, and no-Thought providers.

### Orchestrator notes

This worker should avoid changing stream or persistence contracts unless RD-02/RD-06 left a small projection gap.

## RD-09: Harden lifecycle behavior for stop, reconnect, retry, queue, and landing handoff

**Type:** AFK  
**Blocked by:** RD-01, RD-02, RD-06

### What to build

Make Reasoning Depth, Depth Metadata, Activity Timeline state, and Thought persistence coherent across chat lifecycle edge cases: user stop, passive disconnect/reconnect, retry, queued turns, and landing-to-chat first-message sends.

### Acceptance criteria

- [ ] Explicit user stop persists Depth Metadata and Thought only when a partial assistant message is saved.
- [ ] Passive route detach/reconnect does not mark the response as user-stopped and can replay active activity/thought/text state.
- [ ] Retry preserves explicit `Off` and `Max`; `Auto` reruns depth selection.
- [ ] Queued turns preserve their queued Reasoning Depth snapshot.
- [ ] Landing first message preserves local composer Reasoning Depth through handoff.
- [ ] Activity Timeline disappears after finalized completion and does not reappear on reload.
- [ ] Tests cover stop, reconnect replay, retry, queued follow-up, and landing handoff.

### Orchestrator notes

This is a hardening slice. It should run after the main data and activity contracts exist, then close behavior gaps with focused tests.

## RD-10: Final visual and behavioral acceptance pass

**Type:** HITL  
**Blocked by:** RD-01 through RD-09

### What to build

Run the final acceptance pass across the implemented feature. This is the point where the orchestrator verifies the integrated result, captures screenshots, and asks for human design approval of the live Activity Timeline and the modestly larger info popover.

### Acceptance criteria

- [ ] Playwright or equivalent browser checks cover desktop and mobile chat rendering.
- [ ] Visual review confirms the Activity Timeline is inline, compact, above Thought, and not card-like.
- [ ] Visual review confirms completed answers remain clean and audit details live in the info tooltip/popover.
- [ ] Manual or automated checks confirm Off, Auto, and Max behavior on at least one reasoning-capable provider and one provider/model path without exposed reasoning.
- [ ] Documentation is updated if implementation uncovers a necessary design adjustment.
- [ ] The orchestrator produces a final integration report with changed paths, tests run, residual risks, and any follow-up issues.

### Orchestrator notes

This is intentionally HITL because final visual fit cannot be judged from unit tests alone.

## Proposed implementation waves

1. **Foundation:** RD-01.
2. **Parallel data/display work:** RD-02 and RD-07 can run after RD-01 with limited overlap.
3. **Depth intelligence:** RD-03, then RD-04 and RD-05 can run in parallel if ownership is kept separate.
4. **Live experience:** RD-06 after activity-relevant metadata and budget behavior exist.
5. **Completed audit:** RD-08 after the data and live activity contracts settle.
6. **Lifecycle hardening:** RD-09 after the core contracts exist.
7. **Acceptance:** RD-10.

## Review questions before opening tracker issues

- Does this granularity feel right, or should RD-03/RD-05 be merged into one larger core behavior slice?
- Are the dependency relationships correct?
- Should RD-09 stay as a separate hardening issue, or should its acceptance criteria be distributed into earlier slices?
- Are the AFK/HITL labels correct?
