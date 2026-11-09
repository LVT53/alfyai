# Feature Guide

The `/guide` page, "What AlfyAI can do": six sections, thirty entries, a drawing per section, and a box of keys and slash commands. It is the app's one map of what a person can do (`docs/plans/feature-guide/design.md`). The route, `src/routes/(app)/guide/+page.svelte`, is an adapter: it draws the frame and the serif title (the only serif on the page, and the one `MAY_NAME_THE_SERIF` entry for it is a class) and renders `GuidePage`. Nothing in the chat shell imports this folder: the "?" that opens the page only links to it. Its drawings are `drawings/` here, built from the kit in `src/lib/components/drawings/` (its own AGENTS.md).

## Where the content and the words live

- **What is listed** is `guide-content.ts`: the six section ids, and the thirty entries with their section, `drawingSpot`, action (Try it, Show me or none) and `added` date. The page lists them in that order. The count (7/6/4/4/5/4) is held by `guide-content.test.ts`.
- **Every word** is a `guide.*` key in `src/lib/i18n/guide.ts`, English and Hungarian: the page's words, each section's name and intro, each entry's name, line and (Try it) example. Add or reword an entry in both languages in the same change, with one Hungarian word per thing (`docs/plans/feature-guide/inventory.md`, section 3). A drawing's words are not here: they are the real controls' own keys. Keycaps (`Ctrl/⌘+K`, `Esc`) and slash tokens are not words and are not keys.
- **A change to a feature** that adds, removes, renames or moves what a person can do updates its entry and its words here, its `drawingSpot` in `drawings/section-drawing-spots.ts` and the drawing when a pictured control changed (root AGENTS.md).

## Show me

- `showGuidePlace` asks for the control (`requestSpotlight`, in memory, `src/lib/stores/spotlight.ts`) and then goes to its page. `place: null` is a control the sidebar shows on every page, so the person stays where they are. Show me exists only where its control is always there; a control that appears in some state gets none.
- **Every Show me spotlight has a marker on its real control** (`use:spotlightTarget={"area.control"}`, `src/lib/actions/spotlight.ts`), and **a line in `tests/e2e/feature-guide.spec.ts`** that presses the row's button and expects the ring on that control. A control that moves keeps its marker; a spotlight id with no marker rings nothing, quietly, and only that spec notices.
- **The marked control's class is static plus `class:` directives.** The action rings by adding `spotlight-ring` to the element's class list; a `class={...}` string that Svelte re-evaluates while the ring is on would write the whole attribute again and drop the ring early.

## Try it

- `tryGuideExample` stores the example with `storeHomeComposerSeed` (`src/lib/client/conversation-session.ts`, the one module that owns hand-off keys: the session key is `home-composer-seed`) and then goes to Home. The example is in the reader's language (`guide.entry.<id>.example`) and never in the URL.
- Home takes it once (`consumeHomeComposerSeed`, `HomeSurface.svelte`), on Home only: a project page leaves a waiting example alone, and sign-out drops one that is still waiting. It goes into the message box unsent, with the caret in it.
- It goes in only after Home has read the saved draft back. **A draft with anything in it** (words, files, linked sources, a skill, Atlas mode) is kept, the example is dropped and a toast says so (`guide.tryItDraftKept`); a saved draft with nothing in it takes the example.

## NEW

An entry wears NEW for 30 days from its `added` date (`isGuideEntryNew`, `GUIDE_NEW_FOR_DAYS`), judged against the browser's clock, read once per visit. Everyone sees the same thing, so nothing is stored per person. A feature that already existed when the guide shipped has `BEFORE_THE_GUIDE`; a new feature gets the day it ships, and its mark goes by itself.

## No admin features

The guide never mentions an admin feature (the Administration tab, campaigns, system settings) and never filters by who is looking: not by role, and not by what the server has configured. The owner is the only admin and does not need a map of what only they see.

## The page

- **Stable hooks** for the end-to-end spec: `data-testid="guide-scroller"` (the route's scroller), `guide-section` with `id="guide-section-<id>"` on each band, `guide-row` with `data-entry-id="<id>"` on each row, `guide-shortcuts` and `guide-shortcut-keys`.
- **Layout.** The sections answer to the width of the page's column, not the window's: two columns (a 330 px column for the name, intro and drawing, and the rows) from 46rem of column, which a phone, a tablet held upright and a 1024 px window with its sidebar open do not have. Stacked, the drawing is `position: sticky; top: 0` inside its band, capped at 28rem, so a row tapped far down still shows its spot; the band tells its rows how much that hides (`--guide-pinned`) so a focused button is never left under it. A window under 36rem tall pins nothing.
- **Words wrap.** A name or a line is never cut short (some Hungarian names run to two lines at 360 px), and neither the page nor a drawing scrolls sideways at 360 px.
- **A row lights its spot** in its section's drawing (`GuideRow`, `GuideSection`): while a mouse or pen is over it, while the keyboard is on its button (`focusin`), and after a tap (a click on the row). A finger's own pointer enter and leave are ignored, since they come with every scroll. A click outside the section's rows puts the light out. A row with no action has no button and is not focusable; what it says is in its words.
- **The keys box** (`GuideShortcuts`): the keys were checked against the code: Ctrl/⌘+K opens Search (`Sidebar.svelte`), `/` goes to the message box where the page has one, Ctrl/⌘+Enter sends and Enter writes a new line (`MessageInput.svelte`), Esc closes a menu or dialog. A changed shortcut changes the box. The slash commands are `STATIC_COMPOSER_COMMANDS` read with the composer's own descriptions. The key rows are hidden on a touch-only screen (`(hover: none) and (pointer: coarse)`); the commands stay.
