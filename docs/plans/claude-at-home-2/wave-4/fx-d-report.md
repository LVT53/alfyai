# FX-D report: the in-chat card at a docked panel's narrow chat column

Model: `claude-sonnet-5-5`. Worktree `art-fxd4`, branch `fix/artifacts-card-narrow` (from `feat/artifacts` `d69432e7`), e2e port 5480.
Commit range: `d69432e7..407637ad` (7 commits, all with the Co-Authored-By trailer; nothing pushed, merged or rebased; the tree is clean).

```
36c2aec8 Put a narrow in-chat card's action on a row of its own, under the text          (the fix + its red spec + unit test + FX-C's spec updated)
811eae7e Cover every card state of the narrow layout: out of reach, cannot regenerate, File row, phone, wide
ffafa760 Keep the narrow-card spec quiet and start its English case from English
4a62f714 Assert the facts line's height is one line's, as the brief words it
92b8a9c8 Keep a tablet's docked card inside its edge: wrap the pills and the long action   (found by the spec's real 800 px docked case)
d3ac5cdf Assert what a screen reader says of the narrow card, in the order it is shown
407637ad Say in the card's CSS that its host must be a block box                          (comment only)
```

Status: **DONE_WITH_CONCERNS**. The concerns are decisions for you, not defects: phones (390 px) now get the narrow layout too; `keepFactsWhole` is removed; the chat route grew by 128 B gzip. See "Concerns".

## The layout rule as built

`src/lib/components/artifacts/ArtifactCard.svelte`, `chrome="full"` only (the `chrome="row"` list rows, the `chrome="body"` File row and the plain body card are untouched):

- The card root `.artifact-card-full` is a size container: `container: artifact-card / inline-size` (the pattern `ReviewBar.svelte` already uses). The card answers to **its own width**, never the window's: an undocked card in the same 1440 px window is 680 px wide and keeps its layout.
- **Below 26rem (416 px) the card is narrow.** The head's grid is icon + text and the action (Megnyitás / Megnyitva a panelen / Átnézés / Újragenerálás; Open / Open in panel / Review / Regenerate) takes **a row of its own under the text**, left-aligned under the title (its words line up with the title's; a hover's tint reaches 0.5 rem left of them). From 26rem up nothing changes: the action stays at the right of the head, centered on the text block.
  - Why 26rem: beside the text the action needs a card of about 400 px: 88 px for the icon and the head's spacing, ~150 px for the facts line, 164 px for the longest action (Hungarian "Megnyitva a panelen" is a 164 px box). Below that the title column is crushed (FX-C's measurements on the unfixed tree: 5 px at a 1100 px window, 63 at 1280, 114 at 1440; card widths 257, 314, 365 px).
- **The meta line is one line.** The kind, the facts and the version are one element, `.artifact-card-facts` (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%`): it ends in an ellipsis before it wraps. Nothing in it can break, so a number can never part from its unit and FX-C's no-break spaces (`keepFactsWhole`) are gone.
- **The review pills** ("✓ Átnézve", "1 módosítás vár rád", "N részt nem érintett") are siblings of the facts line inside the wrapping `.artifact-card-sub`: beside it when they fit, on a row of their own when they do not. In a column narrower than the pill (a tablet with the panel docked) their words wrap inside the card (`min-height: 20px; max-width: 100%; white-space: normal`; was `height: 20px; white-space: nowrap`), never past its edge.
- In a column narrower than the action's label (a tablet), the label wraps ("Megnyitva a / panelen ›"); the Regenerate button, one word, gives up some of its own padding and gap.
- Deleted / out-of-reach / cannot-regenerate states keep their sentences (a sentence may wrap; it is not a facts line) and the deleted state's Regenerate takes its row under them.

No new string, no new i18n key, no new export.

## Red first (seen failing on the unfixed tree, then fixed)

`tests/e2e/artifact-card-narrow.spec.ts` (new): a real click on the first card docks the panel, Hungarian, bounding boxes. On the unfixed component every state failed at 1100, 1280 and 1440 px. At 1100 px (card 257 px wide):

| card | unfixed | now |
| --- | --- | --- |
| Weekend plan (open in the panel) | text column 5 px; meta text on 4 lines (`Dokumentum` / `· 1 fül` / `·` / `v1`); the action (168..332) drawn over the meta text (151..229, 151..184); the action starts above the lowest text | 1 line; the action (143..307) under the pill, over nothing |
| Packing list (change to review) | 3 meta lines; the action (247..332) starts above the pill row | 1 line |
| Weekend board (Canvas) | 3 meta lines | 1 line |
| Budget app (App) | the action (233..332) drawn over the title (151..241) | action under the title |
| Old itinerary (deleted) | Regenerate (202..332) over the sentence; sentence on 3 lines | Regenerate under the sentence, over nothing |

At 1280 (card 314) and 1440 (card 365) the unfixed meta line was 3 lines for the Document/Canvas cards (FX-C's screenshot 09 shape). At 390 px on the unfixed tree the deleted card's text column was under 150 px and its sentence broke into 2 lines beside Regenerate; at 1440 docked the deleted and the open card's columns were under 150 px as well. The unit test "draws kind, facts and version as one line, with the review pill beside it and not inside it" fails on the unfixed component too (`ArtifactCard.test.ts`; verified by stashing the component). The undocked 1440 case is a guard: it passed before and after (the wide layout is unchanged).

## Tests

- **`tests/e2e/artifact-card-narrow.spec.ts`** (new, 8 tests, ~45 s). One chat is seeded with every state: a reviewed Document (the first card: the click that docks the panel), a Document with a change to review (seeded through `applyDocumentPatch`), a Canvas with 3 blocks, an App, a deleted Document (Regenerate), a deleted Document whose call kept no usable request (a real click on Regenerate, after which the card says why it cannot), a Document made in an incognito chat of the same reader (out of reach: "Az eredeti beszélgetésben készült"), and a produced file (the File kind's `chrome="body"` row). Per card it measures: the lines the meta text is drawn on (1) and the facts element's height in lines of its own text, the text column (>= 150 px), the action's box against every text box and pill (no intersection), the action under the lowest text (narrow) or to the right of everything (wide), everything inside the card (a pill inside the text column), and the head's accessible name (title, kind and facts, version, pill, action, in that order). Cases: 1100, 1280, 1440 docked (Hungarian); 1100 docked (English); 390 phone; 800 tablet docked (facts line cut by an ellipsis, pills and the long label inside the card); 1440 undocked (the action stays beside the text, as it was). The File row must stay inside the grey box that holds it. `FXD_SHOTS=<dir>` also writes the light/dark screenshots (and prints per-card numbers).
- **`ArtifactCard.test.ts`**: the `keepFactsWhole` test is replaced by one on the new structure (the facts are one element; the pill is its sibling, never inside it). 51 tests pass.
- **`tests/e2e/artifact-chat-card.spec.ts`** (FX-C's M-7 spec): it measured the side-by-side layout (a text range under the label's left edge, a text node's `firstChild`), which is no longer the truth; it now asserts the same promise on the new element (one line; the label's box intersects nothing).

## Gates (the tree as of `d3ac5cdf`; `407637ad` is a CSS comment, ArtifactCard's 51 unit tests rerun)

| Gate | Result |
| --- | --- |
| `npm run check` | 8,407 files, **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1: the baseline) |
| `npx biome check src scripts tests` | clean (2,537 files) |
| `npm test` | 1,033 files passed (+1 skipped); **17,204 tests passed**, 2 skipped |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (baseline, same on base and head) |
| `npm run check:artifact-chunks` (own line) | **exit 0.** Editor first paint unchanged on base and head: target 208.5 kB raw / 62.2 kB gzip, exclusive closure 227.9 kB raw / 70.2 kB gzip (ceiling 72,704); Chart.js, MapLibre, Mermaid out of it. Chat route: see below. `--chat-baseline` not moved. |
| Fallow | **124 issues, 4 circular** (13 unused files, 87 unused exports, 9 unused types: the same summary as FX-C's run); nothing new is flagged |
| `npm run check:migrations` | passes unchanged |
| Playwright, port 5480: every `tests/e2e/artifact*` spec, knowledge, chat, conversation, conversation-forks, live-evidence-metadata | 580 tests: **557 passed, 23 skipped, 0 failed** (44.4 min) |

### Chat-route size (not moved by me; the orchestrator records it)

- **Base** `d69432e7`: its `ArtifactCard.svelte` is the only difference, so I built the head tree with that one file swapped back: **542,894 B gzip** (+1,405 over the 541,489 baseline).
- **Head** (built at `92b8a9c8`; `d3ac5cdf` changes a spec and `407637ad` a CSS comment, so the bundle is the same): **543,022 B gzip** (+1,533 over the baseline; 2,048 allowed). **My growth: +128 B gzip.** (After the first version of the fix it was +78 B: the tablet rules for the pills and the long label are the other 50.) Removing `keepFactsWhole` gave some back; the container query, the facts element and the three pill rules took it.

## Screenshots (looked at each; Hungarian unless named; `.../scratchpad/w4/shots/fx-d/after/`, the old layout in `.../before/`)

The eight asked for (1100, 1280, 1440 docked and 390, light and dark), all five-to-seven cards in view (tall windows):
- `docked-1100-hu-light.png`, `docked-1100-hu-dark.png`: seven card states and the File row in the narrowest laptop column; the action under the text on every card, the meta line one line, the pill on its own row where it does not fit, the deleted sentence and Regenerate, "Az eredeti beszélgetésben készült" on two lines.
- `docked-1280-hu-light.png`, `docked-1280-hu-dark.png`, `docked-1440-hu-light.png`, `docked-1440-hu-dark.png`: the same; at 1440 the pill sits beside the facts when it fits.
- `phone-390-hu-light.png`, `phone-390-hu-dark.png`: the cards (358 px) use the narrow layout: action under the text (before: `before/phone-390-hu-light.png`, action at the right).
Extras: `docked-1100-en-light/dark.png` (English labels), `docked-800-hu-light/dark.png` and `card-{reviewed,pending,deleted}-800-hu-light.png` (a tablet's 192 px card: ellipsis on the facts line, the pill and "Megnyitva a / panelen" wrapped inside, Regenerate inside), `wide-1440-hu-light/dark.png` (undocked: unchanged, action at the right; the same as `before/`), `hover-pending-1100-hu-light.png` (a hover's tint on the action under the title).
`before/docked-1100-hu-light.png` is FX-C's defect again (title column gone, label over the meta lines).

## Concerns

1. **Phones now get the narrow layout (decision for you).** A phone's card is 358 px wide at 390 px, under 26rem, so its action moves from the right of the head to a row under the text (about 22 px taller per card; `before/phone-390-hu-light.png` against the after). It cannot be avoided by width alone: a 365 px docked card with the 164 px label "Megnyitva a panelen" and a 358 px phone card with the 99 px label "Megnyitás" differ by 7 px but need opposite layouts. The simple rule is one threshold for every card, which also keeps the cards in one docked column alike (the open card and its siblings). The alternative, if you prefer the compact phone card: a lower threshold (about 22rem) for the cards that are not open in the panel, keeping 26rem only for `.artifact-card-current` (the long label). Cost: between about 1440 and 1600 px with the panel docked, the open card is stacked beside siblings that are not. One more `@container` rule; say so and I will do it.
2. **`keepFactsWhole` is removed** (FX-C's M-7 mechanism). A facts line that cannot wrap cannot part "1" from "fül", so the no-break spaces and their unit test are dead weight; FX-C's e2e now asserts the same promise (one line) on the new element. If FX-C's suggested AGENTS.md line about `keepFactsWhole` was recorded, replace it with the line in the hand-off.
3. **Scope reaches tablets.** The panel docks from 768 px up (below it, an overlay), so a tablet's chat column is 180-250 px and the card ~190 px. I measured 800 px for real and fixed what ran past the edge (pills, the long label). At those widths the facts line ends in an ellipsis ("Dokumentum · 1 …") by design, and the sentence cards wrap on two to four lines. Narrower than that is not reachable with a docked panel.
4. **The File row (`chrome="body"`) is unchanged and reads**, but at the narrowest laptop column its own layout truncates the file name hard ("Trip su…" at 1100 px docked, "Trip summar…" in English): it is `FileProductionCard`'s existing ellipsis, the same before my change (see `before/`). Out of scope here; mention it if you want a card-level fix there.
5. **Hosts must be block boxes.** Inline-size containment gives the card no width of its own; the only host (`ToolActivityRow`'s `.act-standalone-card`) is a block, the measured widths are identical before and after (257/314/365 at the docked widths, 358 at 390), and the CSS says so.
6. **The e2e's "out of reach" card** relies on today's scope rule (an item of an incognito chat is out of reach from the reader's other chats), seeded by setting `memoryIncognito` on a second conversation, as `artifact-delete.spec.ts` does for forks.

## Hand-off

- No new exports or props. New DOM/CSS names: `.artifact-card-facts` (the one-line kind · facts · version element, a child of `.artifact-card-sub`; the pills are its siblings), the container name `artifact-card`.
- Suggested AGENTS.md line, under Artifacts next to the card's other lines (the file is the orchestrator's): "**The in-chat card answers to its own width** (FX-D): `ArtifactCard.svelte`'s `chrome="full"` root is a size container (`container: artifact-card / inline-size`, as `ReviewBar`); below 26rem (the chat column a docked panel leaves, a tablet's, a phone's) the head is icon + text and the action (Open / Open in panel / Review / Regenerate) takes a row of its own under the text. The kind, facts and version are one `.artifact-card-facts` line that ends in an ellipsis before it wraps (so a number never parts from its unit; `keepFactsWhole`'s no-break spaces are gone) and the review pills drop to a row of their own, wrapping inside the card when the column is narrower than they are. Never a media query: a docked panel narrows the chat column whatever the window is. The card's host must be a block box (inline-size containment). `tests/e2e/artifact-card-narrow.spec.ts` measures every state at 1100/1280/1440 docked, 800 docked, 390 and undocked."
