/**
 * Stable public entrypoint for the Knowledge Memory service, kept for the
 * `/api/knowledge/memory/*` routes (and referenced by name in CONTEXT.md).
 * The implementation lives in two cohesive modules:
 *   - `knowledge-memory-read`    — the read/serialize surface (getKnowledgeMemory*,
 *      getKnowledgeMemoryOverview/Summary, listKnowledgeMemoryTimeline). This is
 *      the legacy-compat serialize surface over the Memory Profile Projection.
 *   - `knowledge-memory-actions` — the v2 action-dispatch surface
 *      (applyKnowledgeMemoryAction, parse/apply of the memory action envelope).
 */

export * from "./knowledge-memory-actions";
export * from "./knowledge-memory-read";
