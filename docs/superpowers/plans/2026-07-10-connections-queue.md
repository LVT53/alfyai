# Connections Queue + UX/Analytics Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the remaining Connections roadmap (URL normalization, new connectors, OwnTracks connect + Wave B visualization, write-safety review + live-test) alongside five standalone UX/analytics fixes, each verified, reviewed, fixed, and deployed.

**Architecture:** SvelteKit 2 / Svelte 5 runes; Drizzle + better-sqlite3; Vitest; Biome; Vercel AI SDK tool-calling. Connections use a capability/provider registry (`registry.ts`), per-user encrypted vault (`vault.ts`), adapters (`adapters.ts`), write firewall (`write-guard.ts` + `write-executors.ts` + `pending-writes.ts`), and capability gating (`resolve.ts`). New connectors follow the existing provider pattern: a `providers/<name>.ts` adapter + a connect route under `src/routes/api/connections/<name>/` + registry entries + a normal-chat tool in `normal-chat-tools/` + UI tile in the settings connect strip.

**Tech Stack:** TypeScript, SvelteKit, Drizzle ORM, Vitest, Biome, lucide/simple-icons, Microsoft Graph (OneDrive), GitHub REST, CalDAV/CardDAV, Todoist REST.

## Global Constraints

- **Every task is TDD:** failing test first, minimal impl, green, commit. Full suite must stay green (`npm run test`), Biome clean (`npm run lint` / `npx biome check`), types clean (`npm run check`).
- **i18n:** every user-facing string gets English **and** Hungarian entries in the matching `src/lib/i18n/*.ts` file. No hardcoded UI copy.
- **Per-user isolation:** all connection reads/writes are strictly scoped to `user.id`. Never cross users.
- **Write firewall invariants (unchanged):** `allowWrites` gate checked *before* secret decrypt; writes are *always* a `pending_writes` proposal requiring explicit `confirmPendingWrite`, never inline/immediate; write-allowlist enforced via `resolveWriteTarget`; non-destructive defaults (trash not delete, If-Match where available); idempotency.
- **SSRF guard:** all user-supplied server URLs pass `assertPublicHttpsUrl` (public https only) before any request. New connectors that accept a URL MUST use it.
- **Data locality:** connector data flows through `decideLocalDistill`/`applyLocalDistillGate`; connector-derived facts are a documented memory non-goal — do not add connector data to memory.
- **Branch + deploy:** each Wave runs on its own branch off `main`; when the Wave is green + finally-reviewed, merge to `main`, push, then deploy via `bash scripts/deploy.sh` on prod (`ssh alfydesign`). Live-verification steps that need third-party accounts are user-gated and called out explicitly.

---

## Wave 1 — Standalone UX/Analytics fixes (independent, low-risk, deploy as one batch)

Branch: `wave1-ux`. These five tasks touch disjoint files and can be implemented in any order; do them sequentially per SDD.

### Task 1: Remove profile-picture colour switcher

**Files:**
- Modify: `src/routes/(app)/settings/_components/SettingsProfileTab.svelte` — remove the "Change color" Palette button (~262–270) and the dead props `avatarColors`/`avatarCount`/`selectedAvatar`/`showAvatarPicker`/`onSelectAvatar` (~48–55, types ~117–124); remove `avatarId={selectedAvatar}` on the preview `<AvatarCircle>` (~247).
- Modify: `src/routes/(app)/settings/+page.svelte` — remove `AVATAR_COLORS`/`AVATAR_COUNT` import (~55), `avatarId` field in `initialPreferences` type (~81), `selectedAvatar` state (~174), `showAvatarPicker` state (~234), `selectAvatar()` (~426–429), the five prop lines passed to the tab (~832–839), dead CSS `.avatar-swatch*`/`.avatar-selected` (~1100–1116).
- Modify: `src/lib/components/ui/AvatarCircle.svelte` — drop the `avatarId` prop; `const color = $derived(getAvatarColor(null, userId))` (or simplify the util signature).
- Modify: `src/lib/utils/avatar.ts` — keep the deterministic `userId`→palette hash as the sole path; `AVATAR_COLORS`/`AVATAR_COUNT` become internal (no external consumers after this task).
- Modify: `src/lib/components/layout/Sidebar.svelte` — remove `avatarId={...}` on both `<AvatarCircle>` (~356, ~384).
- Modify: `src/routes/(app)/settings/+page.server.ts:44`, `src/routes/api/settings/+server.ts:39`, `src/lib/server/services/auth.ts:65`, `src/lib/server/services/app-shell.ts:49,101` — remove `avatarId`/`userAvatarId` plumbing.
- Modify: `src/routes/api/settings/preferences/+server.ts` — remove `avatarId` body field (~30, ~88–90).
- Modify: `src/lib/client/api/settings.ts:137` — remove `avatarId` param.
- Modify: `src/lib/types.ts` — remove `avatarId` at ~225 and ~275.
- Modify: `src/lib/i18n/settings.ts` — remove `settings_changeColor`, `settings_changeColorA11y`, `settings_avatarNumber` (en+hu). Keep `settings_avatar` (labels the whole photo section).
- Modify tests: `SettingsProfileTab.test.ts` (drop the "Change color" props + assertions ~51–57, 144, 194, 197), and remove `avatarId`/`userAvatarId` fixtures in the test files that carry them (layout.server.test.ts, hooks.server.test.ts, settings page tests, chat page-load/page-runtime tests, analytics.test.ts, auth.test.ts, account-data-archive/index.test.ts, knowledge/upload/test-helpers.ts, client/api/settings.test.ts).

**Decision (keep DB column):** Do **not** drop the `avatar_id` DB column (`schema.ts:25`) — leave it dead to avoid a fragile SQLite drop-column migration. Remove only application code. `account-data-archive/index.ts:208` condition reduces from `avatarId !== null || profilePicture` to `profilePicture`.

**Requirements:**
1. The "Change color" control no longer renders in profile settings.
2. Avatars still render everywhere (sidebar, settings preview) with a stable per-user colour via `getAvatarColor(null, userId)`.
3. No dead references to removed props/state/i18n keys remain; `npm run check` clean.
4. Data export (account-data-archive) still embeds the avatar when a profile picture exists.

**Tests:** update `SettingsProfileTab.test.ts` to assert the "Change color" button is **absent** and upload/remove-photo still present; keep avatar-render tests green.

**Done:** button gone, avatars stable, full suite + check + lint green.

### Task 2: Restore per-model breakdown analytics (admin System Analytics)

**Files:**
- Modify: `src/lib/client/api/settings.ts` — widen `AnalyticsByModelRow` (~20–25) to add fields the server already returns: `promptTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`, `totalTokens`, and `providerDisplayName?`. (Server `analytics.ts` `AnalyticsByModelRow` already emits all of these via `materializeUsageBreakdown`; API already serializes them. **No server change.**)
- Modify: `src/routes/(app)/settings/_components/SettingsSystemAnalytics.svelte` — expand the existing "Cost by model" block (~313–328) into a full per-model **table** mirroring the per-user table (~361–406): columns Model (ModelIcon + displayName) / Requests (`msgCount`) / Prompt / Cached / Output / Reasoning / Total tokens / Cost (`formatUsd`). Reuse existing `ModelIcon`, `formatUsd`, and token-formatting helpers already in the component. Keep it inside the `{#if analyticsData.system.byModel?.length > 0}` guard.
- Modify: `src/lib/i18n/*.ts` (the analytics keys file) — add a section title key (e.g. `analytics.usageByModel` "Usage by model" / "Használat modellenként") if not present; reuse existing column-header keys (`analytics.model`, `analytics.msgs`, `analytics.promptTokens`, `analytics.outputTokens`, `analytics.reasoning`, `analytics.totalTokens`, `analytics.cost`) — add any missing (e.g. cached-input header) en+hu.

**Requirements:**
1. Admin System Analytics shows a per-model breakdown table with request count + per-token-class counts + cost, using data already returned by the API.
2. `displayName ?? model` shown with `ModelIcon`; numbers use `tabular-nums` and the same formatting as the per-user table.
3. Hidden when `byModel` is empty; respects the current month navigation (it already binds to `analyticsData.system`).

**Tests:** extend the analytics-tab test (`page-analytics-tabs.test.ts` or the component's test) to assert the per-model table renders rows from a `system.byModel` fixture with the token columns; assert it's absent when `byModel` is empty.

**Done:** table renders with full per-model stats, green.

### Task 3: Collapse memory items to one Sources entry

**Files:**
- Modify: `src/lib/components/chat/MessageEvidenceDetails.svelte` — the component flattens all groups into `allItems` (~62) then re-buckets by `status` (~66–73) and renders one `.evidence-row` per item (loops ~286, ~301 via `renderItem`). Change so that **memory-sourceType items collapse into a single synthetic row** labeled from `GROUP_LABELS.memory` ("Memory") with a count of the underlying memory items, instead of N rows. Non-memory items keep their current per-item rows. The single memory row should still be clickable/expandable if the existing row affordance supports it, but must not enumerate each memory item as its own top-level row.
- Discriminator: `item.sourceType === "memory"` (see `src/lib/types.ts:657` `MessageEvidenceItem`). Persona facts additionally use `id` prefix `memory-fact:` but all memory-derived items share `sourceType: "memory"`.
- `consideredCount`/`usedCount` (~75–76): counting semantics — the memory collapse should count as **one** used source entry in the summary line (not N), matching the user's "It should be 1 item named accordingly." Keep considered-count behavior sensible (document choice in the task report).

**Requirements:**
1. In the Sources disclosure, all memory items render as exactly **one** entry named "Memory" (with a count, e.g. "Memory · 4"), not one row per memory item.
2. Web/document/tool sources are unchanged.
3. The summary count line reflects memory as a single source.

**Tests:** add/adjust `MessageEvidenceDetails` test: given an `evidenceSummary` with a memory group of N items + one web item, assert exactly one memory row renders (with count N) and one web row; assert the summary counts memory as one source.

**Done:** single "Memory (N)" row, green.

### Task 4: Compact connector tool-call display in chat

**Files:**
- Modify: `src/lib/components/chat/ThinkingBlock.svelte` — the tool-call stack (~450–485, loop over `visibleTools` = `segments.filter(isVisibleThinkingToolCall)`) renders one `.tool-call-row` per tool call. Add **grouping for connector tool calls**: consecutive/collated connector tool calls (detected via `isConnectionToolName(tool.name)`) collapse into a single summary row per capability — e.g. "Google Calendar · 5 actions" — reusing the existing `fetchedSourceGroup` collapse precedent (~379–426: a summary row + expandable `<details>` list). Non-connector tool rows are unchanged. When expanded, list the individual connector actions (using `formatToolCall`/`formatConnectionToolAction`).
- Use helpers from `src/lib/utils/tool-calls.ts`: `isConnectionToolName`, `getConnectionToolLabelKey`, `formatConnectionToolAction`, `formatToolCall`.
- Grouping key: the capability tool `name` (one of the 7). Group label = the friendly connection label (existing `CONNECTION_TOOL_LABEL_KEYS` → i18n). Count = number of calls to that capability in the turn.
- Apply the same compaction to the expanded interleaved view (~487–591) so a burst of connector calls there is also grouped, keeping non-connector interleaving intact.

**Requirements:**
1. A round with many connector tool calls shows a compact grouped summary (per-capability, with a count), not dozens of rows.
2. Users can still expand to see the individual actions.
3. Non-connector tool calls (search/fetch/file-production/generic) render exactly as before.
4. Running vs done state still visible for the group (e.g. spinner while any call in the group is running, check when all done).
5. i18n for "{count} actions" (en+hu).

**Tests:** add a `ThinkingBlock` test: given segments with 6 `calendar` tool_call segments + 1 web-search segment, assert one grouped calendar summary row (count 6) + the web row; expanding reveals 6 action labels. Assert group shows running state when one call is running.

**Done:** grouped compact display, expandable, green.

### Task 5: Detailed "updating your memory" notice

**Files:**
- Modify: `src/lib/server/services/memory.ts` — in `getKnowledgeMemoryOverview` (~482–520), extend the `processing` payload to include a privacy-safe per-reason operation list: `operations: Array<{ reason: MemoryDirtyReason; scope: MemoryProfileScope; count: number }>`, aggregated from the dirty-ledger `pending` entries (group by `reason`+`scope`). Keep existing `active`/`pendingCount` for backward compat. Include the content-work reasons currently filtered (`deferred_intake`, `possible_conflict`, `possible_duplicate`) and optionally the other in-flight reasons present in `pending` (`stale_projection`, `projection_reconciliation`, `review_generation`, `profile_action_reconciliation`) so the list is informative. **Do not** surface raw fact text — only reason/scope/count (honors `assertPrivacySafeMetadata` privacy design).
- Modify: `src/lib/types.ts` — extend `KnowledgeMemoryOverviewPayload.processing` (~1747) with the `operations` array type.
- Modify: `src/routes/(app)/knowledge/_components/KnowledgeMemoryView.svelte` (~446–461) — when `processing.active`, render the existing header line plus a friendly, non-accordion `<ul>`/lines mapping each operation `reason` (+ scope hint for project scope) to human-readable copy via i18n, each with its count. No modal/accordion — just a compact list under the spinner.
- Modify: `src/lib/i18n/knowledge.ts` — add en+hu friendly labels per reason, e.g.:
  - `deferred_intake` → "Reviewing new details from your recent conversations" / "Új részletek áttekintése a legutóbbi beszélgetésekből"
  - `possible_conflict` → "Resolving a possible conflict"
  - `possible_duplicate` → "Merging a possible duplicate"
  - `review_generation` → "Preparing your memory review"
  - `stale_projection`/`projection_reconciliation` → "Refreshing your memory summary"
  - `profile_action_reconciliation` → "Applying a recent change"
  - plus a `{count}` suffix pattern and a project-scope hint.

**Requirements:**
1. While memory is updating, the notice shows a friendly, human-readable list of what's happening (per-reason lines with counts), not just "Updating your memory…".
2. No raw fact text is exposed — only privacy-safe reason/scope/count.
3. No accordion/modal; inline list under the existing spinner pill, `role="status"`/`aria-live` preserved.
4. Falls back gracefully to the single-line notice when `operations` is empty but `active` is true.
5. en+hu for every reason label.

**Tests:** `memory.ts` service test — assert `getKnowledgeMemoryOverview` returns grouped `operations` with correct counts from a seeded dirty ledger. `KnowledgeMemoryView` test — given `processing` with two operation reasons, assert both friendly lines + counts render; given empty operations but active, assert single-line fallback.

**Done:** friendly per-reason list, privacy-safe, en+hu, green.

**Wave 1 deploy:** final whole-branch review of `wave1-ux`, fix findings, merge to `main`, push, deploy. Live-verify in prod: profile settings (no colour button), admin analytics (per-model table), a chat answer using memory (single Memory source), a connector-heavy round (grouped tool calls), knowledge page while memory processes (friendly list).

---

## Wave 2 — URL normalization (connector framework prep)

Branch: `wave2-url`. Do before new connectors so they inherit bare-host input.

### Task 6: URL fields accept bare hosts (auto-prepend https://)

**Files:**
- Modify: `src/lib/server/services/connections/providers/nextcloud-files.ts` — `assertPublicHttpsUrl` (~74) is the single chokepoint used by Nextcloud + Immich (imports it) and should be used by Plex/OwnTracks connect too. Add a normalization step at the top: if the trimmed input has **no scheme** (no `^[a-z][a-z0-9+.-]*://`), prepend `https://` before parsing; then apply the existing public-https validation unchanged. A value that already specifies `http://` still fails the https requirement (unchanged) — we only *add* https to bare hosts, we do not downgrade or coerce an explicit http.
- Verify Plex (`plex/start/+server.ts`) and OwnTracks server-URL inputs route through `assertPublicHttpsUrl` (Plex adapter should; if a connect route trims a URL without validating, wire it through the guard).
- Client hint: update the URL input placeholders/help in the connect wizard (`ConnectWizardModal.svelte` and any provider URL field) to indicate the scheme is optional (e.g. placeholder `cloud.example.com`), en+hu.

**Requirements:**
1. Pasting `cloud.example.com` (no scheme) into any connector server-URL field connects as `https://cloud.example.com`.
2. Existing full `https://…` URLs behave exactly as before.
3. An explicit `http://…` still rejected (SSRF/public-https invariant preserved).
4. All password-key/URL-bearing providers (Nextcloud, Immich, Plex, OwnTracks, and new ones) inherit this via the shared guard.

**Tests:** unit-test `assertPublicHttpsUrl`: bare host → `https://host`; `https://host` unchanged; `http://host` throws; private/loopback host still throws (with and without scheme). Add a connect-route test asserting a bare host is accepted.

**Done:** bare hosts accepted centrally, invariants intact, green.

**Wave 2 deploy:** review, merge, deploy, live-verify by connecting a service with a bare host.

---

## Wave 3 — New connectors (sequential; share registry/schema/UI)

Branch: `wave3-connectors` (or per-connector sub-branches merged in order). Each connector follows the established pattern. **Template references:** password-key adapter → `providers/immich.ts` + `immich/start/+server.ts`; OAuth adapter → `providers/google.ts` + `google/start`; CalDAV → `providers/apple-caldav.ts`; tool → `normal-chat-tools/index.ts` capability blocks; registry → `registry.ts` `PROVIDER_META`/`CAPABILITY_META`; UI tile → settings connect strip + `BrandIcon.svelte`.

### Task 7: GitHub/Gitea connector (new "repos" capability)

**Files (create):**
- `src/lib/server/services/connections/providers/github.ts` — adapter: PAT auth (fine-grained or classic), `checkHealth` (GET `/user`), read methods: list repos, read repo tree/file, list issues, list PRs, list commits, list CI runs (Actions). Gitea variant: accept an optional base URL (default `https://api.github.com`), validated via `assertPublicHttpsUrl`. Read-only for v1 (writes are a later, confirm-gated follow-up — out of scope here unless trivial).
- `src/routes/api/connections/github/start/+server.ts` — POST { token, baseUrl? }; validate token via a `/user` probe; store PAT in vault; create connection.
- `src/lib/server/services/normal-chat-tools/` — a `repos` capability tool: actions `list_repos`, `read_file`, `list_issues`, `list_prs`, `list_commits`, `ci_status`, `search_code`. en+hu descriptions matching the connector tool standard.
- Schema/registry: add `github` to `ConnectionProvider` (schema.ts union + migration if the provider is an enum-checked column — follow how existing providers are added), add `repos` to `Capability`/`CAPABILITIES`, `PROVIDER_META.github = { capabilities: ["repos"], connectMethod: "app-password", displayName: "GitHub" }`, `CAPABILITY_META.repos = { tier: "explicit", providers: ["github"], displayName: "Repositories" }`.
- Adapter registration in `adapters.ts` + tool label wiring in `tool-calls.ts` (`CONNECTION_TOOL_LABEL_KEYS.repos`) + `BrandIcon.svelte` github glyph (vendored from simple-icons) + settings connect-strip tile + connect wizard branch (token + optional base URL, help link to create a PAT).

**Requirements:**
1. User connects GitHub with a PAT (optionally a Gitea base URL); health check passes.
2. Model can browse repos/issues/PRs/commits/CI and read files, read-only, scoped to the user's token.
3. Base URL (Gitea/GHE) validated via `assertPublicHttpsUrl`; api.github.com default.
4. Tool labels render as "GitHub: list repos" etc. (via the connector-label + compaction from Wave 1 Task 4).
5. New capability appears in the composer/settings capability model consistently.

**Tests:** adapter unit tests with mocked GitHub REST (repos/issues/PRs/commits/CI/file read, error mapping, token-invalid → needs_reauth); connect-route test; tool-gating test; registry test updated for the new provider/capability.

**Done:** GitHub read connector end-to-end, unit-tested green. **Live-verify (user-gated):** user creates a PAT and connects; run read probes via the diagnostic.

### Task 8: OneDrive connector (files capability, Microsoft Graph, OAuth2)

**Files (create):**
- `src/lib/server/services/connections/providers/onedrive.ts` — adapter under the **files** capability using Microsoft Graph (`/me/drive`): list folder, search, read file (download), metadata with mtime; OAuth2 (auth-code + refresh) mirroring `google.ts` token handling. `checkHealth` → GET `/me/drive`.
- `src/routes/api/connections/onedrive/start` + OAuth return route (mirror Google's start + callback), incremental scopes `Files.Read` (read-only v1; write is a later confirm-gated follow-up).
- Registry: `PROVIDER_META.onedrive = { capabilities: ["files"], connectMethod: "oauth", displayName: "OneDrive" }`; add `onedrive` to `CAPABILITY_META.files.providers`.
- Tool: OneDrive plugs into the existing `files` capability tool (multi-provider files) — extend files resolution to disambiguate Nextcloud vs OneDrive by connection (multi-account already supported). Reuse files tool actions (list/search/read).
- UI: BrandIcon onedrive glyph, connect strip tile, wizard OAuth branch.

**Infra note (user-gated):** Microsoft Graph OAuth requires an **Azure AD app registration** (client id/secret + redirect URI) supplied via env, exactly like Google. Build the flow reading `ONEDRIVE_CLIENT_ID`/`ONEDRIVE_CLIENT_SECRET` (+ redirect). Live-connect is gated on the user registering the Azure app and providing creds. If creds are absent, the connect tile is shown but the flow reports a clear "not configured" state (mirror how Google behaves without creds).

**Requirements:**
1. OneDrive is a `files`-capability provider via Microsoft Graph, read-only v1, OAuth2 with refresh.
2. Files tool transparently works across Nextcloud + OneDrive (multi-account disambiguation).
3. All Graph calls scoped to the user's token; tokens in vault; refresh handled.
4. Absent Azure creds → graceful "not configured", no crash.

**Tests:** adapter unit tests with mocked Graph (list/search/read/mtime, token refresh, error mapping); OAuth start/return route tests; registry test; files-tool multi-provider disambiguation test.

**Done:** OneDrive read connector end-to-end, unit-tested green. **Live-verify (user-gated):** user registers Azure app + provides creds + logs in.

### Task 9: Tasks capability + Generic CalDAV/CardDAV

**Files (create/modify):**
- `src/lib/server/services/connections/providers/caldav-tasks.ts` — CalDAV VTODO read (list tasks, due/status) generalizing the CalDAV client from `apple-caldav.ts`; and `todoist.ts` — Todoist REST (API token) read (projects, tasks). New `tasks` capability.
- Generic CalDAV/CardDAV: generalize `apple-caldav.ts` to accept an arbitrary user-supplied CalDAV/CardDAV base URL (app-password), so any standards server (Nextcloud, Fastmail, mailbox.org…) works for calendar + contacts. Add a `caldav`/`carddav` generic provider (or extend the existing generic `contacts` provider) — validated via `assertPublicHttpsUrl`.
- Registry: add `tasks` capability + `todoist`/`caldav` providers; wire `PROVIDER_META`/`CAPABILITY_META`.
- Tool: a `tasks` capability tool (list/search tasks, by project/due), en+hu.
- Connect routes + UI tiles + BrandIcon glyphs (todoist; generic CalDAV uses a generic glyph) + wizard branches (Todoist token; generic CalDAV URL+app-password).

**Requirements:**
1. Tasks capability: read tasks from CalDAV VTODO and Todoist, scoped per user.
2. Generic CalDAV/CardDAV lets a user connect any standards server by URL + app password for calendar/contacts.
3. All URLs via `assertPublicHttpsUrl` (inherits Wave 2 bare-host).

**Tests:** adapter unit tests (VTODO parse, Todoist REST, generic CalDAV discovery) with mocked responses; connect-route tests; registry tests.

**Done:** tasks + generic CalDAV/CardDAV connectors, unit-tested green. **Live-verify (user-gated):** user provides a Todoist token / generic CalDAV account.

**Wave 3 deploy:** each connector reviewed; merge the wave to `main`, deploy. Live-verify each as the user connects accounts; capture HTTP status/body via `scripts/diagnose-connections.ts` run inside the service env.

---

## Wave 4 — Location connect + Wave B visualization

Branch: `wave4-location-viz`.

### Task 10: OwnTracks connect flow (cleanly connectable)

**Files:**
- Review `providers/owntracks.ts` + `owntracks/start` + `owntracks/devices` — ensure a user can connect OwnTracks (recorder URL via `assertPublicHttpsUrl`, per-user device selection, `requiresSecret: false` semantics honored) and the `location` capability + B-tier `places`/`distance` actions work end-to-end. Fix any connect-flow gaps found. Ensure `homeLat`/`homeLon` config path for the `distance`-to-home feature is settable (today always unset).
- UI: OwnTracks connect tile + wizard branch (recorder URL + user/device), BrandIcon (MapPin fallback already), en+hu.

**Requirements:**
1. A user can connect OwnTracks and select their device; `last`/`history`/`places`/`distance` all resolve.
2. Recorder URL validated (public-https, bare-host accepted).
3. Per-user device isolation preserved.

**Tests:** connect-route + device-selection tests; location-tool gating test.

**Done:** OwnTracks connectable, green. **Live-verify (user-gated):** user connects their OwnTracks recorder.

### Task 11: Wave B visualization — agenda peek + photo strip

**Files (create):**
- A preview channel that, during thinking/wait time, surfaces (a) an **agenda peek** (next few calendar events) and (b) a **photo strip** (recent/relevant Immich thumbnails) rendered in `ThinkingBlock.svelte` — the two ideas the user liked from the mockup. Candidates built pre-redaction from the user's own connector data (privacy-safe by construction), gated on active connections + capability enabled, budget-capped, incognito-safe, locality-safe (never sent to a cloud model — display-only in the user's browser).
- Authed **Immich thumbnail proxy** endpoint (server-side, per-user, streams thumbnails using the vault key) so images render without exposing the Immich key to the client.
- Render: compact agenda list + horizontal thumbnail strip in the thinking area (reuse the mockup's approved layout: photo thumbnail row + agenda peek). No other mockup elements.

**Requirements:**
1. During a connector-relevant turn, the thinking area can show an agenda peek and/or a photo strip from the user's own data.
2. Thumbnails load via an authed per-user proxy; the Immich key never reaches the client.
3. Display-only: this data is not added to memory and not sent to cloud models (locality-safe); suppressed in incognito.
4. Budget-capped; absent/opted-out connections → nothing shown.
5. en+hu for any labels.

**Tests:** proxy endpoint auth/isolation test (user A cannot fetch user B's thumbnail); candidate-builder test (empty when no connections/incognito); render test for agenda peek + strip given fixtures.

**Done:** agenda peek + photo strip, privacy-safe, green. **Live-verify (user-gated):** user with Google Calendar + Immich connected.

**Wave 4 deploy:** review, merge, deploy, live-verify.

---

## Wave 5 — Write safety: review + careful live-test

Branch: `wave5-write-safety`.

### Task 12: Write-executor review pass (autonomous)

**Files (review, fix if needed):** `write-executors.ts`, `providers/nextcloud-files.ts` (PUT/MOVE/DELETE/MKCOL/share), `providers/google-calendar-write.ts` (create/update/delete), `providers/apple-caldav-write.ts`, `providers/imap-write.ts`, `providers/immich-write.ts`, `write-guard.ts`, `pending-writes.ts`.

**Requirements (audit checklist per executor):**
1. `allowWrites` gate is checked **before** secret decrypt.
2. Every write goes through a `pending_writes` proposal + explicit `confirmPendingWrite`; nothing writes inline.
3. Write target passes `resolveWriteTarget` allowlist; no path/calendar outside the allowed set.
4. Non-destructive defaults: delete → trash where available; updates use If-Match/ETag where the protocol supports it; no silent overwrite.
5. Idempotency: re-confirming the same pending write does not double-apply.
6. No corruption vectors: partial writes, wrong-resource targeting, encoding issues, recurrence-expansion on calendar edits.
7. Per-user isolation on the write path.

Produce a written audit report; fix any Critical/Important finding as a TDD change with a regression test. If clean, record that.

**Tests:** for any fix, add a regression test; otherwise assert the existing write-safety suite (`write-guard.test.ts`, `pending-writes*.test.ts`, `*-write*.test.ts`) covers the checklist points; add missing coverage.

**Done:** audit complete, fixes (if any) green.

### Task 13: Careful live-test of Nextcloud + Google Calendar writes (USER-GATED)

**Preconditions (user must do first):** enable "allow writes" on the Nextcloud connection; reconnect Google with the calendar-write scope. Confirm before running.

**Procedure:** using labeled throwaway data only (e.g. a folder `AlfyAI-writetest/` and a calendar event titled `ALFY TEST — delete me`), exercise: create folder, save a file, move, delete (→ trash), share-link; calendar create/update/delete. Each must go through the confirm chokepoint. Verify via read-back and via `scripts/diagnose-connections.ts` in the service env. Do **not** touch any real user data; clean up test artifacts afterward.

**Done:** writes verified non-destructive against real accounts with throwaway data; results reported.

**Wave 5 deploy:** review, merge any fixes, deploy.

---

## Execution order & deploy checkpoints

1. **Wave 1** (5 UX/analytics fixes) → deploy. *[fastest user-visible value, lowest risk]*
2. **Wave 2** (URL normalization) → deploy.
3. **Wave 3** (GitHub → OneDrive → Tasks/CalDAV) → deploy per connector or as one wave.
4. **Wave 4** (OwnTracks connect + Wave B viz) → deploy.
5. **Wave 5** (write review → live-test) → deploy.

**User-gated live-verification (build+unit-test+deploy proceeds regardless):**
- GitHub PAT (Task 7), Azure app + login for OneDrive (Task 8), Todoist token / generic CalDAV account (Task 9), OwnTracks recorder (Task 10), Immich+Calendar connected (Task 11), allow-writes + Google write scope (Task 13), and any Immich/Plex/Email accounts for outstanding B-tier live-checks.

## Self-review notes
- Wave 1 tasks are file-disjoint and each independently testable — correct task granularity.
- Type consistency: `processing.operations` (Task 5) shape defined once in `types.ts` and consumed in `memory.ts` + `KnowledgeMemoryView.svelte`. `AnalyticsByModelRow` widened once (Task 2) client-side to match the server type.
- Connector tasks reuse the proven provider pattern; each is one reviewer-gated deliverable.
- Live-test steps that need third-party accounts are explicitly user-gated, not blockers to build/deploy.
