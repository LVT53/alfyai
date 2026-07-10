# Model-Scaled Context Selection Slices

These are local `$to-issues` slices for [ADR 0006](./adr/0006-model-scaled-context-selection.md). They are not published tracker issues. The ordering keeps the product contract stable before replacing old hard caps.

## 1. Expose Product Context Sources Payload

**Type:** AFK

**Blocked by:** None

**User stories covered:** As a user, I should see which sources the conversation is carrying forward without relying on debug evidence state.

**What to build:** Add a stable `contextSources` product payload to conversation detail and stream metadata. It should summarize active source count, selected/reduced/compacted state, pinned/excluded counts, and source groups without depending on `ContextDebugState`.

**Acceptance criteria**

- [ ] Conversation detail returns `contextSources`.
- [ ] Stream completion metadata can carry `contextSources`.
- [ ] The payload distinguishes active, inferred, pinned, excluded, reduced, and compacted states.
- [ ] Existing Message Evidence/debug metadata remains unchanged.

## 2. Localize Existing Context Sources Surface

**Type:** AFK

**Blocked by:** Slice 1 if labels mention new payload fields

**User stories covered:** As a Hungarian user, the Context Sources surface should not contain hardcoded English labels.

**What to build:** Replace remaining hardcoded Evidence Manager/Context Sources copy with i18n keys and Hungarian translations.

**Acceptance criteria**

- [ ] Labels such as manage, current selection, pinned, excluded, reduced, compacted, and source groups use i18n keys.
- [ ] English and Hungarian tests or snapshots cover the surface.
- [ ] The user-facing term is Context Sources; Evidence Manager remains only where it means per-message evidence/debug.

## 3. Extract Model-Scaled Context Budget Helper

**Type:** AFK

**Blocked by:** None

**User stories covered:** As an operator, I should be able to rely on model-derived context sizing instead of hidden tiny budgets.

**What to build:** Create one budget helper that derives usable model context, Target Constructed Context, Compaction Threshold, Reserved/Core/Support/Awareness budgets, and output reserve from provider/model metadata plus explicit admin overrides.

**Acceptance criteria**

- [ ] Unset Target Constructed Context defaults to about 90% of usable model context.
- [ ] Unset Compaction Threshold defaults to about 80% of usable model context.
- [ ] Explicit admin values override derived defaults.
- [ ] Unit tests assert exact math at this boundary.

## 4. Use Budget Helper For Current-Turn Attachments

**Type:** AFK

**Blocked by:** Slice 3

**User stories covered:** As a user, when I attach many readable documents to a large-context model, the app should not silently reduce them to tiny excerpts.

**What to build:** Replace the old small attachment prompt budget with model-scaled allocation for current-turn attachments.

**Acceptance criteria**

- [ ] Twelve current-turn readable attachments can become active Context Sources on a large model.
- [ ] Attachments receive near-full or meaningful structured Prompt Context when they fit.
- [ ] Under real budget pressure, attachments degrade by structure/chunks before falling to tiny excerpts.
- [ ] Context Sources reports the active attachment set.

## 5. Preserve Breadth For Explicit Active Source Sets

**Type:** AFK

**Blocked by:** Slice 4

**User stories covered:** As a user comparing many documents, no entire document should disappear before every active source gets meaningful representation.

**What to build:** Change allocation so explicit active source sets preserve breadth before depth. Every active attachment/document gets Reference or Excerpt Context before one source receives extra Task Context.

**Acceptance criteria**

- [ ] Active source sets preserve at least Reference Context for every source when budget allows.
- [ ] Under pressure, every explicit source gets a meaningful slice before extra depth is allocated.
- [ ] Comparison requests can promote multiple documents beyond the old one-primary-item assumption.
- [ ] Tests assert behavior rather than brittle token totals.

## 6. Replace Selected Evidence Count Caps With Budgeted Safeguards

**Type:** AFK

**Blocked by:** Slice 3

**User stories covered:** As a user, pinned or selected evidence should not be capped at a few items when the active model has room.

**What to build:** Remove or widen fixed selected-evidence and rerank count caps so they scale with budget and runtime safeguards.

**Acceptance criteria**

- [ ] Old `3`, `5`, `6`, and `8` style caps no longer decide product inclusion by themselves.
- [ ] Candidate/rerank limits are documented as performance safeguards.
- [ ] Pinned/preferred evidence remains budgeted and may be downgraded rather than dropped.
- [ ] Tests cover multi-document selected evidence behavior.

## 7. Carry Forward Active Context Sources Across Turns

**Type:** AFK

**Blocked by:** Slices 1, 4, and 5

**User stories covered:** As a user, documents that define a conversation should remain available on the next turn without re-attaching them.

**What to build:** Persist or recompute active Context Sources across turns until topic shift, reset, exclusion, or task boundary changes demote them.

**Acceptance criteria**

- [ ] The next turn after twelve attachments still shows them as active Context Sources.
- [ ] Active sources remain eligible for Prompt Context before generic retrieval.
- [ ] Clear topic shift can demote active sources into inferred available sources.
- [ ] User exclusion/reset overrides decay.

## 8. Narrow Old Evidence Manager Debug Path

**Type:** AFK

**Blocked by:** Slices 1, 2, and 7

**User stories covered:** As a maintainer, there should not be two competing source-management systems.

**What to build:** Replace conversation-level source management with `contextSources` and narrow the old evidence/debug state to message-level evidence, diagnostics, and task traces.

**Acceptance criteria**

- [ ] Conversation-level UI reads from `contextSources`.
- [ ] `ContextDebugState` is no longer the product source-management contract.
- [ ] Message Evidence remains attached to each assistant response.
- [ ] Obsolete hard-cap UI/debug assumptions are removed or renamed.
