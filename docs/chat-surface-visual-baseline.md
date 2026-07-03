# Chat Surface Visual Baseline

This baseline is the visual contract for the chat conversation surface — message bubbles, edit UI, action rows, and composer send-key behavior. It complements the [Document Workspace Visual Acceptance Baseline](./document-workspace-visual-acceptance-baseline.md).

## Completed Changes

### Design Token Foundation (commit 594030ab)

The following tokens were added to `src/app.css` in both light and dark themes:

| Token | Light | Dark | Purpose |
|-------|-------|------|---------|
| `--font-sans` | `"Nimbus Sans L", sans-serif` | same | UI chrome font |
| `--font-serif` | `"Libre Baskerville", serif` | same | Message content font |
| `--font-mono` | `"JetBrains Mono", "Fira Code", "Consolas", monospace` | same | Code blocks |
| `--text-2xs` | `0.72rem` | same | Timestamps, meta, badges |
| `--text-xs` | `0.78rem` | same | Labels, secondary text |
| `--text-sm` | `0.84rem` | same | Body UI text |
| `--text-md` | `0.875rem` | same | Compact body text |
| `--text-base` | `0.95rem` | same | Default body text |
| `--text-lg` | `1.125rem` | same | Headings |
| `--warning` | `#d97706` | `#f59e0b` | Warning status |
| `--warning-hover` | `#b45309` | `#d97706` | Warning hover |
| `--caution` | `#eab308` | `#facc15` | Caution status |
| `--info` | `#2563eb` | `#60a5fa` | Info / provider badges |
| `--accent-contrast` | `#ffffff` | `#ffffff` | Text on accent backgrounds |

All chat components migrated from hardcoded font-size and font-family values to these tokens. The shared `.fork-lineage-marker`, `.fork-lineage-icon`, and `.fork-lineage-link` CSS classes are defined once in `app.css` and consumed by both `MessageBubble.svelte` and `MessageArea.svelte`.

### Fork Marker Redesign (commit 594030ab)

**Fork Origin Marker** (in `MessageBubble.svelte`):
- Card-like block below the message content with accent-tinted icon chip
- Bold label on its own line, pill-shaped child fork links with hover elevation
- `data-testid="fork-origin-marker"` preserved

**Fork Boundary Marker** (in `MessageArea.svelte`):
- Centered content with dashed accent separator lines above and below
- Accent-tinted icon chip, source link as a distinct chip with "←" prefix
- Degraded state uses `AlertCircle` icon and `var(--warning)` color
- `data-testid="fork-boundary-marker"` preserved

### Context Compression Marker (commit 594030ab; redesigned — see ADR 0043)

The inline compaction marker is a centered chip-divider, not a left-bordered strip:
- A centered rounded pill between two hairline gradient lines, gold-tinted (`#C8A882` family)
- In progress: the pill's color breathes (no loading icon — the color change is the signal)
- Done: static pill labeled "Summarized N earlier messages" with a terracotta `Eye` icon button that expands the LLM-generated summary inline
- Failed: red-tinted pill with a `RotateCw` retry icon button
- The prior `Layers` icon / neutral muted left-border form is superseded by ADR 0043

### Icon and Color Compliance (commit 594030ab)

- Inline `<svg>` elements in `FileProductionCard.svelte` replaced with Lucide `X` and `Download` icons
- Literal `<span>x</span>` remove buttons in `MessageInput.svelte` replaced with Lucide `X` at `size={14}`
- Hardcoded golden accent `rgba(194, 166, 106, ...)` replaced with `color-mix(in srgb, var(--accent) XX%, transparent)` across `MessageInput.svelte` and `ComposerToolsMenu.svelte`
- Legacy CSS variables (`--bg-hover`, `--bg-secondary`, `--bg-primary` with fallbacks) migrated to semantic tokens in `ModelSelector.svelte` and `ModelSelectionGuideModal.svelte`
- Hardcoded provider brand hex colors replaced with `var(--success)` and `var(--info)` tokens
- Retired research-card undefined tokens (`--border-strong`, `--surface-card`, `--text-on-accent`) replaced with real semantic equivalents

### File Attachment Unification (commit a99dfa16)

- `FileAttachment.svelte` uses `FileTypeIcon` with a `getFileType(mimeType, filename)` helper that mirrors the knowledge base icon mapping (image, PDF, spreadsheet, presentation, code, archive, text, fallback)
- `FileTypeIcon.svelte` enhanced with `code`, `archive`, and `html` icon types
- `MessageInput.svelte` composer uses `FileAttachment` for both pending attachments and linked context sources instead of ad-hoc chip markup
- Prop type lightened to `FileAttachmentData` interface with Svelte 5 generics for backward compatibility

### Other Completed Fixes (commit 594030ab)

- User edit mode width stays at `max-w-[85%]` instead of jumping to `max-w-full`
- Empty conversation state vertically centered, with the static (non-animated) LogoMark as centerpiece, a serif "How can I help?" headline, and a quiet composer hint (see ADR 0043; the prior plain "Conversation Ready" text is superseded)
- The per-message disclosure is labeled **"Sources"** (with a Lucide `Book` icon), not "Evidence"; the i18n keys for "Evidence is loading…", "Tool", and "Reranked" are retired — "Reranked N%" is no longer shown, and the surface is informational-only with Used/Set-aside groups (see ADR 0043)

## Planned Changes

### 1. User Message Edit UI Redesign

**Current problem**: The edit textarea changes background, border, padding, and font size all at once. Save/cancel use `btn-primary`/`btn-secondary` which look like form submit buttons.

**Target design**:
- The edit textarea inherits the exact same visual container as the display state — same `--surface-message-user` background, same padding, same `var(--text-md)` font size, same rounding
- No border change (borderless, like the display state)
- Save/cancel become quiet icon buttons: `Check` (save) and `X` (cancel), both Lucide, `size={16}`, non-colored, with hover background
- Keep `Cmd/Ctrl+Enter` to save and `Escape` to cancel
- Remove the "Cmd+Enter to send" hint text from the edit mode

### 2. User Message Bubble Refinement

**Current problem**: The bubble uses `bg-surface-elevated` with a nearly invisible border and shadow. In dark mode the contrast against the page background is too low. Padding is tight at `p-sm` (8px).

**Target design**:
- New dedicated `--surface-message-user` token:
  - Light: `#f4f3ee` (current elevated value — visible against `#fafaf8` page)
  - Dark: `#2f2f2f` (notably lighter than `#1a1a1a` page — closer to ChatGPT's contrast level)
- Remove `border-border-subtle` and `shadow-sm` — the background color alone provides the distinction
- Increase padding from `p-sm` (8px) to `p-md` (16px)
- Keep `rounded-md` and `max-w-[85%] md:max-w-[80%]`
- Reduce both user and assistant message font size from `text-[15px]` to `var(--text-md)` (14px)

### 3. Button System Unification

See [Button System Baseline](./button-system-baseline.md) for the complete specification.

### 4. Composer Send Key Behavior

**Current behavior**: Composer uses `Enter` to send, `Shift+Enter` for newline. Edit mode uses `Cmd/Ctrl+Enter` to send. These are inconsistent.

**Target behavior**:
- Composer: `Enter` creates a newline, `Cmd/Ctrl+Enter` sends, `Shift+Enter` also creates a newline
- Edit mode: unchanged (`Cmd/Ctrl+Enter` to save, `Escape` to cancel)
- No visible shortcut hint in the composer — the send button is present and Cmd/Ctrl+Enter is a well-known convention
- The existing `messageBubble.sendShortcut` i18n key ("Cmd+Enter to send") remains available but is no longer shown in the edit mode either

## Visual Rules

- Assistant messages remain borderless on `--surface-page` — the calm reading surface is the design intent
- User messages use `--surface-message-user` background with no border and no shadow — background contrast alone distinguishes them
- Both user and assistant message text uses `var(--text-md)` (14px) in `--font-serif` (Libre Baskerville)
- All UI chrome (timestamps, labels, action buttons, tooltips) uses `var(--font-sans)` (Nimbus Sans L)
- Fork markers and compression markers are visually distinct — fork markers use accent color, compression markers use neutral muted color
- All icons come from `@lucide/svelte` — no inline `<svg>` elements for UI icons
- All colors use semantic CSS custom properties from `app.css` — no hardcoded hex values in component `<style>` blocks
