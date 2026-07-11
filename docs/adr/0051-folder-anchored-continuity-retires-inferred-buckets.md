# Folder-anchored continuity retires the inferred project-memory substrate

Accepted. Project continuity now anchors exclusively to **Project Folders** (`projects` + the
conversations filed under them) plus the folder's own confirmed membership. The auto-inferred
`memory_projects` / `memory_project_task_links` bucket substrate and the convergence glue that kept it
in sync with folders are **removed**. This is a structural simplification with **no loss of
on-demand recall**: the model-facing `memory_context` tool keeps full project / sibling / history
retrieval.

> **Recorded 2026-07-11.** Part of the `arch-hardening-2` backbone work (C1). Supersedes ADR-0008.

## What changed

- **The inferred substrate is gone.** `memory_projects`, `memory_project_task_links`, and
  `projects.canonical_memory_project_id` are dropped (no backfill — every field was derived from
  folders / conversations / task states / summaries / checkpoints). The write door
  (`syncTaskContinuityFromTaskState`), the convergence functions
  (`convergeProjectFolderContinuityFor{TaskState,Conversation}`), the inferred read path
  (`getProjectContinuityReferenceContext`), the status/orphan maintenance
  (`updateProjectMemoryStatuses`, `pruneOrphanProjectMemory`), the pause/resume signal
  (`applyProjectContinuitySignalFromMessage`), the focus-continuity DTOs
  (`listFocusContinuityItems`, `TaskContinuitySummary`, `FocusContinuityItem`), and the dead
  `ProjectMemory*` aliases are all removed.
- **`getProjectReferenceContext` is folder-only.** Folder conversation → folder-anchored siblings;
  non-folder conversation → `null`. All four callers already treated it as nullable.
- **The `memory_context` tool is unchanged for users.** `getProjectContext` was already
  substrate-free (folder awareness + folder-name query fallback); `getHistoryMemoryContext`
  already searched non-folder conversations by full text. Both are preserved and are the sanctioned
  path for recall over unorganized conversations.

## Considered options

- **Keep the inferred buckets (status quo / ADR-0008).** Rejected: Memory v2 already sunset inferred
  continuity (the `focusContinuities` payload was already suppressed); the substrate was a second,
  redundant continuity authority that had to be converged into folders on every turn — a diffuse
  write surface with no product-visible benefit.
- **Keep the tables, stop writing them.** Rejected: dead tables still appear in erasure, archive,
  and maintenance delete-lists and invite re-collapse. Removing them makes the folder the single
  continuity authority.

## Consequences

- **Project Folders are the single continuity authority.** Continuity = folder membership +
  confirmed folder state. There is no inferred bucket to diverge from it.
- **On-demand recall is unchanged.** The `memory_context` tool keeps summary/detail/report over
  folder siblings and full-text history recall over unorganized conversations. A seam-guard test
  (`no-memory-projects.test.ts`) asserts no source file references the dropped substrate, and
  `project.folder-retrieval.test.ts` proves the tool still retrieves project/sibling/history context
  post-removal.
- **Supersedes ADR-0008.** ADR-0008 deliberately kept the substrates separate for "inferred
  continuity for unorganized conversations"; that capability is retired here (history search covers
  the unorganized case on demand).

## CONTEXT.md reconciliation

- **Project Continuity** — redefined from "inferred bucket linking sibling tasks" to "folder-anchored:
  the conversations filed under a Project Folder."
- **Project Continuity Candidate** — removed (was the `chooseProjectCandidate` inferred-routing term).
- **Project Continuity Awareness** — kept, but re-anchored to `getProjectFolderReferenceContext`
  (folder siblings), not the inferred dispatch.
- **Memory Profile Scope** — unaffected in substance; the inferred project-continuity bucket /
  `memoryProjects` substrate is now on the _Avoid_ list.
