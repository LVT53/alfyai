# Workspace Search Slices

Historical note: this document is the original implementation slice plan for the
Workspace Search revamp. The unchecked acceptance criteria below are preserved as
the planning checklist used during delivery; they are not a current status board.
Use the current code, tests, and `AGENTS.md` files as the source of truth for
delivered behavior.

This plan breaks the Workspace Search revamp into independently testable, separately committable tracer-bullet slices. Do not create tracker issues from this document unless explicitly asked.

## Scope

Workspace Search is the app-shell search surface for finding and opening a user's workspace material across conversations and documents. V1 is lexical and deterministic, account-wide by default, server-backed, and navigational rather than a transcript browser or document viewer.

The production target is:

- Empty and one-character input show at most three recent conversations and three recent documents.
- Two or more non-space characters search conversations and documents.
- Conversation results include title, project-folder metadata, and best body-message matches.
- Document results include uploaded documents, generated documents, skill notes, and chat attachments only when they are openable as workspace documents.
- Selecting a conversation body match opens the conversation focused on the matched message.
- Selecting a document opens it directly in the document workspace; source-backed documents may offer secondary source-chat navigation.
- Query results show at most six conversations and six documents, with document overflow handed off to the Knowledge Library.
- The modal renders grouped result sections with distinct icons, badges, snippets, matched-term highlighting, loading/error states, and keyboard launcher behavior.

Relevant domain and decision docs:

- `CONTEXT.md` — Workspace Search glossary.
- `docs/adr/0034-workspace-search-boundary.md` — server-backed Workspace Search boundary.

## Slice 1: Server-Backed Default Workspace Search

Type: AFK

Blocked by: None

What to build:

Replace the modal's local conversation-title filtering baseline with a server-backed Workspace Search path for the default state. With empty or one-character input, the shell search should fetch and render recent workspace material: up to three conversations and three openable documents. This slice proves the route, service, client API, modal integration, auth scoping, and grouped result rendering without body search yet.

Acceptance criteria:

- [ ] Workspace Search has an authenticated server endpoint backed by a service boundary, not modal-local ranking.
- [ ] Empty input returns at most three recent visible conversations and three recent openable documents for the current user.
- [ ] One-character input uses the same default-result behavior and does not search message or document body content.
- [ ] The modal renders `Recent conversations` and `Recent documents` sections from the server response.
- [ ] Conversation selection still opens the conversation, and document selection opens the document workspace through the existing handoff.
- [ ] Other users' conversations and documents never appear.

Suggested verification:

- Service/route tests for default results, one-character threshold behavior, caps, auth scoping, and empty workspace state.
- Modal test proving default results render from the Workspace Search API rather than from local title filtering.

## Slice 2: Conversation Title, Body, And Project Metadata Search

Type: AFK

Blocked by: Slice 1

What to build:

Add query-state conversation search for two-or-more-character input. Results should include title matches, project-folder metadata matches, and one best Conversation Body Match per conversation. A body match should show a compact role-aware snippet and open the chat focused on the matched message. This slice keeps Workspace Search account-wide and excludes empty prepared conversations.

Acceptance criteria:

- [ ] Two-or-more-character queries search conversation titles, project-folder metadata, and message body text.
- [ ] Results show at most six conversations and at most one row per conversation.
- [ ] A body-only match includes one clipped query-centered snippet and role context.
- [ ] Selecting a body match opens the conversation focused on the matched message.
- [ ] Sealed conversations are searchable and open read-only through the existing chat behavior.
- [ ] Empty prepared conversations remain excluded.
- [ ] Result ordering is deterministic: title/name strength first, body relevance next, recency only as a tie-breaker.

Suggested verification:

- Service tests for title, body, project metadata, sealed-conversation, empty-conversation, cap, and ownership scenarios.
- Modal/navigation tests for body-match row rendering and focus-message navigation.

## Slice 3: Document Search With Direct Open And Source Navigation

Type: AFK

Blocked by: Slice 1

What to build:

Add query-state document search for two-or-more-character input. Results should include openable uploaded documents, generated documents, skill notes, and chat attachments that have a document workspace target. Matching should cover document name, label, role, summary, and content text. Primary row activation opens the document directly; source-backed documents expose a secondary action to the source chat.

Acceptance criteria:

- [ ] Two-or-more-character queries search openable workspace documents by name, label, role, summary, and content text.
- [ ] Results show at most six logical documents/families.
- [ ] Uploaded, generated, historical generated, and skill-note documents render with distinct badges or metadata.
- [ ] Chat attachments appear only when they are openable as workspace documents and do not introduce a separate attachment result type.
- [ ] Primary document activation opens the document workspace directly.
- [ ] Source-backed documents show a secondary source-chat action when source metadata exists, and hide it when it does not.
- [ ] If more document matches exist than the modal cap, the modal offers a handoff to the Knowledge Library with the same query.

Suggested verification:

- Knowledge/document service tests for name, label, summary, content text, generated, historical, skill-note, attachment eligibility, cap, and ownership scenarios.
- Modal/navigation tests for direct document open, source-chat secondary action, and Knowledge overflow handoff.

## Slice 4: Workspace Search Result Explanation And Visual Taxonomy

Type: AFK

Blocked by: Slices 2 and 3

What to build:

Make query results easy to scan and trustworthy. Render grouped `Conversations` and `Documents` sections with distinct icons, match snippets, matched-term highlighting, badges, and metadata. The surface should explain why each result matched without exposing long raw message or document content.

Acceptance criteria:

- [ ] Conversation title matches, Conversation Body Matches, uploaded documents, generated documents, historical documents, and skill notes have visually distinct row treatments.
- [ ] Matched terms are highlighted in visible titles/names and snippets using restrained inline styling.
- [ ] Snippets are clipped and query-centered when practical, with no long raw message bodies or document excerpts.
- [ ] Metadata badges such as `Current`, `Uploaded`, `Generated`, `Skill note`, and `Historical` are localized and not treated as highlighted search text.
- [ ] Query empty state, no-results state, loading copy, error copy, section labels, badges, and tooltips are localized in English and Hungarian.

Suggested verification:

- Component tests for row variants, badges, snippet clipping, and matched-term highlighting.
- i18n key coverage for English and Hungarian Workspace Search strings.

## Slice 5: Launcher Keyboard, Loading, And Error Behavior

Type: AFK

Blocked by: Slices 2 and 3

What to build:

Turn the modal into a predictable search launcher. Keyboard navigation should move through all visible result rows across sections, Enter should activate the active or first result, Escape should close, Tab should preserve the focus trap, and secondary source actions should remain reachable without stealing primary row activation. Loading and failure states should be quiet and should not fall back to title-only client search.

Acceptance criteria:

- [ ] Opening Workspace Search focuses the input on desktop.
- [ ] Arrow keys move the active result across conversations and documents.
- [ ] Enter activates the active result, or the first result when none is active.
- [ ] Tab reaches secondary source actions while preserving the existing modal focus trap.
- [ ] Two-or-more-character input is debounced, while explicit Enter can activate the current top result.
- [ ] Loading is shown inline without blocking the modal.
- [ ] Search failures show a compact error state and never silently fall back to client-side title-only search.

Suggested verification:

- Component tests for arrow navigation, Enter activation, focus trap behavior, secondary action tab reachability, loading state, and error state.
- Browser smoke test for keyboard-only default, conversation, and document result activation.

## Slice 6: Boundary Cleanup And Regression Guards

Type: AFK

Blocked by: Slices 1, 2, 3, 4, and 5

What to build:

Remove stale SearchModal assumptions and protect the new boundary from regression. The old title-only modal behavior should be gone, docs should describe Workspace Search accurately, and regression tests should keep private body/content search server-owned.

Acceptance criteria:

- [ ] SearchModal no longer filters `$conversations` by title as its query implementation.
- [ ] Component/service docs describe Workspace Search as server-backed conversation and document search.
- [ ] Stale docs claiming document search exists without the implemented boundary are reconciled.
- [ ] Tests prove message body and document content are not downloaded for modal-side ranking.
- [ ] Fallow reports no new unintentional dead exports or dependency cycles.
- [ ] `npm run check` passes with zero new diagnostics.

Suggested verification:

- `rg "conversation.title.toLowerCase\\(\\).*includes|searchableConversations.filter" src/lib/components/search src/lib/stores src/lib/client`
- Focused Workspace Search service, route, client, and component tests.
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- `npm run check`

## Final Verification

Run after the slices are integrated:

- Focused Workspace Search test suite.
- Existing Knowledge document search/list tests touched by the document result path.
- Existing chat navigation/focus-message tests touched by Conversation Body Match navigation.
- `npm run check`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- Browser or Playwright smoke covering:
  - empty Workspace Search default state,
  - conversation title match,
  - Conversation Body Match focus navigation,
  - document direct open,
  - source-chat secondary action,
  - keyboard-only activation,
  - loading/error state.
