# FB-9 — phone polish: nothing collides, no keyboard chords on a touch screen, short labels that do not crowd

The owner's own finds (2026-10-12), part of the friction build (`phase-5/build-plan.md`, ruling 77 and its amendment:
"short, natural Hungarian that does not crowd a row … the small UI changes that make it look mature"). Read
`phase-5/common.md` and the two files it names first, then ruling 77 with its amendment (end of `decisions.md`), and
`phase-5/fb6-report.md`'s F13 section (the phone review bar).

- Branch / worktree: `fix/friction-phone-polish` in `.claude/worktrees/art-fb9`, from `feat/artifacts`. Ports 5480–5489.
- Report: `<scratchpad>/p5/fb9-report.md`. Owns: `components/layout/Sidebar.svelte`, `components/sidebar/**`,
  `artifacts/document/keyboard-shortcuts.ts`, `DocumentToolbar.svelte`, `MobileToolbar.svelte`, `ChangeBar.svelte`,
  `canvas/CanvasToolbar.svelte`, `canvas/CanvasSelectionPill.svelte`, `search/SearchModal.svelte`,
  `artifacts/ReviewBar.svelte`, and their tests. Not yours: History's help line (FB-8 drops its chord on touch), the
  panel's crumb and headers (FB-5), the chat page and message bubbles (FB-7).
- **The Canvas editor's first paint has about 80 B of room** (`CanvasToolbar` and `CanvasSelectionPill` are in it):
  measure with `npm run check:artifact-chunks` and keep the change in CSS where you can.

## What to fix

0. **A regression on your base (first, alone):** FB-3's `toggleSidebarCollapsed()` (`stores/ui.ts`) answers a press while
   the sidebar is folded for a docked panel by dismissing the fold only, so a reader whose own setting is "collapsed"
   presses Expand on the rail and nothing opens; five tests in `artifacts-panel-scope.spec.ts` fail on `feat/artifacts`
   for it (`phase-5/fb5-report.md`, near line 108, has FB-5's diagnosis and two candidate fixes). Fix it so a press on
   the rail always does what it says, with the panel docked or not, and the fold still returns the sidebar when the panel
   closes; that spec green. `stores/ui.ts` is yours for this.

1. **The sidebar on a phone** (the owner): with a chat open and the sidebar open at phone widths (390, 360; check 430
   too), the conversation row's three-dots button and the project folder's counter collide. Reproduce it with real
   touch first, then lay the row out so each has its own place (a long title gives way, never the button or the
   count), with 44 px targets.
2. **No keyboard chords on a touch screen** (the owner: "plain wasted space"). On a device whose primary pointer is
   coarse (`(pointer: coarse)`; a phone, a tablet without a mouse), no button, tooltip, menu row or toolbar draws a
   keyboard shortcut (⌘Z, Ctrl+Alt+Z, Esc, ⌘K, Enter …), and the space they took goes back to the label. Keep
   `aria-keyshortcuts` and the shortcuts themselves (a tablet with a keyboard still has them); a mouse-and-keyboard
   desktop is unchanged. `keyboard-shortcuts.ts` is the one place that says how a chord is written on a button: put the
   rule there, not in each component.
3. **The phone review bar's labels.** FB-6 made the bar one row on phones with the short words "Megtart" / "Visszavon"
   (EN "Keep" / "Undo"); in Hungarian they read as clipped verb stems. Use natural Hungarian that fits the one row at
   360 and 390 ("Megtartom" / "Visszavonom", as the pills say, if they fit; measure), keeping the accessible names.
4. **The panel list's repeated heading:** the list shows the eyebrow "EZ A BESZÉLGETÉS" ("THIS CHAT") over the title
   "Amit ez a beszélgetés készített" ("What this chat made"): the owner's principle says one of them goes; drop the
   eyebrow there (FB-5 kept it as a heading; `DocumentWorkspace.svelte`'s list header is yours for this one line).
5. **A sweep for crowded rows on a phone**, in Hungarian, at 360 and 390: the files you own first (fix what crowds or
   wraps badly there), then a short list in your report of anything elsewhere that crowds, with a screenshot each, for
   the next round.

## Tests and gates

Red first, real input (touch at 390 and 360): the sidebar row's button and count do not overlap (bounding boxes) and
both take a tap; no chord text on a coarse pointer and the chord still shown with a fine pointer (Playwright's
`hasTouch` + a mobile project, and the desktop one); the review bar's labels whole at 360/390. Screenshots you look at
yourself, at most 6, in `<scratchpad>/p5/fb9-shots/`. `scripts/gates.sh agent <out-dir> --port 5480 --workers 4` with
your specs plus the specs that cover the sidebar, `artifact-document-keyboard.spec.ts`,
`artifact-document-review-bar.spec.ts`, `artifact-canvas-pill*.spec.ts`, `search-modal.spec.ts`;
`check:artifact-chunks` exit 0.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the editor closure before → after,
concerns.
