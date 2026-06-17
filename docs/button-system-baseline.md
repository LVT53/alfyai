# Button System Baseline

This document defines the canonical button size variants for the AlfyAI design system. All buttons across the app should use these variants instead of inline size overrides.

## Text Buttons

Base classes: `btn-primary`, `btn-secondary`, `btn-ghost`, `btn-danger`

These share the base styles defined in `src/app.css`: `display: inline-flex`, `align-items: center`, `justify-content: center`, `border-radius: var(--radius-md)`, `font-family: var(--font-sans)`, `letter-spacing: 0.025em`, `font-weight: 500`.

### Size Variants

| Variant class | min-height | padding | font-size | Use case |
|---------------|-----------|---------|-----------|----------|
| `btn-sm` | 30px | 0.2rem 0.5rem | var(--text-2xs) (11.5px) | Dense lists, admin table actions, file card actions |
| `btn-md` (default) | 34px | 0.3125rem 0.75rem | var(--text-sm) (13.4px) | Standard buttons — profile, settings, dialogs |
| `btn-lg` | 44px | 0.5rem 1rem | var(--text-base) (15.2px) | Primary CTAs, login submit, mobile touch targets |

### Color Variants

| Class | Background | Border | Color |
|-------|-----------|--------|-------|
| `btn-primary` | `color-mix(in srgb, var(--accent) 12%, transparent)` | `1px solid color-mix(in srgb, var(--accent) 38%, transparent)` | `var(--accent)` |
| `btn-secondary` | transparent | `1px solid color-mix(in srgb, var(--text-primary) 50%, transparent)` | `var(--text-primary)` |
| `btn-ghost` | transparent | none | `var(--text-primary)` |
| `btn-danger` | `color-mix(in srgb, var(--danger) 12%, transparent)` | `1px solid color-mix(in srgb, var(--danger) 38%, transparent)` | `var(--danger)` |

### Rules

- Size variants are applied by appending the class: `<button class="btn-primary btn-sm">` or `<button class="btn-secondary">` (defaults to `btn-md`).
- No `text-sm`, `text-xs`, or other Tailwind font-size overrides on buttons — the variant class sets the font size.
- No inline `min-height`, `h-[40px]`, `h-9`, `w-full` overrides for sizing — use the variant class. `w-full` is still allowed for layout (full-width buttons) since it doesn't affect height.
- `btn-ghost` padding normalized to match `btn-primary`/`btn-secondary`/`btn-danger` — no longer has 2× padding.
- `btn-ghost` is included in the mobile 48px target-size bump.

## Icon Buttons

Base classes: `btn-icon`, `btn-icon-bare`

These share the base styles: `display: inline-flex`, `align-items: center`, `justify-content: center`, `border-radius: var(--radius-md)`, `color: var(--icon-muted)`, hover: `color: var(--icon-primary)`.

### Size Variants

| Variant class | min-height / min-width | padding | Use case |
|---------------|----------------------|---------|----------|
| `btn-icon-sm` | 32px | 0.25rem | Search modal, dense toolbars |
| `btn-icon-md` (default) | 40px | 0.375rem | Composer actions, message action row, knowledge modals |
| `btn-icon-lg` | 44px | 0.5rem | Header, sidebar, mobile touch targets |

### Rules

- Icon size inside buttons: `size={16}` for `btn-icon-sm`, `size={16}` for `btn-icon-md`, `size={18}` for `btn-icon-lg`.
- No inline `h-[40px]`, `h-9`, `h-8`, `h-7`, `h-10` overrides — use the variant class.
- `btn-icon` has a subtle background; `btn-icon-bare` is transparent with no border.
- Both hover to `opacity: 0.78` or `color: var(--icon-primary)`.

## Mobile Override

At `max-width: 767px`, all button variants bump to `min-height: 44px` and `min-width: 44px` for touch compliance. This override lives in `app.css` and applies to:

- `btn-primary`, `btn-secondary`, `btn-danger` (via `btn-sm`, `btn-md`, `btn-lg`)
- `btn-icon`, `btn-icon-bare` (via `btn-icon-sm`, `btn-icon-md`, `btn-icon-lg`)
- `.composer-send`, `.composer-stop-accent`, `.queue-button`

## Migration Plan

### Files to update (removing inline overrides):

| File | Current override | Target |
|------|-----------------|--------|
| `SettingsAdminSystemPane.svelte` | `:global(.btn-secondary)` redefinition + `:global(.btn-small)` definition | Remove both; use `btn-sm` from app.css |
| `SettingsProfileTab.svelte` | `text-sm` on btn classes | Remove `text-sm` — default `btn-md` matches |
| `SettingsAdminUsersPane.svelte` | `w-full` on buttons | Keep `w-full` for layout, remove any `text-sm` |
| `SettingsAdminCampaignsPane.svelte` | `:global(.btn-primary/.btn-secondary)` min-height override | Remove override; use `btn-lg` if 40px is needed |
| `MessageInput.svelte` | `h-[40px] w-[40px]` on composer buttons | Use `btn-icon-md` (default 40px) |
| `Sidebar.svelte` | `h-9 w-9` (36px) custom buttons | Use `btn-icon-sm` or standardize to 40px |
| `Header.svelte` | `min-h-[38px]` custom header options | Use `btn-icon-md` |
| `SearchModal.svelte` | `h-8 w-8` (32px), `h-7 w-7` (28px) | Use `btn-icon-sm` (32px) |
| `KnowledgeMemoryModal.svelte` | `h-10 w-10` (40px) | Use `btn-icon-md` (default) |
| `KnowledgeMemoryView.svelte` | `h-9 w-9` (36px), `h-10 w-10` (40px) | Use `btn-icon-sm` or `btn-icon-md` |
| `FileProductionCard.svelte` | Custom 28px/30px buttons | Use `btn-icon-sm` (32px) |
| `Login+page.svelte` | `min-h-[44px]` on btn-primary | Use `btn-lg` (44px) |
| `DocumentPreviewRenderer.svelte` | `text-sm` on btn classes | Remove `text-sm` |
| `UserSkillsSettingsSurface.svelte` | `text-sm` on btn classes | Remove `text-sm` |
| `SettingsDataImport.svelte` | `text-sm` on btn classes | Remove `text-sm` |
| `ProviderList.svelte` | `btn-small` with `whitespace-nowrap` | Use `btn-sm` from app.css |
| `ModelList.svelte` | `btn-small` with `whitespace-nowrap` | Use `btn-sm` from app.css |

### New definitions to add to `app.css`:

The `btn-sm`, `btn-md`, `btn-lg`, `btn-icon-sm`, `btn-icon-md`, `btn-icon-lg` classes need to be defined in `app.css` `@layer components`. The existing base button classes become the foundation; size variants layer on top.

### Token additions to `app.css`:

```
--surface-message-user (light: #f4f3ee, dark: #2f2f2f)
```
