# ChatGPT Import — Issue Breakdown

## Slice 1: Minimum Viable Import — Parser + Schema Foundation
**Type**: AFK | **Blocked by**: None

### What to build
The thinnest possible end-to-end path. User uploads a ChatGPT ZIP. Parser extracts `conversations.json`, reconstructs linear threads (backward walk from `current_node`), handles basic content types (text, code), strips Unicode control characters. Conversations + messages created in DB. All imported chats appear in sidebar, openable and readable. **No selection, no forks, no summarization, no project grouping.**

### Acceptance criteria
- [ ] `messages` table has `import_source` column
- [ ] `import_jobs` table exists for tracking progress
- [ ] Parser correctly reconstructs linear threads from `current_node` backward walk
- [ ] Parser handles text and code content types
- [ ] Parser strips `\ue200`–`\ue204` Unicode control characters
- [ ] Parser skips empty conversations gracefully
- [ ] API endpoint `POST /api/chat/import` accepts ZIP, creates conversations + messages
- [ ] Imported conversations appear in sidebar
- [ ] User can open and read imported chats
- [ ] Unit tests cover parser logic (TDD)

### Blocked by
None — can start immediately.

---

## Slice 2: Selection Modal + Project Grouping
**Type**: AFK | **Blocked by**: Slice 1

### What to build
User picks which chats to import and where they go. Client-side ZIP parsing for preview. Modal shows chat list with titles, dates, message counts, checkboxes. Auto-group by `gizmo_id` into project folders; remainder into "ChatGPT Import" folder. Dropdown to reassign to existing Project Folders. "Import Selected" triggers API with filtered list. Progress indicator: "X of Y chats processed."

### Acceptance criteria
- [ ] Client-side ZIP + JSON parse for preview
- [ ] Modal shows chat list with selection checkboxes
- [ ] Auto-group by `gizmo_id` into project folders
- [ ] Ungrouped conversations go to "ChatGPT Import" folder
- [ ] Dropdown to reassign to existing Project Folders
- [ ] Progress indicator updates during import
- [ ] Error handling per conversation (don't fail entire import)
- [ ] Component tests for modal (TDD)

### Blocked by
- Slice 1 (needs import API + sidebar display)

---

## Slice 3: Fork/Branch Preservation
**Type**: AFK | **Blocked by**: Slice 1

### What to build
ChatGPT's tree branches become AlfyAI Conversation Forks. Detect branches in mapping tree (multiple children under one parent, weight ≠ 1.0). Create Conversation Fork for each alternative branch, with Fork Boundary Marker at divergence point and Fork Origin Marker on source messages.

### Acceptance criteria
- [ ] Parser detects branches (multiple children, weight ≠ 1.0)
- [ ] Import service creates Conversation Fork for each branch
- [ ] Fork Boundary Marker added at divergence point
- [ ] Fork Origin Marker added on source messages
- [ ] Tests cover fork creation (TDD)

### Blocked by
- Slice 1 (needs conversation creation + fork infrastructure)

---

## Slice 4: Summarization + Memory Pipeline
**Type**: AFK | **Blocked by**: Slice 1

### What to build
Imported chats feed persona and long-term memory. Chunk conversations exceeding local model context. Call local model for summarization per conversation. Store as Conversation Summary. Feed summaries into Honcho for persona building. Summaries available as model context when user continues chat.

### Acceptance criteria
- [ ] Chunking logic for conversations exceeding 262K tokens
- [ ] Local model call for summarization per conversation
- [ ] Conversation Summary stored in conversation metadata
- [ ] Summaries fed into Honcho for persona building
- [ ] Model sees summary + last N messages + new message when continuing chat
- [ ] Tests cover summarization (TDD)

### Blocked by
- Slice 1 (needs conversations + messages to summarize)

---

## Slice 5: Semantic Embeddings for Retrieval
**Type**: AFK | **Blocked by**: Slice 1

### What to build
Imported messages are searchable on-demand. Generate semantic embeddings for imported conversation text. Store in `semantic_embeddings` table. Integrate with existing retrieval infrastructure so model can search imported history when relevant to current turn.

### Acceptance criteria
- [ ] Embeddings generated for imported conversation text
- [ ] Stored in `semantic_embeddings` table
- [ ] Integrated with existing retrieval infrastructure
- [ ] Model can retrieve imported messages on-demand
- [ ] Tests cover embedding generation (TDD)

### Blocked by
- Slice 1 (needs persisted conversations + messages)

---

## Slice 6: Import Boundary Marker
**Type**: AFK | **Blocked by**: Slice 1

### What to build
Visual divider showing where ChatGPT ends and AlfyAI begins. Reuse Fork Boundary Marker pattern. Marker appears as a compact persisted cue in the chat thread. Visible when user opens an imported conversation. Labeled to distinguish from fork markers (e.g., "Imported from ChatGPT" vs "Fork").

### Acceptance criteria
- [ ] Visual marker appears in imported chat threads
- [ ] Marker distinguishes ChatGPT history from AlfyAI history
- [ ] Marker appears when user sends first message in imported chat
- [ ] Distinct visual treatment from Fork Boundary Marker
- [ ] Tests cover marker rendering (TDD)

### Blocked by
- Slice 1 (needs imported conversations to display)

---

## Slice 7: Settings + Onboarding Entry Points
**Type**: AFK | **Blocked by**: Slice 2

### What to build
Import accessible from onboarding tour and Settings. New "Data & Import" section card in Settings → Profile tab with "Import from ChatGPT" button. Onboarding import slide (after preference setup slide) with CTA opening import modal. If user skips onboarding slide, Settings entry remains available.

### Acceptance criteria
- [ ] "Data & Import" section card in Settings Profile tab
- [ ] "Import from ChatGPT" button opens import modal
- [ ] Onboarding import slide appears after preference setup
- [ ] CTA on onboarding slide opens import modal
- [ ] On skip, tour continues to next slide
- [ ] Settings entry always available for existing users
- [ ] Tests cover settings component and onboarding slide (TDD)

### Blocked by
- Slice 2 (needs import modal to open)

---

## Dependency Graph

```
Slice 1 (MVP Import) ──┬── Slice 2 (Modal + Projects) ── Slice 7 (Entry Points)
                       ├── Slice 3 (Forks)
                       ├── Slice 4 (Summarization)
                       ├── Slice 5 (Embeddings)
                       └── Slice 6 (Boundary Marker)
```

Slices 2–6 are all parallel after Slice 1. Slice 7 depends on Slice 2.
