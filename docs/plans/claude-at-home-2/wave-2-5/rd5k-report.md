# Agent 5k · Knowledge chips (redesign step 14) — report

Worktree: `.claude/worktrees/art-rd5k`, branch `feat/artifacts-rd5k-chips`.
Commit range: `0581ba24..d437beaa` (base `0581ba24` = agent 5a's merge point).

- `99129148` feat(knowledge): redesign Step 14 — chip disable, All-files chip, one count source
- `d437beaa` fix(test): disambiguate "No documents" e2e queries from the new chip reason

## What changed, and where

Target file (per the spec's §9.2 row): `src/routes/(app)/knowledge/_components/DocumentsList.svelte`.
One touch outside it was required by the "one count source" bullet: `src/routes/(app)/knowledge/+page.svelte`.

### 1. Zero-count chips dimmed and disabled with a reason (§6.2/§6.4)

In `DocumentsList.svelte`'s top chip row (`DOCUMENT_TYPE_FILTER_ORDER` loop): a chip whose
`chipCount(filter) === 0` now renders `disabled`, gets a dashed/50%-opacity look
(`.documents-filter-chip:disabled` in the `<style>` block), and carries its reason both in
`title` and via `aria-describedby` pointing at a visually-hidden (`.sr-only`) sibling span, so
a screen-reader user gets the same sentence a sighted hover would. Six new i18n keys,
`knowledge.documents.filter.emptyReason.{all,document,canvas,app,slides,uploaded}`, EN+HU
(`src/lib/i18n/knowledge.ts`); the `canvas` text matches the spec's own example verbatim ("No
canvases yet").

`disabled` alone doesn't stop a *synthetically dispatched* click (only real, hit-tested pointer
input) — confirmed by a failing vitest assertion until I added an explicit `!isZero` guard in
the chip's `onclick` too. Comment left in place explaining why both exist.

New function `chipEmptyReasonKey(filter)` beside the existing `chipLabelKey`.

### 2. File-type row attached to Files with an "All files" chip (ruling 60)

Added a leading "All files" chip inside `documents-file-family-chips`
(`knowledge.documents.fileFamily.all`, EN "All files" / HU "Minden fájl" — the exact HU text
ruling 60/§6.5 gives), counted from `countsByKind?.uploaded` (the same number the top-level
Files chip already shows, so it can never disagree with it), active when `!fileFamilyFilter`,
`onclick` calls `onFileFamilyFilterChange?.(null)` directly. The seven-family enumeration
itself (`FILE_FAMILY_ORDER` / `FileFamily` in `src/lib/shared/file-types/index.ts`) and the
"hide a zero family, don't dim it" rule were already correct and pre-existing — ruling 60's own
text ("zero families hidden") matches what was already built; I only added the missing "All
files" chip in front of it.

`knowledge.test.ts`'s `fileFamilyKeys.length` assertion updated 8 → 9 (the new `.all` key);
comment updated to match.

### 3. Reveal animation (§7.2 #32, reduced path per §7.3)

Pure CSS: a `documents-file-family-reveal` `@keyframes` (fade + 4px rise) on
`.documents-filter-chips-secondary`, using the existing `--duration-emphasis`/`--ease-emphasis`
tokens. No JS, no `reducedMotionAnimate` — `app.css` already collapses every `animation` to
0.01ms under `prefers-reduced-motion: reduce` (confirmed in `app.css` lines 442-450), so that
global rule *is* this row's whole §7.3 path, for free, with nothing to unit-test.

**Deviation, with reason**: I did not implement the spec's per-chip 20ms stagger or the
animated *collapse* (only the reveal-on-mount is animated; leaving Files removes the row
instantly, as before). A Svelte `out:` transition would keep the element in the DOM past the
`{#if}` boundary until the outro finishes, which several existing synchronous
`not.toBeInTheDocument()` assertions (both vitest and the live e2e spec) depend on not
happening — the risk/complexity didn't seem worth it for a static screenshot deliverable, since
a transient stagger/collapse can't be seen in a still frame anyway. Flagging this explicitly in
case a later motion-focused pass wants the full fidelity.

### 4. One count source

`+page.svelte` had a second, disagreeing counter: a pill beside the "Documents" `<h2>` reading
`knowledge.documentCount` with `documentTotalItems` — the *current, filtered* total — right next
to `DocumentsList`'s own summary line, which always shows the *unfiltered* per-kind totals. That
pill is exactly the spec's problem #3 ("the eyebrow pill that disagreed goes" — §6.2). Removed
the pill and the now-dead `knowledge.documentCount` key (EN+HU; confirmed unused anywhere else
first). The heading stays, naming the section only. `documentTotalItems` itself is still used
(feeds `DocumentsList`'s `totalDocuments` prop for pagination) — not touched.

### 5. ICU plurals for the summary, and the "N uploaded" wording

`knowledge.documents.count.{uploaded,document,app}` now use the ICU `{count, plural, one {…}
other {…}}` form already established elsewhere (`artifacts.ts`). `canvas`/`slides` were **left
un-pluralized on purpose**: the app already labels a single item of either kind "Canvas"/"Slides"
(`artifacts.type.canvas`/`.slides`), so "1 canvas"/"1 slides" is the existing, correct,
invariant-noun convention, not the bug the spec's "1 apps" example names — only `app` (and
`document`, same bug class, just not the example given) needed the fix. Hungarian is unchanged
beyond the wording swap below: it doesn't inflect nouns after a numeral, matching the file's own
prior convention.

The open question ("N uploaded" vs the mockup's own wording): the mockup's §6.2 example spells
it **"8 files"**, so I followed the spec — reworded `count.uploaded` from "{count} uploaded" to
"{count} file(s)" (EN) / "{count} fájl" (HU, unchanged text, since "fájl" was already right).
I did *not* adopt the mockup's other summary-line change (a leading "11 items ·" total with
comma-separated buckets) — that's a bigger format change the brief's four bullets don't name,
and I judged it out of this step's scope. Note for whoever picks this up: `knowledge.documents.totalLabel`
("{count} items"/"{count} elem") already exists in both dictionaries but is **unused anywhere in
the codebase** — looks like scaffolding for exactly that leading-total format, left by an earlier
slice and never wired up. I left it alone (not mine to add or remove) but flag it here.

## Tests

`src/routes/(app)/knowledge/_components/DocumentsList.test.ts` (vitest + testing-library):
- Updated "renders a chip at 0" → also asserts `disabled`, `title`, `aria-describedby` → a
  real `.sr-only` node with the reason text; added a sibling non-zero-chip assertion.
- New: "does not fire onTypeFilterChange when a disabled zero chip is clicked".
- Bumped one unrelated test's `canvas: 0` → `canvas: 2` (it exercises click/`aria-pressed`
  wiring generically, not the zero-disable behaviour — zero would now make its own click
  no-op).
- File-family row: updated the "one chip per non-zero family" expectation to include the
  leading "All files 13"; added two new tests ("All files" shown/active by default;
  clicking it fires `onFileFamilyFilterChange(null)` and its own `aria-pressed` flips).
- Summary line: reworded the two existing assertions "N uploaded" → "N files"; added a new
  "uses the singular noun for a count of exactly one" test (the spec's own "1 app" example).
- Two pre-existing "Empty State" tests broke on a **loose** `/no documents/i` query (jsdom +
  testing-library's `getByText` *is* exact-by-default, but a plain string still needs the
  literal empty-state text vs. the new "No documents yet" reason span) — switched to the exact
  string.

`src/lib/i18n/knowledge.test.ts`: `fileFamilyKeys.length` 8 → 9 (see §2 above).

`tests/e2e/knowledge.spec.ts`: four assertions (`getByText("No documents")`/`.../(/No
documents/)`, at what are now lines 31, 91, 194, 226) needed `{ exact: true }` — **Playwright's**
`getByText` substring-matches a plain string by default (unlike `@testing-library/dom`), so even
the exact-string calls were ambiguous against the new "No documents yet" reason once it existed
live in the DOM. This is why `npm test` was green before the live e2e gate caught it — two
different libraries, two different default matching rules, same string.

Ran `DocumentsList.test.ts` + `knowledge.test.ts` alone first (RED, 9 failures, all expected),
then implemented, then GREEN. `knowledge.spec.ts` was run twice: once revealing the 4
Playwright-matcher collisions above, once green after the fix.

## Gates (run once each, at the end, this worktree)

1. `npm run check` — **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6,
   `RouteItinerary` 1) — exactly the pre-existing baseline, no new warning.
2. `npx biome check src scripts tests` — clean, "Checked 2129 files… No fixes applied."
3. `npm test` — **13537 passed, 2 skipped** (893 files: 892 passed, 1 skipped) — 0 failed.
4. `E2E_PORT=5448 npx playwright test tests/e2e/knowledge.spec.ts` — **14 passed**.
5. `npx fallow --no-cache --format json --quiet --score --output-file /tmp/fallow-rd5k.json` —
   `check.total_issues = 124`, `check.circular_dependencies = 4` — **exactly the baseline, zero
   new findings** (also grepped every finding category for the five files I touched — no hits
   at all).

All five green.

## Screenshots

Knowledge → Documents, Files chosen, Hungarian, light. Both in
`.../scratchpad/rd/shots/rd5k/`, **not committed**:

- `rd5k-knowledge-files-1440-light-hu.png` — 1440×900. Summary line "5 fájl · 1 dokumentum"
  (correct singular, no "1 dokumentumok"). Kind row: zero chips (Táblák 0, Alkalmazások 0,
  Diasorok 0) visibly dimmed/dashed next to the two live ones. File-type row: "Minden fájl 5"
  leads, filled/active, followed by PDF 1 · Word 1 · Táblázatok 1 · Képek 1 · Szöveg és
  Markdown 1.
- `rd5k-knowledge-files-390-light-hu.png` — 390×844. Both chip rows wrap onto more lines as
  expected. I separately re-verified (both a `scrollWidth`/`clientWidth` check I added to the
  capture script, and the pre-existing English-language e2e assertion at the same viewport) that
  the page does **not** horizontally scroll at this width with this data — a chip near the right
  edge (Alkalmazások 0) reads slightly clipped in the PNG, but that row's own wrap layout
  predates this step (Slice 7) and isn't one of the four things Step 14 owns; noting it here in
  case it's a real cosmetic issue worth a closer look, since I didn't chase it further.

Seeded via a throwaway `tests/e2e/_capture-rd5k.spec.ts` (real DB rows through the same
`db.insert(artifacts/conversations)` shape `knowledge.spec.ts`'s own file-family test uses — one
`document`-kind artifact plus five Files-bucket rows across five families; Canvas/Apps/Slides
left at zero on purpose to capture the disabled state), language switched through the real
Settings → Interface language control (localStorage alone doesn't work — the server-rendered
preference always wins over it in `stores/settings.ts`'s `initSettings`), run with
`E2E_PORT=5448`, then **deleted** before finishing; `git status` is clean.

## Deviations from the spec, with reasons

- No per-chip 20ms stagger, no animated collapse on the file-family row — see §3 above.
- Kept the summary line's existing dot-joined "N bucket · N bucket…" shape rather than adopting
  the mockup's "N items · A, B, C" lead-in+comma format — out of the four named bullets; see §5.
- `canvas`/`slides` summary counts stay un-pluralized — a deliberate reading of "correct
  plurals," not an oversight; see §5.

## Hand-off — reuse these

- `chipEmptyReasonKey(filter)` / `knowledge.documents.filter.emptyReason.*` — the pattern for
  "disabled chip with a reason in `title` + `aria-describedby`," if another chip-style control
  in the app needs the same treatment.
- `documents-file-family-reveal` `@keyframes` on `.documents-filter-chips-secondary` — a
  template for a "reveal on mount, no JS" motion that rides the global
  `prefers-reduced-motion` CSS override for free; reach for this shape before reaching for
  `reducedMotionAnimate` when the animation is a simple one-shot tied to element mount/unmount
  rather than to app state a caller branches on.
- `knowledge.documents.totalLabel` (EN "{count} items" / HU "{count} elem") exists, EN+HU, and
  is unused — see §5's note. Whoever next touches this summary line should either wire it in
  (matching the mockup's leading total) or remove it; I left it as found.
