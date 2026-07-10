# UI Refresh Implementation Plan

**Parent ADR:** [`docs/adr/0043-ui-refresh-identity-clarity-and-jump-rail.md`](./adr/0043-ui-refresh-identity-clarity-and-jump-rail.md)
**Created:** 2026-07-03
**Status:** Planning — slices to be executed in dependency order, then two review slices, then browser visual test.

This document breaks the ADR-0043 decisions into **vertical tracer-bullet slices**. Each slice cuts through all integration layers end-to-end (schema → service → route → component → i18n → tests) and is independently demoable. Slices are ordered so blockers come first.

Conventions confirmed by codebase exploration:
- **i18n:** keys live in `src/lib/i18n/{common,chat,settings,knowledge,skills}.ts`, each with `en:` and `hu:` blocks in the SAME file. Every new key MUST be added to both blocks. `index.ts:35` enforces parity. Placeholders use `{name}`.
- **Migrations:** `drizzle/<timestamp_ms>_<slug>.sql` + one entry appended to `drizzle/meta/_journal.json` (`idx`, `version:"7"`, `when:<timestamp>`, `tag:<slug-without-.sql>`). No snapshot JSON needed (project stopped emitting those after idx 8). Run `npm run check:migrations` to verify.
- **Schema changes:** add the column to `src/lib/server/db/schema.ts` AND ship the matching migration in the same slice. Never one without the other.
- **Verification gates (AGENTS.md):** `npm run check` (0 errors + 0 warnings), `npm run lint`, `npm test`, `npm run build` after each slice. Fallow + Playwright where chat/streaming is touched.
- **i18n parity:** every new user-facing string in EN + HU, or `npm run check` fails.

---

## Slice 0 — Prefactor: shared viewport/capability helper

**Blocked by:** None.
**Decisions covered:** #8 (touch/capability model).

### What to build
A single source of truth for viewport/capability detection at `src/lib/utils/viewport.ts`, plus `viewport.test.ts`. Consolidates the 7 inconsistent checks scattered across `ChatComposerPanel`, `ContextUsageRing`, `MessageInput`, `SearchModal`, `ModelSelector`, `DocumentWorkspace`.

### API
- `isTouchDevice()` → `boolean`. SSR-safe (`typeof window === "undefined"` → `false`). Uses `window.matchMedia("(hover: none) and (pointer: coarse)").matches`.
- `viewportTier()` → `"phone" | "tablet" | "desktop"`. SSR-safe → `"desktop"`. `<640` phone, `640–1023` tablet, `≥1024` desktop.
- A Svelte-readable reactive store (`viewportStore`) exposing `{ touch, tier }` updated on `resize` + `orientationchange` + `(pointer) change` media-query listeners, for components that need reactivity (`MessageInput`, `ModelSelector`). Lazy-initialized, SSR-safe.

### Acceptance criteria
- [ ] `src/lib/utils/viewport.ts` + `viewport.test.ts` exist; tests cover SSR (no window), touch=true/coarse, touch=false at three tiers.
- [ ] All 7 existing scattered checks replaced with calls to the helper (no behavior change yet — this slice only consolidates; the *new* affordance rules land in slices that touch each component).
- [ ] `npm run check`, `npm run lint`, `npm test`, `npm run build` clean.
- [ ] Manual: app behavior unchanged on desktop, tablet-width, phone-width.

---

## Slice 1 — Mobile keyboard jank fix

**Blocked by:** Slice 0.
**Decisions covered:** #10.

### What to build
Add `interactive-widget=resizes-content` to the viewport meta in `src/app.html`; delete the custom `keyboardOffset` JS and the `transition: padding-bottom 150ms` in `ChatComposerPanel.svelte`; switch to CSS `100dvh` + bottom anchoring.

### Acceptance criteria
- [ ] `src/app.html` viewport meta includes `interactive-widget=resizes-content`.
- [ ] `ChatComposerPanel.svelte`: `keyboardOffset` state, `handleVisualViewportChange`, the `onMount`/`onDestroy` visualViewport listeners, and the `padding-bottom` calc all removed. Composer anchored via `dvh` units.
- [ ] `transition: padding-bottom 150ms ease` removed from `.composer-layer`.
- [ ] `npm run check/lint/test/build` clean.
- [ ] Manual on Android Chrome + iOS Safari: keyboard appears, composer stays glued to visual bottom with no lag, no double-offset, no jump.

---

## Slice 2 — Schema: file-production `dismissed` flag

**Blocked by:** None (purely additive).
**Decisions covered:** #14(d).

### What to build
Add `dismissed` boolean column to `file_production_jobs`, default `false`, following the `retryable` precedent (`schema.ts:1538`). Ship the migration.

### Acceptance criteria
- [ ] `src/lib/server/db/schema.ts`: `dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false)` added to `fileProductionJobs`.
- [ ] Migration `drizzle/<ts>_file_production_jobs_dismissed.sql`: `ALTER TABLE file_production_jobs ADD dismissed integer DEFAULT 0 NOT NULL;`
- [ ] `_journal.json` entry appended with next `idx` (82), `when`/`tag` = timestamp.
- [ ] `npm run check:migrations` passes.
- [ ] `npm run db:prepare` is idempotent against an existing DB (the migration applies cleanly).
- [ ] `npm run check/lint/test/build` clean.

---

## Slice 3 — File-production dismiss lifecycle (service + API + read-model)

**Blocked by:** Slice 2.
**Decisions covered:** #14(d).

### What to build
The full dismiss lifecycle: a dismiss action on the job ledger, a thin API route, and a read-model filter so dismissed failed/cancelled jobs stop resurfacing on reload (restorable via an explicit "include dismissed" flag).

### Acceptance criteria
- [ ] `job-ledger.ts`: new `dismissFileProductionJob({ userId, jobId })` that sets `dismissed=true` only on `failed`/`cancelled` jobs (no-op or error otherwise); records the transition in the existing trace prefix.
- [ ] `read-model.ts`: `listConversationFileProductionJobs(..., { includeDismissed?: boolean })` filters `dismissed=true` rows out unless `includeDismissed` is true. The conversation-detail read-model calls it with `includeDismissed: false` by default.
- [ ] `src/lib/types.ts`: `FileProductionJob` gains `dismissed: boolean`.
- [ ] New thin route `src/routes/api/chat/files/jobs/[id]/dismiss/+server.ts` — POST, auth-gated (session OR signed assertion like the other job routes), delegates to the facade.
- [ ] `npm run check/lint/test/build` clean. New service path has unit tests (dismiss only on failed/cancelled; read-model filter parity).

---

## Slice 4 — FileProductionCard revamp (running + failed + dismiss)

**Blocked by:** Slice 3.
**Decisions covered:** #14(b)(c)(e).

### What to build
Rewrite the `isActive` branch (today: empty shimmer + X) to render title, elapsed timer, animated progress bar, and Stop. Add the stale-job amber honesty state. Revamp the failed-non-retryable branch with human copy + Dismiss + suggestion. Pass `onDismiss` from the chat page.

### Acceptance criteria
- [ ] Active branch renders `job.title`, a client-side elapsed timer (`m:ss`, tabular-nums) computed from `job.createdAt`, a spinning `LoaderCircle`, an animated gold gradient-sweep bar (reusing the compaction motion keyframes), and a Stop (`Square`) cancel icon — not a dominant X.
- [ ] Stale branch: when `Date.now() - job.createdAt.getTime() > 90_000` AND status is `queued`/`running`, render the amber "Still working… or stalled. We'll know in a moment." state (client heuristic only; no new backend field).
- [ ] Failed non-retryable: human copy "Couldn't produce this file" + plain `errorMessage` + Dismiss (X) icon button + a one-line suggestion. Retryable keeps the existing Retry (`RotateCw`).
- [ ] `FileProductionCard.svelte` accepts `onDismiss?: (jobId: string) => void`; chat page wires it to the dismiss route.
- [ ] New i18n keys in `chat.ts` (EN + HU): `fileProduction.producing`, `fileProduction.elapsedFormat`, `fileProduction.staleHeading`, `fileProduction.staleDescription`, `fileProduction.couldNotProduce`, `fileProduction.suggestion*`, `fileProduction.dismiss`.
- [ ] `npm run check/lint/test/build` clean. Reduced-motion: bar/elapsed animations honor `prefers-reduced-motion` (static bar, no spinner).
- [ ] Manual: trigger a long-running produce job (large program), confirm title+elapsed+bar; force a non-retryable failure (oversized program), confirm Dismiss removes the card and it stays dismissed after reload.

---

## Slice 5 — Mobile compare view bug fix

**Blocked by:** None.
**Decisions covered:** #14(j).

### What to build
Fix the copy-paste bug in `DocumentWorkspace.svelte` mobile compare branch.

### Acceptance criteria
- [ ] Mobile branch (`:1023-1046`) restructured to match desktop (`:1272-1292`): exactly one `.workspace-compare-panel-body` per `<section>` — current in section 1, compared in section 2. The duplicate `compareOtherTextHtml` block removed.
- [ ] `syncScroll` `leftPanelBody`/`rightPanelBody` binds still reference the correct elements.
- [ ] `npm run check/lint/test/build` clean.
- [ ] Manual on phone width: open two versions of a generated doc in compare mode; current shows once, compared shows once; sync-scroll works.

---

## Slice 6 — Knowledge Library fixes (bug cluster)

**Blocked by:** Slice 0 (for the loading-state and mobile select-all).
**Decisions covered:** #11.

### What to build
Six concrete fixes in `DocumentsList.svelte` and the knowledge page.

### Acceptance criteria
- [ ] Remove the stray `...` text node in the bulk-delete button (`:1098-1106`).
- [ ] `handleDrop` surfaces a toast/inline error when `validFiles.length === 0`, and validates the 100MB size limit client-side before upload (today silently passed to server).
- [ ] Loading state: a navigating flag tracked around `updateKnowledgeLibraryParams` drives the existing `.loading` opacity + an input spinner during server-side search/sort/page round-trips.
- [ ] Mobile select-all: a "Select all (N)" control in the bulk-action bar (works when thead is hidden `<720px`).
- [ ] Nested scroll: table's `max-height: 600px` inner scroll removed on desktop; table grows with the page scroll, sticky header preserved. (Mobile keeps the existing stacked-card behavior.)
- [ ] Memory category empty states get a one-line explainer (`memoryProfile.emptyHint`) + a link to relevant settings.
- [ ] New i18n keys in `knowledge.ts` + `chat.ts` (memory hint): EN + HU.
- [ ] `npm run check/lint/test/build` clean. Manual: drop a `.zip` (see error), search (see spinner), select-all on mobile, scroll a long library on desktop (no nested scrollbar).

---

## Slice 7 — Memory actions: single "Remove" → modal

**Blocked by:** None.
**Decisions covered:** #13.

### What to build
Replace the two instant-firing destructive icon buttons (Suppress X + Delete trash) on memory items/review cards with a single trash entry point that opens a confirm modal teaching Forget vs Delete permanently.

### Acceptance criteria
- [ ] New modal `MemoryRemoveModal.svelte` (or extend the existing modal pattern in `KnowledgeMemoryView`/`_components`) with header "Remove this memory?" + X top-right + the memory text shown for context + a framing line + three options: **Forget** (EyeOff, terracotta), **Delete permanently** (Trash, red), **Cancel** (quiet). Plain-language explainers under each action.
- [ ] `KnowledgeMemoryView.svelte`: inline cards now show View · Edit · Remove (single trash). The "Do not remember" X icon is removed from the inline row; the trash Delete is removed from the inline row. Both dispatch through the modal.
- [ ] Modal dispatches the existing `onAction` with the correct `{action: "suppress" | "delete"}` based on the chosen button — no new backend behavior, just the UX gate.
- [ ] New i18n keys in `chat.ts` (memoryProfile namespace): `removeTitle`, `removeFraming`, `forget`, `forgetDescription`, `deletePermanently`, `deletePermanentlyDescription`, `cancel`. EN + HU.
- [ ] `npm run check/lint/test/build` clean. Focus trap, Escape-to-close, focus-restore on close. Manual: open modal, choose Forget (suppress happens), choose Delete (delete happens), Cancel/X escape harmlessly.

---

## Slice 8 — "AI-facing version" → "What the AI sees"

**Blocked by:** None.
**Decisions covered:** #12.

### What to build
Rename the row action + expanded panel label and add a one-line explainer.

### Acceptance criteria
- [ ] `DocumentsList.svelte`: Bot icon button → Eye icon (terracotta) with `title` "What the AI sees" (`knowledge.whatAiSees`).
- [ ] Expanded panel heading "AI-facing version" → "What the AI sees" + explainer line `knowledge.whatAiSeesDescription` ("AlfyAI reads this normalized text instead of the raw file — shown so you can verify the model understood your document correctly.").
- [ ] Old keys (`knowledge.aiFacingVersion`, `knowledge.viewAiVersion`) retired (kept as aliases mapping to new keys for one cycle, or removed if no external callers — verify).
- [ ] EN + HU in `knowledge.ts`.
- [ ] `npm run check/lint/test/build` clean.

---

## Slice 9 — Search modal "Keep typing…" hint

**Blocked by:** None.
**Decisions covered:** #14(a).

### What to build
Replace the misleading "recent" results shown for 0–1 char queries with an explicit hint.

### Acceptance criteria
- [ ] `SearchModal.svelte`: when `trimmedSearchQuery.length < 2` AND a non-empty query has been entered, render the "Keep typing to search…" state (with a subtle Search icon) instead of fetching/showing recents.
- [ ] Recents appear ONLY when the query is empty (the landing state) — unchanged.
- [ ] New i18n key `searchModal.keepTyping` in `chat.ts` EN + HU.
- [ ] `npm run check/lint/test/build` clean. Manual: type "a" → see hint, not unrelated recents.

---

## Slice 10 — Composer dead-ends (over-length + disabled-send + `/` shortcut)

**Blocked by:** Slice 0.
**Decisions covered:** #14(f)(g)(h).

### What to build
Three composer fixes: always-visible red counter for over-length (no truncate button), disabled-send reason hint, `/` focus shortcut.

### Acceptance criteria
- [ ] `MessageInput.svelte`: char counter is always visible (not just above 80%); when over `maxLength`, shows red `{n} / {max} — too long to send` (`chat.tooLongFormat`). **No truncate/auto-cut button** — the user edits their own content.
- [ ] When `!canSend && message.trim()` is non-empty, render a one-line hint (e.g. "Waiting for attachment…") near the send button instead of a silent disabled button. Hint text derives from the blocking reason where derivable.
- [ ] Global `/` keydown listener (on `document`) focuses the composer textarea when the target is not already an input/textarea/contenteditable and no modifier keys are held. Includes a one-time coach hint near the composer on first chat.
- [ ] New i18n keys in `chat.ts`: `tooLongFormat`, `waitingForAttachment` (and any other reason strings), `slashShortcutHint`. EN + HU.
- [ ] `npm run check/lint/test/build` clean. Manual: paste 50k chars (red counter, no button), attach a file and type (hint shows until ready), press `/` from anywhere (composer focuses).

---

## Slice 11 — Hover→touch/focus affordance rule (chat surface)

**Blocked by:** Slice 0.
**Decisions covered:** #9 (+ the `codeBlock.copied` i18n leak fix from the audit).

### What to build
Apply the canonical touch/focus rule to: message action row, code copy button, audit-info popover, action tooltips.

### Acceptance criteria
- [ ] `MessageBubble.svelte` action row: on touch (helper), always visible at ≥44px at all widths (not just `sm:`); on desktop, `md:opacity-0 md:hover:opacity-100` keeps quiet-by-default but adds `md:focus-within:opacity-100` so keyboard focus reveals the row.
- [ ] `CodeBlock.svelte`: desktop copy shows at `opacity: 0.4` by default → `1` on hover/focus; touch shows full-opacity ≥44px. Hardcoded "Copied!" string at `:65` replaced with `{$t('codeBlock.copied')}` (new key EN "Copied!" / HU "Másolva!" in `chat.ts`).
- [ ] `MessageBubble.svelte` info popover + action tooltips: on touch, a tap toggles them (not hover-only). Audit-info (cost/tokens/model) reachable on mobile.
- [ ] New i18n key `codeBlock.copied` in `chat.ts` EN + HU.
- [ ] `npm run check/lint/test/build` clean. Manual: on desktop Tab through a message (row reveals), hover code (copy at 40%), on touch device/toggle device-mode (action row always visible, copy full, tap Info opens popover).

---

## Slice 12 — Favicon privacy proxy route

**Blocked by:** None.
**Decisions covered:** #14(i).

### What to build
Same-origin `/api/favicon?domain=...` route: source-site `/favicon.ico` first, DuckDuckGo fallback (`https://icons.duckduckgo.com/ip3/{domain}.ico`), in-memory cache, graceful globe fallback. `ThinkingBlock` switches to it.

### Acceptance criteria
- [ ] `src/routes/api/favicon/+server.ts` GET handler: validates `domain` (rejects non-hostnames, IP literals, localhost to prevent SSRF), tries source `/favicon.ico`, falls back to DuckDuckGo, caches in a bounded in-memory LRU, returns the image with long-lived `Cache-Control` + correct `Content-Type`. On any failure returns a generic globe SVG (200, not an error).
- [ ] SSRF hardening: domain validation (no IPs, no localhost/private ranges, scheme forced to https, redirects not followed to internal addresses). Add a unit test for the validator.
- [ ] `ThinkingBlock.svelte`: `getFaviconUrl` returns `/api/favicon?domain=${encodeURIComponent(host)}` instead of the Google S2 URL.
- [ ] `npm run check/lint/test/build` clean. Manual: trigger a web-grounded answer, confirm favicons load via `/api/favicon` (network tab), confirm no `google.com` requests, confirm graceful fallback when a domain has no icon.

---

## Slice 13 — Pass-1 decision 1: LogoMark placement

**Blocked by:** None.
**Decisions covered:** Pass-1 #1.

### What to build
Add the existing `LogoMark.svelte` (unchanged) to the sidebar header, collapsed rail, empty conversation state (static — `animated={false}`), mobile header, and ship a favicon asset. The mark's look/animation stay exactly as-is.

### Acceptance criteria
- [ ] `Sidebar.svelte`: `LogoMark` beside the "AlfyAI" wordmark in the header; collapsed rail shows the mark alone as the rail icon (replacing/augmenting the chevron).
- [ ] `MessageArea.svelte` empty state: static `LogoMark` (`animated={false}`) as centerpiece + the new copy (see Slice 14).
- [ ] `Header.svelte` (mobile): mark beside/above the truncated title.
- [ ] Favicon: add a `static/favicon.svg` (or .png) derived from the mark, wire `src/app.html` `<link rel="icon">`.
- [ ] No changes to `LogoMark.svelte` colors or animation.
- [ ] `npm run check/lint/test/build` clean. Manual: confirm mark appears in all 5 new homes + favicon in the browser tab.

---

## Slice 14 — Pass-1 decision 7: empty conversation state copy

**Blocked by:** Slice 13 (uses the static mark).
**Decisions covered:** Pass-1 #7.

### What to build
Replace the "Conversation Ready" dead text with the static mark + "How can I help?" + composer hint.

### Acceptance criteria
- [ ] `MessageArea.svelte` empty state: static `LogoMark` (from Slice 13) + serif headline `chat.emptyHeadline` ("How can I help?") + quiet hint `chat.emptyHint` ("Type below to start the conversation.").
- [ ] Old strings (`chat.conversationReady`, `chat.messagesWillAppearHere`) retired/aliased.
- [ ] New i18n keys EN + HU in `chat.ts`.
- [ ] `npm run check/lint/test/build` clean. Manual: open a new conversation, confirm the new empty state.

---

## Slice 15 — Pass-1 decision 2: Evidence → Sources

**Blocked by:** None.
**Decisions covered:** Pass-1 #2.

### What to build
Rename the per-message disclosure "Evidence" → "Sources" (Lucide `Book` icon), make it informational with Used/Set-aside groups + Lucide type icons, clickable documents → DocumentWorkspace, drop "Reranked N%", remove the Auto/Pinned/Excluded control from the chat surface (it stays available in the Knowledge library/working-document workspace — already lives there).

### Acceptance criteria
- [ ] `MessageEvidenceDetails.svelte`: header `Book` icon + "Sources" label + (when expanded) "· N considered, M used"; two groups **Used** (terracotta left-bar, Lucide type icons: `FileText` doc / `Globe` web / `Quote` memory / `Paperclip` attachment) and **Set aside** (muted). Documents clickable → open DocumentWorkspace; web links terracotta-tinted underline → open URL.
- [ ] Favicons for web items reused via the proxy route (Slice 12).
- [ ] "Reranked N%" badge removed from the surface. `EvidencePreferenceControl` (Auto/Pinned/Excluded `<select>`) removed from the chat surface; pinning/excluding continues to work from the Knowledge library + working-document workspace (verify no regression there).
- [ ] New i18n keys in `chat.ts`: `messageEvidenceDetails.sourcesLabel`, `.consideredUsedFormat`, `.used`, `.setAside`, `.whatInformedFormat`. Retire/alias `evidenceLabel`, `rerankedLabel`. EN + HU.
- [ ] `npm run check/lint/test/build` clean. Playwright `tests/e2e/chat.spec.ts` updated if it asserts the old label. Manual: a web-grounded + document-backed answer shows the new Sources layout; clicking a doc opens the workspace.

---

## Slice 16 — Pass-1 decision 3: Sidebar S1 + project chat counts

**Blocked by:** Slice 0.
**Decisions covered:** Pass-1 #3.

### What to build
Sidebar consistency: all 3 sections collapsible with icon+label headers, Chats header never vanishes, project folders show chat-count badges, touch affordances always visible, collapsed-rail active-conversation indicator, Logout confirmation, vocabulary unified between sidebar and header menu.

### Acceptance criteria
- [ ] `ConversationList.svelte`: Pinned section gets a collapse chevron + `Pin` icon + label; Projects (`Folder`) and Chats (`MessageSquare`) already collapsible — add the icons. Chats header always renders (empty state inside it).
- [ ] `ProjectItem.svelte`: chat-count badge beside the folder name.
- [ ] `ConversationItem.svelte`/`ProjectItem.svelte`: hover-gated actions (`md:opacity-0 md:group-hover:opacity-100`) gain a touch fallback via the helper — always visible on touch devices.
- [ ] Collapsed rail: active conversation indicated (e.g. an accent dot or active styling on the relevant icon).
- [ ] `Sidebar.svelte`: Logout opens a `ConfirmDialog` before ending the session.
- [ ] Vocabulary unified: header menu labels match sidebar labels (no "Settings" vs "Profile and settings" drift) — reconcile in i18n.
- [ ] New/changed i18n keys EN + HU.
- [ ] `npm run check/lint/test/build` clean. Playwright `tests/e2e/conversation.spec.ts` + `chat.spec.ts` updated. Manual: collapse each section, see counts on projects, use on a touch device, log out (confirm), collapse sidebar (see active indicator).

---

## Slice 17 — Pass-1 decision 4: Conversation jump-rail

**Blocked by:** Slice 0.
**Decisions covered:** Pass-1 #4.

### What to build
Floating vertical rail on the chat left edge, vertically centered, fades in after 6 messages, active turn = thicker terracotta, hover reveals H2 reply snippet (no turn number), cursor-relative scale+color-sweep wave, hidden on mobile, reduced-motion safe.

### Acceptance criteria
- [ ] New component `ConversationJumpRail.svelte` (under `src/lib/components/chat/`) — absolute-positioned, `left`, vertically centered, `pointer-events: auto` only on the marks. Reads the message list from `MessageArea` (props, not a new store). Renders one mark per turn; height encodes content length; active mark thicker + terracotta.
- [ ] Fade-in: 0.6s ease-out, 6px slide-in, only mounts when `messages.length >= 6`. `prefers-reduced-motion` → instant.
- [ ] Hover: cursor-relative scale+sweep wave originates from the hovered mark; an H2-style tooltip shows a serif snippet of the assistant reply (no turn number). On reduced-motion, the wave is skipped (hovered mark just scales + shows snippet).
- [ ] Hidden on phone tier (helper); visible on tablet/desktop.
- [ ] Clicking a mark scrolls `MessageArea` to that turn.
- [ ] New i18n keys (e.g. `chat.jumpRailA11yLabel`) EN + HU.
- [ ] `npm run check/lint/test/build` clean. Manual: open a long conversation (>6 msgs) — rail fades in; hover a mark (wave + snippet); click (scrolls); reduce motion (wave skipped); narrow to phone (rail hidden).

---

## Slice 18a — Profile grouped sections + icon buttons + jargon

**Blocked by:** None.
**Decisions covered:** Pass-1 #5 (partial).

### What to build
Restructure the Profile tab into 4 grouped sections (Account / Preferences / Assistant / Data & privacy) with all fields preserved; convert text CTAs to `btn-icon-bare` Lucide icon buttons; clear jargon ("Default Style" → "Conversation style", language controls clarified). Skills stays in place as a section header (the manager extraction is 18b; the analytics merge is 18c).

### Acceptance criteria
- [ ] `SettingsProfileTab.svelte` restructured into 4 grouped sections with section labels; all fields preserved (avatar upload/color/remove, display name, email, password, import, default model, conversation style + note, appearance, language [UI + title clarified], Skills section header, download/clear/clear/delete).
- [ ] Text CTAs → `btn-icon-bare` icon buttons (`ChevronRight`, `Download`, `Trash2`, etc.); account deletion gets a solid red `Trash2` CTA.
- [ ] "Default Style" → "Conversation style" with clarifying note; language controls clarified.
- [ ] New/changed i18n keys EN + HU in `settings.ts`.
- [ ] `npm run check/lint/test/build` clean.

---

## Slice 18b — Skills manager extraction

**Blocked by:** 18a.
**Decisions covered:** Pass-1 #5 (partial).

### What to build
Promote the Skills section into a summary card ("N active · M disabled · chevron") that opens a dedicated full-screen Skills manager; back chevron returns to Profile.

### Acceptance criteria
- [ ] Profile's Skills section becomes a summary card with a `ChevronRight` opening the manager.
- [ ] Dedicated full-screen manager hosts the existing `UserSkillsSettingsSurface.svelte` content (re-homed, not duplicated); back chevron returns to Profile.
- [ ] `npm run check/lint/test/build` clean. Manual: open Skills from Profile, edit a skill, return.

---

## Slice 18c — Analytics merge (personal → Profile, system → Administration)

**Blocked by:** 18a.
**Decisions covered:** Pass-1 #5 (partial).

### What to build
Remove the top-level Analytics tab for normal users; merge personal analytics (Block A) into Profile as "Your Activity"; move system analytics (Blocks B/C/D) to a sub-pane under Administration.

### Acceptance criteria
- [ ] `+page.svelte`: Analytics tab removed from `settingsTabs` and the `Tab` union; `SettingsAnalyticsTab` Block A (personal) renders inside Profile's new "Your Activity" section; the page state for personal analytics flows to Profile.
- [ ] Administration tab: system analytics added as a sub-pane (alongside System/Users/Campaigns) — admin-only, gated as today.
- [ ] New i18n keys EN + HU (`settings.yourActivity`, etc.).
- [ ] `npm run check/lint/test/build` clean. Playwright `settings-admin.spec.ts` + `login.test.ts` updated. Manual: normal user sees Profile (now 5 sections incl. Your Activity, no Analytics tab); admin sees Administration with system analytics sub-pane.

---

## Slice 19 — Pass-1 decision 6: Compaction UI (popover + chip-divider marker)

**Blocked by:** None.
**Decisions covered:** Pass-1 #6.

### What to build
ContextUsageRing popover humanized (Context room bar, "What AlfyAI remembers", "Sources included", "Memory in play", both costs on one line, near-trigger heads-up at ~78%, silent during compaction). Inline marker → C1 chip-divider layout with Eye/RotateCw.

### Acceptance criteria
- [ ] `ContextUsageRing.svelte` popover: two cost lines (conversation total + last turn, each `$X · Nk tokens`); "Context room" bar (no "plenty left" sub-text); human labels; one-line capacity explainer; near-trigger heads-up at ~78% (amber bar + note). Popover shows NO in-progress state during compaction (only the inline marker does); updates once on completion.
- [ ] Compaction marker (`MessageArea`/`ContextCompressionMarker`): C1 chip-divider — centered pill between two hairline gradient lines, gold tint. In progress: pill color breathes (no loading icon). Done: static pill "Summarized N earlier messages" + `Eye` icon → expands the LLM summary inline + "originals still saved" line. Failed: red-tinted pill + `RotateCw` retry.
- [ ] New i18n keys EN + HU in `chat.ts` (room labels, "Summarized N earlier messages", "Show what was kept", etc.). Retire "Automatically compacted context" wording.
- [ ] `npm run check/lint/test/build` clean. Manual: drive context near 78% (see heads-up); trigger compaction on a long chat (see chip-divider breathe → settle → Eye expands summary).

---

## Review Slice R1 — Full code review pass #1

**Blocked by:** Slices 0–19.
**Decisions covered:** all.

### What to build
Run the `code-review` skill across every implementation piece in detail; fix issues found.

### Acceptance criteria
- [ ] `code-review` skill invoked on the full diff (or per-slice if large).
- [ ] Every finding either fixed in-code or explicitly accepted with a recorded reason.
- [ ] Re-run `npm run check/lint/test/build` clean after fixes.
- [ ] Re-run `npm run check:migrations` (Slice 2).
- [ ] Fallow green (or known-debt reported against the five-cycle baseline).

---

## Review Slice R2 — Full code review pass #2

**Blocked by:** R1.
**Decisions covered:** all.

### What to build
A second independent review pass with fresh eyes, focusing on cross-slice integration, the touch/capability rule applied consistently everywhere, i18n parity (every new key in EN + HU), reduced-motion compliance, and any regressions to the AGENTS.md boundaries (file-production facade, route adapter thinness, no route-local persistence).

### Acceptance criteria
- [ ] `code-review` skill invoked again on the post-R1 diff.
- [ ] Cross-slice consistency verified: the helper (Slice 0) is used everywhere (no re-introduced ad-hoc checks); motion language consistent (compaction sweep ↔ FileProductionCard sweep); icon-button pattern consistent (all `btn-icon-bare`).
- [ ] i18n parity audit: a script/grep confirming every new key exists in BOTH `en` and `hu` blocks of its file.
- [ ] Reduced-motion audit: every new animation has a `prefers-reduced-motion` fallback.
- [ ] `npm run check/lint/test/build` + `check:migrations` clean.
- [ ] Fix everything found; record accepted exceptions.

---

## Slice V — Browser visual test against mockups + present

**Blocked by:** R2.
**Decisions covered:** all.

### What to build
Run the app locally, walk every redesigned surface in the browser, and compare against the authoritative mockup files in `.superpowers/brainstorm/52096-1783083593/content/`. Authoritative comparison targets: `10-jumprail-final`, `12-settings-v2`, `14-empty-compaction-v2`, `17-summary-final`, `20-memory-modal`, `22-fileprod-v2`, `06-evidence-v3`.

### Acceptance criteria
- [ ] `npm run build && npm run preview` (or dev) running locally.
- [ ] For each surface, capture a screenshot and compare side-by-side with its mockup. List discrepancies.
- [ ] Fix discrepancies that are regressions vs the agreed design; flag intentional deviations for the user.
- [ ] Commit all changes in focused chunks (one commit per slice, conventional commit messages explaining the *why* per AGENTS.md).
- [ ] Present the full set of before/after screenshots + the discrepancy resolution to the user for **final go/no-go on git push**. Do NOT push until the user approves.

---

## Execution Model — Orchestrator + Sub-Agent Dispatch

This wave is executed by a **single human-facing orchestrator (the assistant in this session) that writes no code itself**. Every implementation slice is delegated to a **sub-agent** with an isolated context. This keeps the orchestrator's context tidy for coordination, integration, and the final visual presentation, and gives each slice a focused, self-contained brief.

### Orchestrator responsibilities (this session)
1. **Dispatch** one sub-agent per slice, in the wave order below. Each dispatch opens with the **TDD-first dispatch brief** (TDD is mandatory; the Iron Law). Each dispatch is a fully self-contained prompt (the slice spec, the relevant mockup path, the grounding facts it needs, the verification commands, the constraints, the required return format).
2. **Integrate** each sub-agent's returned diff — apply, then run the full verification gate (`npm run check && npm run lint && npm test && npm run build`, plus `npm run check:migrations` for schema slices). The orchestrator does the verification, not the sub-agent, so integration conflicts surface here.
3. **Verify TDD discipline** before accepting a slice: confirm the test files exist, that they would have failed before the implementation (by inspecting the diff — tests reference behavior that the production code in the same diff adds), and that no production code appears without a corresponding test. **Reject and re-dispatch any slice where code preceded its test.**
4. **Resolve conflicts** between slices (especially i18n file contention — see below). The orchestrator edits only conflict-resolution / glue, not feature code.
5. **Commit** each integrated slice in a focused chunk before dispatching the next wave.
6. **Run the two review slices (R1, R2)** as sub-agents that review the *integrated* diff and return findings; the orchestrator dispatches fix-up sub-agents for any issues. R2 explicitly audits TDD coverage as one of its cross-cutting checks.
7. **Run the visual test (Slice V)** in the browser itself (this is a presentation task, not code), then present to the user for final push approval.

### Sub-agent contract (per slice)
Each dispatched sub-agent receives:
- **Role & constraints:** "You are an implementation sub-agent. Implement exactly this slice. Do not touch files outside the slice's scope. Do not run git commands. Do not edit other slices' work."
- **The slice spec** (copied verbatim from this doc).
- **Grounding facts** the slice needs (file:line anchors, the real markup, the i18n key shape, the migration convention — sourced from the exploration report, so the sub-agent doesn't re-explore).
- **Mockup reference** (the absolute path to the authoritative `.superpowers/.../*.html` file, with instruction to match it faithfully).
- **Conventions** (i18n EN+HU parity, `btn-icon-bare` pattern, reduced-motion, AGENTS.md boundaries).
- **Verification gate** the orchestrator will run (sub-agent should self-check before returning, but orchestrator re-verifies).
- **Required return:** a structured summary — files changed (with line ranges), new i18n keys added (EN+HU), any deviations from the spec + why, any blockers/ambiguities encountered. **No git operations.**

### Parallel waves (dispatch order)
Slices are grouped into waves. **Within a wave, slices may be dispatched in parallel ONLY if their file sets are disjoint** (the dispatching-parallel-agents discipline: same-file edits conflict). Across waves, strict sequence — each wave's output is integrated + committed before the next dispatches.

A key contention: **`src/lib/i18n/chat.ts` is touched by ~9 slices** (4, 7, 9, 10, 11, 14, 15, 17, 19). Those slices cannot run concurrently. To maximize safe parallelism without i18n merge hell, the orchestrator either (a) runs chat.ts-touching slices sequentially within their wave, or (b) batches all new chat.ts keys for a wave into one consolidation sub-agent at the end of the wave. Approach (a) is the default — simpler, fewer conflicts.

**Wave 1 — Foundation (sequential, others depend on these):**
- Slice 0 (viewport helper) — blocks 1, 6, 10, 11, 16, 17
- Slice 2 (schema + migration) — blocks 3
- Slice 13 (LogoMark placement) — blocks 14

These three are file-disjoint (viewport.ts / schema.ts+drizzle / layout+MessageArea) → **dispatch in parallel**, integrate, commit.

**Wave 2 — Independent leaves (parallel where disjoint):**
- Slice 5 (DocumentWorkspace mobile compare) — disjoint
- Slice 8 (DocumentsList "What the AI sees" + knowledge.ts) — disjoint
- Slice 12 (favicon route + ThinkingBlock) — disjoint, and blocks 15
- Slice 1 (keyboard fix, needs Slice 0) — disjoint from 5/8/12

→ **Dispatch 1, 5, 8, 12 in parallel.** Integrate, commit.

**Wave 3 — More independent leaves:**
- Slice 7 (memory modal + chat.ts i18n) — chat.ts contention with 9/10/11/14/15/17/19
- Slice 9 (search hint + chat.ts i18n) — chat.ts contention
- Slice 19 (compaction + chat.ts i18n) — chat.ts contention

→ These three all touch chat.ts. **Dispatch sequentially** (7, then 9, then 19), or have one sub-agent do all three's chat.ts edits. Orchestrator default: sequential.

**Wave 4 — Touch-foundation dependents (need Slice 0):**
- Slice 6 (Knowledge Library, needs Slice 0 for loading-state/mobile-select-all) — touches DocumentsList + knowledge.ts + chat.ts(memory hint)
- Slice 10 (composer, needs Slice 0) — touches MessageInput + chat.ts
- Slice 11 (hover→touch rule, needs Slice 0) — touches MessageBubble + CodeBlock + chat.ts (codeBlock.copied)

→ chat.ts + MessageInput/MessageBubble contention. **Dispatch sequentially:** 6, then 10, then 11. (Slice 6 mostly touches knowledge.ts so could parallel with 10 if the memory-hint key is deferred — orchestrator decides at dispatch time.)

**Wave 5 — Sources + jump-rail + empty state (need 12, 13):**
- Slice 15 (Evidence → Sources, needs 12 for favicons) — touches MessageEvidenceDetails + chat.ts
- Slice 14 (empty state copy, needs 13) — touches MessageArea + chat.ts
- Slice 17 (jump-rail, needs 0) — new component + chat.ts

→ All touch chat.ts. **Sequential:** 14, 15, 17.

**Wave 6 — Sidebar (needs 0):**
- Slice 16 (sidebar S1 + counts) — touches Sidebar/ConversationList/ProjectItem/ConversationItem + common.ts/settings.ts i18n. Disjoint from chat.ts. Could parallel with Wave 5's chat.ts work, but to keep integration simple: **sequential after Wave 5.**

**Wave 7 — File-production chain (needs 2 → 3 → 4):**
- Slice 3 (dismiss lifecycle) — touches job-ledger + read-model + types + new route. Disjoint from chat.ts.
- Slice 4 (FileProductionCard revamp, needs 3) — touches FileProductionCard + chat.ts (fileProduction.* keys).

→ **3 then 4 (sequential).** Could overlap 3 with Wave 6 since disjoint.

**Wave 8 — Profile (18a → 18b, 18c):**
- Slice 18a (grouped sections + icon buttons + jargon) — touches SettingsProfileTab + settings.ts i18n.
- Slice 18b (Skills manager, needs 18a) — touches UserSkillsSettingsSurface re-home + settings.
- Slice 18c (analytics merge, needs 18a) — touches +page.svelte + SettingsAnalyticsTab + Administration + settings.ts.

→ 18a first, then **18b and 18c in parallel** (18b touches Skills components; 18c touches analytics/page — file-disjoint after 18a lands).

**Wave 9 — Reviews:**
- Slice R1: dispatch a review sub-agent on the full integrated diff → returns findings. Orchestrator dispatches fix sub-agents per finding (each scoped to the offending slice's files). Re-verify.
- Slice R2: second review sub-agent, cross-slice focus (helper usage consistency, i18n parity audit, reduced-motion audit). Same fix-loop.

**Wave 10 — Visual:**
- Slice V: orchestrator runs the app, walks every surface, screenshots vs mockups, fixes discrepancies via targeted sub-agents, commits, presents to user. **No push until user approves.**

### Why this ordering
- File-disjoint slices parallelize; same-file (especially chat.ts) slices serialize.
- Hard dependencies (0, 2, 12, 13, 18a) land first.
- Each wave is integrated + committed before the next dispatches, so a sub-agent always starts from a clean, verified tree.
- The orchestrator's context holds only: dispatch briefs, returned summaries, verification results, and the running commit log — not the code itself.

### Conventions (apply to every sub-agent)
- **🔴 TEST-DRIVEN DEVELOPMENT IS MANDATORY (the Iron Law).** Every sub-agent MUST follow TDD via the `superpowers:test-driven-development` skill: **(1) RED** — write one minimal failing test for the behavior; **(2) verify RED** — run `npm test <path>` and watch it fail *for the expected reason* (feature missing, not a typo); **(3) GREEN** — write the *minimal* code to pass; **(4) verify GREEN** — run the test, watch it pass, confirm no other tests broke; **(5) REFACTOR** — clean up, keep tests green. **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.** If a sub-agent writes code before the test, the orchestrator rejects the slice and re-dispatches. No exceptions, no "too simple to test," no "tests after." The TDD verification checklist (every new function/method has a test; each test watched failing first; minimal code; pristine output; edge cases covered) is part of every slice's acceptance criteria. The orchestrator confirms the test files exist and fail-before-pass in the integrated diff before accepting a slice.
- **TDD scope notes for this codebase:**
  - **Unit-testable logic (always TDD):** the viewport helper (Slice 0), file-production dismiss service/read-model (Slice 3), favicon domain validator (Slice 12), the dismiss-job-status predicate (Slice 3), any pure helpers introduced.
  - **Component logic that has extractable pure functions (TDD the function):** e.g. the elapsed-time formatter (Slice 4), the stale-job predicate (Slice 4, `createdAt > 90s`), the over-length predicate (Slice 10). Extract these as small pure functions and test them in isolation before wiring them into `.svelte` markup.
  - **Svelte component rendering / markup-only changes:** where a slice is purely markup/styling/i18n with no new logic (much of Slice 11, 13, 14, 15, 16, 19), there is no unit-testable behavior — the test is the Playwright e2e + the manual browser visual test (Slice V). For these slices, the sub-agent still writes/updates the relevant Playwright spec first (RED: assert the new label/affordance/behavior), watches it fail, then implements the markup to pass it. The orchestrator treats a missing Playwright assertion for a markup slice as a TDD failure.
  - **Schema migrations (Slice 2):** no production *logic* code, but verify with `npm run check:migrations` AND a test that the column exists with the right default after `db:prepare` (RED: query the column, fail; GREEN: migration applied).
- **i18n parity:** every new user-facing string added in BOTH `en` and `hu` blocks of the right file, or `npm run check` fails. Sub-agent reports every key it added.
- **Icon buttons:** canonical `btn-icon-bare` + Lucide at `size={16} strokeWidth={2} aria-hidden="true"` (per ADR 0043 + the codebase audit). No bare `.btn-icon`.
- **Reduced motion:** every new animation honors `prefers-reduced-motion` (the app has a global override; new keyframes must respect it or be skipped under reduced-motion).
- **No new top-level services** (AGENTS.md): favicon proxy = thin route; dismiss lifecycle extends the existing file-production facade; viewport helper = leaf util under `src/lib/utils/`.
- **Verification gate per slice:** `npm run check && npm run lint && npm test && npm run build` (+ `npm run check:migrations` for schema slices). Sub-agent self-checks; orchestrator re-verifies after integration.
- **Mockup fidelity:** each sub-agent compares its output to the named authoritative mockup file and reports any intentional deviation.

### TDD-first dispatch brief (template the orchestrator uses for every slice)
> You are an implementation sub-agent for ADR 0043 Slice N. **You MUST follow TDD (Red-Green-Refactor) for all production code via the `superpowers:test-driven-development` skill** — write the failing test first, watch it fail for the right reason, write minimal code, watch it pass, refactor. No production code without a failing test first; code written before its test will be rejected. For markup/i18n-only changes, write/update the Playwright assertion first (RED) and watch it fail before implementing. [Then: slice spec, grounding facts, mockup path, conventions, verification gate, required return format.]
