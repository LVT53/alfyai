# App Shell Routes

## Request Bootstrap

- [`src/hooks.server.ts`](../../hooks.server.ts)
  - Validates the session cookie.
  - Attaches the current user to `locals`.
  - Refreshes runtime config overrides.
  - Starts optional maintenance work.
- [`src/routes/(app)/+layout.server.ts`](<+layout.server.ts>)
  - Preloads conversations, projects, models, and user-facing config.
  - This is the main bridge between server state and the authenticated app shell.
- [`src/routes/(app)/+layout.svelte`](+layout.svelte)
  - Owns client-side conversation-list refresh on focus/visibility.
  - Missing-current-conversation redirects must verify the conversation detail endpoint before sending the user back to `/`; a brand-new bootstrap chat can exist before the sidebar list includes it.
  - Sets `uiLanguage` from `data.userUiLanguage` in its script, not in `onMount`: the first message's chat is server-rendered (the landing sends with a full navigation), so the reader's language has to be there before the first frame, or the bootstrap view and every label are drawn in English first (F5). The root `+layout.svelte` puts the baseline back at the start of every server render, so a login page is never drawn in the previous reader's language. Do not move either write into `onMount`.


Do not:

- duplicate session/bootstrap checks inside every child route unless the route truly has extra requirements
- fetch the same layout data again in child pages unless the data is page-specific and cannot come from layout


## Client Shell And Page Boundaries

- [`src/routes/(app)/+page.svelte`](+page.svelte)
  - Landing page.
  - Prepares a draft conversation and stores the first pending message before navigation.
  - Must validate any stored landing draft conversation before reuse; only empty default-title prepared conversations are eligible for reuse from session state.
  - Owns the landing-to-chat visual handoff: once the first message is sent, the landing composer should transition into a bottom-docked "opening chat" state instead of staying centered like the idle hero surface.
  - First-message sends may use a full document navigation to `/chat/[conversationId]` after storing the pending message so deploy/restart edge cases cannot leave the browser visually stuck on the landing route while the new chat already runs on the server.
  - A conversation nothing has named yet is STORED as `DEFAULT_CONVERSATION_TITLE` ("New Conversation", `src/lib/shared/conversation-title.ts`: the database default, the prepared draft, the generator's fallback, and what several places compare against) and SHOWN through `conversationDisplayTitle` as `chat.untitledConversation` ("Új beszélgetés" in a Hungarian UI). Never print the stored sentence, and never compare against the localized one.
- [`src/routes/(app)/chat/[conversationId]/+page.svelte`](chat/[conversationId]/+page.svelte)
  - Owns visible chat page state, route lifecycle hooks, draft persistence, document workspace state, and UI commands for an existing conversation.
  - Delegates Normal Chat browser-side send, retry, reconnect, waiting, stop, and queued follow-up runtime semantics to `src/lib/client/normal-chat-client-turn-runtime.ts`.
  - Keeps visible queued-turn preview and composer state through runtime adapters, while the runtime decides queued turn admission, restore, and drain ordering.
  - Owns route-level working-document workspace state. Which document is open, active, compared, or closed belongs here, not inside file-row or preview components.
  - The chat detail route should stay visually distinct from the landing page: the composer remains bottom-docked and the message surface stays visible even before the first persisted messages arrive.
  - Route-local `_components/` and `*_helpers.ts` files are acceptable for chat render scaffolding and pure page-only transforms, but Normal Chat client turn runtime semantics should stay in the client runtime module.
- [`src/routes/(app)/knowledge/+page.svelte`](knowledge/+page.svelte)
  - Large page-specific knowledge UI with a single primary content column.
  - Main content: Library and Memory Profile tabs.
  - Upload, search, and document-management behavior lives inside the main library panel.
  - Also owns the knowledge-side working-document workspace shell and cross-route workspace handoff from global search.
  - It may contain page-local fetches for page-only actions, but shared browser API logic should still move to `src/lib/client/api/` if reused.
- [`src/routes/(app)/settings/+page.svelte`](settings/+page.svelte)
  - User settings and admin/runtime config UI surface.
  - The Profile tab is grouped into Account, Preferences, Assistant, Data & privacy, and Your Activity sections (ADR 0043). Skills is a summary card that opens a dedicated full-screen manager. Personal analytics merged into Profile as "Your Activity"; the standalone Analytics tab is removed for normal users.
  - The Administration tab (admin only) is split into `System`, `Users`, and `Campaigns` panes, and also hosts system-level analytics (overview, per-user, excluded users) for admins.
  - Route-local `_components/`, `*_helpers.ts`, or `*.svelte.ts` files next to the page are acceptable when splitting page-only UI/controller logic without creating a new shared boundary.


Do not:

- move chat orchestration into shared visual components
- make `MessageInput.svelte` own cross-page navigation or conversation bootstrap decisions
- make `MessageInput.svelte` own queued-turn orchestration; it may emit `onQueue`, but the Normal Chat Client Turn Runtime decides queued-turn admission, auto-send, and restore behavior through page-owned adapters
- let `MessageInput.svelte` retain a stale internal `conversationId` after the parent clears the prop; landing-page sends and uploads must fall back to the parent-owned prepared-conversation flow instead of silently targeting an old conversation
- turn page files into long-lived business-logic modules when a store/service/helper boundary already exists


## Announcements (the welcome, the release card, and the feature note)

Two kinds of campaign reach the whole app (`first_run_onboarding`, `release_update`); a tour is not one (see Tours), and a feature note (`feature_note`) is a fourth campaign kind that reaches only the landing. Who is shown what, and when, is ADR-0012 as amended 2026-10-13 and 2026-10-17, and each half has one owner:

- **Who** is `getEligibleCampaignForUser` in `src/lib/server/services/announcement-campaigns.ts`: the latest welcome only to an account that has never finished or skipped ANY welcome (a state row on a snapshot of that type, so a new revision or an archived one reaches nobody who has been through one), else the latest release to an account that has not finished it and was here before it was published (`users.created_at` before `published_at`). The release is derived from the account's age and never from a stored "seen" row: do not write a state row for a release when a welcome is finished, it would use up a card another account still needs. The badge's `getLatestPublishedAnnouncement` is the latest release, else the latest welcome.
- **When** is the shell's one mount check in `src/routes/(app)/+layout.svelte`, an arrival only. `mayAutoShowCampaign` (`src/lib/client/campaign-replay.ts`) says the load that carries a first message from the landing page into its new chat is no arrival (that hand-off is a full document navigation that mounts the shell again); it reads the hand-off's pending message through `conversation-session.ts` and must be asked at the start of the document, because the chat takes the message up a frame later. `/api/campaigns/eligible` offers nothing while the account has a turn running (`userHasActiveChatStream`). Do not call the eligibility endpoint from a navigation, a list refresh, a focus handler or a send.
- **The feature note** is the landing-only fourth kind: one `standard`/`feature` slide naming a small feature, with one body line and an optional allow-listed action (never `internal:`), and no screenshots or setup controls. Its reader is `getEligibleFeatureNoteForUser` and its endpoint `GET /api/campaigns/feature-note`; neither `getEligibleCampaignForUser` nor the badge ever returns one, so a note cannot open in the campaign modal and is not replayable. The shell asks for it once per landing arrival, only after the document's one campaign check settled with no campaign — or on a later landing arrival when no campaign is active, even if that check had returned a campaign which was then dismissed — and re-checks every guard after the request (`(app)/+layout.svelte`). The campaign wins the arrival, a note never follows a campaign in the same arrival, and one note is live at a time (publishing a note archives the previous one). The shell records the arrival's one `auto_shown` and hides the note for the rest of the arrival on a send, a campaign opening, or leaving `/`; that is a latch, not a dismissal. X writes `skipped` through `completeCampaign`; the CTA writes `completed` through `completeCampaignOnLeave` (keepalive, then the `<a>` navigates). Both are terminal. The four-showing cap is soft: the eligibility read and the showing write are separate requests, so tabs or a fast reload can exceed it. `FeatureNoteStrip.svelte` is presentational; the shell owns every call.
- **e2e.** `tests/e2e/campaign-audience.spec.ts` publishes and archives its own campaigns and uses accounts of its own (an `existing` one made ten days ago, a new one made after the publish). A spec that publishes a welcome, a release or a feature note must archive it again, or every later spec on that worker's database meets it.

## Rules In Other Files

- The chat page's side panel (its history entries, the dock, `openWorkspaceDocument`): `src/lib/components/document-workspace/AGENTS.md`; what the Document shows while Alfy works: `src/lib/components/artifacts/document/AGENTS.md`.
- `settings/_components/campaigns/`, the admin's tour editor: `src/lib/components/artifacts/tour/AGENTS.md`.
