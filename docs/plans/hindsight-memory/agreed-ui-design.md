# Agreed Memory replacement design

Owner-approved visual direction, consolidated 2026-11-18. This is the current design handoff. The owner subsequently authorized implementation. Deployment, real-user migration and cutover require separate authorization. [Implementation progress](implementation-progress.md)

Interactive preview: `/Users/lvt53/.codex/visualizations/2026/11/17/01a1ebf0-5321-7190-a198-41c2994a41ea/memory-agreed-design.html`.

## Intent and approved boundaries

Memory stays automatic for ordinary users and straightforward to inspect, edit and remove. Use the Quiet list direction. Notebook/Open notes/Search first/Loose notes are not alternatives awaiting implementation. Refine within AlfyAI's existing system rather than inventing a new one.

[Personal/project boundary](scope-boundary.md) is mandatory: personal memory is available in all of that user's chats; project memory stays in its originating project. Project chats read personal + their project, but write only to their project, including personal-sounding preferences. No automatic promotion. Outside a project, existence/name/description come from authorized project metadata, not project memory. Automatically shared project summaries/key points are not approved.

Keep native Hindsight extraction and the small correction/publication boundary already prototyped. Do not turn UI convenience into an all-memory semantic extractor or ontology. Later deliberate edits supersede older conflicting assertions within the permitted scope; replay and unrelated edits never renew old assertions.

## Information architecture

- Knowledge retains its Memory/Documents switcher and the real application shell.
- Memory has list, detail, add, edit and remove-confirmation views. Errors, loading, empty, no matches, off, saving and background update are states of those views.
- **No Manage button, no Memory management page, and no duplicated settings/reset controls in Memory.** Memory on/off and existing global privacy/reset actions remain in **Profile settings**. This explicitly supersedes all prior mockups containing Manage, Clear pages or an inline Turn on button. Memory can show status and indicate where Profile settings live without rebuilding them.
- Use a dropdown for Personal/project selection, not scope tabs. The selected space controls what is stored/displayed; it does not broaden authorization. Project view explains that personal memory is also available in that project's chats, without mixing personal records into the project's stored list.

## Page and component hierarchy

Reuse the established Settings/detail patterns: serif Knowledge page title; sans-serif view headings around 20px; compact section headings 15px/600; 13px supporting copy; 12px metadata; aligned header actions; 20px section padding on desktop, 16px on narrow screens; existing warm surfaces, borders, radii and Lucide icons. Typography is a small scale, not independently sized per element.

References inspected in the current checkout:
- `src/routes/(app)/settings/+page.svelte`: shared settings-card head/title/description.
- `src/routes/(app)/settings/_components/SettingsProfileTab.svelte`: grouped controls, action footer, separated destructive actions and ownership of memory settings.
- `src/routes/(app)/settings/_components/connections/PrivacyCard.svelte` and `users/UserDetailPanel.svelte`: compact heading, supporting copy and aligned controls.
- `src/lib/components/chat/ErrorMessage.svelte`: existing retryable/dismissible error row.
- `src/lib/utils/motion.ts`, `src/app.css`, `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte`: motion tokens, reduced-motion handling and existing transitions.

### List

A contained list with scope dropdown and scope explanation in its header, Add action, search, readable statements and quiet date metadata. Open a row for intentional fine-tuning. Preserve query, selected scope, scroll position and keyboard return focus. No confidence scores, maintenance dashboard, global project-summary cards or review inbox. Latest assertion time governs ordering; background processing time must not relabel old claims as new. Paginated results must not claim completeness from a top-K recall response.

### Individual memory

The first card keeps the accepted compact footprint. Header: Memory and Edit aligned. Body: the current statement at a readable consistent size. Footer: scope and meaningful date on a common row.

Conversation evidence is a separate section: conversation title link, original user quotation labelled You wrote, and concise manual-edit attribution where needed. Editing the memory never rewrites the quotation to make it falsely match. A source can support several native facts and a memory can have several sources; the final read contract must support that without fabricating a one-to-one relation.

Previous versions is a full-row expandable section with a chevron and quiet description, not a bare browser marker. Opened records show earlier wording labelled No longer used. Display only provenance-backed earlier versions belonging to that memory. No invented dates, physical-history narratives, Restore button or nightly Undo. The UI may omit the section when no verified versions exist. Exact coverage is a preimplementation qualification item; native observation history must not be passed off as this feature.

Remove sits separately below the evidence/history with the statement that conversations remain.

### Add and Edit

Use **Edit**, not Correct. Plain copy: “Change the wording or delete details you don’t want remembered.” One editor handles changing information and removing only part. No Keep part instead action anywhere in product UI. Example: remove “green” while retaining touring-kayak ownership and the white racing kayak. This is a semantic removal requirement, not permission to leave the removed detail recallable from old evidence.

Add saves in the selected space; Edit retains the existing space. Scope is visible. View saved version is optional collapsed comparison. Cancel and Save changes share a consistent footer. Save returns to the updated detail only after verification; retain draft on failure. Stale edits require review of the actual newer accepted content before resubmission. Never explain this as “latest statement including older chats…” in user-facing copy.

### Remove

Show the exact memory, Cancel and Remove. “Alfy will stop remembering this. Your conversations will stay.” A short line clarifies that telling Alfy again later may create a new memory. No permanent topic-ban or physical source-erasure promise. All known linked older versions must be excluded from answer context, including indirect source expansion; unrelated memories remain.

### Source navigation

**No intermediate Memory conversation page.** Open the original authorized chat and scroll to the exact source message/reply using its stable ID. Load the relevant messages if outside the current page. Apply the app's existing message highlight/navigation pattern, respecting reduced motion. Deleted/inaccessible sources show an honest unavailable state. Source navigation is not an authorization bypass.

## Reuse error handling and motion

Use the existing `ErrorMessage.svelte` visual/interaction contract for retryable operation errors: AlertCircle, concise message, retry only when eligible, dismiss, app danger tint/border/shadow. The standalone study reproduces that component's look because it cannot import Svelte; implementation must reuse the existing component rather than ship a parallel error widget. Dismiss only hides feedback; it does not declare success, cancel pending removal or restore admission. Preserve draft and operation status independently.

Background failure keeps the last accepted list readable. Edit failure keeps the old accepted memory and user's draft. Removal cleanup failure may say the memory is excluded only after exclusion is acknowledged. If exclusion itself fails, say it may still be used. Retry is idempotent. These are integration guarantees to verify, not effects of styling an error row.

Use app motion tokens: micro 100ms, standard 150ms, emphasis 250ms; `cubic-bezier(.4,0,.2,1)` and emphasis `cubic-bezier(.2,0,0,1)`. The study demonstrates short directional content transitions between list/detail/edit, animated version expansion/collapse, familiar error entrance, and subtle control feedback. Preserve the shell during transitions, do not animate every keystroke/list search or loop decorative motion. Existing reduced-motion helpers must make transitions instant. Avoid layout jumps and maintain focus throughout.

## Deliberately omitted

Portrait/summary editor, expiry/renewal, routine review inbox, permanent endorsement/protection, nightly reconciliation narrative and nightly undo. The legacy pipeline serves accounts until their individual cutover. Native background consolidation continues in Hindsight. Settings remain in Profile. Documents, artifacts, project/task continuity and account privacy/export stay in their established boundaries.

## Validation and next gate

This preview uses fictional sample data and local simulated actions only. Source links produce a preview-only notice; they do not navigate to real chats. English/Hungarian and phone previews are included. There are no product source changes.

Standalone checks: 17 states in both languages at 320px without horizontal overflow or JavaScript errors; no Manage control; 150ms page animation observed; Previous versions opens and closes; retry/dismiss works; zero active animations under reduced motion. These are design checks, not Hindsight acceptance. Product implementation must also cover long/multi-source memories, keyboard/focus, real asynchronous operations and Profile settings regressions.

Read [remaining Hindsight qualification](ui-hindsight-qualification.md) before implementing. The agreed visual design does not by itself settle the current-memory read view, stable edit/version identities or new multi-bank routing.

A fresh builder-check review identified four deferred qualification groups. Those groups set the scope of the initial backend qualification.

At design approval, the owner requested real left/right padding inside hover highlights and subtle animated hover feedback. The study has 12px row insets, 150ms background/text transitions and a 2px trailing-chevron movement, suppressed for reduced motion. The owner authorized the four isolated Hindsight qualification checks at this stage.

## Backend feasibility update — 2026-11-18

The execution handoff incorporates completed feasibility and capacity probes, the approved migration policy and the remaining integrated acceptance tests. The optional one-time historical-import choice uses existing introduction and Profile patterns. [Full implementation plan](../../superpowers/plans/2026-11-18-hindsight-memory-replacement.md) · [Approved migration policy](chat-backfill-migration.md#accepted-migration-policy--owner-approved-2026-11-18)

Native observations can back the approved list under the tested current-information mission and one-fact consolidation setting. Serve a published native-row snapshot and apply removal revocation to older pages. Separate exact native provenance suffixes from main row text without semantic rewriting. Native row identities and groupings may change, so previous versions require verified continuity. [Current-list results](current-list-followup-results.md) · [Edit/Remove results](edit-remove-followup-results.md)
