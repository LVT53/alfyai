# Unified Memory design study

Superseded by [agreed UI design](agreed-ui-design.md). Its Manage/reset pages are rejected duplicates of Profile settings; do not implement them.

2026-11-18. Design only. Owner approved the latest hierarchy as the direction to apply throughout; final complete design still awaits feedback. No product implementation.

Latest interactive study: `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/memory-complete-design.html`.

## Shared hierarchy

Existing AlfyAI Settings patterns are carried through all primary Memory screens: serif Knowledge page title; 20px view headings; compact 15px section headings; 13px explanatory text; 12px metadata; aligned heading actions; 20px section padding; explicit footers for destructive or save actions. Phone controls reflow rather than squeezing descriptions. English/Hungarian previews share the structure.

- Browse: one contained list with Personal/project dropdown and scope explanation in its header, Add action, search, quiet statement rows and single memory status below. No mixed personal/project storage list.
- Detail: accepted memory, conversation evidence, previous versions and separate removal section.
- Add/Edit: consistent form surface and footer. Partial removal is ordinary text editing; no Keep part action.
- Remove: exact memory and plain consequence copy; Cancel/Remove only.
- Manage: on/off and incognito grouped together; clear-all separated. Clear all explicitly includes personal and every project memory, without deleting chats/documents.
- Reset: same confirmation hierarchy with acknowledgement before clearing.
- Status states: loading, empty, no matches, off, saving, background update, update failure, edit failure, removal failure and stale editing use the same heading/text/action scale. Preview selector exposes all states, including partial-edit example and expanded previous versions.

## Accepted conversation navigation decision

Remove the redundant intermediate conversation-link page. In the real product, selecting the source opens the original authorized chat and scrolls to the exact source message/reply. Navigation must identify the message by durable ID rather than matching quote text. A target outside the currently loaded messages must be loaded before scrolling. Highlight the referenced message briefly using the application's existing navigation patterns. Deleted or inaccessible sources must produce an honest unavailable state, never open an unrelated chat or bypass project/user access.

The design study contains fictional chats, so a source click stays on the detail and gives a preview-only notice outside the product. That notice is not proposed product UI. No real navigation or data writes occur.

## Boundaries and verification

[Accepted scope boundary](scope-boundary.md), [Edit/removal decisions](ui-edit-remove-refinement.md), [hierarchy rationale and inspected sources](ui-hierarchy-refinement.md) remain applicable. This visual work does not add custom extraction, a global project summary, or a revision-history backend. Current memory and previous versions still require the bounded grounded read view and provenance integration previously identified.

Standalone checks exercised project switching, direct-link intent without an intermediate page, adding a memory and reset acknowledgement. All 19 preview states were checked in English and Hungarian at 320px with no JavaScript errors or horizontal overflow. Desktop browse/settings and phone browse screenshots were inspected. These are design-preview checks, not app integration or production acceptance. Save/failure/retry/reset timing remains simulated.
