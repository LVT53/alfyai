# AlfyAI Product Context

AlfyAI is a conversational workspace where users can chat casually, use tools, work with files, and optionally start deeper background research tasks. This context captures product-domain language that should stay stable across implementation choices.

## Workspace Search

### Language

**Workspace Search**:
The app-shell search surface for finding and opening a user's workspace material across conversations and documents. It is for navigating existing AlfyAI workspace content, not for searching the web, settings, admin records, or raw memory internals.
_Avoid_: search modal, global search, command palette, Ctrl+K modal

**Workspace Search Result**:
A navigable match returned by **Workspace Search**, such as a conversation title match, a conversation body match, or a document match. A result should carry enough human context to explain why it matched while still opening the owning workspace surface rather than becoming a separate transcript or document browser.
_Avoid_: raw search hit, database row, transcript result

**Workspace Search Document Result**:
A **Workspace Search Result** for a workspace document that opens the document directly in the document workspace. When the document has a containing or source chat, that chat may be offered as a secondary navigation target rather than replacing direct document open.
_Avoid_: chat file result, attachment row, document preview modal

**Workspace Search Source Navigation**:
The secondary action from a source-backed **Workspace Search Document Result** to the chat context that produced or contains that document. Source navigation supports provenance without making chat navigation the primary way to open a searched-for document.
_Avoid_: primary document action, source preview, chat-first document open

**Conversation Body Match**:
A **Workspace Search Result** that matches text inside a conversation message rather than the conversation title. It represents the best matching message context for that conversation and opens the conversation at that message.
_Avoid_: transcript browser row, message database hit, conversation title match

**Lexical Workspace Search**:
Workspace search behavior that finds literal words or phrases present in workspace material rather than conceptually related material. It is the expected baseline for navigation when a user remembers text, names, or titles from their workspace.
_Avoid_: semantic workspace search, fuzzy memory search, related-content discovery

**Workspace Search Metadata Match**:
A **Workspace Search Result** explained by contextual metadata such as a conversation's project folder rather than by the main title or body text. Metadata matches help navigation but do not introduce separate result types when the metadata itself is not the thing being opened.
_Avoid_: folder search result, metadata browser

**Workspace Search Default Results**:
The compact no-query state of **Workspace Search**, showing a small set of recent conversations and recent documents so the surface remains navigational before a user searches. V1 should show at most three conversations and three documents in this state.
_Avoid_: full recent history, library table, sidebar duplicate

**Workspace Search Result Limits**:
The compact caps that keep **Workspace Search** a fast navigation surface rather than a full results page. V1 query results show at most six conversations and six documents, with document overflow handed off to the Knowledge Library.
_Avoid_: unlimited modal results, full search page, transcript listing

**Workspace Search Query Threshold**:
The minimum meaningful query length before **Workspace Search** searches workspace body content. V1 treats empty and one-character input as default-result states and begins searching from two non-space characters.
_Avoid_: single-character body search, search-on-empty

**Workspace Search Snippet**:
A short, clipped excerpt that explains why a **Workspace Search Result** matched body or document content. It should help navigation without turning the search surface into a transcript reader or document viewer.
_Avoid_: full message body, document excerpt panel, debug match text

**Workspace Search Eligibility**:
The rule that **Workspace Search** includes non-deleted workspace material the user can still open, including sealed conversations and historical generated documents. It excludes empty prepared conversations, cleared or erased workspace data, raw memory internals, settings, admin records, and web results.
_Avoid_: sidebar visibility, prompt eligibility, memory retrieval scope

**Workspace Search Scope**:
The default account-wide reach of **Workspace Search** across the user's accessible conversations and workspace documents. It is not implicitly narrowed to the current chat, project folder, or page.
_Avoid_: current-project search, page-local search, sidebar-only search

**Workspace Search Document Eligibility**:
The rule that files, generated outputs, skill notes, and chat attachments appear in **Workspace Search** only when they are openable as workspace documents. Workspace Search does not expose a separate attachment result type.
_Avoid_: raw attachment search, file metadata row, non-openable attachment result

## User Onboarding

### Language

**First-run Onboarding Tour**:
A versioned per-user introduction shown in the authenticated app shell until the user completes or dismisses that tour version. It teaches core AlfyAI concepts, may collect initial preference choices, and can be replayed from Settings.
_Avoid_: welcome popup, tutorial carousel, one-time modal

**First-run Onboarding Audience**:
All users who have not completed or dismissed the current first-run onboarding campaign version, including existing accounts. Ordinary campaign audience settings do not narrow first-run onboarding v1.
_Avoid_: new-users-only onboarding, signup-only tour, admin-only onboarding

**Announcement Campaign**:
A versioned, localized app-shell announcement shown to an eligible user until that user completes or dismisses the campaign version. A campaign may be the **First-run Onboarding Tour**, a product update, or another high-priority disclosure, but only one campaign should be active in the shell at a time.
_Avoid_: toast, changelog page, ad hoc modal, release banner

**Campaign Auto-show**:
The app-shell behavior that opens one eligible published **Announcement Campaign** without an explicit user click. First-run onboarding takes precedence for users who have not completed or dismissed it; release/update campaigns auto-show only after onboarding is no longer pending, and only the latest unseen release/update campaign auto-shows.
_Avoid_: popup queue, scheduled modal, forced replay

**Campaign Skip**:
The secondary action that closes an auto-shown **Announcement Campaign** and marks that campaign version finished for the user. Skip replaces explicit "don't show again" wording in the campaign modal and is hidden on the final slide. Closing the modal with the close button has the same user-state effect as Skip.
_Avoid_: reminder toggle, maybe later, close without state

**Campaign Identity**:
The system-generated stable identity for an **Announcement Campaign**, derived from campaign type, version, and revision rather than typed by an admin.
_Avoid_: admin slug, editable key, title-as-id

**Draft Announcement Campaign**:
An editable admin-authored campaign revision that has not yet been published to users. It may be previewed in the admin UI but is not eligible for automatic display.
_Avoid_: live campaign, hidden popup, production draft

**Campaign Template**:
A system-seeded draft scaffold for a campaign such as first-run onboarding. A template can provide required slide structure and starting copy, but it is not auto-shown until an admin completes validation and publishes it.
_Avoid_: auto-published onboarding, demo campaign, hidden default

**Published Announcement Campaign**:
An immutable campaign revision that may be shown to eligible users, replayed from the **App Version Badge**, and audited later by admins. Corrections require publishing a new campaign version rather than mutating the published record.
_Avoid_: editable announcement, mutable release notes, overwritten campaign

**Published Campaign Snapshot**:
The frozen published content and asset references for a **Published Announcement Campaign**, stored separately from editable draft state so later edits, crop-tool changes, or admin configuration changes cannot alter what users saw.
_Avoid_: live draft render, mutable slide JSON, reconstructed campaign

**Archived Announcement Campaign**:
A published campaign that is no longer eligible for automatic display but remains available in admin history and audit views.
_Avoid_: deleted announcement, hidden history, expired modal

**Campaign Authoring Surface**:
The Campaigns pane in admin settings for creating draft campaigns, editing fixed-layout slides, previewing the campaign in desktop/mobile and English/Hungarian modes, publishing immutable campaign revisions, and reviewing published or archived campaign history. Desktop uses a three-zone workbench: campaign list, editor, and exact modal preview; smaller screens may stack editing, preview, and history views.
_Avoid_: rich page builder, markdown changelog editor, ad hoc popup form

**Campaign Slide Ordering**:
The admin workflow for changing slide order using explicit accessible move controls. Drag and drop is not required for v1.
_Avoid_: drag-only ordering, hidden sort field, inaccessible reorder

**Campaign Shell Preview**:
An admin-only preview that opens draft campaign content in the real campaign modal without changing per-user completion state or writing campaign interaction analytics. It must be visibly marked as a preview.
_Avoid_: test publish, user-visible draft, analytics event

**Campaign Modal Layout**:
The fixed user-facing layout for **Announcement Campaigns**. Desktop uses a centered modal with blurred backdrop, subtle border, 8px radius, prominent 16:10 screenshot, localized copy, segmented progress, compact header, and fixed footer. Mobile uses a near full-screen modal or sheet with safe-area padding, 9:16 screenshot, scrollable content, stacked setup controls, and sticky footer. Skip sits far left on non-final slides, Back and the accent Next/Finish action sit on the right, and all clickable controls need pointer cursor, hover affordance, and focus-visible styling.
_Avoid_: arbitrary slide layout, landing page, inline banner

**Campaign Slide Layout**:
The fixed layout type for a campaign slide. V1 supports only setup slides and standard slides; both still use required desktop and mobile **Campaign Screenshots**.
_Avoid_: text-only disclosure, rich custom slide, arbitrary content block

**Campaign Image Crop**:
The admin workflow that accepts source images and produces required desktop and mobile **Campaign Screenshots** using the campaign's fixed aspect ratios. Desktop crops use 16:10 and mobile crops use 9:16. A slide may use separate desktop and mobile source uploads, with optional source reuse when practical, and the admin should not have to pre-crop source images outside AlfyAI.
_Avoid_: exact-ratio upload requirement, uncropped image, responsive freeform media

**Campaign Crop Modal**:
The dedicated admin modal for producing a desktop or mobile **Campaign Image Crop** from a source image. It provides enough room for fixed-ratio cropping, zoom, pan/reposition, reset, and save actions without crowding the campaign editor.
_Avoid_: cramped inline cropper, external crop tool, freeform crop

**Announcement Release**:
A meaningful app release that intentionally has an attached **Announcement Campaign**. It is not inferred from every deployment or patch version; the product decides which releases deserve an announcement.
_Avoid_: every deploy, automatic patch popup, server-update notice

**App Version Badge**:
A compact, muted version label shown next to the AlfyAI title in the sidebar. It identifies the current app version and opens the most recent **Announcement Campaign** when clicked. It displays a compact major/minor version such as `v1.4`, with the full package version available in hover or metadata.
_Avoid_: changelog nav item, build hash, update toast

**Canonical App Version**:
The deployed AlfyAI application version used by the **App Version Badge** and as the default linked app version for release campaigns. It comes from package metadata rather than admin-entered configuration.
_Avoid_: admin-typed current version, deploy timestamp, build hash as product version

**Campaign Screenshot**:
A curated static capture of AlfyAI used inside an **Announcement Campaign** to show a released product surface without relying on the user's private data or live app state. Each campaign slide requires desktop and mobile screenshots with stable aspect ratios, and screenshots may zoom into a focused UI area instead of showing the full app chrome.
_Avoid_: live screenshot, user-data preview, approximate mock UI

**Campaign Asset**:
An app-owned screenshot or image file uploaded and cropped through admin campaign authoring. Campaign assets are stored outside the Knowledge Base, are not user documents, and are served according to campaign publication state: draft assets to admins only, published campaign assets to authenticated eligible viewers.
_Avoid_: knowledge artifact, public static file, chat attachment

**Campaign Content Localization**:
Admin-authored localized slide content stored with campaign drafts and published snapshots. Reusable campaign UI chrome belongs in the app i18n dictionary, while campaign-specific titles, body text, action labels, and image alt text are campaign content.
_Avoid_: hardcoded slide copy, i18n-only campaign text, single-language release note

**Campaign Publish Validation**:
The strict completeness checks required before a draft campaign can become a published immutable snapshot. Validation covers required localized content, desktop and mobile campaign assets, valid slide ordering, bounded actions, valid preference controls, and type-specific requirements such as first-run setup and data disclosure slides.
_Avoid_: best-effort publish, missing-language campaign, broken slide

**Campaign Interaction Analytics**:
Minimal admin-facing event records for campaign delivery and engagement, such as auto-shown, slide viewed, completed, skipped, replay opened, and setup preference changed. These events are tied to campaign identity, user, timestamp, event type, and slide index when relevant, without free-form user content or heatmap-style tracking.
_Avoid_: behavioral surveillance, click heatmap, transcript analytics

**Campaign Analytics Summary**:
The admin campaign-detail view of **Campaign Interaction Analytics**, showing simple campaign-revision counts and completion/drop-off signals near the campaign content rather than in the general analytics dashboard.
_Avoid_: global usage dashboard, per-click report, heatmap

**Campaign Action Destination**:
An optional slide action target chosen from a fixed allowlist of internal AlfyAI routes. Campaign actions do not support arbitrary external URLs in v1.
_Avoid_: external link, arbitrary redirect, freeform URL

**Onboarding Preference Choice**:
A real account default selected inside the **First-run Onboarding Tour** using the same preference authority as Settings. It is limited to existing user-controlled defaults such as UI language, default model, AI style, and theme.
_Avoid_: onboarding-only setting, setup wizard state, admin default override

**Onboarding Setup Slide**:
The first slide of the **First-run Onboarding Tour**, where the user can choose the most important account defaults before seeing feature introductions. It groups **Onboarding Preference Choices** such as language, theme, default model, and AI style.
_Avoid_: language-only slide, account setup wizard, profile creation

**System Default Preference**:
A user preference state where the account inherits the current administrator-configured default instead of storing a personal override. For model selection, it means the user's default model follows the system default model until the user chooses a specific model.
_Avoid_: copied default, recommended model, hardcoded provider

**System Default Migration**:
The transition rule for existing user model preferences when **System Default Preference** is introduced. Existing users whose stored preferred model equals the configured default model become inherited System default users; users with a different stored model keep that model as an explicit override.
_Avoid_: forced reset, all-users model override, historical guesswork

**Onboarding Feature Introduction**:
A tour slide that teaches or discloses a product capability without changing durable workspace data or system-level configuration. It may link the user to the owning surface after the tour.
_Avoid_: hidden configuration step, feature enablement, tutorial task

**Onboarding Data Disclosure**:
A required first-run onboarding slide that plainly explains that AlfyAI is not fully local, may process messages and files through configured model providers and integrations, and stores memory or analytics according to the deployment's configuration. It is an acknowledgement disclosure unless the product offers a real opt-out.
_Avoid_: privacy consent toggle, local-only claim, legal fine print

## Privacy Controls

### Language

**Account Erasure**:
The user-requested deletion of an AlfyAI account and the personal workspace data that can identify or belong to that user, including app-controlled external memory state. Non-identifying aggregate usage and cost totals may remain, but retained records should not preserve the erased user's email, name, user identity, conversation titles, message identity, or other person-linked traces.
_Avoid_: account cleanup, soft delete, analytics-preserving delete

**Account Data Archive**:
A user-requested downloadable ZIP archive that helps a person review the personal data AlfyAI stores about them, including chat messages, app-controlled memory, original uploaded files, generated files, analytics, and related workspace records. It is meant to be comprehensive, human-readable, and easy to navigate by a person, using stable English folder and file names beginning with `Open AlfyAI Data Archive.html` while preserving stored user content in its original language, not a machine-importable backup, restore format, diagnostic trace, or raw structured-data dump for AlfyAI.
_Avoid_: app backup, restore export, importable snapshot, raw database dump, developer export

**Data Archive Exclusion Note**:
A plain-language disclosure inside an **Account Data Archive** for a known product area that is intentionally left out of the archive scope. In v1 data is excluded and should be named in the archive rather than silently omitted.
_Avoid_: hidden limitation, missing export, internal TODO

**Privacy and Data Controls**:
The profile settings section where every signed-in user manages personal data lifecycle actions: downloading an **Account Data Archive**, **Clear Memory and Knowledge**, **Clear Workspace Data**, and **Account Erasure**. It replaces vague danger-zone wording with concrete action names.
_Avoid_: danger zone, account reset area, GDPR menu, data tools

**Clear Memory and Knowledge**:
The user action that removes remembered context, Knowledge Base content, document-derived context, continuity state, and stored evidence traces while keeping the user's chat conversations and account. It is narrower than **Clear Workspace Data** and is not **Account Erasure**. The **Memory Rework Update** should preserve this as the account-level memory and knowledge reset path rather than adding a second reset button, and it must clear any new Memory Profile projection, review, conflict, intake, maintenance, telemetry, and Honcho identity state that could otherwise rehydrate memory.
_Avoid_: reset memory, forget everything, knowledge reset, account reset, duplicate memory reset button

**Memory Reset Generation**:
A durable account-level marker advanced by **Clear Memory and Knowledge** so old memory maintenance, dirty work, review items, and projection writes cannot rehydrate pre-reset memory. Memory work from an older generation should be ignored rather than applied after reset.
_Avoid_: in-memory cancel flag, best-effort quiesce only, old retry work, reset timestamp heuristic, Honcho-only reset

**Clear Workspace Data**:
The user action that removes a user's chats, Knowledge Base content, app-controlled memory, generated files, and workspace continuity while keeping their login, profile settings, avatar, and identifiable historical analytics. It is a workspace wipe for continued use of the same account, not **Account Erasure**.
_Avoid_: reset account, delete account, factory reset, privacy deletion

## Normal Chat Context

### Language

**Available Context**:
Conversation, workspace, memory, document, attachment, or task information that AlfyAI may consider for a **Normal Chat** turn.
_Avoid_: prompt, evidence, memory dump, active context

**Prompt Context**:
The subset of **Available Context** actually sent to the model for a specific **Normal Chat** turn.
_Avoid_: available context, all memory, workspace state

**Normal Chat Turn**:
One user request and assistant response cycle in **Normal Chat**, including **Context Selection** before the model call and **Normal Chat Turn Completion** after the assistant response.
_Avoid_: message send, Langflow run, SSE session

**Normal Chat Model Run**:
The app-owned execution boundary that runs already-prepared model work for a **Normal Chat Turn** after **Context Selection** and before **Normal Chat Turn Completion**. It owns outbound model attempts, provider failover, tool-call lifecycle, model output, and usage metadata without deciding **Prompt Context** or durable completion.
_Avoid_: Langflow run, Vercel run, AI SDK run, prompt assembly, AI SDK UI Stream Contract, Normal Chat Turn Completion

**Langflow Model Run**:
Retired historical term for the old outbound execution boundary for a Normal Chat model call through Langflow. It has been superseded by **Normal Chat Model Run**, which now uses Vercel AI SDK/OpenAI-compatible provider execution and app-owned tools.
_Avoid_: prompt assembly, Context Selection, AI SDK UI Stream Contract, Normal Chat Turn Completion

**Normal Chat Turn Completion**:
The point where an assistant response becomes durable conversation state, including persisted messages, response-facing **Context Sources**, message evidence, skill state changes, and continuity side effects for that turn.
_Avoid_: route response assembly, stream end event, post-send cleanup

**Normal Chat Completion Boundary**:
The app-owned boundary that decides the durable result of **Normal Chat Turn Completion** before transport adapters expose it as JSON, SSE, refreshable conversation detail, or visible chat UI state.
_Avoid_: deep module, route-local completion, stream-only finalization

**AI SDK UI Stream Contract**:
The browser-facing streaming transport contract for **Normal Chat** stream and reconnect responses, including the allowed AI SDK UI stream part names, payload shapes, encoding, replay framing, metadata, finish, and `[DONE]` rules owned by `src/lib/server/services/chat-turn/stream.ts` and decoded by `src/lib/services/streaming.ts`.
_Avoid_: Langflow stream, Normal Chat Turn Completion, route-local stream part, legacy Browser SSE event

**Normal Chat Client Turn Runtime**:
The browser-side plain TypeScript boundary at `src/lib/client/normal-chat-client-turn-runtime.ts` that owns Normal Chat send, retry, reconnect, waiting, stop, queued follow-up, and recovery runtime semantics above `streamChat`. It consumes decoded stream callbacks and server-returned metadata through page adapters while the chat page keeps visible Svelte state, route lifecycle, document workspace state, and UI commands.
_Avoid_: AI SDK UI stream parser, Context Sources builder, chat page state, durable completion

**Token Display Buffer**:
A `requestAnimationFrame`-aligned batching layer inside the **Normal Chat Client Turn Runtime** that coalesces streamed text deltas — both visible text and thinking text — before they reach the page adapter's `appendTokenChunk` and `appendThinkingChunk`. It is a display cadence buffer, not a content buffer — it changes when accumulated text reaches reactive state, not what text arrives. It flushes once per animation frame and synchronously on stream end, user-requested stop, and error, ensuring no buffered text is lost during termination. It does not buffer tool-call updates or metadata.
_Avoid_: content buffer, token cache, render throttle, display queue, MarkdownRenderer throttle

**Render Coalescing Cadence**:
The minimum interval between markdown re-renders during streaming, owned by `MarkdownRenderer.svelte`. It is distinct from the **Token Display Buffer**: the buffer controls when accumulated text reaches reactive state (aligned to animation frames), the cadence controls when that state is re-parsed and painted (throttled via `setTimeout`). Both are needed — the buffer prevents reactive pressure, the cadence prevents render-cost pressure from full markdown re-parses. When the block count is unchanged during streaming, only the last block's HTML is updated in-place to avoid tearing down and recreating the entire block list.
_Avoid_: render throttle, display buffer, frame skip, debounce

**Word Reveal Animation**:
The CSS animation applied to newly arrived words during streaming, owned by `MarkdownRenderer.svelte` and `ThinkingBlock.svelte`. Words fade from `opacity: 0` to `1` with a `translateY(2px)` settle over `300ms ease-out`, with no stagger within a batch. It replaces the previous `0.3 → 1` opacity-only flash. Each batch's words animate together; the natural cadence comes from the **Render Coalescing Cadence**, not from intra-batch staggering. The final batch of words when the stream ends must also receive the animation — the last render transitioning from streaming to finished should still call `wrapNewWords()` so there is no visual seam between streaming words and finished words. Both components must keep their `wordFadeIn` keyframes in sync, and both must respect `prefers-reduced-motion: reduce`.
_Avoid_: typewriter effect, per-letter animation, staggered cascade, blur-in, word shimmer

**Conversation Detail Read Model**:
The server read-model boundary at `src/lib/server/services/conversation-detail/read-model.ts` that assembles the refreshable `ConversationDetail` payload for chat page load and browser hydration. It owns bootstrap/full detail selection, payload defaults, child-fork message decoration, Context Sources projection, task-state continuity attachment, draft, generated-file, File Production, context-compression, cost fields, and active Skill Session public serialization.
_Avoid_: route-local hydration recipe, durable Normal Chat Turn Completion, AI SDK UI stream terminal payload, page-owned payload assembly

**Memory Access**:
AlfyAI's ability to use durable user, conversation, project, document, and research context through Honcho-led memory and app-supplied historical context retrieval.
_Avoid_: local persona engine, memory replacement, transcript dump

**Context Access**:
The production capability that lets AlfyAI discover, select, and use relevant memory, history, project, document, and research context without requiring low-level manual setup from the user.
_Avoid_: tool collection, retrieval demo, manual context setup

**Memory Context Tool**:
The model-facing retrieval tool for asking AlfyAI what durable memory or historical context is relevant to the current turn. It may retrieve historical chats and documents for source/history questions, but should not reintroduce deleted, suppressed, expired, blocked, or review-needed profile memory as ordinary personalization.
_Avoid_: project-only tool, persona-memory tool, transcript search tool, hidden personalization bypass

**Forget (a memory)**:
The user action that suppresses a memory from active recall — AlfyAI stops bringing it up on its own — while keeping the underlying record so it can still be found or restored. It is the lighter of the two memory-removal actions and the default offered on the Memory Profile surface.
_Avoid_: delete, erase, permanent removal, hide

**Delete permanently (a memory)**:
The user action that fully erases a memory so AlfyAI no longer remembers it at all, even on direct recall. It is the heavier of the two memory-removal actions and is demoted behind Forget on the Memory Profile surface because it is not reversible.
_Avoid_: forget, suppress, soft removal, pause

**Memory Rework Update**:
The complete product update that makes AlfyAI memory usable long-term by replacing raw transcript mirroring and raw maintenance tables with curated Memory Profile, gated intake, bounded maintenance, next-turn-effective user corrections, and first-class telemetry-backed reconciliation.
_Avoid_: v1, draft, prototype, partial memory path, temporary cleanup pass

**Memory Rework Telemetry**:
The operational evidence AlfyAI records to judge whether the **Memory Rework Update** is working unattended, including memory intake decisions, maintenance actions, review burden, user correction and deletion patterns, and prompt-use outcomes. It is organized around fixed event families instead of free-form logs. By default it should record decisions, categories, reasons, counts, statuses, and stable identifiers rather than raw remembered text or raw chat excerpts. User-linked telemetry should clear with **Clear Memory and Knowledge**; non-identifying aggregate counters may remain only when they cannot identify the user or reconstruct memory. It should be backend/log-only by default, without a Memory Profile or admin summary view until collected data proves which metrics are useful.
_Avoid_: raw memory dump, raw chat excerpt log, hidden debug log, free-form telemetry stream, vanity metric, later observability add-on, second sensitive memory store, default telemetry dashboard

**Memory Rework Telemetry Event Family**:
A stable class of **Memory Rework Telemetry** events used to make memory behavior measurable without storing raw remembered content. The default families are intake, active profile projection, prompt use, maintenance, guided review, profile action, reset or forget, and error or fallback.
_Avoid_: arbitrary log label, dashboard metric, remembered fact type, memory category

**Memory Decision Confidence Band**:
A coarse confidence range used to bootstrap automatic memory decisions such as active admission, junk rejection, supersession, review, preservation, or inactive use. It should guide defaults and telemetry, but it must not override **Memory Source Authority** or user-authored profile state.
_Avoid_: precise truth score, classifier-only authority, source-agnostic threshold, confidence badge, deletion permission

**Baseline Memory Profile**:
A compact default slice of **Active Memory Profile Context** available to an ordinary chat turn before the model decides whether to retrieve deeper memory. It is not a separate profile or store; it should respect the active **Memory Profile Projection** so corrected, deleted, suppressed, expired, and review-blocked profile facts do not leak back into prompt context.
_Avoid_: newest memories, raw conclusion list, local persona summary, stale deleted memory, second profile store

**Projection-Gated Memory Access**:
The rule that Honcho-led and historical memory may support chat only through active profile projection or policy-aware retrieval, not as unfiltered ordinary personalization. It is not a separate tool or store; it preserves relevance by allowing query-time memory retrieval while enforcing deleted, suppressed, expired, conflict-blocked, review-needed, and preserved-legacy memory state.
_Avoid_: raw Honcho bypass, blanket Honcho ban, hidden personalization path, direct persona injection, second access layer

**Adaptive Active Memory Budget**:
The pressure-based limit that decides how much remembered material may remain active in the **Memory Profile Projection** and **Active Memory Profile Context**. It is based on relevance, authority, scope, confidence, category balance, contradiction risk, and available context budget rather than a fixed product item count.
_Avoid_: hard active item cap, fixed 100-memory limit, visible memory quota, profile pressure warning, storage limit, everything active

**Knowledge Memory Overview**:
The legacy compatibility surface for older Knowledge Memory callers. New user-facing memory UX should use the **Memory Profile Projection** returned by `src/lib/server/services/memory.ts`, while `/api/knowledge/memory/overview` may wrap that projection for callers that still expect a Knowledge Memory overview payload. It must not revive raw Honcho markdown, task/focus continuity buckets, or route-local Honcho cleanup as the Knowledge Base memory UI.
_Avoid_: memory markdown, Honcho dump, conversation results list, generated report, project continuity dashboard, task memory table, active profile authority

**Memory Profile Projection**:
The durable, app-owned, user-facing active memory authority that turns admitted profile memory, legacy evidence, and app-owned profile state into an easy-to-review **Memory Profile** made of curated **Memory Profile Items**. It should keep stable item identity and active-use state across refreshes and chat turns so user corrections, deletions, suppressions, expiries, conflict blocks, and review decisions remain next-turn-effective. Honcho may support migration, enrichment, historical evidence, and reconciliation, but active profile memory exists when it is active in the current projection generation.
_Avoid_: live Honcho prose as active truth, local persona engine outside the projection, task continuity surface, focus continuity section, rebuild-only profile

**Memory Profile Item Identity**:
The app-owned stable identity of a **Memory Profile Item**, derived from the normalized remembered statement, category, scope, and provenance relationship rather than from a single Honcho conclusion ID. Honcho IDs may be provenance pointers, but they should not be the user-facing item identity because edits, merges, splits, and Honcho rewording must not break next-turn-effective profile state.
_Avoid_: Honcho conclusion ID as item ID, raw memory row ID, live-memory identity, source-only identity

**Memory Slot**:
The normalized meaning position of a remembered fact: category, scope, subject, predicate, and authority relationship. It is used to decide whether an edit, merge, split, or conflict concerns the same remembered fact, not shown as a user-facing field set.
_Avoid_: text similarity, source row, UI form fields, Honcho conclusion ID

**Memory Profile Provenance Link**:
A backing relationship between a **Memory Profile Item** and the evidence or memory record that supports it, such as a Honcho conclusion, user-authored correction, review decision, source chat, document rule, or structured work output. Multiple provenance links may support one profile item, but users should edit the profile item rather than individual links.
_Avoid_: user-facing item, raw memory row, source table as profile, one-link-per-card memory

**Legacy Memory Migration**:
The one-time per-user transition that turns pre-rework Honcho memory into the new **Memory Profile Projection** without treating every legacy memory as active. It should preserve potentially valuable legacy information for future reconciliation or review while only high-confidence, category- and scope-fitting items become active.
_Avoid_: memory purge, raw legacy import, global memory dump, migration wizard, everything active, clean-slate reset

**Preserved Legacy Memory**:
Pre-rework memory state kept after **Legacy Memory Migration** because it may still be valuable but should not currently shape ordinary personalization. It is not a separate profile or browser, is not shown in the default **Memory Profile**, is not part of **Active Memory Profile Context**, and exists only for bounded future reconciliation, capped review, or explicit history and source questions.
_Avoid_: hidden active memory, second profile, inactive memory browser, deleted memory, raw review backlog, second memory store

**Legacy Reconciliation Trigger**:
A bounded reason to revisit **Preserved Legacy Memory**, such as a related profile edit or deletion, a new same-topic memory, a detected conflict, a stale Memory Profile refresh, or spare scheduled maintenance capacity. It prevents preserved legacy material from being processed merely because it exists.
_Avoid_: full backlog sweep, process-everything obligation, unbounded migration pass, GPU cleanup run

**Memory Profile Item**:
A concise, editable statement in the **Memory Profile Projection** that represents remembered user context AlfyAI may actively use. It may aggregate several **Memory Profile Provenance Links** when they clearly support the same remembered fact, but the default UI should present the clean remembered fact rather than raw extracted chat-round records, confidence labels, freshness metadata, or cleanup status.
_Avoid_: Honcho conclusion row, extracted chat round, source table row, debug memory record, raw durable-memory table, default confidence badge, default freshness badge, one-to-one conclusion wrapper

**Active Memory Profile View**:
The default **Memory Profile** view that shows only **Memory Profile Items** AlfyAI may currently use for personalization, plus visible **Guided Memory Review** when needed. Normal categories should exclude deferred, blocked, expired, suppressed, deleted, and review-needed items. It should not provide a general inactive, deleted, suppressed, expired, or history browser.
_Avoid_: all memories table, Honcho dump, recently-updated section, inactive default list, memory graveyard, deleted memories tab, blocked item in category

**Active Memory Profile Context**:
The model-facing form of the active **Memory Profile Projection** used for personalization in chat. It should use the same active usable **Memory Profile Item** set shown in the normal categories of the **Active Memory Profile View**, while omitting UI-only details and excluding deleted, suppressed, expired, corrected-away, deferred, blocked, or unresolved review-needed memory.
_Avoid_: raw Honcho context, hidden stale memory, UI-only profile details, backend continuity state

**Pre-Filtered Prompt Memory**:
The rule that ordinary model-facing memory personalization contains only active usable **Memory Profile Items** before the model sees it. Inactive, deleted, suppressed, expired, conflict-blocked, review-needed, preserved legacy, and ambiguous-scope material should be omitted from ordinary personalization rather than sent with status labels for the model to police.
_Avoid_: model-policed memory status, inactive facts with warnings, use-but-don't-use prompt block, raw status-labelled Honcho dump

**Historical Memory Evidence**:
The compact, source-framed memory or history material returned only for explicit history, source, document, or evidence questions. It may include inactive, expired, preserved legacy, or ambiguous-scope material as historical evidence, but it is not current profile truth and should not rehydrate user-deleted or user-suppressed profile memory through memory recall.
_Avoid_: current personalization, hidden profile memory, deleted memory recall, suppressed memory recall, active profile fact, full inactive profile payload

**Memory Intake Gate**:
The memory boundary that decides whether new chat, document, or work material is durable enough to become remembered context. It should admit explicit, useful profile facts, preferences, constraints, goals, and concrete work capsules while rejecting ordinary transcript chatter and obvious **Junk Memory** before they reach durable memory. It should make a bounded structured decision before durable memory writes rather than persist a long-lived pending-memory-candidate store.
_Avoid_: transcript mirror, every-message capture, assistant-response dump, broad cleanup pass, second memory system, pending raw memory queue

**Memory Intake Decision**:
The structured outcome produced by the **Memory Intake Gate** for new candidate material. It should be one of: admit, reject, or defer to maintenance. Admit writes accepted durable memory into the active **Memory Profile Projection**; reject records why the material should not become memory; defer to maintenance records telemetry and dirty state without storing raw candidate text.
_Avoid_: hidden maybe-memory queue, raw candidate backlog, unstructured classifier note, forced admit, silent uncertainty

**Immediate Memory Admission**:
The path where the **Memory Intake Gate** admits a remembered fact during post-turn processing without waiting for broader maintenance. It should require explicit durable language or strong explicit phrasing for preferences, constraints, goals, project rules, and document rules. Stable user-authored self-statements may be admitted without memory verbs when they are clearly about the user and not merely document-derived or assistant-inferred.
_Avoid_: soft instruction as durable rule, assistant inference, document-derived self-truth, every preference-like phrase, uncertain immediate write

**Deferred Memory Extraction**:
The LLM-assisted intake path that processes conversation material the **Immediate Memory Admission** parser could not confidently admit or reject. It runs during **Expensive Memory Reconciliation** as a bounded maintenance slice, inspects a bounded window of recent conversation turns, and produces structured candidate memories with category, scope, and **Memory Decision Confidence Band**. High-confidence candidates are auto-admitted; ambiguous candidates become **Guided Memory Review** items; low-confidence candidates are rejected with telemetry. It does not mirror raw transcript, extracting only durable candidate facts, preferences, constraints, goals, and self-statements. The app owns this extraction using its configured model; Honcho is not the extraction engine.
_Avoid_: real-time extraction, chat-path LLM call, raw transcript mirror, Honcho deriver as extraction engine, unbounded extraction sweep

**Assistant Prose Memory Exclusion**:
The rule that ordinary assistant-generated answer text is not a source for **Immediate Memory Admission**. Assistant prose may remain chat history, evidence, or conversation context, but it should not become durable memory authority. App-owned structured outputs may become memory only through typed, scoped, provenance-aware paths.
_Avoid_: assistant answer as user truth, mirrored assistant prose, summary as profile memory, model guess as memory, feedback loop

**User-Authored Memory Precedence**:
The conflict rule that explicit user-authored memory, corrections, deletions, and durable statements override assistant-generated prose and app-authored structured memory when they disagree. The user's statement should affect active use immediately, while memory maintenance reconciles older durable records later.
_Avoid_: work capsule override, assistant inference wins, generated metadata as higher authority, stale structured memory, delayed user correction

**Memory Intake Normalization**:
The constrained shaping step that turns admitted material into a clean remembered statement with category, scope, reason, and provenance. It should preserve the user's meaning while removing task clutter, local wording, accidental assistant prose, and unsafe over-inference. If the category, scope, or statement cannot be separated confidently, the intake decision should defer to maintenance.
_Avoid_: free-form personality inference, raw sentence storage, duplicate category fanout, hidden rewrite, broad classifier guess

**Memory Scope**:
The applicability boundary for a remembered fact. It answers where AlfyAI may use the memory, separately from **Memory Profile Category**, which answers what kind of memory it is. Allowed scopes are global, project, conversation, and document. Scope assignment should use the narrowest confident scope; global scope is for clearly user-wide memory. Project scope attaches to the **Project Folder** when one is present, otherwise to confirmed **Project Continuity**. Scope prevents project-, conversation-, or document-specific remembered facts from leaking into global personalization while still allowing the right related chats to share context.
_Avoid_: category, UI section, provenance, confidence score, global-by-default memory, free-form client scope, free-form topic scope

**Document-Sourced Context**:
Information available because it appears in an uploaded, generated, attached, or stored document. It may be used as document evidence or working-document context, but it is not user-truth or Memory Profile material merely because the document exists in AlfyAI.
_Avoid_: user profile fact, persona memory, document content as user truth, receipt as preference, tax paper as biography

**Document-Scoped Memory**:
A remembered fact whose applicability is limited to a specific document or document family, usually about how that document should be interpreted, edited, revised, or reused. It should come from explicit user intent or document-workflow behavior, not from treating arbitrary document contents as facts about the user.
_Avoid_: fact found inside a document, global user memory, document provenance, uploaded-file ownership, extracted PDF fact

**Document Memory Admission**:
The rule for when **Document-Sourced Context** may become **Document-Scoped Memory**. Immediate admission requires explicit user-authored durable intent about how AlfyAI should remember, treat, edit, interpret, revise, or reuse a document or document family, such as "remember," "always," "from now on," or "for this document family." Repeated document workflow behavior may defer to maintenance or review, but should not silently admit durable memory.
_Avoid_: upload-as-memory, repeated behavior as silent truth, document body extraction as profile learning, automatic receipt learning, one-off edit as durable preference

**Main Chat Memory Control**:
A visible memory-specific control inside the ordinary chat interface, such as a save-to-memory button, memory toggle, or memory management action attached to chat messages or the composer. The **Memory Rework Update** should not add these controls because normal chat memory should remain automatic from the user's perspective.
_Avoid_: save memory button, remember-this chip, chat memory toggle, message-level memory editor

**Memory Profile Category**:
A broad, user-facing group of **Memory Profile Items** that helps a person quickly understand what kind of remembered context they are reviewing. Categories should be few, conceptually separate, and easy to distinguish without understanding memory internals.
_Avoid_: memory class, Honcho scope, extraction bucket, technical taxonomy, status label

**About You Memory Category**:
The **Memory Profile Category** for stable personal context, background facts, owned things, and other durable information about the user.
_Avoid_: preference, goal, constraint, inferred project continuity

**Preferences Memory Category**:
The **Memory Profile Category** for how the user likes AlfyAI to respond, how they prefer work to be done, and other durable tastes or defaults.
_Avoid_: hard rule, temporary instruction, personal biography, task checkpoint

**Goals & Ongoing Work Memory Category**:
The **Memory Profile Category** for explicit user-shared goals, plans, and ongoing work that the user would expect AlfyAI to remember as part of their profile.
_Avoid_: inferred project continuity, hidden task state, sibling chat awareness, every active task

**Constraints & Boundaries Memory Category**:
The **Memory Profile Category** for durable hard requirements, sensitivities, limits, deadlines, and "do not do this" boundaries that should shape personalization.
_Avoid_: casual preference, stale warning, raw safety policy, temporary task detail

**Memory Profile Correction**:
A user action that amends or replaces a remembered fact in the **Memory Profile** because AlfyAI's current understanding is wrong, outdated, or incomplete. If exposed as an edit action, it should be a direct full edit of the remembered statement, not a guided field editor. It should take precedence over conflicting remembered facts on the next chat turn while memory maintenance reconciles the durable record.
_Avoid_: preference toggle, hidden prompt override, duplicate conflicting memory, local memory synthesis, guided edit wizard, partial field editor

**Memory Edit Classification**:
The decision that determines whether a direct edit to a **Memory Profile Item** is a same-item correction, a replacement item, or an ambiguous rewrite that needs plain user confirmation. It should compare the normalized memory slot, not text length or character similarity.
_Avoid_: text-diff threshold, small edit heuristic, silent unrelated rewrite, always delete and recreate

**Safe Memory Match**:
A provenance relationship strong enough for maintenance to alter backing remembered evidence without likely touching unrelated memory. It should come from explicit provenance or a tightly matching **Memory Slot** and authority relationship, not fuzzy text similarity alone.
_Avoid_: best-effort delete, broad Honcho cleanup, exact-text-only match, partial provenance guess, LLM-only match

**User-Authored Merge Precedence**:
The rule that user-authored **Memory Profile** state wins when maintenance merges duplicate or overlapping remembered items. Merges should preserve user edits, review decisions, suppressions, and deletions instead of letting lower-authority Honcho-derived or structured records revive old active truth.
_Avoid_: Honcho-derived merge winner, deleted memory revival, suppressions lost during merge, newest row wins

**Memory Profile Split**:
A maintenance action that separates one **Memory Profile Item** into child items when it clearly contains multiple **Memory Slots**. It should preserve the parent item's user-authored state and assign only relevant provenance links to each child.
_Avoid_: silent rewrite, provenance fanout, deleted parent revival, split to reduce text length

**Memory Profile Refresh**:
The cheap read-side update that returns the current **Memory Profile Projection** when the user opens the **Knowledge Base** or Memory Profile. It may check projection staleness and enqueue background maintenance, but it should not synchronously run expensive reconciliation before rendering the profile.
_Avoid_: full maintenance sweep, blocking cleanup, Honcho dreaming, LLM pruning run

**Memory Projection Revision**:
A durable version marker for **Memory Profile Projection** state that lets newer user-facing memory changes supersede stale background work. It should guard concurrent edits and maintenance writes without turning the memory system into full event sourcing.
_Avoid_: last-writer-wins, full memory event log, stale maintenance overwrite, hidden prompt override revision, Honcho revision

**Memory Authority Fallback**:
The fallback behavior when Honcho-backed memory authority cannot refresh, delete, or reconcile backing memory. The durable **Memory Profile Projection** remains the user-facing active truth, while failed authority work becomes retryable maintenance and telemetry.
_Avoid_: empty profile fallback, raw Honcho fallback, blocking local profile action, background-error banner, authority-first UI

**Memory Authority Substrate**:
The durable backing store that holds the canonical copy of remembered facts for cross-session, cross-conversation recall. In AlfyAI, Honcho serves as the **Memory Authority Substrate** while the app-owned **Memory Profile Projection** is the active read model used at prompt time. Writes to the substrate happen asynchronously after admission so the chat path never blocks on external memory service latency. Raw transcript is not stored in the substrate; only curated conclusions from admitted memories are written.
_Avoid_: local persona-memory system, projection-as-canonical-store, parallel memory store, chat-blocking memory write, raw transcript in substrate

**Expensive Memory Reconciliation**:
The bounded background maintenance work that deduplicates, expires active use, revisits preserved legacy material, generates review items, reconciles Honcho deletes or replacements, and triggers Honcho Dreaming when needed. It should run from dirty state, cooldowns, and account work budgets rather than from every chat turn or Knowledge Base open.
_Avoid_: cheap profile refresh, synchronous KB load, every-message cleanup, unbounded account sweep

**Bounded Memory Reconciliation Slice**:
The limited unit of **Expensive Memory Reconciliation** performed for an account in one maintenance run. It should process the highest-priority dirty work that fits the current budget and leave remaining **Memory Dirty State Ledger** entries pending for later runs.
_Avoid_: finish-everything pass, account monopoly, full legacy sweep, unbounded cleanup run

**Memory Slice Batch Limit**:
A per-slice safety limit on how many memory candidates, projection changes, authority mutations, review items, or dreaming actions **Expensive Memory Reconciliation** may attempt. It complements time and token budgets so legacy-heavy users cannot create unpredictable maintenance runs.
_Avoid_: full candidate sweep, unlimited mutation batch, authority-call flood, time-budget-only maintenance

**Memory Dirty State Ledger**:
The durable, typed account-level signal that tells maintenance what memory work may be needed without storing raw candidate text. It coalesces repeated triggers such as stale projection, deferred intake, profile-action reconciliation, projection reconciliation, possible conflict, possible duplicate, legacy migration, optional Honcho export, and review generation so expensive maintenance can choose bounded work after restarts.
_Avoid_: raw pending memory queue, transcript backlog, in-memory-only dirty flag, full account scan trigger, per-message cleanup job

**Memory Maintenance Scheduler**:
The background worker path that claims **Memory Dirty State Ledger** work by user, priority, cooldown, and budget, then runs **Bounded Memory Reconciliation Slices**. It should own expensive scheduling instead of letting chat turns, Knowledge Base opens, or profile actions directly run cleanup.
_Avoid_: chat-turn cleanup runner, KB-open maintenance runner, per-tab reconciliation, competing schedulers, direct expensive trigger

**Memory Profile Edit Surface**:
The user-facing place where a person edits or inspects a **Memory Profile Item**. It should present the curated statement, simple actions, and optional human-readable details rather than raw memory rows, Honcho dumps, markdown source text, or technical tables.
_Avoid_: raw durable-memory table, extracted-round dump, Honcho row editor, developer diagnostics, markdown blob

**Memory Profile Suppression**:
A user action that removes a remembered fact from active use when it is unwanted, obsolete, too sensitive, or cannot be safely matched to one exact durable memory. It should stop the fact from shaping the **Memory Profile**, memory recall, and the next chat turn's active personalization even when original source records still exist.
_Avoid_: account erasure, conversation deletion, silent hide, raw memory dump pruning, local Honcho replacement

**Memory Profile Deletion**:
A user action that tells AlfyAI to stop remembering a **Memory Profile Item**. It should remove the item from active use immediately, keep it out of memory recall and the next chat turn, and permanently remove safely matched remembered evidence when possible. It does not delete the original chat messages, documents, account, or workspace data where the information may have first appeared.
_Avoid_: source chat deletion, document deletion, account erasure, technical delete-versus-suppress choice, ambiguous active memory

**Junk Memory**:
Remembered material that carries no useful user meaning and should not personalize AlfyAI, such as malformed extraction residue, accidental technical artifacts, boilerplate interaction summaries, or meaning-preserving duplicates.
_Avoid_: old but meaningful memory, contradiction, sensitive fact, user preference, user boundary, active profile evidence

**Automatic Junk Deletion Gate**:
The intake and maintenance policy that allows junk blocking or permanent deletion without user confirmation only when remembered material is safely identifiable as **Junk Memory**, exact remembered evidence can be targeted where deletion is involved, and no user-meaningful or active-profile veto applies. It is not a separate cleanup system: at intake it blocks only obvious junk before it reaches memory authority; during background maintenance it may perform broader cleanup because it has more context. Candidates that fail the gate should use **Memory Active-Use Expiry**, **Memory Profile Deletion**, or **Guided Memory Review** instead of silent permanent deletion.
_Avoid_: age-based deletion, silent deletion of meaningful facts, contradiction resolver, active profile cleanup shortcut, separate cleanup system

**Memory Reconciliation**:
Background maintenance that aligns the underlying memory substrate after profile edits, deletions, cleanup, supersession, or larger memory batches. It supports durable memory quality over time, but should not be the source of immediate user-facing truth in the **Memory Profile**.
_Avoid_: user-facing dreaming status, blocking save step, primary Memory Profile state, next-turn guarantee mechanism

**Memory Active-Use Expiry**:
A lifecycle change that makes a remembered fact inactive for personalization because it is superseded by newer evidence, time-bound and past, contradicted, stale in a user-impacting way, or no longer confidently useful. It preserves historical evidence unless the user requests forgetting or suppression. It is evidence-based, not simple age-based.
_Avoid_: automatic deletion, permanent forgetting, stale fact as active truth, blind age-based decay

**Memory Conflict Block**:
An active-use block applied when remembered facts in the same **Memory Scope** conflict and AlfyAI cannot safely decide which one supersedes the other. Conflicting items should stay out of ordinary prompt personalization and normal **Memory Profile Categories** until maintenance can supersede, expire, reconcile, or ask the user through **Guided Memory Review**.
_Avoid_: model chooses at answer time, contradictory prompt context, whole-category suppression, silent deletion, cross-scope false conflict, blocked item in active category

**Guided Memory Review**:
The user-facing memory maintenance mode where AlfyAI asks for help only when remembered facts are ambiguous, contradictory, stale, sensitive, or otherwise unsafe to resolve autonomously. Memory remains background by default, but becomes interactive when user judgment is the right authority. It should be optional and visible in the **Memory Profile**, not hidden or routinely interruptive.
_Avoid_: memory inbox, developer diagnostics queue, fully manual memory management, autonomous-only memory, interruptive memory chores

**Memory Review Item**:
A durable, plain-language question created by memory maintenance in **Guided Memory Review** that asks the user for a **Memory Review Resolution**. It should have a simple lifecycle of open, resolved, or obsolete; hide raw memory provenance unless the user asks for details; and remain stable across profile refreshes until the user acts or maintenance proves it obsolete. Chat may ask a direct clarification when the current answer depends on unresolved memory, but persistent **Memory Review Items** should come from memory maintenance rather than ad hoc chat-turn logic.
_Avoid_: Honcho row, contradiction diff, memory debug item, task notification, chat-created durable review item, regenerated question on every refresh

**Memory Review Subject**:
The user-facing issue a **Memory Review Item** asks about, derived from the review type, **Memory Slot**, and affected **Memory Profile Items** when available. Repeated evidence for the same subject should attach to one open review item rather than create duplicate questions.
_Avoid_: Honcho conclusion ID, exact text match, source chat, duplicate review question, raw memory row

**Memory Review Resolution**:
The user decision that closes an open **Memory Review Item**. Resolutions should share three meanings: use this remembered fact, edit the remembered fact, or do not remember this subject.
_Avoid_: custom action vocabulary per review type, keep inactive action, archive choice, technical reconciliation action, source-delete wizard

**Memory Review Item Lifecycle**:
The durable state model for a **Memory Review Item**. Open items need user attention, resolved items record a user decision, and obsolete items are no longer relevant because newer evidence, expiry, merge, deletion, suppression, or reconciliation removed the need to ask.
_Avoid_: regenerated-only review, hidden pending question, permanent stale review, dismissed-by-default state

**Memory Review Burden**:
The amount of unresolved memory-maintenance judgment AlfyAI asks a user to handle through **Guided Memory Review**. It should be capped more aggressively than background maintenance throughput so legacy cleanup does not become user work.
_Avoid_: unlimited review backlog, memory inbox size, developer queue depth, cleanup throughput

**Memory Needs Review Area**:
The dedicated, full-width section at the top of the **Memory Profile** that appears when unresolved **Memory Review Items** exist. It should be visually separate from normal **Memory Profile Categories** so review work is easy to notice when needed without mixing review state into the active profile groups. It should be non-scrollable, show at most three review items, and open an extended modal view for remaining items.
_Avoid_: inline category warning, hidden review queue, global notification, side diagnostics panel, review item mixed into active category, scrollable review panel

**Memory Review Signal**:
A visible, non-interruptive indicator that unresolved **Memory Review Items** exist. It belongs with the **Memory Profile** entry point and should guide interested users into review without becoming a global notification or blocking chat.
_Avoid_: hidden badge, global alert, mandatory task queue, settings-only notice

**Memory Provenance Detail**:
Optional supporting detail that explains why AlfyAI believes a **Memory Profile Item**, such as source conversations, dates, or underlying memory evidence. It should be available on demand, not shown as the default Memory Profile view.
_Avoid_: default source list, extracted chat log, main profile content, technical trace

**Memory Source Authority**:
Supporting detail that describes the authority path behind a **Memory Profile Item**, such as user-authored statement, review resolution, structured work output, maintenance reconciliation, or Honcho-derived memory. It should help users inspect and debug memory when they open details, but should not appear as a default badge or label on ordinary Memory Profile cards.
_Avoid_: default authority badge, technical trust score, source hierarchy UI, card clutter, hidden prompt priority

**Knowledge Memory Overview Bullet**:
A concrete, human-readable statement about the user, their preferences, owned things, goals, constraints, explicitly shared projects, or durable personal context. It may include specific remembered items when they help the user understand what AlfyAI knows, but it should not cite retrieval provenance such as chat numbers, conversation titles, result counts, task checkpoint labels, or inferred continuity buckets.
_Avoid_: chat mention, conversation provenance, source inventory, result summary

**Memory Provenance Noise**:
Source metadata that may be useful internally but should not appear as the main text of a **Knowledge Memory Overview Bullet**, including timestamps, chat numbers, conversation titles, result counts, and section labels like "Explicit Observations".
_Avoid_: visible timestamp, chat title, generated result count, raw Honcho section label

**Sensitive Memory Value**:
Exact personal or security-sensitive values such as phone numbers, email addresses, physical addresses, account identifiers, credentials, tokens, and keys. A Knowledge Memory Overview may soften these values when they appear in otherwise useful bullets, but it should not become a separate memory policy engine that suppresses broad categories of legitimate Honcho memory.
_Avoid_: raw phone number, exact credential, exposed token, overzealous memory filtering

**Context Sources**:
The concept of the carried-forward pool of documents, attachments, memory, prior turns, generated work, and other sources AlfyAI is considering for a conversation. On the chat surface it is shown read-only as the **Sources** disclosure; steering it (pin or exclude) lives in the Knowledge library and working-document workspace, not on the chat surface.
_Avoid_: evidence manager, manual retrieval setup, budget manager, chat-surface steering panel

**Sources**:
The chat-surface label for the per-message disclosure of what informed a specific assistant answer — split into what was **Used** and what was **Set aside**. It is the user-facing name for **Message Evidence** and is informational only on the chat surface.
_Avoid_: Evidence tab, citations panel, context manager

**Message Evidence**:
The per-assistant-message audit of sources used or cited for that answer. Shown on the chat surface under the label **Sources**.
_Avoid_: carried-forward context, context manager, conversation-level source pool

**Source Link Chip**:
A compact assistant-message affordance that represents a safe external source link as a short clickable label plus external-link icon. Hover or focus reveals the full source name and URL while the answer text stays uncluttered.
_Avoid_: icon-only citation, raw citation URL, full source title inline, evidence row

**Protected Context**:
Context that should survive budget pressure longer than ordinary context but still respects the **Context Budget**.
_Avoid_: essential context, mandatory context, unlimited context

**Context Selection**:
The per-turn process that chooses **Prompt Context** from **Available Context**.
_Avoid_: memory assembly, Honcho context, retrieval, prompt building

**Normal Chat Context Selection Boundary**:
The deep server module at `src/lib/server/services/chat-turn/context-selection.ts` that owns constructed Prompt Context for a Normal Chat turn, including candidate collection, budgeted section selection, context status updates, and Context Trace sections. Honcho, Knowledge, Task-State, Working Document Selection, and linked-source services supply candidates or signals to this boundary; they do not decide final Prompt Context inclusion.
_Avoid_: Honcho prompt assembly, Langflow prompt builder, route-local retrieval policy

**Context Inclusion Level**:
The amount of an item of **Available Context** promoted into **Prompt Context** for a turn.
_Avoid_: mode, retrieval class, prompt size

**Reference Context**:
A **Context Inclusion Level** that includes only compact identifying details such as title, type, and relevance reason.
_Avoid_: metadata dump, citation, evidence

**Excerpt Context**:
A **Context Inclusion Level** that includes selected snippets relevant to the current turn.
_Avoid_: chunk dump, full document

**Task Context**:
A **Context Inclusion Level** that includes enough content to perform a requested document or workspace task.
_Avoid_: full context, unlimited context, entire file

**Omitted Context**:
Available information deliberately left out of **Prompt Context** for a turn.
_Avoid_: forgotten context, unavailable context

**Context Signal**:
A reason that an item of **Available Context** may be relevant to the current **Normal Chat** turn.
_Avoid_: guess, heuristic, vibe

**Weak Context Signal**:
A **Context Signal** that can help rank or break ties but should not promote context by itself.
_Avoid_: relevance, active context

**Strong Context Signal**:
A **Context Signal** strong enough to promote **Available Context** into **Prompt Context** when the turn budget allows.
_Avoid_: guarantee, always include

**Context Budget**:
The turn-specific ceiling for how much **Prompt Context** may be sent to the model.
_Avoid_: model limit, token dump

**Max Model Context**:
The model's total input-plus-output context window.
_Avoid_: max output tokens, response limit, prompt-only window

**Max Output Tokens**:
The maximum generated response size reserved for a model call.
_Avoid_: model context, context length, prompt budget

**Reasoning Depth**:
A user-facing Normal Chat composer setting that expresses how much extra answer effort AlfyAI should apply for the next turn, including provider-native reasoning effort when supported and broader Normal Chat effort such as context breadth or web grounding. It is a cost and latency preference, not a guarantee of a better answer or a request to expose private reasoning.
_Avoid_: chain-of-thought toggle, quality mode, spinner time

**Automatic Depth Selection**:
The pre-turn decision used when **Reasoning Depth** is Auto. It may choose standard, extended, or maximum Normal Chat effort from the user's request and lightweight turn context, but it must not choose reasoning-off behavior; disabling reasoning remains an explicit user choice. It should reserve maximum effort for clearly hard or high-value turns and fall back to standard effort if the decision cannot be completed.
_Avoid_: hidden off switch, mid-answer escalation, hardcoded keyword mode

**Depth Clarification**:
A concise localized user-facing question asked as a **Normal Chat** response before high-cost **Depth Profiles** begin when multiple plausible answer targets would materially change expensive work. It asks at most one scoping question, may offer concrete interpretations plus an open-ended alternative, must not expose cost, token, pass-count, or deliberation internals, should use app-owned localized wording rather than model-authored user-facing prose, and should not create a paused or resumable turn state in v1.
_Avoid_: context clarification, hidden assumption, English-only clarification, paused depth turn

**Depth Clarification Turn**:
A normal persisted **Normal Chat Turn** whose assistant response is a **Depth Clarification** instead of a final substantive answer. It should remain visible in conversation history and may carry compact metadata for one-follow-up **Depth Clarification Carry-forward**.
_Avoid_: preflight error, invisible prompt rewrite, unpersisted user request, hidden retry state

**Depth Clarification Gate**:
The bounded pre-turn decision after high-cost **Reasoning Depth** effort is selected and before expensive Normal Chat work begins. It uses deterministic bypasses before any cheap model classification, asks only when the selected effort is high-cost, multiple plausible answer targets exist, and the wrong target would materially change the work, then decides whether to proceed, ask a **Depth Clarification**, or proceed with an explicit assumption.
_Avoid_: full context selection, source-heavy precheck, deliberation pass, approval workflow, model-only gate

**Depth Assumption**:
A brief user-facing assumption stated in the final answer when a high-cost **Depth Profile** can proceed without asking a **Depth Clarification** because one interpretation is clearly dominant. It should name only assumptions that materially shaped the answer and should not mention the internal clarification gate.
_Avoid_: hidden assumption, gate explanation, verbose preamble, weak guess

**Depth Clarification Carry-forward**:
The one-follow-up preservation of the high-cost **Depth Profile** that caused a **Depth Clarification**, so the clarified next turn can still receive the intended effort. It is not a paused turn, a durable preference, or a guarantee that the same effort applies after the user changes the visible composer depth.
_Avoid_: paused turn resume, sticky depth preference, hidden Max mode

**Depth Classifier Model**:
The model used for **Automatic Depth Selection**. By default it is the user's selected **Provider Model** for the turn, but an administrator may configure a specific available **Provider Model** for system use to make depth classification faster, cheaper, or more consistent.
_Avoid_: hidden assistant model, second chat model, hardcoded classifier

**Depth Classifier Resilience**:
The property that **Automatic Depth Selection** degrades through progressively cheaper fallbacks rather than collapsing every Auto turn to standard when the classifier model fails. A resilient classifier retries on token exhaustion, uses schema-in-prompt with lenient parsing for provider compatibility, and falls back to a deterministic keyword heuristic before defaulting to standard. A single classifier failure should not silently make every hard prompt look simple.
_Avoid_: silent standard fallback, single-point-of-failure classifier, invisible classification error

**Explicit Depth Selection**:
A user-selected non-Auto **Reasoning Depth**, such as Off or Max, that applies directly to the next Normal Chat turn without running **Automatic Depth Selection**.
_Avoid_: model override, classifier suggestion, hidden escalation

**Off Reasoning Depth**:
The user-selected **Reasoning Depth** that asks AlfyAI to avoid extra reasoning depth and disable provider-native thinking where supported. It should use the leanest Normal Chat effort profile, but it must not block explicitly requested tools, required freshness grounding, or evidence needed for the user's task.
_Avoid_: no-tools mode, no-search mode, unsafe shortcut

**Depth Classification Context**:
The small, capped preflight context used only for **Automatic Depth Selection**. It may include the current user request, compact recent exchange context with bounded assistant summaries or excerpts, and bounded metadata about selected sources, attachments, active documents, model capability, and user-visible composer state, but it is separate from full **Prompt Context** and should not include raw large document bodies or trigger heavy retrieval by itself.
_Avoid_: full prompt context, retrieval result set, hidden document dump

**Depth Profile**:
The resolved effort profile applied to a Normal Chat turn after **Reasoning Depth** and **Automatic Depth Selection** are evaluated. Some profiles may be internal, such as a middle extended profile, and should appear only in post-response metadata or diagnostics rather than as additional composer choices. Higher profiles should mainly give the model more room to reason through edge cases, implicit user needs, difficult constraints, and key details; broader grounding is added when the task benefits from external or current evidence.
_Avoid_: visible mode list, provider tier, model name

**Max Signal Gap**:
The absence of **Depth Selection Signals** when Max bypasses **Automatic Depth Selection** via deterministic bypass. Without signals, the signal-aware deliberation planner falls back to a baseline all-local pass plan, causing Max to produce fewer model-calling deliberation passes than Auto resolved to Extended with signals. The gap is closed by assigning conservative default signals to Max or by reusing the previous turn's classifier signals when available.
_Avoid_: Max missing signals, deliberation planner default, local-only Max

**Normal Chat Deliberation Pass**:
A bounded extra deliberation step inside a **Normal Chat Turn** that lets higher **Depth Profiles** review context, sources, assumptions, draft quality, or missed edge cases before the final answer. The first pass reconstructs a focused workspace from the current prompt context, keeping only essential user intent, constraints, evidence needs, edge cases, and final-answer guidance. Later passes update a compact central **Deliberation Workspace Report** rather than rereading every prior note. Maximum uses small deterministic micro-checks for missed user needs, risk/tension, final answer shape, and Hungarian parity, then ends in a compact deterministic viable-alternatives preservation check so the final answer stays decisive without prematurely collapsing conditional options. Dynamic high-cost planning may choose additional bounded read-only passes such as source reconciliation, workspace synthesis, or edge-case review when depth signals justify the added latency, but model-backed passes should degrade to compact local checks when their prompt would likely exceed budget. Deliberation remains synchronous Normal Chat work and does not create a retired research job, approval workflow, or report lifecycle.
_Avoid_: deleted research subsystem pass, hidden research job, background report

**Normal Chat Deliberation Brief**:
A compact structured result from a **Normal Chat Deliberation Pass**, carrying findings such as assumptions, evidence needs, source or memory findings, edge cases, viable alternatives, exit criteria, draft risks, and final-answer instructions. It is transient working material for the final answer pass, not durable user-facing chain-of-thought.
_Avoid_: chain-of-thought, hidden transcript, final answer draft

**Deliberation Workspace Report**:
A compact central report reduced from **Normal Chat Deliberation Briefs** during a higher-depth turn. It carries only the user intent, must-include constraints, evidence needs, recommendation guidance, viable alternatives, risks, language requirements, final style guidance, and open questions needed by later passes and final synthesis. It is the Normal Chat equivalent of a streamlined IterResearch workspace and is transient working material, not durable chain-of-thought.
_Avoid_: full deliberation transcript, hidden essay, durable research report

**Deliberation Context**:
The bounded **Prompt Context** and prior **Normal Chat Deliberation Brief** material supplied to a **Normal Chat Deliberation Pass**. The first deliberation pass reconstructs a streamlined workspace from selected Prompt Context, while later passes should use the compact **Deliberation Workspace Report** and gathered findings rather than blindly repeating every full context item.
_Avoid_: full prompt replay, hidden document dump, unbounded context loop

**Deliberation Tool Scope**:
The read-only Normal Chat tool scope available to a **Normal Chat Deliberation Pass** for inspecting memory, web sources, and selected context before the final answer. It excludes file production, write actions, destructive tools, and retired background research mode.
_Avoid_: full tool access, action mode, research job tools

**Normal Chat Response Usage**:
The combined token, cost, model, provider, and runtime measurements for one completed or partially completed **Normal Chat Turn** response. When higher **Depth Profiles** run **Normal Chat Deliberation Passes**, their model and tool usage is included in the same user-facing response total rather than shown as per-pass cost, hidden overhead, or **Research Usage**.
_Avoid_: hidden pass cost, fake research usage, final-call-only cost, per-pass cost row

**Depth Selection Signal**:
A compact structured signal returned with a **Depth Profile** that explains which effort dimensions should change, such as grounding need, context breadth, or output room. It keeps depth selection decomposable rather than treating the profile as an opaque all-or-nothing mode.
_Avoid_: hidden prompt, chain-of-thought, freeform classifier note

**Depth Verbosity Discipline**:
The rule that a higher **Depth Profile** should increase reasoning care and completeness, not automatically make the final answer longer. The final response should still follow the user's requested style, length, and format.
_Avoid_: long answer mode, verbosity slider, always detailed

**Max Reasoning Depth**:
The highest user-selectable **Reasoning Depth** for **Normal Chat**. It raises bounded Normal Chat effort, strengthens grounding guidance, and may broaden context or web source budgets when useful, but only within the selected **Provider Model** limits. It does not guarantee web search for every turn and does not start retired background research mode.
_Avoid_: Deep mode, automatic research job

**Depth Metadata**:
The user-inspectable post-response metadata that records which **Depth Profile** was applied to a Normal Chat turn and why at a compact level, including whether higher-depth deliberation was constrained or degraded. It helps users and operators understand effort tradeoffs without exposing private model reasoning.
_Avoid_: chain-of-thought, debug dump, hidden prompt

**Depth Outcome**:
The compact result category for a **Reasoning Depth** decision, distinguishing completed high-cost work from a **Depth Clarification Turn**, constrained deliberation, or ordinary standard response. It prevents metadata, analytics, and user-facing audit details from treating a clarification as if expensive deliberation actually ran.
_Avoid_: fake Max completion, hidden analytics flag, pass result dump

**Thinking Trace**:
Provider-exposed or app-extracted reasoning text associated with an assistant response. It may be useful for audit and transparency when available, but it is not an authoritative explanation of the final answer and should remain secondary to the answer, sources, and structured metadata. The compact user-facing label for this trace is **Thought**. Completed Thought disclosures should stay focused on the trace itself rather than replaying tool calls or source activity.
_Avoid_: official rationale, proof, answer explanation

**Interim Thought Step**:
A short status-like sentence or phrase emitted while a response is still being prepared or reasoned through. It should be visually separated from neighboring interim steps while live, removed from the completed answer surface, and remain inspectable later through **Thought** when it was part of the persisted **Thinking Trace**.
_Avoid_: final answer sentence, activity event, progress estimate

**Depth Observability**:
Operational timing and outcome facts about **Automatic Depth Selection** and the resulting **Depth Profile**, such as classification latency, profile choice, and response-start timing. It supports tuning based on real traces rather than fixed product-timeout guesses.
_Avoid_: spinner budget, hardcoded timeout, private reasoning

**Reasoning Depth Evaluation Harness**:
A focused Normal Chat evaluation set that compares standard, extended, maximum, and high-cost clarification behavior on representative prompts for edge-case handling, source grounding, context awareness, format discipline, latency, cost, and wrong-target avoidance. It exists to prove higher depth earns its added response time rather than merely making answers slower or asking unnecessary clarifying questions.
_Avoid_: live demo, subjective vibe check evaluation, English-only benchmark

**Deliberation Status Line**:
A compact Normal Chat pending-response surface that shows one current high-level **Normal Chat Deliberation Pass** status above the inline **Thought** disclosure while higher **Depth Profiles** are running. It is driven by real pass/tool/context work, changes status with a smooth transition, and disappears from the main answer surface after completion.
_Avoid_: activity timeline, progress percentage, debug log, chain-of-thought viewer

**Deliberation Status Step**:
A high-level status phrase from a **Normal Chat Deliberation Pass**, such as reviewing context, checking sources, reviewing edge cases, or writing the answer. Completed status steps and compact human-readable tool milestones may appear inside the **Thought** disclosure at the point where they occurred, but raw tool inputs, JSON, source diagnostics, candidate lists, and verbose tool results should not become a completed UI surface.
_Avoid_: tool log row, source ledger, debug event, final answer sentence

**Response Audit Details**:
A user-requested post-response detail surface for inspecting compact response facts in the existing assistant-message info tooltip. It should stay visually minimal and may include **Depth Metadata**, model/provider, response time, token counts, and cost, while deliberation status steps and the persisted **Thinking Trace** remain available through the existing inline **Thought** disclosure.
_Avoid_: permanent status card, hidden transcript, explanation of correctness, second audit UI

**Model Capability**:
An admin-visible statement about which Normal Chat behaviors a configured model connection is expected to support, such as tools, streaming, structured output, reasoning controls, or usage reporting. A capability may be detected from a provider check or set by an admin override.
_Avoid_: provider guess, endpoint toggle, hidden compatibility flag

**Target Constructed Context**:
The configured target size for a Normal Chat turn's **Prompt Context** before final model-call overhead and response space.
_Avoid_: arbitrary evidence cap, fixed document limit, small-context mode

**Compaction Threshold**:
The configured point at which AlfyAI treats **Prompt Context** as large enough to show or record compaction pressure.
_Avoid_: hard evidence limit, maximum context, token warning

**Context Compression**:
An LLM-produced compact representation of selected context that would otherwise exceed the **Context Budget**.
_Avoid_: context selection, deterministic truncation, hidden omission

**Context Compression Snapshot**:
A reversible prompt snapshot used by future **Context Selection** to represent older or oversized selected context without deleting raw conversation, file, tool, or source records.
_Avoid_: memory replacement, message rewrite, deleted history

**Reserved Context Budget**:
The portion of **Context Budget** held for the current user message, system instructions, tool overhead, and response space.
_Avoid_: hidden budget, overhead

**Core Context Budget**:
The portion of **Context Budget** used for direct user-supplied or explicitly targeted context.
_Avoid_: essential budget, unlimited budget

**Support Context Budget**:
The portion of **Context Budget** used for relevant supporting context such as excerpts, recent turns, summaries, and retrieved evidence.
_Avoid_: extra context, filler

**Awareness Context Budget**:
The portion of **Context Budget** used for compact **Reference Context** about weaker but plausible items.
_Avoid_: metadata budget, weak context dump

**Context Trace**:
A structured operational diagnostic record of what became **Prompt Context** and why.
_Avoid_: debug log, chain of thought, hidden reasoning

**Context Diagnostics Debug**:
An explicit runtime setting that enables verbose context, retrieval, attachment, and TEI diagnostics beyond the compact **Context Trace**.
_Avoid_: trace on/off, noisy mode

**Context Limitation**:
A user-facing disclosure that an answer is based on partial or selected **Prompt Context**.
_Avoid_: error, apology, debug note

**Context Clarification**:
A user-facing question asked only when AlfyAI cannot choose usable **Prompt Context** automatically.
_Avoid_: context setup, retrieval prompt, settings question

**Context Selection Debt**:
Obsolete or duplicated context-selection behavior left behind after a newer **Context Selection** path replaces it.
_Avoid_: old code, junk, legacy stuff

**Context Selection Slice**:
An independently testable and verifiable increment that improves **Context Selection** behavior.
_Avoid_: phase, batch refactor, cleanup later

**Production Slice**:
A slice that is complete enough to operate reliably in production rather than only demonstrate a prototype path.
_Avoid_: demo slice, spike, partial path

**Composer Command Slice**:
A production slice that implements a coherent part of the **Composer Command Registry** or **Skill** system while keeping unfinished behavior hidden behind a feature flag.
_Avoid_: demo command, half-enabled skill path, prototype UI

**Composer Command V1**:
The complete production-ready first release of the **Composer Command Registry**, **Skills**, **Skill Sessions**, **Linked Context Sources**, **Skill Notes**, and AI-created **Skill Drafts**.
_Avoid_: demo prototype, prompt shortcut experiment, partial command palette

**Project Folder**:
A user-managed grouping of conversations that names the project the user intends those conversations to belong to.
_Avoid_: UI project, folder, memory project

**Sidebar Pin**:
A user-owned sidebar preference that visually promotes a **Conversation** without changing prompt context, project membership, or memory authority.
_Avoid_: context pin, favorite, priority memory

**Sidebar Order**:
The user-owned visual order of **Project Folders** and **Sidebar-Pinned Conversations** in the sidebar.
_Avoid_: activity order, memory priority, conversation rank

**Project Continuity**:
AlfyAI's long-term memory about an ongoing project across related tasks and conversations.
_Avoid_: memory project, project folder, task bucket

**Project Continuity Candidate**:
A possible link between a conversation or task and **Project Continuity** that AlfyAI has noticed but should not yet treat as confirmed project context. It may become **Project Continuity** after an explicit user signal or enough supporting evidence.
_Avoid_: confirmed project, automatic project assignment, prompt authority

**Project Folder Awareness**:
Compact awareness of other conversations that belong to the same **Project Folder**.
_Avoid_: folder dump, all project chats, sibling transcript context

**Project Continuity Awareness**:
Compact background awareness of other conversations or tasks linked to confirmed inferred **Project Continuity**. It may help AlfyAI orient a response, but it is not part of the user-facing **Knowledge Memory Overview** and should not be created from a weak one-off **Project Continuity Candidate**.
_Avoid_: global chat search, folder awareness, all memory, Memory Profile item

**Conversation Summary**:
A compact durable description of what happened in one conversation.
_Avoid_: task checkpoint, transcript, chat title

**Conversation Fork**:
A new conversation that preserves a source conversation up to a chosen assistant response and then continues independently.
_Avoid_: inline branch, alternate message, retry, regeneration

**Fork Boundary Marker**:
A compact persisted cue in a **Conversation Fork** that separates inherited snapshot history from new fork-local work.
_Avoid_: system message, copied-message badge, branch tree node, plain divider

**Fork Origin Marker**:
A compact persisted cue on a source assistant response showing that one or more **Conversation Forks** start there.
_Avoid_: boundary marker, fake message, inline branch, plain divider

**Conversation Fork Indicator**:
A compact conversation-list cue that identifies a conversation as a **Conversation Fork**.
_Avoid_: project icon, status badge, nested branch, full origin panel

**Composer Command Registry**:
The Normal Chat command surface that discovers and runs composer-triggered actions from typed prefixes.
_Avoid_: prompt shortcut list, agent tool registry command system

**Command Suggestion Row**:
The shared composer UI row used to discover and select **Skills** or **Composer Commands** while the user types a command prefix.
_Avoid_: autocomplete text, prompt template menu, separate skill browser

**Command Tray**:
The composer-attached surface that contains **Command Suggestion Rows** while the user is selecting a `$` skill or `/` command.
_Avoid_: modal palette, detached dropdown, full command center

**Skill**:
An explicitly activated guided behavior that can shape a Normal Chat turn or short interaction.
_Avoid_: Langflow tool, system prompt, slash command, agent mode

**System Skill**:
A **Skill** managed by an administrator and available to eligible users, often through an admin-maintained **Skill Pack**.
_Avoid_: built-in prompt, hardcoded skill, Langflow tool

**User Skill**:
A **Skill** owned by an individual user for their own Normal Chat use. It may be standalone user-authored guidance or a **Skill Variant** that customizes a **Skill Pack**.
_Avoid_: private command, personal prompt snippet, user tool

**Skill Pack**:
Admin-maintained reusable base skill guidance, potentially backed by internal resources for high-quality system or admin-managed skills.
_Avoid_: copied prompt template, marketplace package, plugin install

**Skill Variant**:
A user-owned overlay on a **Skill Pack** that customizes the pack for that user's Normal Chat use without copying the pack's base instructions.
_Avoid_: cloned skill, forked system skill, private copy

**Skill Draft**:
A proposed **Skill** definition created by a user or by AlfyAI that is not active in the `$` skill list until the owning user saves it.
_Avoid_: installed skill, hidden prompt, temporary chat instruction

**Skill Definition**:
The saved editable configuration for a **Skill**, including its display information, instructions, visibility, run policy, note behavior, source scope, ownership, enabled state, and version.
_Avoid_: executable plugin, Langflow node, raw system prompt

**Skill Activation Hint**:
Optional activation-facing guidance that helps AlfyAI decide when a **Skill** should be suggested or selected without exposing the full skill instructions.
_Avoid_: hidden instruction, classifier prompt, ranking keyword

**Skill Activation Profile**:
The durable activation-facing metadata on a **Skill Definition** that tells AlfyAI when assisted activation is eligible, when it should prefer no skill, how to break overlaps with other skills, and what user-facing reason to show.
_Avoid_: full skill instructions, hidden router prompt, hardcoded resolver rule

**Skill Draft Card**:
A compact assistant-message card that presents an AlfyAI-proposed **Skill Draft** and lets the user review, save, dismiss, or publish it if they are an admin.
_Avoid_: installed skill row, hidden suggestion, tool output

**Skills Settings Surface**:
The user settings area where users create, edit, enable, disable, and delete their own **User Skills**, and where admins may also manage **System Skills**.
_Avoid_: hidden admin config, command tray editor, Langflow flow manager

**Skill Session**:
An active **Skill** run whose state remains visible and controllable while it affects one or more Normal Chat turns.
_Avoid_: hidden mode, background agent job

**Skill Session Panel**:
The composer-adjacent UI surface that shows the current active **Skill Session**, expected next action, note target, and finish or dismiss controls.
_Avoid_: transcript log, settings editor, hidden mode banner

**Pending Skill Chip**:
A compact composer chip showing a one-turn **Skill** selected for the next Normal Chat message.
_Avoid_: active session panel, transcript marker, command text

**Skill Suggestion Chip**:
A compact composer suggestion shown when **Assisted Skill Activation** has enough confidence to offer a **Skill** but not enough confidence to select it for the next turn.
_Avoid_: hidden auto-selection, active session panel, durable session state

**Linked Source Chip**:
A compact composer chip showing a **Linked Context Source** selected for upcoming Normal Chat context.
_Avoid_: upload attachment, evidence row, document tab

**Document Picker Modal**:
A modal or mobile sheet for selecting one or more existing **Library Documents** to become **Linked Context Sources**.
_Avoid_: upload manager, document preview modal, inline tray submode

**Linked Sources Popover**:
A compact composer-adjacent surface for inspecting, removing, clearing, or adding currently selected **Linked Context Sources**.
_Avoid_: full Knowledge Library modal, evidence manager, document preview

**Setting State Chip**:
A compact composer chip showing a temporary non-default composer setting that affects the next turn.
_Avoid_: permanent preference display, settings form, hidden flag

**Skill Session Milestone**:
A sparse durable chat-history marker for important **Skill Session** events, such as started, note updated, or finished.
_Avoid_: activity spam, internal state dump, debug event

**Skill Question**:
A normal assistant message that asks the user for the next answer required by a question-capable **Skill Session**.
_Avoid_: separate question tool, form-only prompt, hidden app prompt

**Skill Control Envelope**:
A structured assistant-output control block that AlfyAI validates, strips from visible text, and uses to update **Skill Session** state.
_Avoid_: visible answer text, prose guessing, Langflow tool output

**Skill Run Policy**:
The configured runtime behavior for a **Skill**, including whether it completes after one turn, stays active across turns, writes notes, or asks user-facing questions.
_Avoid_: hardcoded skill type, prompt flag, UI exception

**Skill Duration Policy**:
The part of a **Skill Run Policy** that decides whether the **Skill** applies only to the next message, stays active until the user turns it off, or stays active until the **Skill** reaches a clear finish point.
_Avoid_: session type, persistence flag, mode name

**Skill Question Policy**:
The part of a **Skill Run Policy** that decides whether the **Skill** may ask user-facing follow-up questions before continuing.
_Avoid_: interview mode, clarification hack, assistant pause flag

**Skill Notes Policy**:
The part of a **Skill Run Policy** that decides whether the **Skill** may create or update notes, and whether note changes need user approval.
_Avoid_: filesystem permission, memory write flag, hidden scratchpad

**Skill Source Scope**:
The part of a **Skill Definition** that limits what source material a **Skill** may intentionally use, such as no extra sources, selected sources only, current conversation context, or Knowledge Library search.
_Avoid_: retrieval bypass, hidden context access, tool permission

**Skill Note**:
A living AI-created Markdown working document that a note-capable **Skill** may create or update during Normal Chat.
_Avoid_: uploaded document, generated-document version, hidden memory, scratchpad

**Skill Note Checkpoint**:
A bounded internal recovery record of a previous **Skill Note** state.
_Avoid_: visible document version, library duplicate, generated document revision

**Skill Note Operation**:
A validated bounded write requested by a **Skill Control Envelope** to create, replace, or append to a **Skill Note**.
_Avoid_: arbitrary file write, raw filesystem edit, document patch script

**Structured Skill Note**:
A **Skill Note** that follows app-owned Markdown section conventions for readability and future export.
_Avoid_: rigid database schema, arbitrary transcript dump, hidden memory object

**Composer Command**:
An immediate app-side composer action, such as changing a Normal Chat setting, attaching a document, linking a Library Document, or opening an upload flow.
_Avoid_: skill, tool call, hidden prompt, chat macro

**Linked Context Source**:
A user-selected existing source, such as a **Library Document**, that should be considered for upcoming Normal Chat turns without being re-uploaded as an attachment.
_Avoid_: uploaded attachment, file copy, hidden retrieval hint

### Relationships

- **Available Context** is broader than **Prompt Context**.
- **Prompt Context** is selected per **Normal Chat** turn.
- **Context Selection** starts a **Normal Chat Turn** by choosing **Prompt Context** from **Available Context**.
- **Normal Chat Model Run** happens after **Context Selection** and before **Normal Chat Turn Completion**.
- **Normal Chat Model Run** owns model/provider attempts, tool-call lifecycle, configured failover, provider usage extraction, and run diagnostics; it does not select **Prompt Context** or define durable completion.
- **Langflow Model Run** was the Langflow-specific form of **Normal Chat Model Run** and has been retired without changing the surrounding Normal Chat domain boundaries.
- **Normal Chat Turn Completion** ends a **Normal Chat Turn** by turning assistant output into durable conversation state and response-facing **Context Sources**.
- Transport surfaces may expose the result of **Normal Chat Turn Completion**, but they should not redefine what completion means.
- The **AI SDK UI Stream Contract** exposes streaming, replay, waiting, completion, and error transport parts for **Normal Chat**, but it does not own durable turn completion.
- The **AI SDK UI Stream Contract** does not own upstream model attempts or failover; it only exposes browser-facing parts after server-side stream orchestration.
- **AI SDK UI Stream Contract** part names and payload shapes should change only at the shared stream/framing boundary with protocol tests.
- The **Normal Chat Client Turn Runtime** sits above `streamChat`: it reacts to decoded stream callbacks, but it does not parse raw AI SDK UI stream lines or define protocol grammar.
- The **Normal Chat Client Turn Runtime** applies server-returned metadata through chat-page adapters; it does not build **Context Sources** or decide **Normal Chat Turn Completion**.
- The chat page owns visible Svelte state, route lifecycle, document workspace state, and UI commands; the **Normal Chat Client Turn Runtime** owns browser-side turn transitions and queue recovery rules.
- The **Token Display Buffer** sits inside the **Normal Chat Client Turn Runtime** between `onToken`/`onThinking` callbacks and page-adapter `appendTokenChunk`/`appendThinkingChunk` calls; it batches text to reduce reactive pressure, not to change content.
- The **Render Coalescing Cadence** sits inside `MarkdownRenderer.svelte`, downstream of the **Token Display Buffer**; the buffer controls when text reaches reactive state, the cadence controls when that state is re-parsed and painted.
- The **Word Reveal Animation** is applied after each coalesced render via `wrapNewWords()`; it depends on the **Render Coalescing Cadence** to ensure each batch contains enough words for a perceivable fade.
- The **Token Display Buffer** must flush synchronously on stream end, stop, and error; the **Render Coalescing Cadence** must allow one final render with **Word Reveal Animation** when streaming transitions to finished.
- The **Composer Command Registry** has separate **Skill** and **Composer Command** namespaces.
- The **Composer Command Registry** and **Skill** work should ship in **Composer Command Slices** behind a feature flag until the v1 surface is coherent.
- The **Composer Command Registry** feature flag should be runtime admin-configurable and default off until the v1 surface is coherent.
- Recommended **Composer Command Slices** are existing slash settings, linked context sources, skill definitions and settings, durable skill sessions, skill control envelopes and question-led sessions, Skill Notes, and AI Skill Draft Cards.
- **Composer Command V1** should include complete desktop and mobile command selection, command mixing, the agreed slash catalog, Linked Context Source persistence, User and System Skill management, one-turn skills, durable multi-turn Skill Sessions, Skill Control Envelope handling, question-led skills, living Skill Notes, AI Skill Draft Cards, and focused regression coverage.
- The `$` prefix opens **Skills** in the **Composer Command Registry**.
- The `/` prefix opens **Composer Commands** in the **Composer Command Registry**.
- `$` and `/` discovery should use the same **Command Suggestion Row** surface and keyboard behavior.
- **Command Suggestion Rows** may render namespace-specific details, such as skill ownership and policy indicators for `$`, or current command values for `/`.
- **Command Suggestion Rows** appear inside the **Command Tray**.
- The **Command Tray** should cap visible suggestions to a small ranked set rather than rendering an unbounded skill or command list.
- Network-backed **Command Tray** search should debounce user input and keep keyboard selection stable while results update.
- The **Command Tray** should be visually attached to the composer and appear to slide upward from behind it.
- The **Command Tray** should use a darker elevated surface, approximately 90% of the composer width, so it reads as a layered card behind the composer rather than a separate modal.
- The **Command Tray** should animate in from the first interaction with a smooth upward slide and fade.
- The **Command Tray** should animate out with the corresponding slide and fade rather than disappearing abruptly.
- When the **Command Tray** is open, Enter should select the highlighted **Command Suggestion Row** instead of sending the current message.
- Message send on Enter resumes only after the **Command Tray** closes or no command selection is active.
- During IME or text composition, keyboard actions should not select command rows or send messages.
- Shift+Enter should insert a newline even when the **Command Tray** is open.
- Arrow key tray navigation should not interfere with active text composition.
- The **Command Tray** should expose accessible combobox or listbox-style semantics with clear active-row announcements.
- **Document Picker Modal**, **Linked Sources Popover**, and mobile sheets should trap and restore focus appropriately.
- Chips should provide specific accessible remove labels.
- Command and skill animations should respect reduced-motion preferences.
- App-side command, source, skill, and note errors should surface locally near the tray, picker, chip, session panel, or settings editor that caused them, not as ordinary assistant text.
- The **Command Tray** may show locally known commands and already-loaded skills during network issues, but network-backed actions such as document picking, skill saving, and session state changes should fail locally with retry affordances.
- Offline or failed network states should not block ordinary message typing or sending unless the user selected command-derived state that requires validation.
- On mobile, the **Command Tray** should render as a bottom sheet rather than a compressed desktop tray.
- The mobile **Command Tray** should use touch-friendly rows, capped height, outside-tap or swipe dismissal, and a clear connection to the composer.
- Accent color should highlight active command states, selected rows, and confirmed selections without making the whole tray visually loud.
- `$` **Command Suggestion Rows** should show skill name, a one-line description, ownership, duration behavior, question capability, and note capability.
- `$` **Command Suggestion Rows** should not show full skill instructions; full instructions belong in the skill editor or details view.
- A focused `$` row should use a slightly lighter dark surface plus restrained accent treatment, such as a thin border or left rail.
- `/` **Command Suggestion Rows** should be shorter direct-action rows that show command name, direct effect, and current state where relevant.
- `/` command current state should appear for values such as current model, style, **Reasoning Depth** mode, or linked-source count.
- `/` rows may use familiar action icons when they improve scanning.
- A **Composer Command** should mutate explicit app state, attach or link context, or open a user-visible flow rather than paste hidden instructions into the message.
- Command prefix text should be consumed only after the user explicitly selects a **Skill** or **Composer Command**.
- If a user sends text containing `$` or `/` without selecting a **Command Suggestion Row**, AlfyAI should treat that text as ordinary user message content.
- Selecting a **Skill** or **Composer Command** should preserve non-command message text already typed around the command.
- Users may combine one pending or active **Skill**, multiple **Linked Context Sources**, uploaded attachments, and composer setting commands in one Normal Chat turn.
- While a Normal Chat response is streaming, new command-derived composer state should apply only to the next queued turn, not the in-flight assistant response.
- A queued turn should capture the **Reasoning Depth** selected when it is queued rather than using whatever composer setting is active when the queued turn later sends.
- Starting a durable **Skill Session** while streaming should start with the queued turn that carries that skill, not mutate the response currently being generated.
- If a queued turn already exists, changing command-derived state should require editing or replacing that queued turn rather than silently stacking another queued payload.
- V1 should allow only one pending or active **Skill** at a time; selecting another **Skill** should require replacing, finishing, or dismissing the current one.
- Command prefixes are discovery triggers, not a strict command language.
- `$` and `/` should open the **Command Tray** only for an active cursor token at the start of the composer or after whitespace.
- A command token query continues until whitespace.
- The **Command Tray** should follow the command token at the cursor rather than the first command-looking text in the composer.
- Prefix-like text inside URLs, prices, paths, or ordinary prose should remain literal unless it satisfies the active command-token rule.
- Escape should dismiss the **Command Tray** for the current command token until that token changes.
- Pasting ordinary text should not automatically open the **Command Tray**.
- Pasting text that exactly matches an enabled **Skill** or **Composer Command** may open the **Command Tray** with the exact match highlighted, but paste alone should not execute the command.
- Exact pasted command matches should use restrained accent text highlighting rather than a loud visual state.
- Users should not need to know exact command arguments, such as a document name, before selecting a **Composer Command**.
- After a **Skill** or **Composer Command** is selected, AlfyAI should convert it into structured composer state, remove only the selected command token, preserve the remaining text, and allow remaining command prefixes to be selected in any order.
- Removing a selected command token should perform only local whitespace cleanup, not natural-language rewriting of the remaining message text.
- After command-token cleanup, the cursor should stay near the removed token rather than jumping to the end of the composer.
- When a command opens a modal or picker, focus should return to the composer near the removed token after that flow closes.
- When a selected `/document` token includes a typed query, that query may initialize the **Document Picker Modal** search and be removed with the selected command token.
- Unsent command-derived composer state should restore across navigation or refresh when it is part of the pending next turn, including pending one-turn skills and **Linked Source Chips**.
- Transient UI state such as an open **Command Tray**, highlighted row, open **Document Picker Modal**, or open **Linked Sources Popover** should not restore.
- `/clear` should clear pending composer state such as textarea content, pending one-turn skill selection, linked-source chips, pending upload attachments, and command tray state.
- `/clear` should not dismiss a durable active **Skill Session** unless the user explicitly chooses that additional action.
- `/clear` should confirm when it would remove attachments, linked sources, or a pending skill.
- `/clear` should remove the selected command token only after confirmation when it would clear meaningful pending state; cancelling should leave the composer unchanged.
- A **Skill** may shape the next Normal Chat behavior, but it is not a Langflow tool and should not be treated as a deleted research subsystem mode.
- A **Skill** may be a **System Skill** or a **User Skill**.
- **System Skills** and **User Skills** share the same activation surface, but ownership controls who can edit, publish, disable, or delete them.
- A **Skill Pack** is the admin-maintained base for reusable skill guidance, including system-quality guidance and any internal resources managed with it.
- A **Skill Variant** stores only user-owned overlay guidance and references the current **Skill Pack** rather than copying or pinning its base instructions.
- Admin updates to a **Skill Pack** silently update the base guidance used by future direct pack activations and future **Skill Variant** activations.
- The **Skills Settings Surface** should keep **Skill Variant** editing overlay-only; admin pack content and resources are managed separately.
- Users may hide **System Skills** from their own `$` discovery without disabling them system-wide.
- Hidden **System Skills** should remain restorable from the **Skills Settings Surface**.
- Users should not edit shared **System Skill** definitions unless they are an admin.
- A pending **Skill** selection should be blocked at send if the **Skill** was disabled, hidden, deleted, or otherwise made unavailable before submission.
- An active **Skill Session** should pause or end visibly if its underlying **Skill** becomes unavailable, rather than continuing with stale hidden instructions.
- A **Skill Draft** may become a **User Skill** when the owning user saves it.
- A **Skill Draft** may become a **System Skill** only when an administrator publishes it system-wide.
- AlfyAI may create a **Skill Draft**, but it should not silently save, enable, or publish a **Skill**.
- AlfyAI-proposed **Skill Drafts** should appear as **Skill Draft Cards** attached to assistant messages.
- A **Skill Draft Card** should show proposed name, description, run-policy summary, notes behavior, source scope, and review/save/dismiss actions.
- A **Skill Draft Card** should offer system-wide publish actions only to admins.
- V1 **Skill Drafts** attached to chat should live in assistant-message metadata until saved, not a separate drafts table.
- AlfyAI may prefill **Skill Draft** policy fields, but ambiguous drafts should default to next-message duration, no questions, no notes, and selected-sources-only source scope.
- **Skill Draft** review should visibly call out broader capabilities such as note writing or Knowledge Library search before save.
- V1 AI-created **Skill Drafts** are app-side draft proposals, not Langflow tool side effects.
- V1 should not expose a model-facing Langflow `create_skill` tool.
- A v1 **Skill Definition** should be declarative configuration, not executable code or an arbitrary plugin surface.
- A v1 **Skill Definition** should include display name, description, instructions, activation examples, a **Skill Activation Profile**, visibility, ownership, enabled state, duration policy, question policy, notes policy, source scope, creation source, version, and update timestamp.
- **Assisted Skill Activation** should classify from activation-facing metadata such as display name, description, activation examples, run policy, and optional **Skill Activation Hints**, not from full skill instructions by default.
- A **Skill Activation Profile** should be first-class durable metadata, not a resolver-local hardcoded list or documentation-only convention.
- A **Skill Activation Profile** should include assisted-activation eligibility, positive signals, negative signals, the material-improvement rule, overlap tie-breakers, and a short user-facing reason template.
- System **Skill Packs** should ship curated **Skill Activation Profiles**; **User Skills** and **Skill Variants** may own or override activation-facing profile fields without exposing or copying admin-managed pack instructions.
- V1 should not include generic skill sharing, copying, duplicating, import, package install, remote marketplace, or plugin-style export flows.
- Users may create new **User Skills** manually, and v1 may support deliberate personalization of admin-maintained **Skill Packs** through **Skill Variants** instead of clone, copy, or forked personalized-system-skill workflows.
- V1 should ship a small initial **System Skill** set rather than a large catalog.
- Initial **System Skills** should include Interview, Grill With Docs, Code Review, and Writing Coach.
- Built-in **System Skills** exist to prove the framework and provide useful defaults; users and admins should still be able to create personalized skills.
- Spreadsheet-oriented **Skill Packs** should preserve quality, style, and domain guidance while routing file creation through AlfyAI **File Production Requests** and durable **File Production Cards**.
- Built-in **System Skill** display names, descriptions, and default instructions should support English and Hungarian where practical.
- **User Skills** should remain in the user-authored language rather than being automatically translated.
- AI-created **Skill Drafts** should default to the current UI or chat language unless the user asks otherwise.
- **User Skills** should be managed from the **Skills Settings Surface** under the user's settings/profile area.
- Admin users may manage **System Skills** from the same **Skills Settings Surface** with system-wide publishing controls.
- Admins manage **System Skills** and global skill settings, but v1 should not expose private **User Skill** instructions, bodies, or **Skill Note** content to admins.
- Future admin-safe surfaces may expose aggregate **User Skill** or **Skill Note** metadata and counts, but not private content by default.
- `/skill` and `$` discovery may provide shortcuts to create or manage skills, but editing belongs in the **Skills Settings Surface**.
- Normal users may save personalized **User Skills** that only they see.
- Admin users may save personalized **User Skills** and may also publish **System Skills** for eligible users.
- Empty `$` discovery should show pinned, recent, or recommended skills first, then **User Skills**, then remaining **System Skills**.
- Typed `$` discovery should rank skill name matches before activation-example matches, and activation-example matches before description matches.
- `$` discovery should cap visible tray results for performance and scanning.
- When match quality is equal, **User Skills** should rank above **System Skills**.
- **Skill** display names do not need to be globally unique.
- Duplicate **Skill** display names should be disambiguated with ownership labels such as User or System.
- Saving or publishing a **Skill** with a duplicate display name should warn but not block the user.
- Disabled **Skills** and unsaved **Skill Drafts** should not appear in `$` discovery.
- Multi-turn behavior belongs to a **Skill Run Policy**, not to hardcoded skill names.
- A **Skill Run Policy** should be configured through plain behavior controls rather than exposed as confusing implementation-oriented preset names.
- A **Skill Run Policy** may combine duration, question behavior, and note permissions instead of treating those as mutually exclusive skill types.
- A **Skill Duration Policy**, **Skill Question Policy**, and **Skill Notes Policy** are independent controls in the skill editor.
- A **Skill Source Scope** should guard what source material a **Skill** may intentionally request or rely on, while **Context Selection** remains responsible for actual **Prompt Context**.
- V1 **Skill Source Scope** options should include no extra sources, selected sources only, current conversation context, and Knowledge Library search.
- User-created **Skills** should default to selected sources only.
- A note-capable **Skill** may create or update a **Skill Note** when its **Skill Notes Policy** allows notes.
- A **Skill Note** is a living document with one current visible state rather than a visible **Generated Document Version** chain.
- Updating a **Skill Note** should update the current note in place instead of creating another Library Document or generated-document revision.
- **Skill Note Checkpoints** may exist for bounded recovery or audit, but they should not appear as separate **Library Documents** or **Working Documents**.
- A **Skill Note** is AI-created working material; it does not allow AlfyAI to silently edit a user-uploaded **Library Document**.
- V1 **Skill Note Operations** are limited to creating a note, replacing a note body, or appending a dated or session-scoped note entry.
- A **Skill Note Operation** should never expose raw filesystem paths or allow arbitrary file writes.
- Replacing a **Skill Note** body should create a bounded **Skill Note Checkpoint** before the current body changes.
- A failed **Skill Note Operation** should not partially mutate the **Skill Note**.
- If assistant text succeeds but a **Skill Note Operation** fails, the **Skill Session Panel** should surface the note failure while preserving the assistant response.
- **Skill Notes** should be visible and reusable in the Knowledge Library under a distinct source or category.
- A **Skill Note** created in the current **Skill Session** may be an active **Context Source** for that session.
- After its originating **Skill Session** ends, a **Skill Note** should return to low-authority **Available Context** by default.
- Because **Skill Notes** often duplicate chat decisions, they should not become **Prompt Context** in other conversations without explicit selection, a strong source-continuity signal, or a strong retrieval hit.
- A **Skill Note** should record its origin conversation and originating **Skill Session**.
- A **Skill Note** should use a distinct living-note artifact type rather than `generated_output`, because it should not enter generated-document version-family behavior.
- App-side skills such as Grill With Docs should write **Skill Notes**, not real repository files, uploaded **Library Documents**, or arbitrary filesystem paths.
- Built-in note-writing skills may use **Structured Skill Notes** with predictable Markdown sections such as resolved decisions, open questions, terms, deferred ideas, and ADR candidates.
- If an open or linked **Skill Note** is updated by a **Skill Note Operation**, AlfyAI should refresh the current note in place and keep existing links pointed at the updated note.
- **Skill Note** updates should show quiet provenance such as an updated timestamp or skill source rather than disruptive notifications for every append.
- A **Skill Note** may be globally visible in the Knowledge Library while retaining conversation-scoped context authority by default.
- Reusing a **Skill Note** in another conversation should require explicit selection, such as linking it as a **Linked Context Source**.
- An active **Skill Session** may use the **Skill Notes** it created during that session.
- Restarting the same **Skill** in the same conversation may use prior same-conversation **Skill Notes** as low-authority reference context.
- A **Skill** should not receive blanket high-authority access to all **Skill Notes** it created across other conversations.
- Activating a **Skill** should add structured Normal Chat turn context rather than rewriting or prefixing the user's message text.
- **Assisted Skill Activation** may affect the current turn only when the selected **Skill** is visible and reversible; it should not silently start a durable **Skill Session**.
- **Assisted Skill Activation** should prefer no skill unless the selected **Skill** would materially improve the answer beyond ordinary **Normal Chat**.
- Product lookup, web search, or source retrieval alone should not trigger **Assisted Skill Activation** unless the user's task also matches a skill's workflow intent.
- High-confidence **Assisted Skill Activation** may automatically set a visible removable **Pending Skill Chip** before the user submits the message.
- Medium-confidence **Assisted Skill Activation** should show a **Skill Suggestion Chip** with use, details, and dismiss actions instead of selecting the skill.
- **Assisted Skill Activation** should not silently add a **Skill** to a turn after the user has submitted that turn; late activation results may only suggest a **Skill** for a future turn.
- The user-visible transcript should preserve what the user wrote, not the command syntax or hidden skill instructions.
- Skill instructions, **Skill Session** state, and relevant **Skill Notes** should enter **Prompt Context** through the chat-turn assembly path.
- **Skills** should act as process guidance, while **Linked Context Sources** and attachments provide source or task material.
- A **Skill** should not override the current user message, explicit user instructions, or document facts.
- **Skill** instructions are user-authored process guidance and should be lower priority than system, developer, app policy, current user instructions, and source facts.
- **Skill** instructions cannot grant tool access, filesystem access, source access, or note-write authority beyond the validated **Skill Definition** policy and server-side checks.
- A `/` command that selects an existing **Library Document** should create a **Linked Context Source**, not a new upload.
- A **Linked Context Source** is a structured source-selection signal for **Context Selection** and may appear as a compact composer chip distinct from uploaded attachments.
- If the same source is both a current-turn upload attachment and a **Linked Context Source**, the attachment should win and the linked source should be deduplicated.
- The composer and chat-turn preflight should avoid double-counting the same source family as both attachment and linked source.
- Before message submission, a **Linked Context Source** selected by `/document` is pending composer state.
- After message submission, selected **Linked Context Sources** should become active conversation **Context Sources** until removed, a clear topic shift demotes them, or another existing context-source lifecycle rule applies.
- Pending **Linked Context Sources** should be validated during chat-turn preflight.
- If a pending **Linked Context Source** is deleted or inaccessible before send, AlfyAI should block the send, identify the invalid source, and let the user remove it rather than silently ignoring it.
- The v1 composer **Composer Command** catalog includes `/model`, `/style`, `/depth`, `/attach`, `/document`, `/source`, `/skill`, `/settings`, and `/clear`.
- `/document` may add one or more **Linked Context Sources** in one flow.
- Repeated `/document` selections should merge linked-source chips instead of replacing earlier selected sources.
- `/document` should open a **Document Picker Modal** rather than keep multi-document selection inside the **Command Tray**.
- The **Document Picker Modal** should reuse the Knowledge Library document-list language and scanning behavior while hiding management actions such as delete, download, and upload.
- The **Document Picker Modal** should support multi-select and add selected documents as **Linked Source Chips**.
- The **Document Picker Modal** should enforce a configurable selected-document cap for UI and performance predictability.
- The **Document Picker Modal** should support pagination or server-aware search for large Knowledge Libraries and preserve selection across pages or searches.
- Server-backed **Document Picker Modal** search should debounce input and keep already selected sources selected across query changes.
- The **Document Picker Modal** should include uploaded **Library Documents**, current or active **Generated Documents**, and **Skill Notes**.
- Historical **Generated Document Versions** should be hidden by default in the **Document Picker Modal** and available only through an explicit historical filter.
- Raw **Generated Files** that are not document-like should not appear in the **Document Picker Modal** by default.
- Selecting many documents does not guarantee full-body **Prompt Context** for every source; **Context Selection** should preserve breadth before depth and disclose limitations when needed.
- `/source` should open a compact **Linked Sources Popover** for currently selected **Linked Context Sources**.
- The **Linked Sources Popover** should list linked sources with title, type, and remove controls, plus simple add-document and clear-all actions.
- The **Linked Sources Popover** should stay visually close to existing composer UI and remain compact.
- `$` should be the fast path for directly activating enabled **Skills**.
- `/skill` should act as a skill command hub with actions such as pick skill, create skill, manage skills, and stop active skill when applicable.
- `/skill` pick behavior should reuse `$` skill discovery rather than introduce a second skill picker implementation.
- **Reasoning Depth** and **Depth Profiles** stay inside **Normal Chat**. They may increase Normal Chat effort, but they must not create a separate background job lifecycle.
- A **Skill Session** should be visible to the user while it can affect submitted messages.
- V1 allows at most one active **Skill Session** per conversation composer.
- Starting another **Skill Session** while one is active should require replacing, finishing, or dismissing the current session rather than stacking skill instructions.
- Multi-turn **Skill Sessions** should be durable and scoped to a conversation.
- A **Skill Session** should snapshot its effective **Skill** instructions, policies, source scope, display name, and version when the session starts, including current **Skill Pack** base guidance plus **Skill Variant** overlay guidance when applicable.
- Editing a **Skill Definition**, **Skill Pack**, or **Skill Variant** should affect future sessions, not already-running **Skill Sessions**, unless the user explicitly restarts or updates the session.
- Skill-definition snapshots are backend continuity records and should not add visible UI clutter by default.
- Durable v1 storage should distinguish saved **Skill Definitions**, per-user skill preferences, conversation-scoped **Skill Sessions**, sparse **Skill Session Milestones**, living **Skill Notes**, and bounded **Skill Note Checkpoints**.
- **Skill Session Milestones** should be persisted as separate skill-session event rows, not synthetic user or assistant messages.
- **Skill Session Milestones** may be rendered alongside chat history when useful, but they should not be treated as chat turns.
- A pending one-turn **Skill** selection may remain composer-draft state until the user submits the next message.
- A completed or dismissed **Skill Session** may remain available as lightweight history, but it should not appear as an active composer mode.
- **Skill Notes** remain durable after their originating **Skill Session** ends.
- The **Skill Session Panel** should own active controls for a running **Skill Session**.
- A **Pending Skill Chip** should represent a one-turn **Skill** selected before message submission.
- A **Skill Suggestion Chip** should never start a **Skill Session** or affect **Prompt Context** until the user accepts it or the system promotes it to a visible removable **Pending Skill Chip** before submission.
- **Linked Source Chips** should represent composer-selected **Linked Context Sources** and remain visually distinct from upload attachment chips.
- **Setting State Chips** should appear only for temporary non-default composer choices that affect the next turn.
- Pending chips should sit inside the composer flow between the textarea and action controls so they read as part of the next message payload.
- The desktop **Skill Session Panel** should use a compact dark surface with an accent rail, skill name, status, next action, note link when present, and finish or dismiss controls.
- On mobile, an active **Skill Session Panel** should default to a collapsed single-row bar above the composer with status and a tap target to expand into a bottom sheet.
- Mobile **Skill Session Panel** content should avoid pushing the composer and latest messages off-screen.
- `/model`, `/style`, and `/depth` should update the same current composer settings used by the existing composer tools, including **Reasoning Depth**, not create a separate one-turn override system.
- `/thinking` should be removed when `/depth` replaces the old Thinking control.
- **Reasoning Depth** should be represented consistently across composer state, request payloads, draft restoration, stream/runtime metadata, and post-response metadata rather than kept under the old thinking-mode contract.
- **Reasoning Depth** starts as local composer state rather than a persisted user preference.
- Landing-to-chat handoff should preserve selected **Reasoning Depth** for the first submitted turn.
- Retrying a turn should preserve explicit **Reasoning Depth** such as Off or Max. If the original turn used Auto, retry may run **Automatic Depth Selection** again.
- When an existing composer control already visibly reflects a setting command result, a **Setting State Chip** is not required.
- **Skill Session Milestones** may appear in chat history for durable orientation, but ordinary internal session-state changes should not create noisy transcript entries.
- A question-capable **Skill Session** should ask through normal assistant messages marked as **Skill Questions**, not through a separate question transport.
- A **Skill Question** should remain part of the user-visible transcript.
- If a question-capable **Skill** asks multiple questions despite its policy, v1 should not rewrite or block the assistant message; the **Skill Session** should remain in a conservative awaiting-user state.
- A **Skill Control Envelope** should update **Skill Session** state such as active, awaiting user, finished, and note operations.
- A **Skill Control Envelope** should be stripped from visible assistant text before persistence and display.
- **Skill Control Envelope** operations should be idempotent by session turn and operation ID so stream retries, reconnects, or finalization retries do not duplicate note writes or status transitions.
- If a user stops a streaming response before a complete valid **Skill Control Envelope** is finalized, AlfyAI should not apply partial note operations or finish the **Skill Session**.
- Stopping a skill-guided response should leave the **Skill Session** active in a conservative state unless a complete idempotent operation already committed.
- If a **Skill Control Envelope** is missing or invalid, AlfyAI should keep the **Skill Session** in a conservative active state rather than guessing from prose.
- This **Composer Command Registry** v1 is scoped to **Normal Chat** and does not change the retired research job lifecycle.
- **Context Sources** is the carried-forward pool; the chat-surface **Sources** disclosure shows it read-only (what informed an answer), while steering it (pin or exclude) happens in the Knowledge library and working-document workspace, not on the chat surface.
- Pinning or excluding a **Context Source** is scoped to the current conversation or task by default and is managed where the user works with documents, not inline in chat.
- Global source preference is a separate future concept and should not be implied by ordinary pinning.
- **Context Sources** may summarize or group sources for a cleaner UI, but it should preserve enough detail for users to understand which important sources are being carried forward.
- **Context Sources** is conversation-level and compact.
- **Context Sources** should subtly indicate when active sources were compacted, reduced, or omitted because of budget pressure.
- A **Reduced** Context Sources state means at least one active source was downgraded, truncated, or omitted from **Prompt Context** because of **Context Budget** pressure.
- A large **Knowledge Library**, inferred memory group, or duplicate source-management row should not by itself make **Context Sources** appear reduced.
- A false **Reduced** state is **Context Selection Debt** and should be corrected independently of broader source-planning upgrades.
- **Message Evidence** is message-level and may stay attached to each assistant response.
- **Context Sources** should show the broader carried-forward pool, while **Message Evidence** shows what supported a specific answer.
- **Context Sources** should avoid unbounded lists by grouping, summarizing, or collapsing lower-priority sources.
- **Context Sources** should separate active sources from inferred available sources.
- Active **Context Sources** include current attachments, pinned sources (managed in the working-document workspace), open or current documents, current generated documents, and strong task sources.
- In a new chat, the **Knowledge Library** is **Available Context**, not active **Context Sources**, unless the user explicitly asks for library material or retrieval finds a strong relevant hit.
- A strong Knowledge Library retrieval hit may support the current answer as **Message Evidence** without automatically becoming an active **Context Source**.
- A retrieved Library Document should become an active **Context Source** only when the user follows up on it as the working subject, opens it, pins it, or otherwise gives a strong source-continuity signal.
- **Context Source** lifecycle is: **Available Context** may become a candidate, a candidate may become **Message Evidence**, and **Message Evidence** becomes an active **Context Source** only after a strong continuity signal.
- Existing Knowledge Library material starts as **Available Context**, not active **Context Sources**.
- Memory may appear in **Context Sources** as a compact separate group.
- Memory display should summarize source type or role rather than exposing long memory internals.
- Inferred available sources may be grouped or collapsed with counts and representative names.
- Active **Context Sources** should persist across turns until a clear topic shift, user reset, user exclusion, or task boundary change.
- Retrieval may resize and reprioritize active **Context Sources** each turn, but retrieval should not be the only memory of which sources define the conversation.
- Clear topic shifts may demote active **Context Sources** into inferred available sources.
- User reset or exclusion is stronger than topic-shift decay and may remove sources from the active pool.
- Smart decay or compaction may use a local control model when intelligence is useful.
- Local-model decay or compaction should avoid slowing ordinary response generation; prefer cached, bounded, asynchronous, or fallback-safe decisions.
- Smart decay is async-first and should usually run after a turn or during idle maintenance.
- **Context Compression** should run on demand when selected **Prompt Context** does not fit the model-window-aware **Context Budget**, not as routine background work after every turn.
- During a chat turn, use deterministic fast rules unless a high-impact decision requires a short-timeout local-model check.
- **Context Selection** remains responsible for choosing candidate **Prompt Context**; **Context Compression** handles selected context that cannot fit the model-window-aware **Context Budget** without losing the user's working intent.
- Deterministic overflow handling should enforce hard safety boundaries, but it should not be the primary production behavior for silently dropping or slicing useful selected context.
- **Context Compression** should use the user's selected response model in v1; a separate admin-configured compressor model would weaken the user's model preference without enough product value.
- **Context Compression Snapshots** change prompt assembly defaults only; they must not rewrite, delete, or replace raw chat messages, files, tool outputs, Message Evidence, or source records.
- In v1, **Context Compression Snapshots** may be consumed only by Normal Chat prompt assembly, Context Sources status/markers, and operational metadata that records compression occurred.
- In v1, **Context Compression Snapshots** must not feed Honcho mirroring, durable memory extraction, Message Evidence, source audit, file-production source material, tool-call replay, exact retry/regenerate reconstruction, search indexing, or conversation export.
- **Context Compression Snapshots** are conversation-owned records and must be linked to the raw messages, source ranges, and source groups they summarize.
- Deleting a conversation must delete its **Context Compression Snapshots**.
- Editing or deleting a message that predates or participates in a **Context Compression Snapshot** must delete that snapshot through the same mutation boundary that handles normal chat-turn storage cleanup.
- **Context Compression Snapshots** should not survive as orphaned database rows after their owning conversation or covered source history changes.
- Invalid **Context Compression Snapshots** should be hard-deleted in v1 rather than retained as invalidated audit records.
- When selected context is too large for the selected model to compress in one pass, **Context Compression** should use hierarchical source-aware compression with bounded chunks and a final merge pass.
- Hierarchical **Context Compression** should chunk by natural source boundaries such as message pairs, tool call/result pairs, document sections, web-source excerpts, and log sections rather than arbitrary token slicing whenever possible.
- Hierarchical **Context Compression** must preserve causal order for user/assistant turns and tool call/result pairs.
- Active or in-flight tool calls are not eligible for **Context Compression**.
- Completed tool outputs from older turns may be included in **Context Compression Snapshots** as structured tool state.
- The just-finished tool result for the current turn should remain raw selected context for that turn.
- Large completed tool outputs such as raw JSON, logs, or page text should be summarized in **Context Compression Snapshots** with source coverage and limitations rather than replayed in full.
- A **Context Compression Snapshot** should be structured rather than a single prose blob.
- A **Context Compression Snapshot** should preserve the current goal, active decisions, open questions, user preferences relevant to the conversation, working artifacts, summarized tool state, source coverage, and known limitations.
- Model-facing prompt assembly may render a **Context Compression Snapshot** as readable text, but storage should keep enough structure for audit, status display, and regression tests.
- A **Context Compression Snapshot** must pass deterministic validation before it becomes **Prompt Context**.
- **Context Compression Snapshot** validation should verify schema, token budget fit, source coverage, tool call/result coverage, absence of raw oversized blobs, and absence of internal reasoning tags.
- If **Context Compression** validation fails, AlfyAI may retry compression once with stricter instructions before falling back to deterministic safety trimming plus a visible **Context Limitation**.
- Memory remains supporting context even for large-context models.
- Memory should stay compact and summary-oriented rather than expanding into long history dumps by default.
- **Protected Context** is not unlimited context.
- **Protected Context** may be downgraded to a smaller **Context Inclusion Level** when needed to fit the **Context Budget**.
- The current user message is reserved rather than merely protected.
- A direct attachment or explicitly targeted document may become **Protected Context**.
- Passive workspace state alone does not create **Protected Context**.
- **Context Selection** is the source of truth for promoting **Available Context** into **Prompt Context**.
- **Context Selection** considers conversation, memory, attachment, workspace, task, generated-file, generated-document, and retrieval signals together.
- `src/lib/server/services/chat-turn/context-selection.ts` is the **Normal Chat Context Selection Boundary** for constructed Prompt Context.
- `src/lib/server/services/honcho.ts` supplies Honcho session/persona candidates through a narrow adapter seam and must not own prompt budget policy, Knowledge retrieval, Task-State selection, linked-source assembly, or Working Document Selection.
- `src/lib/server/services/normal-chat-context.ts` may request constructed Prompt Context from the chat-turn boundary and may add model-facing runtime guidance, but it should not rebuild candidate promotion or inclusion policy.
- Individual subsystems may supply **Available Context** and **Context Signals**, but should not independently force large text into **Prompt Context**.
- **Memory Access** should extend Honcho-led memory rather than replace it with a parallel local persona-memory system.
- Honcho should not be treated as a raw transcript mirror; ordinary chat history belongs to conversation history unless the **Memory Intake Gate** admits durable remembered context.
- **Memory Access** may make historic chat details available for retrieval, but historic chats become **Prompt Context** only through **Context Selection** or an explicit model-facing retrieval result.
- A **Memory Context Tool** should consolidate project, persona, and history retrieval so model-facing memory access does not fragment into overlapping tools.
- Replacing a project-only memory retrieval tool with the **Memory Context Tool** should remove the old model-facing tool rather than keep overlapping compatibility surfaces.
- **Memory Access** sizing should scale with the configured model and runtime capacity; small fixed counts are operational guardrails, not the product definition of what AlfyAI can remember.
- A **Memory Context Tool** should preserve breadth with lightweight summaries before spending large budget on deep conversation or memory detail.
- A **Memory Context Tool** may retrieve historical chats and documents that are not active **Memory Profile Items** when answering source, history, document, or evidence questions.
- A **Memory Context Tool** should not use historical retrieval to bypass deleted, suppressed, expired, blocked, or review-needed **Memory Profile** state for ordinary personalization.
- **Projection-Gated Memory Access** should block raw Honcho memory from entering ordinary personalization directly while still allowing relevant Honcho-backed query-time retrieval.
- **Projection-Gated Memory Access** should distinguish active personalization from historical or source recall so useful memory retrieval is preserved without treating every retrieved fact as current user truth.
- Ordinary personalization should use **Pre-Filtered Prompt Memory** so the model receives active usable memory rather than inactive memory plus instructions to ignore it.
- Deleted, suppressed, expired, conflict-blocked, review-needed, **Preserved Legacy Memory**, and ambiguous-scope material should not appear in ordinary **Active Memory Profile Context** at all.
- Explicit history, source, document, or evidence recall may retrieve non-active material only as historical or source evidence, not as current profile truth.
- **Historical Memory Evidence** may include inactive, expired, **Preserved Legacy Memory**, or ambiguous-scope material for explicit history, source, document, or evidence questions.
- **Historical Memory Evidence** should not include user-deleted or user-suppressed **Memory Profile Items** as remembered context; exact source-record retrieval may still find original chats or documents if those source records still exist.
- Conflict-blocked or review-needed memory should appear as **Historical Memory Evidence** only when the user asks about the conflict, source history, or what AlfyAI previously had recorded; it should be framed as unresolved rather than current profile truth.
- **Historical Memory Evidence** should be compact: short excerpt or summary, source kind, source title or date when available, evidence framing, and enough provenance to cite or inspect.
- **Historical Memory Evidence** framing should distinguish historical-only material, source-record evidence, and unresolved conflict evidence.
- **Historical Memory Evidence** should not expose full inactive profile tables, confidence/debug scores, raw Honcho conclusion dumps, or deletion/suppression internals.
- When **Memory Access** omits matching memories or historical context because of a limit, the result should disclose the applied limit and omitted count.
- Historic chat recall through a **Memory Context Tool** should start from existing conversation summaries and bounded message search before adding new persistent memory structures.
- A **Baseline Memory Profile** should come from Honcho-led synthesis rather than a newest-N raw conclusion list.
- A **Baseline Memory Profile** should apply the active **Memory Profile Projection** so user-visible edits, deletions, suppressions, expiries, and review blocks are respected in the next chat turn.
- Deeper persona recall belongs in the **Memory Context Tool**, while the **Baseline Memory Profile** gives every normal chat turn enough personalization to start well.
- The Knowledge Base should render a **Memory Profile Projection** instead of raw Honcho prose.
- Opening the **Knowledge Base** from navigation should default to **Memory Profile**, not restore **Documents** as the last selected tab.
- The default **Memory Profile** should be the **Active Memory Profile View**.
- Normal categories in the **Active Memory Profile View** should show only currently active usable **Memory Profile Items**.
- Deferred, blocked, expired, suppressed, deleted, and review-needed memory should not appear as ordinary items inside normal **Memory Profile Categories**.
- The **Memory Profile** should not need explanatory feature copy such as "used by chat"; its purpose should be clear from the profile structure and actions.
- Opening the **Knowledge Base** should refresh the **Memory Profile Projection** automatically; the primary Memory Profile surface should not require or expose a generic manual reload control.
- The default **Memory Profile Projection** view should be made of approachable **Memory Profile Items**, not raw extracted memory records or source provenance lists.
- The **Memory Profile** should not expose a general inactive/history tab or browsable list of deleted, suppressed, expired, superseded, or inactive memories.
- Raw durable-memory tables, extracted-round lists, salience/debug columns, and Honcho conclusion IDs should not appear in user or admin UI.
- The Knowledge Base **Memory Profile** should not show Focus Continuity, task memory, inferred work continuity, or backend continuity buckets as memory sections.
- Backend continuity may remain useful for chat, folders, projects, and routing, but it should not appear as a Knowledge Base memory-management surface.
- User-facing ongoing work belongs in the **Goals & Ongoing Work Memory Category** only when it is explicit user-shared profile context, not inferred backend continuity.
- Account-level memory and knowledge reset should continue to use **Clear Memory and Knowledge** in **Privacy and Data Controls**; the **Memory Rework Update** should not add a duplicate reset action to the Memory Profile.
- **Clear Memory and Knowledge** should clear new **Memory Rework Update** state, including Memory Profile projection metadata, review items, conflict blocks, intake dirty state, maintenance state, and user-linked telemetry.
- **Clear Memory and Knowledge** should advance the account's **Memory Reset Generation** so old memory maintenance and retry work cannot write pre-reset state after the reset.
- **Memory Profile Projection**, **Memory Dirty State Ledger**, **Memory Review Items**, conflict blocks, and maintenance slices should be scoped to the current **Memory Reset Generation**.
- **Clear Memory and Knowledge** may leave non-identifying aggregate **Memory Rework Telemetry** counters only when they cannot identify the user or reconstruct remembered content.
- **Clear Memory and Knowledge** should continue to reset Honcho-backed memory in a way that prevents old Honcho state from reappearing after the reset.
- Active, inactive, corrected, suppressed, expired, and review status in the **Memory Profile Projection** may come from app-owned profile metadata layered over Honcho-led memory.
- **Memory Profile Categories** should be limited to a small set of meaningfully distinct groups so users can understand the profile at a glance.
- The primary **Memory Profile Categories** are **About You Memory Category**, **Preferences Memory Category**, **Goals & Ongoing Work Memory Category**, and **Constraints & Boundaries Memory Category**.
- Review state, freshness, correction state, and recent activity should not become primary **Memory Profile Categories**.
- Recently updated items should appear within their normal **Memory Profile Category** rather than in a separate recently-updated section.
- Confidence, freshness, provenance, and cleanup status should stay out of the default **Memory Profile Item** view unless the user needs to act on them.
- **Memory Provenance Detail** should be available on demand for inspection, but should not be required to understand or edit the Memory Profile.
- **Memory Source Authority** should be available in **Memory Provenance Detail** or an item detail surface, not as a default badge or label on ordinary Memory Profile cards.
- Users should edit the curated **Memory Profile Item** that AlfyAI actively uses, not individual raw extraction records.
- A **Memory Profile Edit Surface** should remain curated and human-readable; edit and detail views should not fall back to raw memory tables, Honcho dumps, markdown blobs, or extracted-round lists.
- **Memory Profile Correction** should be offered only when AlfyAI can support a full direct edit of the remembered statement and make that edit effective for the next chat turn.
- **Memory Edit Classification** should classify direct edits by normalized memory slot: category, scope, subject, predicate, and authority relationship.
- **Memory Edit Classification** should keep the same **Memory Profile Item Identity** for same-slot corrections, but create replacement or split work when the edited statement is a different memory slot.
- Ambiguous **Memory Edit Classification** outcomes should ask for plain confirmation in the edit surface rather than silently rewriting or duplicating profile memory.
- Durable delete or replace work after a **Memory Profile Correction** should require a **Safe Memory Match**.
- If a **Memory Profile Item** cannot be fully edited with next-turn effect, the default UI should not show an edit action for that item.
- Users should have one clear **Memory Profile Deletion** action for unwanted **Memory Profile Items**, not a technical choice between deletion and suppression.
- Durable delete work after a **Memory Profile Deletion** should require a **Safe Memory Match**; ambiguous backing evidence should stay untouched until safer reconciliation is possible.
- The **Memory Profile Projection** should keep stable item identity and active-use state across **Knowledge Base** refreshes and chat turns; rebuilding only from live Honcho output is not sufficient for next-turn-effective corrections, deletions, suppressions, expiries, conflict blocks, and review decisions.
- **Memory Profile Item Identity** should be app-owned and stable across Honcho rewording, merges, splits, edits, deletions, suppressions, expiries, conflict blocks, and review decisions.
- Honcho conclusion IDs may be stored as provenance pointers for reconciliation, but they should not be the primary **Memory Profile Item Identity**.
- A **Memory Profile Item** should be able to aggregate multiple **Memory Profile Provenance Links** when they clearly support the same remembered fact.
- A **Memory Profile Item** should not be a one-to-one wrapper around a Honcho conclusion, source chat, document rule, or extracted memory row.
- Automatic aggregation of **Memory Profile Provenance Links** should be conservative; ambiguous near-duplicates should remain separate, expire from active use, or become **Guided Memory Review** rather than be merged by guesswork.
- **User-Authored Merge Precedence** should choose the user-authored item as the merge survivor when it is merged with lower-authority Honcho-derived or structured memory.
- **User-Authored Merge Precedence** should prevent deleted, suppressed, corrected-away, or review-resolved item state from being lost during later maintenance merges.
- If two merge candidates both contain conflicting user-authored state, maintenance should create or keep **Guided Memory Review** rather than auto-merge them.
- A **Memory Profile Split** should happen only when one item clearly contains multiple **Memory Slots**.
- A **Memory Profile Split** may happen automatically for Honcho-derived items when the child slots are clearly separable and non-conflicting.
- A **Memory Profile Split** should not silently change active truth when the parent item has user-authored edit, deletion, suppression, or review state; it should preserve the parent state or use **Guided Memory Review**.
- Child items from a **Memory Profile Split** should inherit only relevant **Memory Profile Provenance Links**, not every link from the parent.
- Deleted or suppressed parent state should prevent maintenance from creating active child items from the same evidence unless new explicit user-authored evidence exists.
- **Legacy Memory Migration** should preserve potentially valuable legacy memory while keeping uncertain, noisy, conflicting, or out-of-taxonomy material out of active personalization by default.
- **Legacy Memory Migration** should make only high-confidence, non-junk, category- and scope-fitting legacy material active in the **Memory Profile Projection**.
- Legacy material with unknown or ambiguous **Memory Scope** should not become active by default; it should become **Preserved Legacy Memory** or **Guided Memory Review** depending on user impact.
- **Legacy Memory Migration** should use the **Adaptive Active Memory Budget** instead of a fixed product item count for deciding how much legacy material can remain active.
- **Legacy Memory Migration** should keep valuable but uncertain legacy material available for future reconciliation or capped **Guided Memory Review** rather than deleting it merely because it is not active.
- **Preserved Legacy Memory** should not appear in the default **Memory Profile**, should not enter **Active Memory Profile Context**, and should not be used for ordinary personalization.
- **Preserved Legacy Memory** may be used by bounded maintenance for future merge, supersession, expiry, review, or deletion decisions, and by explicit history or source questions without becoming a hidden personalization bypass.
- **Preserved Legacy Memory** should be revisited through **Legacy Reconciliation Triggers**, not by trying to process the full preserved backlog merely because it exists.
- **Projection-Gated Memory Access** should allow explicit history, source, and evidence questions to retrieve preserved or historical memory without letting that material become ordinary active personalization.
- **Legacy Reconciliation Triggers** may include related profile edits or deletions, new same-topic memory, detected conflicts, stale **Memory Profile** refreshes, or spare scheduled maintenance capacity.
- A **Memory Profile Projection** may support user review and maintenance of remembered facts; prompt inclusion still flows through Honcho-led memory, **Active Memory Profile Context**, **Baseline Memory Profile**, **Memory Context Tool**, and **Context Selection**.
- **Active Memory Profile Context** should use the same active usable item set shown in the normal categories of the **Active Memory Profile View**.
- **Active Memory Profile Context** should be pre-filtered by the server before prompt assembly; the model should not be asked to decide which inactive profile facts are safe to use for ordinary personalization.
- The **Adaptive Active Memory Budget** should size active memory primarily by context pressure and relevance rather than a fixed number of visible **Memory Profile Items**.
- When active memory exceeds the **Adaptive Active Memory Budget**, AlfyAI should prefer merge or compaction first, active-use expiry second, and moving lower-priority material into **Preserved Legacy Memory** third rather than silently injecting everything into chat.
- User-authored corrections, hard constraints, and high-confidence scope-relevant memories should outrank softer, lower-confidence, or globally over-applied preferences when memory pressure is high.
- Category balance should guide active-memory pressure, but **Constraints & Boundaries Memory Category** may exceed its normal category target when those items are durable hard constraints.
- Internal operational safety caps may exist, but they should not become the user-facing product definition of how much AlfyAI can remember.
- **Adaptive Active Memory Budget** pressure should remain internal maintenance and telemetry state; the default **Memory Profile** should not show a profile-pressure warning, memory quota, or other technical capacity indicator.
- Ordinary chat personalization should not use hidden profile facts that are absent from the active default **Memory Profile** because they are deferred, blocked, expired, suppressed, deleted, or review-needed.
- Chat should not use raw Honcho context in a way that contradicts the next-turn-effective **Memory Profile Projection**.
- Ordinary chat personalization should use **Projection-Gated Memory Access** rather than receiving unfiltered Honcho peer or session context as current profile truth.
- If memory retrieval finds relevant but inactive historical, preserved, deleted, suppressed, expired, conflict-blocked, or review-needed material, AlfyAI should either use it only as explicit source/history evidence or route it to maintenance/review; it should not silently personalize from it.
- **Memory Profile Correction** and **Memory Profile Suppression** should take immediate precedence in the **Memory Profile Projection**.
- **Memory Profile Correction** and **Memory Profile Suppression** should be effective for the next chat turn even if Honcho still returns older remembered facts.
- **Memory Profile Deletion** should be effective for the next chat turn even when deeper durable cleanup must continue after the user action.
- **Memory Profile Deletion** and **Memory Profile Suppression** should remove the item from memory recall as well as ordinary personalization.
- **Memory Profile Deletion** should not imply deletion of source chats, documents, account data, or workspace data.
- The immediate correction/suppression path should stay narrow and user-authored; it should not grow into app-owned persona synthesis, semantic clustering, dreaming, or a replacement for Honcho.
- When a corrected, deleted, or suppressed memory has a **Safe Memory Match**, maintenance may reconcile it with the memory authority by deleting or replacing the matched remembered evidence.
- When provenance is partial or ambiguous, maintenance should not mutate uncertain backing memory; the user-facing correction, deletion, or suppression remains authoritative for active personalization until safer reconciliation is possible.
- **Memory Active-Use Expiry** should make stale remembered facts inactive for the **Memory Profile Projection**, **Baseline Memory Profile**, and active personalization without automatically deleting their historical evidence.
- **Memory Active-Use Expiry** should be conservative and evidence-based, not a simple timer.
- **Memory Active-Use Expiry** should apply when newer user statements clearly supersede older facts, time-bound facts have passed, contradictions require review, stale facts would cause bad personalization, or the user edits or deletes related profile items.
- Stable remembered facts such as names, long-term preferences, durable writing style, important boundaries, and durable personal context should not expire merely because they are old.
- Expired memory may re-enter active use after fresh evidence, explicit user confirmation, or safe reconciliation with a newer remembered fact.
- Same-scope contradictory memories should not both enter **Active Memory Profile Context**.
- A **Memory Conflict Block** should keep unresolved same-scope contradictions out of ordinary prompt personalization until maintenance resolves them or asks the user.
- **Memory Conflict Block** state should surface through the **Memory Needs Review Area** when user action is needed, not as blocked items inside normal **Memory Profile Categories**.
- The model should not be responsible for choosing between contradictory memories at answer time.
- Memory maintenance may permanently delete remembered evidence automatically only through the **Automatic Junk Deletion Gate**.
- The **Memory Intake Gate** should decide what new material may enter durable memory before broader maintenance tries to clean it later.
- The **Memory Intake Gate** should write accepted durable memory through the existing memory authority path after a structured admit decision, not by creating a separate long-lived pending-candidate store.
- A **Memory Intake Decision** should have exactly three outcomes: admit, reject, or defer to maintenance.
- A deferred **Memory Intake Decision** should create privacy-preserving telemetry and dirty-state signaling only, not a raw candidate backlog.
- **Immediate Memory Admission** should require explicit durable language or strong explicit phrasing for preferences, constraints, goals, project rules, and document rules.
- Stable user-authored self-statements may use **Immediate Memory Admission** without memory verbs when they are clearly about the user and not document-derived or assistant-inferred.
- **Assistant Prose Memory Exclusion** should keep ordinary assistant-generated answer text out of **Immediate Memory Admission**.
- App-owned structured outputs, such as work capsules or typed tool outcomes, may become memory only through typed, scoped, provenance-aware paths rather than raw assistant prose mirroring.
- **User-Authored Memory Precedence** should make explicit user-authored memory, corrections, deletions, and durable statements outrank conflicting assistant-generated prose or app-authored structured memory.
- When **User-Authored Memory Precedence** applies, active personalization should use the user-authored memory immediately while maintenance reconciles older durable records later.
- An admitted **Memory Intake Decision** should pass through **Memory Intake Normalization** so durable memory receives a clean statement with category, scope, reason, and provenance rather than a raw user sentence or assistant response.
- **Memory Scope** should be first-class and separate from **Memory Profile Category**.
- **Memory Scope** should determine where a remembered fact may be used; **Memory Profile Category** should determine how it is grouped for user understanding and maintenance.
- **Memory Scope** should use a small fixed set: global, project, conversation, and document.
- **Memory Scope** assignment should use the narrowest confident scope.
- Global **Memory Scope** should be used only when the remembered fact is clearly user-wide.
- Project-scoped memory should attach to the **Project Folder** when present, otherwise to confirmed **Project Continuity**.
- **Memory Scope** should not introduce free-form client, team, topic, or arbitrary entity scopes without telemetry proving the fixed set is insufficient.
- **Document-Sourced Context** should not become user-truth or Memory Profile material merely because the user uploaded, attached, opened, or worked with a document.
- **Document-Scoped Memory** should be reserved for facts about a specific document or document family, such as how to edit, interpret, revise, or reuse it.
- Arbitrary document contents, including tax papers, receipts, third-party PDFs, sample documents, and unrelated reference files, should remain document evidence unless explicit user-authored intent promotes a fact into memory.
- Uploaded document contents should not sync directly into Honcho persona or session memory by default.
- Document-related memory should enter durable memory only when the **Memory Intake Gate** explicitly admits it.
- **Document Memory Admission** should immediately admit document-related memory only from explicit user-authored intent.
- Immediate **Document Memory Admission** should require clear durable language such as "remember," "always," "from now on," or "for this document family."
- Repeated document workflow behavior should create telemetry and may defer to maintenance or **Guided Memory Review**, but should not silently become admitted durable memory.
- Explicit user-authored memory intent may come from ordinary chat language or dedicated **Memory Profile** and **Guided Memory Review** actions, but not from adding **Main Chat Memory Controls**.
- The normal chat interface should not add memory-specific save, toggle, edit, or review controls as part of the **Memory Rework Update**.
- **Memory Intake Normalization** should choose one primary **Memory Profile Category** instead of duplicating the same remembered fact across categories.
- **Memory Intake Normalization** should defer to maintenance when it cannot confidently preserve meaning, assign category, or assign scope.
- **Memory Decision Confidence Bands** should be coarse bootstrap defaults for automatic memory decisions, not precise truth scores.
- **Memory Decision Confidence Bands** should never override **Memory Source Authority**, user-authored corrections, deletions, suppressions, or resolved **Memory Review Items**.
- Memory should remain one pipeline: immediate authoritative continuity or profile actions may take effect right away, while expensive reconciliation runs later without becoming a second source of truth.
- Opening the **Knowledge Base** or Memory Profile should run **Memory Profile Refresh**, not synchronous **Expensive Memory Reconciliation**.
- **Memory Profile Refresh** may enqueue background maintenance when the projection is stale or dirty, but the visible profile should render from the current durable projection without waiting for LLM pruning, deduplication, Honcho cleanup, or Honcho Dreaming.
- **Memory Authority Fallback** should keep the current durable **Memory Profile Projection** as the user-facing active truth when Honcho refresh, delete, or reconciliation fails.
- If **Memory Profile Refresh** cannot read the durable projection, the UI should show an ordinary load failure or retry state rather than falling back to raw Honcho output.
- User-authored edits, deletions, suppressions, and review decisions should update the **Memory Profile Projection** immediately and then enqueue targeted **Expensive Memory Reconciliation**.
- User-authored edits, deletions, suppressions, and review decisions should advance the relevant **Memory Projection Revision** with the visible projection change.
- If the visible **Memory Profile Projection** change is saved, the user action should succeed locally even when Honcho cleanup fails; the failed cleanup should become retryable dirty work and **Memory Rework Telemetry**.
- If the visible **Memory Profile Projection** change cannot be saved, the user action should fail visibly rather than pretending memory changed.
- Concurrent user actions against the same **Memory Profile Item** should be guarded by **Memory Projection Revision** rather than silently overwriting newer profile state.
- Chat turns may mark memory dirty and may perform **Immediate Memory Admission** for high-confidence material, but they should not trigger full **Expensive Memory Reconciliation** by default.
- **Expensive Memory Reconciliation** should be driven by a durable **Memory Dirty State Ledger**, not only periodic full scans or in-memory cooldown state.
- **Memory Dirty State Ledger** entries should be typed, coalesced, and privacy-preserving; they may record reason, scope, stable identifiers, counts, and timestamps, but not raw candidate memory text.
- Deferred **Memory Intake Decisions** should write **Memory Dirty State Ledger** signals and telemetry rather than raw pending-memory candidates.
- Chat turns, **Memory Profile Refresh**, profile actions, legacy migration, and **Memory Authority Fallback** should produce typed **Memory Dirty State Ledger** work instead of directly running expensive reconciliation.
- The **Memory Maintenance Scheduler** should be the single path that claims expensive dirty work by user, priority, cooldown, and budget.
- Multiple active chats for the same user should coalesce into shared dirty work rather than independent reconciliation runs.
- Each **Expensive Memory Reconciliation** run should process a **Bounded Memory Reconciliation Slice** rather than trying to clear all dirty work for the user.
- Each **Bounded Memory Reconciliation Slice** should respect **Memory Slice Batch Limits** in addition to elapsed-time and LLM-token budgets.
- A **Bounded Memory Reconciliation Slice** should stop when any relevant time, token, candidate, projection-mutation, authority-call, review-item, or dreaming limit is reached.
- Legacy migration should use the same **Memory Maintenance Scheduler** and **Bounded Memory Reconciliation Slice** path as other expensive work rather than a special accelerated catch-up mode.
- **Bounded Memory Reconciliation Slices** should prioritize user-facing correctness, prompt safety, profile quality, legacy migration or preserved backlog, then opportunistic junk cleanup.
- If a **Bounded Memory Reconciliation Slice** exhausts its budget, remaining **Memory Dirty State Ledger** entries should stay pending for later scheduled work.
- **Expensive Memory Reconciliation** should apply projection changes only when the **Memory Projection Revision** still matches the state it read.
- Stale maintenance output should be discarded or retried against the current **Memory Projection Revision**, not applied over newer user-facing memory state.
- If maintenance crashes partway through a **Bounded Memory Reconciliation Slice**, uncommitted or unfinished dirty work should remain pending rather than be treated as complete.
- **Expensive Memory Reconciliation** should apply dirty work, projection writes, review-item writes, and Honcho reconciliation only for the current **Memory Reset Generation**.
- Maintenance work from an older **Memory Reset Generation** should discard its output and must not recreate profile, review, dirty, telemetry, or Honcho-derived memory state after **Clear Memory and Knowledge**.
- Background Honcho cleanup or reconciliation failures should be logged as retryable maintenance failures, not surfaced as user-facing action errors unless the visible projection save failed.
- Memory maintenance cooldowns should gate expensive cleanup, expiry, deduplication, review generation, and reconciliation; they should not delay active continuity writes or active continuity reads needed for project and folder work.
- **Memory Rework Telemetry** should be a required part of the memory design rather than a later observability add-on.
- **Memory Rework Telemetry** should cover intake accepts and rejects, maintenance actions, review-item creation and resolution, user corrections and deletions, and whether active memory was included or blocked from prompt context.
- **Memory Rework Telemetry** should use fixed **Memory Rework Telemetry Event Families** instead of free-form telemetry labels.
- **Memory Rework Telemetry** should be privacy-preserving by default: decisions, categories, reasons, counts, statuses, and stable identifiers are appropriate default telemetry, while raw remembered text and raw chat excerpts require a narrow explicit debug mode.
- User-linked **Memory Rework Telemetry** should be cleared by **Clear Memory and Knowledge**; anonymous aggregate counters may remain only if they cannot identify the user or reconstruct memory.
- **Memory Rework Telemetry** should remain backend/log-only by default; the **Memory Rework Update** should not add a user-facing or admin-facing telemetry summary view.
- A future focused admin telemetry summary may be added only after collected telemetry proves which metrics are useful.
- The **Automatic Junk Deletion Gate** should permit silent permanent cleanup for **Junk Memory** such as malformed residue, technical artifacts, boilerplate interaction summaries, or meaning-preserving duplicates.
- The **Automatic Junk Deletion Gate** should veto automatic permanent deletion for user-meaningful facts, preferences, boundaries, goals, identity facts, relationships, locations, jobs, deadlines, sensitive context, contradictions, merely old facts, user-authored corrections, and anything supporting an active **Memory Profile Item**.
- **Junk Memory** should be blocked or cleaned during both memory intake and background memory maintenance so trash does not accumulate again.
- Memory intake should block only obvious **Junk Memory** before it reaches the memory authority.
- Background memory maintenance may apply the **Automatic Junk Deletion Gate** more broadly because it can inspect duplicates, supersession, provenance, and active-profile support.
- Memory intake should not discard potentially meaningful remembered material merely because it is unusual, old, contradictory, or sensitive.
- **Memory Reconciliation** should run in the background after profile edits, deletions, cleanup, and larger memory batches; it should not be exposed as a primary **Memory Profile** status.
- The **Memory Profile Projection** should carry the next-turn-effective truth immediately while **Memory Reconciliation** catches the underlying memory substrate up over time.
- Memory maintenance should remain autonomous for high-confidence cleanup and supersession, but use **Guided Memory Review** when user judgment is needed to resolve ambiguous, sensitive, or user-impacting remembered facts.
- Persistent **Memory Review Items** should be created by memory maintenance, not by ad hoc chat-turn logic.
- **Memory Review Items** should be durable records rather than regenerated from current conflicts on every **Memory Profile Refresh**.
- **Memory Review Items** should dedupe by **Memory Review Subject**, not by raw Honcho conclusion ID, exact remembered text, or source chat.
- When maintenance finds more evidence for an existing open **Memory Review Subject**, it should attach that evidence to the existing **Memory Review Item** rather than create another question.
- A new **Memory Review Item** should be created only when the review type or **Memory Slot** meaningfully differs, or when no existing open item covers the issue.
- **Memory Review Resolution** should use a small shared action model: use this remembered fact, edit the remembered fact, or do not remember this subject.
- Review UI labels may vary by **Memory Review Item** type, but they should resolve to the shared **Memory Review Resolution** meanings.
- Guided review should not ask users to choose a keep-inactive, archive, source-delete, or technical reconciliation state.
- **Memory Review Item Lifecycle** should use open, resolved, and obsolete as the default states.
- Maintenance should mark a **Memory Review Item** obsolete when newer evidence, expiry, merge, deletion, suppression, or reconciliation removes the need to ask before the user sees or resolves it.
- Resolved **Memory Review Items** should record the user decision needed to update the **Memory Profile Projection** and guide later reconciliation without exposing raw memory rows.
- A **Memory Review Item** should ask a plain-language user question rather than expose raw memory records, source inventories, or technical reconciliation state.
- **Guided Memory Review** should be optional but discoverable in the **Memory Profile**, with a visible review signal when unresolved **Memory Review Items** exist.
- **Memory Review Burden** should be capped more aggressively than background maintenance throughput.
- Maintenance should create at most three new **Memory Review Items** per **Bounded Memory Reconciliation Slice** by default.
- A user should have at most twelve open **Memory Review Items** by default.
- When the open review cap is reached, additional ambiguous material should become inactive or **Preserved Legacy Memory** rather than more user-facing review work.
- Higher-impact review work may obsolete or replace lower-priority open **Memory Review Items**, but should not exceed the open review cap.
- Unresolved **Memory Review Items** should appear in a dedicated, full-width **Memory Needs Review Area** above normal **Memory Profile Categories** when items exist.
- The **Memory Needs Review Area** should be non-scrollable and show at most three **Memory Review Items**.
- Additional **Memory Review Items** should open in an extended modal view rather than expanding the main **Memory Profile**.
- **Memory Review Items** should not be mixed inline into normal **Memory Profile Categories**.
- **Memory Conflict Block** review work should appear in the **Memory Needs Review Area** rather than in normal **Memory Profile Categories**.
- A **Memory Review Signal** should appear on the **Memory Profile** entry point when unresolved review items exist, but should not become a separate inbox, settings-only surface, or global notification.
- Chat may ask a direct clarification when the current answer depends on unresolved remembered information, but the durable **Memory Review Item** creation path should still belong to memory maintenance.
- A **Baseline Memory Profile** is **Protected Context** but not unlimited; it should shrink under genuine budget pressure before it disappears.
- For a small trusted deployment with large-context models, **Baseline Memory Profile** defaults should be generous rather than cost-minimized.
- **Baseline Memory Profile** budget should derive from model-scaled context with a generous floor and configurable ceiling, rather than from a small fixed token cap.
- The **Memory Context Tool** should cover project, persona, and history retrieval; it should not become a universal document search replacement in the **Memory Rework Update**.
- The **Memory Rework Update** should make memory and document context reliable together; fixing memory retrieval while leaving Knowledge Library document selection dependent on exact filenames or manual `/document` selection is not a complete update.
- **Max Model Context** should be derived from provider/model metadata when available.
- Explicit admin **Max Model Context** values override derived provider/model defaults.
- For locally managed or frequently retuned models, configured admin model settings are the authority for **Max Model Context**; do not hardcode GPT-OSS or other local model context windows when the admin fields already carry that limit.
- Third-party API connections should use the context length configured in admin model settings.
- A third-party API connection without an explicit or confidently inferred context length is not fully configured for production use.
- This deployment assumes every usable model has a configured **Max Model Context**; v1 does not need a separate missing-limit user flow.
- The safety fallback for unknown model capacity is 150k tokens, and it should be treated as a conservative fallback rather than the model's real advertised capacity.
- Third-party API connections should require **Max Model Context** in admin model settings before they are considered fully configured.
- Third-party **Target Constructed Context** and **Compaction Threshold** may remain optional; when unset, they should derive from the configured **Max Model Context**.
- **Max Model Context** describes the total model window, while **Max Output Tokens** describes reserved response space.
- **Max Output Tokens** reduces usable prompt capacity but should not be treated as the model's context length.
- **Target Constructed Context** and **Compaction Threshold** are the primary product controls for prompt size.
- **Target Constructed Context** and **Compaction Threshold** should be automatically derived from the selected model's usable context capacity by default.
- A good default is **Target Constructed Context** at about 90% of usable context capacity and **Compaction Threshold** at about 80% of usable context capacity.
- Derived context-size defaults are model- and provider-specific and should update when the active model changes.
- Explicit admin values for **Target Constructed Context** and **Compaction Threshold** override derived defaults.
- When those settings are unset, AlfyAI should use the model-derived defaults.
- Fixed item-count limits should not override **Target Constructed Context** when the configured model has enough context capacity.
- Candidate and rerank limits should scale with the configured context capacity or runtime policy instead of acting as hidden hard caps.
- Candidate and rerank limits are performance safeguards, not the source of truth for how many sources may enter **Prompt Context**.
- **Context Selection** may batch, widen, or bypass reranking for clearly active sources when model capacity allows.
- Cost-saving behavior should be an explicit admin or runtime policy, not an accidental consequence of small fixed evidence limits.
- False **Reduced** state, third-party provider context configuration, and unknown-capacity fallback behavior are immediate correctness issues.
- Source lifecycle promotion and breadth-first depth allocation are V2 source-planning upgrades.
- Every promoted context item has a **Context Inclusion Level**.
- **Reference Context** preserves awareness without sending body content.
- **Excerpt Context** supports focused answers when only part of an item is relevant.
- **Task Context** is reserved for turns that require substantial document or workspace content.
- Active source status decides eligibility for **Prompt Context**; task intent decides **Context Inclusion Level** depth.
- Large-context models should not force full source text by default.
- Whole-document or near-full context is appropriate when the task requires it and the **Context Budget** allows it.
- Structured slices or task-focused excerpts should be preferred for ordinary summarization, comparison, and question-answering over large documents.
- When multiple active **Context Sources** compete for budget, **Context Selection** should preserve breadth before adding depth.
- Every active source should receive at least **Reference Context** or **Excerpt Context** when budget allows before one source receives substantially deeper context.
- Under budget pressure, active sources should lose depth before they are omitted entirely.
- **Omitted Context** remains **Available Context** and may be promoted in a later turn.
- An open workspace document is **Available Context**.
- An open workspace document creates a **Weak Context Signal**.
- A **Weak Context Signal** may combine with user wording or explicit selection to become a **Strong Context Signal**.
- A **Strong Context Signal** should be deterministic and source-identity-backed.
- LLMs and rerankers may rank candidates and judge relevance, but they should not independently promote a source into active carry-forward context.
- The TEI reranker may strengthen evidence ordering and source relevance when combined with deterministic source identity or continuity signals.
- A semantically strong Library Document match may enter one-turn **Prompt Context** and **Message Evidence** without exact filename wording or manual `/document` selection.
- A semantically strong one-turn Library Document match does not become an active carried-forward **Context Source** unless the user follows up, opens it, pins it, explicitly selects it, or gives another strong source-continuity signal.
- Cross-conversation Library Document eligibility should consider semantic and rerank confidence, not only lexical token overlap.
- Opening a Library Document creates a **Weak Context Signal** by default.
- Opening a Library Document becomes a **Strong Context Signal** only when paired with document-directed user wording, explicit selection, pinning, or another source-continuity action.
- Passive workspace state alone should not promote a document into **Prompt Context**.
- Uncertainty should usually reduce the **Context Inclusion Level** rather than block the user.
- A **Context Clarification** is reserved for cases where the answer would materially depend on choosing between ambiguous context items.
- Attaching an item in the current turn is the strongest **Context Signal**.
- Current-turn attachments should be treated as active **Context Sources**.
- Current-turn attachments should receive near-full **Prompt Context** when they fit within model-scaled **Target Constructed Context**.
- Current-turn attachments should degrade by document structure or meaningful chunks before falling back to tiny excerpts.
- After the turn, uploaded or attached documents should remain active **Context Sources** for the conversation or task until they decay, are excluded, or a boundary change removes them.
- Explicitly naming an item is stronger than relying on workspace state.
- Deictic wording such as "this" or "it" is a **Strong Context Signal** only when paired with a clear available target.
- Correction or refinement wording can promote the current work item into **Prompt Context**.
- Pinned or preferred task evidence is stronger than ordinary retrieval but still subject to the **Context Budget**.
- Semantic or lexical retrieval alone should usually promote no more than **Excerpt Context**.
- An open workspace item alone should only break ties or produce **Reference Context**.
- Recency alone should rarely promote more than **Reference Context**.
- Pinned or preferred evidence is strongly preferred but still budgeted.
- Pinned or preferred evidence may become **Protected Context** when relevant to the turn.
- Pinned or preferred evidence still has a **Context Inclusion Level**.
- Irrelevant pinned evidence should not receive full body content.
- When multiple items are relevant, AlfyAI should preserve breadth before depth.
- Breadth means using **Reference Context** for plausible relevant items before spending large budget on any one item.
- Depth means using **Excerpt Context** or **Task Context** for the strongest item or explicitly requested comparison set.
- For explicitly supplied or active source sets, breadth means giving every source meaningful content before giving very deep content to the strongest sources.
- Explicitly supplied or active source sets should not lose entire documents because of small fixed item-count limits when the model-scaled **Context Budget** has room.
- By default, only one primary item should receive **Task Context** in a turn.
- Multiple items may receive large context when the user explicitly asks to compare or jointly transform them.
- Attaching an item makes it explicitly relevant but does not override the **Context Budget**.
- Attached items should use model-scaled **Context Budget** before being reduced to **Excerpt Context**.
- Large attached items may receive **Excerpt Context** only when the model-scaled budget is genuinely pressured or the user asks a narrowly targeted question.
- Multiple attached items should preserve breadth unless the user explicitly asks for exhaustive joint analysis.
- Automatically selected Library Documents should use intent-based depth: weak matches receive **Reference Context**, strong answer-seeking matches receive meaningful **Excerpt Context**, and document-shaped tasks receive **Task Context** when budget allows.
- Direct attachments, `/document` selections, explicit document titles, and current workspace focus paired with document-directed wording should receive near-full or structured full content when they fit within the model-scaled **Context Budget**.
- **Context Limitation** should appear only when partial context materially affects trust in the answer.
- Routine answers should not narrate context-selection mechanics.
- High-impact judgments, exhaustive review requests, and whole-document claims require a **Context Limitation** when AlfyAI used only selected context.
- **Prompt Context** must fit inside the **Context Budget**.
- **Reserved Context Budget** is allocated before document, memory, or retrieval context.
- **Core Context Budget** is for direct attachments and explicitly targeted work items.
- **Support Context Budget** is for selected evidence, summaries, and recent conversation context.
- **Awareness Context Budget** preserves breadth through **Reference Context**.
- Recent conversation turns are **Support Context** by default.
- The immediately previous exchange may receive limited protection for conversational continuity.
- Older turns should compete through relevance and budget rather than transcript recency alone.
- Older turns may be represented by a **Context Compression Snapshot** when raw inclusion would exceed the **Context Budget**.
- Large previous outputs should not become **Prompt Context** only because they are recent.
- **Generated Files** and **Generated Documents** are **Available Context** but not automatically **Prompt Context**.
- Generated-output prompt inclusion must happen through **Context Selection**, not through a separate latest-file or file-generation prompt shortcut.
- A generated output may become **Protected Context** when the user clearly continues work on it.
- A recent or visible generated output alone should usually receive no more than **Reference Context**.
- A semantically relevant generated output may receive **Excerpt Context**.
- A directly targeted generated output may receive **Task Context**.
- Old generated outputs should decay unless pinned, selected, or part of an active document family.
- When context exceeds budget, AlfyAI should downgrade **Context Inclusion Level** before dropping useful items.
- When useful items must be dropped, lower-priority **Context Signals** drop before stronger ones.
- A **Context Trace** records promoted context and the **Context Signals** that caused promotion.
- A **Context Trace** records selection facts, not private model reasoning.
- A **Context Trace** may include item identity, inclusion level, signal reasons, token estimates, trimming, limitations, and budget totals.
- A production **Context Trace** should be versioned.
- A production **Context Trace** should identify the model, context source, budget, sections, source totals, limitations, warnings, and fallbacks.
- A production **Context Trace** should include correlation identifiers such as conversation id, stream or turn id, user id, model id, provider id, model name, message id when available, attempt, and phase.
- A production **Context Trace** should not store document or message body text.
- Failing to create a **Context Trace** should not block a chat turn.
- Fallback paths should still produce a **Context Trace** when possible.
- In v1, **Context Trace** should be emitted as structured server logs.
- **Context Trace** should be compact enough for production logs.
- In v1, compact **Context Trace** should be emitted for every Normal Chat turn attempt.
- New **Context Trace** logs should replace or consolidate overlapping debug logs instead of adding parallel noise.
- Production success-path logs should be event-based and sparse.
- Routine context diagnostics should collapse into one compact **Context Trace** per turn or attempt.
- Warnings and errors should remain visible by default.
- Verbose retrieval, attachment, TEI, and per-candidate diagnostics should require an explicit debug setting.
- **Context Diagnostics Debug** controls verbose diagnostics beyond the compact **Context Trace**.
- **Context Diagnostics Debug** should be configurable at runtime with an environment default.
- Routine TEI retrieval summaries should not be always-on production logs once the system is stable.
- **Context Trace** data should not be mirrored into external memory systems.
- External memory mirrors should receive conversational content and minimal role/session metadata, not local diagnostics.
- **Context Trace** is operational diagnostics, not a normal user-interface feature.
- Normal chat UI should not surface **Context Trace**.
- A user-triggered or automatic **Context Compression** should create a compact user-visible chat marker, distinct from **Context Trace**.
- While **Context Compression** is running, the marker may appear as a thin in-progress line; after completion it should become a compact accent-colored marker such as "Compacted context" for manual compression or "Automatically compacted context" for automatic compression.
- Automatic **Context Compression** during a user turn should continue the turn after compression without requiring user intervention.
- Automatic **Context Compression** during a user turn should keep the user turn pending, show a compact intermediate timeline marker, and then continue into normal assistant thinking and generation.
- A **Context Compression** marker is a chat timeline event backed by snapshot status, not a normal user, assistant, or system message row.
- The app should check model-window fit at every model-call boundary in a user turn, including after tool calls or other in-generation prompt expansion.
- If any in-generation model-call boundary would exceed the model-window-aware **Context Budget**, the app should handle it through **Context Compression** or another explicit overflow path and keep the user informed.
- Post-tool automatic **Context Compression** should compact older selected context while keeping the just-returned tool result raw for the current turn.
- Failed or timed-out automatic **Context Compression** should not silently continue with arbitrary deterministic truncation.
- If automatic **Context Compression** fails validation or size limits, AlfyAI may retry once with stricter instructions.
- If automatic **Context Compression** still fails, AlfyAI should preserve the current user message, current tool result when present, and highest-priority protected context, then continue only with a visible **Context Limitation** when the reduced context is likely useful.
- If no useful reduced context can fit, AlfyAI should stop the turn with a clear recoverable error rather than producing an answer from silently damaged context.
- Manual `/compact` should run immediately only when no assistant turn is active.
- If an assistant turn is active, manual `/compact` should queue behind the active turn and run against the completed conversation state rather than compressing partial streaming state.
- Manual `/compact` should not interrupt an active assistant turn unless the user explicitly stops that turn first.
- Manual `/compact` may run even when selected **Prompt Context** already fits the active model because its purpose is also reducing conversation drift and clarifying working state.
- Manual `/compact` should avoid recompressing when no relevant raw conversation or source state changed since the last valid **Context Compression Snapshot**.
- Manual `/compact` should make future prompts prefer the resulting **Context Compression Snapshot** for older history while preserving recent raw turns.
- A valid **Context Compression Snapshot** may represent a covered prefix or range of older conversation context.
- New messages after a valid **Context Compression Snapshot** should remain raw recent context rather than invalidating the snapshot.
- Future prompt assembly should combine the latest valid **Context Compression Snapshot** for covered older history with raw recent turns after the snapshot.
- A **Context Compression Snapshot** should be invalidated by changes inside its covered source history, not by later appended messages.
- A newer **Context Compression Snapshot** may compress the previous valid snapshot plus raw turns appended after that snapshot.
- **Context Compression** may repeatedly compact from the latest valid snapshot plus raw turns as often as needed; v1 should not impose a snapshot generation limit.
- Automatic **Context Compression** should be incremental by default, using the latest valid **Context Compression Snapshot**, raw messages after that snapshot, current selected source context, and current user intent.
- Automatic **Context Compression** should not reopen older raw history merely because a snapshot exists; older raw history should be revisited only through explicit user intent, exact-history requests, or retrieval-selected relevance.
- Exact older-content requests should use the existing **Memory Context Tool** or another existing retrieval path to find and return the relevant raw or detailed context as new selected **Prompt Context**.
- **Context Compression** should not introduce a separate exact-history bypass for compressed snapshots.
- Raw covered history remains stored and available for exact retrieval or future features, but v1 should not force periodic full raw-source rebuilds solely to prevent compression drift.
- Users are responsible for using project chats, separate conversations, manual `/compact`, source selection, and other focus tools when a conversation's working focus drifts too far.
- Normal Chat **Context Selection** happens before the model call by default.
- If selected context is insufficient, AlfyAI should use a **Context Clarification** or **Context Limitation** rather than a hidden context-expansion loop.
- **Context Selection** should evolve through **Context Selection Slices**.
- Each **Context Selection Slice** should be testable and verifiable on its own.
- **Context Selection Slices** should follow test-driven development: prove the behavior, implement it, then refactor.
- A **Context Selection Slice** changes one observable context-selection behavior.
- A **Context Selection Slice** includes the cleanup needed for the behavior it replaces.
- A valid **Context Selection Slice** should prove behavior, trace output, and relevant regression protection.
- Broad refactors are not valid **Context Selection Slices** unless they are tied to one observable behavior.
- Every v1 **Context Selection Slice** should be a **Production Slice**.
- A **Production Slice** includes fallback behavior, observability, tests, and cleanup appropriate to its scope.
- Replacing context-selection behavior should include removing **Context Selection Debt** once the replacement path owns the behavior.
- A conversation may belong to zero or one **Project Folder**.
- A **Conversation Fork** is a new conversation with independent future turns.
- A **Conversation Fork** has one immediate source conversation and one source assistant response.
- A **Conversation Fork** preserves visible history through its fork point, including user-visible attachments and generated work from copied turns.
- A **Conversation Fork** excludes source conversation messages after the source assistant response.
- Copied history in a **Conversation Fork** remains usable as **Available Context** while staying distinguishable from fork-local turns.
- A **Conversation Fork** inherits conversation history, not live control state such as drafts, queued turns, active streams, active **Skill Sessions**, or current **Working Set**.
- A **Conversation Fork** starts in the same **Project Folder** as its source conversation by default and may be moved afterward like any other conversation.
- **Conversation Fork** lineage should be shown as a compact contextual cue, not as a full branch tree or nested sidebar hierarchy.
- A source assistant response with forks should show compact fork awareness, with fork details available only on demand.
- A source assistant response with forks should persist a visually scannable **Fork Origin Marker** for auditability.
- A **Conversation Fork** should show a **Conversation Fork Indicator** in conversation lists with accessible hover/focus text.
- A **Conversation Fork** is a snapshot of copied history; later edits, regeneration, deletion, or title changes in the source conversation do not rewrite the fork.
- Editing or regenerating source history that has **Conversation Forks** should warn that existing forks remain unchanged.
- Deleting a source conversation should not delete its **Conversation Forks**.
- If a source conversation is deleted, its **Conversation Forks** should retain source-title lineage snapshots while source navigation degrades gracefully.
- Deleting a **Conversation Fork** should update fork awareness on the source side without mutating the source transcript.
- Creating a **Conversation Fork** does not automatically send a Normal Chat turn.
- Creating a **Conversation Fork** should open the new fork for continued work.
- A **Conversation Fork** can start only from a completed, persisted assistant response.
- Inherited assistant responses inside a **Conversation Fork** may themselves become fork points for a new immediate child fork.
- Creating a **Conversation Fork** should not implicitly stop or detach an active stream.
- Messages copied into a **Conversation Fork** receive new identities while retaining lineage to their source messages.
- The **Conversation Fork** action belongs on the eligible assistant response that defines the fork point.
- Creating a **Conversation Fork** should not replay copied turns into memory, analytics, external mirrors, task checkpoints, summaries, or generated-work side effects.
- A **Conversation Fork** should preserve the documents, attachments, generated work, and artifact relationships needed to continue from copied history as usable **Available Context**.
- A **Conversation Fork** should link existing durable document artifacts but snapshot conversation-owned generated work into the fork.
- Generated work copied into a **Conversation Fork** should begin fork-local generated-document families while retaining origin lineage to the source generated work.
- Creating a **Conversation Fork** should be atomic; a failed fork should not leave partial copied history or partial artifact continuity.
- A **Conversation Fork** should fail clearly rather than silently omit copied visible documents, attachments, generated work, or required artifact relationships.
- Inherited assistant responses in a **Conversation Fork** should preserve their original **Message Evidence** as snapshot evidence.
- Inherited copied history in a **Conversation Fork** should not count as new usage or cost.
- External memory mirrors should receive only fork-local turns from a **Conversation Fork**, not a replay of inherited copied history.
- Creating a **Conversation Fork** should create one compact local event describing the lineage, not one event per copied turn.
- A **Conversation Fork** should persist a visually scannable **Fork Boundary Marker** so the inherited-history boundary survives refreshes.
- A **Fork Boundary Marker** is lineage metadata, not a chat message.
- A new **Conversation Fork** opens with fork-local composer state, not inherited drafts, queued turns, pending skills, or selected source chips.
- A **Conversation Fork** should start with a predictable editable title derived from the source conversation title.
- Multiple **Conversation Forks** from the same source conversation should receive lineage-based title suffixes rather than relying on title text matching.
- A sealed source conversation may still produce an open **Conversation Fork** because fork creation does not mutate the source conversation.
- Opening a **Conversation Fork** should preserve visual continuity from the source conversation rather than abruptly replacing the chat surface.
- **Project Continuity** may exist with or without a **Project Folder**.
- When a conversation belongs to a **Project Folder**, that **Project Folder** is the canonical project identity for **Project Continuity**.
- A **Project Folder** and **Project Continuity** keep separate identities even when they are linked.
- A **Project Folder** may be linked to at most one canonical **Project Continuity**.
- A **Project Continuity** may be linked to at most one **Project Folder**.
- Creating an empty **Project Folder** does not by itself create **Project Continuity**.
- A **Project Folder** gets canonical **Project Continuity** only after it has a conversation with meaningful task continuity.
- Conversations without a **Project Folder** may still create and use inferred **Project Continuity**.
- A single automatic match should create a **Project Continuity Candidate**, not confirmed **Project Continuity**.
- A **Project Continuity Candidate** may become confirmed **Project Continuity** after an explicit user signal or repeated supporting evidence across related turns or conversations.
- Explicit actions such as moving a conversation into a **Project Folder** or direct continue/pause/resume project language may confirm, pause, or resume **Project Continuity** immediately.
- **Project Folder** linking adds explicit user authority when present; it does not replace automatic **Project Continuity** for unorganized conversations.
- Conversations without a **Project Folder** may receive bounded **Project Continuity Awareness**.
- **Project Continuity Awareness** has lower authority than **Project Folder Awareness** because it comes from inferred continuity rather than explicit user organization.
- When linked, the **Project Folder** name is the canonical display label for **Project Continuity**.
- Renaming a **Project Folder** changes the current label used for linked **Project Continuity** without rewriting historical memory events.
- An explicit **Project Folder** assignment overrides inferred **Project Continuity** routing for future turns in that conversation.
- When a conversation with existing **Project Continuity** is assigned to a linked **Project Folder**, future turns should use the folder's canonical **Project Continuity** rather than the previously inferred one.
- Assigning or moving a conversation into a **Project Folder** should immediately converge that conversation's **Project Continuity** to the folder's canonical **Project Continuity**.
- A later chat turn may refresh **Project Continuity** details, but it should not be required before the **Project Folder** identity applies.
- Removing a conversation from a **Project Folder** removes that folder as the canonical project identity for future turns in the conversation.
- Deleting a **Project Folder** unassigns its conversations from that folder and unlinks its canonical **Project Continuity**, but it does not delete the conversations or by itself mean the user asked AlfyAI to forget project memory.
- **Project Continuity** is forgotten only through an explicit memory-forgetting action or cleanup of conversation-scoped memory links.
- A **Sidebar Pin** changes only conversation sidebar presentation; it does not pin a **Context Source**, change **Prompt Context**, or raise memory authority.
- **Sidebar-Pinned Conversations** may use manual **Sidebar Order** relative to other pinned conversations.
- **Sidebar-Pinned Conversations** appear once in a global pinned area even when they belong to a **Project Folder**.
- A **Sidebar-Pinned Conversation** keeps its **Project Folder** assignment while visually promoted outside that folder.
- A **Sidebar-Pinned Conversation** that belongs to a **Project Folder** should show a subtle project label in the global pinned area.
- Moving a **Sidebar-Pinned Conversation** through the details menu should preserve its **Sidebar Pin**.
- Dropping a **Sidebar-Pinned Conversation** into a normal non-pinned chat area should unpin it and place it in the targeted ordinary location.
- Unpinned conversations remain ordered by recent activity.
- **Project Folders** may use manual **Sidebar Order** relative to other project folders.
- Deleting a sidebar-pinned item removes that item's **Sidebar Pin** with the item.
- Deleting a **Project Folder** should not unpin conversations that were inside it; those conversations become unorganized while keeping their own **Sidebar Pin** if they had one.
- The sidebar details menu for a **Conversation** should expose `Pin to sidebar` when unpinned and `Unpin from sidebar` when pinned.
- **Project Folders** are always visually above ordinary chats, so they should not expose Sidebar Pin actions.
- The global pinned conversation area should be labeled `Pinned` in English and `Rögzített` in Hungarian.
- The sidebar pin action should appear before rename, move, or delete actions because it controls sidebar presentation rather than item ownership.
- A **Sidebar-Pinned Conversation** should keep the same conversation actions as an unpinned conversation.
- Pinning and unpinning should rely on immediate sidebar movement as success feedback rather than adding success toasts.
- The sidebar details menu should remain available through normal click or tap on the three-dots control.
- Opening the same sidebar details menu from a row context-menu gesture may be added as a secondary shortcut, but it should not replace click, tap, or keyboard access.
- The first **Sidebar Pin** slice should support the existing three-dots menu and row context-menu gestures that open the same sidebar details menu.
- Opening a sidebar details menu from a row context-menu gesture should not select a conversation or expand/collapse a **Project Folder**.
- A sidebar details menu opened from a row context-menu gesture should appear at the pointer position while using the same menu contents as the three-dots menu.
- Pinned conversation rows should show a subtle persistent pin indicator.
- Pinned-state styling should not compete with active-conversation styling.
- **Sidebar Pin** and **Sidebar Order** are durable account state, not browser-local preferences.
- Sidebar expansion state may remain browser-local, but sidebar pinning should follow the user across devices.
- Newly pinned conversations enter at the top of the pinned group.
- Activity updates should not reorder sidebar-pinned items.
- Unpinning a **Conversation** returns it to its ordinary project or unorganized location by recent activity.
- Re-pinning a previously unpinned conversation should place it at the top of its pinned group rather than restoring an old pinned position.
- Only conversations visible in the sidebar may be sidebar-pinned.
- Empty bootstrap conversations do not need sidebar pinning before they become visible sidebar conversations.
- The global pinned conversation area should appear only when at least one conversation is sidebar-pinned.
- The first **Sidebar Pin** slice may ship without drag reordering if newly pinned items have deterministic top insertion.
- Drag reordering should use whole-row dragging for sidebar-pinned conversations and **Project Folders**, with no separate reorder handle or up/down buttons.
- A **Project Folder** assignment is a **Strong Context Signal** for project identity.
- A **Project Folder** name may enter **Prompt Context** as a quoted label, not as user or system instructions.
- Raw **Project Folder** names belong in **Prompt Context**, not in the system prompt.
- A conversation inside a **Project Folder** should receive bounded **Project Folder Awareness** by default.
- **Project Folder Awareness** is **Reference Context** by default.
- **Project Folder Awareness** may summarize sibling conversations by title and compact summary.
- **Project Folder Awareness** should prefer **Conversation Summaries** when available.
- A **Conversation Summary** should describe the conversation, not only the current task objective.
- **Project Folder Awareness** should stay bounded for large folders by selecting recent or relevant sibling summaries and disclosing omitted counts where useful.
- **Project Folder Awareness** should appear in **Context Sources** as a compact conversation-level memory or project group when active.
- **Project Folder Awareness** should not appear as a long flat list of every sibling conversation by default.
- Backend **Context Selection** should promote strongly relevant sibling conversation context automatically.
- A model-facing retrieval tool may let AlfyAI explicitly request sibling conversation context, but it should complement **Context Selection** rather than replace it.
- Model-facing sibling conversation retrieval should be summary-first by default.
- Model-facing sibling conversation retrieval may expose an explicit detail mode for one selected sibling conversation.
- Model-facing sibling conversation retrieval should return bounded structured results rather than raw folder-wide transcripts.
- Model-facing sibling conversation retrieval is scoped to the current **Project Folder** by default.
- Full sibling conversation content should enter **Prompt Context** only when the current turn or retrieval gives a **Strong Context Signal** for that sibling conversation.
- Sibling conversation material becomes **Message Evidence** only when a specific sibling summary or transcript materially supports the assistant's answer.
- Excluding one sibling conversation from **Project Folder Awareness** while keeping it in the **Project Folder** is a future source-control behavior, not required for the first implementation.
- A **Project Folder** alone should not promote unrelated documents or memories; **Context Selection** still decides **Prompt Context** within the **Context Budget**.

### Example dialogue

> **Dev:** "If a document is open and the user asks a general question, should the document go into the prompt?"
> **Domain expert:** "No. The open document is **Available Context**, but open by itself is only a **Weak Context Signal**."
>
> **Dev:** "If the document is open and the user says 'summarize this', should it be included?"
> **Domain expert:** "Yes. The open document plus the user's wording creates a **Strong Context Signal**, so it can become **Prompt Context** within the **Context Budget**."
>
> **Dev:** "If the system is unsure whether the open CV matters, should it include the whole CV or omit it?"
> **Domain expert:** "Neither by default. Use **Reference Context** or **Excerpt Context** unless the user asks for a task that needs **Task Context**."
>
> **Dev:** "Should users need to understand the context-selection process?"
> **Domain expert:** "No. AlfyAI should choose automatically and ask a **Context Clarification** only when ambiguity would materially change the answer."
>
> **Dev:** "Should every answer say which excerpts were used?"
> **Domain expert:** "No. Show a **Context Limitation** only when partial context materially changes how much the user should trust the answer."
>
> **Dev:** "If a turn sends too much context, should the UI show a context inspector?"
> **Domain expert:** "No. Emit a structured **Context Trace** in server logs so production behavior can be verified without surfacing diagnostics to users."
>
> **Dev:** "Should each subsystem add its own prompt text?"
> **Domain expert:** "No. Subsystems supply **Available Context** and **Context Signals**; **Context Selection** decides what becomes **Prompt Context**."
>
> **Dev:** "If a chat is inside the **Project Folder** named 'Acme RFP', should that name shape project memory?"
> **Domain expert:** "Yes. The **Project Folder** is the canonical project identity for **Project Continuity**, but its name is a label, not an instruction."

## Model Provider Context

### Language

**Model Provider**:
A configured connection to an external LLM service, defined by a base URL and an API key. One provider can expose multiple **Provider Models**. The built-in model1 and model2 are seeded as providers from environment variables at bootstrap but operate identically to admin-configured providers at runtime.
_Avoid_: inference provider, model endpoint, third-party model

**Provider Processing Region**:
An admin-declared country or region marker for where a **Model Provider** is expected to process inference data. It is a compact user-facing privacy cue, commonly shown as a flag in tight model-selection UI with the full country or region name available on hover or focus; it is not a full claim about provider incorporation, storage location, retention behavior, or subprocessors.
_Avoid_: provider country, company country, data residency guarantee, retention policy

**Provider Privacy Policy Link**:
An optional admin-provided link to the privacy or data-processing policy for a **Model Provider**. It carries deeper third-party policy detail in the **Model Selection Guide** through an unobtrusive icon affordance while the compact model selector stays focused on choosing a model.
_Avoid_: provider documentation dump, legal summary, model guide essay

**Provider Model**:
A specific model name available under a **Model Provider** that an admin has chosen to make available for Normal Chat. It carries its own display name, context limits, capability flags, reasoning configuration, and pricing rules. Users select from available **Provider Models** in the chat model selector.
_Avoid_: available model, configured model, endpoint, model

**Model Selection Guide**:
A contextual, reopenable informational comparison modal launched from Provider Model selection. It supplements the existing model selector with compact structured model facts and short admin-authored guidance for all currently enabled **Provider Models**, without replacing the selector, allowing model selection, or becoming an **Announcement Campaign**.
_Avoid_: campaign slide, release note, onboarding popup, static model list, enhanced selector

**Model Guide Launcher**:
The compact question-mark help control shown beside the chat model selector trigger. It reopens the **Model Selection Guide** without requiring the user to open the selector dropdown first.
_Avoid_: dropdown item, onboarding replay, campaign button

**Model Guidance Note**:
A short localized admin-authored recommendation for one **Provider Model**, used by the **Model Selection Guide** to express the model's best-fit use cases in at most a couple lines. Objective facts such as pricing, context size, and capability indicators should remain structured model metadata instead of being buried in this note.
_Avoid_: model marketing copy, long introduction, pricing text, capability prose, campaign body

**Model Guide Badge**:
An optional saved display label in the **Model Selection Guide** that labels a **Provider Model** as either Intelligent or Fast. It is a lightweight presentation cue only and must not affect model routing, fallback, context selection, pricing, or provider behavior.
_Avoid_: benchmark score, intelligence ranking, routing hint, model capability

**Model Cost Indicator**:
A compact user-facing cost label in the **Model Selection Guide**, derived from the **Provider Model** pricing rules. It should communicate relative cost at a glance, with exact token pricing available on hover or focus rather than shown as primary row text.
_Avoid_: billing rule, admin pricing field, cost accounting, exact price column

**Model Guide Row**:
The compact per-model entry in the **Model Selection Guide**. It shows the Provider Model identity, provider and processing-region cues, lightweight badges, relative cost, notable context capacity when useful, and at most a short **Model Guidance Note**; it is informational only and should not expose raw provider configuration, fallback policy, capability JSON, or long descriptions.
_Avoid_: model detail page, provider configuration row, capability dump, benchmark card

**Model Guidance Authoring**:
The admin workflow for maintaining **Model Guidance Notes** and any explicit positioning fields that help users choose among **Provider Models**. It belongs with Provider Model configuration rather than Announcement Campaign authoring.
_Avoid_: campaign authoring, release-note editing, onboarding copy

**Model Connection**:
The resolved runtime binding of a **Provider Model** for one Normal Chat turn, including the provider's base URL, decrypted API key, model name, and capability assertions. It is ephemeral — created per turn, not stored.
_Avoid_: provider instance, model run config

**Model Fallback**:
The retry target used when a selected **Provider Model** fails in a retryable way during a **Normal Chat Model Run**. A model-specific fallback takes priority; if the selected Provider Model has no fallback, the global fallback may apply. Provider-wide fallback is not part of the model-routing contract.

Model Fallback applies only to retryable infrastructure or model-availability failures: connect timeout, request timeout, provider rate limit, provider 5xx, premature stream completion before a usable assistant answer, or a provider response indicating the selected model is temporarily unavailable. It should not apply to authentication failures, bad API keys, user aborts, prompt/schema validation errors, unsupported response-format compatibility issues, or normal model refusals.

When a Model Fallback is used, the fallback Provider Model's own runtime settings apply: provider connection, context limits, tool support, reasoning/thinking settings, response-format compatibility, pricing, and display metadata. Fallback is a new resolved Model Connection, not a partial swap of URL or model name under the original Provider Model.

Model Fallback is operational behavior, not a new end-user interaction. It should be recorded in diagnostics, logs, usage metadata, or admin-facing traces where appropriate, but it should not introduce visible chat UI changes or fallback banners for end users.

Model Fallback does not chain in v1. A selected Provider Model may use its model-specific fallback, or the global fallback when no model-specific fallback is configured. If that fallback attempt fails, the Normal Chat Model Run should stop and report the failure through the existing error path; it should not continue through the fallback model's own fallback.

Model Fallback must not resolve to the same selected Provider Model. Self-fallback should be rejected at configuration time where possible; at runtime, a self-resolved fallback should be treated as unconfigured and recorded as invalid fallback configuration.

Normal Chat Model Fallback resolution order is: selected Provider Model fallback first, global fallback second, no fallback third. Provider-wide fallback is legacy migration debt and should not be part of Normal Chat routing once model-specific fallback is available.

Model Fallback configuration should be strict for model-specific fallback choices when the system has explicit incompatible evidence. Admin surfaces should prevent choosing a fallback Provider Model that explicitly lacks a capability the source Provider Model is known to use. Unknown provider-discovery capability state is advisory metadata, not an automatic incompatibility, because many OpenAI-compatible model-list endpoints do not report chat or streaming flags. A global fallback may be saved even when it is incompatible with some enabled Provider Models, but it applies only to compatible inheriting Provider Models and incompatible models must be visibly warned in admin surfaces.

Fallback compatibility treats an enabled Provider Model as chat-capable by definition. Other Normal Chat capabilities are compared from explicit evidence: a fallback Provider Model is incompatible when it explicitly lacks streaming, tools, structured output/JSON mode, file/image message parts, or provider-native reasoning controls that the source Provider Model is explicitly configured or detected to require. Usage reporting is not a fallback blocker; missing usage should degrade diagnostics/cost accounting rather than answer generation.

If no compatible fallback Provider Model exists for an enabled Provider Model, admin surfaces should make that visible without forcing an immediate configuration choice: show a compact warning indicator on the provider/model row, and show a short reason in the model edit modal explaining which required capabilities prevent fallback compatibility. This remains admin-facing only and should not create end-user chat UI.

At runtime, if the selected Provider Model has no compatible model-specific fallback and cannot inherit a compatible global fallback, Normal Chat should make no fallback attempt. Retryable failures should follow the existing error path with diagnostics indicating that no compatible Model Fallback was configured or inherited.

Model Fallback applies to the main Normal Chat answer Model Run. It should not be reused for Depth Classification, structured control-model calls, or schema-repair paths, which have their own constrained fallback behavior and diagnostics.

Model Fallback is admin-only configuration. End users select the primary Provider Model; they do not choose, override, or see fallback policy during normal chat.
_Avoid_: provider fallback, failover provider, backup endpoint

**Model Discovery**:
The admin-triggered process of calling the provider's `/v1/models` endpoint to list available model IDs. The result is used to pre-populate **Provider Models** for admin selection.
_Avoid_: model fetch, auto-detect, model scan

### Relationships

- A **Model Provider** has many **Provider Models**.
- A **Provider Model** belongs to exactly one **Model Provider**.
- A **Model Selection Guide** explains all currently enabled **Provider Models** without replacing the chat model selector.
- A **Model Selection Guide** preserves **Model Provider** grouping, **Provider Processing Region**, and **Provider Privacy Policy Link** cues because providers may carry user-facing privacy or jurisdiction meaning.
- A **Model Selection Guide** does not select or change the active Provider Model; the existing model selector remains the selection surface.
- A **Model Guide Launcher** opens the **Model Selection Guide** from beside the model selector trigger.
- A **Model Guidance Note** belongs to one **Provider Model** and complements structured model metadata.
- A **Model Guide Badge** may label a **Provider Model** for user understanding, but it has no runtime authority.
- A **Model Cost Indicator** summarizes existing Provider Model pricing for users without replacing admin cost accounting.
- A **Model Guide Row** is informational and compact, not a provider or model administration surface.
- **Model Guidance Authoring** is part of Provider Model administration, not Announcement Campaign administration.
- A **Model Connection** is resolved from a **Provider Model** for one **Normal Chat Model Run**.
- A **Provider Model** may define one model-specific **Model Fallback** to another Provider Model.
- The global **Model Fallback** is used only when the selected Provider Model has no model-specific fallback.
- **Model Discovery** is triggered when a **Model Provider** is created or when an admin explicitly refreshes it.
- **Model Capability** assertions are per **Provider Model**, probed during **Model Discovery** or validated at model creation time.
- **Max Model Context**, **Max Output Tokens**, and **Compaction Threshold** are per **Provider Model**.
- model1 and model2 are **Model Providers** seeded from `MODEL_1_*` / `MODEL_2_*` environment variables at bootstrap, each with one **Provider Model**.

## Knowledge Library Context

### Language

**Knowledge Base**:
The user-facing area for reviewing AlfyAI's remembered user context and stored documents. Its primary entry point is the **Memory Profile**, and its document-management area is **Documents**. Opening the Knowledge Base from navigation should enter through **Memory Profile** rather than restoring **Documents** as the last selected tab.
_Avoid_: hidden memory admin, single document library, developer diagnostics page

**Library Document**:
A document the user has uploaded, imported, or otherwise stored in the Knowledge Library.
_Avoid_: artifact, file row, evidence item

**Uploaded Document**:
A **Library Document** created from a user-provided file.
_Avoid_: source artifact, original file

**Filename Conflict**:
A Knowledge Library upload whose filename is already used by another **Library Document** for the same user.
_Avoid_: duplicate version, overwrite candidate

**Auto-Renamed Upload**:
An **Uploaded Document** whose display name was changed to preserve both files after a **Filename Conflict**.
_Avoid_: new version, replacement, overwrite

**Knowledge Upload Intake**:
The deep server module at `src/lib/server/services/knowledge/upload-intake.ts` that completes an **Uploaded Document** after an upload adapter has authenticated the user and received bytes or upload intent metadata. It owns shared upload limits, optional conversation validation, source artifact persistence through the Knowledge store, normalized-document extraction, prompt-readiness resolution, and upload trace output. It does not sync uploaded or normalized document bodies into Honcho persona memory by default.
_Avoid_: route-local upload completion, partial raw-upload helper, duplicated readiness path

**File Production Request**:
A user request for AlfyAI to create one or more downloadable **Generated Files**.
_Avoid_: export task, PDF tool call, sandbox job

**File Production Intake**:
The normalized start of a **File Production Request**, where AlfyAI decides whether the request becomes a queued job or a durable failed **File Production Card** before rendering begins.
_Avoid_: route-local file job, tool-specific export path, transient generation task

**File Production Job Ledger**:
The file-production deep module that owns durable job, attempt, retry, cancellation, stale-recovery, and produced-file-link state transitions.
_Avoid_: route-local job state, renderer-owned retry state, worker-owned DB rules

**File Production Read Model**:
The file-production deep module that projects **File Production Card** state for conversation detail, including legacy generated-file backfill and internally-visible job-linked files that are not yet attached to an assistant message.
_Avoid_: worker import side effect, chat-file public list, route-local job projection

**File Production Worker Runner**:
The file-production deep module that owns in-process worker identity, startup recovery, lazy wakeups, drain-to-idle execution, and current-attempt orchestration.
_Avoid_: route-owned worker loop, renderer queue, always-on polling loop

**File Production Execution Adapter**:
The file-production deep module that parses persisted production requests and dispatches either source-first document rendering or sandboxed program execution.
_Avoid_: job ledger parser, storage adapter renderer, model-facing tool parser

**Generated File Storage Adapter**:
The file-production deep module that validates produced outputs, stores generated files, links them to jobs, maps source-first document files, and triggers post-success memory sync.
_Avoid_: worker-local storage block, renderer-owned chat-file write, duplicate generated-file mapper

**Generated Document Source Persistence**:
The production file-production deep module that stores the canonical **Generated Document Source** artifact, manages its pending/succeeded/failed lifecycle, and links rendered **Generated Files** back to it.
_Avoid_: test helper, chat-file extraction path, rendered-file truth

**File Production Card**:
A chat card that presents the durable state and actions for a **File Production Request**.
_Avoid_: stream placeholder, temporary generated-file row, tool-call log

**Dismissed File Production Job**:
A failed or cancelled **File Production Job** the user has acknowledged and hidden from the chat. It is a persisted flag, not a deletion: the job row and any produced files remain, and the card can be restored via a per-message "show dismissed" affordance. A non-dismissed failed or cancelled card reappears on reload; a dismissed one does not.
_Avoid_: deleted job, hidden job, soft-deleted card, ephemeral dismiss

**Generated File**:
A downloadable file produced by AlfyAI during chat.
_Avoid_: uploaded document, attachment, artifact

**Generated File Serving**:
The server-side boundary at `src/lib/server/services/generated-file-serving.ts` that serves validated **Generated File** bytes for preview or download once a caller has selected a generated chat-file id and the file is either attached to an assistant message or linked to a succeeded **File Production Job** for the same user and conversation.
_Avoid_: route-local generated-file headers, preview-runtime authorization, working-document byte validator

**Generated Document**:
A **Generated File** whose content is a document-like work item that can be opened, revised, or versioned.
_Avoid_: uploaded document, attachment, report, raw export

**Generated Document Source**:
The normalized semantic structure AlfyAI uses to render a **Generated Document**.
_Avoid_: PDF code, layout script, binary file bytes, raw HTML

**Generated Document Family**:
A set of **Generated Documents** that are iterations of the same AI-created work item.
_Avoid_: duplicate upload group, file history

**Generated Document Version**:
One member of a **Generated Document Family**.
_Avoid_: uploaded duplicate, library version

**Generated Document Template**:
A reusable presentation policy for rendering a **Generated Document Source**.
_Avoid_: generated document source, PDF script, style prompt

**App Typography Set**:
The bundled Nimbus Sans L and Libre Baskerville fonts used by AlfyAI's product interface and generated-document presentation.
_Avoid_: system font dependency, per-document custom font, host-installed PDF font

**Working Document**:
A **Library Document** or **Generated Document** that the user has opened, selected, or clearly continued working on.
_Avoid_: active file, current artifact

**Working Document Identity**:
The app-owned contract that resolves a **Working Document** into purpose-specific artifact identities for display or workspace use, prompt context, preview or file serving, and family matching.
_Avoid_: ad hoc `displayArtifactId` choice, prompt artifact convention, route-local preview fallback

**Working Document Selection**:
The per-turn authority that collapses live **Working Document** signals such as selected workspace focus, current generated document, correction/refinement target, recently refined generated-document family, and reset/move-on phrasing into caller-ready prompt, retrieval, context-source, and task-evidence views.
_Avoid_: legacy live-signal helper, stale reason-code carryover, caller-local current document guess

**Document Workspace**:
The user-facing surface where one or more **Working Documents** can be opened, switched, inspected, compared, or closed.
_Avoid_: working document sidebar, file preview modal, active document

**Preview Runtime**:
The client-side deep module under `src/lib/components/document-workspace/preview-runtime/` that loads preview bytes, classifies file types, and renders supported **Working Document** previews through focused PDF, Office, Text, and Image adapters.
_Avoid_: monolithic file preview component, route-local renderer, server file-serving rule

**Open Documents Rail**:
The **Document Workspace** switcher that appears when multiple **Working Documents** are open.
_Avoid_: tabs, document chips, file row

**Expanded Document Workspace**:
A larger **Document Workspace** presentation for focused reading or inspection of the same open **Working Documents**.
_Avoid_: fullscreen modal, separate viewer

**Document Provenance**:
The origin information that explains where a **Working Document** came from.
_Avoid_: source message button, primary document action, source viewer

### Relationships

- A **Library Document** may be an **Uploaded Document**.
- A **Generated Document** is a **Generated File**.
- A **Generated File** is not an **Uploaded Document**.
- A **Generated File** does not automatically become a **Generated Document**.
- A **File Production Request** may produce one or more **Generated Files**.
- A **File Production Request** is one user-facing capability even when AlfyAI uses different internal production methods.
- **File Production** creates jobs, renders or executes outputs, and stores **Generated Files**; **Generated File Serving** serves already-stored generated-file bytes.
- **Generated File Serving** owns generated-file lookup, conversation-owner fallback, assigned/succeeded-job eligibility, generated-file type checks, byte validation, MIME/content-type selection, CSP/disposition/cache headers, and generated HTML/SVG preview hardening.
- Chat generated-file preview and download routes are transport adapters over **Generated File Serving**.
- Every **File Production Request** enters **File Production Intake** before renderer, sandbox, or storage work begins.
- **File Production Intake** creates or reuses durable **File Production Card** state; it is not a stream-only or tool-specific concern.
- A malformed **File Production Request** still produces a durable failed **File Production Card** through **File Production Intake** when enough conversation ownership is known.
- The public file-production facade delegates to deep modules; callers should import the facade unless they are inside the file-production boundary or the **Conversation Detail Read Model** needs **File Production Read Model** without loading worker/rendering/storage modules.
- **File Production Job Ledger** is the durable state authority for **File Production Cards** and attempts; renderers, routes, and worker code should not reimplement job state transitions.
- **File Production Read Model** is the projection authority for conversation-visible **File Production Cards**; it may hydrate job-linked unassigned files for finalization, and **Generated File Serving** may serve those unassigned files only when the read model confirms a succeeded job link for the requesting user and conversation.
- **File Production Worker Runner** consumes **File Production Job Ledger**, **File Production Execution Adapter**, and **Generated File Storage Adapter** rather than owning their rules inline.
- **File Production Execution Adapter** decides how a persisted request runs; it does not own durable job state or generated-file storage.
- **Generated File Storage Adapter** stores and links outputs after execution and before job success; output validation failures do not create produced-file links.
- A `document_source` **File Production Request** that passes intake validation and ownership checks persists its canonical **Generated Document Source** through **Generated Document Source Persistence** before PDF, DOCX, or HTML rendering begins.
- Invalid **Generated Document Source** input fails during request parsing or validation and does not create a persisted source artifact.
- A source-first **Generated Document Source** is pending and non-durable until its rendered **Generated Files** attach successfully.
- A failed or still-pending source-first **Generated Document Source** is not prompt-eligible and must not fall through to text-only preview/download as though generation succeeded.
- A **File Production Card** appears from persisted job state, not from a stream-only placeholder.
- A **File Production Card** may present queued or running jobs with a generating visual treatment while the underlying job status remains `queued` or `running`.
- A queued or running **File Production Card** may use a content-loading shimmer treatment instead of textual progress, a spinner, or a progress bar.
- A queued or running **File Production Card** keeps cancellation available as a quiet icon-only affordance rather than a text action.
- A **File Production Card** should resolve from generating to finished in place with a tight top-to-bottom reveal, not a large success flash or layout jump.
- An unassigned active **File Production Card** may appear inside the current streaming assistant response as soon as the successful production job exists, then reconcile to the persisted assistant message when the stream completes.
- A **Generated Document** may have a **Generated Document Source**.
- A **Generated Document Source** is **Available Context**.
- **Generated Document Source Persistence** is the source authority for source-first **Generated Documents**; it is not route-local behavior, a detached helper, or a binary-extraction fallback.
- The rendered binary file is the downloadable **Generated File** and a projection of the persisted **Generated Document Source**.
- Rendered PDF, DOCX, and HTML **Generated Files** from the same source-first job link back to one source artifact through `generatedDocumentRenderedChatFileIds` plus `originalChatFileId` and `sourceChatFileId` read-model metadata.
- Source-first rendered document files sync to memory and Honcho through the canonical **Generated Document Source** artifact instead of creating duplicate binary-extraction `generated_output` artifacts.
- Program-mode and legacy **Generated Files** keep the existing extraction and generated-output versioning path when no canonical **Generated Document Source** exists.
- A **Generated Document Template** renders a **Generated Document Source** into one or more downloadable formats.
- A **File Production Request** may name a **Generated Document Template**.
- When no template is named, AlfyAI chooses an appropriate **Generated Document Template**.
- A **Generated Document Template** should use the **App Typography Set** rather than depending on host-installed PDF fonts.
- Within the **App Typography Set**, Nimbus Sans L is the primary generated-document font; Libre Baskerville is reserved for restrained title or cover accents.
- Missing **App Typography Set** font files are a packaging error for generated-document rendering and should fail visibly rather than falling back to host fonts.
- AlfyAI owns document layout and rendering; the assistant supplies semantic content, not PDF layout code.
- Non-document outputs such as raw data files, code files, stylesheets, scripts, images, or bundles may remain **Generated Files** without entering generated-document version history.
- Program-mode **File Production Requests** may produce source/text artifacts such as CSS, JavaScript, TypeScript, shell scripts, GraphQL, TOML, SQL, language source files, configuration files, and logs when the requested output type, filename extension, stored MIME type, and bytes agree.
- A **Filename Conflict** creates an **Auto-Renamed Upload**.
- A **Filename Conflict** does not create a **Generated Document Version**.
- An **Auto-Renamed Upload** remains a separate **Uploaded Document**.
- Uploaded documents do not form user-visible version history in v1.
- Every **Uploaded Document** enters **Knowledge Upload Intake** before normalized extraction or prompt-readiness response assembly. Uploaded document bodies do not become Honcho persona memory by default.
- Knowledge upload routes are adapters for authentication, HTTP metadata parsing, multipart form reads, raw stream receipt, chunk storage, chunk assembly, and response translation; they do not own durable upload completion.
- **Knowledge Upload Intake** composes Knowledge store attachment persistence for auto-rename, optional conversation linking, and source artifact writes; it does not create a second artifact store.
- **Knowledge Upload Intake** validates any supplied conversation id before artifact persistence or prompt-readiness linking, while conversationless library uploads stay valid.
- A **Generated Document Family** may contain one or more **Generated Document Versions**.
- A **Working Document** may point to either a **Library Document** or a **Generated Document**.
- **Working Document Identity** owns purpose-specific artifact ids for **Working Documents**; callers should request display, prompt, preview/file-serving, or family identity instead of inspecting `displayArtifactId`, `promptArtifactId`, and `familyArtifactIds` directly.
- **Working Document Selection** owns live per-turn signal collapse for **Working Documents**; callers should request its prompt, working-set, retrieval, and task-evidence views instead of re-deriving active focus, correction target, current-generated, recent-refinement, or reset rules locally.
- `document-resolution.ts` remains the generated-document family ranking authority. **Working Document Selection** consumes that ranking to decide the live current/generated carryover view; it does not replace generated-family identity or version ordering.
- **Document Workspace** and Knowledge preview/download routes use **Working Document Identity** preview/file-serving identity so source-plus-normalized documents open the display file while text-only documents degrade deliberately.
- The Knowledge Base Documents page should keep source-plus-normalized documents as one source row, but rows with a normalized prompt artifact must expose an on-demand AI-facing version panel. This panel shows the normalized text AlfyAI can use for prompt context; it is not Honcho persona memory and should not be removed when tightening memory intake boundaries.
- **Working Document Identity** and Working Document file serving select artifact identity or generated-output `sourceChatFileId`; when that identity points to generated chat-file bytes, they delegate byte validation and headers to **Generated File Serving**.
- **Preview Runtime** consumes bytes served through **Working Document Identity** and server-side file serving; it does not decide which artifact or generated file is authorized or canonical.
- **Preview Runtime** renders bytes in the browser; it does not own **Generated File Serving** concerns such as assignment quarantine, ownership fallback, MIME/byte validation, or CSP/disposition/cache headers.
- **Preview Runtime** owns client-side file-type preview behavior for PDF, Office/OpenDocument, text/Markdown/CSV/HTML, source-style code/text files, and images; `DocumentPreviewRenderer.svelte` coordinates loading/error/unsupported state and adapter composition.
- **Document Workspace** lazy-loads `DocumentPreviewRenderer.svelte`, and `DocumentPreviewRenderer.svelte` delegates heavy file-type work into **Preview Runtime** adapters so idle Chat and Knowledge shells do not eagerly import preview libraries.
- Preview prewarm may warm the same preview URL bytes, but **Preview Runtime** remains the authoritative browser path for opening and rendering the preview.
- **Linked Context Sources** use **Working Document Identity** canonical display, prompt, and family identity for dedupe, stale-selection matching, and prompt readiness.
- **Context Selection** may consume prompt identity supplied by **Working Document Identity** and signals supplied by **Working Document Selection**, but **Context Selection** still decides whether an artifact becomes **Prompt Context** and how much budget it receives.
- Knowledge retrieval and **Context Sources** may use **Working Document Selection** to preserve the user's current document intent across follow-up turns, but they should not become a second live-signal authority.
- **Task Context** may protect **Working Document Selection** evidence ids during reranking and persistence, but task continuity remains owned by task-state.
- **File Production** and **Generated Document Source Persistence** create and link generated-document source/rendered-file metadata; **Working Document Identity** consumes that metadata for workspace and preview behavior rather than owning file-production jobs.
- A **Library Document** preview in the **Document Workspace** should resolve to the original display file when that file exists.
- Normalized or extracted **Library Document** text is retrieval and prompt context, not the default visual preview identity.
- If a **Library Document** no longer has an original display file, the **Document Workspace** may fall back to extracted text as a degraded preview.
- A **Document Workspace** may contain one or more **Working Documents**.
- A **Document Workspace** has at most one selected **Working Document** at a time.
- A **Document Workspace** should keep multiple open **Working Documents** readable and scannable even when more documents are open than fit at once.
- An **Open Documents Rail** appears only when the **Document Workspace** contains more than one **Working Document**.
- An **Open Documents Rail** lists open **Working Documents**, not unopened **Generated Document Versions**.
- On desktop, the **Open Documents Rail** should be a vertical, scrollable document switcher.
- The **Open Documents Rail** should prioritize readable titles, a clear active row, quiet file-type/provenance metadata, compact close controls, and compact generated-version badges where relevant.
- The **Open Documents Rail** should not become a secondary action toolbar, thumbnail strip, or colorful status board.
- **Generated Document Versions** remain visible through generated-document version history, separate from the **Open Documents Rail**.
- Generated-document version history should be visible only when the selected **Working Document** belongs to a multi-version **Generated Document Family**.
- Generated-document version history should stay compact in the normal **Document Workspace** view.
- Unopened **Generated Document Versions** should not show body content unless the user opens or compares that version.
- A Markdown **Working Document** should render as a readable document by default.
- A Markdown **Working Document** is a rich reading preview, not a source-style text or code preview.
- Markdown **Working Document** rendering should support common reading features such as headings, lists, tables, task lists, fenced code, callouts, and frontmatter presentation.
- Markdown **Working Document** rendering should provide document typography and visible structure for heading hierarchy, list markers, tables, blockquotes, and code fences.
- Markdown **Working Document** rendering should not resolve Obsidian-style wiki links or embeds unless AlfyAI can map them to real documents.
- Markdown **Working Document** rendering should keep safe external links clickable.
- Markdown **Working Document** rendering should not make unresolved relative links, wiki links, or embeds behave like real workspace navigation.
- A Markdown **Working Document** does not need a separate raw-text mode in the **Document Workspace**; the original file remains available through download.
- A **Document Workspace** provides read-only previews for supported document formats.
- Supported **Document Workspace** previews should preserve the natural reading shape of the format: paged PDF, readable Word/OpenDocument content, workbook tables, slide previews, rendered Markdown, rendered HTML, CSV tables, and source-style text/code previews.
- HTML **Working Document** previews should be visual, static, and sandboxed rather than fully interactive pages.
- HTML **Working Document** previews should preserve inline styling and safe same-file packaged styling when available.
- HTML **Working Document** previews should not execute scripts or allow live page navigation inside the preview.
- External network assets in HTML **Working Document** previews may remain blocked or degraded.
- Unsupported legacy or specialized file formats may remain download-only unless AlfyAI adds a dedicated preview path for them.
- An **Expanded Document Workspace** keeps the same selected **Working Document**, open-document set, and document controls as the docked **Document Workspace**.
- An **Expanded Document Workspace** should not be a separate preview surface with different behavior from the docked **Document Workspace**.
- An **Expanded Document Workspace** should use a centered max-width reading frame on wide desktop displays, approximately 1600px.
- An **Expanded Document Workspace** should use extra width for a better rail and preview layout, not by stretching the preview surface edge to edge.
- A docked **Document Workspace** may be horizontally resized within sensible min and max bounds.
- Double-clicking the docked **Document Workspace** resize handle should reset it to the default width.
- An **Expanded Document Workspace** should not expose manual horizontal resizing.
- **Document Workspace** implementation work should be sliced by user-verifiable behavior, not by component internals alone.
- Independently verifiable **Document Workspace** slices include open-document rail behavior, PDF interaction, Markdown rendering, Knowledge preview parity, HTML visual fidelity, resize reset, provenance placement, and expanded-width layout.
- Chat and Knowledge should use the same **Document Workspace** for inspecting **Working Documents**.
- Chat opens the **Document Workspace** docked by default so conversation remains primary.
- Knowledge may open documents in the **Expanded Document Workspace** by default.
- Knowledge opens the **Expanded Document Workspace** by default so document inspection remains primary.
- Closing the **Expanded Document Workspace** in Knowledge should return to the same Knowledge Library state underneath.
- Chat and Knowledge keep separate open **Working Document** sets even though they use the same **Document Workspace** surface.
- Opening a **Working Document** in Knowledge should not automatically add it to the Chat **Document Workspace**.
- AlfyAI should not maintain parallel document viewer surfaces with different controls or behavior for the same **Working Documents**.
- Generated-document comparison belongs inside the **Document Workspace**, not in a separate viewer surface.
- **Document Provenance** is secondary metadata for a **Working Document**, not a primary **Document Workspace** action.
- **Document Provenance** should appear near document identity details such as filename, type, and generated version.
- When **Document Provenance** points to a chat message, the **Document Workspace** may offer a quiet origin affordance that jumps to that message.
- **Document Provenance** controls should not sit beside page, slide, zoom, or pan controls.
- Document navigation and zoom controls belong with the preview inside the **Document Workspace**, not split across separate workspace and preview surfaces.
- Document navigation and zoom controls should appear only for formats that benefit from them.
- Page and slide navigation in the **Document Workspace** should start with compact controls rather than thumbnail strips.
- Page and slide navigation in the **Document Workspace** should use one compact indicator, not duplicate page or slide summaries.
- Mouse wheel input should scroll a **Working Document** preview by default; modified wheel input such as Ctrl/Cmd+wheel may zoom when the format supports zoom.
- Drag panning should activate only when a zoomable **Working Document** preview is zoomed beyond its fit/default scale.
- Image previews in the **Document Workspace** should support intuitive zoom, fit, and pan interactions for inspection.
- Image preview controls should remain read-only and should not introduce editing actions such as crop, rotate, or annotation.
- Opening a document can make it a **Working Document**, but it does not by itself make the whole body **Prompt Context**.

### Example dialogue

> **Dev:** "If the user uploads `report.pdf` twice, is the second file version 2?"
> **Domain expert:** "No. That is a **Filename Conflict**, so the second file becomes an **Auto-Renamed Upload** such as `report_1.pdf`."
>
> **Dev:** "When do we show version history?"
> **Domain expert:** "Only for a **Generated Document Family**, where each generated iteration is a **Generated Document Version**."
>
> **Dev:** "If AlfyAI creates `data.csv`, is that a **Generated Document**?"
> **Domain expert:** "No. It is a **Generated File**. It becomes a **Generated Document** only if the user treats it as a work item to open, revise, or version."
>
> **Dev:** "Should the assistant choose between a PDF export feature and a sandbox file generator?"
> **Domain expert:** "No. The user made one **File Production Request**. AlfyAI chooses the internal production path."
>
> **Dev:** "Should the assistant write PDF styling code?"
> **Domain expert:** "No. The assistant provides a **Generated Document Source**; AlfyAI applies a **Generated Document Template** when rendering."
>
> **Dev:** "If a source-first PDF is rendered, should memory sync extract the PDF and create another generated-output artifact?"
> **Domain expert:** "No. The rendered file is a downloadable projection; memory sync uses the persisted **Generated Document Source** artifact."
>
> **Dev:** "Can an uploaded PDF be the **Working Document**?"
> **Domain expert:** "Yes. A **Working Document** can be uploaded or generated, but upload duplicates still stay separate documents."
>
> **Dev:** "Is the sidebar itself the **Working Document**?"
> **Domain expert:** "No. The surface is the **Document Workspace**; the selected item inside it is the **Working Document**."
>
> **Dev:** "If many documents are open, should their names shrink until they are unreadable?"
> **Domain expert:** "No. The **Document Workspace** should preserve readable document switching, even when the open set has to scroll."
>
> **Dev:** "Should the switcher always take space, even when only one document is open?"
> **Domain expert:** "No. The **Open Documents Rail** appears when there are multiple **Working Documents**."
>
> **Dev:** "Should a Markdown file open as highlighted source code?"
> **Domain expert:** "No. A Markdown **Working Document** should open as a rendered reading document; raw text is available through download."
>
> **Dev:** "Should Obsidian wiki links and embeds behave like real links immediately?"
> **Domain expert:** "No. Render Markdown readably, but do not resolve workspace-specific links unless they can point to real documents."
>
> **Dev:** "Should every relative Markdown link become clickable in the workspace?"
> **Domain expert:** "No. Keep safe external links clickable, and keep unresolved workspace links readable but non-navigating."
>
> **Dev:** "Should opening a spreadsheet or slide deck behave like editing it in an office suite?"
> **Domain expert:** "No. The **Document Workspace** provides read-only previews for supported formats; editing is out of scope."
>
> **Dev:** "Should HTML previews run arbitrary page scripts?"
> **Domain expert:** "No. HTML **Working Document** previews should be static and sandboxed."
>
> **Dev:** "Should fullscreen open a separate file-preview modal?"
> **Domain expert:** "No. Focused reading should use an **Expanded Document Workspace** with the same documents and controls."
>
> **Dev:** "Should Knowledge keep its own document preview modal if Chat has the new workspace?"
> **Domain expert:** "No. Chat and Knowledge should use the same **Document Workspace** surface, with different default presentation states when useful."
>
> **Dev:** "Should page and zoom controls be split between the workspace header and the preview renderer?"
> **Domain expert:** "No. Navigation and zoom belong in one compact preview toolbar inside the **Document Workspace**."
>
> **Dev:** "Should the first-class navigation redesign include page thumbnails?"
> **Domain expert:** "No. Start with compact controls; thumbnails can be added later if the need is proven."
>
> **Dev:** "Does better image zoom mean adding image editing?"
> **Domain expert:** "No. Image zoom, fit, and pan are inspection controls inside the **Document Workspace**."

## Atlas Research Reports

AlfyAI can produce durable, navigable research reports called Atlases through a special kind of Normal Chat Turn. This context captures the product-domain language for the Atlas feature, which replaces the deleted Deep Research subsystem.

### Language

**Atlas** / **Atlasz**:
A durable, navigable research report artifact produced by an **Atlas Turn**. It is a self-contained document with sidebar navigation, deterministic source chips/source attribution, images, and evidence-derived **Atlas Basis Markers**, available as a styled HTML website, a PDF, and a Markdown file. It is stored and previewed through the existing file-production and document-workspace infrastructure, not as a chat message.
_Avoid_: deep research report, research card, research job output, research artifact

**Atlas Turn**:
A **Normal Chat Turn** that produces an **Atlas** through an enforced multi-stage research pipeline. Unlike a regular turn where the model decides its own tool flow, an Atlas Turn runs a fixed server-controlled sequence. V1 runs decompose, search, curate, synthesize, integrate, assemble, audit, then deterministic rendering; future multi-round Atlas work may insert bounded coverage review and gap-fill rounds, but the model still fills in content within server-owned stages rather than owning orchestration. Its kickoff assistant message flows through **Normal Chat Turn Completion** with memory and Honcho enrichment explicitly skipped; the background completion records usage, source counts, file-production links, and generated-file ids on the Atlas job. It is not a parallel background subsystem and does not create a second completion turn.
_Avoid_: deep research job, research workflow, background research task, research mode

**Atlas Profile**:
The depth and duration setting for an **Atlas Turn**. Three profiles exist: **Overview** (Áttekintés), **In-Depth** (Részletes), and **Exhaustive** (Kimerítő). In v1 a profile controls search-query breadth, accepted web-source cap, stage output budget, and prompt posture; future profiles may also cap gap-fill rounds and claim-basis density. A profile changes budgets and posture, not the Atlas architecture, and quality gates are non-negotiable regardless of profile — even Overview cannot ship unsupported certainty.
_Avoid_: research depth, research mode, depth level, research tier

**Atlas Quality Gate**:
A non-negotiable check within the **Atlas Turn** pipeline that prevents unsupported certainty from shipping silently. If the gate requests retry, the pipeline performs one audit-driven revision pass before final rendering. If quality limits are exhausted but the source basis and rendering/storage can still produce a trustworthy artifact, the Atlas ships with prominent Limitations and evidence-derived **Atlas Basis Markers** rather than unsupported certainty. Only structural critical audit markers (such as zero accepted sources) fail the job; model-generated critical markers (such as misleading comparisons or multiplier mismatches) are downgraded to warnings so the pipeline proceeds to render with the audit addendum. This replaces the old Deep Research plan-approval gate: instead of checking a prediction upfront, it checks the actual output.
_Avoid_: plan approval, research checkpoint, pass checkpoint, coverage gate, hard fail on model-generated critical markers

**Atlas Honesty Marker**:
A v1 visible severity-coded indicator in an **Atlas** showing where the audit found source gaps, contradictions, language drift, or other verification concerns. Honesty Markers are derived from the **Atlas Basis** verification step, not from model self-assessment. They are superseded by **Atlas Basis Markers** in the planned claim-basis architecture: audit concerns should become unsupported or partially supported Basis Markers plus Limitations text, not a second competing marker system or a separate final report section.
_Avoid_: confidence badge, citation verdict, audit label, quality score

**Atlas Basis**:
The provenance contract for factual output in an **Atlas**: the assembled report is audited against the accepted source pool, search limitations, and local-source set before rendering. V1 stores compact audit markers and source metadata rather than a separate per-field evidence database. Future Atlas work may refine the same contract into **Atlas Claim Basis** objects for individual factual claims or dense factual passages. It is part of the output contract, not decorative metadata.
_Avoid_: citation list, evidence appendix, source ledger, audit trail

**Atlas Evidence Pack**:
A compact, structured evidence unit created from accepted **Atlas Web Sources** and **Atlas Local Sources** before final synthesis. An Evidence Pack groups what a source or evidence cluster supports, the relevant excerpt or summary, source authority, conflicts or limitations, and the report facet it helps cover. It is the model-facing memory for later Atlas stages and rounds; it is not a second persistence system or a raw search dump.
_Avoid_: evidence database, raw source pile, search dump, vector memory, citation pile

**Atlas Writer Evidence Card**:
A compact, final-writing evidence unit distilled from **Atlas Evidence Packs** for the report-writing step. It carries the source identity, authority, relevant facts, limitations, conflicts, and likely supported report sections in a form the model can synthesize from without rereading raw fetched pages. It is a writer input, not a rendered source appendix or durable evidence database.
_Avoid_: raw excerpt card, source dump card, vector memory card, citation pile

**Atlas Published Report**:
The reader-facing **Atlas** document body plus compact deterministic source projection. It should answer the user's request with useful synthesis, decision framing, tradeoffs, recommendations, limitations, and evidence-derived basis markers. It is not the place for long fetched-page excerpts, rejected-source diagnostics, or the research scratchpad.
_Avoid_: research scratchpad, source dump, raw evidence report, diagnostic appendix

**Atlas Evidence Appendix**:
An optional companion artifact or diagnostic view containing raw fetched excerpts, accepted/rejected source diagnostics, and other inspection material that would make the **Atlas Published Report** harder to read. It supports auditability without becoming the main report.
_Avoid_: main Sources section, published report body, model-authored bibliography

**Atlas Coverage Review**:
A bounded review inside one **Atlas Turn** where Atlas compares the intended report questions or outline against the current **Atlas Evidence Packs** and identifies high-value missing evidence. The model may propose gaps and concrete search targets, but the server decides whether a profile still allows another **Atlas Gap-Fill Round**.
_Avoid_: plan approval, autonomous planning loop, model-owned continuation, self-reflection loop

**Atlas Gap-Fill Round**:
A bounded adaptive **Atlas Research Round** that attempts to repair important coverage gaps before final synthesis. The model identifies missing angles and proposes targeted search needs, while the server controls the maximum number of rounds, search budgets, source curation, and stop conditions. A gap-fill round must not become an open-ended ReAct loop, a separate Atlas Turn, or a reason to make the user launch several Atlas jobs for one intended report.
_Avoid_: agent loop, ReAct research turn, infinite research, second Atlas job, manual follow-up job

**Atlas Claim Basis**:
A fine-grained support object for an individual factual claim, paragraph, or tightly scoped report section. It should expose cited evidence, a compact support rationale, and exactly one support level: supported, partial, or unsupported. Thin, stale, contested, and ambiguous evidence should fold into partial or unsupported depending on severity; a hallucinated fact or made-up logical connection is unsupported. Adjacent factual claims may share one Claim Basis when they depend on the same logical support rationale, but marker placement follows claim content rather than paragraph length. A large paragraph with several distinct factual claims may need several Claim Basis objects, including mid-sentence markers when a single important fact needs its own basis. It is derived from accepted evidence and **Atlas Basis** checks, not from hidden chain-of-thought or model self-confidence.
_Avoid_: confidence marker, model certainty badge, chain-of-thought tooltip, citation-only badge

**Atlas Basis Marker**:
The compact report UI affordance that exposes **Atlas Basis** details in the report body or near a report section. It is the future umbrella marker surface for both ordinary **Atlas Claim Basis** support and audit-concern states that v1 calls **Atlas Honesty Markers**. It has exactly three visual states: supported, partial, and unsupported, using the existing success/warning/danger palette. The default marker is color-only: a small colored dot/blob/swatch with no icon and no visible text, since source favicons already carry icon weight in the report. Hover, focus, or tap reveals a compact panel whose first line is exactly "Supported claim", "Partially supported claim", or "Unsupported claim", and whose second line is a single compact source-based support rationale.
_Avoid_: confidence pill, inline text badge, bulky marker, always-visible rationale, decorative citation icon

**Atlas Source Projection**:
The deterministic Sources section and source-chip rendering generated from accepted **Atlas Web Sources**, **Atlas Local Sources**, and structured source/basis metadata. The default projection in an **Atlas Published Report** should be compact: enough to identify the source and why it matters, not a long raw excerpt dump. The model may emit source rationale and desired claim/source associations as structured data for Atlas to validate and render, but it must not write its own Markdown Sources section above or beside the canonical Sources section.
_Avoid_: model-authored sources section, duplicate sources section, prose bibliography, freeform citation appendix

**Atlas Report Opening**:
The deterministic opening structure of an **Atlas**. The model-generated report title is the canonical Atlas title and appears once in the app-owned report chrome/header. The model must not emit a second title, subtitle, or alternate H1/H2 immediately below it. The first accented content section after the app-owned title should be the Executive Summary. A query-derived or job-derived title is only a fallback when no valid model-generated title exists.
_Avoid_: duplicate report title, model-authored title block, secondary title, alternate title, decorative subtitle heading

**Atlas Generated Title**:
The single model-generated title for an **Atlas**, produced as structured report metadata rather than as a body heading. Atlas uses it for the report chrome/header, file label, and generated-document title. If the model also emits the same or alternate title in the report body, that body title is removed so the content begins with Executive Summary.
_Avoid_: query-derived title, truncated prompt title, body heading title, title reconciliation, competing report title

**Atlas Research Round**:
The durable checkpoint unit for an **Atlas Turn**. V1 writes one completed round checkpoint after audit and before deterministic rendering, containing the curated source pool, compressed findings, usage, quality diagnostics, and document-source summary. Future multi-round expansion should keep this vocabulary for initial and gap-fill rounds rather than adding stage-local persistence or treating each gap-fill round as a separate Atlas Turn.
_Avoid_: research pass, workflow pass, iteration, cycle

**Atlas Continue**:
A lifecycle action that extends an existing **Atlas** with more research. It creates a new version in the same document family, seeded with the previous Atlas's compressed findings and curated sources. The new **Atlas Turn** builds on what was already found rather than starting from scratch.
_Avoid_: research further, extend research, resume research

**Atlas Fork**:
A lifecycle action that starts a new **Atlas** with a modified or related query from the same conversation. It creates a new document family, optionally seeded with the previous Atlas's findings. The original Atlas remains unchanged.
_Avoid_: branch research, alternative research, split research

**Atlas Revise**:
A lifecycle action that re-runs an **Atlas** with fresh searches, producing a new version in the same document family. The old version remains in document history. The new Atlas is aware of the previous structure but re-searches to catch updated or changed information.
_Avoid_: update research, refresh research, re-run research

**Atlas Progress Indicator**:
The user-facing progress surface for an in-progress **Atlas Turn**. It shows the Atlas label, a kickoff orbit/running ring animation, and cycling human-readable status messages rather than literal pipeline stage labels, since the stages repeat across rounds. After decompose completes, it may show the sanitized research questions driving the search stage for transparency. The user can leave, close, or reload the page and return to see current progress.
_Avoid_: research card, step tracker, stage progress bar, polling panel

**Atlas Resume**:
The behavior where a failed or retried **Atlas Turn** preserves its durable checkpoint and job state rather than losing the completed audited source/report summary. V1 retry behavior reruns the bounded pipeline from the job and parent/checkpoint context; explicit cancellation discards partial state and does not resume.
_Avoid_: research restart, checkpoint restore, paused job resume, cancelled job resume

**Atlas Cost Summary**:
The accumulated token and cost measurements for one completed **Atlas Turn**, stored on the Atlas job and shown after completion where Atlas job details are rendered. It aggregates usage from model calls across all stages and rounds, including audit and audit-revision calls. Cost may be zero when the provider/model runtime does not expose pricing, but token usage is still stored. It is not shown during execution since the user may have left the page.
_Avoid_: hidden pass cost, per-stage cost breakdown, research usage meter, live cost ticker

**Atlas Concurrent Limit**:
The cap on how many **Atlas Turns** may run simultaneously. One active Atlas job per user; a global admin-configurable limit (default 2) prevents all server resources from being consumed by Atlas jobs. This is separate from **Normal Chat** stream limits because Atlas jobs are background work, not held stream slots.
_Avoid_: research job queue, active research limit, per-day quota, monthly quota

**Atlas Local Source**:
A **Library Document** from the user's Knowledge Library or active working set that the **Atlas Turn** includes in its source pool alongside web sources. **Linked Context Sources** and composer attachments that the user explicitly selected for the Atlas Turn are snapshotted to the kickoff user message and become Atlas Local Sources with the highest authority boost. Readable active working-set documents and parent Atlas seed sources may be included automatically with lower authority. They appear in the Atlas under a "Your Library" subsection of the Sources section.
_Avoid_: knowledge attachment, uploaded research input, library artifact citation

**Atlas Web Source**:
A web page discovered through SearXNG during the **Atlas Turn** search stage. Web sources are the primary source pool for an Atlas and appear in the Atlas under a "Web Sources" subsection of the Sources section.
_Avoid_: search result, fetched page, web citation

**Atlas Completion Notice**:
The set of signals that tell a user an **Atlas** has finished compiling. Three layers: on-page progress card updates in real-time via polling; conversation list sidebar shows an unseen-completion badge on a conversation with a newly completed Atlas when the user navigates within AlfyAI; browser push notification fires when the Atlas completes and the user has left AlfyAI entirely. The sidebar badge is not a permanent marker: it does not show for the currently open chat, and opening the chat marks that specific completed Atlas badge as seen while allowing later Atlas completions in the same chat to show a fresh badge. Browser push requires a one-time permission prompt and uses the Web Push API with VAPID keys.
_Avoid_: research notification, Atlas email alert, separate notification center

### Relationships

- An **Atlas** is produced by an **Atlas Turn**, which is a special kind of **Normal Chat Turn**.
- An **Atlas Turn** uses **Normal Chat Turn Completion** for its kickoff assistant message and persists background completion state on the Atlas job. It does not bypass conversation persistence or generated-file linking, but it does not create a second analytics/task-state completion event. The generated Atlas content is assistant prose and is not automatically admitted to durable memory.
- An **Atlas Profile** changes search breadth, accepted-source cap, stage output budget, and prompt posture, but **Atlas Quality Gates** are non-negotiable regardless of profile.
- **Atlas Honesty Markers** are the v1 audit-concern marker concept. The claim-basis architecture should supersede them with **Atlas Basis Markers** and should remove the separate final Honesty Markers report section.
- **Atlas Claim Basis** is the fine-grained future extension of **Atlas Basis** for ordinary factual claims.
- **Atlas Basis Markers** are the preferred future marker surface for both ordinary claim support and audit-concern states. **Atlas Honesty Marker** remains the v1/audit-domain term and should fold into Basis Marker rendering rather than become a parallel UI system.
- **Atlas Basis Markers** use only three support states: supported, partial, and unsupported. They are placed by logical claim content, not by paragraph length alone.
- **Atlas Evidence Packs** are the bridge between curation and synthesis. They give later stages structured, source-grounded material without creating a parallel evidence database.
- **Atlas Writer Evidence Cards** distill Evidence Packs into compact final-writing inputs. They help the model write a useful **Atlas Published Report** without receiving or rendering a raw source pile.
- **Atlas Source Projection** owns the rendered Sources section. Model-authored Sources sections are invalid output and should be replaced by deterministic source chips/sections built from accepted sources and structured metadata.
- An **Atlas Published Report** is the main reader-facing artifact. Raw fetched excerpts and source diagnostics belong in an **Atlas Evidence Appendix** or diagnostic surface when needed, not in the default published report body.
- **Atlas Generated Title** is the canonical report title. **Atlas Report Opening** renders it once through app-owned chrome/header, and model-authored content should begin with Executive Summary rather than a second title block.
- **Atlas Coverage Review** and **Atlas Gap-Fill Rounds** are bounded adaptive work inside one **Atlas Turn**. The model may judge what is missing; the server owns whether another round may run.
- **Atlas Profiles** may cap the number of **Atlas Gap-Fill Rounds** differently, but they must not introduce different execution graphs. Overview, In-Depth, and Exhaustive remain the same Atlas architecture with different budgets and posture.
- An **Atlas** can be continued (**Atlas Continue**), branched (**Atlas Fork**), or refreshed (**Atlas Revise**) — each creates a new **Atlas Turn** with different seeding.
- **Atlas Continue** and **Atlas Revise** produce new versions in the same document family; **Atlas Fork** creates a new document family.
- An **Atlas Turn** persists an **Atlas Research Round** checkpoint after audit and before rendering; future multi-round expansion should use the same checkpoint vocabulary.
- An **Atlas** is stored and previewed through the existing file-production and document-workspace infrastructure, not through a separate research-specific UI.
- A failed **Atlas Turn** preserves durable job/checkpoint state for **Atlas Resume** behavior; cancelled jobs do not resume.
- An **Atlas Turn** tracks model usage across all model calls; the **Atlas Cost Summary** is shown to the user after completion, with cost set to zero when provider pricing is unavailable. Atlas pipeline costs are also recorded as **Usage Events** so they appear in the analytics dashboard and **Context Usage Ring** alongside Normal Chat costs.
- The **Atlas Concurrent Limit** allows one active Atlas per user and a global admin-configurable limit. Excess jobs queue, they are not rejected.
- An **Atlas** draws on both **Atlas Web Sources** (SearXNG) and **Atlas Local Sources** (explicit linked sources, composer attachments, active working-set documents, and parent Atlas seed sources). Memory is background context, not a citable source.
- An **Atlas Completion Notice** fires through three layers: on-page progress polling, sidebar badge on conversation list refresh, and browser push notification when the user has left AlfyAI.
- An **Atlas** ships a full report when it has a trustworthy source basis, even when evidence is thin. The **Limitations** section and **Atlas Basis Markers** communicate evidence quality honestly. Only structural critical quality-gate failures (such as zero accepted sources) fail the Atlas Turn; model-generated critical audit markers are downgraded to warnings so the report ships with caveats instead of being discarded.
- **Atlas Lifecycle Actions** (Continue, Fork, Revise) require the parent Atlas job to have `status: "succeeded"`. The server validates this before creating the new job and before loading the parent seed.

### Example dialogue

> **Dev:** "Should an Atlas Turn create a separate background worker like the old Deep Research did?"
> **Domain expert:** "No. An Atlas Turn is a Normal Chat Turn. It creates a job for the long-running research, but the turn itself goes through Normal Chat Turn Completion. The user can leave and come back."
>
> **Dev:** "If the user picks Overview, can the pipeline skip the audit stage to finish faster?"
> **Domain expert:** "No. Atlas Quality Gates are non-negotiable. Overview uses a smaller output budget and lighter prompt posture, but it still cannot ship unsupported certainty. That's what killed the old pipeline — it would finish with gibberish."
>
> **Dev:** "Should the user approve a research plan before the Atlas Turn starts?"
> **Domain expert:** "No. The pipeline just runs. The quality gates replace plan approval — they check the actual output, not a prediction. Users rubber-stamped plans anyway."
>
> **Dev:** "If two sources contradict each other, should the Atlas pick one?"
> **Domain expert:** "No. It should mark the conflict with a partial or unsupported Atlas Basis Marker and explain it in the Limitations section. The Atlas Basis for that claim should show both sources and the compact support rationale."
>
> **Dev:** "Is an Atlas a chat message or a file?"
> **Domain expert:** "It's a file. A durable, navigable report artifact — HTML, PDF, and Markdown. It appears as a file-production card in the chat and opens in the document workspace."
>
> **Dev:** "Should gap fill be deterministic so production is predictable?"
> **Domain expert:** "The orchestration should be deterministic; the gap judgment should be adaptive. The model identifies missing angles and search targets, while Atlas limits how many rounds can run and how sources are curated."
>
> **Dev:** "If one gap-fill round is not enough, should the user run another Atlas manually?"
> **Domain expert:** "No. Profiles may allow bounded gap-fill rounds inside the same Atlas Turn. When the cap is exhausted, Atlas ships honest limitations rather than turning one report request into several user-managed jobs."
>
> **Dev:** "If every factual section needs support markers, should they be visible text badges after every sentence?"
> **Domain expert:** "No. Use compact Atlas Basis Markers. They can be textless in the reading flow, with support rationale and evidence available on hover, focus, or tap."
>
> **Dev:** "Can the model add a Sources section before the deterministic backend Sources section?"
> **Domain expert:** "No. The model may emit structured source rationale and claim/source associations, but Atlas Source Projection renders the canonical Sources section deterministically."
>
> **Dev:** "Should the model repeat the report title below the app-owned title?"
> **Domain expert:** "No. Atlas Report Opening owns the title. The first accented content section should be Executive Summary."
>
> **Dev:** "What if the query-derived job title is truncated?"
> **Domain expert:** "Use the model-generated Atlas title as the canonical title. Query-derived titles are fallback labels, not the final report title."

## Connections

### Language

**Connection**:
A single external account a user has linked to AlfyAI (one login), such as a Google account, a Nextcloud server, or a mailbox. A **Connection** belongs to exactly one user and is the unit shown as one row in the Connections settings list. One provider may have several **Connections** (multiple accounts).
_Avoid_: integration, account link, provider (a provider is the service type, not the user's linked account), data source

**Capability**:
A kind of data or action a **Connection** can serve — calendar, files, email, photos, media, location, or contacts. Capabilities are per-connection and toggleable. One **Connection** (e.g. a Google login) can serve several capabilities.
_Avoid_: scope, permission, feature, tool (a tool is the chat-facing surface a capability powers)

**Account**:
The external identity (email address or username) a **Connection** authenticates as, used to disambiguate when a user has more than one **Connection** for the same provider. Disambiguation between accounts is resolved by the assistant in chat and learned into memory — it is never a composer control.
_Avoid_: profile, user (the AlfyAI user is distinct), identity

**Connections Toggle**:
The single per-conversation on/off control in the composer that permits the assistant to use the user's default-on **Connections** for that turn. When on, the assistant decides *which* connections and capabilities to use; when off, none are used. It is a trust-the-assistant switch, not per-capability control, and lives as one icon in the composer row beside the incognito toggle — never as per-capability rows in the plus menu. Defaults on.
_Avoid_: capability toggles, per-tool switches, connection picker, plus-menu connection rows

**Default-on Capability**:
A **Capability** marked to be available by default when the **Connections Toggle** is on. Which capabilities are default-on is set per-connection in Settings, not in the composer — the composer only carries the single master **Connections Toggle**.
_Avoid_: enabled tool, active capability (active = default-on AND the toggle is on for this turn)

**Alfy Email**:
The on-box mailbox connect path for accounts hosted on AlfyAI's own mail server (Virtualmin-managed, one machine, many domains). Because the server host/port/TLS are predictable, connecting an **Alfy Email** account is near-zero-config: the user supplies only their email address and password. Distinct from the Gmail & Other (IMAP) path, which needs manual or provider-specific setup.
_Avoid_: AlfyWS Email, local mail client, on-box IMAP form

**Connection Detail**:
The full-screen modal overlay for one **Connection**'s settings — capabilities, default-on, allow-writes (with the reversible/allowlist explainer behind the shared info tooltip), folder allowlist, and disconnect. It overlays the Connections list on top; it does not replace the row or expand it inline. The list row itself stays glance-only (brand icon, account, capability mini-icons, status) with quick icon actions.
_Avoid_: settings accordion, inline expander, connection card (the fat always-expanded card is the rejected prototype)

**Data Locality**:
Keeping a user's connected-account data on AlfyAI's own infrastructure — processing it with a local model before any third-party cloud model can see it (Option A), or warning the user the first time connected data would reach a third-party cloud model (Option C). The settings surface for this must plainly say it keeps connected-account data private/on-device; the prototype title "Adatvédelem és adatkezelés helye" is rejected as unclear.
_Avoid_: locality guard (internal term), Option A/Option C (internal labels — not user-facing copy), data residency

## Flagged ambiguities

- "canonical" was a term from the deleted Deep Research subsystem. It is historical and should not be used for Atlas or any current feature.
- "finished chat" and "Report Boundary" were concepts from the deleted Deep Research subsystem (a sealed conversation after a research report). They are historical — Atlas does not seal conversations.
- "research" in AlfyAI now refers to the live `research_web` Normal Chat tool (single-turn web search) unless prefixed with "Atlas" — an **Atlas** is the durable report, not a search result.
- "report" without qualification could mean any generated file; an **Atlas** is a specific kind of research report with navigation, deterministic source attribution, and evidence-derived Basis Markers.
- "multi-turn Atlas pipeline" is ambiguous. Prefer **multi-round Atlas Turn** when one user kickoff owns several **Atlas Research Rounds** inside the same **Atlas Turn**; reserve "multiple Atlas Turns" for explicit lifecycle actions such as **Atlas Continue**, **Atlas Fork**, and **Atlas Revise**.
- "confidence marker" is ambiguous in Atlas language. Use **Atlas Basis Marker** for the future compact marker UI surface. Use **Atlas Honesty Marker** only when referring specifically to v1 audit-derived concern data or the current concern-marker behavior. Both must stay evidence-derived rather than model self-assessment.
- "deterministic gap fill" is ambiguous. Prefer **bounded adaptive gap-fill**: adaptive LLM judgment for missing evidence, deterministic server orchestration for round count, search budgets, curation, and stop conditions.
- "Sources section" in Atlas means the deterministic **Atlas Source Projection**, not a model-authored Markdown section.
- "report title" in Atlas means the **Atlas Generated Title** rendered once by **Atlas Report Opening**, not a query-derived fallback label or a model-authored duplicate body heading.
- "duplicate title cleanup" should mean removing title-like body blocks from the opening region after the generated title has been projected into app-owned chrome, not evaluating competing title quality.
