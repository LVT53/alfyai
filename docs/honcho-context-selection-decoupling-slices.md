# Honcho Context Selection Decoupling Slices

Local `$to-issues` implementation plan for the architecture-review section
`Move Prompt Context Selection Out Of Honcho`. These are not tracker issues.

## Scope

Move Normal Chat prompt context selection policy out of `honcho.ts` and into the
chat-turn context-selection boundary. Honcho remains the adapter for sessions,
peers, mirrored messages, persona/profile recall, and Honcho snapshots. The
chat-turn context-selection module owns candidate collection, signal mapping,
budget policy, prompt-context assembly, context status updates, and trace
sections.

## Slice 1: Honcho Supplies Session And Persona Candidates Only

**Status:** Completed on 2026-05-29.

**Type:** AFK

**Blocked by:** None

**What to build:** Narrow the Honcho boundary so it exposes a typed
session/persona context supplier for chat-turn context selection without owning
prompt-section construction or budget policy.

**Acceptance criteria**

- [ ] Honcho exports a narrow read-side supplier for session messages, stored
      messages, summary, peer/persona context, diagnostics, and snapshots.
- [ ] Honcho no longer imports chat-turn context-selection helpers.
- [ ] Honcho still owns SDK session bootstrap, peer bootstrap, fallback to stored
      Honcho snapshots, and persona recall.
- [ ] Existing Honcho disabled, timeout, and fallback behavior remains intact.

**Verification**

- Focused unit or integration tests for the supplier's fallback behavior where
  feasible.
- Repository search proving `honcho.ts` no longer imports
  `chat-turn/context-selection`.

## Slice 2: Chat-Turn Owns Constructed Prompt Context

**Status:** Completed on 2026-05-29.

**Type:** AFK

**Blocked by:** Slice 1

**What to build:** Move `buildConstructedContext` and its prompt-selection helper
logic to the chat-turn context-selection boundary. Keep the public return shape
stable for Langflow and stream/send callers.

**Acceptance criteria**

- [ ] `buildConstructedContext` is exported from the chat-turn context-selection
      boundary.
- [ ] Candidate promotion, inclusion-level signal mapping, document intent,
      active-source budgets, context compression snapshot handling, and context
      status updates live in the chat-turn boundary.
- [ ] Knowledge, task-state, working-document selection, linked sources, and
      Honcho are candidate/signal suppliers rather than prompt assemblers.
- [ ] Prompt output, context debug, Honcho metadata, and trace sections keep
      their existing response contracts.

**Verification**

- Existing `context-selection` tests still pass.
- Add a regression test that protects the new boundary by asserting constructed
  context can combine Honcho/session, task, attachment/document, and evidence
  candidates without reaching through Langflow or route adapters.

## Slice 3: Retarget Langflow And Remove Context Selection Debt

**Status:** Completed on 2026-05-29.

**Type:** AFK

**Blocked by:** Slice 2

**What to build:** Retarget all Langflow prompt-preparation paths to the
chat-turn context-selection export and remove obsolete prompt-selection imports,
constants, helpers, and tests from Honcho.

**Acceptance criteria**

- [ ] `langflow.ts` imports `buildConstructedContext` from
      `chat-turn/context-selection`.
- [ ] `honcho.ts` keeps only Honcho adapter behavior and no longer imports
      knowledge/task-state context-selection dependencies.
- [ ] No stale test-only helpers, duplicate prompt budget constants, or dead
      context-selection modules remain.
- [ ] Existing Normal Chat send/stream contracts are unchanged.

**Verification**

- `npm run check`
- Focused Vitest tests for context selection and Honcho/memory behavior.
- Repository search for stale ownership violations and unused modules.

## Slice 4: Document The New Deep Module And Mark Review Status

**Status:** Completed on 2026-05-29.

**Type:** AFK

**Blocked by:** Slices 1-3

**What to build:** Update `CONTEXT.md`, relevant ADRs, and the architecture review
HTML so future agents treat chat-turn context selection as the deep module and
do not move prompt assembly back into Honcho.

**Acceptance criteria**

- [ ] `CONTEXT.md` defines the deep chat-turn context-selection module and its
      supplier seams.
- [ ] ADR-0002 and ADR-0011 reflect the implemented split without discarding the
      Honcho-led memory decision.
- [ ] The architecture review section is marked finished with implementation
      status and changed module ownership.
- [ ] Documentation does not contradict AGENTS.md or the existing context-access
      roadmap.

**Verification**

- Search docs for contradictory "Honcho owns prompt context" statements.
- Final architecture-review re-read confirms the requested section is fulfilled.
