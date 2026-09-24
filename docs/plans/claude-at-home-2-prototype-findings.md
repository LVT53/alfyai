# Feature 2 (Artifacts) — prototype findings

Three throwaway prototypes answered the feasibility questions before the Feature 2 spec was written
(prompts and sub-questions: `claude-at-home-2-prototype-briefs.md`). All three verdicts are **feasible**,
each with constraints that the spec must encode. The prototypes themselves are primary sources: they live
on throwaway branches off `dev`, are never merged, and their run commands are below.

| Prototype | Branch | Run | Verdict |
|---|---|---|---|
| P1 · App-artifact model quality | `proto/artifact-apps-quality` | `PROTO_APPS_THINKING=off npm run proto:apps` | Feasible: 10/10 working apps |
| P2 · Document editor | `proto/artifact-document-editor` | `npm run proto:document` → :5195 | Feasible: 9/9 behaviours |
| P3 · Canvas on Svelte Flow | `proto/artifact-canvas` | `npm run proto:canvas` → :5196 | Feasible, 3 caveats |

All three used Node 22, MIT/ISC/BSD libraries only, and `dev` as the base. Nothing was pushed.

---

## P1 — Can the local model write working mini apps? Yes.

Ten prompts (the owner's and the family's real ones: cost splitter, Hungarian shopping list, HUF loan
calculator, flashcards, budget tracker, pomodoro, Danube quiz, habit tracker, unit converter, memory game)
produced ten one-shot, working, correct-language, network-free apps of 194–389 lines. ~17 s and ~3,000
completion tokens each; zero console errors, zero uncaught exceptions, zero external references (verified
by grep across all ten files).

**Rule 1 — generate apps with thinking OFF.** With thinking on and `max_tokens 24000`, the model spent all
24,000 tokens reasoning and returned **zero answer characters** (`finish_reason=length`) twice. With
`enable_thinking:false` the same prompt answered in 15.6 s / 3,045 tokens. Budget the answer, not the
thinking.

**Rule 2 — verify facts and arithmetic before showing the app.** 3 of 10 shipped a quiet content bug
(quiz key named the wrong "easternmost Danube capital"; a loan table was cumulative but labelled per-year;
one Hungarian gloss was wrongly plural). Every automated check passed. Apps with factual, numeric or
counting content need a verification pass — a second model call against the app's own data, or the existing
tool harness — before the card appears.

**Rule 3 — forbid the agentic reflex.** With no tools declared, one call still returned
`finish_reason=tool_calls` ("let me first explore the project structure"). The contract must say: the answer
is the app and nothing else; do not look for files and do not ask questions.

Further contract rules the model obeyed and should keep: no network, inline CSS/JS, AlfyAI CSS variables,
`window.alfy.storage.get/set` for persistence, 390 px + desktop, user's language, under ~400 lines.

Evidence: `scripts/prototype-artifact-apps/out/index.html` (all ten apps live in sandboxed iframes),
`out/results.json`, `out/app-NN.html`. The failed thinking-on attempt is kept in `out/attempts-01-*.json`.

## P2 — Document editor: Tiptap, Markdown, AI edits that respect your words. Yes.

Nine behaviours demonstrated in a browser: rich text in AlfyAI tokens (with tickable checklists, tables,
and a keyboard-only path verified with zero mouse events); Markdown round-trip (idempotent and
tree-identical, but not byte-identical — table column padding is lost, and chips serialise as
`[chip kind="status" value="Booked"]`); targeted block-addressed AI patches with inline Keep/Undo and
exact undo; "your words win" (a patch to a block the user changed since Alfy's last read is refused with a
visible notice while other patches apply); selection → Ask Alfy; anchored comments that survive unrelated
edits and orphan cleanly when their text is deleted; versions with restore; 1.5 ms per keystroke at 5,691
words.

**The finding that changes the design: block ids do not survive a page load.** Ids are re-minted on every
load; only content hashes persist. "Edit *this* paragraph" therefore has no stable address across
sessions. A durable addressing scheme (or a revision log) must be decided **before** the patch protocol is
written.

**Other constraints for the spec:** the guard is a single-session hash compare, so production needs a
revision log plus explicit refusal/rebase rules; the route costs 157 kB gzip (Tiptap/ProseMirror dominate),
so the editor must be lazy-loaded or every chat page pays for it; chips are a non-standard Markdown
extension, so a plain reader sees literal text; at 390 px the toolbar takes 29% of the viewport, so the
mobile layout needs its own toolbar treatment.

Libraries (all MIT): `@tiptap/*` 3.31.3 (core, starter-kit, extension-list, extension-table,
extension-placeholder, markdown, pm), `prosemirror-*` (view 1.42.5, model 1.25.12, state 1.4.4, tables
1.8.5), `@lucide/svelte` 1.17.0 (ISC).

Evidence: `src/routes/prototype/document/_shots/*.png` (eight, desktop + 390 px).

## P3 — Canvas on Svelte Flow. Yes, with three caveats.

Board basics (pan, zoom, drag, marquee, dot grid, minimap, fit-view, real touch pinch at 390 px) all work.
**Real AlfyAI components run inside nodes**: the actual `Chart.svelte` paints its chart, checklist ticks
land in the board JSON, a sticky note is editable, and an `<iframe sandbox="allow-scripts" srcdoc>` mini-app
stays clickable while the board pans and zooms. Frames work (children follow; drag in/out reparents).
Edges draw, follow and delete. The "Alfy arranges" JSON diff works: id-addressed ops
(`add_frame`/`add_node`/`move`/`add_edge`/`update_node`/`remove_node`/`highlight`), an "arranging" pill, and
a brief highlight on changed nodes. Serialisation is plain `{nodes, edges, viewport}` — 6.5 kB for the
sample board. 161 nodes run at ~8.3 ms/frame.

**Caveat 1 — everything is DOM.** One component instance and subtree per node, so cost grows linearly;
heavy live blocks need budgeting or threshold rendering.

**Caveat 2 — Svelte Flow v1 differs from React Flow in ways that fail silently.** Lowercase events,
library-side `addEdge`, `onbeforeconnect` (not `onconnect` — using the React Flow habit creates a duplicate
edge), no `snapToGrid`, a `SelectionMode` enum, and a `.svelte-flow__selection-wrapper` pointer-events trap
that swallows clicks on marquee-selected nodes. Anyone coding this from React Flow memory will lose days.

**Caveat 3 — export and offline fidelity.** PNG export captures Chart.js canvases but **not** iframe
content (a foreignObject clone has no frame document): app blocks would export as empty boxes. MapLibre
needs authed tiles and outbound access, so the offline-honest map block is a static route image — the
existing `map_route` card already degrades to its own inline SVG when tiles 401, which is the shape to
build on. Both need a poster/bitmap strategy.

Libraries: `@xyflow/svelte` 1.7.0 + `@xyflow/system` 0.0.83 (MIT), `html-to-image` 1.11.11 (MIT),
Chart.js 4.5.1 (MIT), MapLibre 6.7.0 (BSD-3), Lucide 1.17.0 (ISC). Route chunk 51 kB gzip; Chart.js
(776 kB) and MapLibre (474 kB) lazy-load only when those blocks mount.

Evidence: `src/routes/prototype/canvas/_shots/*.png` and `_probe.mjs` (reproduces every number above).

---

## What this means for the Feature 2 spec

Validated decisions to encode (see the spec for the full design):

1. **Build order stands:** App → Canvas → Document → Slides, on the shared card + panel.
2. **App generation defaults to thinking off**, with a fact/arithmetic verification pass before the card
   appears.
3. **The App sandbox** is an `<iframe sandbox="allow-scripts">` with a host-injected storage bridge
   (`window.alfy.storage`) and `nodrag`/`nowheel` on the frame so canvas panning does not steal clicks.
4. **Document durability** needs a decision on block identity across sessions before the patch protocol.
   The editor is lazy-loaded, and mobile gets its own toolbar layout.
5. **Canvas** owns its own reparenting hit-test, uses `onbeforeconnect`, budgets DOM-heavy blocks, and
   needs poster frames for app/map blocks in export and offline.
6. **Reuse is real:** Chart.js, checklists, the map card and the app frame all worked inside artifacts
   without being rewritten.
