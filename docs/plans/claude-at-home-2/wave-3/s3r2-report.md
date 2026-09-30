# S3-R2 report · photos and live web on the board, and Refresh (Slice 3 T2's rest + T7's refresh)

Model: `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-s3r2`, branch `feat/artifacts-s3-live`, base `81c70efb`.
Commits `12d55ef6..18840e9b` (11). No migration. Nothing in `docs/plans/**`. No subagent.

| SHA | What |
|---|---|
| `12d55ef6` | one strict rule for a board's photo and source addresses (`shared/artifacts/block-urls.ts`) — **closes a real bypass in the existing photo rule**, see "Found on the way" |
| `7e37197d` | the listing gains the chat's photo searches and web searches; the client calls the two web reads will use; EN/HU strings |
| `7e1981e4` | `PhotoNode` and `LiveWebNode`, their `BLOCK_META` / registry / loader rows, tests |
| `5c042093` | the two web-read routes, their service (`canvas-web.ts`), the per-reader throttle, tests (real DB, real tool) |
| `038fd212` | the panel provides Refresh and Search-the-web; the menu's "Search the web…" row; `CanvasBoard.setBlockData` |
| `1523871c` | `tests/e2e/artifact-canvas-live.spec.ts` |
| `17ac32d8`, `acf1777f`, `36e88faa`, `1ad490f3` | polish found by looking (a source's site keeps its room; the menu's search is 44 px on a phone); test typing; wording; a pick is validated against the block's schema before it lands |
| `18840e9b` | a search's sources are read back through `web-grounding.ts` (new `groundedWebSourcesFromCandidates`, next to `createGroundedWebCandidates`) instead of re-shaped in the listing; S3-R1's two menu-count specs updated for the new row |

## What I built, per step

### Found on the way (S3-P's photo rule was not a same-origin rule)
`^/(?!/)` accepts `/\evil.example/x.png` and `/<TAB>/evil.example/x.png` (also `/<LF>/…`): a URL parser reads a backslash as a slash and
drops tabs and line breaks, so each resolves to another origin (verified with `new URL`, tests assert the premise). A photo block is the one place a
model can write an address the browser loads on its own, so this was an exfiltration channel (`?d=<page contents>`), and a same-origin path that is
not the thumbnail proxy would make the browser call any route with the reader's cookies. `block-urls.ts` (zod-free, one place) now says a photo is
**exactly** `/api/connections/immich/thumbnail/<safe id>[?connectionId=<safe>]` and a source link a web address a reader could have typed (http(s),
a host, no whitespace/control characters, ≤ 2,000). The block schemas use it (`canvas-blocks.ts`), so it holds on save, on load and for a model's
`update_node`; the listing and the two blocks use the same functions; `PhotoNode`/`LiveWebNode` check again at draw time. `canvas-body.test.ts` pins
the bypass shapes at schema level (mutation-checked against the old regex).

### Step 1 · Photos
- **Listing** (`services/artifacts/chat-blocks.ts`, shared `ChatPhotoBlock`): the chat's finished `photos` calls that found photos, read from the same persisted
  tool-call candidates the chat's own strip reads (`getPhotoCandidates`' criterion, `immichThumbnailUrl`'s mapping), newest first, 12, one block per
  search (≤ 50 photos, the schema's cap), deduped inside a search. **Only the asset id and the proxy address go into the block: never the file
  name/description** the chat keeps for the reader's own screen (the locality gate strips them for the model; a board can be read to a model), so `alt` is never
  written (test: a candidate titled `hospital-visit-…jpg` leaves no trace). A candidate whose `thumbnailPath` is not `/api/assets/<safe id>/thumbnail` is left out.
- **`PhotoNode`** (`nodes/PhotoNode.svelte`, lazy): 3 × 2 thumbnails (`<img>` only for `isPhotoProxyPath`, `draggable=false`, `referrerpolicy=no-referrer`, `loading=lazy`), a
  `+N` pill for the rest; each thumbnail is a named button ("Open photo 2 of 8"); a click opens the chat's own `ImageLightbox` (unchanged, portalled) at that photo over
  every photo that loaded; **focus goes into the viewer's dialog on open and back to the thumbnail on close** (Escape or Close) — `ImageLightbox` itself has no focus
  handling, done in the node; a thumbnail that will not load is a quiet empty tile (`role=img`, "Photo not available") and is left out of the viewer.
- Registry: `photo` row (card, 340×230, `needsPoster: true`, section `chat`), loader (no shell dress), `defaultDataFor` null.

### Step 2 · Live web and Refresh
- **Listing**: the chat's finished `research_web` calls (a `fetch_url` is not a search), each with its query and the sources it returned, rebuilt into the block's own source shape
  from the persisted candidates (`ArtifactSource`, the web-grounding payload's shape — no second shape), `fetchedAt` = when the chat searched. A source whose link is not a web address is
  dropped; a search with no query, a query > 500 or nothing left is not offered (a Refresh must run the whole stored query); one query searched twice is one row at its newest run.
- **`LiveWebNode`** (lazy): the query as the header, the sources as the chat shows them under a search (the site's icon from the app's own `/api/favicon` proxy, title, host; each a link only
  if `isHttpSourceUrl`, `target=_blank rel="noopener noreferrer"`, tooltip = the snippet as plain words), 8 at most + "+N more", "Updated 5 min ago" (kept current by a 30 s tick), a
  **"Not live" badge past one hour** (`LIVEWEB_FRESH_MS`; the spec names the badge, not the window), and **Refresh**: `aria-busy`/`aria-disabled` (not `disabled`, so focus stays), ignores a second
  press, a status line for failed / found nothing / asked too often, aborts when the block goes away. The snapshot is untouched by a failure.
- **`POST /api/artifacts/[id]/blocks/[nodeId]/refresh`** and **`POST /api/artifacts/[id]/blocks/liveweb`** (the Insert menu's new query; not in the spec's four routes, the brief asks for the flow),
  both thin over `services/artifacts/canvas-web.ts` (`refreshCanvasLiveWeb`, `searchCanvasLiveWeb`; facade exports). See "Security review notes" for every rule and its test.
- **Insert menu**: `Search the web…` is a row at the top of "From this chat"; it opens an inline field (own keys, 500 limit, 44 px on a phone), says searching / what went wrong, keeps what was typed,
  aborts and drops the answer when the menu goes away, and hands over the block on success. `InsertMenu` no longer treats arrow keys typed in a text field as menu navigation.
- **Editor**: `refreshBlock`/`searchWeb` are provided through the chat context. A Refresh **saves the reader's last step first**, calls the route, and puts the returned snapshot on the
  board through the new `CanvasBoard.setBlockData(id, data)` (`_lib/board-model.withBlockData`) as **one step of the reader's own**, exactly like a checklist tick: undoable, saved by the board's autosave.
  A pick from the chat is validated against the block's schema before it lands.

## Security review notes (for the Opus review of the refresh route)
Rules (each is a test; file → test names in `canvas-web.test.ts` unless another file is named):
1. **Auth**: `requireApiUser` (401), route tests + e2e (no session → 401 for both routes).
2. **Who/what**: the board through THE scoped read (`readScopedArtifactRow`, `?conversationId=` for incognito) and must be a Canvas; a stranger's board, a missing id, a non-board and an incognito board from outside its chat are
   the same `{ ok:false, reason:"not_found" }` (byte-identical, route + real-DB ownership tests, and the real server in e2e). Ownership is checked BEFORE the query is validated and BEFORE the throttle is charged.
3. **What runs**: the query **stored on the saved board**, found by the block's id, trimmed; a non-liveweb block is `not_refreshable` (422), an unknown block `not_found`. **A map is `not_refreshable`**: a map block stores the ROUTE the map tool returned, no request of its own to repeat.
   The refresh route **never reads the request** (`request.json/text/formData/body/headers` are absent from its source — a test reads the file — and a real `Request` with a hostile body is left `bodyUsed === false`); the mocked-route test uses a Proxy that throws on any property but `signal`.
   The tool is called with exactly `{ query }` (no `objective`, `searchQueries`, `readPages` → no page reads, no `fetch_url`); the only thing sent out is a ≤ 500-char text query to the provider the chat already uses.
4. **Through the one module** (ruling 57): `createResearchWebTool` from `research-web-tool.ts`, on a **session of its own** (`canvas-live:<uuid>` conversation id, fresh `turnId`) so the tool's 30-minute per-conversation cache can never serve the chat's earlier answer as a refresh (test: distinct ids each read). No new import cycle (Fallow circular 4 = baseline).
5. **What comes back**: built field by field from each source, `isHttpSourceUrl` on the link (script/data/scheme-relative/ftp/space/relative all dropped), ≤ 50 sources, then parsed with the block's own shared schema; nothing usable = `no_results` and the stored snapshot is untouched (never a blanked snapshot). Tested against a stub AND against the real tool with only the provider client stubbed (`canvas-web.real-tool.test.ts`: the tool's *compacted* payload leaves an empty `sources` list out — found by that test, `no_results` vs `refresh_failed` is read from it).
6. **Bounded**: 45 s deadline (the tool's own envelope is 60 s) enforced with a race, so it holds even if the tool ignores its signal; aborts on the caller's signal; a caller that is already gone is not searched for.
   **Abort on disconnect**: `event.request.signal` fires for the refresh (a POST with **no body and no content-type**: SvelteKit's node adapter only aborts a request whose body it never consumed) — the client sends exactly that; the `liveweb` route has a JSON body, so its signal is best-effort there (the deadline and throttle bound it).
7. **Throttled** (`canvas-web-limit.ts`, modelled on `connections/recheck-rate-limit.ts`): 10 searches / minute and 2 at once per reader, in memory, `429` with `Retry-After`; a place is freed however the read ends; refused requests (foreign board, wrong block, bad query) spend nothing.
8. **Writes nothing** (see Deviation 1): no version, no body change (test compares the artifacts table and version rows before/after).
9. **Says nothing**: no log line in the module; every failure is a reason code (`refresh_failed` for anything) — a test throws an error containing a key, the query and a status and asserts none reaches the answer; console spies over success / failure / throttle / abort / timeout assert no board title, note text, query or source text is logged. (`researchWebViaParallel`, the tool module and `recordParallelUsage` were read: none logs the query.)
10. **Render side**: source titles/snippets are text (never HTML), the tooltip is `stripToPlainText`'d, a non-web link is plain text; the favicon comes from the app's SSRF-hardened proxy (`validateFaviconDomain`: public DNS names only), never from the site.

Mutation checks (each applied, the targeted suite run, the file restored): 15 on the service/limiter (13 killed; the two survivors are equivalent — a first guard that the query check duplicates for every block that exists, and a pass-through of extra fields that the schema strips anyway), 6 on the routes (all killed), 10 on the two blocks (all killed), 7 on the listing (6 killed; the survivor is the query-length check the block schema repeats), 6 on the section and menu (all killed — one survived until I found its test did not wait long enough for the answer it claimed to drop, and fixed the test), the URL rule against the old regex (killed).

**Residual risks / owner decisions** (not changed, flagged):
- `update_node` works on every kind (ruling 64), so a prompt-injected model can still rewrite a live-web block's `sources` (attacker-chosen `https` links with attacker-chosen titles) or its `query`; the block would then show them and a Refresh would search the rewritten query. Photos are now safe (proxy-only). **Recommendation: `sources`/`fetchedAt` of a live-web block and `items` of a photo block are written only by Refresh/insert, i.e. one allow-list in `board-ops.ts` `stepUpdateNode`** (S3-P's open question 2, same fix).
- The model's own read of a board (`canvas-model.ts`) shows a live-web block by its query and a photo block by its count, so third-party snippets and asset ids are not put in front of the model by `read_artifact`.
- Photo thumbnails carry no `connectionId` (the chat's strip omits it too; the persisted candidate does not keep it): with two Immich connections the proxy serves the first.

## Tests added
`vitest`: ~180 cases in 17 files (new: `block-urls`, `live-web`, `canvas-web` 40, `canvas-web.real-tool` 4, `live-block-nodes` 33, two routes × (mocked + real-scope) 30; extended: `chat-blocks` service +19, `chat-block-data` +5, `ChatBlocksSection` +9, `InsertMenu` +7, `artifacts` client API +9, `web-grounding` +5, `board-model` +5, `block-registry`, `lazy-nodes`, `lazy-node`, `nodes`, `canvas-body`).
Browser (`tests/e2e/artifact-canvas-live.spec.ts`, 16 cases + 6 gated screenshot cases): lists the two groups and the search row (and the private file name is nowhere); a photo search becomes a grid of proxy thumbnails, kept through a reload, data has ids and proxy addresses only; the lightbox over the page (topmost, focus in, arrows page it, the board's block does not move, Escape / Close return focus); a failing thumbnail is a quiet tile and out of the viewer; a hostile stored board (5 shapes incl. `/\`, `/<TAB>/`, `/api/auth/logout`) is dropped with the notice and **no request to the foreign host or the logout route is ever made**; incognito photos/searches listed only for that chat (API); a web search block (links `_blank noopener`, popup has no opener, favicon proxy, `fetchedAt` = when the chat searched); a 3-hour-old search is "Not live"; **Refresh: a bare POST at the block's own address (no body, no content-type), the new sources replace the old, the board saves them as `author: user`, Undo brings the old snapshot back**; a failed refresh leaves the stored board and the version rows identical and works on the next try; 429 / no-results messages; the keyboard alone (button stays focused while busy); the menu's search (query in the body, never the URL; a failure keeps the text; the field keeps its own keys); the real routes' guards against the real server (unknown board, map/note not refreshable, bad queries 400, oversize 413, no session 401); a menu longer than the popover scrolls and End reaches the last row; the phone's 44 px search.
Two of S3-R1's and one of S3-B's specs changed because what they check changed: `artifact-canvas-blocks.spec.ts` counts the menu's rows (there is one more: "Search the web…", also in a chat that made nothing) and presses Enter on "the first chat row" (now the second); `artifact-canvas.spec.ts`'s seeded "block this build cannot draw" was a photo, and every kind has a component now, so it asserts the empty photo block says so and no missing-kind card is drawn.

## Gates (final tree `18840e9b`)
1. `npm run check`: **0 errors, 17 warnings** (the pre-existing 17).
2. `npx biome check src scripts tests`: clean (2,386 files).
3. `npm test`: **985 files passed, 1 skipped; 15,550 tests passed, 2 skipped** (an earlier full run showed two unrelated load flakes — `mineru/client.contract` over real HTTP and `routing/region-manager`, both green alone and in the last two full runs).
4. `npm run build`: exit 0; **32 `Unused CSS selector` + 2 `must have an ARIA role`** (the baseline); chunk guard passes.
5. Playwright (5500), the gate-5 set (`artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation`): the full run on `1ad490f3` was **310 passed, 3 failed, 9 skipped** (22.3 min; the 9 are the gated screenshot cases). The 3: S3-R1's two menu-count specs (they count menu rows; the menu has one more — updated in `18840e9b`) and `artifact-canvas-comments.spec.ts:603` (the phone case: `page.goto … net::ERR_ABORTED`, a navigation race in its own helper, S3-R1 saw the same family on a neighbouring case). **Rerun of `artifact-canvas-blocks`, `-live`, `artifact-canvas` and `-comments` on `18840e9b`: 70 passed, 0 failed** (6.9 min), the comments phone case included. (The web-grounding move came after the full run and touches only the server listing, which `-live` and `-blocks` measure; I reran those specs rather than the whole set again.)
6. Fallow: **124 issues, 4 circular** = baseline, zero added (two findings on the way, fixed: an import of `CanvasBlockData` from `canvas-blocks` in the client API made Fallow report `BlockKind` as a duplicate export — it is imported from `canvas` now; an unused export).
7. `npm run check:migrations`: passes unchanged.

### Editor chunk (`npm run check:artifact-chunks`)
| | target chunk | loads on its own | shared |
|---|---|---|---|
| before (`81c70efb`, measured here) | 226.5 kB raw / 67.5 kB gzip | 5 chunks, 241.3 kB / 73.1 kB | 30 |
| **after** | **227.8 kB raw / 68.0 kB gzip** | 7 chunks, 243.6 kB / 74.1 kB | 31 |

**+1.3 kB raw / +0.5 kB gzip** in the editor's own chunk, +2.3 / +1.0 in what it loads (the two extra chunks are 0.5 kB and 0.4 kB: `block-urls` and `live-web`, which the editor's schemas and the lazy blocks share).
What the editor pays for is plumbing that must be there for a stored block to draw and a Refresh/insert to work: the two `BLOCK_META` rows and their icons, the two loader lines, the schema rules, `withBlockData`/`setBlockData`, the editor's `refreshBlock`/`searchWeb`. **None of the content is in it**: `PhotoNode` 3.2 kB raw (+1.4 kB css), `LiveWebNode` 4.8 kB (+2.8 kB css), `ImageLightbox` (in the photo chunk's imports), and the section (now 8.0 kB with the search form, was 6.5) all load only when a block or the menu needs them.
`@xyflow`/`perfect-freehand` still only in the editor chunk. (`html-to-image` still in no chunk.)

## Screenshots (`…/scratchpad/w3/shots/s3r2/`, Hungarian, not committed; I looked at each)
Taken on the final tree (dev server, stubbed thumbnails and web-read routes), 8 files; light and dark for the board at 1440×900, phone 390×844 light and dark:
- `1440-light-board.png`, `1440-dark-board.png`: the chat's photo search (3 × 2 thumbnails, "+2"), a fresh live-web block ("Frissítve: 5 perce", Frissítés) and a stale one ("Frissítve: 3 órája", "Nem élő"), fitted at 76 %; the query is the header, each source a row with its site's icon, title and host.
- `1440-light-lightbox.png`: the chat's own viewer over the page (caption "3. fénykép", counter "3 / 8", prev/next, close).
- `1440-light-refresh-failed.png`: the stale block after a failed Refresh — "Nem sikerült frissíteni ezt a blokkot." under its footer, sources and badge unchanged.
- `1440-light-insert-menu.png`: "Ebből a beszélgetésből" with the search field open and filled ("időjárás Budapesten") ahead of "Fényképek" (beach · 8 fénykép · 2 perce) and "Webes keresések".
- `390-light-board.png`, `390-dark-board.png`, `390-light-insert-sheet.png`: the board on a phone (67 %) and the sheet with the search field.
What looking found: the site's host was cut to "weather1.exa…" in a 380-wide block, so it now keeps its own room and the title gives way (`17ac32d8`); a Refresh error line sits under the footer and the block simply grows, fine; the phone's search row/field/button measured 44 px (a browser case now asserts it). Element close-ups at 2× (not kept: the folder holds 8) showed the failed-thumbnail tile, the "+2" pill and the focused Frissítés button's ring. Not caused by these blocks but visible in the 390 shots: the fitted board leaves the last of three tall blocks partly under the zoom chip.

## Deviations from the brief / spec, and why
1. **The refresh route writes nothing; the version is the editor's own autosave.** The brief says the route writes the new sources back "as one version authored by the user". I did not, for a reason found in the editor: a server-side write races the editor's autosave (a save in flight when the refresh lands is refused as stale and the editor shows the conflict banner), and the one existing way to adopt a server-side change (`adoptBoard`) treats it as Alfy's (review bar) and declares a *conflict* if the reader edited during the (1–45 s) search. So: the route validates and returns the snapshot (`{ ok, nodeId, data }`, the spec's shape); the editor saves the reader's last step first (the server reads the SAVED board for the query), puts the snapshot on the board as one reader step (`setBlockData`), and the board's autosave writes it — **`author: "user"`, verified in the browser** (`versionRows`), undoable, one writer. "Leave the snapshot untouched with a 422 on failure" holds by construction (nothing is written). If the owner wants the server to write, it is the same seam as `applyArtifactOps` plus an autosave hold in the editor.
2. **A second route, `POST …/blocks/liveweb`** for the menu's "Search the web…" (the brief asks for the flow; the spec's four routes don't have it). Same service, same rules.
3. **The freshness window is 1 hour** (`LIVEWEB_FRESH_MS`); the spec names `artifacts.canvas.staleBadge` and a test ("marks … stale past its freshness window") but no number.
4. **Strings**: I used the spec's own keys where it has them (`artifacts.canvas.refresh`, `refreshFailed`, `staleBadge`); "Updated {when}" is a new key `artifacts.canvas.liveweb.updated` (the brief says "updated N min ago"; the spec's `fetchedAt` key says "Fetched"). The refusal for a refresh is under the footer, not "in the node's meta line".
5. **A map refresh is `422 not_refreshable`** (asked for in the brief: "say so in the report").
6. **The photo URL rule is stricter than S3-P's "same-origin path"**: exactly the thumbnail proxy (see "Found on the way"). A future source of photos widens `PHOTO_PROXY_PATH` in one place.
7. **`alt` is never written** on a photo item (privacy, above); the viewer's caption is "Photo N".
8. **Registry row size for `photo`** (340×230) and `liveweb` (380×300) are mine; both grow with content (`fixedHeight: false`).
9. The listing groups are `photos` and `searches` (`ChatPhotoBlock`, `ChatSearchBlock`); the wire shape of `GET …/chat-blocks` gained two arrays (the client fills them when an older server omits them).
10. **One function added to `web-grounding.ts`** (not in the brief's list of files I own): `groundedWebSourcesFromCandidates`, the inverse of `createGroundedWebCandidates`, because AGENTS.md makes `web-grounding.ts` the one place web sources are shaped and the listing must rebuild them from persisted candidates. Additive, five tests, no change to anything that exists.
11. **The schema's photo/source rules changed** (`canvas-blocks.ts`, S3-P's file): see "Found on the way". S3-P's tests still pass; their external-URL cases are all still refused, more are.

## Open questions
1. `update_node` on a live-web block's `sources`/`query` and on a photo block's `items` (residual risk above): lock them to Refresh/insert?
2. Should a `photos` result keep its connection id so a second Immich account resolves (needs the photos tool to record it on the candidate)?
3. `ImageLightbox` has no focus trap and no focus handling of its own (the chat's use has none either); I return focus from the node. The S6 focus-trap pass could take the lightbox as one of its dialogs.
4. The fitted board on a phone leaves the last of three tall blocks partly under the zoom chip (fit padding is S3-B's; seen in the 390 screenshots, not caused by these blocks).
5. The photo thumbnail is the proxy's thumbnail size: the viewer shows it at that size (a larger size would need a size parameter on the proxy route).
6. `research_web` bills the reader's Parallel allowance per Refresh/search (as a chat's own call does), on a synthetic conversation id (`canvas-live:<uuid>`), so it is not attributed to the board's chat in usage rows.

## Expected merge friction
- `src/lib/i18n/artifacts.ts`: my block sits right after `artifacts.canvas.block.loadFailed` in each language.
- `canvas/_lib/block-meta.ts` / `block-registry.ts` / `lazy-nodes.ts`: two rows / two entries / two loaders appended after `app`.
- `CanvasEditor.svelte`: two imports, two lines in `provideChatContext`, `refreshBlock` after `saveBoardNow`, one entry in `boardApi`'s type; `CanvasBoard.svelte`: `setBlockData` before `place`, one import.
- `client/api/artifacts.ts`: `photos`/`searches` in `fetchCanvasChatBlocks`, then `refreshCanvasBlock` / `searchCanvasWeb` after it. `services/artifacts/index.ts`: one export block after `listCanvasChatBlocks`.
- `shared/artifacts/canvas-blocks.ts`: the photo/source rules now come from `block-urls.ts`; `canvas-limits.ts` gained `PHOTO_MAX_ITEMS`, `SOURCES_MAX`.

## Hand-off

### For S3-X (posters, export, perf)
- Both blocks have `needsPoster: true`. Selectors: `[data-testid="canvas-photo"]` (thumbnails are same-origin `<img loading="lazy">`: an off-screen block's thumbnails may not have loaded at capture time — set `loading="eager"` or wait), `[data-testid="canvas-liveweb"]` (text and same-origin favicons only; the Refresh button and status line should be left out of a capture). A poster of either is a picture of a snapshot; a **refresh drops a stored `poster`** (the new data has none), so S3-X's "re-run capture on data change" covers it.
- Chunks: see the table; the two lazy chunks and the section have their own entries.

### Modules, exports, components, props
- Shared: `shared/artifacts/block-urls.ts` (`isPhotoProxyPath`, `isHttpSourceUrl`), `live-web.ts` (`LIVEWEB_FRESH_MS`, `isLiveWebStale`, `CanvasWebFailure`, `isCanvasWebFailure`), `canvas-limits.ts` (`PHOTO_MAX_ITEMS`, `SOURCES_MAX`), `chat-blocks.ts` (`ChatPhotoBlock`, `ChatSearchBlock`, `CanvasChatBlocks.photos/.searches`).
- Server: facade `refreshCanvasLiveWeb({ userId, artifactId, nodeId, conversationId?, signal? })`, `searchCanvasLiveWeb({ …, query, … })`, `canvasWebFailureStatus(reason)`; `canvas-web-limit.ts` (`acquireWebReadSlot`); routes `api/artifacts/[id]/blocks/[nodeId]/refresh`, `api/artifacts/[id]/blocks/liveweb`.
- Client: `refreshCanvasBlock(artifactId, nodeId, conversationId?, fetchImpl?, signal?)`, `searchCanvasWeb(artifactId, query, conversationId?, fetchImpl?, signal?)` → `{ ok: true, … } | { ok: false, reason: CanvasWebFailure }` (never throws except for the caller's abort).
- Components: `canvas/nodes/PhotoNode.svelte` (no shell dress), `nodes/LiveWebNode.svelte` (`livewebShell`), `canvas/chat-blocks/ChatBlocksSection.svelte` (new prop `search?`), `canvas/_lib/chat-context.ts` (`refreshBlock?`, `searchWeb?`, `BlockRefreshResult`), `_lib/board-model.ts` (`withBlockData`), `CanvasBoard` (`setBlockData(id, data): boolean`).
- Test ids: `canvas-photo`, `canvas-photo-thumb`, `canvas-photo-missing`, `canvas-liveweb`, `canvas-liveweb-source`, `canvas-liveweb-age`, `canvas-liveweb-stale`, `canvas-liveweb-refresh`, `canvas-liveweb-status`, `canvas-chat-websearch`, `canvas-chat-websearch-form`.

### A paragraph for `AGENTS.md`'s Artifacts section (I did not touch it)
> **Photos and live web (Wave 3).** A Canvas can hold the photo searches and web searches its own chat ran. `GET /api/artifacts/[id]/chat-blocks` lists them (`photos`: the asset ids and the app's own thumbnail addresses, never a file name; `searches`: a `research_web` call's query and sources, rebuilt from its persisted candidates). What a board may load or link is one rule (`shared/artifacts/block-urls.ts`): a photo is exactly the Immich thumbnail proxy, a source a web address — the block schemas, the listing and the blocks (`nodes/PhotoNode.svelte`, `LiveWebNode.svelte`, lazy like the other chat blocks) all use it. A live-web block's Refresh and the Insert menu's "Search the web…" are `POST /api/artifacts/[id]/blocks/[nodeId]/refresh` and `…/blocks/liveweb`, thin over `services/artifacts/canvas-web.ts`: they read the stored query from the saved board (never the request), run `research_web` through its own module on a session of their own, allow a few a minute per reader (`canvas-web-limit.ts`), stop at a deadline or when the caller goes, return only web addresses, log nothing, and **write nothing** — the editor puts the snapshot on the board as one step of the reader's own (`CanvasBoard.setBlockData`) and the board's autosave keeps it. A model's `update_node` can still rewrite a live-web block's sources (ruling 64); see the open question.
