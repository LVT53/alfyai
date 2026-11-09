# Drawing Kit

Small drawn copies of real controls (`DrawnReply`, `DrawnComposer`, `DrawnMenu`, `DrawnPanel`, `DrawnChatCard`, with `DrawnBar` for content), composed into realistic drawings of real screens inside a `DrawingFrame`. The Feature Guide draws one per section, in `src/lib/components/guide/drawings/`. Campaign pictures will draw from the same parts later (`docs/plans/feature-guide/design.md`, section 9). Only drawings import this folder: nothing in the chat shell does.

## Rules

- **Words are the real control's dictionary key**, read from the component that renders the control (`$t(...)`). A reworded control then rewords its drawing, in both languages. A drawing never gets a key of its own, and content (a message, a title, a name) is a grey `DrawnBar`.
- **Icons are Lucide**, the ones the real control imports: a kind's icon is `ARTIFACT_KIND_ICONS`. A part arranges icons and simple shapes (elements in token colours and radii) and draws no icon of its own: an inline `svg` is out. An icon sits in a `.drawn-ic` box (`size="100%"`; `--ic` sets its size).
- **Tokens only.** Colours, radii and type are `src/app.css` tokens, and light and dark come from them alone: no hex, no `rgb()`, no `.dark` branch.
- **Design pixels.** A drawing is designed at 330 by 222 and `DrawingFrame` scales it to its container's width with container-query units (the frame's height is its `aspect-ratio`, so nothing is measured and nothing jumps after hydration). A part sizes itself in `calc(var(--u) * N)`, N being its size in the 330-wide design, never in `px`, `rem` or `%` of the frame. Labels must fit at any width: a part draws no ellipsis, and `nowrap` text gets room for the longer Hungarian.
- **Decorative.** The frame is `aria-hidden`, so nothing inside takes focus: spans, never buttons or links. Give the frame a container as wide as the drawing may be; it fills it.
- **Spots.** A control a guide row can light carries `data-drawing-spot="<id>"` and the class `drawing-spot-lit` while lit (`drawing-spot.ts`, `isLit`). The look is `src/app.css`'s `.spotlight-ring, .drawing-spot-lit` rule, the ring Show me puts on the real control. The drawing names the ids, which are the guide's `drawingSpot`s listed per section in `guide/drawings/section-drawing-spots.ts`; a part holding a spot takes `lit` and the ids it marks (`spots`, or `spot`). The frame positions every spot, so a part sets no `position` on one.

## A drawing follows its control

A change to a pictured control's icon, order or place changes its part in the same change; words follow on their own, through their keys. `guide/drawings/drawings.test.ts` holds what a test can: the "+" menu's rows against `buildComposerMenuRows`, the words in both languages, the tokens and Lucide rules above. A spot added or removed changes `SECTION_DRAWING_SPOTS` too.
