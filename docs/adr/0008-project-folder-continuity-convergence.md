# Project folders converge AI project continuity

> **Superseded by [ADR-0051](0051-folder-anchored-continuity-retires-inferred-buckets.md) (2026-07-11).** The inferred `memory_projects` / `memory_project_task_links` substrate and the convergence glue described below have been removed; continuity is now folder-anchored only. Retained for historical context.

Project Folders are user-managed conversation organization, while Project Continuity is AlfyAI's long-term memory about ongoing project work. We will keep those identities separate and link them structurally: when a conversation belongs to a Project Folder, that folder becomes the canonical project identity for future Project Continuity routing, display labels, and bounded Project Folder Awareness. Raw folder names are prompt-context metadata, not system-prompt instructions.

The first production slice will promote relevant sibling conversation context through backend Context Selection, using bounded Project Folder Awareness by default and deeper sibling content only when the current turn gives a strong signal. Any follow-up explicit project/sibling conversation retrieval should be exposed through the app-owned Normal Chat tool boundary, and it should complement Context Selection rather than replacing it as the source of prompt-context authority.

**Considered Options**

- Add only prompt text that names the current UI folder.
- Collapse Project Folder IDs and Project Continuity IDs into one identity.
- Keep separate identities and link Project Folders to canonical Project Continuity.
- Let the model discover sibling conversations only through a model-facing retrieval tool.

We chose structural linking because prompt text alone would not fix memory routing, while shared IDs would collapse concepts with different lifecycles. Separate linked identities let empty folders remain organization-only, let inferred continuity work for unorganized conversations, and let explicit folder assignment override inferred routing without treating user-controlled folder names as instructions.

**Acceptance Scenarios**

- A chat inside a Project Folder sends Prompt Context containing a quoted project label, not a system-prompt instruction.
- Moving a chat into a Project Folder immediately links or re-homes its Project Continuity to the folder's canonical continuity.
- Renaming a Project Folder updates the current label used in future Prompt Context without rewriting historical memory events.
- Deleting a Project Folder unassigns its conversations but does not delete the conversations or imply memory forgetting.
- A folder chat receives bounded Project Folder Awareness with sibling conversation titles and summaries.
- A relevant user query can promote one sibling conversation into deeper Prompt Context automatically through backend Context Selection.
- The app-owned retrieval tool returns summary-first structured sibling results scoped to the current folder by default, with explicit single-conversation detail mode.
- Unorganized chats with inferred continuity can receive lower-authority Project Continuity Awareness.
