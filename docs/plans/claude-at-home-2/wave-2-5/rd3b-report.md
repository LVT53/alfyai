# rd3b report — Comments on phones, the narrow-panel drawer, Versions and Download popovers

Branch `feat/artifacts-rd3b-sheets`, worktree `.claude/worktrees/art-rd3b`. Base: `f1c29be8`
("Merge redesign agent 5b"). 9 commits, HEAD `dc370bc6`.

Commit range: `f1c29be8..dc370bc6`
```
7d09962d feat(artifacts): Versions and Download become anchored popovers with sheets on phones
352e5a21 feat(artifacts): add CommentsSheet for the phone comments sheet and narrow-panel drawer
c3f37c38 feat(artifacts): wire the comments overlay into DocumentBody
dda60ab4 feat(artifacts): add the header's Comments button with its open-thread badge
30b6ce75 test(artifacts): add Playwright coverage for the comments overlay and popovers
d11183d1 fix(artifacts): use the real btn-sm class in the Versions popover, not a made-up btn-xs
cbeb0211 fix(artifacts): raise the three phone sheets above the mobile shell's own backdrop
3b828831 test(artifacts): assert the phone Comments sheet is actually topmost, not just visible
dc370bc6 style: biome formatting pass over this session's files
```

## What changed, by step

### Versions and Download → anchored popovers (redesign §3.2/§9.2/§9.3)

`VersionsSheet.svelte` and `DownloadSheet.svelte` were plain always-rendered cards positioned by
a wrapping `<div class="document-versions-anchor">`/`.document-download-anchor"` inside
`DocumentBody.svelte`. Rewrote both to the anchored-popover-desktop / `DialogShell`-sheet-phone
shape `AppBody.svelte`'s regenerate popover already established (rd5b's own hand-off pointed here
directly):

- Desktop: `position: fixed`, rect-measured against the trigger button (found via
  `document.querySelectorAll('[data-testid="artifact-version-pill"]'
  /`"artifact-download-button"`)`, filtered to whichever copy is actually rendered — both the
  mobile-shell and desktop-shell headers are real DOM nodes at every viewport, CSS alone decides
  which is visible), `portalToBody`, `focusTrap` joined to `DialogShell`'s own
  `registerDialog`/`deregisterDialog`/`isTopmostDialog` stack (so Escape closes only the topmost
  layer), click-outside-to-close, `reducedMotionAware(scale)` entrance.
- Phone: the same content inside `DialogShell` `phonePresentation="sheet"`.
- Versions gets: a `v{n}` label per row, avatars (`AvatarCircle` for the user, a Lucide `Sparkles`
  tile for Alfy — matching `CommentCard.svelte`'s own pattern exactly), Restore
  reveal-on-hover/focus (always shown on touch, via the `(hover:none)` media query), and the inline
  restore confirm ("Restore v4? Your current text stays as a version. [Cancel] [Restore]") —
  `ConfirmDialog` is gone from this file entirely. A successful restore closes the popover and
  raises a `Toast` ("Restored v2 as v4 · Undo"); Undo restores whatever was current a moment
  before (captured as `versions[0]?.id` before the restore — never re-restores the same target),
  mirroring `AppBody.svelte`'s own `handleUndoRegenerate` shape.
- `DocumentBody.svelte`'s own edit here is just removing the two now-unneeded wrapper divs (the
  popovers position themselves) and their now-dead CSS.

New i18n keys inside the existing `versions.` block (EN+HU): `restoreConfirm` now takes `{v}`
(was generic text), `restoreToast`, `undo`.

### CommentsSheet — the phone sheet and the narrow-panel drawer (redesign §3.2/§3.3)

New `src/lib/components/artifacts/document/CommentsSheet.svelte`. Wraps `MarginPanel.svelte`
**unchanged** as its content (per rd3a's own hand-off) behind two presentations the caller
decides:

- `presentation="sheet"` (phone): `DialogShell phonePresentation="sheet"`, `titleVisuallyHidden`
  (MarginPanel already draws its own visible "Comments" `<h2>` + the resolved-count toggle as its
  rail header — a second visible title would duplicate it; `DialogShell`'s title still carries the
  dialog's accessible name via `aria-labelledby`).
- `presentation="drawer"` (narrow desktop panel): a self-built 280px `position: fixed` panel over
  the right edge of the viewport, `portalToBody`, its own `focusTrap` joined to the same
  `registerDialog`/`isTopmostDialog` stack, `reducedMotionAware(fly)` slide-in from the right.

`contentEl` is **deliberately never forwarded** — `MarginPanelProps` is typed as
`Omit<ComponentProps<typeof MarginPanel>, "contentEl">`. `MarginPanel`'s own placement math
measures the TEXT's scroll container; this overlay isn't in that scroll container, and
withholding `contentEl` puts `MarginPanel` straight into its own already-built "plain stacked
list" fallback (`panelWidth` stays 0, `useMarginLayout` stays false) — exactly the shape a
disconnected overlay needs, with nothing new to build for it.

The quote button ("goes to the anchor") is wrapped to also call `onClose()` after the real
handler — jumping to the text is an exit action from a sheet/drawer that would otherwise still be
covering (or partly covering) what it just scrolled to.

### Wiring into DocumentBody.svelte (Step 8's "one handler" + mounting)

- New container-width tracking: `documentBodyEl` (`bind:this` on `.document-body`),
  `panelContainerWidth` via a guarded `ResizeObserver` (same `typeof ResizeObserver === "undefined"`
  guard `MarginPanel.svelte` already uses, so jsdom/vitest stays correct without one),
  `isNarrowPanel = panelContainerWidth > 0 && panelContainerWidth < 820`. `NARROW_PANEL_THRESHOLD_PX`
  is the one JS-side copy of the SAME 820 the CSS below uses — commented as a pair, must stay in
  step.
- `.document-content`/`.document-content-rail`'s CSS moved from `@media (min-width: 820px)` to
  `@container (min-width: 820px)` (`container-type: inline-size` added to `.document-body`) — the
  panel this body sits inside is a resizable side pane (`workspace-fade-in { width: min(68vw,
  59.375rem); }`, a `.workspace-resize-handle`), not necessarily full viewport width, so a
  viewport-`@media` query was measuring the wrong thing for "is there room for the 300px rail".
  Confirmed harmless to existing desktop tests: at the Playwright default viewport the DOCKED
  panel is ~870px wide, still ≥820, so nothing that depended on the inline rail being visible by
  default changed.
- `commentsOverlayOpen` state; `openCommentsOverlay()` registered as `registerPanelActions`'s new
  `openComments`; an `openCommentCount` derived (`comments.filter(c => c.status !== "resolved").length`,
  across every tab — the header button represents the whole document, matching the mockup's own
  header count) reported upward every render via a new `onCommentCountChange` callback prop.
- The "one handler": `handleEditorAnchorActivate` (already existed, sets `activeCommentId` +
  bumps `focusCommentRequest`) gained one `if (isPhone || isNarrowPanel) openCommentsOverlay();`
  line. Because `CommentsSheet` mounts the SAME `MarginPanel` with the SAME already-set
  `focusRequest`, its `focusOnRequest` action (confirmed by reading it: `apply(params)` runs on
  the action's own creation, not just on `update`) scrolls-to-and-focuses the right thread
  immediately on mount — no new plumbing needed for "opens the sheet at that thread".
- An auto-close effect (`if (!isPhone && !isNarrowPanel) commentsOverlayOpen = false;`) so a
  resize back to wide doesn't leave a drawer floating uselessly next to the now-visible inline
  rail.
- Template: the inline `<aside class="document-content-rail">` is unchanged; `<CommentsSheet
  presentation={isPhone ? 'sheet' : 'drawer'} ... onClose={...} />` mounts as a sibling when
  `commentsOverlayOpen`, passing the same 12 props `MarginPanel` already took (minus `contentEl`).

### The header's Comments button (DocumentWorkspace.svelte)

`artifactHeaderActionsSnippet()` (shared by both the mobile-shell and desktop-shell
`ArtifactPanelHeader` instances) gained a Comments button before Download (matches the mockup's
`.ph-actions` order: Comments, Download, divider, Expand, Close), gated on
`bodyPanelActions?.openComments` (Document only — App/File never register it, so the button never
renders for them). Shows `documentOpenCommentCount` as an overlaid badge, but only once it's above
zero (mirrors this same file's own `artifacts.header.buttonA11y` "never draw a bare 0" rule) — the
icon (`MessageSquareText`) alone otherwise. New `documentOpenCommentCount` state, reset alongside
`bodyPanelActions` in the existing per-item-change effect. Both `<ArtifactBody>` mount points wire
the new `onCommentCountChange` prop. The Download button also gets a stable
`data-testid="artifact-download-button"` (the version pill already had one) so the popovers' own
anchor lookup has something to query.

New i18n key `artifacts.document.margin.buttonA11y` ("Comments ({count})") inside the existing
`margin.` block, EN+HU.

### `artifact-bodies.ts`

`ArtifactPanelBodyActions` gained `openComments?: () => void`. `ArtifactBodyProps` gained
`onCommentCountChange?: (openCount: number) => void` — a plain reactive report (not a
`registerPanelActions` field, since it changes continuously as comments load/resolve rather than
being a one-time trigger).

## A real bug the Hungarian screenshot pass caught

All three phone sheets (Comments/Versions/Download) open from a button **inside**
`DocumentWorkspace.svelte`'s mobile shell, whose own `.workspace-mobile-backdrop` sits at
`z-index: 95`. `DialogShell`'s default `z-50` rendered every one of them genuinely `visible` and
interactive per every role/text-based query (Playwright's `toBeVisible()`/Testing Library's
`getByText` do not check paint order) — but painted **behind** that backdrop. Found only by
looking at the actual screenshot pixels, not by any of the (passing) interaction tests. This is
the exact same issue `MobileToolbar.svelte`'s own "More" sheet already hit and documented; fixed
all three with the same `zIndexClass="z-[150]"`. Added a regression test
(`artifact-document-comments.spec.ts`, the phone Comments test) using
`document.elementFromPoint` at the sheet's own rect to assert it is the actual topmost element,
not just DOM-visible — this is the check that would have caught the bug without a screenshot pass.

## Tests added

- `CommentsSheet.test.ts` (new, 5 tests): sheet vs. drawer rendering, no duplicate visible
  "Comments" heading, portaled-to-body, Escape + `unmount()` (simulating the parent's own
  `onClose`-driven teardown, mirroring `DialogShell.test.ts`'s own pattern) restores focus,
  close-button, and "going to a comment's anchor also closes the overlay".
- `VersionsSheet.test.ts` (rewritten, 8 tests): version number + avatar rendering, popover
  role/name + portaled-to-body, inline-confirm-then-restore with the toast+Undo assertion, Cancel
  leaves it untouched, Undo restores whatever was current before (not the just-restored target),
  retry-on-load-failure, close button, Escape.
- `DownloadSheet.test.ts` (updated, 8 tests): added portaled-to-body and Escape; the rest
  unchanged in substance.
- `DocumentBody.test.ts` (+3 tests, in a new "comments away from the rail" describe): registers
  `openComments` and it opens the phone sheet (mocks `isPhoneViewport` via a `vi.hoisted` mutable
  flag, `importOriginal`-preserving every other export so `DialogShell`'s own
  `resolveDialogPresentation` import stays real); `onCommentCountChange` reports the open
  (non-resolved) count across the whole document; a synthetic click on a `.comment-anchor
  [role=button]` span opens the phone sheet too. The width-driven narrow-panel branch needs a real
  ResizeObserver/layout, which jsdom does not have — left for Playwright, per the brief's own plan.
  Also fixed the one pre-existing test that used `ConfirmDialog`'s `confirm-delete` testid for the
  old restore flow (no longer exists — the confirm is inline now).
- `artifact-document-comments.spec.ts` (+7 Playwright tests, two new `test.describe` blocks): the
  phone Comments sheet from the header AND from a tapped highlight (+ the topmost-paint-order
  regression check above); the narrow-panel drawer appearing below the 820px container threshold
  while the inline rail stays hidden (viewport 1100×800 — chosen so BOTH the chat page's own
  desktop count-button breakpoint, Tailwind `lg`/1024px, and the workspace's own desktop-shell
  breakpoint, 768px, agree it's "desktop", while the DOCKED panel's `min(68vw, 950px)` still comes
  out under 820); the Versions popover anchored near its own button, opened ON TOP of an
  already-open Comments drawer (both reachable via real UI interaction, since neither drawer nor
  popover has a backdrop), where Escape closes only the popover and the drawer stays open, then
  refocuses the version button; an inline restore with its Undo toast; the Download popover's
  PDF/Word/Markdown options. Every header-button lookup is scoped to whichever shell
  (`document-workspace-mobile-shell` testid, or the desktop `<aside role="complementary">`) is
  actually active for that test's viewport — `page.getByTestId(...)` alone strict-mode-fails since
  both shells are always in the DOM.

## Screenshots (Hungarian)

Captured via a throwaway spec (deleted before the final commit, never tracked), switching the
seeded user's `uiLanguage`/`theme` through the real `/api/settings/preferences` route (client-only
`localStorage` seeding does NOT work — the server-provided preference wins on every load, the same
rule `theme`'s own store documents for itself). Saved to
`…/scratchpad/rd/shots/rd3b/` (not committed):

- `phone-comments-sheet-hu-390x844-light.png` — the Comments sheet, thread with "· elmozdult"
  (moved), Reply/Resolve.
- `phone-versions-sheet-hu-390x844-light.png` — the Versions sheet, avatars, v2 "Jelenlegi"
  (Current)/v1.
- `desktop-versions-popover-hu-1440x900-light.png` — the Versions popover anchored under `v2 ▾`,
  the inline rail visible alongside it (1440px is well above the 820px threshold).
- `desktop-versions-popover-hu-1440x900-dark.png` — same, dark theme.

All four looked correct against the mockup's intent on inspection (before the z-index fix, the two
phone ones showed the sheet's content rendered but invisible behind the document — see the bug
above; re-captured clean after the fix).

## Gates — all run once, at the end

1. `npm run check` — **0 errors, 17 warnings** (the exact pre-existing baseline: `RouteItinerary`
   1, `ToolActivityRow` 10, `ThinkingBlock` 6). No new warnings.
2. `npx biome check src scripts tests` — clean after fixing 5 pure line-wrap formatting diffs and
   one explained `useImportType` suppression in `CommentsSheet.svelte` (biome's import-usage check
   only sees the `<script>` block, not the template's two `<MarginPanel {...} />` mounts, so a
   genuinely-runtime import reads as type-only to it).
3. `npm test` (full vitest) — **893 files passed, 1 skipped; 13,607 tests passed, 2 skipped. Zero
   failures.**
4. Playwright, once, on port 5425: `tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts
   tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts` — 86 tests,
   85 passed, 1 failed (`artifact-chat-card.spec.ts`, unrelated to this work — the in-chat card
   during a live `create_artifact` call). Re-ran that spec alone per the brief's own guidance: 2/2
   passed. Confirmed pre-existing flake, not a regression.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd3b.json` —
   **`total_issues: 124`, `circular_dependencies: 4`. Exact match to the stated baseline. Zero new
   findings.**

## Deviations from the spec, with reasons

- **The narrow-panel drawer positions itself against the viewport's own right edge
  (`position: fixed; right: 0`), not the panel's own measured rect.** Correct for the panel's
  default DOCKED presentation (its right edge is flush with the viewport's — it's the last flex
  child in a right-docked layout with nothing past it), and the only presentation narrow enough to
  ever cross the 820px threshold at the widths this brief's screenshots and tests use. The panel's
  separate "expanded" presentation (`.workspace-shell-expanded`, centered with margins on both
  sides, `z-index: 115`) is not accounted for — on a narrow enough BROWSER WINDOW with the panel
  expanded, the drawer would likely misplace itself against the wrong edge, and could even paint
  under the expanded shell's own z-index. Not reachable through any test or screenshot this brief
  asked for; flagged rather than silently accepted. A future pass wanting this combination should
  measure `.document-body`'s own rect the way `VersionsSheet`/`DownloadSheet` measure their
  trigger buttons, and bump `CommentsSheet`'s drawer `z-index` past 115 to match.
- **The header's Comments button does not toggle the INLINE rail's own visibility at wide
  (≥820px) panel widths**, unlike the mockup's own `#commentsBtn`, which hides/shows the inline
  column at any width via a `comments-hidden` class. The brief's own Step 8 title and bullets
  ("Comments on phones and in a narrow panel") scope this to phone + narrow; adding a third,
  wide-desktop "hide the rail entirely" behavior wasn't asked for and would have meant giving the
  button a THIRD piece of visible state (`aria-pressed`) with no test or screenshot coverage
  requested for it. Left out; the button today opens the overlay only where the inline rail isn't
  already visible.
- **Versions' restore toast's Undo, and the restore itself, always mint a brand-new version**
  (ruling 47: never coalesced) rather than the popover re-fetching and staying open. Matches the
  mockup's own `doRestore` exactly (`closeHistory(); closeSheet();` before the toast) — a
  deliberate read of the mockup's JS, not a guess.

## Hand-off — reuse these

- **The anchored-popover-desktop / `DialogShell`-sheet-phone shape**, now with THREE real
  instances (`AppBody.svelte`'s regenerate popover, and now `VersionsSheet.svelte`/
  `DownloadSheet.svelte`): rect-measured `position: fixed` (via a `document.querySelectorAll`
  lookup filtered to whichever shell copy is actually rendered, when the trigger lives in a
  shared/duplicated header — see below), `focusTrap` joined to `DialogShell`'s own
  `registerDialog`/`deregisterDialog`/`isTopmostDialog` stack, `portalToBody`,
  `reducedMotionAware(scale)`. A future Canvas/Slides popover need should copy this shape directly
  rather than re-deriving it a fourth time.
- **`zIndexClass="z-[150]"` for ANY `DialogShell` sheet that can open from inside
  `DocumentWorkspace.svelte`'s mobile shell.** Three real instances now confirm this isn't a
  one-off (`MobileToolbar.svelte`'s "More" sheet, and now `CommentsSheet`/`VersionsSheet`/
  `DownloadSheet`'s phone branches) — the mobile shell's own `.workspace-mobile-backdrop` is
  `z-index: 95`, so DialogShell's default `z-50` is silently wrong (still `toBeVisible()`,
  genuinely painted underneath) for EVERY phone sheet opened from inside that shell. A future
  agent adding a fourth should reach for this value on sight, not rediscover it by screenshot.
  **`document.elementFromPoint` at a dialog's own rect** is the cheap, no-screenshot-needed way to
  assert "is actually topmost" in a Playwright test — `toBeVisible()`/`getByText` alone cannot
  catch this class of bug; see the regression test added to `artifact-document-comments.spec.ts`.
- **Both the mobile-shell and desktop-shell headers are real DOM nodes at every viewport width**
  (`DocumentWorkspace.svelte`; CSS alone decides which is visible) — ANY new header button/badge
  needs its lookup scoped to one shell (`document-workspace-mobile-shell` testid, or the desktop
  `<aside role="complementary">`) in both Playwright AND any component that measures a trigger's
  own rect (`document.querySelectorAll` + filter by `getClientRects().length > 0`, not
  `querySelector`). This is now a 3-for-3 pattern (`artifact-version-pill`,
  `artifact-download-button`, this same reasoning would apply to any future header control).
- **`CommentsSheet.svelte`'s `contentEl`-omission trick** — reuse this exact shape (`Omit<
  ComponentProps<typeof X>, "someProp">` plus deliberately never forwarding it) for ANY future
  component that reuses another component's content in a context where one of that component's
  props stops making sense (a measurement/scroll-container prop, here) rather than teaching the
  REUSED component a new "am I in an overlay" branch itself.
- **`.document-body`'s `container-type: inline-size`** is now the one place `.document-content`/
  `.document-content-rail` read "is there room for the 300px rail" — the JS-side
  `NARROW_PANEL_THRESHOLD_PX` (820, `DocumentBody.svelte`) and the CSS `@container (min-width:
  820px)` are the same number kept in two places on purpose (CSS can't read a JS constant); change
  one, change the other.
- **`ArtifactPanelBodyActions.openComments` / `ArtifactBodyProps.onCommentCountChange`**
  (`artifact-bodies.ts`) are the two new fields in this session's established
  registerPanelActions-and-friends conventions — a future kind with its own comment-like overlay
  (unlikely, but the shape generalizes) should reuse these rather than adding a third parallel
  pair.
- Kept test ids stable throughout, per the brief: `artifact-count-button`, `artifact-panel-list`,
  `alfy-change-bar`, `refusal-notice`, `margin-comment`, `selection-bubble`, `document-tabs`. New
  ones added, all additive: `artifact-comments-button`, `artifact-download-button`,
  `comments-drawer`, `document-versions-popover`, `document-download-popover`.

## Not mine, still open

- The "expanded" workspace presentation × narrow-panel drawer combination (see Deviations above).
- The wide-desktop "hide the inline rail entirely" toggle the mockup's own `#commentsBtn` has,
  which this brief's own scope (phone + narrow) didn't ask for.
- Agent 4b (the review bar) comes after this branch.
