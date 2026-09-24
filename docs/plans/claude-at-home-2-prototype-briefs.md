# Feature 2 (Artifacts) — feasibility prototype briefs

Three throwaway prototypes answer the riskiest questions before the Feature 2 spec is written. The mockups
they check against are `claude-at-home-2-artifacts-mockups.html` (App, File) and
`claude-at-home-2-artifact-types-mockups.html` (Canvas, Document, Slides).

**Scope decision (owner, 2026-09-24):** one user only. There is no sharing and no real-time multi-user
sync, so do not add collaboration libraries.

**Rules for all three** (these come from the prototype skill and AGENTS.md):
- **Throwaway.** Each prototype goes on its own branch, `proto/artifact-*`, and is never merged or pushed.
  Mark every file and folder as PROTOTYPE.
- **One command to run.** Each prototype gets an npm script (`proto:apps`, `proto:document`,
  `proto:canvas`).
- **Node 22 only:** `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.
- **Check the current library docs first:** Tiptap v3, `@xyflow/svelte`, Svelte 5.
- **Licences:** MIT or equivalent only. No paid or "Pro" extensions.
- **Show the state.** Each prototype page has a State drawer showing the underlying data live.
- **Report back** per sub-question: works, partly, or no, with the specific obstacle. Include versions,
  licences, bundle size, the 3 biggest risks, the run command, and screenshots.

---

## P1 · Can Qwen write working mini apps? (`proto/artifact-apps-quality`)

**Where:** `scripts/prototype-artifact-apps/`, run with `npm run proto:apps`.

**Endpoint:**
- Use the owner's OpenCode provider that reaches the AlfyAI model. Read its config at runtime.
- **Never print, commit or report the API key.**
- Call the OpenAI-compatible endpoint directly with our own system prompt. Do not use `opencode run` for
  the test itself; its agent prompt and tools would contaminate the result.
- **This is the production model, shared with family.** Send one request at a time, 10 prompts with at
  most 1 retry each, and stop after two 429 or 5xx responses in a row.
- Sampling: temperature 0.6, top_p 0.95, top_k 20, max_tokens 24000.

**The App contract (system prompt draft).** The model returns one self-contained HTML document in an
`html` fence. The document must follow these rules:
- **No network at all:** no CDN, no fonts, no fetch.
- **Inline CSS and JS only,** with no frameworks.
- **AlfyAI's CSS variables:**
  - light: `--pg:#fafaf8; --el:#f4f3ee; --tx:#1a1a1a; --mu:#6b6b6b; --bd:rgba(0,0,0,.08); --ac:#c15f3c`
  - dark: `--pg:#1a1a1a; --el:#242424; --tx:#ececec; --mu:#a0a0a0; --bd:rgba(255,255,255,.08); --ac:#d4836b`
  - fonts: Helvetica for the UI, Georgia for headings
- **Persistence only** through `window.alfy.storage.get/set`, which the host injects.
- **Layout and access:** works at 390 px and on desktop, and is keyboard accessible.
- **Language:** the user's language.
- **Size:** under 400 lines.

**Test prompts:**
1. Trip cost splitter (Levente, Anna, Peti; who paid; who owes whom)
2. HU shopping list with categories, tickable, persistent
3. HUF loan calculator with a yearly table
4. HU flashcards for a 9-year-old (English–Hungarian words, flip cards, score)
5. Budget tracker with a hand-drawn bar chart
6. Pomodoro timer (25/5)
7. HU quiz about the Danube (10 questions)
8. Habit tracker (5 habits × 7 days, streaks)
9. Cooking unit converter
10. Memory card game (8 pairs)

**Evaluation** runs in headless Chromium through Playwright:
- block all network requests
- inject the storage mock
- capture console errors
- run a smoke interaction
- take screenshots at 1280 and 390 px, in light and dark
- check whether the app tried to persist anything

**Verdict per app:** works, works with glitches, or broken.

**Output:**
- `out/results.json`
- a gallery `out/index.html` showing each app live in a sandboxed iframe, with its metrics and screenshots

---

## P2 · Document editor (`proto/artifact-document-editor`)

**Where:** `src/routes/prototype/document/`. Use a public `/prototype/*` path, added in `hooks.server.ts`
behind a `// PROTOTYPE ONLY — never merge` comment. Use a scratch DB at `data/PROTOTYPE-wipe-me.db`.
Run with `npm run proto:document`, then open port 5195.

**Library:** Tiptap v3 core with MIT extensions: StarterKit, TaskList, Table, Placeholder, and Markdown
(official if one exists, otherwise a maintained MIT package).

**Prove each of these:**
- **A. Rich text.** Headings, lists, tickable checklists and tables, all in AlfyAI styling, working at
  390 px.
- **B. Markdown round-trip.** Show the Markdown live, and report exactly what gets lost.
- **C. Targeted "Alfy" edit.** The edit is a patch addressed to block ids. Inserted text is highlighted,
  with Keep and Undo.
- **D. Your words win.** Each block gets a content hash. A patch against a block the user changed after
  Alfy's last read is refused with a visible notice; the other patches still apply.
- **E. Selection bubble.** Offers Ask Alfy and Comment, with canned "Shorter" and "Hungarian" results.
- **F. Tracker table.** A Status dropdown chip and a date chip, including how they serialise.
- **G. Comments.** Anchored to text and shown in the margin. Report what happens when the anchored text
  is deleted.
- **H. Versions.** A version list with restore.
- **I. Size and speed.** Measure the bundle impact, and typing responsiveness on a 5,000-word document.

---

## P3 · Canvas on Svelte Flow (`proto/artifact-canvas`)

**Where:** `src/routes/prototype/canvas/`, using the same public-path and scratch-DB approach. Run with
`npm run proto:canvas`, then open port 5196.

**Library:** `@xyflow/svelte`. Check its version, Svelte 5 support, licence, NodeToolbar, parent nodes,
MiniMap and export options.

**Prove each of these:**
- **A. Board basics.** Pan, zoom, drag, multi-select, dotted background and minimap, plus touch at 390 px.
- **B. Real AlfyAI components as nodes.** This is the key question. Mount:
  - a Chart node, using the real `Chart.svelte`
  - a tickable checklist
  - a map node (try `MapRouteCard`, or explain why it can't work)
  - an editable sticky note
  - a sandboxed iframe mini app that stays clickable while the board pans
- **C. Frames.** A parent node whose children move with it; nodes can be dragged in and out.
- **D. Connectors.** Draw, follow and delete edges.
- **E. "Alfy arranges."** Apply a JSON diff a language model could emit (add a Saturday frame with notes,
  move nodes, add an edge), animated, with an "arranging" pill.
- **F. Serialisation.** Show the board JSON live, round-trip it, and report its size.
- **G. Toolbar.** A floating bottom toolbar with Insert and Ask Alfy, plus a context bar on the selected
  node.
- **H. Scale.** Add 150 notes and report how panning and zooming feel.
- **I. Export.** PNG export, including whether the iframes and chart canvases appear in it.
- **J. Bundle impact.** Also list what Svelte Flow is *not* good for (freehand drawing, rich text in
  nodes).
