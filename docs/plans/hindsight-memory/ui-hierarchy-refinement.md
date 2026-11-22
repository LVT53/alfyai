# Memory hierarchy refinement

2026-11-18. Design only, awaiting feedback. No application code changed.

Reviewed live component sources for Settings Profile, its shared settings-card styles, Connections PrivacyCard and admin UserDetailPanel. Patterns used: compact 15px/600 section titles, 13px supporting lines, aligned header actions, 20px content padding, explicit footer separators, and muted metadata. Source references: `src/routes/(app)/settings/+page.svelte` (settings-card-head/title/desc), `_components/SettingsProfileTab.svelte` (identity footer and destructive-action separation), `_components/connections/PrivacyCard.svelte`, `_components/users/UserDetailPanel.svelte`. This was source inspection, not a live production browser walkthrough.

Memory detail: keep roughly the previous first-card footprint; put Memory and Edit in one header, use a consistent 20px reading size for the fact, and group actual scope/date in a separated footer. Remove repeated scope copy outside the card. Conversation and Previous versions share the same header scale and aligned surfaces. Previous versions is a full-row accessible disclosure with descriptive text, a clear chevron, and an expanded previous wording record labelled No longer used. No invented dates, restoration control or assertion of physical historical transitions. The rendered earlier record is demonstration data, not proof of a native Hindsight revision-history API.

Carry the type/spacing hierarchy into browse, Edit and Remove: page title remains serif; section headings, content and supporting text have distinct consistent roles. Editing and removal retain the owner's simplified labels and partial-removal-through-Edit flow. Personal/project dropdown and accepted isolation boundary stay unchanged.

Preview: `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/memory-hierarchy-refined.html`.

Standalone validation: version disclosure expands, partial edit saves, no script errors, and eight Hungarian states at 320px showed no horizontal overflow. Desktop closed/open history screenshots inspected. No product gate or production integration claim; source, edits and all operations remain synthetic preview interactions.
