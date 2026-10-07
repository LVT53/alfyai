# FX-E report: the chat's Mermaid makes no call and shows no link a model wrote

Branch `fix/mermaid-hardening` (worktree `art-fxe4`), from `feat/artifacts` d69432e7. Model: Sonnet 5.5 (`claude-sonnet-5-5`).
Commits `d69432e7..b39859a4` (12, first `ee18e482`). Port 5500. Nothing pushed, merged or rebased; no other branch or worktree touched
(one scratch worktree of the base commit was made for the size comparison and removed).

## 1. What was wrong, measured (Mermaid 11.17 in real Chromium, the app's own posture: strict, labels as SVG text)

I read Mermaid's installed code for every place that makes an `<image>`, an `<a>`, a `new Image()` or takes CSS, then
rendered **254 hostile sources over every diagram family** (seven sets, `scratchpad/w4/fxe/attacks*.mjs`, `run.mjs`)
with a stand-in host counting requests. Before: the browser called the host for each of these, while the diagram was
being drawn and before any sanitizer ran (Mermaid draws into the live document and sanitizes only the finished SVG):

| construct | effect |
|---|---|
| `A@{ img: "https://…" }` (also the key spelt `"img"`, single quotes, `? img :`, unquoted, over several lines) | Mermaid decodes the picture itself, twice |
| `%%{init: {"htmlLabels": true}}%%` anywhere, and the same as a front-matter `config:` | HTML labels on, so an `<img>` in a label is loaded; `themeCSS` / `fontFamily` carry CSS |
| CSS `url(…)` in a class or state diagram's `classDef` / `style`, also `\75rl(…)` and `\u\r\l(…)` | the paint server is fetched |
| a sequence diagram's `properties A: {"icon": "https://…"}` (any actor name) | an `<image>` for the actor (found by reading the code, not in the brief) |
| `click … href`, `link`, `links` (flowchart, class, state, Gantt, sequence; after `;`, after `end`, tabs, CRLF) | an `<a>` that survives Mermaid's own sanitizer and the SVG profile |

Front-matter variants that Mermaid reads and the first draft of my check did not (found by probing, fixed): a byte order
mark, lone carriage returns, a no-break space after the dashes.

## 2. What was built

- **`src/lib/shared/artifacts/mermaid-source.ts`** (new, beside CV-A's rule, browser-safe, one pure import): the ONE
  sanitizer. `sanitizeMermaidSource(source) -> { source, removed }` removes, and keeps the rest of the diagram:
  `%%{ }%%` directives; a front-matter block except one plain `title:`; any `@{ }` block that is not plainly
  shape / label / motion / kanban facts / participant type (a plain caption of a removed image shape is kept);
  `click`, `link(s)` and `properties` statements (at a statement start, after `;`, `end`, `direction XX`); the *name* of
  a CSS function that fetches (`url`, `image-set`, `-webkit-image-set`, `src("…")`) or an at-rule that loads (`@import`,
  `@font-face`), escapes and all, broken with a space (`url (`: not a function to CSS, a space in a label). It runs to a
  fixed point (so `cl%%{x}%%ick` and `cl@{…}ick` cannot join), cuts at 51,200 characters (Mermaid's limit is 50,000) and
  comes back empty if it cannot settle. An ordinary diagram comes back byte for byte.
  `mermaidSourceProblem` (ruling 74's door for a model) moved here and is the same list read as a refusal, plus any click
  line and any web address; wording for the four things it named before is unchanged. `MERMAID_SECURE_KEYS`: the
  `secure` list for Mermaid's own wall.
- **`components/chat/Mermaid.svelte`** (the one place Mermaid is called; chat replies, a board's block, and the reader's
  edit of one all draw through it): loads Mermaid and the sanitizer together lazily (one chunk, not in the chat route),
  hands Mermaid `sanitize(source)`, runs with `securityLevel: "strict"`, labels as SVG text, and `secure` = Mermaid's six
  defaults + `htmlLabels, themeCSS, themeVariables, fontFamily, altFontFamily, ticketBaseUrl` (naming the list
  replaces the default, so the six are kept), and puts what was taken out in `data-removed` (no visible note: a note
  needs EN+HU strings and chat-route bytes).
- **`utils/html-sanitizer.ts`** (the SVG gate, `svg: true`): unwraps every `<a>`; keeps an `href` only to `#id` or
  `data:image/…`; scrubs `url()`, `image-set()`, `src("…")`, `@import` from EVERY attribute (it was `style` only) and
  `<style>`, with CSS escapes undone (`utils/css-escapes.ts`, a leaf), and counts an unclosed `url(` (CSS ends it at
  the end of the value, and Chromium then fetches what is left).
- **CV-B's form** needed no code: a reader's typed source is stored as typed and drawn through the same component
  (Playwright case below). The drawn block says nothing of what it left out.
- AGENTS.md: a Core Rules paragraph (what was measured, the one gate, do not call Mermaid elsewhere, do not keep a
  second list, measure a new Mermaid feature that takes an address with a real request count).

## 3. Proof

**Red first, real Chromium (Playwright, `tests/e2e/mermaid-hardening.spec.ts`, 5 cases).** On the unfixed tree
(log `scratchpad/w4/fxe/red1.log`): the reply with 10 hostile diagrams made **8 calls** to the stand-in host (`page.route`
counts), showed links/`<image>` on 7, and two diagrams lost their words (HTML labels stripped by the gate); the stored
board block and the reader's own edit through CV-B's form failed the same way. After: 0 calls, 0 links, every diagram
still drawn with its words; 7 kinds of ordinary diagram (flowchart with style/classDef/class/linkStyle and a shape
block, sequence with `rect rgb()`, class, state, ER, Gantt, pie, plus labels that say click and link) are drawn with
nothing removed (no `data-removed`). One more case draws 17 kinds of hostile SVG as they stand and through the gate
in Chromium: **17 of 17 call out raw, 0 through the gate** (against the base gate 8 still do).

**The no-request proof beyond the spec** (`scratchpad/w4/fxe`): 254 hostile sources, sanitizer alone: **0 requests**
(and with the secure keys as well); raw: 32 sources make requests; benign diagrams render identical SVG with and without
the sanitizer where Mermaid is deterministic (sequence/class differ even raw: random ids). Output gate: 40 SVG snippets
injected into Chromium: 31 call out raw, 0 after the gate.

**Unit tests (red first, mutation-checked):** `mermaid-source.test.ts` 95 (every construct both directions: an ordinary
flowchart/sequence/class/state/ER/Gantt/pie/mindmap/title are unchanged AND Mermaid's own `parse` still reads them;
evasions; fixed point; the door), `html-sanitizer.test.ts` +21 (links, hrefs, attributes, escapes, unclosed, image-set,
timing), `Mermaid.test.ts` +3 and the exact-config assertion (now with `secure`). Switching each rule off fails 3 to 34
tests.

## 4. Robustness: three availability bugs found by timing my own patterns (not in the brief)

A hostile diagram could freeze the reader's tab. Timed the sanitizer on sources built against its own patterns:
- my `@{ }` check was two patterns that could split `a: b, a: b, …` 2^n ways: **24 pairs = 12 s** → one left-to-right
  scanner;
- a title line with a long run of spaces was n²: 1.4 s at 40,000 → a title line over 200 characters is not a title;
- many removed spans on one line were n² (0.35 s) → only the blanks beside a span are walked;
- the **pre-existing** url() pattern in the SVG gate (`html-sanitizer.ts`) took more than 20 s on `url(` + 40,000
  spaces, and every unclosed `url(` / `image-set(` read to the end again → one pass, each call closed at its first
  bracket.
Every shape measured now takes a few ms at the largest source (51 KB); a test holds each to 100 ms. 20,000 random token
soups: worst 2 ms, every output a fixed point.

## 5. Size (ruling 68; baselines NOT moved)

| | base d69432e7 (scratch build, this machine) | mine | gate |
|---|---|---|---|
| chat route, gzip | 542,899 | **543,392** (+493) | baseline 541,489 + 2,048: +1,903 now, 145 left |
| editor first paint (own closure), gzip | 71,918 | **71,915** | ceiling 72,704, unmoved |

The +493 B is `html-sanitizer.ts` (+404, of which the escape decoder 203) and the `Mermaid.svelte` loader/`data-removed`;
the sanitizer, the secure keys and the door are in a lazy chunk and cost the route nothing. If the sanitizer's SVG mode
is wanted out of the route, it can move to a lazy module (only Mermaid uses `svg: true`), at the price of the preview
path importing its CSS scrub from elsewhere; I did not do that refactor.

## 6. Gates

- `npm run check`: 0 errors, 17 warnings (the pre-existing ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1).
- `npx biome check src scripts tests`: clean.
- `npm test`: 17,320 passed, 2 skipped (1,034 files).
- `npm run build`: exit 0, 32 `Unused CSS selector` + 2 `must have an ARIA role`, nothing new.
- `npm run check:artifact-chunks` (own step): **exit 0**; numbers above.
- Fallow: 124 issues, 4 circular (the baseline; my one finding, `MERMAID_SECURE_KEYS` read through `Promise.all`, was
  cleared by reading the lazy import the way Fallow can follow).
- `npm run check:migrations`: passes, no migration.
- Playwright, once, port 5500, every artifact suite + knowledge + chat + conversation + the new spec:
  **552 passed, 23 skipped, 0 failed** (43 min, exit 0), on the final code. (Earlier, the new spec's
  10-diagram page timed out once while the machine was shared with other agents' runs and passed on every rerun since; its
  failure message now says how many diagrams drew and how many gave up. It did not recur in the full run.)

## 7. Screenshots (looked at each) `scratchpad/w4/shots/fx-e/`

`01-chat-1440-light-hu.png`, `02-chat-1440-dark-hu.png`, `03-chat-390-light-hu.png` (a Hungarian reply with an
image-shape + click + directive diagram, a sequence diagram with `properties` and `link`, and a plain flowchart: the
hostile ones are drawn as plain labelled boxes and arrows, no picture, no link, readable in both themes and on a phone),
`04-board-1440-light-hu.png` (a board's diagram block holding the same hostile source, drawn the same). The first
dark capture was a method artefact (class toggled, store not), redone with the colour scheme emulated.

## 8. Decisions and concerns

1. **Remove, not refuse**, for every draw; the model's door still refuses (a board keeps what it is given). A reader's
   typed source is stored as typed and drawn through the gate; the form does not warn (it would need EN+HU strings).
2. **What the gate does not stop and I left alone:** a markdown image in a reply (`![](https://…)`) still loads any
   https address: `svelte.config.js` says so on purpose (`img-src … https:`, CSP default is report-only). Same class
   of exposure, outside Mermaid; the owner should decide it separately. A CSP in enforce mode with a narrow `img-src`
   would also be a complete wall for images and paint servers.
3. **Completeness is by measurement and reading Mermaid 11.17's code**: the places that make an image, a link or take
   CSS are enumerated in the module header; a Mermaid upgrade can add one. AGENTS.md says to re-measure; the 254-source
   harness and the 40-snippet gate harness are in `scratchpad/w4/fxe/` (not in the repo) if you want them kept as a
   script.
4. `link`/`links` for an actor whose name has a space is not removed at the source (the pattern is narrow so a note line
   that starts with "link" is safe); the SVG gate unwraps the `<a>`, so no link is drawn. `properties` is matched
   with any actor name, since a bound would be a way round it. `click A callbackName` (no address) stays: inert in strict.
5. A label that says `url(s)` or `@import` gains a space (`url (s)`), by design; a node called `url(…)` in a flowchart
   would stop parsing (the diagram then shows its source and the note).
6. Chat route +493 B (section 5): the orchestrator records the move.
7. The sanitizer is also the answer to the CV-A concern 1 in full; nothing in `nodes/**` or CV-B's form was touched.

8b. Process notes: one commit (the SVG gate's) was amended once, unpushed, to correct a count in its message; a scratch worktree of
the base was created for the size comparison and removed; my probes and harnesses (`attacks*.mjs`, `run.mjs`, `gate-browser.mjs`,
`fuzz*.mjs`, `redos*.mjs`) are in `scratchpad/w4/fxe/`, outside the repo.

## 9. Hand-off

`shared/artifacts/mermaid-source.ts`: `sanitizeMermaidSource`, `mermaidSourceProblem`, `MERMAID_SECURE_KEYS`.
`utils/css-escapes.ts`: `decodeCssEscapes`. `utils/html-sanitizer.ts`: `sanitizeHtml(…, { svg: true })` is now the diagram's
SVG gate (links, hrefs, every attribute). `Mermaid.svelte`: `data-removed="<kinds, space separated>"` on `.markdown-mermaid`
when the sanitizer took something out (`image-shape shape-block click link properties directive config css-address`).
Test ids/handles for e2e: `.markdown-mermaid`, `.markdown-diagram-error`, `canvas-mermaid`, `canvas-edit-source`.
