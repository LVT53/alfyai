# Polish agent G2-B report — the Document's phone touch targets, prose details, review bar at laptop widths, filter and Dismiss

Model: claude-sonnet-5-5. Worktree `…/.claude/worktrees/art-g2b`, branch `polish/artifacts-doc-polish`, e2e port 5515.
Commit range `a0cd35e3..22337a54` (8 commits, 16 files, about +1180/−107). Nothing pushed, merged or rebased.

Status: **DONE**.

## Commits

| commit | what |
|---|---|
| `f2539b05` | Prose: tight checklists, status chip select as wide as its value |
| `2357a26b` | Phone: 44px mobile toolbar buttons, chip selects and task ticks |
| `c40c1e58` | Review bar: one row at 480px and up, flush with the bottom of the text column |
| `12446d9a` | The comment filter (and the removed-text fold) survive hiding and showing the column |
| `2dc5a932` | The refusal card slides out when dismissed (§7.2 #22) |
| `f8bf49c8` | Found in my own screenshots: a table cell's paragraph carries no bottom margin |
| `2daf63c7` | style: indent ReviewBar's markup inside its container wrapper |
| `22337a54` | docs: a comment says which padding the tick's hit area borrows |

## Step by step

### 1. Prose (`f2539b05`, review 251–255) — `DocumentBody.svelte` CSS

- The editor stores every task item as its own block, hence its own `ul[data-type=taskList]`, each with `margin: 6px 0 16px`
  (collapsing to 16px between rows). New sibling rules: a task list after a task list has `margin-top: 0`, one followed by a task
  list has `margin-bottom: 0` (`:has(+ ul[data-type=taskList])`). The rows also take the mockup's `.task` values: `line-height: 1.45`
  (they inherited the prose's 1.72) and `margin: 0` (the generic `li` rule's 2px).
  **Measured: row pitch 50.66px → 30.5px; the mockup's `.tasks .task` is 30.475px** (15.5 × 1.45 + 2 × 4), both for a run of
  one-item lists and for one tight list.
- The status chip select gets `field-sizing: content`: **"Paid" 62px → 33px of text + < 8px**, "Kifizetve" no longer carries the width of
  "Lefoglalandó". Engines without `field-sizing` keep today's longest-option width (a graceful fallback, not a break).

### 2. Phone touch targets (`2357a26b`, review 233–238) — `MobileToolbar.svelte`, `app.css`, `DocumentBody.svelte`

- Mobile toolbar: buttons 36 → **44×44**. The `.mobile-toolbar .btn-icon-bare` 36px `!important` opt-out in `app.css` is gone
  (the global 44px rule applies), and the row drops its vertical padding instead, so it stays **45px** (border 1 + button 44), inside the
  48px budget the existing e2e asserts. Seven buttons are 320px: fits a 360px phone.
- Chip selects: 21.5px → **44px tall** (the select's own box, so a tap really opens it): `min-height/min-width: 44px`,
  `margin: -9px -8px; padding: 0 8px`, so the 26px pill and the line around it do not grow (asserted: pill ≤ 26.5px).
- Task ticks: the 17px box keeps its look; an invisible `::after` on the `<label>` that wraps it (the change pill's approach) is
  the 44×44 area, and the box sits above it (`z-index: 1`) so its own mousedown handling stays. **Geometry, on purpose:**
  `inset: -6.75px -10px -20.25px -17px`. Rows are 30.5px apart, so a symmetric 44px area would overlap the next row's by
  13.5px and, with the later row painted on top, hand every tap below a box to the row under it. This area is 6.75px above and 20.25px
  below, so each row's area ends where the next one's begins, halfway between the two boxes: a tap always reaches the nearest
  tick, and the last tick of a run (nothing below to share with) gets the full 44px. Left 17px is free room (the editor's side padding),
  right 10px stops where the text starts. Proven with **real clicks** (12px left of a box, 5px below it → that box; 10px below → the next
  one; 15px below the last).

### 3. Review bar (`c40c1e58`, the orchestrator's finding from G1-A's screenshots) — `ReviewBar.svelte`, `DocumentBody.svelte`

- **One row.** The message is the part that gives way (`flex: 1 1 5rem` instead of the mockup's 260px basis; it wraps onto a
  second line), the stepper buttons are the mockup's 28px (they were the app's 40px ghost buttons), and two `@container` steps on the
  **bar's own width** (a `container: review-bar / inline-size` wrapper — the column beside it decides, not the window) compact it, inside
  `@media (min-width: 481px)` so the phone layout of fix B is untouched: ≤ 40rem drops the buttons' icons; ≤ 34rem drops the position
  number and, with one pending change (nothing to step through, the arrows were disabled anyway), the whole stepper. The action buttons
  get the mockup's 5px between icon and label (the app's `.btn-sm` has none; same fix as the refusal card's).
- **Flush.** `.document-review-bar-slot` is `bottom: 0` (was 14px), and `ReviewBar` takes `docked`: flat (no radius), full width of the
  text column, a rule on top instead of the floating card's border and shadow. The comments drawer's clearance above it went 22 → 8px
  (`REVIEW_BAR_CLEARANCE_PX`). A phone keeps fix B's floating card (`.is-docked` is undone in its media query).
- **Measured, Hungarian UI, one pending change** (text column → bar): 1110×800 (480px column) 48px, one row · 1280×800 (536px) 48px ·
  1366×768 (594px) 48px · 1440×900 (645px) 48px, full layout · 1512×982 (648px) 48px. Before: 96px, two rows. Bottom edge 0px from the
  text column's (was 14px). Two pending: still one row of controls at 1110 and 1280 (the message takes two lines at 480px).

### 4. The filter survives a toggle (`12446d9a`) — `MarginPanel.svelte`, `DocumentBody.svelte`

`MarginPanel` gets controlled props `filter` + `onFilterChange` and `orphanedGroupOpen` + `onOrphanedGroupOpenChange` (callback props, not
`$bindable`: `CommentsSheet` forwards `...marginPanelProps`, and a rest-props spread cannot carry a binding back). `DocumentBody` holds
`commentFilter` / `commentOrphanedGroupOpen` and passes them to the inline column **and** to the drawer/sheet, so hiding and showing the
column, or closing and reopening the drawer or sheet, keeps Open/All and the removed-text fold. Open by default (ruling 61), per document
body, not persisted. `MarginPanel` keeps a local fallback, so it still works standalone (its 50-odd existing tests are unchanged).

### 5. Refusal Dismiss exit (`2dc5a932`, §7.2 #22) — `RefusalNotice.svelte`

Dismiss slides the card 8px right and fades it (`MOTION_DURATION.standard`, `MOTION_EASING.in`) with `reducedMotionAnimate`, then calls
`onDismiss`. Reduced motion: `onDismiss` at once, no animation ("instant"). A second tap while it leaves is ignored; a card removed under
its own exit asks nobody. Not a Svelte `out:` transition (it never finishes under the repo's jsdom animation mock, and the caller removes
the card by clearing its own state). The two older assertions that a click calls `onDismiss` synchronously now `waitFor` it (the spec
changed the behaviour: exit, then clear).

### 6. Extra, found comparing my own screenshots with the mockup (`f8bf49c8`)

Every table cell holds a real paragraph that kept the prose's `margin-bottom: 12px`: rows measured 57px (header 49px) against the
mockup's 45px (37px), content sitting high. `td > p, th > p { margin: 0 }` (a second paragraph in a cell keeps 6px). Small, and it is the
tracker table the brief asked me to compare.

## Tests

Test first for every behaviour: each e2e/unit test below was seen failing for the right reason before its fix.

- **e2e** (all measured in real Chromium; helpers in `tests/e2e/artifact-document-polish-helpers.ts`):
  `artifact-document-prose.spec.ts` (3: checklist pitch 29.5–31.5px for one-item lists and a tight list; table rows 43–47px / header 35–39px;
  chip select width ≈ its label, "Paid" narrower than "To book"), `artifact-document-touch-targets.spec.ts` (2: toolbar buttons ≥ 44×44 and row
  ≤ 48px; chip selects and tick areas ≥ 44 both ways, pill ≤ 26.5px, and the real clicks above),
  `artifact-document-review-bar.spec.ts` (+7 parametrised, Hungarian: one row, flush ≤ 1px, `elementFromPoint` on the bar's last pixel row at its
  left, middle and right, at 1280/1366/1440/1512/1110 with one change and 1280/1110 with two), `artifact-document-comments.spec.ts` (+1: Open/All
  survives hiding and showing the column), `artifact-document.spec.ts` (the live refusal test now clicks Dismiss and sees the card and its
  dashed rule go; a stale comment about the toolbar opt-out updated). The Hungarian tests reset the admin's language in `afterEach`.
- **unit**: `RefusalNotice.test.ts` +5 (keyframes/duration/easing, animates the card itself, reduced motion is instant with no animation,
  second tap ignored, unmounted mid-exit asks nobody), `MarginPanel.test.ts` +2 (caller-held filter and fold), `DocumentBody.test.ts` +2 (filter kept
  across the column toggle and across the drawer) + the docked assertion, `ReviewBar.test.ts` +2 (`is-docked`, `is-single` hooks).

## Gates

1. `npm run check`: 0 errors, 17 warnings (the pre-existing 17: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
2. `npx biome check src scripts tests`: clean (2144 files).
3. `npm test`: 897 files passed (1 skipped), **13860 tests passed** (2 skipped).
4. Playwright, `E2E_PORT=5515 npx playwright test tests/e2e/artifact*.spec.ts tests/e2e/artifacts-*.spec.ts tests/e2e/knowledge.spec.ts tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`: **125 passed, 0 failed** (6.0 min, one worker, my own server on 5515; the whole artifact family, knowledge, chat and conversation suites).
5. Fallow (`/tmp/fallow-g2b.json`): 124 issues, 4 circular dependencies = the baseline; none in a file of this round.

## Screenshots (`rd/shots/g2b/`, Hungarian; not committed) — each looked at once against the mockup

- `g2b-doc-1440x900-hu.png`, `g2b-doc-1440x900-hu-dark.png` — Document with checklist, chips, comment column and the one-row review bar.
- `g2b-doc-budget-1440x900-hu.png`, `g2b-doc-budget-390x844-hu.png` — the tracker table (chips hugging their values, 45px rows).
- `g2b-doc-390x844-hu.png` — phone: 44px toolbar, checklist, unchanged phone review bar.
- `g2b-bar-1280x800-hu.png` (536px column), `g2b-bar-1110x800-hu.png` (480px column, two changes: message on two lines, arrows only).
- Mockup references (HU, light): `mock-doc-1440-hu-light.png`, `mock-doc-budget-1440-hu-light.png`, `mock-doc-390-hu-light.png`.

## Deviations, with reasons

- **The desktop review bar is a flat docked bar, not the mockup's floating card** (the mockup floats 16px in from the sides and 14px up,
  with text visible below): the orchestrator asked for "flush with the bottom of the text column, nothing visible under it". A phone keeps
  the card.
- **Tick hit areas are 44×44 in the box but a tap's effective vertical reach in a run of rows is the row (30.5px)**: two 44px areas cannot
  both fit 30.5px apart; the split is halfway, never biased. A lone tick or the last of a run has the full 44px. Making rows 44px apart
  would have loosened every phone checklist against the mockup.
- **≤ 34rem the stepper's position number is hidden** (and the whole stepper for a single change): there is no room beside the comment
  column at 480–544px in Hungarian. It is still in the DOM, so screen readers lose nothing but the number.
- `field-sizing: content` is not everywhere yet: an engine without it shows the chip select at its longest option's width, as before.

## Concerns (not touched)

- **Phone review bar (fix B, told to stay):** it floats 64px above the panel's bottom edge, and in a long document text shows under it
  (the same complaint as the laptop one). Nothing sits in that 64px strip on the real phone shell (the toolbar is at the top); worth a look.
- The mockup strikes through and mutes a ticked item's text; the real Document only fills the box (not in the review's findings).
- Tracked throwaway specs exist in the repo: `tests/e2e/zz-capture-*.spec.ts` (5) and `zz-knowledge-polish-capture.spec.ts` — not from this
  round; they are outside gate 4's list.
- Task-list checkbox names, the chip select's accessible name and the Versions summaries are still English in the Hungarian UI (a
  separate review item, not mine).

## Hand-off — reuse these

- `ReviewBar`: prop `docked` (flat, flush, rule on top), class hooks `is-docked` / `is-single`, and the pattern of compacting by the
  component's OWN width: a `container: <name> / inline-size` host wrapper plus `@container <name> (max-width: …)` steps inside a
  `@media (min-width: 481px)` so a phone's own layout is untouched. Canvas/Slides hosts a flat bottom bar the same way (sticky, `bottom: 0`).
- `MarginPanel` / `CommentsSheet` props `filter`, `onFilterChange`, `orphanedGroupOpen`, `onOrphanedGroupOpenChange` (controlled, with a local
  fallback); `DocumentBody` owns `commentFilter` / `commentOrphanedGroupOpen`.
- `RefusalNotice` exit: the shape for any "leaves with motion, then the caller clears it" — `reducedMotionAnimate(el, keyframes, { duration, easing }).finished`,
  `prefersReducedMotion()` for the instant path, a `mounted` guard; testable in jsdom by stubbing `Element.prototype.animate`.
- Phone hit areas: `::after` with `inset` asymmetric toward free room for stacked rows (the tick); `min-height: 44px` with equal negative
  margins for an inline control that must not grow its line (the chip select).
- E2E helpers `tests/e2e/artifact-document-polish-helpers.ts`: `seedDocument({ markdown, title, pendingOps })` (real services, optional pending Alfy
  patch), `openDocument(page, conversationId)` (desktop shell by class, so it works in Hungarian), `box`, `tapArea` (own box grown by its
  `::after`, both axes), `setUiLanguage`, `PROSE_MARKDOWN`.
- `app.css`: the `.mobile-toolbar .btn-icon-bare` 36px opt-out is deleted; do not bring it back.
