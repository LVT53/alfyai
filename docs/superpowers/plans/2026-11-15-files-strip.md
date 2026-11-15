# Nextcloud Files Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wall of file cards with one strip of 78px pictures and a chevron: a picture opens the viewer, the chevron opens a compact list, and a long name truncates instead of widening anything.

**Architecture:** A new pure module picks the tiles and the count tile; a new `FilesStrip.svelte` block draws them and hosts the existing lazy `ImageLightbox`; `MessageBubble` renders that block in the `message-deliverables` area instead of routing the files call through `ToolActivityRow`. The card payload gains `viewUrl` (a 1600px preview) and the preview route accepts that size. The reply-level "N more" line goes away, because the count tile says it.

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Vitest, Playwright, the AI SDK tool boundary, Nextcloud preview API.

**Spec:** `docs/superpowers/specs/2026-11-15-nextcloud-file-cards-compact-design.md`

## Global Constraints

- Svelte 5 runes only: `$props()`, `$state()`, `$derived()`, `onclick`. No `on:`, no `<slot>`, no `createEventDispatcher`.
- Every new user-facing string in BOTH `en` and `hu` in `src/lib/i18n/chat.ts`; the dictionaries stay key-identical.
- Icons from `@lucide/svelte`. No hand-written inline `<svg>`.
- No interactive element inside another: a tile is a `<button>`, a list row is one `<a>`.
- The viewer loads only through `image-lightbox-loader.ts`; `npm run check:image-viewer-chunks` must stay green.
- No new dependencies, no new table, no migration.
- `npm run check` at 0 errors / 0 warnings; `npm run build` with zero warnings.
- Never run `npm run check` or `npm test` while `npm run build` runs.
- Node 22: prefix every command with `PATH=/opt/homebrew/opt/node@22/bin:$PATH`.

## Review Focus

1. A message stored before this change has no `viewUrl`: its tiles must still draw, open the viewer at `previewUrl`, and never throw. `viewUrl` is optional and read as `?? null`.
2. A very long file name (Hungarian, 120+ characters) must truncate in the single card and in every list row, at 360px, with the full name on the tooltip and in the accessible name — and must not widen the box (the text block needs `min-width: 0`).
3. No nested controls: the list row is one `<a>` including its 40px picture; the strip tile is a `<button>`; neither contains the other's kind.
4. A call whose results are all documents draws the quiet line and no strip; a call with pictures but no room draws the count tile.
5. Several `files` calls in one reply still cap at six cards in total; a row's `+N` and the quiet line's count are computed from that row's capped cards and are never negative or larger than what exists.
6. The viewer opens at the clicked picture and moves between that call's pictures; Escape closes it and focus returns to the tile.

---

### Task 1: A viewer-sized preview on the card

**Files:**
- Modify: `src/lib/server/services/messages-types.ts` (`ToolCallFileCard`, ~line 170)
- Modify: `src/lib/server/services/normal-chat-tools/files.ts` (`previewUrlForConn`, `buildFilesCards`, the size constant)
- Modify: `src/routes/api/connections/nextcloud/preview/+server.ts` (`PREVIEW_SIZES`)
- Test: `src/lib/server/services/normal-chat-tools/files.test.ts`, `src/routes/api/connections/nextcloud/preview/preview.test.ts`

**Interfaces:**
- Produces: `ToolCallFileCard.viewUrl?: string | null`; `FILE_VIEW_SIZE = 1600`; the route accepts `size=1600`.

- [ ] **Step 1: Write the failing tests**

In `files.test.ts`, beside the existing preview assertions:

```ts
it("gives an image a viewer-sized preview beside the card one", () => {
	const card = /* the first card of a Nextcloud image search */;
	expect(card.viewUrl).toBe(
		"/api/connections/nextcloud/preview?connectionId=conn-1&fileId=42&size=1600",
	);
	expect(card.previewUrl).toContain("size=192");
});

it("gives a document no viewer", () => {
	// a PDF result: viewUrl is null
});
```

In `preview.test.ts`: `size=1600` answers with bytes (same headers as 192), and `size=800` is still a 400.

- [ ] **Step 2: Run them and watch them fail**

`PATH=/opt/homebrew/opt/node@22/bin:$PATH npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts src/routes/api/connections/nextcloud/preview/preview.test.ts`

- [ ] **Step 3: Implement**

- `ToolCallFileCard`: `viewUrl?: string | null` with a comment saying older stored cards have none and readers fall back to `previewUrl`.
- `files.ts`: `export const FILE_VIEW_SIZE = 1600;` beside `FILE_PREVIEW_SIZE`; one builder `previewUrlForConn(conn, fileId, path, size)` used for both sizes, or a sibling `viewUrlForConn` that calls it — do not duplicate the URL string.
- `buildFilesCards` sets `viewUrl` for exactly the cards `previewUrl` is set for, and `null` otherwise.
- The route's `PREVIEW_SIZES` gains `"1600"`; the comment above it explains the three sizes (96 card row, 192 card picture, 1600 viewer).

- [ ] **Step 4: Run them**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/server/services/messages-types.ts src/lib/server/services/normal-chat-tools/files.ts src/routes/api/connections/nextcloud/preview
git commit -m "feat(files): carry a viewer-sized preview on the card"
```

---

### Task 2: The tile-selection module

**Files:**
- Create: `src/lib/components/chat/files-strip-view.ts`
- Test: `src/lib/components/chat/files-strip-view.test.ts`

**Interfaces:**
- Consumes: `ToolCallFileCard` (Task 1).
- Produces:

```ts
export const STRIP_SLOTS_WIDE = 4;
export const STRIP_SLOTS_NARROW = 3;
export type FilesStripTile =
	| { kind: "picture"; card: ToolCallFileCard; pictureIndex: number }
	| { kind: "count"; hidden: number; cover: string | null; pictureIndex: number };
export function filesStripTiles(cards: ToolCallFileCard[], slots: number): FilesStripTile[];
export function stripPictureCards(cards: ToolCallFileCard[]): ToolCallFileCard[];
```

- [ ] **Step 1: Write the failing tests**

Cases, each a `it`:

```ts
it("draws every picture when they fit the slots") // 3 pictures, 4 slots → 3 picture tiles, no count tile
it("counts the pictures it leaves out") // 6 pictures, 4 slots → 3 picture tiles + { kind: "count", hidden: 3 }
it("never counts a document as a picture") // 3 pictures + 3 PDFs, 4 slots → 3 picture tiles, no count tile
it("draws a count tile with no cover when there is no next picture") // slots 3, 5 pictures → 2 pictures + count { hidden: 3, cover: <3rd picture's previewUrl> }
it("narrows to three slots") // 6 pictures, 3 slots → 2 picture tiles + count { hidden: 4 }
it("excludes an image with no preview") // an SVG card (previewUrl null) is not a picture
```

- [ ] **Step 2: Run and watch them fail**

`npx vitest run src/lib/components/chat/files-strip-view.test.ts`

- [ ] **Step 3: Implement**

A picture is a card with `previewUrl != null`. `stripPictureCards` filters in card order. `filesStripTiles` takes the first `slots` pictures when they fit; otherwise the first `slots − 1` as `picture` tiles and one `count` tile with `hidden = pictures.length − (slots − 1)`, `cover = pictures[slots − 1]?.previewUrl ?? null`, and `pictureIndex` = the index of the first hidden picture (so the viewer can open there).

- [ ] **Step 4: Run**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/chat/files-strip-view.ts src/lib/components/chat/files-strip-view.test.ts
git commit -m "feat(files): decide a call's tiles without a browser"
```

---

### Task 3: The strip block

**Files:**
- Create: `src/lib/components/chat/FilesStrip.svelte`
- Modify: `src/lib/i18n/chat.ts` (`en` and `hu`)
- Test: `src/lib/components/chat/FilesStrip.test.ts`

**Interfaces:**
- Consumes: `filesStripTiles`, `STRIP_SLOTS_WIDE`, `STRIP_SLOTS_NARROW` (Task 2); `ToolCallFileCard` (Task 1); `loadImageLightbox` (`image-lightbox-loader.ts`); `FileTypeIcon` (`$lib/components/ui/FileTypeIcon.svelte`) with `getFileType(mime, name)`; `formatByteSize`, `formatRelativeTime` (with `yearWhenNotCurrent`).
- Produces: `<FilesStrip {cards} />`, no other props.

- [ ] **Step 1: Write the failing tests**

```ts
it("draws one file as a card, not a strip") // 1 image → the 56px card, its picture opens the viewer, its link opens Nextcloud
it("draws a tile per picture and a chevron") // 3 pictures → 3 buttons named "Open …, picture 1 of 3", one chevron
it("opens the viewer at the picture that was pressed") // click tile 2 → the lazy loader is called, index 1
it("opens the list from the chevron and closes it again") // aria-expanded true/false, list present/absent
it("draws the quiet line and no strip when nothing is a picture") // 3 documents → "Searched your files · 3 files", no tile buttons
it("keeps the whole name reachable when it is too long") // the rendered name node has title === full name
it("gives a document row one link to Nextcloud") // the row is an <a href=webUrl>, its picture is inside it, no button inside
it("falls back to the preview size for a card with no viewUrl") // legacy card → viewer image src ends size=192
```

- [ ] **Step 2: Run and watch them fail**

`npx vitest run src/lib/components/chat/FilesStrip.test.ts`

- [ ] **Step 3: Implement**

Three shapes, chosen by the cards the row was given:

- **One card** (`cards.length === 1`): the single-file card — a 56px picture (or `FileTypeIcon`), then the name (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0`, `title` = full name), then `size · date` and an "Open in Nextcloud" link. The picture is a `<button>` that opens the viewer; the link opens `webUrl`; the two are siblings, never nested. No chevron and no list.
- **Two or more, with pictures**: the strip, then the list behind the chevron.
- **Two or more, no pictures**: the quiet line, then the list behind the chevron.

Markup of the strip and list:

- Tiles: `<button class="fs-tile">` with `<img src={card.previewUrl} width="78" height="78" loading="lazy" alt="">`; `onerror` swaps in the `FileTypeIcon`; `aria-label` from `toolActivity.filesOpenPicture` with `{name}`, `{index}`, `{total}`. The count tile is a `<button>` with the dimmed overlay and `aria-label` from `toolActivity.filesShowAll`.
- The chevron: a `<button>` with `aria-expanded` and `aria-controls` the list's id; toggles `open`.
- The list (`<ul>`, hidden unless open): each `<li>` is one `<a href={card.webUrl} target="_blank" rel="noopener noreferrer external">` holding a 40px `<img>` (or `FileTypeIcon`), the name, `size · date`, and the "Open in Nextcloud" label. Name is `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0` and carries `title={card.name}`.
- The quiet line (no pictures): `toolActivity.filesQuietLine` + the count + the same chevron.
- The viewer: `loadImageLightbox()` on first open, `$state.raw` component, `images` = `stripPictureCards(cards).map(c => ({ src: c.viewUrl ?? c.previewUrl!, alt: c.name }))`, `index` state, `onClose` and `onNavigate` per `ImageLightbox`'s props.
- Narrow: a `$state` measured by `matchMedia("(max-width: 480px)")` chooses `STRIP_SLOTS_NARROW`; unmeasured defaults to wide.
- New keys, both dictionaries:

```ts
"toolActivity.filesQuietLine": "Searched your files",
"toolActivity.filesShowAll": "Show all {count} files",
"toolActivity.filesOpenPicture": "Open {name}, picture {index} of {total}",
"toolActivity.filesHideList": "Hide the file list",
```

- [ ] **Step 4: Run the component tests and `npm run check`**

Expected: PASS, 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/chat/FilesStrip.svelte src/lib/components/chat/FilesStrip.test.ts src/lib/i18n/chat.ts
git commit -m "feat(files): draw a found call as a strip of pictures"
```

---

### Task 4: Swap the row for the block

**Files:**
- Modify: `src/lib/components/chat/MessageBubble.svelte` (deliverable assembly, `capFileCards` usage)
- Modify: `src/lib/utils/tool-calls.ts` (`capFileCards` — drop the remainder result)
- Modify: `src/lib/utils/tool-activity.ts` (remove the `files` body member and its builder branch)
- Modify: `src/lib/components/chat/ToolActivityRow.svelte` (remove the files branch)
- Modify: `src/lib/i18n/chat.ts` (remove `toolActivity.filesMore` and `toolActivity.filesPreviewFailed` if now unused)
- Modify: `src/lib/i18n/guide.ts` and `src/lib/components/guide/guide-content.test.ts` (the connected-accounts line stops being true the moment the row swaps)
- Create: `tests/e2e/files-strip.spec.ts`
- Test: `src/lib/components/chat/MessageBubble.test.ts`, `src/lib/utils/tool-calls.test.ts`, `src/lib/utils/tool-activity.test.ts`, `src/lib/components/chat/ToolActivityRow.test.ts`

**Interfaces:**
- Consumes: `<FilesStrip {cards} />` (Task 3).
- Produces: `capFileCards(rows)` returns just the capped rows (no remainder).

- [ ] **Step 1: Write the failing tests**

In `MessageBubble.test.ts`, replace the two strip-era cases:

```ts
it("draws a files call as a strip below the prose, not as a row") // the files segment renders <FilesStrip>, and no tool-activity row for it
it("still caps two files calls at six cards, and draws one strip per call") // two segments 4+4 with a repeated path → 6 tiles at most across both strips, no duplicate picture
it("keeps a cardless files call in the thinking rail") // no strip, the rail row stays
```

`tool-calls.test.ts`: `capFileCards` returns rows only, capped and deduped.

- [ ] **Step 2: Run and watch them fail**

`npx vitest run src/lib/components/chat/MessageBubble.test.ts src/lib/utils/tool-calls.test.ts`

- [ ] **Step 3: Implement**

- `capFileCards`: drop `remainder` from its return; keep the cap and the path dedupe.
- `MessageBubble`: build `fileStripCalls` = the reply's segments with `files?.cards.length`, capped by `capFileCards`, in segment order; render one `<FilesStrip cards={…} />` per call inside the existing `message-deliverables` container, after the artifact `ToolActivityList`; `hasDeliverables` includes them. Delete `fileDeliverableItems`, `fileCardsRemainder` and the remainder markup.
- `tool-activity.ts`: remove `{ kind: "files"; … }` from `ToolActivityBody`, its builder branch, and the `isFileCardsToolCall` use there; keep `isFileCardsToolCall` in `tool-calls.ts` for the rail filter.
- `ToolActivityRow.svelte`: remove the files branch and the now-unused imports (`ToolCallFileCard`, `FileTypeIcon`, `formatByteSize`) — keep any the component still uses.
- Update the tests that asserted the old body (they are deleted with the body; do not leave skipped tests).
- **Delete `fileCardFacts` from `ToolActivityRow.svelte` with the files branch.** Task 3 duplicated it into `FilesStrip.svelte`; after this task only one copy may exist — move it to `files-strip-view.ts` taking `$t`, or keep the strip's and delete this one. Two copies is a defect.

- [ ] **Step 3b: The guide line, in the same change**

The entry `guide.entry.connectedAccounts.line` currently says a found file "comes back as a card". After the swap that is false. Rewrite both languages: a found Nextcloud file comes back as a picture you can open in the app's viewer, and the strip's list opens it in Nextcloud. Keep the three facts parallel across `en` and `hu` and keep the length near today's. Extend `guide-content.test.ts` the same way the last change did — per-language keyword facts plus a parity check, never whole sentences.

- [ ] **Step 3c: The browser spec**

Create `tests/e2e/files-strip.spec.ts`. No fake Nextcloud exists, so reach the component through stored data: create a conversation in the UI (the harness's usual helper), then seed or stub one assistant message whose thinking segment carries a `files` payload with six cards (four pictures with `previewUrl` pointing at a 1×1 data or app route, two documents), reload the chat, and assert in a real browser:
  - four tiles at a wide viewport, three and a count tile at 360px;
  - no horizontal overflow of the reply column;
  - a long Hungarian name is ellipsised and its `title` holds the whole name (compare `scrollWidth > clientWidth` on the name node);
  - the count tile and the chevron open the list; a second press closes it;
  - pressing a picture opens the viewer, Escape closes it, and focus is back on that tile.
Choose the seam that the harness actually supports (a seeded row against the worker's SQLite file, or a `page.route` stub of the conversation detail). If neither is possible, stop and report what blocks it with evidence — do not invent a harness feature or weaken the assertions into something that cannot fail.

- [ ] **Step 4: Run the affected suites and `npm run check`**

`npx vitest run src/lib/components/chat src/lib/utils && npm run check`

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/components/chat src/lib/utils src/lib/i18n/chat.ts
git commit -m "feat(files): the strip replaces the file-card row"
```

---

### Task 5: Reconcile the documents

**Files:**
- Modify: `docs/superpowers/specs/2026-11-15-nextcloud-file-cards-compact-design.md`
- Modify: `docs/superpowers/specs/2026-11-15-nextcloud-inline-visuals-design.md` (§4)
- Modify: `docs/superpowers/plans/2026-11-15-files-strip.md` (an Outcome section)

**Interfaces:** none; prose only. The Feature Guide was already corrected in Task 4 — do not touch it again.

- [ ] **Step 1: Fix the compact design's own inconsistencies.**
  - Where it says the count tile's `N` is `cards − 3` / `cards − 2`, say **pictures**, which is what the code counts.
  - Its states table's "5+ results | ≥1 picture | 3 pictures + count tile" contradicts its decision 4 for a mixed set (3 photos + 3 PDFs, 6 cards): the code draws three picture tiles and NO count tile. Correct the table to the decision.
  - Say plainly that the count tile's cover is always a picture (a count tile exists only when pictures overflow, so `cover: null` is unreachable), and that the count tile opens the list while `pictureIndex` names the first picture it hides.
  - Record the one place the design is silent: `ToolCallFilesData.total` is still produced and capped but nothing renders it.

- [ ] **Step 2: Point the first-pass spec at this one.** In `2026-11-15-nextcloud-inline-visuals-design.md` §4, replace the card layout description with a line saying the compact design supersedes it (date + filename), so a later reader does not implement the deleted layout.

- [ ] **Step 3: Outcome section in the plan.** The commit list, the two plan amendments (Task 4 gained the guide and the browser spec; Task 5 became docs-only), and what could not be verified here: a real Nextcloud preview through the production route (the browser spec uses 1×1 data URLs), 78px rendering against real photographs, and the count tile's legibility against a real bright photo.

- [ ] **Step 4: Commit.**

```bash
git add docs/superpowers
git commit -m "docs: reconcile the strip design with what shipped"
```

---

### Task 6: Gates

- [ ] **Step 1:** `PATH=/opt/homebrew/opt/node@22/bin:$PATH scripts/gates.sh agent "$TMPDIR/alfyai-files-strip" --port 4630 tests/e2e/files-strip.spec.ts tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/feature-guide.spec.ts tests/e2e/artifact-card-arrival.spec.ts`

Expected: every step 0, Fallow at its four known cycles with `new_vs_baseline=0`.

- [ ] **Step 2:** Read the Fallow line; a new finding is a regression to fix, not suppress.

- [ ] **Step 3:** `npm run check:image-viewer-chunks` alone must pass — the viewer stays lazy.

- [ ] **Step 4:** Commit any gate fallout with a message saying what the gate found.

---

## Outcome

The strip shipped on `h3-deploy` in the commits below. Task 6 above is the gate
run that closes the plan: it names the new browser spec beside the specs around
it, and those are where the strip is proved. This section records what was
built, what the plan changed on the way, and what nothing here could check.

### The commits

- `51498e0b7` docs: design and plan for the files strip
- `0f151ef83` feat(files): carry a viewer-sized preview on the card
- `5b577f51c` fix(files): gate the viewer off the card picture and widen the preview cap
- `bf9053b85` feat(files): decide a call's tiles without a browser
- `45a22a530` test(files): hold the count tile's hidden pictures and boundaries
- `56f273e05` feat(files): draw a found call as a strip of pictures
- `6a6a939be` fix(files): hold the strip's viewer, width and count tile to their contracts
- `cf78fbd98` feat(files): the strip replaces the file-card row
- `2a3744e77` fix(files): tell the truth about every strip shape, and prove the pictures decode
- the commit that carries this section: `docs: reconcile the strip design with what shipped`

### The two amendments to the plan

**Task 4 gained the Guide line, the browser spec and the duplicate's deletion.**
The connected-accounts entry said a found file "comes back as a card", which
stopped being true the moment the row swapped, so Step 3b rewrites it in both
languages and extends `guide-content.test.ts`; Step 3c creates
`tests/e2e/files-strip.spec.ts`, because no unit test could prove the strip, its
list and its viewer in a real browser; and the `fileCardFacts` the files branch
of `ToolActivityRow.svelte` still carried had to go with that branch, so only
the strip's copy remains. The ruling is in the ledger
(`.superpowers/sdd/2026-11-15-files-strip/progress.md`).

**Task 5 became docs-only.** The Guide moved into Task 4, so Task 5's old text
would have churned the copy Task 4 had just fixed and proved. What was left was
the two design documents disagreeing with the code: this commit corrects the
compact design's own contradictions, points the first-pass spec's §4 at the
compact design, and records here what could not be seen from a test.

### What this work could not verify

- **A real preview through the production route.** The browser spec seeds a
  stored reply whose four pictures are 1×1 PNG data URLs, because the harness
  has no fake Nextcloud. The route's 192 and 1600 sizes, the adapter and its 6MB
  preview ceiling (pinned at 3MB and just over 6MB) are held by unit tests, but
  no run asked a live Nextcloud for a viewer-sized preview and drew the bytes it
  returned.
- **78px tiles against real photographs.** The spec keeps a reply column from
  scrolling sideways at 1280px and 360px and proves that at least one seeded
  picture, and the viewer's copy of it, decode — so the pixel path is real. The
  pixels are one synthetic PNG: no photograph's orientation, crop or detail was
  judged in a tile.
- **The count tile's legibility over a real bright photo.** The dimming is the
  app's scrim token laid twice, which the unit test pins, and the component's
  own note puts its worst case at about 4.6:1; nothing here laid it over an
  actual bright photograph and looked.

No automated check ever loaded a picture from a Nextcloud server. The unit tests
hand the strip the route's own URLs and never load them, the browser spec loads
synthetic data URLs, and the route and adapter were exercised against a mocked
fetch. What a browser cannot tell us here is how a real server's preview looks
at 78px and at 1600px.
