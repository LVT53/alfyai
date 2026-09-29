# Agent 5b report — App panel (redesign step 13) and the in-chat card's remaining states

Worktree `art-rd5b`, branch `feat/artifacts-rd5b-app`, e2e port 5445.
Commit range: `1777736f..bc77fad9` (12 commits on top of `6903880c`, the tip of agent 5a's merge).
Full diff vs. that base: 27 files changed, ~1,976 insertions(+), ~363 deletions(-) (excludes the
throwaway capture spec, deleted before the final commit).

## What changed, per step

### Step 13 · The App panel (`AppBody.svelte`, `AppFrame.svelte`)

- **Status row** (`src/lib/components/artifacts/app/AppBody.svelte`): moved out of the Preview tab
  panel to sit directly under the shared header, so it stays visible (and meaningful) on Code too —
  fixes redesign §6.1 problem 2 ("the fact check sits at the bottom edge, under the app"). Icon
  varies by verdict (`ShieldCheck` clean/repaired, `ShieldAlert` uncertain, muted `Shield`
  unavailable — a new `VERIFY_ICONS` map). "Read Alfy's note" is a real toggle now
  (`noteOpen` state, `aria-expanded`), collapsed by default; the note's own height animates via a
  CSS `grid-template-rows: 0fr → 1fr` transition (no JS needed — `prefers-reduced-motion`'s
  existing global `transition-duration: 0.01ms` override in `app.css` already collapses it to
  instant). Dropped the old repeated "AppWindow icon + title" row entirely (problem 2's other
  half).
- **Segmented Preview/Code control**: a real sliding-thumb segmented control
  (`.app-seg`/`.app-seg-thumb`, `role="tablist"`/`role="tab"` kept), "Change this app…" beside it
  in the same row (`.app-bar`), matching the mockup's `d · App & Knowledge` layout.
- **Sandbox bar moved into `AppFrame.svelte`** (redesign §6.2: "the sandbox promise is a thin bar
  on the frame itself"): a `Lock` icon + "Runs sandboxed · no internet · keeps your data" sits
  directly above the iframe, inside the one component that actually runs the app. The sandbox
  `allow-scripts allow-forms` attribute, the `{#key src}` remount, and the whole trust-boundary
  `handleMessage` function are byte-for-byte untouched — I only added a sibling bar and a wrapping
  `<div>` around the existing iframe (ruling 58's exact-string tests still pin the literal).
- **Regenerate popover, not a modal**: "Ask Alfy for a new version" (button + `DialogShell` modal)
  is now "Change this app…" opening a popover anchored under its own button. Desktop: a
  `position: fixed` div measured off `regenerateTriggerEl.getBoundingClientRect()`, portalled via
  `portalToBody`, the shared `focusTrap` attachment (`onEscape`, initial focus moves to the
  textarea, `restoreFocusOnCleanup` returns it to the trigger), and it joins `DialogShell`'s own
  topmost-dialog stack (imports `registerDialog`/`deregisterDialog`/`isTopmostDialog` from
  `DialogShell.svelte`'s module context — the same join `CampaignModal.svelte` already does) so
  Escape only closes the topmost layer if something else is open at the same time. An outside
  `mousedown`/`touchstart` listener closes it too. Phone: the exact same form content renders
  inside `<DialogShell phonePresentation="sheet">` instead (only mounted when `isPhoneViewport()`
  is true, so desktop never sees a centred modal). Real classes throughout (`btn-primary`,
  `btn-ghost`, `btn-sm`, `btn-icon-bare` — nothing hand-rolled). Submit ("Make v2") closes the
  popover immediately and starts the busy state, mirroring the mockup's own `runRegen()`.
- **Non-blocking busy veil**: while v2 builds, `.app-body-frame-wrap` gets a real HTML `inert`
  attribute (`inert={regenerateBusy}`) — not a fabricated overlay-only block — so keyboard focus
  cannot land in an app about to be replaced, plus `opacity: 0.55`. A veil card
  (`data-testid="app-busy-veil"`) shows "Alfy is building v2 · v1 stays until v2 is ready…" with a
  looping progress sweep (given a static `prefers-reduced-motion` fallback — see Reduced motion
  below). The status row *simultaneously* shows a spinner + "Alfy is checking the facts in v2…"
  (reused the existing, previously-dead `artifacts.app.verify.checking` key).
- **Failed regenerate**: status row shows "Alfy couldn't make v2. v1 is unchanged." plus a
  "Try again" button (reuses `artifacts.action.retry`) — not an inline dialog error. Try again
  reopens the popover **without discarding the prompt text** (a separate `retryRegenerate()` from
  the fresh-open handler, which does clear it). The popover's own granular reason
  (`empty_content`/`no_fence`/`tool_call`/`too_long`/`version_conflict`) still shows inline once
  reopened, for anyone retrying.
- **Real v2 toast with Undo**: extended `src/lib/stores/toast.ts`/`Toast.svelte` with an optional
  `actionLabel`/`onAction` pair (see "Shared primitives" below) rather than building a second toast
  mechanism. On success, `submitRegenerate()` snapshots the pre-regenerate version's id
  (`detail.versions[0].id`, captured before the call) and the toast's Undo calls
  `restoreArtifactVersion` (the same `versions.ts` `restoreVersion` mechanism the Document History
  sheet uses) — a real restore, never a fabricated affordance. `showToast({ duration: 5200, ... })`
  matches §7.2 row 33 ("leaves after 5.2s").
- **Download only in the header**: `AppBody.svelte` no longer renders its own Download button;
  it registers `openDownload` through `registerPanelActions` (only when `artifactConversationId`
  is truthy, so the header shows no button at all rather than one that would silently no-op — a
  small `DocumentWorkspace.svelte` change makes the header's download label kind-aware, "Download
  as .html" for App vs. the generic "Download" for everything else, since that button previously
  always used the Document-specific i18n key). The "not in a chat" hint paragraph and the
  transient `downloadError` line both still render in the body, just without a button attached to
  them.
- **Bug fix found along the way**: `submitRegenerate` now snapshots `artifactId` at call time and
  guards every write after the `await` with `if (id !== artifactId) return;` — the pre-existing
  code had no such guard, so switching to a different App mid-regenerate could have written that
  call's busy/error/success state onto the *new* App's UI. `load()` already had the equivalent
  guard for fetches; this mirrors it for regenerate.

### The Open-documents rail decision (`DocumentWorkspace.svelte`)

Chose to **complete §9.2's original "hide it for every artifact kind"** rather than keep it for
App: narrowed the condition from `activeDocument.kind !== "document"` to `!activeDocument.kind`.
The one e2e test that depended on the rail's persisted iframe `WindowProxy` for its cross-app
storage-isolation coverage now switches Apps through the panel list instead (the test's own
`openFromList()` helper, already used for the first two opens in that test) — the *same*
`{#key src}` remount in `AppFrame.svelte` fires either way, so it is still exercising the real
mechanism, not a weaker substitute. Full detail and reasoning is in the commit message
(`65c514de`).

### The in-chat card's remaining states

- **Live "current" (open-in-panel)**: threaded a new `activeArtifactId` prop (the panel's own open
  item, as a *bare* artifact id — distinct from `activeWorkspaceDocumentId`, the "artifact:"-
  prefixed workspace item id) from `+page.svelte` down through `ChatMessagePane` → `MessageArea` →
  `MessageBubble` → `ThinkingBlock` (all 4 internal render sites) → `ToolActivityList` →
  `ToolActivityRow`, mirroring the existing `alfyActivity` chain exactly. `ToolActivityRow`'s
  `artifactCardView()` now sets `ArtifactCardView.current` by matching `activeArtifactId` against
  `body.artifactId`.
- **Creating**: `tool-activity.ts`'s running branch for `create_artifact` (never `edit_artifact` —
  its call arguments carry no kind/title) now returns a new `"artifact-creating"` body instead of
  `null`, read from the tool call's own `input.artifactType`/`input.title` (available while
  running, unlike `metadata`, which is the settled result). `ArtifactCard.svelte` renders it as a
  disabled head + an "Alfy is writing…" subtitle (accent-coloured, matching the mockup's own
  inline style) + three shimmering skeleton lines reusing the mockup's own `.skeleton`/`.skel-line`
  visual, built from this codebase's existing tokens.
- **Failed**: a *settled, business-level* refusal (`ok: false`) of `create_artifact` — never
  `edit_artifact`, whose refusal keeps falling through to the generic identity/body exactly as
  before (`tool-activity.test.ts`'s own pinned "shows the refusal, not a deliverable" rule is
  untouched and still passes) — now returns a new `"artifact-failed"` body with the tool's own
  English reason, and the row's status is overridden to `"failed"` (red glyph) even though the
  transport-level `segment.status` stayed `"done"`. `ArtifactCard.svelte` renders a calm
  `RefusalNotice`-styled card ("Alfy couldn't make this." + the reason) — no Retry button, because
  there is no real retry path for a `create_artifact` call today (see Deviations).
- **App fact-check line**: `ArtifactCardSummary` gained an optional `appVerification`
  (`{checked, verdict}`) for `kind: "app"`, computed in `read-model.ts` from the exact same
  `metadata.verification` shape `AppBody.svelte` already reads client-side. `ToolActivityRow`
  projects it into a new `ArtifactCardView.factCheckLine` field via the shared
  `APP_VERIFY_LINE_KEYS` map (extracted from `AppBody.svelte` into
  `src/lib/shared/artifacts/app-verify-labels.ts` so both surfaces read the *identical* sentence
  per verdict) — "show the same line the panel's status row shows," literally. This flows through
  the *same* `body.preview` attachment `ThinkingBlock.svelte` already does for Document's
  `documentPreview` (nothing new to wire there).
- **Composer placeholder**: `+page.svelte`'s `composerPlaceholder` now branches on the open item's
  kind — App gets "Ask Alfy to change {title}…" (a new `artifacts.chat.composerPlaceholderApp`
  key) instead of the generic "Ask about {title}" every other kind uses, per redesign §6.2's own
  composer note. Refactored the underlying derived from `activeWorkspaceDocumentTitle` to
  `activeWorkspaceDocument` (the whole item) so both the placeholder and `activeArtifactId` read
  one lookup instead of two.
- **Not built** (per the brief): the "deleted" card state and the "1 part left alone" pill — both
  explicitly out of scope (agent 4a's territory / no server signal exists).

## Shared primitives touched (small, deliberate extensions — not new subsystems)

- **`src/lib/stores/toast.ts` / `Toast.svelte`**: added optional `actionLabel`/`onAction` to
  `ToastEntry`/`showToast()`, and a rendered action button in `Toast.svelte` between the message
  and the close X. This is what "Toast.svelte for undo toasts" (redesign §9.3) turned out to
  require — the component only supported a message + close before.
- **`src/lib/shared/artifacts/app-verify-labels.ts`** (new): `APP_VERIFY_LINE_KEYS`, extracted from
  `AppBody.svelte`'s own local copy. Both the panel's status row and the in-chat card's fact-check
  line now read one map.
- **`ArtifactCardView`** (`ArtifactCard.svelte`) gained `creating?`, `failedReason?`,
  `factCheckLine?` — all `chrome="full"` only, additive, `chrome="row"`/`"body"` untouched.
- **`ArtifactCardSummary`** (`services/artifacts/types.ts`) gained `appVerification?` — additive,
  `undefined` for every kind but App.
- **`DocumentWorkspace.svelte`**: the header's Download label is now kind-aware (App vs. generic).

## Tests added

- `src/lib/stores/toast.test.ts` (+1), `src/lib/components/ui/Toast.test.ts` (+2): the new
  action-button field/rendering, and its absence when unset.
- `src/lib/utils/tool-activity.test.ts` (+4, 1 rewritten): the creating-card body (rewrote the old
  "no card yet" running-create test to assert the new skeleton body), a running-edit-with-no-title
  regression, a defence-in-depth running-edit-with-a-title-shaped-input test, and the new failed
  body + red status.
- `src/lib/components/artifacts/ArtifactCard.test.ts` (+3): creating (skeleton, disabled head, no
  "Open"), failed (message + reason, disabled head), fact-check line rendering.
- `src/lib/components/chat/ToolActivityRow.test.ts` (+5): `current` matched/not-matched, the App
  fact-check line (built from a hand-assembled `body.preview`, mirroring how `ThinkingBlock`
  attaches it — this component has no `conversationArtifacts` prop of its own), the creating
  skeleton card, the failed card.
- `src/lib/server/services/artifacts/read-model.test.ts` (+4): `appVerification`
  present/null/malformed/omitted-for-non-app.
- `src/lib/components/artifacts/app/AppFrame.test.ts` (+1): the sandbox bar's text.
- `src/lib/components/artifacts/app/AppBody.test.ts`: rewrote the "download" describe block (6
  tests) to drive `registerPanelActions` directly instead of a body-local button; rewrote
  "regenerate" (3 tests → popover/"Make v2", failed-status-row + Try again + preserved prompt) and
  added 2 new tests (busy veil + `inert`, the v2 toast's real Undo restore) + 1 note-toggle test.
  30 tests total in this file now (was 27; net +8 after the rewrites).
- `tests/e2e/artifact-app.spec.ts`: fixed the regenerate test onto "Change this app…"/"Make v2",
  and the rail-switch test onto the panel list (same test, renamed to describe what it now does).

## Gates (run at the end; the last two after every code commit including the final CSS fix)

1. `npm run check` — **0 errors, 17 warnings**, exactly the documented baseline (`ToolActivityRow`
   10, `ThinkingBlock` 6, `RouteItinerary` 1). Verified clean after the final commit too.
2. `npx biome check src scripts tests` — clean (9 pure-formatting fixes applied and verified along
   the way; final state has zero pending fixes).
3. `npm test` (full vitest) — **13559 passed, 2 skipped, 0 failed** (892 files passed, 1 skipped of
   893).
4. Playwright, port 5445: the exact 10-file list the brief's gate names —
   `artifact-app.spec.ts artifact-chat-card.spec.ts artifact-document-comments.spec.ts
   artifact-document-selection-bubble.spec.ts artifact-document.spec.ts artifacts-api.spec.ts
   artifacts-panel.spec.ts knowledge.spec.ts chat.spec.ts conversation.spec.ts` — **81 passed, 0
   failed** (~3.9 min), one clean run, nothing rerun. `artifact-app.spec.ts` alone re-verified
   again after the final CSS-only commit (10/10).
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd5b.json` —
   **124 total issues, 4 circular dependencies** — exactly the documented baseline, **zero new
   findings** (verified none of my touched/new files — `AppBody.svelte`, `ToolActivityRow.svelte`,
   `app-verify-labels.ts`, `read-model.ts`, `artifact-bodies.ts` — appear anywhere in the report).

## Reduced motion

Everything new is either a plain CSS `transition`/`animation` (segmented-control thumb slide, note
height via `grid-template-rows`, status spinner, busy-progress sweep, popover-open/close-adjacent
opacity) — already covered by `app.css`'s existing global
`*, *::before, *::after { animation-duration/transition-duration: 0.01ms !important;
animation-iteration-count: 1 !important; }` override — or the popover's Svelte `scale` transition,
wrapped in `reducedMotionAware` like every other migrated popover/sheet in this codebase. One place
needed an explicit reduced-motion rule: the busy-progress sweep's one forced 0.01ms iteration lands
on its keyframe's *end* (fully translated off to the right, i.e. invisible), so I added a small
`@media (prefers-reduced-motion: reduce)` block holding it at a plain resting position instead —
the redesign's own §7.3 rule 2 ("a loop becomes a static state... never an animated dot alone").

## Accessibility

- Status row: `role="status" aria-live="polite"` while checking/building; `role="alert"` while
  failed/glitching. Note toggle: real `aria-expanded`/`aria-controls`. Segmented control: kept
  `role="tablist"`/`role="tab"`/`aria-selected`/`aria-controls`. Popover: `role="dialog"
  aria-modal="true" aria-label="Change this app…"`, focus-trapped, Escape-closable, initial focus
  on the textarea, focus restored to the trigger on close. Busy veil: never traps focus (no
  `focusTrap` there on purpose); the frame itself is `inert` instead, per redesign §6.4.
- Phone 44px touch targets: added a `@media (max-width: 639px)` rule (matching
  `viewport.svelte.ts`'s own `PHONE_MAX_WIDTH`) bumping the segmented tabs and the primary button
  to `min-height: 44px`. Found and fixed a real wrapping issue at 390px via the Hungarian
  screenshot (see below) — the status row now wraps instead of squeezing the note toggle.
- Focus rings: the popover/regenerate controls all reuse global `.btn-*`/`.app-seg-tab` classes
  with `:focus-visible` box-shadow rings already defined (either globally in `app.css` or locally
  for the new `.app-seg-tab`/`.app-regen-textarea`).

## Screenshots (Hungarian, not committed — capture script deleted before the final commit)

Saved to `scratchpad/rd/shots/rd5b/`, looked at once each, one real issue found and fixed (the
phone status-row wrap, see above):

- `app-panel-hu-desktop-light.png` (1440×900) — the App panel: header ("EZ A BESZÉLGETÉS 1",
  "Alkalmazás · v1 · épp most"), the status row ("Alfy ellenőrizte az adatokat, és kijavított egy
  dolgot." + "Alfy megjegyzésének elolvasása"), the segmented control ("Előnézet"/"Kód") beside
  "Módosítás…", the sandbox bar ("Homokozóban fut · nincs internet · megőrzi az adataidat"), the
  composer placeholder ("Kérd meg Alfyt, hogy módosítsa ezt: Trip budget splitter").
- `app-panel-hu-desktop-dark.png` (1440×900) — same surface, dark theme; sidebar/panel/status
  row/sandbox bar all correctly follow the theme (the App's own generated HTML content is
  necessarily still light — that's the app's own arbitrary markup, not part of the design system).
- `regenerate-popover-hu-desktop-light.png` (1440×900) — the popover open, anchored under
  "Módosítás…": "Min változtasson?" title + label, the textarea, "Mégse"/"v2 elkészítése" (the
  latter correctly disabled-looking with an empty textarea), the effect line ("Alfy megírja az új
  változatot, és ellenőrzi az adatait. A v1 megmarad az Előzményekben.").
- `app-panel-hu-phone-light.png` (390×844) — after the wrap fix: status text and the note toggle
  each on their own line, everything else unchanged from desktop, no horizontal overflow.

**Not captured**: the "creating" and "failed" in-chat card states in Hungarian. Both need a live or
fake-provider `create_artifact` tool call frozen mid-flight (creating) or refused (failed) inside a
real chat turn; building that harness (or extending the shared AI-smoke fixture library with a new
refusal scenario) was a larger cost than the rest of this step's screenshots combined, for a state
that — for "creating" specifically — is inherently as hard to freeze as the redesign spec's own
Appendix found for "Alfy is writing" ("could not be captured: the fake model's tool call and its
result reach the browser in the same stream chunk"). Both states are fully covered by unit tests
instead (`ArtifactCard.test.ts`, `ToolActivityRow.test.ts`, `tool-activity.test.ts`).

## Deviations from the spec, with reasons

- **Preview↔Code has no cross-fade** — §7.2 row 28 wants "the thumb slides; content cross-fades";
  I built the thumb slide but the content swap is a plain `{#if}/{:else}`, no transition. Under
  reduced motion this is already the *correct* end state (row 28's own reduced-motion column says
  "instant"), so the gap is normal-motion polish only. Scoped out for budget once the thumb slide,
  the popover, the veil and the toast were all working and tested.
- **App's version pill has no real "Versions" browsing** — the header shows `v{n}` as plain static
  text (no `onVersions` handler registered), same as before this step. Checked the mockup's own
  demo JS first: its `#appVerBtn` click handler just shows a toast placeholder
  (`toast(t("appVersionsToast", ...))`) — there is no real Versions UI for App in the approved
  mockup either, so I did not invent one. `fetchArtifact` already returns the full `versions[]`
  array (used internally for the Undo restore's `restoreVersionId`), so a future agent building a
  real Versions sheet for App has the data already flowing.
- **Download-busy has no visual feedback on the header button** — `downloadBusy` still guards
  against a double-submit internally, but nothing disables or spins the header's button while a
  download request is in flight (the old body-local button did the same job with its own
  `disabled={downloadBusy}`, now unreachable from the header). `ArtifactPanelBodyActions.
  openDownload` is a bare `() => void` with no busy signal in its contract; extending that contract
  felt like it belonged to whichever agent next touches `ArtifactPanelHeader.svelte` for a second
  kind's busy-download need, not a one-off App-specific special case here.
- **The regenerate popover's textarea has an explicit `<label>`** that visually repeats the
  popover's own h4 title text ("Min változtasson?" appears twice — see the popover screenshot).
  The mockup's own raw HTML has no `<label>` at all, relying on visual proximity to the heading.
  Kept the explicit label deliberately (proper `for`/`id` association for screen readers) rather
  than matching the mockup's implicit one.
- **`VersionsSheet.svelte`/`DownloadSheet.svelte`'s own "popover anchored to the header button with
  focusTrap"** (redesign §9.2's own row for those two Document-only components, distinct from the
  App popover I built) is still not built — confirmed via rd2's report that Step 5 only covered
  Tabs/Toolbar/MobileToolbar's sheet, not this. Out of scope here (Document belongs to other
  agents); flagging since my brief pointed me at the same §9.2 section that names it.

## Hand-off — reuse these

- **`APP_VERIFY_LINE_KEYS`** (`src/lib/shared/artifacts/app-verify-labels.ts`): the one map from
  `AppVerificationVerdict` to an i18n key. Any future surface that needs to say what the App
  panel's status row says (a search result, a notification, …) should import this rather than
  re-deriving the four sentences.
- **`Toast.svelte`'s `actionLabel`/`onAction`**: any future "X happened · Undo/Retry/View" toast
  should use this instead of a bespoke banner. `duration` is still fully overridable per call
  (5200ms for the v2 toast vs. the 4000ms default).
- **`ArtifactCardView.creating`/`failedReason`/`factCheckLine`** (`ArtifactCard.svelte`,
  `chrome="full"` only): a future Canvas/Slides "creating"/"failed" card state should set these
  the same way `ToolActivityRow.svelte`'s new `artifactCreatingCardView`/`artifactFailedCardView`
  do, rather than inventing a second skeleton/failure treatment. `factCheckLine` is deliberately
  generic (plain already-localised text, no verdict-icon coupling) — any kind with its own
  "one-line status echo" need can reuse it without teaching `ArtifactCard` a new verdict enum.
- **The anchored-popover-desktop / `DialogShell`-sheet-phone pattern** (`AppBody.svelte`'s
  `regeneratePopoverOpen` block): `measureRegeneratePopover()` (rect-based `position: fixed`
  placement, no viewport-edge flip logic — safe because the App panel is always wide enough) +
  `focusTrap` + `portalToBody` + joining `DialogShell`'s own topmost stack via its exported
  `registerDialog`/`deregisterDialog`/`isTopmostDialog`. This is the first concrete instance of
  "a popover on desktop, a sheet on phone" outside `IncognitoPopover.svelte` (which hand-rolls its
  own sheet rather than reusing `DialogShell`) — whichever agent eventually builds
  `VersionsSheet`/`DownloadSheet`'s own popover treatment (see Deviations above) can lift this
  shape directly.
- **`activeArtifactId` prop chain**: `+page.svelte` → `ChatMessagePane` → `MessageArea` →
  `MessageBubble` → `ThinkingBlock` → `ToolActivityList`/`ToolActivityRow`, all typed
  `string | null`, default `null` — the exact same shape as rd5a's own `alfyActivity` chain, kept
  parallel to it on purpose. A future "is this the open item" need anywhere in this chain reuses
  the existing prop rather than adding a third parallel one.
- **`activeWorkspaceDocument`** (`+page.svelte`, renamed from `activeWorkspaceDocumentTitle`): now
  the one derived lookup both `composerPlaceholder` and `activeArtifactId` read from. A future
  per-kind composer-placeholder or open-item need reads this rather than re-deriving its own.
- **`registerPanelActions`'s `openDownload: fn | undefined` pattern**: App is now the second real
  implementation after Document (which uses it for a sheet-opener; App uses it for a direct
  action). Confirms the contract is generic enough for either shape — a future kind can register
  either a sheet-opener or a direct action through the same field.
- **Not mine, still open**: the Open-documents-rail's long-term fate for Canvas/Slides once those
  kinds get real bodies (currently moot — no body loader exists for them yet, so they never reach
  the `!activeDocument.kind` branch either way in practice); `VersionsSheet`/`DownloadSheet`'s own
  popover-ification (Deviations above); the download-busy header-button feedback gap (Deviations
  above).
