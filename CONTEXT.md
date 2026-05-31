# AlfyAI Product Context

AlfyAI is a conversational workspace where users can chat casually, use tools, work with files, and optionally start deeper background research tasks. This context captures product-domain language that should stay stable across implementation choices.

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

**Normal Chat Turn Completion**:
The point where an assistant response becomes durable conversation state, including persisted messages, response-facing **Context Sources**, message evidence, skill state changes, and continuity side effects for that turn.
_Avoid_: route response assembly, stream end event, post-send cleanup

**Normal Chat Completion Boundary**:
The app-owned boundary that decides the durable result of **Normal Chat Turn Completion** before transport adapters expose it as JSON, SSE, refreshable conversation detail, or visible chat UI state.
_Avoid_: deep module, route-local completion, stream-only finalization

**Browser SSE Protocol**:
The browser-facing streaming transport contract for **Normal Chat** stream and reconnect responses, including the allowed SSE event names, payload shapes, encoding, and decoding rules owned by `src/lib/services/stream-protocol.ts`.
_Avoid_: Langflow stream, Normal Chat Turn Completion, route-local event string

**Normal Chat Client Turn Runtime**:
The browser-side plain TypeScript boundary at `src/lib/client/normal-chat-client-turn-runtime.ts` that owns Normal Chat send, retry, reconnect, waiting, stop, queued follow-up, and recovery runtime semantics above `streamChat`. It consumes decoded stream callbacks and server-returned metadata through page adapters while the chat page keeps visible Svelte state, route lifecycle, document workspace state, and UI commands.
_Avoid_: Browser SSE parser, Context Sources builder, chat page state, durable completion

**Memory Access**:
AlfyAI's ability to use durable user, conversation, project, document, and research context through Honcho-led memory and app-supplied historical context retrieval.
_Avoid_: local persona engine, memory replacement, transcript dump

**Context Access**:
The production capability that lets AlfyAI discover, select, and use relevant memory, history, project, document, and research context without requiring low-level manual setup from the user.
_Avoid_: tool collection, retrieval demo, manual context setup

**Memory Context Tool**:
The model-facing retrieval tool for asking AlfyAI what durable memory or historical context is relevant to the current turn.
_Avoid_: project-only tool, persona-memory tool, transcript search tool

**Baseline Memory Profile**:
A compact Honcho-led personalization profile available to an ordinary chat turn before the model decides whether to retrieve deeper memory.
_Avoid_: newest memories, raw conclusion list, local persona summary

**Knowledge Memory Overview**:
The user-facing Memory Profile summary in the Knowledge Base. It should read as human-readable memory notes that explain what AlfyAI understands about the user, not as raw markdown, transcript metadata, conversation result logs, or a report outline.
_Avoid_: memory markdown, Honcho dump, conversation results list, generated report

**Knowledge Memory Overview Bullet**:
A concrete, human-readable statement about the user, their preferences, owned things, goals, constraints, current projects, or durable personal context. It may include specific remembered items when they help the user understand what AlfyAI knows, but it should not cite retrieval provenance such as chat numbers, conversation titles, or result counts.
_Avoid_: chat mention, conversation provenance, source inventory, result summary

**Memory Provenance Noise**:
Source metadata that may be useful internally but should not appear as the main text of a **Knowledge Memory Overview Bullet**, including timestamps, chat numbers, conversation titles, result counts, and section labels like "Explicit Observations".
_Avoid_: visible timestamp, chat title, generated result count, raw Honcho section label

**Sensitive Memory Value**:
Exact personal or security-sensitive values such as phone numbers, email addresses, physical addresses, account identifiers, credentials, tokens, and keys. A Knowledge Memory Overview may soften these values when they appear in otherwise useful bullets, but it should not become a separate memory policy engine that suppresses broad categories of legitimate Honcho memory.
_Avoid_: raw phone number, exact credential, exposed token, overzealous memory filtering

**Context Sources**:
The user-facing surface that shows documents, attachments, memory, prior turns, generated work, and other sources AlfyAI is considering or carrying forward.
_Avoid_: evidence manager, manual retrieval setup, budget manager

**Message Evidence**:
The user-facing audit of sources used or cited for one assistant message.
_Avoid_: context sources, carried-forward context, context manager

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

**Project Folder Awareness**:
Compact awareness of other conversations that belong to the same **Project Folder**.
_Avoid_: folder dump, all project chats, sibling transcript context

**Project Continuity Awareness**:
Compact awareness of other conversations or tasks linked to the same inferred **Project Continuity**.
_Avoid_: global chat search, folder awareness, all memory

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
_Avoid_: prompt shortcut list, agent tool registry, Deep Research command system

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
_Avoid_: hidden mode, background agent, Deep Research job

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
- **Normal Chat Turn Completion** ends a **Normal Chat Turn** by turning assistant output into durable conversation state and response-facing **Context Sources**.
- Transport surfaces may expose the result of **Normal Chat Turn Completion**, but they should not redefine what completion means.
- The **Browser SSE Protocol** exposes streaming, replay, waiting, completion, and error transport events for **Normal Chat**, but it does not own durable turn completion.
- **Browser SSE Protocol** event names and payload shapes should change only at the shared stream-protocol boundary with protocol tests.
- The **Normal Chat Client Turn Runtime** sits above `streamChat`: it reacts to decoded Browser SSE callbacks, but it does not parse Browser SSE event strings or define protocol grammar.
- The **Normal Chat Client Turn Runtime** applies server-returned metadata through chat-page adapters; it does not build **Context Sources** or decide **Normal Chat Turn Completion**.
- The chat page owns visible Svelte state, route lifecycle, document workspace state, and UI commands; the **Normal Chat Client Turn Runtime** owns browser-side turn transitions and queue recovery rules.
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
- `/` command current state should appear for values such as current model, style, thinking mode, Deep Research mode, or linked-source count.
- `/` rows may use familiar action icons when they improve scanning.
- A **Composer Command** should mutate explicit app state, attach or link context, or open a user-visible flow rather than paste hidden instructions into the message.
- Command prefix text should be consumed only after the user explicitly selects a **Skill** or **Composer Command**.
- If a user sends text containing `$` or `/` without selecting a **Command Suggestion Row**, AlfyAI should treat that text as ordinary user message content.
- Selecting a **Skill** or **Composer Command** should preserve non-command message text already typed around the command.
- Users may combine one pending or active **Skill**, multiple **Linked Context Sources**, uploaded attachments, and composer setting commands in one Normal Chat turn.
- While a Normal Chat response is streaming, new command-derived composer state should apply only to the next queued turn, not the in-flight assistant response.
- Starting a durable **Skill Session** while streaming should start with the queued turn that carries that skill, not mutate the response currently being generated.
- If a queued turn already exists, changing command-derived state should require editing or replacing that queued turn rather than silently stacking another queued payload.
- V1 should allow only one pending or active **Skill** at a time; selecting another **Skill** should require replacing, finishing, or dismissing the current one.
- If **Deep Research Mode** is selected through `/research`, Normal Chat **Skill Sessions** should not apply to that turn.
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
- A **Skill** may shape the next Normal Chat behavior, but it is not a Langflow tool and should not be treated as a Deep Research mode.
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
- The v1 composer **Composer Command** catalog includes `/model`, `/style`, `/thinking`, `/attach`, `/document`, `/source`, `/skill`, `/settings`, `/clear`, and `/research`.
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
- `/research` is a thin bridge to the existing **Deep Research Mode** composer control when that feature is enabled.
- `/research` does not use **Skill Sessions**, **Skill Notes**, **Skill Drafts**, or **Linked Context Sources**, and does not change the **Deep Research Job** lifecycle.
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
- `/model`, `/style`, and `/thinking` should update the same current composer settings used by the existing composer tools, not create a separate one-turn override system.
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
- This **Composer Command Registry** v1 is scoped to **Normal Chat** and does not change the **Deep Research Job** lifecycle.
- **Context Sources** explains and steers automatic context selection; it should not make the user manually budget context.
- **Context Sources** may expose pin and exclude controls as optional overrides.
- Pinning or excluding a **Context Source** is scoped to the current conversation or task by default.
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
- Active **Context Sources** include current attachments, pinned sources, open or current documents, current generated documents, and strong task sources.
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
- Hierarchical **Context Compression** should chunk by natural source boundaries such as message pairs, tool call/result pairs, document sections, web/research excerpts, and log sections rather than arbitrary token slicing whenever possible.
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
- `src/lib/server/services/langflow.ts` may request constructed Prompt Context from the chat-turn boundary and may add model-facing runtime guidance, but it should not rebuild candidate promotion or inclusion policy.
- Individual subsystems may supply **Available Context** and **Context Signals**, but should not independently force large text into **Prompt Context**.
- **Memory Access** should extend Honcho-led memory rather than replace it with a parallel local persona-memory system.
- **Memory Access** may make historic chat details available for retrieval, but historic chats become **Prompt Context** only through **Context Selection** or an explicit model-facing retrieval result.
- A **Memory Context Tool** should consolidate project, persona, and history retrieval so model-facing memory access does not fragment into overlapping tools.
- Replacing a project-only memory retrieval tool with the **Memory Context Tool** should remove the old model-facing tool rather than keep overlapping compatibility surfaces.
- **Memory Access** sizing should scale with the configured model and runtime capacity; small fixed counts are operational guardrails, not the product definition of what AlfyAI can remember.
- A **Memory Context Tool** should preserve breadth with lightweight summaries before spending large budget on deep conversation or memory detail.
- When **Memory Access** omits matching memories or historical context because of a limit, the result should disclose the applied limit and omitted count.
- Historic chat recall through a **Memory Context Tool** should start from existing conversation summaries and bounded message search before adding new persistent memory structures.
- A **Baseline Memory Profile** should come from Honcho-led synthesis rather than a newest-N raw conclusion list.
- Deeper persona recall belongs in the **Memory Context Tool**, while the **Baseline Memory Profile** gives every normal chat turn enough personalization to start well.
- A **Baseline Memory Profile** is **Protected Context** but not unlimited; it should shrink under genuine budget pressure before it disappears.
- For a small trusted deployment with large-context models, **Baseline Memory Profile** defaults should be generous rather than cost-minimized.
- **Baseline Memory Profile** budget should derive from model-scaled context with a generous floor and configurable ceiling, rather than from a small fixed token cap.
- The first **Memory Context Tool** should cover project, persona, and history retrieval; it should not become a universal document search replacement in the same slice.
- **Context Access** v1 should make memory and document context reliable together; fixing memory retrieval while leaving Knowledge Library document selection dependent on exact filenames or manual `/document` selection is not a production-quality slice.
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

## Knowledge Library Context

### Language

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

**Generated File**:
A downloadable file produced by AlfyAI during chat.
_Avoid_: uploaded document, attachment, artifact

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
- Every **File Production Request** enters **File Production Intake** before renderer, sandbox, or storage work begins.
- **File Production Intake** creates or reuses durable **File Production Card** state; it is not a stream-only or tool-specific concern.
- A malformed **File Production Request** still produces a durable failed **File Production Card** through **File Production Intake** when enough conversation ownership is known.
- The public file-production facade delegates to deep modules; callers should import the facade unless they are inside the file-production boundary or are read-only conversation detail code that needs **File Production Read Model** without loading worker/rendering/storage modules.
- **File Production Job Ledger** is the durable state authority for **File Production Cards** and attempts; renderers, routes, and worker code should not reimplement job state transitions.
- **File Production Read Model** is the projection authority for conversation-visible **File Production Cards**; it may hydrate job-linked unassigned files for finalization, but public generated-file lists and direct preview/download routes still require an assigned assistant message.
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
- Non-document outputs such as raw data files, code files, images, or bundles may remain **Generated Files** without entering generated-document version history.
- A **Filename Conflict** creates an **Auto-Renamed Upload**.
- A **Filename Conflict** does not create a **Generated Document Version**.
- An **Auto-Renamed Upload** remains a separate **Uploaded Document**.
- Uploaded documents do not form user-visible version history in v1.
- A **Generated Document Family** may contain one or more **Generated Document Versions**.
- A **Working Document** may point to either a **Library Document** or a **Generated Document**.
- **Working Document Identity** owns purpose-specific artifact ids for **Working Documents**; callers should request display, prompt, preview/file-serving, or family identity instead of inspecting `displayArtifactId`, `promptArtifactId`, and `familyArtifactIds` directly.
- **Working Document Selection** owns live per-turn signal collapse for **Working Documents**; callers should request its prompt, working-set, retrieval, and task-evidence views instead of re-deriving active focus, correction target, current-generated, recent-refinement, or reset rules locally.
- `document-resolution.ts` remains the generated-document family ranking authority. **Working Document Selection** consumes that ranking to decide the live current/generated carryover view; it does not replace generated-family identity or version ordering.
- **Document Workspace** and Knowledge preview/download routes use **Working Document Identity** preview/file-serving identity so source-plus-normalized documents open the display file while text-only documents degrade deliberately.
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

## Deep Research Context

### Language

**Deep Research Job**:
A user-started background research task that plans, gathers sources, synthesizes findings, and produces a cited report.
_Avoid_: agent, flow, chat turn, automatic search, standard report generation

**Normal Chat**:
The default conversational mode where the user can ask questions and the assistant may use available tools within the ordinary chat turn.
_Avoid_: shallow chat, basic mode

**Deep Research Mode**:
An explicit chat composer setting that causes the next user request to start a **Deep Research Job** instead of a **Normal Chat** turn.
_Avoid_: auto research, agent mode, report mode

**Report Boundary**:
The point after a **Deep Research Job** completes with a **Research Report** or **Limited Research Report** where its conversation becomes read-only and further discussion must start from the completed report in a new conversation.
_Avoid_: finished chat, dead chat, context lock, archive

**Report Action**:
An allowed interaction with a completed **Research Report** or **Limited Research Report** after a **Report Boundary**, such as opening, inspecting sources, exporting, or starting a new conversation from it.
_Avoid_: follow-up turn, continued chat

**Discuss Report**:
A **Report Action** that starts a new **Normal Chat** using the completed report as context.
_Avoid_: reopen chat, continue chat

**Research Further**:
A **Report Action** that starts a new **Deep Research Job** using the completed report as context.
_Avoid_: follow-up turn, continue research

**Memo Recovery Action**:
A structured action offered after an **Evidence Limitation Memo**, such as revising the plan, adding sources, choosing deeper depth, or starting a new **Deep Research Job** from the grounded limitation state.
_Avoid_: report action, failed-job retry, prose suggestion only

**Research Plan**:
A user-reviewable outline of the questions, source scope, and expected report shape for a **Deep Research Job**.
_Avoid_: hidden prompt, agent thoughts, execution plan

**Plan Edit**:
A freeform user instruction that asks AlfyAI to revise a **Research Plan** before research starts.
_Avoid_: advanced plan form, parameter editor

**Plan Normalization Note**:
A compact user-facing note shown on a **Research Plan** when AlfyAI safely reinterprets or narrows the requested report shape before approval, such as treating unnamed option-category comparison as candidate discovery.
_Avoid_: debug warning, model parser detail, hidden classifier result

**Plan Health Check**:
A cheap diagnostic check run when research progress suggests the approved **Research Plan** itself may be poisoned, mis-scoped, or internally inconsistent rather than merely under-evidenced.
_Avoid_: citation audit, source review, user blame, hidden failure

**Research Plan Revision Needed**:
A terminal Deep Research outcome produced when a **Plan Health Check** finds that the approved **Research Plan** was likely poisoned or mis-scoped and should be corrected before further source-heavy research.
_Avoid_: Evidence Limitation Memo, failed job, normal report, silent retry

**Focused Deep Research**:
A Deep Research depth for narrow questions that still need deliberate multi-pass research and a cited brief without broad source exploration.
_Avoid_: short, quick, shallow, normal web search

**Standard Deep Research**:
The default Deep Research depth for serious multi-source synthesis.
_Avoid_: normal chat, regular chat

**Max Deep Research**:
The highest Deep Research depth for broad or high-stakes investigations that may inspect hundreds of sources.
_Avoid_: exhaustive mode, unlimited research

**Planning Context**:
Relevant user or workspace context used to draft a better **Research Plan** before research starts.
_Avoid_: source, evidence, citation

**Research Source**:
A source that a **Deep Research Job** may read, analyze, cite, or use as evidence in the final report.
_Avoid_: context, memory, hint

**Research Report**:
The completed, cited output produced by a **Deep Research Job** when the evidence is strong enough to answer the approved **Research Plan** as a normal report.
_Avoid_: assistant answer, generated file, summary, chat response

**Limited Research Report**:
A completed, cited **Deep Research Job** output produced when some useful evidence exists but the approved **Research Plan** cannot be fully answered with normal-report confidence. It gives the best supported answer, narrows or omits unsupported sections, and makes the evidence limits visible.
_Avoid_: Evidence Limitation Memo, partial draft, failed report, padded report

**Readable Research Report**:
A **Research Report** organized for scanning and decision-making, with a short title, answer-first executive summary, capped key findings, plan-shaped analysis, visible limitations, and a cited source list.
_Avoid_: source dump, activity log, citation audit transcript, raw findings export

**Decision Brief**:
The default reading shape of a **Readable Research Report**: an answer-first, scan-friendly report that foregrounds the practical conclusion, recommendation, or comparison outcome before audit detail.
_Avoid_: transcript, exhaustive research log, source ledger as main body

**Structured Research Report**:
A machine-checkable report model that AlfyAI renders into Markdown or another user-facing format.
_Avoid_: markdown blob, prose-only draft, raw report text

**Structured Report Block**:
An app-owned, typed part of a **Structured Research Report**, such as a summary, finding list, matrix, rubric, timeline, evidence table, limitation, or appendix section.
_Avoid_: raw Markdown chunk, model-owned layout instruction, untyped prose field

**Report Shape Template**:
An intent-specific structure used to assemble a **Structured Research Report** while preserving a shared readable core.
_Avoid_: universal report skeleton, markdown theme, writer preference

**Comparison Matrix**:
The primary scan surface for a comparison-oriented **Decision Brief**, organized by **Compared Entity** and central **Comparison Axis** so the reader can compare evidence-backed differences before reading prose detail.
_Avoid_: decorative table, prose recap table, source-note grid

**Decision Meaning**:
The comparison-matrix explanation of why a difference matters for the user's choice, use case, recommendation, or next action.
_Avoid_: neutral restatement, citation note, hidden scoring rationale

**Evidence Confidence Cue**:
A compact user-facing phrase inside a **Decision Brief** that explains the evidence basis only when it changes interpretation, such as official spec, vendor claim, dated price observation, independent review, or owner report.
_Avoid_: internal audit verdict, full source-quality dump, confidence decoration on every fact

**Report Visual Aid**:
A table, matrix, chart, timeline, rubric, or other structured reading aid used by a **Report Shape Template** when it improves comprehension of supported claims.
_Avoid_: decorative chart, infographic filler, visual polish unrelated to evidence

**Comparison Report Shape**:
A **Report Shape Template** for comparing known **Compared Entities** across central **Comparison Axes**, led by an answer, a **Comparison Matrix**, decision meaning, caveats, and cited sources.
_Avoid_: parallel prose specs, feature dump, generic analysis section

**Recommendation Report Shape**:
A **Report Shape Template** for choosing or prioritizing options, led by the recommendation, ranked options, criteria rubric, fit and risk table, and next actions.
_Avoid_: unordered option list, unsupported ranking, advice without criteria

**Investigation Report Shape**:
A **Report Shape Template** for explaining what happened, why, or what is most plausible, led by the answer, timeline or causal map, competing explanations, confidence, and open questions.
_Avoid_: chronology dump, single-cause overclaim, unresolved speculation as fact

**Market/Product Scan Report Shape**:
A **Report Shape Template** for surveying options, vendors, products, prices, or market signals, led by the answer, shortlist table, evaluation rubric, freshness or pricing notes, and watchouts.
_Avoid_: search result list, catalog dump, stale availability claim

**Evidence Review Report Shape**:
A **Report Shape Template** for summarizing what evidence supports or disputes a question, led by the answer, evidence strength table, consensus or conflict map, and limitations.
_Avoid_: annotated bibliography, source-by-source recap, hidden conflict

**Evidence Limitation Memo Shape**:
A Deep Research outcome shape for cases that cannot credibly become a **Research Report**, led by reviewed scope, grounded limitation reasons, recovery actions, and a source ledger appendix.
_Avoid_: failed report, thin research report, apology without next action

**Report Appendix**:
The end-of-report area for durable provenance and audit detail, such as evidence basis, source ledger, audit notes, and detailed limitations that would interrupt the main **Decision Brief**.
_Avoid_: main narrative, hidden source truth, unstructured dump

**Report Callout**:
A sparse semantic Markdown callout used to highlight the report answer, a decision-changing limitation, or an evidence-basis legend.
_Avoid_: decorative box, every-section wrapper, visual noise

**Report Intent**:
The approved **Research Plan**'s intended report purpose, such as comparison, recommendation, investigation, market scan, product scan, or evidence limitation.
_Avoid_: topic, depth, claim type, report-writer guess

**Report Core**:
The shared required parts of a **Structured Research Report**, including title, scope, answer-first executive summary, key findings, methodology or source basis, limitations, and source ledger snapshot.
_Avoid_: generic report, optional appendix, full source dump

**Claim-Grounded Report Assembly**:
Building a **Structured Research Report** from accepted or limited **Synthesis Claims** and verified **Claim Evidence Links**.
_Avoid_: report writer invention, all-notes rewrite, unsupported prose expansion

**Evidence Note**:
A first-class persisted research-evidence row extracted from a **Reviewed Source** or **Research Task** for use inside the **Research Workspace**.
_Avoid_: report finding, conclusion, source title, nested JSON claim

**Synthesis Claim**:
A first-class persisted report-eligible conclusion synthesized from **Evidence Notes** and mapped back to the approved **Research Plan**.
_Avoid_: source note, snippet, raw finding, prose-only conclusion

**Claim Type**:
The kind of conclusion a **Synthesis Claim** makes, used to decide what evidence can support it.
_Avoid_: report section, topic, source type

**Claim Type Disclosure**:
A user-facing label or phrase that explains a **Claim Type** only when it helps users interpret evidence strength, freshness, or limitation.
_Avoid_: internal taxonomy dump, hidden trust signal, decorative label

**Central Claim**:
A **Synthesis Claim** whose truth materially affects the report's answer, recommendation, comparison outcome, or approved **Research Plan** goal.
_Avoid_: important-sounding detail, highlighted bullet only, writer emphasis

**Non-Central Claim**:
A **Synthesis Claim** that can be removed, downgraded, or limited without changing the report's answer, recommendation, comparison outcome, or approved **Research Plan** goal.
_Avoid_: trivial claim, unsupported claim, decorative detail

**Evidence Requirement**:
A claim-type-specific support rule that defines which **Evidence Notes** and **Source Quality Signals** are strong enough to support a **Synthesis Claim**.
_Avoid_: generic citation rule, source count, fixed source tier

**Claim Support Gate**:
A hard minimum evidence rule that a central **Synthesis Claim** must pass before it can be treated as supported.
_Avoid_: weighted score, source popularity, enough weak sources

**Claim Evidence Link**:
A durable relationship between a **Synthesis Claim** and the **Evidence Notes** that support, qualify, or contradict it.
_Avoid_: inline citation guess, markdown footnote only, prose support

**Claim Conflict**:
A meaningful disagreement between **Evidence Notes** or **Synthesis Claims** that changes, qualifies, or challenges a report conclusion.
_Avoid_: minor wording difference, source noise, unsupported alternative

**Competing Synthesis Claim**:
A **Synthesis Claim** that represents a materially different conclusion from another **Synthesis Claim** for the same plan question, entity, or axis.
_Avoid_: duplicate claim, caveat, source note

**Claim Graph**:
The persisted graph of **Synthesis Claims**, **Evidence Notes**, **Claim Evidence Links**, **Citation Audit Verdicts**, and **Report Limitations** used for coverage, citation audit, memo generation, and report rendering.
_Avoid_: markdown citations, source list, prose-only support map

**Durable Research Graph Foundation**:
The first implementation milestone that persists **Research State Checkpoints**, **Evidence Notes**, **Synthesis Claims**, **Claim Evidence Links**, **Citation Audit Verdicts**, and **Report Limitations** before report rendering improvements.
_Avoid_: renderer polish, markdown cleanup, visual report redesign

**Deep Research Evaluation Harness**:
A repeatable test and fixture suite that proves Deep Research quality, durability, report readability, and failure handling across representative research scenarios.
_Avoid_: manual spot check, demo query, one-off downloaded report review

**Golden Research Fixture**:
A preserved input, source set, graph state, or generated output used by the **Deep Research Evaluation Harness** to catch regressions.
_Avoid_: stale sample, screenshot-only proof, manual QA note

**Live Research Evaluation**:
An optional non-blocking evaluation run that uses live web discovery to observe current real-world Deep Research behavior.
_Avoid_: CI gate, deterministic fixture, release blocker

**Claim Readiness**:
The state where enough accepted or repairable **Synthesis Claims** exist, with sufficient **Claim Evidence Links**, to answer the approved **Research Plan**.
_Avoid_: source count, draft confidence, writer preference

**Discovered Source**:
A candidate source found during research but not necessarily read.
_Avoid_: used source, citation

**Reviewed Source**:
A source opened, extracted, summarized, or otherwise analyzed by a **Deep Research Job**.
_Avoid_: search result, cited source

**Topic-Relevant Reviewed Source**:
A **Reviewed Source** that supports the approved **Research Plan** and passes plan-topic or named-entity relevance checks.
_Avoid_: reviewed source, plausible source, generic source

**Topic-Relevance Gate**:
The source-review checkpoint that decides whether a **Reviewed Source** may produce valid **Evidence Notes** for the approved **Research Plan**.
_Avoid_: report eligibility, source count, citation formatting

**Source Quality Signal**:
A structured quality attribute for a **Research Source** or **Evidence Note**, such as source type, independence, freshness, directness, extraction confidence, or claim fit.
_Avoid_: single authority rank, generic quality score, website reputation only

**Source Authority Summary**:
A user-facing summary derived from **Source Quality Signals** to help users scan source strength.
_Avoid_: source-quality truth, fixed source tier, citation proof

**Compared Entity**:
A named subject that a comparison-oriented **Research Plan** asks AlfyAI to compare.
_Avoid_: item, target, topic term

**Comparison Axis**:
A criterion used to compare **Compared Entities**, such as model year changes, specifications, price, value, risks, or use case.
_Avoid_: section, attribute, question bucket

**Entity-Axis Discovery Strategy**:
A source discovery strategy that targets specific **Compared Entities** and **Comparison Axes** from the approved **Research Plan**.
_Avoid_: broad query list, generic search plan, search prompt

**Cited Source**:
A **Research Source** cited in a **Research Report**.
_Avoid_: discovered source, reviewed source

**Source Ledger**:
A user-inspectable list of **Research Sources** that affected or explain a **Deep Research Job** outcome.
_Avoid_: raw search results, discovered-source dump, citation list only

**Source Ledger Snapshot**:
A durable read snapshot of the **Source Ledger** attached to a completed **Research Report** or **Evidence Limitation Memo**.
_Avoid_: live source query, regenerated source list, diagnostics dump

**Research Concurrency Budget**:
The depth-dependent limit for how many source-processing and model-reasoning steps a **Deep Research Job** may run at once.
_Avoid_: source quota, pass budget, unlimited fan-out

**Source Processing Concurrency**:
The part of a **Research Concurrency Budget** used for fetching, extracting, parsing, and normalizing source material.
_Avoid_: LLM review slots, synthesis workers, browser tabs

**Model Reasoning Concurrency**:
The part of a **Research Concurrency Budget** used for source review, evidence extraction, claim synthesis, coverage assessment, citation audit, and repair reasoning.
_Avoid_: fetch slots, scrape parallelism, provider rate limit

**Research Budget**:
The depth-dependent ceiling for source discovery, review, synthesis passes, and runtime effort in a **Deep Research Job**.
_Avoid_: source quota, guaranteed source count

**Pass Budget**:
The depth-dependent maximum number of **Iterative Research Passes** and **Repair Passes** a **Deep Research Job** may run.
_Avoid_: required pass count, source quota, runtime promise

**Repair Pass Budget**:
The depth-dependent maximum number of **Repair Passes** a **Deep Research Job** may run.
_Avoid_: unlimited repair loop, citation formatting budget, retry count

**Minimum Pass Expectation**:
The depth-dependent expectation for how much iterative research should normally happen before publishing a normal **Research Report**.
_Avoid_: hard quota, guaranteed passes, spinner time

**Depth Pass Floor**:
The configured minimum number of **Meaningful Research Passes** expected for a Deep Research depth before normal report publication.
_Avoid_: hardcoded pass count, runtime promise, source quota

**Meaningful Research Pass**:
An **Iterative Research Pass** that advances research state through new relevant evidence, gap resolution, claim work, conflict resolution, or audit-driven repair.
_Avoid_: retry, no-op pass, formatting pass, progress theater

**Publishable Evidence Floor**:
The minimum evidence and structure threshold a **Deep Research Job** must meet before publishing a normal **Research Report**.
_Avoid_: quota, target count, nice-to-have quality bar

**Research Effort Estimate**:
A coarse pre-approval disclosure of expected time, source review scale, and relative cost for a **Deep Research Job**.
_Avoid_: guaranteed runtime, exact quote

**Activity Timeline**:
A user-visible record of major **Deep Research Job** steps, source progress, assumptions, and stage changes.
_Avoid_: thinking, chain of thought, debug log

**Meaningful Timeline Event**:
An **Activity Timeline** event that adds user-relevant information beyond the existence of a workflow stage.
_Avoid_: routine stage row, connector filler, repeated count row

**Stage Progress Ring**:
A compact **Research Card** indicator that visualizes the current **Deep Research Job** stage and completion state.
_Avoid_: exact percent, guaranteed progress, runtime meter

**Stage Detail Reveal**:
An interaction that opens meaningful details for one selected Deep Research stage inside the **Research Card**.
_Avoid_: log viewer, full debug trace, pending-stage filler

**Meaningful Pass Progress**:
Compact progress information about **Meaningful Research Passes**, **Depth Pass Floor**, **Coverage Gaps**, and **Claim Conflicts**.
_Avoid_: stage percent, exact runtime, source-count padding

**Progress Reveal Motion**:
A short, smooth top-fade transition used when new **Research Card** progress states or **Meaningful Timeline Events** appear.
_Avoid_: dramatic animation, layout jump, decorative motion

**Research Language**:
The language used for user-facing **Deep Research** plan, progress, and report prose.
_Avoid_: source language, UI language

**Research Card**:
The chat-visible representation of a **Deep Research Job** or **Research Report**.
_Avoid_: assistant message, placeholder, report body

**Research Card Severity**:
The user-facing meaning of a **Research Card** state, separate from the operational **Deep Research Job** status.
_Avoid_: raw job status, database status, stage name

**Research Workspace**:
The structured working state of a **Deep Research Job**, including plan versions, source ledger, extracted notes, synthesis drafts, citation records, and activity events.
_Avoid_: filesystem, scratchpad, hidden memory

**Research Orchestrator**:
The Deep Research service role that owns plan execution, task assignment, coverage decisions, and publication readiness for a **Deep Research Job**.
_Avoid_: report writer, source reviewer, hidden chat agent

**Iterative Research Pass**:
A bounded search-review-reasoning loop that writes structured work into the **Research Workspace** before deciding whether to continue, synthesize, or stop.
_Avoid_: one-shot search, bulk scrape, source dump

**Repair Pass**:
A first-class **Iterative Research Pass** created to repair unsupported claims, close audit-driven gaps, replace weak evidence, or convert unrepairable claims into **Report Limitations**.
_Avoid_: citation-audit side effect, hidden rewrite, formatting repair

**Research State Checkpoint**:
A durable commit of one **Iterative Research Pass** state, including pass inputs, outputs, coverage result, next decision, and related workspace references.
_Avoid_: prompt memory, in-process state, transient agent notes, inferred timeline state

**Pass Decision**:
The terminal orchestration decision for an **Iterative Research Pass**, such as continue research, synthesize, publish memo, publish report, stop, or fail.
_Avoid_: timeline event, task status, model preference

**Workspace Rehydration**:
Reconstructing the **Research Workspace** from durable rows before each worker step or model call.
_Avoid_: continuing from chat context, continuing from worker memory

**Research Resume Point**:
The durable checkpoint, task, or pass state from which a **Deep Research Job** can continue after crash, deploy, timeout, or worker restart.
_Avoid_: in-memory continuation, retry guess, transcript replay

**Runtime Policy**:
The configurable limits and behaviors that control **Deep Research Job** runtime, cost, concurrency, cancellation, timeout, and overrun handling.
_Avoid_: hidden worker setting, provider limit, billing summary

**Coverage Assessment**:
A checkpoint where AlfyAI decides whether the **Reviewed Sources** sufficiently answer the approved **Research Plan**.
_Avoid_: vibes check, confidence guess

**Research Usage**:
Cost, token, model, provider, and runtime measurements produced by Deep Research planning, research, synthesis, and audit work.
_Avoid_: message analytics, hidden cost

**Final Research Time**:
The user-facing wall-clock duration from **Deep Research Job** creation to completion.
_Avoid_: model latency, token time, hidden worker time

**Coverage Gap**:
A first-class unanswered or weakly supported part of an approved **Research Plan** identified during **Coverage Assessment**.
_Avoid_: todo, missing info, uncertainty, checkpoint-only field

**Research Task**:
A bounded unit of research work inside a **Deep Research Job**, assigned to a key question, **Coverage Gap**, source group, or synthesis step.
_Avoid_: subagent, autonomous worker

**Pass Barrier**:
A synchronization point where required **Research Tasks** for a research pass must complete, fail, or be explicitly skipped before **Coverage Assessment** or synthesis can proceed.
_Avoid_: race, loose parallelism

**Report Limitation**:
A first-class disclosed weakness, missing answer, source constraint, rejected claim, limited claim, or audit uncertainty in a **Research Report**.
_Avoid_: failure, excuse, hidden caveat, generic disclaimer

**Citation Audit Verdict**:
A first-class persisted support decision produced by **Citation Audit** for a **Synthesis Claim** and its **Claim Evidence Links**.
_Avoid_: citation formatting result, prose comment, markdown lint finding

**Citation Audit**:
A verification step that checks whether **Synthesis Claims** are supported by their **Claim Evidence Links** before report prose is published.
_Avoid_: source formatting, citation cleanup, markdown footnote pass

**Audited Structured Report**:
A **Structured Research Report** after **Citation Audit** has retained, repaired, removed, or limited its claims without flattening its report structure.
_Avoid_: retained-claims list, citation-audit transcript

**Report Eligibility Gate**:
A checkpoint before synthesis or report publication that decides whether enough **Topic-Relevant Reviewed Sources** exist to produce a credible **Research Report**.
_Avoid_: citation audit, final formatting, source count check

**Evidence Limitation Memo**:
A durable Deep Research output assembled from grounded **Report Limitations** and workspace state when no credible **Research Report** can be produced.
_Avoid_: failed report, limited report, plan revision needed, partial report, empty report, memo-only explanation path

### Relationships

- A **Deep Research Job** is optional and explicitly started by the user.
- A **Deep Research Job** extends **Normal Chat** without replacing it.
- **Normal Chat** may use tools casually; a **Deep Research Job** is a deliberate background task.
- **Deep Research Mode** must be switched on by the user; AlfyAI does not automatically convert a **Normal Chat** request into a **Deep Research Job**.
- Successful **Deep Research Job** completion creates a **Report Boundary**.
- Cancelling a **Deep Research Job** does not create a **Report Boundary**.
- After a **Report Boundary**, users may take **Report Actions** but may not send new turns into the same conversation.
- Starting from a completed report creates a new conversation; it does not reopen the sealed conversation.
- **Discuss Report** starts a new **Normal Chat**.
- **Research Further** starts a new **Deep Research Job**.
- A **Discuss Report** conversation may still use casual tools, but it does not become a **Deep Research Job** unless the user explicitly chooses **Deep Research Mode** again.
- A sealed conversation cannot start another **Deep Research Job** directly.
- A conversation may have at most one active or uncompleted **Deep Research Job**.
- A cancelled or failed **Deep Research Job** does not prevent starting another **Deep Research Job** in the same unsealed conversation.
- Every **Deep Research Job** creates a **Research Plan** before source-heavy research begins.
- The user may approve, edit, add to, or cancel a **Research Plan**.
- Source-heavy research does not begin until the user approves the **Research Plan**.
- Cancelling before **Research Plan** approval does not create a **Report Boundary**.
- Editing a **Research Plan** produces a revised **Research Plan**; it does not start source-heavy research.
- After a **Research Plan** is revised, the user is again offered approval or further editing.
- A **Research Plan** includes a goal, key questions, source scope, depth, report shape, constraints, and deliverables.
- A **Research Plan** should include **Report Intent** before source-heavy research begins.
- **Report Intent** should be shown to the user before **Research Plan** approval so the user can correct the expected report shape.
- Source-heavy research should use the approved **Report Intent** to guide discovery, **Claim Type** selection, **Evidence Requirements**, **Coverage Assessment**, and **Report Shape Template** selection.
- Report assembly should not infer a different **Report Intent** after research has completed unless the output becomes an **Evidence Limitation Memo** because the approved intent cannot be supported.
- A request to compare unnamed option categories, such as "at least three architecture patterns," is not enough by itself to create known **Compared Entities**.
- When comparison is a means to choosing or recommending and the options are not named yet, the **Research Plan** should use **Recommendation Report Shape** or another decision-oriented intent, discover candidate options as research work, and add comparison blocks only after those options are grounded.
- **Comparison Report Shape** is for known **Compared Entities** present in the user request or approved **Research Plan**, not imperative clauses such as "identify failure modes" or "recommend one design."
- Strict **Comparison Report Shape** requires at least two named, source-searchable **Compared Entities** before approval, such as concrete products, vendors, jurisdictions, people, organizations, standards, versions, policies, or explicitly named approaches.
- Candidate options discovered during recommendation, scan, or investigation work may become comparison columns later, but they should not be pre-approved as **Compared Entities** until they are concrete and grounded.
- Generic comparison fallback questions should be domain-neutral; product, vehicle, procurement, legal, software, health, finance, and literature-review questions should appear only when topic detection or the approved **Research Plan** justifies that domain.
- Product or vehicle comparison questions may ask about specs, model years, trims, dealers, manufacturers, availability, and rider or buyer use cases only when the compared entities are actually products or vehicles.
- Planner model output may draft useful structure, but local **Research Plan** normalization owns the trust boundary for **Report Intent**, **Compared Entities**, and domain-appropriate fallback questions.
- Local **Research Plan** normalization should reject imperative clauses, quantity placeholders, and unnamed option categories as **Compared Entities** even when a planner model returns them as strings.
- A **Research Plan** should include a **Plan Normalization Note** when local normalization changes **Report Intent**, drops invalid **Compared Entities**, or converts unnamed option categories into candidate-discovery work.
- A **Plan Normalization Note** should not block approval and should not expose regexes, parser internals, or low-level model diagnostics.
- If a **Deep Research Job** reviews a meaningful number of sources and accepts zero topic-relevant sources, AlfyAI should run a **Plan Health Check** before presenting the outcome as insufficient evidence.
- A **Plan Health Check** should detect signs such as fake **Compared Entities**, imperative clauses treated as entities, domain-mismatched key questions, or search/relevance framing that no longer matches the user's goal.
- If a **Plan Health Check** detects plan poisoning, the user-facing outcome should explain that the research plan needs revision and offer a corrected draft or recovery path instead of implying the real topic lacks evidence.
- If a **Plan Health Check** detects plan poisoning after source-heavy work has already run, Deep Research should complete as **Research Plan Revision Needed**, not as an **Evidence Limitation Memo**.
- **Research Plan Revision Needed** should create a corrected **Research Plan** draft automatically when AlfyAI can infer the safe correction, but it must not start another source-heavy run without user approval.
- The corrected **Research Plan** draft after **Research Plan Revision Needed** should be reviewable with the same approve, edit, or cancel controls as any other **Research Plan**.
- Rejected or off-topic source counts from the poisoned run should not be treated as evidence against the corrected **Research Plan** topic.
- The first UI slice for **Research Plan Revision Needed** should be minimal: the **Research Card** shows that the plan needs revision, explains the plan-health reason briefly, and presents the corrected draft through the existing approval controls.
- **Research Plan Revision Needed** should not introduce a new modal, wizard, or separate recovery surface when the existing **Research Plan** approval UI can handle approve, edit, and cancel.
- **Research Plan Revision Needed** should be stored as an operationally completed **Deep Research Job** with a distinct plan-revision-needed stage or outcome, not as a failed job.
- **Research Plan Revision Needed** should not have a normal report artifact, should not create a **Report Boundary**, and should keep the corrected **Research Plan** available for approval.
- The **Activity Timeline** for **Research Plan Revision Needed** should explain the plan-health failure in user-facing terms.
- Approving the corrected **Research Plan** after **Research Plan Revision Needed** should continue the same **Deep Research Job** with a new plan version rather than starting an unrelated job.
- The corrected run should start source-heavy work from clean execution state for the new plan while preserving the poisoned run's timeline, source ledger, and usage as diagnostic history.
- Poisoned-run rejected sources, coverage gaps, tasks, and topic-relevance counts should not satisfy or block coverage for the corrected **Research Plan**.
- If the **Plan Health Check** passes and useful topic-relevant evidence is still absent, Deep Research should publish an **Evidence Limitation Memo**.
- A **Plan Edit** is freeform; AlfyAI synthesizes the user's edit into a revised **Research Plan**.
- The Deep Research planning flow avoids exposing advanced structured controls beyond approval, cancellation, and freeform editing.
- Deep Research depth levels are **Focused Deep Research**, **Standard Deep Research**, and **Max Deep Research**.
- No Deep Research depth is selected by default; the user explicitly chooses **Focused Deep Research**, **Standard Deep Research**, or **Max Deep Research**.
- AlfyAI may recommend a different depth in the **Research Plan**, but it must not automatically change the user's selected depth.
- The knowledge library may contribute **Planning Context**.
- **Planning Context** is not automatically a **Research Source**.
- The **Research Plan** must disclose source scope before approval.
- Knowledge-library items become **Research Sources** only when the approved **Research Plan** includes them.
- Files attached to the **Deep Research Job** request may be **Research Sources** because attachment is an explicit user action.
- Current conversation context may be **Planning Context**, but is not automatically cited as a **Research Source** unless the approved **Research Plan** says the report is based on it.
- When private or workspace material influences a **Research Plan**, the plan may show a compact "context considered" disclosure.
- A "context considered" disclosure summarizes **Planning Context** by type, count, or title; it is not evidence or citation.
- Every completed **Deep Research Job** produces exactly one durable outcome: a **Research Report**, **Limited Research Report**, **Evidence Limitation Memo**, or **Research Plan Revision Needed**.
- A **Research Report** or **Limited Research Report** creates the **Report Boundary** for its conversation.
- A **Research Report** or **Limited Research Report** is durable and reusable; it is not only assistant message text.
- A **Research Report** or **Limited Research Report** includes citations and a user-facing source list.
- Every successful **Research Report** should be a **Readable Research Report**.
- A Deep Research output should be labeled a **Research Report** only when it is a **Readable Research Report**.
- A **Limited Research Report** should still read as a **Decision Brief**, but it should explicitly narrow unsupported scope instead of pretending the full approved **Research Plan** was answered.
- A **Readable Research Report** should be produced from a **Structured Research Report** rather than a freeform Markdown blob.
- A **Structured Research Report** should be assembled through **Claim-Grounded Report Assembly**.
- A **Structured Research Report** should preserve intent-specific **Structured Report Blocks** before Markdown rendering.
- A **Structured Research Report** should use a **Report Shape Template** selected by **Report Intent**, not one universal report shape with every optional section.
- Every **Report Shape Template** should include the **Report Core**.
- Intent-specific sections should be added only when they help the approved **Research Plan**: comparison reports may include matrices and entity-by-axis analysis; recommendation reports may include criteria, ranked options, fit, and risks; investigation reports may include timelines, competing explanations, and confidence; market or product scans may include shortlists, evaluation rubrics, pricing, and freshness notes; evidence limitation outputs should focus on limitation reasons, searched/reviewed scope, and recovery actions.
- Every **Report Intent** should have an upgraded Markdown reading shape with appropriate **Report Visual Aids**, not only comparison reports.
- Initial upgraded Markdown shapes should be **Comparison Report Shape**, **Recommendation Report Shape**, **Investigation Report Shape**, **Market/Product Scan Report Shape**, **Evidence Review Report Shape**, and **Evidence Limitation Memo Shape**.
- Default **Report Shape Templates** should be compact and answer-first: the executive summary gives the conclusion before methodology; key findings are capped; tables appear where comparison, ranking, or scan structure helps; limitations remain visible near the conclusion and again in the source basis when needed.
- Charts in a **Readable Research Report** should be reserved for genuinely quantitative patterns such as 3+ option comparisons, ranked shortlists, time series, distributions, or scored axes.
- Two-entity comparisons should prefer a **Comparison Matrix** over charts unless the approved **Research Plan** asks a specifically quantitative question.
- A report-writing model may improve organization, transitions, section summaries, and prose quality, but it must not introduce new cited substance outside accepted or limited **Synthesis Claims** and their verified **Claim Evidence Links**.
- Markdown layout for **Readable Research Reports** should be rendered deterministically by AlfyAI from **Structured Report Blocks**, not left primarily to model-prompted freeform Markdown.
- A **Structured Research Report** should preserve report parts such as title, scope, executive summary, recommendation, comparison matrix, key findings, sections, limitations, and cited sources before rendering.
- A **Readable Research Report** is not a dump of every reviewed source note.
- Styling or Markdown polish cannot turn source titles, snippets, or weak per-source notes into a **Readable Research Report**.
- When the available evidence supports useful synthesized conclusions but not the full approved **Research Plan**, Deep Research should produce a **Limited Research Report** instead of blocking on a normal **Research Report**.
- A **Limited Research Report** requires at least one useful, citation-supported **Central Synthesis Claim**, a narrower answerable version of the approved goal, and explicit **Report Limitations** for unsupported parts.
- A **Limited Research Report** must not invent unsupported sections to preserve the original **Research Plan** shape.
- When the available evidence can only support weak per-source notes rather than useful synthesized conclusions, Deep Research should produce an **Evidence Limitation Memo** instead of a normal **Research Report**.
- By default, a **Readable Research Report** should read as a **Decision Brief** rather than a research transcript.
- A **Readable Research Report** should lead with the answer, then show the strongest evidence-backed findings, then organize the body around the approved **Research Plan**.
- Key findings in a **Readable Research Report** should be capped to a small, scannable set; additional reviewed notes belong in the **Research Workspace**, source ledger, or future appendix, not the main report body.
- Audit detail, source review detail, and full source-ledger context should remain inspectable without dominating the main **Decision Brief** reading path.
- Source, audit, and detailed limitation material should default to a **Report Appendix** rather than inline main-body prose.
- A **Report Appendix** should keep durable provenance visible through sections such as evidence basis, compact limitations, source ledger, and audit notes when repair, removal, or limitation materially affected the output.
- A **Readable Research Report** may use sparse **Report Callouts** for the answer-first conclusion, decision-changing limitations, and evidence confidence legend.
- **Report Callouts** should carry semantic reading weight and should not be used as decorative wrappers around every section.
- A comparison-oriented **Readable Research Report** should make the **Comparison Matrix** the primary body surface when central **Compared Entities** and **Comparison Axes** are known.
- A **Comparison Matrix** should use central **Comparison Axes** as rows and **Compared Entities** as columns, with an additional **Decision Meaning** column when the comparison is meant to support a choice or recommendation.
- A **Comparison Matrix** should include an **Evidence Confidence Cue** inside a cell only when the evidence basis changes how the reader should interpret that cell.
- A comparison-oriented **Decision Brief** should include a short confidence legend near the **Comparison Matrix** when it uses **Evidence Confidence Cues**.
- Prose in a comparison-oriented **Decision Brief** should explain decision-relevant differences, trade-offs, caveats, and evidence confidence rather than restating every matrix cell.
- Methodology and **Report Limitations** should be visible but compact.
- A full source ledger or activity history may be attached to the **Research Report** as metadata.
- Source review produces **Evidence Notes**; it does not produce final report conclusions.
- **Evidence Notes** should be stored as first-class persisted rows, such as a `deep_research_evidence_notes` table, rather than only inside `reviewed_note`, `extracted_claims_json`, or **Research Task** output JSON.
- An **Evidence Note** should retain durable links to the **Deep Research Job**, **Research State Checkpoint**, source or task that produced it, supported key question, and any relevant **Compared Entity** or **Comparison Axis**.
- **Evidence Notes** should preserve enough source support for later synthesis and audit, such as cited text, normalized finding text, source location when available, confidence or quality metadata, and rejection/limitation status.
- Source quality should be represented as separate **Source Quality Signals**, not as one fixed **Source Authority** tier.
- **Source Quality Signals** should include source type, independence, freshness, directness to the claim, extraction confidence, and claim fit where available.
- The same source may be strong evidence for one **Synthesis Claim** and weak evidence for another.
- A **Source Authority Summary** may help users scan the source ledger, but coverage and audit should evaluate the underlying **Source Quality Signals** in relation to specific **Evidence Notes** and **Synthesis Claims**.
- Acceptable evidence should depend on **Claim Type**.
- **Synthesis Claims** should have a **Claim Type** so coverage and audit can apply the right **Evidence Requirement**.
- **Claim Type** should be persisted for every **Synthesis Claim**.
- **Claim Type Disclosure** should be selective: reports should expose claim type labels only when they help users understand trust, freshness, source authority, or limitation.
- User-facing **Claim Type Disclosure** should use plain labels such as official specification, owner-reported pattern, dated price observation, or recommendation based on fit and limitations rather than internal enum names.
- **Evidence Requirements** should consider **Source Quality Signals**, not only whether an **Evidence Note** exists.
- **Evidence Requirements** should behave as **Claim Support Gates** for central report claims.
- If a **Claim Type** requires primary or expert evidence, weaker evidence cannot make that **Synthesis Claim** supported even when many weak sources agree.
- Weaker evidence may still appear as context, qualifying evidence, contradiction, experiential signal, or **Report Limitation** when appropriate.
- Weighted **Source Quality Signals** may rank candidate evidence, source display, or follow-up priority, but they must not override a **Claim Support Gate**.
- **Synthesis Claims** should distinguish **Central Claims** from **Non-Central Claims**.
- Unsupported **Central Claims** should block normal report publication until repaired, converted into a credible limitation state, or replaced by a supported claim.
- Unsupported **Non-Central Claims** may be removed, downgraded, or disclosed as **Report Limitations** without blocking an otherwise useful **Research Report**.
- A recommendation premise should be treated as a **Central Claim** when changing that premise would change the recommendation.
- Official specification claims should prefer official, manual, vendor, or equivalent primary evidence.
- Price or availability claims should require fresh dated evidence and should disclose timing.
- Reliability or user-experience claims may use independent reviews, forums, or owner reports when labeled as experiential evidence.
- Recommendation claims should combine use-case fit, specifications, limitations, and source diversity rather than relying on one evidence type.
- Safety, legal, medical, financial, or similarly high-stakes claims should require stronger primary or expert evidence and more explicit **Report Limitations**.
- Legacy nested source-review or task JSON does not need compatibility preservation for existing Deep Research test data.
- Once first-class **Evidence Notes** replace nested reviewer/task evidence, obsolete fields such as `reviewed_note`, `extracted_claims_json`, or task evidence JSON should be removed or stopped as write targets rather than kept as a parallel evidence path.
- **Synthesis Claims** should be stored as first-class persisted rows, such as a `deep_research_synthesis_claims` table, rather than only inside a report draft, synthesis note blob, or Markdown body.
- A **Synthesis Claim** should retain durable links to the **Deep Research Job**, **Research State Checkpoint** or synthesis pass that produced it, approved **Research Plan** question or report section, status, confidence or strength, limitation flags, and user/conversation ownership.
- **Claim Evidence Links** should explicitly connect each **Synthesis Claim** to supporting, qualifying, or contradicting **Evidence Notes**.
- Contradictory **Evidence Notes** may link to a single **Synthesis Claim** as qualifying or contradicting evidence when the claim honestly incorporates the conflict.
- A **Claim Conflict** should create **Competing Synthesis Claims** when the disagreement changes the conclusion rather than merely qualifying it.
- AlfyAI must not average away a **Claim Conflict** or hide it inside prose; it should resolve it with stronger evidence, disclose it as a **Report Limitation**, or represent it as competing claims until audit or coverage can decide.
- Citation-bearing report prose should be rendered from accepted **Synthesis Claims** and their **Claim Evidence Links**, not by asking the citation audit to infer support from text after the fact.
- A **Synthesis Claim** must answer the approved **Research Plan**, not merely restate a source title, snippet, or per-source note.
- A **Readable Research Report** is rendered from validated **Synthesis Claims**, not directly from raw source titles, snippets, or weak **Evidence Notes**.
- If Deep Research cannot produce useful **Synthesis Claims**, it should not publish a normal **Research Report**.
- A **Research Source** may be tracked as a **Discovered Source**, **Reviewed Source**, or **Cited Source**.
- Only **Reviewed Sources** may become **Cited Sources**.
- **Discovered Sources** may appear in activity history or diagnostics, but they are not evidence for report claims.
- The default **Source Ledger** should show sources that affected the research state: **Cited Sources**, topic-relevant **Reviewed Sources**, and rejected/off-topic reviewed sources when they explain limitations.
- Discovered-only sources should be collapsed or kept in diagnostics by default so users do not mistake discovery volume for used evidence.
- A **Source Ledger** should distinguish cited, reviewed topic-relevant, reviewed rejected/off-topic, and discovered-only sources when discovered-only items are shown.
- A completed **Research Report** or **Evidence Limitation Memo** should include a **Source Ledger Snapshot** so reopening the artifact shows the same source context the user saw at completion.
- The live **Claim Graph** and workspace rows remain the internal orchestration and audit truth, but the **Source Ledger Snapshot** is the stable reading surface for completed outputs.
- Cleanup, retries, or later implementation changes should not silently change the **Source Ledger Snapshot** attached to an already completed output.
- Source counts should distinguish discovered, reviewed, and cited sources instead of presenting one inflated total.
- Research Card source counts should also expose a compact **Topic-Relevant Reviewed Source** count, so users can distinguish source volume from usable evidence quality.
- A **Reviewed Source** is not automatically a **Topic-Relevant Reviewed Source**.
- A **Topic-Relevant Reviewed Source** must support the approved **Research Plan** and pass topic or named-entity relevance checks.
- Source-review model output may identify supported key questions, but deterministic topic or named-entity overlap should guard against unrelated high-authority or generic sources becoming **Topic-Relevant Reviewed Sources**.
- The **Topic-Relevance Gate** should run before a reviewed source can produce valid **Evidence Notes** for the **Claim Graph**.
- Off-topic sources may remain in the source ledger as rejected or limited workspace records, but they must not produce accepted **Evidence Notes**, satisfy **Coverage Assessment**, or support **Synthesis Claims**.
- The **Durable Research Graph Foundation** should preserve rejected/off-topic source state for transparency without allowing that state to become report-supporting evidence.
- A comparison-oriented **Research Plan** should identify **Compared Entities** and central **Comparison Axes** before source-heavy research when the user request makes them available.
- A comparison-oriented **Research Plan** should show detected **Compared Entities** and central **Comparison Axes** before approval so the user can revise scope before source-heavy research begins.
- Comparison reports should require **Topic-Relevant Reviewed Sources** across every central **Compared Entity** before the **Research Report** is eligible to complete.
- Comparison reports should require support for central **Comparison Axes** before presenting a normal comparative conclusion.
- Missing support for a **Compared Entity** or central **Comparison Axis** should create targeted discovery while **Research Budget** remains.
- Comparison-oriented discovery should use an **Entity-Axis Discovery Strategy** rather than relying only on broad goal and key-question searches.
- Discovered and reviewed comparison sources should retain enough structure to show which **Compared Entity** or **Comparison Axis** they were meant to support.
- **Coverage Assessment** for comparison reports should use the **Entity-Axis Discovery Strategy** to identify one-sided evidence, missing axes, and targeted follow-up discovery.
- If **Research Budget** is exhausted with missing entity or axis support, Deep Research should produce an **Evidence Limitation Memo** instead of padding a **Research Report** with unrelated, generic, or one-sided evidence.
- A high discovered or reviewed source count must not satisfy the **Report Eligibility Gate** when too few sources are topic-relevant.
- Source counts are progress telemetry and sanity checks; they are not the main proof of report readiness.
- **Coverage Assessment** should operate primarily over **Evidence Notes**, **Synthesis Claims**, **Claim Evidence Links**, and **Claim Readiness**.
- **Coverage Assessment** should consider **Source Quality Signals** when deciding whether evidence is strong enough for claim-ready coverage.
- **Coverage Assessment** should evaluate whether each central **Synthesis Claim** meets the **Evidence Requirement** for its **Claim Type**.
- Central **Synthesis Claims** that fail their **Claim Support Gate** should create **Coverage Gaps**, **Repair Passes**, rejected claims, or **Report Limitations** rather than publishable support.
- **Coverage Assessment** may allow a **Research Report** to publish after unsupported **Non-Central Claims** are removed, downgraded, or converted into **Report Limitations**.
- Reviewed-source counts and supported-key-question arrays may help detect weak coverage, but they should not by themselves prove that a **Research Report** is publishable.
- **Report Eligibility Gate** should require enough topic-relevant evidence and enough claim-ready coverage for the approved **Research Plan** before normal report publication.
- Deep Research depth sets a **Research Budget**.
- A **Research Budget** is a ceiling, not a promised source count.
- Deep Research depth sets a **Research Concurrency Budget**.
- **Source Processing Concurrency** and **Model Reasoning Concurrency** are separate budgets.
- **Source Processing Concurrency** may be wider than **Model Reasoning Concurrency** because fetching and extraction are less semantically risky than LLM review, synthesis, audit, or repair.
- Initial configurable concurrency defaults should be: **Focused Deep Research** uses up to 6 source-processing slots and 2 model-reasoning slots; **Standard Deep Research** uses up to 12 source-processing slots and 4 model-reasoning slots; **Max Deep Research** uses up to 24 source-processing slots and 8 model-reasoning slots.
- Synthesis, coverage assessment, citation audit, report assembly, and repair decisions should remain low-concurrency coordination steps even when source review runs in parallel.
- **Research Concurrency Budget** should be enforced per job, per user, and globally so deeper research does not overwhelm provider, browser, database, or worker capacity.
- Deep Research depth sets a **Pass Budget**.
- A **Pass Budget** is a maximum, not a required number of passes.
- Deep Research depth sets a **Repair Pass Budget**.
- Initial configurable depth ceilings should be: **Focused Deep Research** reviews up to 24 sources, runs 2-3 **Meaningful Research Passes**, and allows 1 **Repair Pass**; **Standard Deep Research** reviews up to 75 sources, runs 3-5 **Meaningful Research Passes**, and allows 2 **Repair Passes**; **Max Deep Research** reviews up to 200 sources, runs 5-8 **Meaningful Research Passes**, and allows 3 **Repair Passes**.
- Depth ceilings should remain runtime-configurable policy defaults, not permanent hardcoded limits.
- Deep Research depth also sets a **Minimum Pass Expectation**.
- A **Minimum Pass Expectation** prevents any Deep Research depth from publishing after only a light search pass.
- **Minimum Pass Expectation** should be implemented as a configurable **Depth Pass Floor** rather than a permanently hardcoded constant.
- Initial **Depth Pass Floor** defaults should be 2 **Meaningful Research Passes** for **Focused Deep Research**, 3 for **Standard Deep Research**, and 5 for **Max Deep Research**.
- Only **Meaningful Research Passes** should count toward a **Minimum Pass Expectation**.
- A pass counts as a **Meaningful Research Pass** when it reviews new topic-relevant evidence, resolves or updates **Coverage Gaps**, creates or repairs **Synthesis Claims**, resolves **Claim Conflicts**, or performs audit-driven repair.
- A **Repair Pass** counts toward the **Depth Pass Floor** only when it is a **Meaningful Research Pass**.
- A **Repair Pass** that resolves a **Claim Conflict**, finds replacement evidence, closes a **Coverage Gap**, or converts an unsupported **Central Claim** into a clear **Report Limitation** may count toward the **Depth Pass Floor**.
- A **Repair Pass** that only reformats, retries an API call, or reruns audit without new graph state must not count toward the **Depth Pass Floor**.
- No-op passes, transient retry attempts, and formatting-only work must not satisfy a **Minimum Pass Expectation**.
- Deep Research depth also sets a **Publishable Evidence Floor** for normal **Research Report** completion.
- A **Publishable Evidence Floor** is separate from a **Research Budget**: the budget limits how much work may be attempted, while the floor decides whether the result is good enough to publish as a **Research Report**.
- Changes to **Research Budget** or **Pass Budget** ceilings should be independently verifiable from changes to **Publishable Evidence Floor** and **Minimum Pass Expectation** enforcement.
- **Focused Deep Research** may publish a concise cited brief when it meets a narrow but coherent **Publishable Evidence Floor**.
- **Focused Deep Research** is still Deep Research; if the user only wants a few quick searches, **Normal Chat** with web search is the better path.
- **Focused Deep Research** must satisfy its own **Minimum Pass Expectation** before publishing a normal **Research Report**.
- **Standard Deep Research** should normally require at least one follow-up or coverage-driven **Iterative Research Pass** for multi-question reports.
- **Standard Deep Research** should require multi-source synthesis across the central **Research Plan** questions before publishing a **Research Report**.
- **Max Deep Research** should expect multiple **Iterative Research Passes**, including conflict and gap resolution where needed, before publishing a **Research Report**.
- **Max Deep Research** should require broad coverage across central **Compared Entities**, **Comparison Axes**, conflicts, limitations, and source diversity before publishing a **Research Report**.
- A **Research Plan** should show a **Research Effort Estimate** before approval.
- A **Research Effort Estimate** is coarse and not a promise.
- A **Deep Research Job** may stop before reaching its maximum **Research Budget** or **Pass Budget** only after satisfying the selected depth's **Minimum Pass Expectation**, or when it must end as an **Evidence Limitation Memo**, failure, or cancellation.
- A **Deep Research Job** must not pad weak sources to satisfy a **Research Budget**.
- A **Deep Research Job** must continue research when it is below the selected **Depth Pass Floor**, still has budget, and still has plausible source or evidence paths.
- A **Deep Research Job** should continue research when central **Coverage Gaps**, unresolved **Claim Conflicts**, or unsupported **Central Claims** remain and budget is available.
- A **Deep Research Job** should run a **Repair Pass** when **Citation Audit** or **Coverage Assessment** finds repairable central support problems and **Repair Pass Budget** remains.
- A **Deep Research Job** should publish a normal **Research Report** only after the selected **Depth Pass Floor**, **Publishable Evidence Floor**, **Report Eligibility Gate**, **Citation Audit**, and **Structured Research Report** validation all pass.
- A **Deep Research Job** should publish an **Evidence Limitation Memo** when the approved goal cannot be supported credibly after budget exhaustion, source-pool exhaustion, unrepaired central gaps, or unresolvable claim conflicts.
- A **Deep Research Job** should fail only for true execution failure, unrecoverable infrastructure failure, invalid durable state, or user cancellation; weak evidence should normally become an **Evidence Limitation Memo**.
- Clarifying questions are allowed before **Research Plan** approval.
- After **Research Plan** approval, a **Deep Research Job** should run to completion without blocking for more user input.
- If ambiguity appears after approval, the **Deep Research Job** should make and disclose a reasonable assumption instead of pausing indefinitely.
- While a **Deep Research Job** is running, the user may view progress or cancel it.
- A **Research Plan** cannot be edited after approval in v1.
- To change direction after approval, the user cancels and starts a new **Deep Research Job**.
- A running **Deep Research Job** shows an **Activity Timeline** rather than only a spinner.
- The **Activity Timeline** is persisted and remains attached to the **Research Report** after completion.
- The **Activity Timeline** shows user-facing stage progress, source counts, brief summaries, assumptions, and warnings.
- The **Activity Timeline** body should show **Meaningful Timeline Events**, not every pending or routine workflow stage as a separate row.
- **Meaningful Timeline Events** include the current stage summary, changed source counts, warnings, completion or failure outcomes, coverage decisions, and compact audit results.
- Pending stages should be represented through the **Stage Progress Ring** or compact stage indicator rather than rendered as full timeline rows.
- Routine completed stages may collapse into compact progress state rather than occupying black or filled rows.
- The **Activity Timeline** should avoid repeating source counts on every step when the same counts are already visible in the Research Card summary.
- Per-event source counts may appear only when they add meaningful change or diagnostic value.
- A **Stage Progress Ring** may map workflow stages to approximate visual progress, but it should not present exact percentage language while the job is still running.
- A **Stage Progress Ring** should represent coarse workflow stage progress, not detailed pass counts, gap counts, and audit state all at once.
- The visible progress label should name the active stage or completion state, such as reviewing sources, auditing citations, writing report, or complete.
- A running **Stage Progress Ring** is an orientation aid, not a guarantee of remaining runtime or work.
- A **Stage Progress Ring** or compact stage indicator may support **Stage Detail Reveal**.
- A **Stage Detail Reveal** should show only **Meaningful Timeline Events**, **Meaningful Pass Progress**, changed counts, warnings, or compact audit results for the selected stage.
- **Meaningful Pass Progress** may show details such as pass count against **Depth Pass Floor**, open **Coverage Gaps**, resolved **Claim Conflicts**, or audit-driven repair state.
- The compact **Research Card** header should stay stage-oriented and avoid mechanical pass-floor phrasing.
- **Stage Detail Reveal** may show explicit pass-floor wording, such as "Pass 2 of 3 minimum", when it helps the user understand progress.
- Stages without meaningful details should remain compact and should not invent filler text.
- Newly appearing progress states and **Meaningful Timeline Events** should use **Progress Reveal Motion** so updates feel smooth and effortless without adding visual clutter.
- The **Activity Timeline** does not expose private model reasoning or chain-of-thought.
- Deep Research user-facing text must support English and Hungarian.
- **Research Language** defaults to the latest user request language unless the user explicitly asks for another output language.
- **Research Sources** may be in languages other than the **Research Language**.
- Source titles, quotes, and citations may remain in their original source language.
- Deep Research prose should not mix English and Hungarian except for source material, product names, file names, URLs, citations, and quotes.
- A **Research Card** presents the **Research Plan**, running **Activity Timeline**, source progress, completion state, and **Report Actions** inside chat.
- A **Research Card** should derive a **Research Card Severity** separately from the operational **Deep Research Job** status.
- Operational job status describes execution state, such as awaiting approval, running, completed, failed, or cancelled.
- **Research Card Severity** describes user-facing meaning, such as working, needs attention, insufficient evidence, completed, cancelled, or failed.
- Awaiting approval or plan edit should map to needs attention.
- Running normally should map to working.
- A completed **Research Report** or **Limited Research Report** should map to completed.
- An **Evidence Limitation Memo** should map to insufficient evidence.
- **Research Plan Revision Needed** should map to needs attention.
- User cancellation should map to cancelled.
- Infrastructure failure or unrecoverable execution failure should map to failed.
- A **Research Card** should use cited-site favicons for **Cited Sources** where available, as visual source identity rather than evidence authority.
- When a **Deep Research Job** produces an **Evidence Limitation Memo**, the **Research Card** should present it as an insufficient-evidence research outcome, not as a failed job or system error.
- A memo-state **Research Card** should show grounded reason summaries from **Report Limitations**, useful source/evidence counts, and **Memo Recovery Actions**.
- **Memo Recovery Actions** should be structured actions, not only prose suggestions.
- **Memo Recovery Actions** should be derived from grounded limitation origin data where possible, so the UI can offer relevant actions such as revise the compared entities, add missing sources, choose deeper depth, or start targeted follow-up research.
- Choosing a **Memo Recovery Action** must not silently publish a **Research Report** or auto-upgrade depth; the user remains in control of the revised plan or new **Deep Research Job**.
- Failed-job styling and language should be reserved for cancellation, infrastructure failure, unrecoverable worker failure, or other true execution failures.
- A **Research Card** is not the full **Research Report**.
- After a **Report Boundary**, the **Research Card** remains visible in the read-only conversation.
- The full **Research Report** opens in the workspace/report viewing surface rather than inline as chat content.
- The **Research Report** view exposes the report body, source list, and **Activity Timeline**.
- A **Research Report** is a durable workspace document.
- A **Research Report** is not automatically persona memory.
- A **Research Report** should influence future conversations only through explicit or strongly relevant retrieval signals.
- A **Deep Research Job** uses a **Research Workspace** for predictable, inspectable working state.
- A **Research Workspace** is structured; it is not a generic agent filesystem.
- AlfyAI should follow a Kimi-inspired Deep Research pattern where practical: iterative search, source review, reasoning over gaps, and synthesis happen as structured passes rather than one broad search followed by Markdown generation.
- The **Research Orchestrator** owns the **Research Workspace** and decides when to assign **Research Tasks**, run **Coverage Assessment**, request targeted follow-up, synthesize, or stop.
- The report writer does not own end-to-end research quality; it renders and shapes report-ready material after orchestration, coverage, synthesis, and audit have produced enough structured evidence.
- Each **Iterative Research Pass** should record its search intent, reviewed-source outcomes, **Evidence Notes**, **Coverage Gaps**, and pass decision in the **Research Workspace**.
- Kimi-inspired behavior must remain inspectable through AlfyAI's **Research Workspace** and **Activity Timeline**; it should not become an opaque transcript or private chain-of-thought surface.
- AlfyAI's Kimi-inspired foundation should match the practical pattern of long-horizon multi-turn search, tool use, context management, iterative cross-validation, conflict correction, and resumable work.
- AlfyAI should not try to imitate Kimi's end-to-end reinforcement-learning training in v1; the product foundation is a deterministic, durable **Research Orchestrator** plus structured graph state that can later benefit from stronger models.
- AlfyAI's equivalent of long-context management is **Workspace Rehydration** from durable graph state, not trusting one growing prompt transcript.
- AlfyAI's equivalent of partial rollout is a resumable **Research Resume Point** at pass and task boundaries.
- AlfyAI's equivalent of conflict self-correction is explicit **Claim Conflicts**, **Competing Synthesis Claims**, **Coverage Gaps**, **Repair Passes**, and **Citation Audit Verdicts**.
- The durable database-backed **Research Workspace** is the source of truth for iterative research state; model context and worker memory are disposable.
- The first implementation milestone should be the **Durable Research Graph Foundation**, not visual report rendering.
- The **Durable Research Graph Foundation** should include persisted pass checkpoints, first-class **Coverage Gaps**, first-class **Evidence Notes**, first-class **Synthesis Claims**, **Claim Evidence Links**, **Citation Audit Verdicts**, and **Report Limitations**.
- The **Topic-Relevance Gate** should be implemented before the **Durable Research Graph Foundation** starts treating reviewed sources as valid evidence.
- Report renderer work, Markdown polish, higher depth budgets, and richer progress UI should build on the **Durable Research Graph Foundation** instead of trying to compensate for missing research state.
- Each **Iterative Research Pass** must create or update a **Research State Checkpoint** before the next pass, synthesis, memo publication, or report publication begins.
- **Research State Checkpoints** should be stored as first-class persisted pass records, such as a `deep_research_passes` table, rather than inferred from **Research Tasks**, **Reviewed Sources**, or **Activity Timeline** rows.
- A **Research State Checkpoint** should include the pass number, search intent, task status summary, reviewed-source references, **Evidence Note** references, **Coverage Assessment** result, **Coverage Gaps**, limitations, usage summary, and next decision.
- A **Research State Checkpoint** may be mutable while its **Iterative Research Pass** is running.
- Once a **Research State Checkpoint** records a terminal **Pass Decision**, that decision should be treated as immutable.
- Later corrections, repairs, or reversals should create a new **Iterative Research Pass** or **Repair Pass** rather than mutating a completed pass decision.
- A **Repair Pass** uses the same workspace, checkpoint, coverage-gap, evidence-note, synthesis-claim, and audit-verdict model as other **Iterative Research Passes**.
- **Citation Audit** may request a **Repair Pass**, but it should not hide new research, replacement claims, or limitation decisions inside citation-audit side effects.
- **Coverage Gaps** should be stored as first-class persisted rows, such as a `deep_research_coverage_gaps` table, rather than only inside pass checkpoint JSON or final report limitations.
- A **Coverage Gap** should retain durable links to the **Deep Research Job**, **Research State Checkpoint**, approved plan question or comparison axis, status, severity, recommended next action, and any **Evidence Notes**, **Synthesis Claims**, or **Report Limitations** that resolved or inherited it.
- **Coverage Gaps** should have lifecycle states such as open, targeted, resolved, superseded, exhausted, or converted to limitation.
- A resolved **Coverage Gap** should remain inspectable so AlfyAI can explain why a targeted follow-up pass happened and which evidence or claims closed it.
- **Research Tasks**, **Reviewed Sources**, **Activity Timeline** events, usage records, and future synthesis records should reference the relevant **Research State Checkpoint** where practical.
- **Workspace Rehydration** should happen at the start of every worker step and before any model call that depends on prior research state.
- A **Research Resume Point** should exist for every running pass, required **Research Task**, synthesis step, citation-audit step, repair step, and report-assembly step.
- A **Research Resume Point** should record enough state to continue without relying on process memory, private model thoughts, or a previous worker's prompt context.
- Pass transitions should be idempotent: retrying a worker step after a crash must not duplicate sources, tasks, coverage gaps, or timeline events for the same pass decision.
- Pass completion and next-step creation should be committed atomically where practical, so a crash cannot leave the UI showing progress that the orchestrator cannot resume from.
- A timed-out or crashed job should resume from the latest valid **Research Resume Point** and rehydrate the **Research Workspace** before doing new work.
- If the latest pass has no terminal **Pass Decision**, resume should either complete the pending required tasks, mark expired tasks retryable or failed, or create a new recovery pass without mutating completed pass decisions.
- **Research Usage** is tracked for internal Deep Research model calls, tool calls, and workflow stages.
- **Research Usage** belongs to the **Deep Research Job** or **Research Task** that produced it, not fake chat messages.
- Deep Research cost should roll up into user, conversation, model, provider, and billing-month analytics.
- **Runtime Policy** should be runtime-configurable through the same admin/config path as other model-facing operational policy.
- **Runtime Policy** should include depth budgets, concurrency budgets, per-user active-job limits, global active-job limits, timeout windows, retry limits, and overrun behavior.
- Initial active-job defaults should allow one running **Deep Research Job** per conversation, up to two running jobs per user, and a conservative global worker cap sized to deployed infrastructure.
- When runtime is exhausted at a safe boundary, the orchestrator should run **Coverage Assessment** and choose report, memo, or failure from durable state instead of silently abandoning the job.
- User cancellation should stop new work, mark running tasks cancelled where practical, preserve the **Research Workspace**, and show cancelled **Research Card Severity** rather than an evidence memo.
- User-facing **Research Usage** may show runtime, source counts, and actual or estimated cost after completion.
- The primary completed-job time shown in the **Research Card** should be **Final Research Time**.
- **Final Research Time** should sit near the completed-job cost summary so users can scan both effort and cost.
- Worker-active time, model latency, token usage, and provider details may remain in analytics or diagnostics rather than the compact **Research Card**.
- Internal token/model/provider details belong in analytics, not the main **Research Report** UI.
- Deep Research uses **Iterative Research Passes**.
- A **Coverage Assessment** happens after each **Iterative Research Pass**.
- A **Coverage Assessment** may trigger another **Iterative Research Pass** when coverage is insufficient and **Research Budget** remains.
- A **Coverage Assessment** considers key-question coverage, source quality, source diversity, conflicts, freshness, and remaining **Research Budget**.
- **Coverage Assessment** is a separate structured evaluator step rather than the report writer's implicit judgment.
- **Coverage Assessment** returns whether coverage is sufficient and any **Coverage Gaps**.
- When coverage is insufficient and **Research Budget** remains, **Coverage Gaps** guide targeted discovery.
- If **Research Budget** is exhausted before coverage is strong, the **Research Report** must disclose limitations.
- **Coverage Assessment** decisions should be summarized in the **Activity Timeline**.
- **Research Tasks** may run in parallel, but each task has a narrow assignment.
- **Research Tasks** write structured outputs into the **Research Workspace**.
- The orchestrator decides whether to continue discovery, synthesize, or complete; individual **Research Tasks** do not.
- A **Pass Barrier** prevents **Coverage Assessment** or synthesis from running on incomplete required work.
- Parallelism is bounded by depth, user, and system limits.
- A failed **Research Task** records its reason in the **Research Workspace**.
- Transient **Research Task** failures may be retried.
- Failed **Research Tasks** become **Coverage Gaps** when they affect critical questions and cannot be replaced within budget.
- A **Deep Research Job** does not fail only because some non-critical **Research Tasks** fail.
- A **Deep Research Job** may complete with **Report Limitations** when it can still produce a useful, citation-supported **Research Report** or **Limited Research Report**.
- A **Deep Research Job** should fail only for true execution failure, unrecoverable invalid state, repeated infrastructure failure, or user cancellation; weak or partial evidence should normally become a **Limited Research Report** or **Evidence Limitation Memo**.
- **Report Limitations** must be visible in the **Research Report** or **Limited Research Report** rather than hidden in internal logs.
- Every **Research Report** and **Limited Research Report** goes through **Citation Audit**.
- **Citation Audit** verifies the **Claim Graph**, not only citation formatting.
- **Citation Audit** should inspect **Synthesis Claims**, **Evidence Notes**, and **Claim Evidence Links** before user-facing Markdown citation cleanup.
- **Citation Audit** should produce first-class **Citation Audit Verdicts** for **Synthesis Claims**, such as supported, partially supported, unsupported, contradicted, or needs repair.
- **Citation Audit Verdicts** should be durable inputs to **Report Limitations**, memo generation, and final report rendering.
- Markdown citation cleanup is a rendering concern after claim-graph verification, not the primary purpose of **Citation Audit**.
- Unsupported core claims must be repaired, removed, or disclosed as **Report Limitations**.
- **Report Limitations** should be generated from explicit **Coverage Gaps**, rejected or limited **Synthesis Claims**, unresolved contradictions, and **Citation Audit** verdicts rather than freeform caveats added after report writing.
- Each **Report Limitation** should retain enough structured origin data to show what question, entity, axis, claim, source pool, or audit verdict caused it.
- **Report Limitations** should be first-class graph objects, not derived-only fields on the final Markdown report.
- Generic limitations may be included only when they are tied to a concrete workspace signal, such as unavailable source types, stale evidence, inaccessible sources, or exhausted **Research Budget**.
- **Citation Audit** may trigger one **Repair Pass** before completion or failure.
- Every **Research Report** or **Limited Research Report** must pass the appropriate **Report Eligibility Gate** before **Citation Audit** can publish it.
- **Citation Audit** verifies evidence support for retained claims through **Claim Evidence Links**; it does not replace the **Report Eligibility Gate**.
- **Citation Audit** produces an **Audited Structured Report**, not a flat retained-claims list.
- **Citation Audit** should preserve report sections, comparison tables, recommendations, and plan-shaped analysis when their claims remain supported.
- **Claim-Grounded Report Assembly** should retain claim IDs and evidence-link references inside report sections, key findings, recommendations, comparison rows, and limitation records until final rendering.
- A **Research Report** or **Limited Research Report** has a semi-fixed readable structure: short title, executive summary, capped key findings, compact methodology, main body organized by the supported parts of the **Research Plan**, source list, and **Report Limitations** when applicable.
- A **Research Report** or **Limited Research Report** may add plan-specific sections such as recommendations, comparison matrices, timelines, methodology, appendices, or next steps.
- **Citation Audit** should preserve readable report structure while removing unsupported claims; it should not replace every report section with the same retained-claim list.
- Markdown is a rendering target for a **Structured Research Report**, not the report's source of truth.
- If the normal **Report Eligibility Gate** fails because evidence only supports part of the approved scope, Deep Research may publish a **Limited Research Report** with narrowed scope and explicit **Report Limitations**.
- If the **Report Eligibility Gate** fails because too few sources are topic-relevant to support useful synthesized conclusions, Deep Research should end with an insufficient-relevant-evidence outcome instead of publishing a normal **Research Report**.
- An insufficient-relevant-evidence outcome should create an **Evidence Limitation Memo**.
- An **Evidence Limitation Memo** is durable and inspectable, but it must not create the same user expectation as a completed **Research Report**.
- An **Evidence Limitation Memo** should use the same grounded **Report Limitations** and **Research Workspace** state as a failed-to-publish **Research Report**, rather than a separate memo-only explanation path.
- An **Evidence Limitation Memo** should summarize the approved goal, searched/reviewed scope, topic-relevant counts, evidence-note or claim-readiness gaps when available, rejected or limited claims, audit outcomes when available, why no credible report was produced, and the best next research direction.
- When the limitation state is the useful output, the **Evidence Limitation Memo** is that limitation state rendered for the user.
- An **Evidence Limitation Memo** does not create a **Report Boundary**.
- **Research Plan Revision Needed** does not create a **Report Boundary**.
- After an **Evidence Limitation Memo**, the conversation should remain usable so the user can use **Memo Recovery Actions** such as revising the request, adding sources, choosing deeper depth, or starting another **Deep Research Job**.
- After **Research Plan Revision Needed**, the conversation should remain usable so the user can revise or approve a corrected **Research Plan** without treating the prior result as evidence about the original topic.
- Deep Research should be built in independently testable and verifiable vertical slices.
- Deep Research slices should follow test-driven development: prove the behavior, implement it, then refactor.
- Deep Research v1 slices should be production-capable rather than prototype-only.
- A production-capable Deep Research slice includes fallback behavior, observability, tests, and cleanup appropriate to its scope.
- Deep Research cleanup should be part of replacement slices so obsolete paths do not remain as parallel behavior.
- Deep Research fixes should repair poisoned **Research Plan** generation before adding richer final rendering for the same failure path.
- The first stabilization slice for abstract decision prompts should make planning produce sane **Report Intent**, candidate-option discovery, and domain-appropriate key questions before **Limited Research Report** rendering is added.
- The first stabilization slice for abstract decision prompts should also include a minimal **Plan Health Check** so already-approved or slipped-through poisoned plans do not end as plain insufficient-evidence memos.
- The minimal **Plan Health Check** should trigger only on high-reviewed-source, zero-topic-relevant runs, detect obvious plan poison, and offer a plan-revision recovery path without automatically starting broad second research.
- A **Deep Research Evaluation Harness** should exist before raising Deep Research depth budgets.
- The **Deep Research Evaluation Harness** should include **Golden Research Fixtures** for off-topic high-authority sources, enough sources but weak **Evidence Notes**, unsupported **Central Claims**, **Non-Central Claim** removal, **Claim Conflicts**, crash/resume across passes, Hungarian output, abstract architecture recommendation plan pollution, and the bad downloaded report regression.
- The **Deep Research Evaluation Harness** should include Kimi-inspired hard-search fixtures that require multi-turn search, cross-validation, conflict correction, and cautious verification before answering.
- A generated output should fail evaluation when it reads like a source-note dump, repeats snippets without synthesis, makes unsupported central claims, hides unresolved conflicts, cites sources that do not support the claim, or publishes a report when the correct outcome is an **Evidence Limitation Memo**.
- Evaluation should treat readable synthesis, claim grounding, source relevance, citation support, durable resume, and localization as separate acceptance dimensions.
- CI and normal automated verification should use deterministic **Golden Research Fixtures**, not live web search.
- **Live Research Evaluation** may exist for manual or scheduled review, but it should be optional, non-blocking, and should save outputs for inspection rather than acting as a deterministic pass/fail gate.
- Raising **Research Budget** or **Pass Budget** without the **Deep Research Evaluation Harness** risks making low-quality research slower and more expensive rather than better.

### Example dialogue

> **Dev:** "Should every report request become a **Deep Research Job**?"
> **Domain expert:** "No. **Normal Chat** can still answer, search, and generate files. A **Deep Research Job** only starts when the user explicitly switches it on."
>
> **Dev:** "If the user cancels research midway, is that conversation now read-only?"
> **Domain expert:** "No. Only successful completion creates a **Report Boundary**."
>
> **Dev:** "Can the user ask a follow-up in the same conversation after the report is done?"
> **Domain expert:** "No. They can start a new conversation from the report, or start another **Deep Research Job**, but the completed report conversation stays read-only."
>
> **Dev:** "Should asking about a completed report automatically start deeper research?"
> **Domain expert:** "No. **Discuss Report** starts **Normal Chat**. **Research Further** is the explicit deep research path."
>
> **Dev:** "Can a deep research request immediately start browsing because the prompt seems clear?"
> **Domain expert:** "No. It first creates a **Research Plan** that the user can edit or approve."
>
> **Dev:** "If the user edits the plan, does that count as starting research?"
> **Domain expert:** "No. Editing produces a revised **Research Plan** and asks again whether to approve or edit."
>
> **Dev:** "Should users edit plans through a complex form?"
> **Domain expert:** "No. A **Plan Edit** is freeform, and AlfyAI turns it into a revised **Research Plan**."
>
> **Dev:** "Can AlfyAI silently upgrade a focused task to max depth?"
> **Domain expert:** "No. It can recommend a depth change in the **Research Plan**, but the user decides."
>
> **Dev:** "Can private library material help AlfyAI understand what the user likely means?"
> **Domain expert:** "Yes, as **Planning Context**. It only becomes a **Research Source** if the approved **Research Plan** includes it."
>
> **Dev:** "Should the user see why the plan seems personalized?"
> **Domain expert:** "Yes, the plan can show a compact context-considered disclosure without turning that context into report evidence."
>
> **Dev:** "Is the final deep research output just another assistant message?"
> **Domain expert:** "No. It is a durable **Research Report** that can be opened, reused, and inspected."
>
> **Dev:** "Can we say Max used 600 sources if most were only search candidates?"
> **Domain expert:** "No. Say 600 **Discovered Sources**, then separately count **Reviewed Sources** and **Cited Sources**."
>
> **Dev:** "Did Max fail if it reviewed fewer than 100 sources for a narrow topic?"
> **Domain expert:** "No. The **Research Budget** is a ceiling, not a quota."
>
> **Dev:** "Can approved research stop midway to ask the user what they meant?"
> **Domain expert:** "No. After approval, it should continue and disclose any assumptions it had to make."
>
> **Dev:** "Can the user add 'exclude Reddit' after approved research is already running?"
> **Domain expert:** "Not in v1. They can cancel and start a new **Deep Research Job** with a revised **Research Plan**."
>
> **Dev:** "Should running research just show a spinner?"
> **Domain expert:** "No. It should show a persisted **Activity Timeline** with meaningful research stages and source progress."
>
> **Dev:** "If the user asks in Hungarian for research using English sources, what language is the report?"
> **Domain expert:** "The **Research Language** is Hungarian, while **Research Sources** may remain English."
>
> **Dev:** "Should the completed report render inline as a huge chat message?"
> **Domain expert:** "No. The **Research Card** stays compact, and the full **Research Report** opens separately."
>
> **Dev:** "Where should users inspect a long Max report and its sources?"
> **Domain expert:** "In the workspace/report viewing surface, not by scrolling through chat."
>
> **Dev:** "Does completing a sensitive report mean future casual chats should remember it automatically?"
> **Domain expert:** "No. A **Research Report** is a workspace document, not automatic persona memory."
>
> **Dev:** "Should deep research rely on a hidden agent filesystem?"
> **Domain expert:** "No. It should use a structured **Research Workspace** so progress, sources, notes, and citations are inspectable."
>
> **Dev:** "Should AlfyAI copy Kimi's deep research pattern where it can?"
> **Domain expert:** "Yes. Follow the useful part: iterative search, review, gap reasoning, and synthesis as structured **Iterative Research Passes** owned by the **Research Orchestrator**."
>
> **Dev:** "Should the report writer own end-to-end research quality?"
> **Domain expert:** "No. The report writer renders report-ready material after orchestration, coverage, synthesis, and audit have produced enough structured evidence."
>
> **Dev:** "Does deep research search once and then write?"
> **Domain expert:** "No. It runs **Iterative Research Passes** until **Coverage Assessment** says coverage is sufficient or the **Research Budget** is exhausted."
>
> **Dev:** "If the report writer wants to proceed but a key question lacks evidence, what happens?"
> **Domain expert:** "A separate **Coverage Assessment** identifies the **Coverage Gap** and drives another targeted discovery pass if budget remains."
>
> **Dev:** "Can parallel search workers synthesize as soon as they individually finish?"
> **Domain expert:** "No. **Research Tasks** write to the **Research Workspace**, and a **Pass Barrier** waits for required tasks before assessment or synthesis."
>
> **Dev:** "Should Max fail because three reviewed pages could not be fetched?"
> **Domain expert:** "No, unless those failures prevent a credible report and cannot be replaced or disclosed as **Coverage Gaps**."
>
> **Dev:** "If two vendors hide pricing behind sales forms, should the whole report fail?"
> **Domain expert:** "No. Complete with **Report Limitations** and avoid unsupported pricing claims."
>
> **Dev:** "Can the report claim SOC 2 certification from a vague security marketing page?"
> **Domain expert:** "No. **Citation Audit** must reject or repair unsupported claims."
>
> **Dev:** "Should every report use exactly the same section template?"
> **Domain expert:** "No. The structure is semi-fixed: core trust sections are always present, while plan-specific sections adapt."

## Flagged ambiguities

- "canonical" means the preferred term inside the Deep Research subdomain, not the default format for all AlfyAI answers or reports.
- "finished chat" means a conversation after a **Report Boundary**, not cancellation, deletion, or archival.
