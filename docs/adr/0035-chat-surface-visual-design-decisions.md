# Chat Surface Visual Design Decisions

Four visual design decisions for the chat conversation surface, made together because they interact: edit UI, user message bubble, button system, and composer send-key behavior. Full details in [Chat Surface Visual Baseline](../chat-surface-visual-baseline.md) and [Button System Baseline](../button-system-baseline.md).

## Decisions

**1. Edit UI: seamless in-place edit with icon buttons.** The edit textarea inherits the exact same visual container as the display state (same background, padding, font size — no border since the bubble is borderless). Save/cancel become quiet Lucide icon buttons (`Check` / `X`) with hover background instead of `btn-primary`/`btn-secondary`. Rejected: keeping the textarea as a visually distinct "form" with different bg/border/font — it made the display-to-edit transition jarring and looked like a form submit rather than a quick correction.

**2. User message bubble: background-only distinction, no border.** A dedicated `--surface-message-user` token replaces `--surface-elevated` + invisible border + invisible shadow. In dark mode the value is `#2f2f2f` (notably lighter than the `#1a1a1a` page), closer to the contrast level ChatGPT uses. Border and shadow are removed entirely — the background color alone distinguishes user messages. Padding increases from 8px to 16px. Rejected: stronger border (adds visual noise against the calm reading-first identity); accent-tinted background (introduces color where neutrality is the design intent).

**3. Button system: three explicit size variants.** `btn-sm` (30px), `btn-md` (34px, default — matches the profile page buttons the product owner preferred), `btn-lg` (44px). Icon buttons: `btn-icon-sm` (32px), `btn-icon-md` (40px, default), `btn-icon-lg` (44px). Font size is set by the variant class, eliminating pervasive `text-sm` overrides. Rejected: keeping the 34px base without explicit variants — the audit found 6 different effective sizes for `.btn-icon-bare` alone, with `:global()` redefinitions leaking across pages.

**4. Composer send key: Enter creates newline, Cmd/Ctrl+Enter sends.** Matches the edit mode behavior, which already uses Cmd/Ctrl+Enter. No visible shortcut hint in the composer. Rejected: keeping Enter-to-send (inconsistent with edit mode and prevents natural multi-line writing); removing keyboard shortcut entirely (frustrating for keyboard users).

## Context

The chat surface had accumulated visual inconsistencies: hardcoded font sizes and font-family strings across 22+ components, inline SVGs violating the Lucide-only policy, a golden accent color from a previous brand identity, legacy CSS variable references to undefined tokens, and `.btn-icon-bare` rendered at 6 different sizes. A first pass (commits `594030ab` and `a99dfa16`) tokenized fonts, unified file attachment rendering, and fixed icon/color compliance. This ADR records the remaining visual design decisions that build on that foundation.
