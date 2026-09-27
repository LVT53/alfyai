# Agent 1 · Foundation — report

Branch `feat/artifacts-rd1-foundation`, from `feat/artifacts` `87f5ee5d`.
Commit range: `87f5ee5d..988ab94e` (8 commits, worktree clean, nothing left uncommitted).

```
473cc2bb feat(tokens): add Wave 2.5 redesign color and motion tokens (§9.1)
f289d5de feat(motion): add reducedMotionAnimate WAAPI helper (§7.2/§7.3)
70d74f18 fix(artifacts): replace undefined .btn-text with real button classes
b7211988 fix(artifacts): replace undefined --status-* tokens with real ones
832113ec feat(document): style document prose typography (§1, §2.3, mockup .prose)
b2e899f6 feat(document): give the Alfy change mark a visible style and arrive animation
1b6ac207 fix(a11y): raise btn-primary text contrast via --accent-text
988ab94e style: satisfy biome formatting in motion.ts
```

## Step 1 · Tokens and motion helpers

1. **Tokens** (`src/app.css`, `tailwind.config.ts`) — added every §9.1 token to both
   `:root` and `.dark`: `--ease-emphasis`, `--ease-in`, `--duration-settle` (shared, declared
   once since the table marks them "same" in both themes — mirrors how the mockup itself
   declares them once); `--accent-text`, `--accent-fill`, `--on-accent`, `--accent-tint`,
   `--accent-tint-strong` (the last two also declared once — they're pure `color-mix(...,
   var(--accent) N%, ...)` expressions with an identical percentage in both themes, so they
   already resolve correctly against whichever `--accent` cascades, exactly as the mockup's
   own `:root`/dark blocks do); `--alfy-mark`/`--alfy-mark-arrive` (derived from
   `var(--accent)`, different % per theme, so these ARE redeclared in `.dark`);
   `--comment-mark`/`--comment-mark-active` (derived from `var(--caution)` — §2.2 calls the
   comment tone "`--caution`-based", so these reference it rather than duplicating amber's
   literal hex); `--comment-rule`, `--warning-text`, `--warning-tint`, `--success-text`,
   `--success-tint` (tints derived from the existing `--warning`/`--success`, which already
   matched §9.1's expected base values in both themes). `color-scheme: light`/`dark` set on
   the two roots.
2. Mapped into `tailwind.config.ts` only the tokens that fit the codebase's existing
   Tailwind-utility pattern (`text-danger`, `text-accent`, etc. are genuinely used elsewhere,
   e.g. `DocumentPreviewRenderer.svelte`, `ProjectItem.svelte`) — `accent.text/fill/tint/
   tintStrong`, `on-accent`, `warning.{DEFAULT,hover,text,tint}`, `success.{text,tint}` (added
   to the existing `success`/`danger` blocks), and `duration.settle`/`700`. Deliberately did
   **not** add a `transitionTimingFunction` entry for `ease-emphasis`/`ease-in` — nothing in
   this codebase drives easing through a Tailwind utility class today (every existing
   `transition`/`animation` reads `var(--ease-*)` directly in a `<style>` block), so a Tailwind
   mapping would sit unused.
3. **WAAPI helper** — `reducedMotionAnimate(element, keyframes, options)` in
   `src/lib/utils/motion.ts`, beside `prefersReducedMotion`/`reducedMotionAware`. Runs
   `element.animate(...)`; under reduced motion (or an empty `keyframes` array) it skips the
   animation and applies the last keyframe's own properties directly to `element.style`
   instead (§7.3: "jump to the final state"). Returns `{ finished: Promise<void>, cancel()
   }` on **both** paths — `finished` resolves immediately under reduced motion or when the
   real `Animation.finished` settles otherwise, and never rejects (a `cancel()`-triggered
   rejection is swallowed) — so a caller can `await result.finished` the same way regardless
   of the user's motion preference. `MOTION_DURATION`/`MOTION_EASING` are exported JS-side
   mirrors of the four duration / three easing tokens, since WAAPI's `duration`/`easing`
   options take plain numbers/strings, not `var(...)` references. Not for loops (§7.2
   #10/#25/#30 — those stay plain CSS `animation: … infinite`, already collapsed by app.css's
   existing global reduced-motion override).
   - `jsdom` (this repo's `vitest` environment) has no `Element.prototype.animate` at all —
     confirmed empirically before writing the "normal motion" tests, which stub `el.animate`
     themselves (a standard, explicit mock, not a workaround for a bug). The reduced-motion
     path needs no such stub, since it never calls `element.animate`.
4. **`.btn-text`** — its only three users (`CommentCard.svelte`'s Reply/Resolve/Reopen) are
   now `btn-ghost btn-sm`, per §2.1's tertiary-action row. Removed the now-dead
   `.comment-card-actions .btn-text` override rule. No icons added — §2.1 wants icons on
   these, but the brief scoped this step to "make these real buttons", and a later agent
   redesigns the card's full anatomy anyway.
5. **`--status-*`** — `grep -rn "var(--status-" src` now finds nothing.
   `MarginPanel.svelte`'s `.margin-panel-tone-warning` → `--warning-text`/`--warning-tint`;
   `CommentThread.svelte`/`DownloadSheet.svelte`/`VersionsSheet.svelte`'s error text →
   `--danger` (no new `--danger-text` token — not in §9.1's table, and the brief offered
   `--danger` as one of two acceptable choices).
6. **`btn-primary` contrast** — separate commit. `color: var(--accent)` → `var(--accent-text)`
   (3.5:1 on the 12% tint in light → clears 4.5:1 everywhere). Verified visually on a
   non-artifact screen (Settings' "Save changes" button, `rd1-btn-primary-settings-save.png`)
   — unchanged shape/weight, only the label hue shifted.
7. **Contrast test** — `src/lib/components/artifact-color-contrast.test.ts`, same technique
   as the existing `checkbox-tick-contrast.test.ts` (parses solid hex tokens straight out of
   `app.css`, recomputes WCAG contrast, no trust in the spec table's own numbers). Pins
   `--accent-text`/`--warning-text`/`--success-text` ≥ 4.5:1 against `--surface-page`, and
   `--on-accent` ≥ 4.5:1 against `--accent-fill`, in both themes (9 assertions total,
   including a "the raw `--accent` is still under 4.5:1" pin for why `--accent-text` exists).
   Computed ratios: accent-text 5.43/7.16, on-accent 5.03/6.02, warning-text 6.50/9.28,
   success-text 6.82/9.99 (light/dark) — all comfortably clear the bar.

## Step 2 · Document prose and marks

1. **Prose typography** (`DocumentBody.svelte`'s `<style>`) — serif body (16px/1.72, 62ch),
   sans headings (h1 24px/h2 20px/h3 16px matching the mockup exactly, h4–6 given a smaller
   tier since the mockup doesn't cover them but "sans headings" is a general rule), lists,
   blockquote, inline/block code. Inline task items: `ul[data-type="taskList"]`/
   `li[data-type="taskItem"]` (Tiptap's real DOM — no class of its own, unlike the mockup's
   `.tasks`/`.task`), `display: flex` on the row is the literal fix for "every checkbox sits
   on its own line above its label"; the checkbox itself gets `accent-color: var(--accent)`
   rather than reimplementing the app's `.custom-checkbox` SVG-tick system (that class isn't
   on Tiptap's plain `<input>`, and adding it would mean editing `extensions.ts`'s node
   markup, out of this step's "do not restructure markup" boundary). Tracker table: real DOM
   has no wrapper div (`TableKit.configure({ table: { resizable: false } })` leaves
   `renderWrapper` at its default `false`), so the border/radius/overflow-hidden lands on
   `table` directly rather than the mockup's `.doc-table-wrap`; verified this actually clips
   correctly in Chromium via screenshot. Tracker chip: pill background/text keyed off the
   node's own `data-chip-value` attribute (`"To book"`/`"Cancelled"` → warning tone, `"Booked"`/
   `"Paid"` → success tone — **my own tone mapping, not spec'd anywhere**; flagging as a
   judgement call below), a date chip (`data-chip-kind="date"`) as a plain bordered pill, and
   the underlying `<select>` de-styled to inherit the pill's own colors. No chevron/caret
   icon on the select — would need a Lucide icon injected through `extensions.ts`'s
   `renderHTML`/`addNodeView`, which is markup, not styling.
   - Every rule is written `.document-editor-host :global(.document-content h2)` — i.e. the
     **whole** descendant selector inside one `:global(...)` call, not
     `:global(.document-content) h2`. Tiptap injects `.document-content`'s children (h2, p,
     table, …) outside Svelte's own compiled markup, so they never carry this component's
     scoping hash; closing `:global()` early and continuing with a bare combinator would
     silently match nothing (confirmed by reading Svelte's own scoping semantics, not
     assumed).
   - No `.dark`-specific rules needed anywhere in this block — every value is a token
     reference, so both themes come free. Confirmed in the dark screenshot.
2. **`.alfy-change` mark** (`marks.ts` + `DocumentBody.svelte`) — visible now: `--alfy-mark`
   tint plus a 2px `--accent` underline (`box-shadow: inset 0 -2px 0 var(--accent)`).
   `renderHTML` now always emits `class="alfy-change arrive"` (not conditionally) — safe
   because ProseMirror only reconstructs a mark's DOM node when it's first created or
   otherwise dirtied (confirmed by reading how `applyAlfyChangeMarks` creates marks and how
   `keepAlfyChange`/`undoAlfyChange` remove them — nothing re-renders an untouched mark's
   span later), so in practice the CSS `@keyframes` settle animation plays once, right when
   the change lands, and the element then just sits at its resting `.alfy-change` appearance.
   `AlfyChange` deliberately has no markdown serialization (marks.ts's own header comment),
   so this is purely a DOM/view-layer change — no round-trip risk. Reduced motion needed no
   new rule: app.css's existing global `animation-duration: 0.01ms !important` override
   already collapses this `@keyframes` animation like any other.
   - New test in `marks.test.ts` asserting both classes are present on a freshly-applied mark.
3. **Comment-anchor highlight** — `.comment-anchor`/`.comment-anchor.is-active`/
   `.comment-anchor.is-resolved`, using `--comment-mark`/`--comment-mark-active`/
   `--comment-rule`. **These classes are not applied to anything in the DOM today** — I
   searched `extensions.ts`, `document-editor.ts`, `MarginPanel.svelte`, `CommentThread.svelte`
   and every file `git grep`-adjacent to "comment"/"anchor"/"Decoration" and found no
   comment-anchor decoration or plugin anywhere in the codebase; `MarginPanel.svelte`'s quote
   renders only inside its own margin card (`<blockquote class="margin-panel-quote">`), never
   inside the document text. The brief's step 2.3 calls these "the existing comment-anchor
   decoration's classes", but nothing existing produces them — see Deviations below. I named
   and styled a class family agent 3 can apply the moment it builds the decoration, matching
   the mockup's `.c-anchor`/`.is-active`/`.is-resolved` shape under this codebase's own naming
   convention (`comment-anchor`, matching `alfy-change`'s kebab-case-of-the-concept style).

## Tests added

- `src/lib/components/artifact-color-contrast.test.ts` — new file, 9 tests.
- `src/lib/utils/motion.test.ts` — 7 new tests (`reducedMotionAnimate` both paths + fill-mode
  default/override + never-rejects + the `MOTION_DURATION`/`MOTION_EASING` value pin).
- `src/lib/components/artifacts/document/marks.test.ts` — 1 new test (arrive class).
- No changes needed to `extensions.test.ts` (no decoration/class names changed there) or to
  any `CommentCard.test.ts`/`MarginPanel.test.ts`/etc. behavior test (all query by role/text/
  attribute, never by the classes I changed).

## Gates (all run at the end, in this worktree, nothing left running)

1. `npm run check` — **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6,
   `RouteItinerary` 1) — exactly the stated pre-existing baseline, no new warning.
2. `npx biome check src scripts tests` — **clean** (one formatting issue in `motion.ts` on
   the first run, fixed with `biome check --write` and committed separately).
3. `npm test` — **891 files passed, 1 skipped; 13,475 tests passed, 2 skipped; 0 failed.**
4. `E2E_PORT=5400 npx playwright test tests/e2e/artifact-document.spec.ts
   tests/e2e/artifact-document-comments.spec.ts
   tests/e2e/artifact-document-selection-bubble.spec.ts tests/e2e/artifacts-panel.spec.ts` —
   **27/27 passed** (1.2 min).
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd1.json` —
   **`total_issues: 124`, `circular_dependencies: 4`** — exactly the stated baseline, verified
   both as the top-level count and by walking the full JSON for entries under my changed
   files in `unused_exports`/`unused_types`/`unused_class_members`/`duplicate_exports`/
   `unused_files` (none found — the file-path hits I first saw were all in the separate
   `health` scoring section, which isn't the "issues" count the baseline/gate refers to).

## Screenshots (Hungarian UI)

All in `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/shots/rd1/`, not committed:

- `rd1-document-1440-light-hu.png` — 1440×900, light.
- `rd1-document-1440-dark-hu.png` — 1440×900, dark.
- `rd1-document-390-light-hu.png` — 390×844, light.
- `rd1-btn-primary-settings-save.png` — the step-1.6 non-artifact `btn-primary` check
  (Settings → "Változások mentése").

Seeded via a throwaway Playwright spec (`tests/e2e/_capture-rd1.spec.ts`, real seeding through
`createDocumentArtifact`/`createComment` — the same server-side helpers `artifact-document*.spec.ts`
use, not a hand-rolled DB insert), run with `E2E_PORT=5400`, then **deleted** before finishing
(never committed; `git status` is clean). It seeded one document with both heading levels, a
task list (checked + 2 unchecked), the tracker table (a "To book"/warning chip, two "Paid"/
"Booked"/success chips, a date chip), a blockquote and a code block, plus one real seeded
comment on "confirm the flight". The Alfy-change mark and the comment-anchor highlight have no
live trigger yet (see above), so the script paints a `span.alfy-change.arrive` and a
`span.comment-anchor` directly into the rendered DOM via `page.evaluate` purely to produce an
accurate visual of the CSS — this never touched ProseMirror's own state, so it's screenshot-only,
not a claim that either is wired up.

All three Document screenshots matched the mockup's `.prose` page closely: serif body, sans
bold headings at the right sizes, checkboxes inline with their labels, the tracker table
bordered with the right pill tones per status, the date chip as a plain bordered pill, both
marks visibly tinted, dark theme fully consistent with no separate dark-mode CSS needed.

## Deviations from the spec, with reasons

- **Comment-anchor decoration doesn't exist yet** (see Step 2.3 above) — the brief describes
  applying styles to "the existing comment-anchor decoration's classes", but there is no such
  decoration in the current codebase. I added the CSS classes only, named for agent 3 to wire
  up; I did not add a ProseMirror decoration/plugin myself, since "Only the styles... belong to
  agent 3" scopes the click/active/rail behavior away from this step, and building the
  decoration mechanism itself felt like more than "styles."
- **Tracker chip tone mapping is my own call**: `"To book"`/`"Cancelled"` → warning,
  `"Booked"`/`"Paid"` → success. §9.1/§2.1 don't specify a mapping for the 4th status value
  (`"Cancelled"`); I grouped it with warning (needs attention) rather than inventing a third,
  unspec'd tone. Easy to change in one place (`DocumentBody.svelte`'s
  `.tracker-chip[data-chip-value=...]` rules) if agent 2–5 or the reviewer disagrees.
- **h1/h4–h6 sizes are my own choice** — the mockup's `.prose` only styles h2 (20px) and h3
  (16px), which I matched exactly. "sans headings" in the brief reads as a general rule, so I
  extended the same treatment to h1 (24px) and h4–6 (14px, one tier below h3) rather than
  leaving them serif/unstyled; these three sizes aren't pinned against any mockup screenshot.
- **No chevron/caret decoration on the status chip select** and **no icon on the date chip** —
  both present in the mockup's static markup but not reachable from CSS alone without adding
  a Lucide icon through `extensions.ts`'s node `renderHTML`/`addNodeView`, which is markup,
  not styling, and out of this step's boundary.
- **Checkbox touch-target size on phones**: kept the mockup's exact 17×17px box / 4px row
  padding (pixel-matched the mockup rather than inflating the hit area with a hit-slop
  pseudo-element), since enlarging it risked mis-taps between adjacent rows at this density
  and wasn't covered by a concrete test. Flagging this as a real, deliberate gap against the
  brief's general "44px touch targets on phones" a11y note — worth a look whenever a later
  agent does a full a11y pass over this surface.
- Did **not** add `transitionTimingFunction` entries to `tailwind.config.ts` for
  `ease-emphasis`/`ease-in` — no existing Tailwind-utility usage pattern for easing in this
  codebase to extend (see Step 1.2 above).

## Hand-off — reuse these

**Tokens** (`src/app.css`, both themes unless noted): `--duration-settle` (700ms, shared),
`--ease-emphasis`/`--ease-in` (shared), `--accent-text`, `--accent-fill`/`--on-accent`,
`--accent-tint`/`--accent-tint-strong` (shared, don't redeclare per-theme — see Step 1.1),
`--alfy-mark`/`--alfy-mark-arrive`, `--comment-mark`/`--comment-mark-active`/`--comment-rule`,
`--warning-text`/`--warning-tint`, `--success-text`/`--success-tint`. Tailwind utilities for
the subset listed in Step 1.2 (`text-accent-text`, `bg-accent-tint`, `bg-warning-tint`
text-warning-text`, etc., plus `duration-settle`/`duration-700`).

**Motion helper** (`src/lib/utils/motion.ts`): `reducedMotionAnimate(element, keyframes,
options)` for every one-shot animation in §7.2 (list↔item push, panel open/close, staggered
card arrivals, a settle/flash) — pass `MOTION_DURATION.<name>`/`MOTION_EASING.<name>` for
`options.duration`/`options.easing`, get back `{ finished, cancel }` uniformly regardless of
the user's motion preference. Don't use it for loops (writing/shimmer states) — those stay
plain CSS `animation: … infinite`, already covered by app.css's existing reduced-motion
override.

**Classes or components to reuse**:
- `btn-ghost btn-sm` — the real tertiary-button classes (`CommentCard.svelte`'s Reply/
  Resolve/Reopen already use them; add icons there per §2.1 when redesigning that card).
- `.alfy-change` / `.alfy-change.arrive` (`marks.ts`, styled in `DocumentBody.svelte`) — the
  mark itself; don't add a second visual treatment for "an Alfy change" anywhere else.
- `.comment-anchor` / `.comment-anchor.is-active` / `.comment-anchor.is-resolved` — styled,
  **unwired**. Agent 3: apply these via whatever decoration mechanism you build (a
  ProseMirror plugin returning `Decoration.inline(...)` per resolved anchor is the natural
  fit, parallel to how `AlfyChange` is a Mark) and wire click → thread / hover ↔ card both
  ways. The styles already handle resting/active/resolved; you shouldn't need new CSS for the
  base states, only for whatever transition/motion §7.2 #16/#17 add on top (reach for
  `reducedMotionAnimate` for the flash-on-click).
- The prose block in `DocumentBody.svelte` (search `Artifacts redesign §1/§2.3/§9.2, Step
  2.1` for the whole block) is the one place document-content typography lives — don't add a
  second `.document-content` styling location. Every selector pattern is
  `.document-editor-host :global(.document-content <selector>)`; copy that shape exactly for
  any further Tiptap-rendered-DOM styling (closing `:global()` early silently matches
  nothing).

**Contrast test pattern**: `src/lib/components/artifact-color-contrast.test.ts` mirrors
`checkbox-tick-contrast.test.ts`'s `themeBlock`/`tokenValue`/`relativeLuminance`/
`contrastRatio` helpers. Reuse this shape rather than re-deriving WCAG math if a later agent
adds another text-on-surface pairing that needs pinning.
