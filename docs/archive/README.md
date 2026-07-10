# docs/archive

Historical, **consumed** documentation moved here during the 2026-07-10 docs cleanup. These are point-in-time planning and evidence artifacts from the "grill-with-docs → issues → TDD" flow — implementation slice plans (`*-slices.md`), issue backlogs (`*-implementation-issues.md`), overhaul plans, deepening reports, Atlas live-run logs, and UI prototypes — that were fully shipped or superseded.

They are kept for provenance only. **They do not describe current behavior** and must not be treated as reference:

- Anything mentioning **Honcho** describes a memory substrate that was removed (see [ADR-0045](../adr/0045-memory-v2-judge-gated-local-memory.md)); memory is now local-only and judge-gated.
- Anything mentioning **Langflow** describes the pre-Vercel-AI-SDK model runtime (see [ADR-0026](../adr/0026-normal-chat-retires-langflow-for-vercel-ai-sdk.md)).
- Anything mentioning a **deep research** subsystem describes a feature that was removed and replaced by **Atlas** (see ADRs 0036–0040 and `removal-deep-research-runbook.md`).
- The reasoning-**depth LLM classifier** described in some depth docs was retired for a deterministic rules classifier (see [ADR-0046](../adr/0046-automatic-depth-selection-is-deterministic.md)).

Current canonical docs live in `CONTEXT.md`, `AGENTS.md`, `README.md`, and `docs/adr/`. Planning docs still cited by an accepted ADR were intentionally **left in `docs/`** (not archived) so those ADR links stay valid.
