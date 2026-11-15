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

- [ ] **Step 4: Run the affected suites and `npm run check`**

`npx vitest run src/lib/components/chat src/lib/utils && npm run check`

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/components/chat src/lib/utils src/lib/i18n/chat.ts
git commit -m "feat(files): the strip replaces the file-card row"
```

---

### Task 5: The Guide, and the words that moved

**Files:**
- Modify: `src/lib/i18n/guide.ts` (both languages)
- Modify: `src/lib/components/guide/guide-content.test.ts`
- Modify: `docs/superpowers/specs/2026-11-15-nextcloud-inline-visuals-design.md` §4 (point at the compact design)

**Interfaces:** none; copy only.

- [ ] **Step 1: Write the failing test**

The connected-accounts line must still name the pictures, not a "preview card": assert the entry mentions the pictures/strip and opening the file in Nextcloud, in both languages, with the same three facts in each.

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

Suggested English: "Calendar, email, files, photos and more, for Alfy to read. A found Nextcloud file comes back as a picture you can open, and the picture opens the file." Give the Hungarian the same three facts, naturally, and keep both roughly the length of the current line.

- [ ] **Step 4: Run**

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/guide.ts src/lib/components/guide/guide-content.test.ts docs/superpowers/specs
git commit -m "docs(guide): describe the picture strip"
```

---

### Task 6: Gates

- [ ] **Step 1:** `PATH=/opt/homebrew/opt/node@22/bin:$PATH scripts/gates.sh agent "$TMPDIR/alfyai-files-strip" --port 4630 tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts tests/e2e/feature-guide.spec.ts tests/e2e/artifact-card-arrival.spec.ts`

Expected: every step 0, Fallow at its four known cycles with `new_vs_baseline=0`.

- [ ] **Step 2:** Read the Fallow line; a new finding is a regression to fix, not suppress.

- [ ] **Step 3:** `npm run check:image-viewer-chunks` alone must pass — the viewer stays lazy.

- [ ] **Step 4:** Commit any gate fallout with a message saying what the gate found.
