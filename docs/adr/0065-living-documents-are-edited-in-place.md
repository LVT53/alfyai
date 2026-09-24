# Living Documents are edited in place, reversing the "AI generates new files only" rule

Accepted (2026-09-24). Not yet implemented; see the phases in [ADR-0064](0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md).

Until now AlfyAI had two rules for its document surfaces:
- the Knowledge Library has "no in-app file editing"
- "AI generates NEW files only"

Documents were either uploaded or rendered by `produce_file`, and any change produced a new **Generated Document Version**. That works for finished deliverables. It does not work for writing together or for notes that keep changing, which the owner named as a main reason AlfyAI feels "not quite Claude". We are adding a new kind of document, the **Living Document**, that the user and AlfyAI both edit in place.

## Decision

- **Belongs to a chat.** A Living Document belongs to the conversation it was created in. That keeps it working in a chat that is not in a folder.
- **Shared within a folder.** Other conversations in the same **Project Folder** may read and update it, and the folder's **Document Bundle** shows all of them together. Outside the folder, a conversation only reaches it when the user links it in explicitly. It is never visible to other accounts.
- **Markdown underneath, rich text on top.** It is stored as Markdown and edited through a rich-text editor (headings, lists, real checkboxes, tables), so users never see syntax and the model can read and patch it easily.
- **Targeted AI edits.** AlfyAI changes only the part it means to change, and every AI change is shown to the user as a visible change. Document history keeps earlier states. A **Selection Edit** limits a change to text the user highlighted.
- **Interactive checklists.** A checklist is a Living Document. Ticks the user makes persist and are visible to AlfyAI on the next turn.
- **Export, not edit.** DOCX and PDF copies are exported through the existing document renderers. We never edit DOCX or PDF bytes directly.

## Scope of the reversal

This replaces the two AGENTS.md "Knowledge Library → Do not" lines **only for Living Documents**. It does not change these:
- **Uploaded Documents** stay immutable, and AlfyAI still never edits a user's uploaded library files.
- **Generated Documents** stay rendered, versioned outputs.
- There is still no cross-account sharing. It was ruled out outright, not deferred.

## Considered options

- **Patch generated DOCX/PDF files in place:** rejected. Editing office formats is expensive and fragile, and exporting from an editable source covers most "fix the generated file" needs.
- **A Markdown source editor with preview:** rejected. Family users would see syntax.
- **Documents owned by the folder:** rejected. Claude lets you do this in any chat, and forcing a folder first adds friction. The Document Bundle gives the folder-level view without the folder owning the document.
- **Visible only in the conversation that created it:** rejected. A shared note that only its original chat can update goes stale as soon as the conversation moves on.

## Consequences

- AGENTS.md's Knowledge Library rules are narrowed to point here.
- The Document Workspace becomes an editing surface for Living Documents. For every other document type it stays view-only.
- Prompt assembly and Working Document Selection must handle a document that changed since the last turn, including changes made by the user or by a sibling conversation.
