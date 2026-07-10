# Memory Rework Implementation Issues

Local breakdown of ADR 0033 and the related CONTEXT.md glossary additions into independently grabbable implementation slices.

This document is local planning output, not published tracker state. Issue ids use `MR-xx` so dependencies can be reviewed before tracker issues are created.

## Sources

- `docs/adr/0033-guided-memory-review.md`
- `CONTEXT.md` memory glossary additions
- `docs/prototypes/memory-profile-ui-architecture.html`
- Current implementation surfaces inspected while drafting:
  - Knowledge page and memory UI
  - Knowledge memory API/client modules
  - Honcho service boundary
  - Memory context tool
  - Normal Chat prompt assembly
  - Existing maintenance scheduler and account clear route
  - Existing DB schema memory/project/event tables

## User Stories

- U1: As a user, I can open Knowledge Base and first see a curated Memory Profile, not raw Honcho output or document management.
- U2: As a user, I can understand active remembered facts through four clear categories.
- U3: As a user, I can edit, delete, or suppress a remembered fact and trust the next chat turn to use the new truth.
- U4: As a user, I can review only genuinely ambiguous memory questions in a capped, optional Needs Review area.
- U5: As a user, I do not see Focus Continuity, backend task memory, raw durable-memory tables, confidence/debug labels, or memory-pressure warnings.
- U6: As a user, I can inspect why a memory is remembered through a short explanation and source chips without seeing raw evidence dumps.
- U7: As a user, I can keep documents separate from profile memory; uploaded files do not become user-truth merely because they exist.
- U8: As a user, I can ask historical/source questions and get source-framed evidence without reactivating deleted or stale profile truth.
- U9: As a user, old noisy Honcho memories are migrated cautiously so valuable memory is preserved but only high-quality material becomes active.
- U10: As a user, Clear Memory and Knowledge removes all new memory state and prevents async work from recreating it.
- U11: As an operator, memory maintenance is bounded, coalesced, restart-safe, and does not run expensive reconciliation from every chat or Knowledge Base open.
- U12: As an operator, memory behavior is measurable through privacy-preserving telemetry event families.

## Dependency Overview

```text
Foundation: MR-01..MR-08
Profile read/write and prompt safety: MR-09..MR-18
Knowledge Base UI: MR-19..MR-26
Intake gate: MR-27..MR-36
Maintenance and reconciliation: MR-37..MR-49
Legacy migration and reset: MR-50..MR-55
Telemetry, rollout, and final polish: MR-56..MR-60
```

## Proposed Slices

1. MR-01 - Memory Reset Generation Foundation - AFK - Blocked by: None - Stories: U10
2. MR-02 - Projection Schema And Empty Read Model - AFK - Blocked by: MR-01 - Stories: U1, U2, U3
3. MR-03 - Projection Provenance Links - AFK - Blocked by: MR-02 - Stories: U6, U9
4. MR-04 - Memory Review Item Store And Resolution Contract - AFK - Blocked by: MR-02 - Stories: U4
5. MR-05 - Memory Dirty State Ledger - AFK - Blocked by: MR-01 - Stories: U11
6. MR-06 - Memory Rework Telemetry Writer - AFK - Blocked by: MR-01 - Stories: U12
7. MR-07 - Projection Revision Guard - AFK - Blocked by: MR-02 - Stories: U3, U11
8. MR-08 - Memory Profile Public Types - AFK - Blocked by: MR-02, MR-03, MR-04 - Stories: U1, U2, U4, U6
9. MR-09 - Memory Profile GET API - AFK - Blocked by: MR-08 - Stories: U1, U2, U4
10. MR-10 - Memory Profile Refresh Dirty Marking - AFK - Blocked by: MR-05, MR-09 - Stories: U1, U11
11. MR-11 - Profile Action API For Delete And Suppress - AFK - Blocked by: MR-07, MR-09 - Stories: U3
12. MR-12 - Profile Edit API With Memory Edit Classification - AFK - Blocked by: MR-07, MR-11 - Stories: U3
13. MR-13 - Profile Action Honcho Reconciliation Marking - AFK - Blocked by: MR-05, MR-11, MR-12 - Stories: U3, U11
14. MR-14 - Active Memory Profile Context Service - AFK - Blocked by: MR-09, MR-11, MR-12 - Stories: U3, U8
15. MR-15 - Normal Chat Projection-Gated Prompt Memory - AFK - Blocked by: MR-14 - Stories: U3, U8
16. MR-16 - Memory Context Tool Historical Evidence Policy - AFK - Blocked by: MR-14 - Stories: U8
17. MR-17 - Prompt-Use Telemetry For Memory Inclusion And Blocking - AFK - Blocked by: MR-06, MR-14, MR-15 - Stories: U12
18. MR-18 - Authority Fallback For Profile Reads - AFK - Blocked by: MR-09, MR-10 - Stories: U1, U3, U11
19. MR-19 - Knowledge Base Memory/Documents Tabs - AFK - Blocked by: MR-09 - Stories: U1, U7
20. MR-20 - Curated Four-Category Memory Cards - AFK - Blocked by: MR-19 - Stories: U1, U2, U5
21. MR-21 - Remove Focus Continuity And Raw Memory Tables From UI - AFK - Blocked by: MR-19, MR-20 - Stories: U5
22. MR-22 - Memory Profile Auto-Refresh On Entry - AFK - Blocked by: MR-10, MR-19 - Stories: U1
23. MR-23 - Memory Item Detail Drawer With Source Authority - AFK - Blocked by: MR-11, MR-12, MR-20 - Stories: U3, U6
24. MR-24 - Needs Review Default Area - AFK - Blocked by: MR-04, MR-09, MR-19 - Stories: U4
25. MR-25 - Needs Review Overflow Modal - AFK - Blocked by: MR-24 - Stories: U4
26. MR-26 - Memory Profile UI Accessibility And Localization - AFK - Blocked by: MR-20, MR-23, MR-24, MR-25 - Stories: U1, U3, U4
27. MR-27 - Memory Intake Decision Contract - AFK - Blocked by: MR-05, MR-06 - Stories: U11, U12
28. MR-28 - Memory Intake Normalization Contract - AFK - Blocked by: MR-27 - Stories: U2, U7
29. MR-29 - Immediate Admission For Explicit User Facts - AFK - Blocked by: MR-27, MR-28 - Stories: U2
30. MR-30 - Preference Goal Constraint Admission Rules - AFK - Blocked by: MR-29 - Stories: U2
31. MR-31 - Assistant Prose Exclusion - AFK - Blocked by: MR-27 - Stories: U7
32. MR-32 - Document Memory Admission Boundary - AFK - Blocked by: MR-27, MR-28 - Stories: U7
33. MR-33 - Deferred Intake Dirty Marking - AFK - Blocked by: MR-05, MR-27 - Stories: U11, U12
34. MR-34 - Write Admitted Memory Through Authority And Projection - AFK - Blocked by: MR-02, MR-03, MR-29, MR-30 - Stories: U2, U3
35. MR-35 - Chat Turn Intake Integration - AFK - Blocked by: MR-31, MR-33, MR-34 - Stories: U2, U7, U11
36. MR-36 - Structured Work Output Intake Path - AFK - Blocked by: MR-32, MR-34, MR-35 - Stories: U7
37. MR-37 - Typed Memory Maintenance Scheduler - AFK - Blocked by: MR-05, MR-06 - Stories: U11
38. MR-38 - Bounded Reconciliation Slice Runner - AFK - Blocked by: MR-37 - Stories: U11
39. MR-39 - Active Profile Budget Enforcement - AFK - Blocked by: MR-38, MR-08 - Stories: U2, U9, U11
40. MR-40 - Duplicate Merge With User-Authored Memory Precedence - AFK - Blocked by: MR-38, MR-39 - Stories: U3, U9
41. MR-41 - Conservative Memory Profile Split - AFK - Blocked by: MR-40 - Stories: U2, U3
42. MR-42 - Active-Use Expiry And Supersession - AFK - Blocked by: MR-38, MR-40 - Stories: U3, U8
43. MR-43 - Memory Conflict Block - AFK - Blocked by: MR-42, MR-04 - Stories: U4, U8
44. MR-44 - Review Generation Caps And Obsolescence - AFK - Blocked by: MR-43, MR-24 - Stories: U4, U11
45. MR-45 - Automatic Junk Deletion Gate - AFK - Blocked by: MR-38, MR-39 - Stories: U9, U11
46. MR-46 - Safe Memory Match For Authority Mutation - AFK - Blocked by: MR-03, MR-13, MR-45 - Stories: U3, U11
47. MR-47 - Honcho Cleanup And Dreaming Reconciliation - AFK - Blocked by: MR-46 - Stories: U3, U11
48. MR-48 - Memory Authority Fallback Retry Path - AFK - Blocked by: MR-18, MR-47 - Stories: U3, U11
49. MR-49 - Stale Maintenance Output Rejection - AFK - Blocked by: MR-07, MR-38 - Stories: U3, U11
50. MR-50 - Lazy Legacy Migration Claim - AFK - Blocked by: MR-37, MR-38 - Stories: U9, U11
51. MR-51 - Legacy Candidate Classification - AFK - Blocked by: MR-28, MR-39, MR-50 - Stories: U9, U12
52. MR-52 - Preserved Legacy Memory State - AFK - Blocked by: MR-51 - Stories: U8, U9
53. MR-53 - Legacy Review And Conflict Routing - AFK - Blocked by: MR-44, MR-52 - Stories: U4, U9
54. MR-54 - Clear Memory And Knowledge Clears Rework State - AFK - Blocked by: MR-01, MR-02, MR-04, MR-05, MR-06, MR-52 - Stories: U10
55. MR-55 - Reset Generation Guards Async Output - AFK - Blocked by: MR-49, MR-54 - Stories: U10, U11
56. MR-56 - Memory Rework Telemetry Coverage - AFK - Blocked by: MR-17, MR-27, MR-38, MR-44, MR-54 - Stories: U12
57. MR-57 - Remove Raw Transcript Mirroring As Memory Admission - AFK - Blocked by: MR-35, MR-56 - Stories: U7, U11
58. MR-58 - End-To-End Prompt Safety Regression Suite - AFK - Blocked by: MR-15, MR-16, MR-42, MR-43, MR-57 - Stories: U3, U8
59. MR-59 - End-To-End Knowledge Base UX Regression Suite - AFK - Blocked by: MR-22, MR-23, MR-24, MR-25, MR-26 - Stories: U1, U3, U4, U5, U7
60. MR-60 - Final Visual Polish Review - HITL - Blocked by: MR-59 - Stories: U1, U3, U4

## Issue Bodies

### MR-01 - Memory Reset Generation Foundation

**Type:** AFK

**User stories covered:** U10

#### What to build

Add a durable Memory Reset Generation for each user and make it available to future memory writes, maintenance work, and profile reads. The generation should be advanced by Clear Memory and Knowledge and should be cheap to compare in later slices.

#### Acceptance criteria

- [ ] A user's current memory reset generation can be read by memory services without touching Honcho.
- [ ] Clear Memory and Knowledge advances the generation even before later projection tables exist.
- [ ] Tests prove old generation values can be detected and rejected by a simple guard.

#### Blocked by

None - can start immediately.

### MR-02 - Projection Schema And Empty Read Model

**Type:** AFK

**User stories covered:** U1, U2, U3

#### What to build

Add the durable Memory Profile Projection store for Memory Profile Items. It should support stable item identity, category, scope, active-use state, user-facing statement, timestamps, and reset generation. The first read path may return an empty projection for users without migrated or admitted memory.

#### Acceptance criteria

- [ ] Memory Profile Items can be created, read, updated, and filtered by user and reset generation.
- [ ] Active reads exclude deleted, suppressed, expired, blocked, deferred, and review-needed states.
- [ ] Empty projection reads return a valid empty Memory Profile shape rather than falling back to raw Honcho.

#### Blocked by

- MR-01

### MR-03 - Projection Provenance Links

**Type:** AFK

**User stories covered:** U6, U9

#### What to build

Add Memory Profile Provenance Links behind projection items. Links should record supporting sources such as Honcho conclusion, user statement, review decision, source chat, document rule, or structured work output without turning each source into a user-facing item.

#### Acceptance criteria

- [ ] A projection item can have multiple provenance links.
- [ ] Details can derive compact source chips from provenance links.
- [ ] Provenance links are scoped to reset generation and are deleted or ignored after reset.

#### Blocked by

- MR-02

### MR-04 - Memory Review Item Store And Resolution Contract

**Type:** AFK

**User stories covered:** U4

#### What to build

Add durable Memory Review Items with lifecycle states `open`, `resolved`, and `obsolete`, a stable Memory Review Subject, affected projection item references, and a Memory Review Resolution contract. Resolutions should share the three meanings from ADR 0033: use this remembered fact, edit the remembered fact, or do not remember this subject. The store should dedupe open review items by subject.

#### Acceptance criteria

- [ ] Creating a review item for an existing open subject attaches or updates evidence instead of creating a duplicate.
- [ ] Review items remain stable across Memory Profile Refresh.
- [ ] Memory Review Resolution values are shared across review types rather than custom per-review action vocabularies.
- [ ] Resolved and obsolete review items do not appear in the default Needs Review read.

#### Blocked by

- MR-02

### MR-05 - Memory Dirty State Ledger

**Type:** AFK

**User stories covered:** U11

#### What to build

Add the durable Memory Dirty State Ledger for typed account-level maintenance signals. It should coalesce repeated reasons without storing raw candidate text.

#### Acceptance criteria

- [ ] Dirty entries can be marked for stale projection, deferred intake, profile action reconciliation, possible conflict, possible duplicate, legacy migration, Honcho reconciliation, and review generation.
- [ ] Repeated marks for the same user, generation, scope, and reason coalesce.
- [ ] Dirty entries contain stable identifiers, counts, timestamps, and reason metadata, not raw chat excerpts or raw memory text.

#### Blocked by

- MR-01

### MR-06 - Memory Rework Telemetry Writer

**Type:** AFK

**User stories covered:** U12

#### What to build

Add a privacy-preserving Memory Rework Telemetry writer with fixed event families. Events should be backend/log or DB-level only by default and avoid raw remembered text.

#### Acceptance criteria

- [ ] Event families exist for intake, active profile projection, prompt use, maintenance, guided review, profile action, reset or forget, and error or fallback.
- [ ] Telemetry accepts categories, reasons, statuses, counts, stable identifiers, and durations.
- [ ] Tests prevent raw remembered text, raw prompt excerpts, or raw chat excerpts from being required fields.

#### Blocked by

- MR-01

### MR-07 - Projection Revision Guard

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

Add Memory Projection Revision checks so user edits and background maintenance cannot race with last-writer-wins semantics.

#### Acceptance criteria

- [ ] Projection reads expose the current revision needed for user actions.
- [ ] Writes can require an expected revision and reject stale writes.
- [ ] Tests prove stale maintenance output cannot overwrite a newer user edit, deletion, suppression, or review decision.

#### Blocked by

- MR-02

### MR-08 - Memory Profile Public Types

**Type:** AFK

**User stories covered:** U1, U2, U4, U6

#### What to build

Define the app-ready Memory Profile payload used by server APIs, client API helpers, and UI components. It should expose only curated items, categories, compact counts, review summaries, item details, source chips, and action availability.

#### Acceptance criteria

- [ ] Public types include the four categories: About You, Preferences, Goals & Ongoing Work, Constraints & Boundaries.
- [ ] Public types separate default card fields from detail fields.
- [ ] Public types do not include raw Honcho rows, confidence/debug scores, or raw durable-memory table rows.

#### Blocked by

- MR-02
- MR-03
- MR-04

### MR-09 - Memory Profile GET API

**Type:** AFK

**User stories covered:** U1, U2, U4

#### What to build

Expose a thin Memory Profile GET API that reads the projection, visible review items, and compact count badge data. It should replace the old Knowledge Memory Overview contract for the new UI while keeping routes as transport adapters.

#### Acceptance criteria

- [ ] The API returns active items grouped by category.
- [ ] The API returns at most three visible open review items plus overflow count.
- [ ] The API never returns Focus Continuity, task-memory tables, raw Honcho dumps, or raw durable-memory rows.

#### Blocked by

- MR-08

### MR-10 - Memory Profile Refresh Dirty Marking

**Type:** AFK

**User stories covered:** U1, U11

#### What to build

Make Memory Profile Refresh cheap and read-side only. Opening Knowledge Base or Memory Profile should render the current projection and mark dirty work if the projection is stale, without running expensive reconciliation synchronously.

#### Acceptance criteria

- [ ] A stale projection read returns current durable data immediately.
- [ ] A stale projection read marks a typed dirty ledger entry for background work.
- [ ] Tests prove Memory Profile Refresh does not call LLM pruning, Honcho Dreaming, full legacy migration, or expensive reconciliation inline.

#### Blocked by

- MR-05
- MR-09

### MR-11 - Profile Action API For Delete And Suppress

**Type:** AFK

**User stories covered:** U3

#### What to build

Add profile action endpoints for Memory Profile Deletion and Memory Profile Suppression. Both should remove the item from active use immediately in the projection, even when backing Honcho cleanup is not yet complete.

#### Acceptance criteria

- [ ] Delete and suppress actions require the current projection revision.
- [ ] Deleted or suppressed items disappear from the active profile response immediately.
- [ ] The next Active Memory Profile Context read excludes deleted and suppressed items.

#### Blocked by

- MR-07
- MR-09

### MR-12 - Profile Edit API With Memory Edit Classification

**Type:** AFK

**User stories covered:** U3

#### What to build

Add direct full-statement edit for Memory Profile Items when the edit can be made next-turn-effective. The API should use Memory Edit Classification to distinguish same-item corrections, replacement items, and ambiguous rewrites that need plain confirmation.

#### Acceptance criteria

- [ ] Same-slot edits update the user-facing statement and active context immediately.
- [ ] Stale revision edits are rejected without overwriting newer state.
- [ ] Memory Edit Classification compares the normalized Memory Slot rather than text length or character similarity.
- [ ] Ambiguous or unrelated rewrites do not silently preserve the old identity.

#### Blocked by

- MR-07
- MR-11

### MR-13 - Profile Action Honcho Reconciliation Marking

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

After edit, delete, or suppress actions, mark targeted dirty ledger work for safe Honcho reconciliation instead of running broad cleanup from the request.

#### Acceptance criteria

- [ ] Profile actions enqueue targeted reconciliation dirty state with stable item identifiers.
- [ ] The user-facing action succeeds locally when the projection write succeeds.
- [ ] Honcho failures are not shown as user-facing errors for already-saved projection changes.

#### Blocked by

- MR-05
- MR-11
- MR-12

### MR-14 - Active Memory Profile Context Service

**Type:** AFK

**User stories covered:** U3, U8

#### What to build

Create the model-facing Active Memory Profile Context service from the same projection used by the UI. It should return only active usable items and omit UI-only details.

#### Acceptance criteria

- [ ] Active context includes only active usable projection items.
- [ ] Deleted, suppressed, expired, blocked, review-needed, preserved legacy, deferred, and ambiguous-scope items are excluded.
- [ ] The service output can be consumed by Normal Chat without relying on raw Honcho prompt context.

#### Blocked by

- MR-09
- MR-11
- MR-12

### MR-15 - Normal Chat Projection-Gated Prompt Memory

**Type:** AFK

**User stories covered:** U3, U8

#### What to build

Wire Normal Chat prompt assembly to use Active Memory Profile Context for ordinary personalization. Raw Honcho context should not bypass projection state for current profile truth.

#### Acceptance criteria

- [ ] Ordinary prompt personalization uses Active Memory Profile Context.
- [ ] Raw Honcho memory cannot reintroduce deleted, suppressed, expired, conflict-blocked, review-needed, or preserved legacy memory as current truth.
- [ ] Tests cover a deleted or edited profile item being respected on the next chat turn.

#### Blocked by

- MR-14

### MR-16 - Memory Context Tool Historical Evidence Policy

**Type:** AFK

**User stories covered:** U8

#### What to build

Update the Memory Context Tool so explicit history, source, document, or evidence questions may return compact Historical Memory Evidence without treating it as current profile truth.

#### Acceptance criteria

- [ ] Explicit history/source queries can return source-framed historical evidence.
- [ ] Deleted or suppressed profile memory is not returned as remembered context through memory recall.
- [ ] Historical results are framed as historical-only, source-record, or unresolved-conflict where applicable.

#### Blocked by

- MR-14

### MR-17 - Prompt-Use Telemetry For Memory Inclusion And Blocking

**Type:** AFK

**User stories covered:** U12

#### What to build

Record telemetry for active memory included in prompt context and memory blocked due to deletion, correction, suppression, expiry, conflict, review, or preservation. Do not log prompt excerpts.

#### Acceptance criteria

- [ ] Prompt-use telemetry records counts, categories, statuses, and reasons.
- [ ] Prompt-use telemetry does not store raw prompt text or raw remembered text.
- [ ] Tests cover included and blocked memory telemetry paths.

#### Blocked by

- MR-06
- MR-14
- MR-15

### MR-18 - Authority Fallback For Profile Reads

**Type:** AFK

**User stories covered:** U1, U3, U11

#### What to build

When Honcho refresh or reconciliation is unavailable, keep the durable projection as the user-facing truth and report retryable dirty work or telemetry instead of falling back to raw or empty Honcho output.

#### Acceptance criteria

- [ ] Projection reads still return the last durable profile when Honcho is unavailable.
- [ ] Honcho unavailability marks retryable dirty work or telemetry.
- [ ] If the durable projection cannot be read, the API returns an ordinary load failure rather than raw Honcho memory.

#### Blocked by

- MR-09
- MR-10

### MR-19 - Knowledge Base Memory/Documents Tabs

**Type:** AFK

**User stories covered:** U1, U7

#### What to build

Split Knowledge Base into Memory Profile and Documents tabs. Normal navigation opens Memory Profile first; explicit document workflows may activate Documents without changing the normal default.

#### Acceptance criteria

- [ ] Knowledge Base has two tabs: Memory Profile first, Documents second.
- [ ] Normal navigation opens Memory Profile even if the user previously used Documents.
- [ ] Existing document upload, search, preview, workspace, download, and management behavior remains in Documents.

#### Blocked by

- MR-09

### MR-20 - Curated Four-Category Memory Cards

**Type:** AFK

**User stories covered:** U1, U2, U5

#### What to build

Replace the current markdown-like overview with category sections and cards for active Memory Profile Items. Use the four categories and compact item counts.

#### Acceptance criteria

- [ ] Default cards show the remembered statement and icon actions.
- [ ] Categories are About You, Preferences, Goals & Ongoing Work, and Constraints & Boundaries.
- [ ] Global scope labels are hidden on default cards; project, conversation, and document scope labels remain visible.

#### Blocked by

- MR-19

### MR-21 - Remove Focus Continuity And Raw Memory Tables From UI

**Type:** AFK

**User stories covered:** U5

#### What to build

Remove Focus Continuity, backend task memory, and raw durable-memory pruning tables from the Knowledge Base UI and admin-visible memory UI.

#### Acceptance criteria

- [ ] Knowledge Base no longer exposes Focus Continuity or backend task-memory sections.
- [ ] Raw durable-memory records do not appear as user or admin tables.
- [ ] Tests prove the new Memory Profile UI renders without old manage-persona/focus entry points.

#### Blocked by

- MR-19
- MR-20

### MR-22 - Memory Profile Auto-Refresh On Entry

**Type:** AFK

**User stories covered:** U1

#### What to build

Refresh the Memory Profile automatically when the user opens Knowledge Base or the Memory Profile tab. Remove manual reload semantics and explanatory auto-refresh copy.

#### Acceptance criteria

- [ ] Opening the Memory Profile triggers a cheap profile refresh request.
- [ ] The UI does not show a manual reload icon for the default Memory Profile.
- [ ] The UI does not show "refreshed automatically" explanatory status text.

#### Blocked by

- MR-10
- MR-19

### MR-23 - Memory Item Detail Drawer With Source Authority

**Type:** AFK

**User stories covered:** U3, U6

#### What to build

Add the Memory Profile item detail/edit surface with full statement edit, category, scope, short provenance summary, Memory Source Authority in human-readable terms, up to three source chips, secondary source expansion, and one action row for save, cancel, and delete.

#### Acceptance criteria

- [ ] Detail view is human-readable and does not expose raw Honcho rows or technical tables.
- [ ] Memory Source Authority appears only in item details, not as default card badges.
- [ ] Save, cancel, and delete fit in one action row using accessible icon buttons.
- [ ] Delete uses a trash affordance and removes active use immediately through the action API.

#### Blocked by

- MR-11
- MR-12
- MR-20

### MR-24 - Needs Review Default Area

**Type:** AFK

**User stories covered:** U4

#### What to build

Add the dedicated full-width Needs Review area above normal categories when open review items exist. It should show at most three items, no subtitle filler, and icon actions.

#### Acceptance criteria

- [ ] Needs Review appears above the categories only when open review items exist.
- [ ] At most three review items are visible in the default area.
- [ ] Review actions use accessible icon buttons for use, edit, and do not remember.

#### Blocked by

- MR-04
- MR-09
- MR-19

### MR-25 - Needs Review Overflow Modal

**Type:** AFK

**User stories covered:** U4

#### What to build

Add the extended review modal for overflow review items. It should be a compact decision list, not a separate inbox or evidence browser.

#### Acceptance criteria

- [ ] The overflow entry opens a modal with compact rows.
- [ ] Each row has one question, one reason sentence, and icon actions.
- [ ] Source evidence remains behind item details, not in the modal by default.

#### Blocked by

- MR-24

### MR-26 - Memory Profile UI Accessibility And Localization

**Type:** AFK

**User stories covered:** U1, U3, U4

#### What to build

Complete localization and accessibility for the new Memory Profile UI in English and Hungarian. Icon-only controls must have accessible names and tooltips.

#### Acceptance criteria

- [ ] New UI text is localized in English and Hungarian.
- [ ] Icon-only actions have accessible labels and hover/focus tooltips.
- [ ] Keyboard focus order works for tabs, item actions, drawer actions, and review modal actions.

#### Blocked by

- MR-20
- MR-23
- MR-24
- MR-25

### MR-27 - Memory Intake Decision Contract

**Type:** AFK

**User stories covered:** U11, U12

#### What to build

Add the structured Memory Intake Decision contract with outcomes admit, reject, and defer to maintenance. The contract should support reasons, category, scope, confidence band, and telemetry metadata without storing raw candidates by default.

#### Acceptance criteria

- [ ] Intake decisions are locally validated before durable writes.
- [ ] Reject and defer decisions can record telemetry without raw candidate text.
- [ ] Admit decisions carry enough normalized metadata to write through the memory authority and projection.

#### Blocked by

- MR-05
- MR-06

### MR-28 - Memory Intake Normalization Contract

**Type:** AFK

**User stories covered:** U2, U7

#### What to build

Add the Memory Intake Normalization contract that turns admitted material into a clean remembered statement with one primary category, scope, reason, and provenance summary.

#### Acceptance criteria

- [ ] Normalization chooses one category by precedence.
- [ ] Normalization chooses the narrowest confident scope.
- [ ] Ambiguous statement, category, or scope results in defer rather than a hidden guess.

#### Blocked by

- MR-27

### MR-29 - Immediate Admission For Explicit User Facts

**Type:** AFK

**User stories covered:** U2

#### What to build

Implement Immediate Memory Admission for stable first-party user facts, including facts like "I live in Amsterdam," when they are clearly user-authored and not document-derived or assistant-inferred.

#### Acceptance criteria

- [ ] Stable first-party user facts can be admitted without requiring the word "remember."
- [ ] Ambiguous self-statements defer to maintenance.
- [ ] Document-derived or assistant-inferred self-truth is not admitted through this path.

#### Blocked by

- MR-27
- MR-28

### MR-30 - Preference Goal Constraint Admission Rules

**Type:** AFK

**User stories covered:** U2

#### What to build

Implement stricter immediate admission rules for preferences, constraints, goals, project rules, and document rules. These should require explicit durable language or strong explicit phrasing.

#### Acceptance criteria

- [ ] Durable language such as "remember," "always," and "from now on" can admit eligible memory.
- [ ] Soft one-off instructions such as "make this shorter" are rejected or deferred.
- [ ] Constraints & Boundaries win category precedence for hard rules and "never" or "must" language.

#### Blocked by

- MR-29

### MR-31 - Assistant Prose Exclusion

**Type:** AFK

**User stories covered:** U7

#### What to build

Prevent ordinary assistant-generated answer text from becoming a source for Immediate Memory Admission. Assistant prose may remain chat history or evidence, but not durable memory authority.

#### Acceptance criteria

- [ ] Assistant responses are excluded from immediate durable memory writes.
- [ ] Assistant summaries, guesses, and document interpretations do not become Memory Profile material without user confirmation.
- [ ] Tests cover a tempting assistant inference being rejected.

#### Blocked by

- MR-27

### MR-32 - Document Memory Admission Boundary

**Type:** AFK

**User stories covered:** U7

#### What to build

Implement the document boundary so uploaded, attached, generated, or stored document contents stay document evidence unless the user explicitly frames a fact or workflow rule as durable memory.

#### Acceptance criteria

- [ ] Uploaded receipts, tax papers, third-party PDFs, and unrelated references do not become profile memory merely because they are processed.
- [ ] Explicit durable document-workflow instructions can become Document-Scoped Memory.
- [ ] Repeated document workflow behavior marks telemetry or dirty work rather than silently admitting a rule.

#### Blocked by

- MR-27
- MR-28

### MR-33 - Deferred Intake Dirty Marking

**Type:** AFK

**User stories covered:** U11, U12

#### What to build

When intake cannot confidently admit or reject material, record privacy-preserving telemetry and dirty state instead of storing a raw pending candidate queue.

#### Acceptance criteria

- [ ] Defer records a typed dirty ledger entry.
- [ ] Defer records telemetry reason and stable identifiers.
- [ ] Defer does not persist raw candidate text as a long-lived maybe-memory backlog.

#### Blocked by

- MR-05
- MR-27

### MR-34 - Write Admitted Memory Through Authority And Projection

**Type:** AFK

**User stories covered:** U2, U3

#### What to build

When the intake gate admits a normalized memory, write through the existing memory authority path and update or create a projection item so the Memory Profile and next prompt see the same active truth.

#### Acceptance criteria

- [ ] Admitted memory creates or updates a projection item.
- [ ] Admitted memory records provenance linking the intake source and authority write.
- [ ] If Honcho write fails, projection fallback and retryable dirty work follow Memory Authority Fallback.

#### Blocked by

- MR-02
- MR-03
- MR-29
- MR-30

### MR-35 - Chat Turn Intake Integration

**Type:** AFK

**User stories covered:** U2, U7, U11

#### What to build

Integrate Memory Intake Gate into chat-turn finalization or the existing post-turn memory boundary. It should evaluate only eligible user-authored and typed structured material, not mirror every message.

#### Acceptance criteria

- [ ] Ordinary task chatter does not become durable persona memory merely because it was sent.
- [ ] Explicit durable user memory can be admitted after a chat turn.
- [ ] Chat turns mark dirty work but do not run full expensive reconciliation.

#### Blocked by

- MR-31
- MR-33
- MR-34

### MR-36 - Structured Work Output Intake Path

**Type:** AFK

**User stories covered:** U7

#### What to build

Route app-owned structured outputs such as work capsules, generated-document metadata, skill notes, task-continuity updates, and typed tool outcomes through typed, scoped, provenance-aware intake rather than raw assistant prose.

#### Acceptance criteria

- [ ] Structured outputs can become memory only through a typed intake path.
- [ ] User-authored corrections override conflicting structured outputs immediately.
- [ ] Generated document metadata does not become global user preference by default.

#### Blocked by

- MR-32
- MR-34
- MR-35

### MR-37 - Typed Memory Maintenance Scheduler

**Type:** AFK

**User stories covered:** U11

#### What to build

Add a Memory Maintenance Scheduler that claims Memory Dirty State Ledger work by user, generation, priority, cooldown, and budget. It should be distinct from direct chat-turn or Knowledge Base reconciliation.

#### Acceptance criteria

- [ ] Scheduler claims dirty work for one user at a time under configured concurrency.
- [ ] Multiple active chats coalesce into shared dirty work.
- [ ] Server restart leaves durable dirty work claimable later.

#### Blocked by

- MR-05
- MR-06

### MR-38 - Bounded Reconciliation Slice Runner

**Type:** AFK

**User stories covered:** U11

#### What to build

Implement Bounded Memory Reconciliation Slices with time, token, candidate, projection mutation, Honcho authority call, review item, and Dreaming limits.

#### Acceptance criteria

- [ ] A slice processes only configured candidate and mutation limits.
- [ ] Unfinished work remains pending when limits are reached.
- [ ] Slice output records maintenance telemetry without raw remembered text.

#### Blocked by

- MR-37

### MR-39 - Active Profile Budget Enforcement

**Type:** AFK

**User stories covered:** U2, U9, U11

#### What to build

Implement the internal Adaptive Active Memory Budget pressure behavior. It should merge or compact first, expire active use second, preserve lower-priority memory third, and create review only when user judgment is needed and caps allow it.

#### Acceptance criteria

- [ ] Active profile pressure is internal and never shown as a quota or warning.
- [ ] Hard constraints can exceed category soft targets.
- [ ] Budget pressure never permanently deletes meaningful memory merely because it exceeds a target.

#### Blocked by

- MR-38
- MR-08

### MR-40 - Duplicate Merge With User-Authored Memory Precedence

**Type:** AFK

**User stories covered:** U3, U9

#### What to build

Allow maintenance to merge clearly duplicate or overlapping Memory Profile Items while preserving User-Authored Memory Precedence for edits, deletions, suppressions, and review decisions.

#### Acceptance criteria

- [ ] User-authored profile state wins over Honcho-derived or structured duplicates.
- [ ] Similar but not clearly same facts are not force-merged.
- [ ] Merged items keep provenance links from supporting sources.

#### Blocked by

- MR-38
- MR-39

### MR-41 - Conservative Memory Profile Split

**Type:** AFK

**User stories covered:** U2, U3

#### What to build

Allow maintenance to split one projection item into child items only when it clearly contains multiple Memory Slots. Preserve parent user-authored state and assign provenance conservatively.

#### Acceptance criteria

- [ ] Splits create child items only for clearly distinct memory slots.
- [ ] Deleted or suppressed parent evidence does not revive active children without new explicit user-authored evidence.
- [ ] Ambiguous splits become review or stay unchanged.

#### Blocked by

- MR-40

### MR-42 - Active-Use Expiry And Supersession

**Type:** AFK

**User stories covered:** U3, U8

#### What to build

Implement Memory Active-Use Expiry for remembered facts that are superseded, stale in a user-impacting way, time-bound and past, or no longer confidently useful. Preserve historical evidence unless the user requested deletion or suppression.

#### Acceptance criteria

- [ ] Newer user-authored same-scope evidence can expire older active use without asking.
- [ ] Old but stable, durable, and uncontradicted facts do not expire from age alone.
- [ ] Expired memory is excluded from ordinary personalization but may be historical evidence when appropriate.

#### Blocked by

- MR-38
- MR-40

### MR-43 - Memory Conflict Block

**Type:** AFK

**User stories covered:** U4, U8

#### What to build

Implement item-level Memory Conflict Blocks for same-scope contradictions that cannot be safely resolved. Blocked items should stay out of ordinary prompt context and normal categories.

#### Acceptance criteria

- [ ] Same-scope contradictions can be blocked from active personalization.
- [ ] Cross-scope differences are not treated as contradictions merely because wording overlaps.
- [ ] Conflicts needing user authority route to Guided Memory Review rather than normal category cards.

#### Blocked by

- MR-42
- MR-04

### MR-44 - Review Generation Caps And Obsolescence

**Type:** AFK

**User stories covered:** U4, U11

#### What to build

Generate review items from maintenance under caps: at most three new review items per bounded slice and at most twelve open review items per user. Mark review items obsolete when maintenance resolves the issue before the user acts.

#### Acceptance criteria

- [ ] Review item creation respects per-slice and per-user open caps.
- [ ] Overflow ambiguous material becomes inactive or preserved legacy rather than unbounded review work.
- [ ] Obsolete review items disappear from Needs Review without deleting history needed for telemetry.

#### Blocked by

- MR-43
- MR-24

### MR-45 - Automatic Junk Deletion Gate

**Type:** AFK

**User stories covered:** U9, U11

#### What to build

Implement the Automatic Junk Deletion Gate for malformed extraction residue, accidental technical artifacts, boilerplate interaction summaries, and meaning-preserving duplicates that support no active profile item.

#### Acceptance criteria

- [ ] Permanent deletion requires safely identifiable junk and exact remembered evidence where deletion is involved.
- [ ] Meaningful but stale, contradictory, sensitive, or merely old memories are not silently deleted as junk.
- [ ] Intake blocks only obvious junk; broader cleanup happens during background maintenance.

#### Blocked by

- MR-38
- MR-39

### MR-46 - Safe Memory Match For Authority Mutation

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

Implement Safe Memory Match so maintenance mutates backing remembered evidence only when provenance or tightly matching Memory Slot and authority relationships make the target safe.

#### Acceptance criteria

- [ ] Profile delete, suppress, or edit reconciles backing evidence only with Safe Memory Match.
- [ ] Partial or ambiguous provenance does not drive broad Honcho mutation.
- [ ] Tests cover a near-match that must not be deleted.

#### Blocked by

- MR-03
- MR-13
- MR-45

### MR-47 - Honcho Cleanup And Dreaming Reconciliation

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

Run targeted Honcho cleanup or replacement and bounded Honcho Dreaming from maintenance after safe profile actions, cleanup, supersession, or larger memory batches.

#### Acceptance criteria

- [ ] Honcho cleanup is targeted by Safe Memory Match.
- [ ] Honcho Dreaming is internal and never shown as a user-facing Memory Profile status.
- [ ] Dreaming uses configured per-user and per-day limits.

#### Blocked by

- MR-46

### MR-48 - Memory Authority Fallback Retry Path

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

When Honcho cleanup, replacement, refresh, or Dreaming fails, keep the projection as active truth and leave retryable dirty work with telemetry.

#### Acceptance criteria

- [ ] Failed authority cleanup does not undo projection changes.
- [ ] Retryable dirty work survives restart.
- [ ] Users see no action failure when the visible projection save succeeded.

#### Blocked by

- MR-18
- MR-47

### MR-49 - Stale Maintenance Output Rejection

**Type:** AFK

**User stories covered:** U3, U11

#### What to build

Ensure maintenance output applies only when Memory Projection Revision and Memory Reset Generation still match the state the slice read.

#### Acceptance criteria

- [ ] Stale revision output is discarded or retried without overwriting newer user state.
- [ ] Old reset generation output is discarded.
- [ ] Half-finished slices leave dirty work pending rather than marking it complete.

#### Blocked by

- MR-07
- MR-38

### MR-50 - Lazy Legacy Migration Claim

**Type:** AFK

**User stories covered:** U9, U11

#### What to build

Start Legacy Memory Migration lazily per user through dirty ledger and bounded maintenance, not through a full unbounded post-deployment sweep or user-facing migration wizard.

#### Acceptance criteria

- [ ] A user with no projection can be marked for legacy migration.
- [ ] Migration runs in bounded slices under normal scheduler limits.
- [ ] There is no special accelerated legacy catch-up mode before telemetry proves it is needed.

#### Blocked by

- MR-37
- MR-38

### MR-51 - Legacy Candidate Classification

**Type:** AFK

**User stories covered:** U9, U12

#### What to build

Classify legacy Honcho memory into active projection items, Preserved Legacy Memory, Guided Memory Review, or junk cleanup using category, scope, confidence band, source authority, and active profile pressure.

#### Acceptance criteria

- [ ] Only high-confidence, category- and scope-fitting legacy material becomes active.
- [ ] Unknown or ambiguous scope does not become active by default.
- [ ] Classification records telemetry reasons without storing raw legacy memory in telemetry.

#### Blocked by

- MR-28
- MR-39
- MR-50

### MR-52 - Preserved Legacy Memory State

**Type:** AFK

**User stories covered:** U8, U9

#### What to build

Represent Preserved Legacy Memory as inactive material in the same memory pipeline. It should not be user-browsable by default and should not enter Active Memory Profile Context.

#### Acceptance criteria

- [ ] Preserved legacy material is excluded from normal Memory Profile categories.
- [ ] Preserved legacy material is excluded from ordinary personalization.
- [ ] Explicit history/source questions may access it only as Historical Memory Evidence when allowed.

#### Blocked by

- MR-51

### MR-53 - Legacy Review And Conflict Routing

**Type:** AFK

**User stories covered:** U4, U9

#### What to build

Route valuable but uncertain legacy material to capped Guided Memory Review only when user judgment is needed. Otherwise preserve it for future triggers.

#### Acceptance criteria

- [ ] Legacy review creation respects open review caps.
- [ ] Repeated evidence for the same legacy review subject attaches to one open review item.
- [ ] Legacy material that overflows review caps becomes preserved or inactive, not another review question.

#### Blocked by

- MR-44
- MR-52

### MR-54 - Clear Memory And Knowledge Clears Rework State

**Type:** AFK

**User stories covered:** U10

#### What to build

Extend Clear Memory and Knowledge so it clears projection items, provenance links, review items, conflict blocks, dirty ledger entries, maintenance state, user-linked telemetry, preserved legacy state, and Honcho identity state.

#### Acceptance criteria

- [ ] Clear Memory and Knowledge removes or invalidates all new memory rework state for the user.
- [ ] User-linked telemetry clears; non-identifying aggregates remain only if they cannot reconstruct memory.
- [ ] Honcho-backed memory cannot reappear after reset through old peer identity or retry work.

#### Blocked by

- MR-01
- MR-02
- MR-04
- MR-05
- MR-06
- MR-52

### MR-55 - Reset Generation Guards Async Output

**Type:** AFK

**User stories covered:** U10, U11

#### What to build

Guard all in-flight and retrying memory maintenance, intake, profile reconciliation, Honcho cleanup, and telemetry writes with Memory Reset Generation.

#### Acceptance criteria

- [ ] Work started under an old generation cannot write projection, review, dirty, telemetry, or Honcho-derived state after reset.
- [ ] Tests simulate reset during in-flight maintenance and prove old output is discarded.
- [ ] Generation mismatch produces telemetry or logs without user-facing noise.

#### Blocked by

- MR-49
- MR-54

### MR-56 - Memory Rework Telemetry Coverage

**Type:** AFK

**User stories covered:** U12

#### What to build

Complete telemetry coverage across intake, projection, prompt use, maintenance, guided review, profile action, reset or forget, and error or fallback paths.

#### Acceptance criteria

- [ ] Each event family has at least one production path and tests.
- [ ] Telemetry includes statuses, reasons, counts, durations, and stable identifiers.
- [ ] Telemetry remains backend/log-only by default with no Memory Profile or admin dashboard.

#### Blocked by

- MR-17
- MR-27
- MR-38
- MR-44
- MR-54

### MR-57 - Remove Raw Transcript Mirroring As Memory Admission

**Type:** AFK

**User stories covered:** U7, U11

#### What to build

Stop treating every ordinary chat message as durable persona memory. Conversation history may remain available through chat history and retrieval, but durable memory admission must flow through the Memory Intake Gate and typed structured paths.

#### Acceptance criteria

- [ ] Ordinary user and assistant messages are not mirrored as durable persona memory by default.
- [ ] Existing chat history and history retrieval continue to work.
- [ ] Explicit durable memory intent still reaches the intake path and can become projection memory.

#### Blocked by

- MR-35
- MR-56

### MR-58 - End-To-End Prompt Safety Regression Suite

**Type:** AFK

**User stories covered:** U3, U8

#### What to build

Add end-to-end tests proving the prompt path respects projection state, historical evidence framing, deletion, suppression, expiry, conflict blocks, review-needed state, and preserved legacy state.

#### Acceptance criteria

- [ ] Deleted and suppressed items do not appear in ordinary prompt personalization.
- [ ] Expired, conflict-blocked, review-needed, and preserved legacy items do not appear as current truth.
- [ ] Explicit history/source questions can retrieve allowed historical evidence without reactivating it.

#### Blocked by

- MR-15
- MR-16
- MR-42
- MR-43
- MR-57

### MR-59 - End-To-End Knowledge Base UX Regression Suite

**Type:** AFK

**User stories covered:** U1, U3, U4, U5, U7

#### What to build

Add end-to-end and component tests for the new Knowledge Base Memory Profile UI, including tabs, categories, item actions, detail drawer, Needs Review area, overflow modal, and Documents separation.

#### Acceptance criteria

- [ ] Normal Knowledge Base navigation opens Memory Profile first.
- [ ] Memory Profile does not expose Focus Continuity, raw tables, reload icon, confidence/debug badges, or document controls.
- [ ] Documents tab keeps document upload, search, preview, workspace, download, and management separate.

#### Blocked by

- MR-22
- MR-23
- MR-24
- MR-25
- MR-26

### MR-60 - Final Visual Polish Review

**Type:** HITL

**User stories covered:** U1, U3, U4

#### What to build

Perform a final human design review of the implemented Memory Profile UI against the approved wireframe and ADR rules. This is the only intentionally HITL slice in the breakdown.

#### Acceptance criteria

- [ ] Desktop default view matches the approved architecture: compact count badge, icon actions, Needs Review cap, four categories, no raw memory surfaces.
- [ ] Item detail and review modal match the approved density and action rules.
- [ ] Any visual deviations are accepted explicitly or corrected before the rework is called done.

#### Blocked by

- MR-59

## Review Pass 1 - ADR And Glossary Coverage

Checked coverage against ADR 0033 and CONTEXT.md terms. The issue set covers:

- Memory Profile Projection, stable identity, provenance links, active-use state, revision guards.
- Memory Profile UI, Knowledge Base tab split, Needs Review, Memory Review Resolution, review overflow, item detail/edit/delete, Memory Source Authority, and source chips.
- Removal of Focus Continuity, raw durable-memory tables, raw Honcho dumps, reload icon, default confidence/freshness/provenance badges, and pressure warnings.
- Projection-Gated Memory Access, Active Memory Profile Context, Pre-Filtered Prompt Memory, and Historical Memory Evidence.
- Memory Intake Gate, Memory Intake Decision, Immediate Memory Admission, Assistant Prose Memory Exclusion, Memory Intake Normalization, Document Memory Admission, Document-Scoped Memory, and structured output intake.
- User-Authored Memory Precedence, Memory Edit Classification, Safe Memory Match, authority fallback, Honcho cleanup, and Honcho Dreaming as internal reconciliation.
- Dirty ledger, scheduler, bounded slices, batch limits, active budget pressure, duplicate merge, split, expiry, conflict block, review generation, review caps, junk deletion gate.
- Legacy migration, Preserved Legacy Memory, legacy reconciliation triggers, and adaptive active budget behavior.
- Clear Memory and Knowledge, Memory Reset Generation, async output guards, and telemetry clearing.
- Memory Rework Telemetry event families and prompt-use observability.

No intentional ADR topic is left as a broad "do memory rework" issue.

## Review Pass 2 - Slice Shape And Dependency Audit

Checked dependency and slice granularity:

- Most slices are AFK. Only final visual polish is HITL.
- Each slice has a concrete acceptance path and is narrow enough for a single agent to implement and test.
- Foundation slices build reusable contracts before dependent UI, intake, prompt, and maintenance slices.
- UI slices are separated from backend data contracts but still depend on working API slices, so each UI slice can be demoed against real behavior.
- Maintenance slices are split by behavior rather than by layer: scheduler, bounded runner, budget pressure, merge, split, expiry, conflict, review caps, junk deletion, safe authority mutation, fallback, and stale-output rejection.
- Legacy migration is lazy and bounded; there is no unbounded migration or cleanup issue.
- Reset and telemetry slices are late enough to cover new state, but the Memory Reset Generation foundation lands early so later slices can opt in safely.

No blockers reference unpublished tracker IDs; local `MR-xx` ids are stable for review.
