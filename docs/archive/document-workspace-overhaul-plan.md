# Document Workspace Overhaul Plan

This plan turns the current document sidebar and preview modals into one shared **Document Workspace** surface for Chat and Knowledge. It follows the product language in `CONTEXT.md`: a **Document Workspace** contains one or more **Working Documents**, may be docked or expanded, and must not create a second prompt-context authority.

## Goals

- Make multiple open **Working Documents** readable and scannable through an **Open Documents Rail** instead of compressed horizontal tabs.
- Use the same **Document Workspace** shell in Chat and Knowledge.
- Open Chat documents docked by default so conversation remains primary.
- Open Knowledge documents in the **Expanded Document Workspace** by default so document inspection remains primary.
- Remove old parallel viewer shells: the current fullscreen preview modal and the current Knowledge preview modal.
- Keep route-level ownership of open, selected, compared, and closed document state.
- Keep `FilePreview`-style rich rendering lazy-loaded from the workspace path; do not pull heavy preview libraries into idle Chat or Knowledge views.
- Render Markdown as a readable document, not as highlighted source.
- Render HTML previews as static sandboxed visual pages with scripts disabled.
- Move page, slide, and zoom controls into one compact preview toolbar inside the **Document Workspace**.
- Improve image inspection with zoom, fit, and pan controls without adding image editing.

## Non-Goals

- No in-app editing of Knowledge Library files.
- No file versioning for uploaded duplicates.
- No global shared open-document set between Chat and Knowledge.
- No thumbnail strip in this slice.
- No Obsidian workspace graph, embed resolver, or wiki-link resolver.
- No external conversion service for legacy `.doc`, `.xls`, or `.ppt` files.
- No change to **Context Selection** rules: an open workspace document remains a weak signal unless user wording or explicit selection strengthens it.

## Current State

- `src/lib/components/chat/DocumentWorkspace.svelte`
  - Owns the current docked/mobile workspace shell.
  - Renders open documents as horizontal pill tabs.
  - Contains version history, compare mode, page input, resize behavior, and a fullscreen preview modal path.
  - Lazy-loads `src/lib/components/knowledge/FilePreview.svelte`.
- `src/lib/components/knowledge/FilePreview.svelte`
  - Is both renderer and viewer shell: modal/embedded modes, header, close behavior, PDF toolbar, file fetching, and format renderers.
  - Supports PDF, DOCX, XLSX, PPTX, ODT, images, CSV, and text/code previews.
  - Treats Markdown as highlighted source through `renderHighlightedText`.
  - Treats HTML as highlighted source, not a static rendered page.
  - Image preview has no first-class zoom or pan model.
- `src/routes/(app)/knowledge/_components/KnowledgeDocumentPreviewModal.svelte`
  - Wraps `FilePreview` in a separate Knowledge modal viewer.
  - Duplicates shell responsibilities that should belong to the shared **Document Workspace**.
- `src/routes/(app)/knowledge/_components/KnowledgeWorkspaceCoordinator.svelte`
  - Owns Knowledge preview-open state and URL handoff consumption.
  - Currently opens a single active document through the Knowledge modal shell.
- `src/routes/(app)/chat/[conversationId]/+page.svelte`
  - Owns Chat workspace state: open documents, active document, open/close/select handlers.
  - Records workspace-open events through `recordDocumentWorkspaceOpen`.
- `src/routes/(app)/chat/[conversationId]/_helpers.ts`
  - Contains Chat-only workspace open/close reducers that should become reusable when Knowledge gets the same open-document set behavior.

## Target Architecture

### Shared Workspace Package

Create a shared workspace component area under:

```text
src/lib/components/document-workspace/
```

Target components:

- `DocumentWorkspace.svelte`
  - Public shell used by Chat and Knowledge.
  - Accepts docked or expanded presentation.
  - Owns layout, transitions, and composition only.
- `DocumentWorkspaceHeader.svelte`
  - Active document title, metadata, close, expand/collapse, source/download actions.
- `OpenDocumentsRail.svelte`
  - Appears only when `documents.length > 1`.
  - Scrolls independently when the open set exceeds available space.
  - Shows readable document rows with quiet active state and close affordance.
- `DocumentVersionControl.svelte`
  - Compact generated-document family control for the selected document.
  - Shows version metadata without showing unopened version bodies.
- `DocumentCompareView.svelte`
  - In-workspace compare mode for generated-document versions.
  - Stacked in narrow docked layouts; side-by-side in expanded layouts.
- `DocumentPreviewToolbar.svelte`
  - Format-aware navigation and zoom controls.
  - PDF/PPTX: previous, next, direct page/slide input, total count, zoom where applicable.
  - Image: zoom out, reset/percentage, zoom in, fit, pan state.
- `DocumentPreviewRenderer.svelte`
  - Internal renderer body renamed/extracted from `FilePreview`.
  - No modal mode, no standalone close button, no viewer header.
  - Emits page/slide/zoom capabilities upward or receives toolbar state from the workspace controller.

The existing `src/lib/components/chat/DocumentWorkspace.svelte` path should either become a temporary compatibility wrapper during migration or be removed after all imports move to the shared path. By the end of the overhaul, there should be one public workspace shell.

Decision: move immediately to `src/lib/components/document-workspace/`. Do not keep a long-lived compatibility wrapper at the old Chat path. A short-lived mechanical import shim is acceptable inside one implementation branch only if it is deleted before that slice is complete.

Decision: rename `FilePreview.svelte` to `DocumentPreviewRenderer.svelte` as part of the cleanup. "FilePreview" should not remain as the public viewer concept after the shared **Document Workspace** exists.

### Shared Workspace State Helpers

Move generic open/select/close behavior to a shared client helper:

```text
src/lib/client/document-workspace-state.ts
```

Candidate helpers:

- `reduceWorkspaceDocumentOpen(documents, document)`
- `reduceWorkspaceDocumentClose(documents, documentId, activeDocumentId)`
- `reduceWorkspaceDocumentSelect(documents, documentId)`
- `mergeWorkspaceDocumentMetadata(documents, availableDocuments)`

Chat and Knowledge should both keep route-local state, but use the same reducer behavior. Chat and Knowledge must not share one global open-document set.

### Route Responsibilities

Chat route:

- Keeps `workspaceDocuments`, `activeWorkspaceDocumentId`, and `workspaceOpen`.
- Opens the workspace in docked presentation by default.
- Can expand the same workspace in place.
- Keeps source-message jump behavior.
- Keeps workspace-open tracking in route handlers.

Knowledge route:

- Keeps its own `workspaceDocuments`, `activeWorkspaceDocumentId`, and `workspaceOpen`.
- Opens the workspace in expanded presentation by default.
- Consumes global search handoff params and clears them after opening, preserving current behavior.
- Closes back to the same Knowledge Library state underneath.
- May retain a route-local `KnowledgeWorkspaceCoordinator` only if it renders the shared `DocumentWorkspace`; it must not wrap `FilePreview` directly.

## UI Behavior

### Docked Chat Workspace

- Default presentation when opened from chat attachments, generated files, or source-linked work.
- Resizable within current width constraints.
- Header stays minimal: active document title, metadata, expand button, close button.
- **Open Documents Rail** appears only when there are multiple open documents.
- Rail appears with a smooth fade/slide/width transition when the second document opens.
- Rail animation must respect `prefers-reduced-motion`.
- Selecting a different rail row must not reanimate the whole workspace.

### Expanded Workspace

- Replaces the current fullscreen modal.
- Uses the same open-document set, active document, rail, version control, compare state, and preview controls.
- Knowledge opens this mode by default.
- Chat can enter this mode from docked workspace.
- Closing Knowledge expanded workspace returns to the same Knowledge page state.
- Closing Chat expanded workspace should return to docked workspace if the docked workspace was open; closing the workspace itself still clears only the workspace surface, not the open set unless the user closes individual documents.

### Open Documents Rail

- Visible only for `2+` open documents.
- Rows should show:
  - file/document type icon
  - readable title, clamped to one or two lines
  - compact metadata such as type, version, generated-document role, and historical status
  - quiet close icon
- Rail must scroll independently when there are more rows than fit.
- Rail must not include unopened generated-document versions.
- Rail must stay visually restrained: no large colored badges, no card-heavy treatment, no noisy action buttons.

### Version History

- Visible only when the active document belongs to a multi-version **Generated Document Family**.
- Compact by default: version chips or a small segmented/select control.
- Does not show unopened version body content.
- Opening a version adds it to the open-document set or selects it if already open.
- Compare remains inside the workspace.

### Preview Toolbar

- One compact toolbar lives directly above the preview content.
- Controls appear only when the active renderer exposes the relevant capability.
- PDF/PPTX controls:
  - previous page/slide
  - direct page/slide input
  - total page/slide count
  - next page/slide
  - zoom controls where the renderer supports zoom
- Image controls:
  - zoom out
  - reset/percentage
  - zoom in
  - fit mode
- Markdown, DOCX, ODT, HTML, CSV, XLSX, text, and code should not receive page controls unless a renderer later exposes real pages.

## Renderer Behavior

### Markdown

- `.md` and `text/markdown` render as readable Markdown by default.
- Use the existing lazy markdown loader path rather than eager-loading Markdown/Shiki from idle pages.
- Support:
  - headings, paragraphs, emphasis, lists
  - GFM tables
  - task lists
  - fenced code with syntax highlighting
  - safe external links
  - frontmatter presentation
  - Obsidian-style callouts
- Do not add a raw/source toggle in this slice.
- Do not resolve `[[wikilinks]]` or `![[embeds]]` unless they can point to real documents.
- Relative links should remain readable but non-navigating for now.

Implementation notes:

- `gray-matter` is already available and can parse frontmatter.
- Callouts can be handled as a Markdown preprocessor before `marked.parse`, converting recognized callout blocks into safe semantic markup.
- Sanitization must remain mandatory after Markdown rendering.

### HTML

- `.html` and `text/html` render as static sandboxed visual previews.
- Scripts must not execute.
- Prefer an iframe with restrictive sandboxing and `srcdoc` built from sanitized HTML.
- External resource behavior should stay conservative. If external assets are not loaded, the preview should still show the document structure and content where possible.
- Download remains the path for users who need the full original HTML file.

### PDF

- Preserve paged PDF rendering through PDF.js.
- Move page input and zoom controls into the shared `DocumentPreviewToolbar`.
- Avoid duplicate page controls in the workspace shell.
- Keep keyboard page navigation when the preview area is focused.

### PPTX

- Preserve slide preview support.
- Add compact slide navigation when practical.
- Avoid rendering a second standalone slide viewer shell.

### Images

- Add first-class inspection behavior:
  - zoom buttons
  - wheel/pinch zoom where practical
  - drag-to-pan when zoomed
  - reset/fit mode
- Do not add crop, rotate, annotation, or editing tools.

### DOCX, ODT, XLSX, CSV, Text, Code

- Preserve existing read-only preview support.
- Keep office and table previews in the shared renderer.
- Code and plain text remain source-style previews with wrapping.
- CSV and XLSX remain table previews with horizontal overflow handling.

### Unsupported Formats

- Unsupported legacy or specialized formats remain download-only.
- Do not promise preview support for old `.doc`, `.xls`, or `.ppt` without a separate conversion design.

## Removal Plan

Remove or retire these old viewer surfaces:

- `src/routes/(app)/knowledge/_components/KnowledgeDocumentPreviewModal.svelte`
- fullscreen preview modal markup/state inside the current `DocumentWorkspace.svelte`
- modal/header/close shell responsibilities from `FilePreview.svelte`

The renderer can survive, but it should no longer be a standalone viewer. By the end state, there should be no separate Knowledge modal viewer and no separate fullscreen viewer path.

## Testing Plan

Unit/component tests:

- Workspace opens in docked mode in Chat.
- Workspace opens in expanded mode in Knowledge.
- Closing Knowledge expanded workspace returns to the library view.
- Chat and Knowledge open-document sets remain separate.
- Rail appears at `2+` open documents and stays absent for one document.
- Rail rows remain accessible tabs/list options with close buttons.
- Version history appears only for multi-version generated-document families.
- Compare mode stays inside the workspace.
- Markdown files render as document HTML instead of highlighted source.
- Safe external Markdown links remain clickable; relative/wiki links do not navigate.
- HTML previews use a sandboxed static path.
- Image zoom controls update image scale and panning affordance.
- PDF page controls live in the shared toolbar and update the bound page.

Integration/e2e checks:

- Open generated chat file, expand workspace, return to docked workspace.
- Open multiple generated files and switch through the rail.
- Open Knowledge document from library row into expanded workspace.
- Open Knowledge document from global search handoff URL, then clear handoff params.
- Verify no old Knowledge preview modal appears.
- Verify no fullscreen preview modal appears.
- Verify desktop and mobile layouts do not overlap text or controls.

Commands expected during implementation:

```sh
npm run check
npm run test -- DocumentWorkspace
npm run test -- DocumentPreviewRenderer
```

Use targeted Vitest commands first, then broader `npm run test` as the final verification if time allows.

## Issue Candidate Breakdown

### 1. Shared Document Workspace shell baseline

Type: AFK

Blocked by: None

Build a shared `document-workspace` component area and move the current Chat workspace into it without changing user-visible behavior yet. Chat should still open, select, close, resize, and preview documents as it does now, but imports should point directly at the shared workspace boundary.

Acceptance criteria:

- Chat still opens generated files and attachments in the workspace.
- Existing version history and compare behavior still work.
- Rich preview remains lazy-loaded.
- No Knowledge behavior changes in this slice.
- Component tests cover the migrated import path.
- No permanent import remains from `src/lib/components/chat/DocumentWorkspace.svelte`.
- Verification: open a generated file in Chat and run the migrated `DocumentWorkspace` component tests.

### 2. Knowledge uses Expanded Document Workspace

Type: AFK

Blocked by: Slice 1

Replace the Knowledge preview modal with the shared **Document Workspace** in expanded mode. Knowledge keeps route-local open-document state and closes back to the library state underneath.

Acceptance criteria:

- Selecting a Knowledge Library document opens the expanded shared workspace.
- Global search handoff still opens the target document and clears handoff params.
- Knowledge can open multiple documents into its own open set.
- Chat open documents do not appear in Knowledge, and Knowledge documents do not appear in Chat.
- `KnowledgeDocumentPreviewModal.svelte` is removed or no longer imported.
- Verification: component-test the Knowledge coordinator and manually open a library document into expanded workspace.

### 3. Expanded workspace replaces fullscreen modal

Type: AFK

Blocked by: Slice 1

Remove the current fullscreen preview modal path and replace it with an expanded workspace presentation state. Chat can expand from docked to expanded and return without changing the active document or open set.

Acceptance criteria:

- The expand action changes workspace presentation, not viewer surface.
- Expanded workspace keeps rail, version control, compare state, and preview controls.
- Closing expanded Chat workspace returns to docked workspace unless the user closes the workspace itself.
- No fullscreen `FilePreview` modal path remains.
- Verification: open a Chat document, expand it, collapse/close it, and confirm the same active document remains selected.

### 4. Open Documents Rail

Type: AFK

Blocked by: Slices 1 and 2

Replace horizontal open-document tabs with a readable, scrollable **Open Documents Rail** that appears only for `2+` open documents in desktop/tablet Chat and Knowledge workspace presentations. Mobile must remain usable and non-overlapping in this slice, but mobile-specific sheet behavior is deferred.

Acceptance criteria:

- One open document shows no rail.
- Two or more open documents show the rail.
- Rail rows show readable names and compact metadata.
- Rail scrolls independently when many documents are open.
- Rail close/select behavior preserves the existing route-owned state contract.
- Rail appearance uses restrained animation and respects reduced motion.
- Mobile layout remains usable without text/control overlap.
- Verification: component-test one-document, two-document, and many-document rail states; visually check desktop/tablet and mobile viewport basics.

### 5. Compact version history and in-workspace compare

Type: AFK

Blocked by: Slice 1

Convert generated-document version history into a compact control and keep compare mode inside the shared workspace. Do not mix unopened versions into the **Open Documents Rail**.

Acceptance criteria:

- Version control appears only for multi-version generated-document families.
- Unopened versions do not show body content by default.
- Opening a version selects it if open or adds it to the open-document set.
- Compare mode renders inside the workspace and adapts to docked/expanded width.
- Verification: component-test generated family history, version open/select behavior, and compare rendering in docked and expanded widths.

### 6. Markdown reading preview

Type: AFK

Blocked by: Slice 1

Render Markdown files as readable documents in the shared preview renderer. Add the agreed Obsidian-friendly subset without resolving workspace-specific links.

Acceptance criteria:

- `.md` and `text/markdown` files render as document HTML, not a highlighted code block.
- GFM tables, task lists, fenced code, frontmatter, and callouts render cleanly.
- Safe external links remain clickable.
- Relative links, wiki links, and embeds do not navigate.
- Raw Markdown remains available through download, not a viewer toggle.
- Verification: render fixture Markdown covering frontmatter, callouts, task lists, external links, relative links, wiki links, and fenced code.

### 7. Static sandboxed HTML preview

Type: AFK

Blocked by: Slice 1

Render HTML files as static sandboxed visual previews instead of highlighted source.

Acceptance criteria:

- `.html` and `text/html` files render in a sandboxed visual preview.
- Scripts do not execute.
- Unsupported or unsafe content degrades to a readable safe state.
- Download still provides the original file.
- Verification: render an HTML fixture with visible structure and a script that would mutate the page if executed; assert the mutation does not happen.

### 8. Unified PDF and slide navigation toolbar

Type: AFK

Blocked by: Slices 1 and 3

Move PDF page controls and PPTX slide controls into the shared `DocumentPreviewToolbar`.

Acceptance criteria:

- PDF page input and previous/next controls appear in the preview toolbar.
- PPTX slide navigation appears in the preview toolbar where slide count is known.
- Duplicate page controls are removed from the workspace shell.
- Keyboard page navigation works when the preview is focused.
- Verification: component-test page/slide navigation state changes and assert the old workspace shell page input is gone.

### 9. Image zoom, fit, and pan

Type: AFK

Blocked by: Slices 1 and 3

Add image inspection controls to the shared preview renderer and toolbar.

Acceptance criteria:

- Image previews support zoom in, zoom out, reset, and fit.
- Wheel/pinch zoom works where practical.
- Drag-to-pan is available when zoomed.
- No editing controls are introduced.
- Verification: component-test toolbar state changes and pointer/wheel interactions against an image fixture.

### 10. Mobile Open Documents Sheet

Type: AFK

Blocked by: Slice 4

Add mobile-specific open-document switching for the **Document Workspace** without crowding the preview. Mobile should expose a quiet `Documents` affordance that opens a sheet/list for selecting or closing open **Working Documents**.

Acceptance criteria:

- Mobile does not show a cramped rail beside the preview.
- A `Documents` control appears when `2+` documents are open.
- The mobile sheet/list supports selecting and closing open documents.
- The sheet/list preserves readable names and compact metadata.
- Closing the sheet returns to the same active preview.
- Verification: component-test mobile viewport behavior and screenshot-check no overlap in Chat and Knowledge.

### 11. Final viewer cleanup and docs alignment

Type: AFK

Blocked by: Slices 2, 3, 4, 5, 6, 7, 8, 9, and 10

Remove compatibility wrappers and old viewer terminology after the shared workspace and renderer are fully in place. Update component docs so future work does not reintroduce parallel viewer shells.

Acceptance criteria:

- No imports remain for the old Knowledge preview modal.
- No fullscreen modal preview code remains.
- `FilePreview` has been renamed/extracted into `DocumentPreviewRenderer` and no longer exposes standalone viewer shell behavior.
- `src/lib/components/AGENTS.md` and root `AGENTS.md` reflect the shared workspace boundary if paths changed.
- Tests verify the old viewer paths are gone or unreachable.
- Verification: `rg` finds no old modal imports, targeted tests pass, and docs point to the new shared workspace path.

## Open Questions Before Issue Publishing

- Resolved: move immediately to `src/lib/components/document-workspace/`.
- Resolved: rename/extract `FilePreview.svelte` into `DocumentPreviewRenderer.svelte`.
- Resolved: defer mobile-specific sheet behavior into a separate issue slice.
