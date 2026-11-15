# Nextcloud file cards, second pass: the strip

Date: 2026-11-15
Status: design, supersedes the card layout in
`2026-11-15-nextcloud-inline-visuals-design.md` §4

## Why this exists

The first version shipped and was used. Three things went wrong, and one of them
was not ours.

1. **A wall of cards.** Every result of a `files` call got its own 96px card, so
   a six-result search drew six of them — most of a phone screen — and the
   reply's words stopped reading as the answer.
2. **Nothing could be folded away.** The row was pinned and always open, so a
   person had no way to put the results aside.
3. **"Expired".** Not ours: that one-line row is the confirmation card for a
   proposed write to a connected account (an album add, a save, a share link)
   that nobody answered in time. It folds into a row saying "Expired". It is
   pre-existing behaviour in the permission-card system and is **out of scope**
   here.

The person's own framing: compact, but still the most important thing on screen.
The thing that motivated the feature was wanting to *see* the picture, so a
compact version that hides every picture would miss the point.

## What was rejected

- **One quiet line** ("Searched your files · 6 found"). Compact, but it puts the
  picture back behind a click, which is where this started.
- **First match as a hero card, rest folded.** Still a card, so a search of six
  keeps a large block, and the choice of "first" is arbitrary.
- **The full-width bar with the count and chevron floating in it.** Ugly: a
  300-pixel strip stretched into 700 pixels of empty row, with two small things
  stranded at its end.

## The shape

A strip of square pictures, exactly as wide as the pictures, with a chevron
immediately after them. Nothing behind it, nothing stretched.

```
Found six — the June folder has them all.
[ 78 ][ 78 ][ 78 ][+3]  ⌄
```

- **Tiles are 78px**, 7px apart, 10px corners.
- **At most four tiles** on a wide screen. With more than four pictures the
  fourth is the count tile: the next picture, dimmed, with `+N` over it, where
  `N = cards − 3`.
- **At most three tiles** at 480px and below; the count tile carries
  `N = cards − 2`.
- **Clicking a picture opens the viewer** — the app's existing `ImageLightbox`,
  lazily loaded, handed every picture of the call, opened at the one clicked, so
  the arrows move between them.
- **The chevron opens the file list**, and the count tile does too. Closed by
  default.
- **The list** is one line per file: a 40px picture (or file-type icon), the
  name, `size · date`, and "Open in Nextcloud". Every line links to its file.
- **A call that found no pictures draws no strip.** It draws the quiet line —
  `Searched your files · 6 found` — with the same chevron and the same list.
- **A call that found one file** keeps the single card (56px picture, name,
  `size · date`, "Open in Nextcloud"). Its picture opens the viewer; its link
  opens Nextcloud.

## The states, exhaustively

| Results | Pictures | What is drawn |
|---|---|---|
| 1, a picture | 1 | card, picture opens the viewer |
| 1, a document | 0 | card with the file-type icon |
| 2–4 | any | strip of that many tiles, no count tile |
| 5+ | ≥1 | strip of 3 pictures + count tile (`+N`), chevron |
| 2+ | 0 | quiet line, chevron |
| any, all previews failed | — | tiles fall back to the file-type icon; the strip stays |

## Edge cases, decided

- **A long name never widens anything.** The card and every list row keep their
  width; the name is one line ending in an ellipsis. The full name is on the
  element's tooltip and in its accessible name.
- **The text block of a card or row is `min-width: 0`** in a flex row. Without
  it a long name pushes the box wider instead of truncating; this is the bug the
  first version would have had.
- **A name with no extension, or a type the app does not know**, draws the
  generic file-type icon.
- **An unknown size or date is omitted**, and no separator is left dangling.
- **A refused or broken preview** draws the file-type icon in the same square.
  A broken `<img>` is never shown.
- **Non-images never appear as tiles**, even when they are among the results;
  they are in the list, with their icon.
- **A picture that is very tall or very wide** is cropped square in the tile
  (`object-fit: cover`) and fitted whole in the viewer.
- **The cap stays six per reply**, deduplicated by path, with one remainder —
  as the shipped version already does. The strip never shows more than four
  tiles however many pictures there are.
- **A `files` call whose cards are drawn nowhere in the rail**: unchanged from
  the shipped version — a card-drawing call stays out of the thinking rail, a
  cardless one stays in.

## Accessibility

- Each tile is a `<button>` whose accessible name says what it opens:
  "Open IMG_2043.jpg, 1 of 6".
- The count tile's name says "Show all 6 files".
- The chevron is a button with `aria-expanded` and `aria-controls` naming the
  list; the list is a `<ul>` of links.
- The viewer is the existing modal: it takes focus, traps Tab, closes on Escape,
  and hands focus back to the tile that opened it.
- Every string in English and Hungarian.

## Plumbing

- **A larger preview for the viewer.** The route accepts one more size, 1600,
  used only by the viewer; the cards keep 96 and 192. Nextcloud renders that
  size on demand and caps it at its own maximum, so the viewer shows the biggest
  preview the server offers — not the original bytes.
- **The card data carries the viewer's address.** `ToolCallFileCard` gains
  `viewUrl: string | null` (null for anything that is not a drawable image),
  built on the server beside `previewUrl`. The client never assembles a preview
  URL.
- **The row hosts the viewer** through `image-lightbox-loader.ts`, so the chunk
  stays out of first paint, exactly as messages and the Image card do.

## What I decided, open to challenge

- 78px tiles, four across on a wide screen, three on a phone.
- The count tile sits last and is dimmed, rather than a text count after the
  strip.
- A quiet line, not an empty strip, when there are no pictures.
- Six per reply stays.
- The single-file card keeps its shape and only gains the viewer.

## Left to the builder

- The exact breakpoint (480px) and whether it should follow the app's existing
  narrow-chat measure.
- Whether the expanded list should also collapse when the person scrolls past,
  or only on a second press. (Default: only on a second press.)
- Whether `viewUrl` should be persisted or derived from `previewUrl` on the
  client. (Chosen: persisted, so the client builds no URL.)
- Which tests the existing card suite needs rewritten rather than extended.

## Done means

- A six-result search draws one 78px strip and a chevron, and the reply's words
  are the first thing read.
- Clicking a picture opens the viewer at that picture; the arrows move between
  the call's pictures; Escape closes it and focus returns to the tile.
- The chevron opens a compact list; a second press closes it.
- A long Hungarian file name truncates in every place it is drawn, on a phone
  too.
- A document-only search draws a quiet line and no strip.
- Gates green: `npm run check` 0/0, `npm test`, `npm run build` with zero
  warnings, Fallow at its baseline, and the chat and image specs in full.

## Settled after the builder's check

The six things a builder could otherwise guess wrong.

1. **The numbers mean what is drawn.** The card payload is already capped at six
   per reply; `capFileCards` rewrites each row's `total` to the number of cards
   that row actually shows. So the quiet line says `6 found`, not the twelve the
   call may have returned, and the `+N` on the count tile counts the pictures
   that row has but does not show. The reply-level "N more" line
   (`toolActivity.filesMore`, `fileCardsRemainder`) is **removed**: the count
   tile already says it, and two remainders that disagree is what the first pass
   would have produced. The model still sees every result and can say "found
   twelve" in its own words; the cards never claim more than they show.
   Consequence: every number is computable inside one row, so nothing has to be
   threaded from `MessageBubble` down.

2. **The strip replaces the row line, it is not a body inside it.** A
   card-drawing `files` call draws no status glyph, no tool icon and no
   "Searched …" line — the approved mockup has none of those. So the files card
   stops going through `ToolActivityList` / `ToolActivityRow` (whose
   `pinned`/`alwaysOpen`/row-as-button contract is exactly what made the first
   pass unfoldable) and becomes its own block in the `message-deliverables`
   area, beside the artifact list. A cardless `files` call keeps today's
   ordinary rail row, unchanged — that is where a failed or empty search still
   reads "Searched your files".

3. **Old messages lose only the viewer's size, not the feature.** `viewUrl` is
   optional on the card type and read defensively (`?? null`). When a stored
   card has none, the tile opens the viewer at `previewUrl` — 192px, soft but
   working. No backfill, no read-path shim, nothing migrated.

4. **A tile is a drawable picture; the count tile may have no picture behind it.**
   Tiles are cards whose `previewUrl` is not null, in card order. Slots are 4 on
   a wide screen and 3 at 480px and below. If the pictures fit the slots, they
   are all drawn and there is no count tile. If they do not, the last slot is
   the count tile with `N = pictures − (slots − 1)`; its background is the next
   picture when one exists, otherwise a plain neutral tile carrying only the
   number. An image with no preview (an SVG, which the server deliberately
   refuses to preview) is not a tile: it appears in the list with its icon.
   This resolves 3 photos + 3 PDFs: three tiles, no count tile, documents only
   in the list.

5. **Nextcloud preserves the aspect ratio, so 1600 is enough.** Verified in
   Nextcloud's own `PreviewController`: `getPreview(…, !$a, $mode)` — with the
   adapter's `a=1` the crop flag is false, so `mode=fill` does not crop and a
   1600×1600 request returns the picture fitted inside that box (1600×1067 for
   a 3:2 photo). The tile crops it square with CSS; the viewer shows the whole
   picture. No adapter change.

6. **The list row is one link; the tile is a button.** In the expanded list the
   40px picture is part of the row's single `<a>` to Nextcloud, exactly like the
   name — clicking a list thumbnail goes to the file, not the viewer, and no
   interactive element is nested inside another. The strip is the place for
   looking; the list is the place for going. A tile whose picture fails to load
   at runtime draws its file-type icon and stays a button: the 1600 request may
   still succeed, and if it does not, the viewer says so in its own words.
