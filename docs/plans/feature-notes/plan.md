# Feature notes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `feature_note`, a fourth announcement campaign type, and a compact landing-only strip that names a small feature, offers one optional way in, and stops after X/CTA or four showings.

**Architecture:** Reuse the existing campaign tables, immutable snapshots, admin draft/publish/archive flow, campaign events and terminal user-state rows. The note is one existing `standard` slide with type-specific publish rules; its state is the existing `announcement_campaign_events` (`auto_shown` = one showing) plus `announcement_campaign_user_states` (X = `skipped`, CTA = `completed`). A new note-only reader endpoint feeds a presentational strip rendered by the app shell only on `/`. The shell asks for the note only after `/api/campaigns/eligible` returned no campaign, latches it off for the rest of a landing arrival, and records the showing before rendering. No schema change.

**Tech Stack:** SvelteKit route handlers, Svelte 5 runes, TypeScript, Drizzle ORM + SQLite, Vitest + Testing Library, Playwright.

**Spec:** [`docs/plans/feature-notes/spec.md`](./spec.md)  
**Mockup:** [`docs/design/feature-note/index.html`](../../design/feature-note/index.html)

## Global Constraints

- Read the root `AGENTS.md` and every folder `AGENTS.md` covering a file before editing it. In particular: `src/lib/server/services/AGENTS.md`, `src/routes/(app)/AGENTS.md`, `src/routes/AGENTS.md`, `src/lib/components/AGENTS.md`, `src/lib/client/AGENTS.md`, `src/lib/stores/AGENTS.md`.
- Mandatory docs check: the orchestrator checked Context7 for SvelteKit `RequestHandler`/`+server.ts` and Drizzle SQLite `count`/`eq`; workers re-check the current Svelte 5/SvelteKit/Drizzle docs for any API they have not used in this repo.
- Use Node 22 for every npm command: `PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default Node 26 fails `npm ci`/the engine check.
- **No migration.** Reuse the campaign event and campaign user-state tables. The cap is soft: the eligibility read and the showing write are separate requests; two tabs/fast reloads may exceed four. Do not add a counter column or a new table in this plan.
- The note's one slide is `layoutType: "standard"`, `semanticRole: "feature"`. Do not add a `note` slide layout or a `CampaignSlideKind`.
- Campaign behavior is unchanged: `getEligibleCampaignForUser` and `getLatestPublishedAnnouncement` must never return a `feature_note`; the note never enters the campaign modal or the sidebar badge.
- One live note globally: publishing a `feature_note` archives every older published `feature_note` in the same transaction. Release/onboarding campaigns are untouched.
- Delivery only on `/` (the landing). Never on `/chat/[id]`, `/settings`, `/knowledge`, `/projects/[id]`, or while a campaign is active. The campaign wins; a note never follows a campaign in the same landing arrival.
- X = `completeCampaign(id, "skipped")`; CTA = `completeCampaignOnLeave(id, "completed")` (keepalive) then navigate. Both are terminal.
- The note's 1st–4th showings are allowed; the 5th eligibility read returns null. A showing is an existing `auto_shown` event recorded by the shell when it accepts the note for a landing arrival.
- The note strip is a region, not a dialog: no scrim, no focus trap, no focus steal. All icons come from `@lucide/svelte`: `Sparkles`, `ArrowRight`, `X`.
- Every user-facing string is EN and HU. Note content is admin-authored EN/HU; chrome lives in `src/lib/i18n/settings.ts`.
- TDD for every code change: failing test → run it → minimal implementation → pass → commit. Commit in small, focused commits with a why in the message.
- No push and no deploy. The branch is merged into local `dev` only, at the end.

## Review Focus

1. **Campaign precedence / landing guard.** A note must not render on a non-landing route, while `activeCampaign` is set, or after a campaign was opened during this landing arrival. The shell must not fetch the note when a campaign is offered.
2. **The latch.** Send, a campaign opening, or leaving `/` latches the note off for the rest of that landing arrival; a failed send must not pop it back. A later landing arrival may show it again.
3. **The cap and terminal states.** 4th showing allowed, 5th null; X and CTA stop it for good; a newly published note (new snapshot) starts at zero; an archived note is null; another user is unaffected.
4. **Admin parity.** The checklist and server agree: exactly one standard/feature slide, title and body EN/HU, no crops, no setup controls, optional action with allow-listed non-`internal:` destination and both labels. A note cannot be published with two slides or a screenshot.
5. **No resurrection / no campaign leak.** Publishing note B archives note A; archiving B leaves no note; note A never returns; the campaign/badge paths ignore notes. The CTA's completion survives navigation (`keepalive`).

---

## Task 0: Commit the approved spec, plan and mockup

**Files:**
- `docs/plans/feature-notes/spec.md` (new)
- `docs/plans/feature-notes/plan.md` (new)
- `docs/design/feature-note/` (new: `index.html`, `home-desktop.png`, `home-mobile.png`, four `feature-note-*.png`)

- [ ] **Step 1:** Confirm the worktree has no unrelated changes and the mockup/spec/plan are present.
- [ ] **Step 2:** Commit them as one design artifact:

```bash
git add docs/plans/feature-notes docs/design/feature-note
git commit -m "docs: specify the feature-note campaign and its landing strip"
```

This commit is the branch's base for the code tasks.

---

## Task 1: Server contract, publish rules, eligibility and API

**Files:**
- Modify: `src/lib/server/services/announcement-campaigns.ts`
- Modify: `src/lib/client/api/campaigns.ts`
- Create: `src/routes/api/campaigns/feature-note/+server.ts`
- Create: `src/routes/api/campaigns/feature-note/feature-note.test.ts`
- Modify: `src/lib/server/services/announcement-campaigns.test.ts`
- Modify: `src/lib/server/services/announcement-campaigns.audience.test.ts`
- Modify: `src/lib/server/services/announcement-campaigns.test-helpers.ts`
- Modify: `src/lib/client/api/campaigns.test.ts`

**Interfaces:**
- `export const FEATURE_NOTE_MAX_IMPRESSIONS = 4;`
- `export type FeatureNote = { id: string; name: string; snapshotId: string; title: { en: string; hu: string }; body: { en: string; hu: string }; actionLabel: { en: string; hu: string }; actionDestination: string | null; publishedAt: Date | null };`
- `export async function getEligibleFeatureNoteForUser(userId: string, options?: CampaignServiceOptions): Promise<FeatureNote | null>`
- `GET /api/campaigns/feature-note` → `{ note: FeatureNote | null }`
- Client: `type FeatureNote` (same shape with `publishedAt: string | Date | null`), `fetchEligibleFeatureNote(fetchImpl?: FetchLike): Promise<FeatureNote | null>`, `completeCampaignOnLeave(campaignId, reason, fetchImpl?: FetchLike): Promise<unknown>` (a keepalive POST of the existing complete body).
- `CampaignType` in `src/lib/client/api/campaigns.ts` gains `"feature_note"`.

**Server behavior:**
1. Add `feature_note` to `AnnouncementCampaignType`, `CAMPAIGN_TYPES`, the `assertType` message and `validatePublishCampaignBasics` message.
2. `createCampaignDraft` default name for `feature_note` is `"Feature note"`; it seeds exactly one empty slide in the same transaction: `layoutType: "standard"`, `semanticRole: "feature"`, `sortOrder: 1`, empty title/body. The note uses `defaultVersionFor`'s `v1`; `feature_note:v1:rN` is the identity. No releaseVersion.
3. `validatePublishInput`, for `campaignType === "feature_note"`:
   - exactly one slide, `layoutType === "standard"`, `semanticRole === "feature"`; otherwise `errors.noteShape`.
   - no `desktopCropAssetId` / `mobileCropAssetId`; otherwise `errors.noteAssets`.
   - no `actionDestination` starting with `INTERNAL_ACTION_PREFIX`; otherwise `errors.noteAction`.
   - the existing title/body localized, action destination/label and setup-control checks still apply.
4. `publishCampaign`: in the existing transaction, for `feature_note` archive every other published `feature_note` with `archivePublishedRow` (no kind/release filter). Leave the tour block and release behavior untouched.
5. `getEligibleFeatureNoteForUser`:
   - latest published `feature_note` via `latestPublishedByType`;
   - null if missing its single slide;
   - null if `userHasFinishedSnapshot(userId, snapshotId)`;
   - null if `!accountPredates(userId, publishedAt)`;
   - null if the user's `auto_shown` event count for that campaign is `>= FEATURE_NOTE_MAX_IMPRESSIONS`;
   - else map the slide to `FeatureNote`.
   Add a private `countFeatureNoteShows(userId, campaignId, db)` using Drizzle `count()` and `eq`; the existing `(user_id, campaign_id, event_type)` index covers it.
6. Do not change `getEligibleCampaignForUser` or `getLatestPublishedAnnouncement`; add tests proving both ignore a published note.
7. The client `completeCampaignOnLeave` uses the same endpoint/body as `completeCampaign` with `keepalive: true`; refactor a private request builder to avoid duplication.

**Route:** `feature-note/+server.ts` mirrors `eligible/+server.ts`: `requireAuth`; `userHasActiveChatStream(userId)` returns `{ note: null }`; otherwise `json({ note: await getEligibleFeatureNoteForUser(userId) })`.

**Tests (TDD):**
- `createCampaignDraft` note: default name, `feature_note:v1:r1`, exactly one standard/feature slide.
- Publish valid note; reject 0/2 slides, a crop, `data_disclosure`, `internal:chatgpt-import`, missing EN/HU copy, and an action destination without labels.
- Publish note A then note B: A archived; B latest. Archive B: no eligible note; A never returns.
- Eligibility: existing account, account made after publish, 3 events (eligible), 4 events (null), X terminal, CTA terminal, new snapshot reset, a second user unaffected.
- `getEligibleCampaignForUser`/`getLatestPublishedAnnouncement` return null when only a note is published.
- `getCampaignAnalyticsSummary` counts the note's `auto_shown`/`completed`/`skipped` rows (the events/state the delivery uses).
- Route: 401 without auth, `{ note: null }` under an active stream, and the service result.
- Client: `fetchEligibleFeatureNote` parses `{ note }`/null; `completeCampaignOnLeave` sends `keepalive: true`.

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npx vitest run \
  src/lib/server/services/announcement-campaigns.test.ts \
  src/lib/server/services/announcement-campaigns.audience.test.ts \
  src/lib/client/api/campaigns.test.ts \
  src/routes/api/campaigns/feature-note/feature-note.test.ts
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run check
PATH=/opt/homebrew/opt/node@22/bin:$PATH npx biome check src/lib/server/services/announcement-campaigns.ts src/lib/client/api/campaigns.ts src/routes/api/campaigns/feature-note src/lib/server/services/announcement-campaigns.test.ts src/lib/server/services/announcement-campaigns.audience.test.ts src/lib/server/services/announcement-campaigns.test-helpers.ts src/lib/client/api/campaigns.test.ts
```

Commit: `feat: add the feature-note campaign type and delivery contract`.

---

## Task 2: The note strip and landing-shell delivery

**Files:**
- Create: `src/lib/components/campaigns/FeatureNoteStrip.svelte`
- Create: `src/lib/components/campaigns/FeatureNoteStrip.test.ts`
- Modify: `src/lib/stores/ui.ts`
- Modify: `src/routes/(app)/+page.svelte`
- Modify: `src/routes/(app)/+layout.svelte`
- Modify: `src/lib/i18n/settings.ts` (`featureNote.*` chrome keys, EN + HU)
- Modify: `src/routes/(app)/AGENTS.md` (Announcements section)
- Modify: `docs/adr/0012-announcement-campaigns-and-first-run-onboarding.md` (amendment)

**Component interface:**

```ts
let {
  note,
  locale = "en",
  preview = false,
  onDismiss,
  onAction,
}: {
  note: FeatureNote;
  locale?: CampaignLocale;
  preview?: boolean;
  onDismiss?: () => void;
  onAction?: (destination: string) => void;
} = $props();
```

- Render: `section` with `role="region"` and `aria-labelledby` the title; a 42 px dotted tile with `Sparkles` 24 px; title (Libre Baskerville 15 px); a body row with the body (Nimbus Sans 13 px) and, when an action exists, an inline `<a>` with `ArrowRight` at the end of the same row; a 32 px `X` button with `$t("featureNote.dismiss")`; a polite `sr-only` live line `$t("featureNote.announcement", { title })`.
- No CTA when the destination is empty, not allow-listed, or starts with `INTERNAL_ACTION_PREFIX`; no CTA when the localized label is empty.
- `preview` renders the same card with no callbacks; the admin wrapper makes it `inert`.
- CSS from `docs/design/feature-note/index.html`, tokenized; desktop max-width 620, mobile full-width minus 8 px margins; no third line from the CTA; short fade/slide-in with `reducedMotionAware`, instant under reduced motion.
- Icons from `@lucide/svelte`; no inline SVG.

**Store and page:**
- Add `export const landingSendStarted = writable(false);` in `src/lib/stores/ui.ts`.
- In `src/routes/(app)/+page.svelte`, mirror the existing `sendStarted`:
  `$effect(() => { landingSendStarted.set(sendStarted); return () => landingSendStarted.set(false); });`
  Do not change `HomeSurface`; `sendStarted` is already set before its first await.

**Shell (`src/routes/(app)/+layout.svelte`):**
- `isLandingRoute = $derived(page.url.pathname === "/")`.
- State: `activeFeatureNote: FeatureNote | null`, `featureNoteChecked` (per landing arrival), `noteHiddenForArrival`.
- Wait for the one campaign check. `checkEligibleCampaign` runs once on mount; expose a resolved promise/settled flag. The note check awaits it.
- `askForFeatureNote()` guards: browser, landing, no `activeCampaign`, no `activeFeatureNote`, not already checked this arrival, not `noteHiddenForArrival`. It fetches `fetchEligibleFeatureNote()`, then re-checks the guards and `$landingSendStarted`; sets `activeFeatureNote = note`; records one `auto_shown` event (`recordCampaignEvent(note.id, { eventType: "auto_shown" })`, console-warn on failure). The recording follows the render acceptance, not the component mount, so a remount cannot double-count.
- Landing-arrival effect: when `page.url.pathname` becomes `/`, reset `activeFeatureNote`, `featureNoteChecked`, `noteHiddenForArrival`, then `await campaignCheckReady` and `askForFeatureNote()`. When it leaves `/`, clear the note and the per-arrival flags. Do not ask on focus, visibility, list refresh, or send.
- Latch: `$effect(() => { if ($landingSendStarted) { noteHiddenForArrival = true; activeFeatureNote = null; } });`; `openCampaign` (auto or badge replay) does the same when `isLandingRoute`; leaving `/` resets for the next arrival.
- Render inside `<main>` before `{@render children()}` and only when `isLandingRoute && activeFeatureNote && !noteHiddenForArrival && !activeCampaign && !$landingSendStarted`. A `.feature-note-slot` is absolute, top-centered, max-width 620, pointer-events none with pointer-events auto on the strip.
- Dismiss: clear the note + latch, `void completeCampaign(note.id, "skipped").catch(...)`. Action: clear + latch, `void completeCampaignOnLeave(note.id, "completed").catch(...)`; the `<a>` navigates.
- Keep the existing campaign modal/check untouched. Do not call the note endpoint from a non-landing route.

**Docs:** update the Announcements section: `feature_note` is a fourth campaign kind; it is landing-only, the campaign wins, it is capped at four showings, X/CTA terminal, not in the badge. Add an ADR-0012 amendment with the same rules and the soft cap.

**Tests:**
- `FeatureNoteStrip.test.ts`: localized title/body; HU/EN fallback; X calls `onDismiss`; CTA `href`/label calls `onAction`; no destination/no label/no internal destination → no CTA; preview renders no callbacks; one `Sparkles` tile; `role="region"`; accessible labels.
- The layout's behavior is covered by the e2e task; add a small test for any extracted pure helper if the implementation creates one.
- Run component test, `npm run check`, biome on the changed files; commit `feat: show feature notes on the landing page`.

---

## Task 3: Admin authoring, checklist and preview

**Files:**
- Modify: `src/routes/(app)/settings/_components/campaigns/CampaignDialog.svelte`
- Modify: `src/routes/(app)/settings/_components/SettingsAdminCampaignsPane.svelte`
- Modify: `src/routes/(app)/settings/_components/campaigns/SlideEditor.svelte`
- Modify: `src/routes/(app)/settings/_components/campaigns/SlideRail.svelte`
- Modify: `src/routes/(app)/settings/_components/campaigns/CampaignRail.svelte`
- Modify: `src/routes/(app)/settings/_components/campaigns/campaign-labels.ts`
- Modify: `src/routes/(app)/settings/_components/campaigns/campaign-checklist.ts`
- Create: `src/routes/(app)/settings/_components/campaigns/NotePreview.svelte`
- Create: `src/routes/(app)/settings/_components/campaigns/NotePreview.test.ts`
- Modify: `src/routes/(app)/settings/_components/campaigns/campaign-checklist.test.ts`
- Modify: `src/routes/(app)/settings/_components/campaigns/campaign-labels.test.ts`
- Modify: `src/routes/(app)/settings/_components/SettingsAdminCampaignsPane.test.ts`
- Modify: `src/lib/i18n/settings.ts` (admin keys, EN + HU)

**Checklist:**
- `ChecklistCampaignType` gains `feature_note`.
- Add `noteShape` to `ChecklistRuleId`, `RULE_LABEL`, `FAILURE_LABEL`, both i18n locales.
- `evaluateCampaignChecklist`: type accepts `feature_note`; for a note, `use("noteShape")` and fail unless exactly one slide, `kind === "standard"`, `semanticRole === "feature"`, and no desktop/mobile asset. Do not run the image-alt rule for a note. In the action-destination rule, a note's `internal:` destination fails with the note-specific key. The existing release-version/setup/tour rules are unchanged.
- Tests: note ready with one standard/feature slide + title/body (optional action with labels); not ready for two/zero slides, a crop, `data_disclosure`, `internal:` action, missing EN/HU copy, or an action without labels; the existing tour/release tests stay green.

**Admin pane:**
- `isNote = draft?.type === "feature_note"`.
- `slideRailItems`: `picture:false`, `tag` "Note", no step label; one slide. `SlideRail` Add is suppressed for notes (allow a recovery add only when `slides.length === 0`); the note menu has no move/delete.
- `showPerformance` excludes notes (like tours).
- `metaLine` and `CampaignRail` read `"Feature note · 1 note"`; add `noteCountLabel`/`featureNoteLead` in `campaign-labels.ts` and `admin.campaigns.note.*` i18n.
- `SlideEditor` gets a `note` prop (not the `tour` prop): heading "Note", hide alt text and the asset grid, keep title/body/action, keep the language pills and EN→HU copy; filter `internal:` destinations out of the note's destination select; show a note-sized body guide/hint.
- `slideMenuItems`: for a note, only Copy (no Layout/Purpose/Setup, no up/down/delete).
- `SlideOptionsDialog` is not opened for notes; `SlideKindLabel`/layout behavior for standard slides is unchanged.
- Preview: `{#if isNote}<NotePreview …/>{:else if isTour}<TourPreview …/>{:else}<CampaignModal …/>{/if}`. Hide the desktop/mobile toggle for notes. `NotePreview` derives the single slide, builds a `FeatureNote` (`id: "preview"`), renders the shared `FeatureNoteStrip` with `preview` inside an `inert` wrapper; `data-testid="note-preview"`.
- Publish: after a note publishes, `refreshCampaignList()` (the older note was archived) like the tour branch.
- `CampaignDialog`: create offers First-run / Release / Feature note; the release-version field only for release. For an existing note (edit details), show the type read-only like a tour. Update the type help/description.
- Server seeds the one note slide; the pane must not add a second.

**i18n keys (EN/HU):**
`admin.campaigns.type.featureNote`, `admin.campaigns.note.tag`, `admin.campaigns.note.count`, `admin.campaigns.note.editorTitle`, `admin.campaigns.note.bodyHint`, `admin.campaigns.validation.noteShapeInvalid`, `admin.campaigns.validation.noteActionInvalid`, `admin.campaigns.checklist.rule.noteShape`, `admin.campaigns.checklist.fail.noteShape`; update `admin.campaigns.typeHelp`/`description`; add `featureNote.region`, `featureNote.dismiss`, `featureNote.announcement` (Task 2 adds the chrome if not already present). Suggested HU: `Újdonság`, `Új funkció`, `Bezárás`; adjust for natural reading.

**Tests:** the checklist/labels tests, the `NotePreview` test (draft words in the edited locale, inert, no callbacks), and the pane's note describe covering meta line, rail (no picture/add), menu (copy only), editor (title/body/action, no alt/assets), preview branch, fixed edit type, performance card absent. Run the focused tests, `npm run check`, biome; commit `feat: author feature notes in the campaigns pane`.

---

## Task 4: E2E and integration

**Files:**
- Create: `tests/e2e/feature-note.spec.ts`
- Modify: `tests/e2e/admin-users-campaigns.spec.ts` (the "only makes first-run and release" comment; add the note type pill to the create flow where it asserts the dialog)
- Possibly modify: `tests/e2e/campaign-audience.spec.ts` only if a shared `arrive()`/`expectNoNote` helper is worth extracting; do not weaken its existing assertions.

**Spec helpers:** copy the `createReader(existing: boolean)` pattern from `campaign-audience.spec.ts` (an existing reader is created ten days old; a new one now), the `adminApi`/publish/archive helper, and `afterEach` archiving every published note. Use a fresh reader per test; never publish a note on the shared admin without archiving it. A note is never deleted after publish — archive it.

**Tests:**
1. **Visible on landing:** publish a note for an existing reader; `page.goto("/")`; wait for `/api/campaigns/feature-note`; assert the strip/testid, title, body, CTA; assert it is not on a chat route.
2. **Cap:** each `goto("/")` + showing event; four showings; the fifth `goto("/")` returns no note and the strip is gone. Wait for the `POST /api/campaigns/[id]/events` after each showing.
3. **X:** click `Dismiss`, wait for `/complete`, reload, absent.
4. **CTA:** click the link, wait for `/complete` (keepalive) and `/settings`, go back to `/`, absent.
5. **Campaign wins:** publish a release update and a note for an existing reader; the landing shows the campaign, no note; skip/finish; the note does not appear in the same arrival; `goto("/")` (new document load) shows the note.
6. **Send:** publish a note; the reader sees it; fill the composer and send with `page.route("**/api/chat/stream")` + `buildAiSdkUiStreamBody` (copy the campaign-audience pattern); assert the strip is gone immediately and on the chat route; a later `goto("/")` shows it again.
7. **Admin:** as the admin, open Settings → Campaigns, New campaign → Feature note; one note slide; fill title/body/action; checklist ready; preview shows the strip; publish; the rail row reads "Feature note"; archive it via the API in cleanup. Do not assert the admin's own landing note here (another live campaign could win); the delivery tests use fresh readers.

Clean up `live` notes in `afterEach` even on failure. `login()` itself arrives at `/`; publish after the login when the test needs an exact showing count.

Run the focused spec against the dev server:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH E2E_SERVER=dev E2E_PORT=5275 npx playwright test tests/e2e/feature-note.spec.ts
```

Then the full agent gate (orchestrator, once):

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 5275 \
  tests/e2e/feature-note.spec.ts \
  tests/e2e/campaign-audience.spec.ts \
  tests/e2e/admin-users-campaigns.spec.ts
```

Commit: `test: cover feature-note delivery and authoring`.

---

## Task 5: Final review, gate and merge

- [ ] **Step 1:** Dispatch a fresh whole-branch reviewer with the spec, plan, mockup and `git diff dev...HEAD`. It checks: campaign precedence, the latch, cap/terminal semantics, admin/server parity, no resurrection, landing-only guard, EN/HU, no new layout/migration, AGENTS boundaries, and test coverage. Send substantial findings back to the owning worker or a focused fixer; do not reimplement them in the orchestrator.
- [ ] **Step 2:** Re-run the focused tests after fixes, then the full agent gate above with Node 22. It must show every static gate and the named specs green.
- [ ] **Step 3:** Merge into local `dev` from the main checkout (no push):
  - The main checkout has an untracked `docs/design/feature-note/` copy of the mockup. Verify the worktree has the tracked copy; move the main checkout's untracked copy to `$TMPDIR/alfyai-feature-note-main-copy` before merging so the merge can create the tracked files. Do not touch the other session's untracked files.
  - `git merge --no-ff feat/feature-notes` on `dev`.
  - If `dev` moved and conflicts appear, resolve them; if code changes, rerun the affected checks and the full gate. Stop after the merge.
- [ ] **Step 4:** Report the merge commit, the branch, the gate results, and any residual risk. Do not push, deploy, or remove the feature worktree unless the user asks.

## Self-review notes

- Spec coverage: type/publish (Task 1), landing strip/delivery (Task 2), admin (Task 3), tests/docs (Task 4), merge (Task 5).
- The plan deliberately keeps the existing `standard` slide, campaign events and terminal state rows; it adds no migration and does not change campaign eligibility or the badge.
- The soft cap is accepted and documented; the review focus calls it out.
- The one open product choice kept from the spec: the note is asked on every landing activation (including a client-side New chat), not only on a document load. The shell's per-arrival latch and the campaign-first sequencing enforce "one at a time"; the e2e covers it.
