# Nextcloud File Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Nextcloud file AlfyAI found — a small preview card for an image, a glyph-and-link card for anything else — and make every files link open the file itself.

**Architecture:** The WebDAV adapter starts reporting `oc:fileid`, which turns the existing Files-app link into a link to the file and allows the preview endpoint to be called by id. A new authenticated proxy route serves preview bytes. The `files` tool attaches a preview address and a link to each image result and a compact card payload to its tool-call entry — the same JSON hole `map_route` already uses — and a new tool-activity body kind draws the cards below the reply's prose.

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Vitest, Playwright, the AI SDK tool boundary, Nextcloud WebDAV + preview API.

**Spec:** `docs/superpowers/specs/2026-11-15-nextcloud-inline-visuals-design.md`

## Global Constraints

- Svelte 5 runes only: `$props()`, `$state()`, `$derived()`, `onclick` attributes. No `on:` directives, no `<slot>`, no `createEventDispatcher`.
- Every new user-facing string goes in BOTH the `en` and `hu` dictionaries in `src/lib/i18n/chat.ts`; the dictionaries must stay key-identical.
- No new table and no migration. The card data rides a JSON field on the existing tool-call entry.
- Icons come from `@lucide/svelte`. No hand-written inline `<svg>`.
- The Nextcloud app password never reaches the browser: the only preview address the client sees is app-relative and carries a connection id.
- An image the reply draws must be an address a tool result named (ADR-0068). Never a URL the model wrote.
- `npm run check` stays at 0 errors and 0 warnings; `npm run build` at zero warnings.
- Never run `npm run check` or `npm test` while `npm run build` is running — they share `.svelte-kit/`.

## Review Focus

1. A preview that 404s, times out or returns junk must draw the file-type glyph and keep the link — never a broken-image icon.
2. A folder listing of fifty photos must not fire fifty requests or draw fifty cards: at most six cards per reply, six image fetches.
3. Nextcloud answers `303` to a mime icon when a preview is missing. A followed redirect would draw that icon as the picture: every preview fetch sets `redirect: "manual"`.
4. A server that reports no `oc:fileid` must still work: the link falls back to the folder URL, the preview to the path form.
5. OneDrive results must never draw a Nextcloud card or trigger a preview request.
6. Another user's `connectionId`, or a file id outside the caller's own folder, must 404 without fetching anything upstream.
7. A reload must draw the same cards as the live turn.

## Not in this plan

Spec §5 ("Looking") — the model seeing the pictures it found — is deliberately out of scope. The spec calls it separable, it needs the same `decidePhotoLook`/`StepImageQueue` work the Immich thumbnails already carry, and it is gated by a setting. It gets its own plan once the card ships.

---

### Task 1: Report each file's id

**Files:**
- Modify: `src/lib/server/services/connections/dav/xml.ts` (namespace constants, ~line 23)
- Modify: `src/lib/server/services/connections/providers/nextcloud-files.ts` (`NcFile` ~266, `PROPFIND_BODY` ~404, `parseResponseElement` ~433, `searchRequestBody` ~684)
- Test: `src/lib/server/services/connections/providers/nextcloud-files.read.test.ts`

**Interfaces:**
- Produces: `OC_NS = "http://owncloud.org/ns"` exported from `dav/xml.ts`; `NcFile.fileId?: number` (absent, never `null`, when the server does not report one).

- [x] **Step 1: Write the failing test**

In `nextcloud-files.read.test.ts`, beside the existing `nextcloudSearch` case and reusing that file's `fetch` stub, return a multistatus response whose propstat holds `<oc:fileid>42</oc:fileid>` and assert:

```ts
const files = await nextcloudSearch(CONN, "secret", "lake");
expect(files[0]?.fileId).toBe(42);
```

Add a second case whose propstat has no `<oc:fileid>` and assert `files[0]?.fileId` is `undefined`.

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/server/services/connections/providers/nextcloud-files.read.test.ts`
Expected: FAIL — `fileId` is not on the parsed object.

- [x] **Step 3: Implement**

- `dav/xml.ts`: `export const OC_NS = "http://owncloud.org/ns";` beside `DAV_NS`.
- Both request bodies: declare `xmlns:oc="http://owncloud.org/ns"` on the root element and add `<oc:fileid/>` to the prop list. Both, because search is the main "find a picture" path.
- `NcFile`: `fileId?: number`.
- `parseResponseElement`: read `firstNs(prop, OC_NS, "fileid")`; accept only `/^\d+$/` digits and `Number.parseInt` them; anything else leaves `fileId` undefined.

- [x] **Step 4: Run the test file and the provider's other tests**

Run: `npx vitest run src/lib/server/services/connections/providers/nextcloud-files`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/services/connections/dav/xml.ts \
  src/lib/server/services/connections/providers/nextcloud-files.ts \
  src/lib/server/services/connections/providers/nextcloud-files.read.test.ts
git commit -m "feat(files): ask Nextcloud for each file's id"
```

---

### Task 2: The link opens the file itself

**Files:**
- Modify: `src/lib/server/services/normal-chat-tools/files.ts` (`nextcloudWebUiUrl` ~184, `FileEntry` ~215, `webUrlForConn` ~292, `searchOutcome` ~402, `listOutcome` ~487, `readOutcome` ~575)
- Test: `src/lib/server/services/normal-chat-tools/files.test.ts`

**Interfaces:**
- Consumes: `NcFile.fileId` (Task 1).
- Produces: `FileEntry.fileId?: number`; `nextcloudWebUiUrl(conn, path, fileId?)`; `webUrlForConn(conn, path, fileId, webUrl?)`.

- [x] **Step 1: Write the failing tests**

```ts
it("links to the file itself when the result has an id", () => {
	expect(nextcloudWebUiUrl(ncConn, "/Photos/lake.jpg", 42)).toBe(
		"https://cloud.example.com/index.php/apps/files/?dir=%2FPhotos&openfile=42",
	);
});

it("falls back to the folder link when it has none", () => {
	expect(nextcloudWebUiUrl(ncConn, "/Photos/lake.jpg")).toBe(
		"https://cloud.example.com/index.php/apps/files/?dir=%2FPhotos&scrollto=lake.jpg",
	);
});
```

Export `nextcloudWebUiUrl` for the test (it is module-private today).

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts`
Expected: FAIL — the first expectation receives the `scrollto` URL.

- [x] **Step 3: Implement**

- `nextcloudWebUiUrl(conn, path, fileId?)`: with a positive `fileId`, emit `?dir=<encoded dir>&openfile=<fileId>` (no `scrollto`); without one, keep today's exact string.
- `FileEntry` gains `fileId?: number`; it already accepts `NcFile` structurally, so no mapper changes.
- `webUrlForConn` takes the id and passes it to `nextcloudWebUiUrl`; OneDrive keeps using `webUrl`.
- Every `webUrlForConn(conn, file.path, …)` call site passes `file.fileId`; `readOutcome` passes the id from the `nextcloudStat` call that already precedes `nextcloudReadFile`.

- [x] **Step 4: Run the file's tests**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts`
Expected: PASS. Any existing expectation on the old URL is updated with a comment saying the link now opens the file.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/services/normal-chat-tools/files.ts \
  src/lib/server/services/normal-chat-tools/files.test.ts
git commit -m "feat(files): open the file, not its folder"
```

---

### Task 3: Fetch a preview

**Files:**
- Modify: `src/lib/server/services/connections/providers/nextcloud-files.ts` (new export beside `nextcloudReadFile` ~587)
- Test: `src/lib/server/services/connections/providers/nextcloud-files.preview.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `nextcloudPreview(conn: ConnectionPublic, secret: string, opts: { fileId?: number; path?: string; size: number }, fetchOpt?: FetchOpt): Promise<{ bytes: ArrayBuffer; contentType: string } | null>`

- [x] **Step 1: Write the failing tests**

Cover five cases, each with its own `fetch` stub:

```ts
it("returns the bytes of a real image preview", async () => {
	// 200, content-type image/jpeg, a few bytes
	expect(await nextcloudPreview(CONN, "secret", { fileId: 42, size: 192 })).toEqual({
		bytes: expect.anything(),
		contentType: "image/jpeg",
	});
});

it("treats a missing preview as nothing", async () => {
	// 404
	expect(await nextcloudPreview(CONN, "secret", { fileId: 42, size: 192 })).toBeNull();
});

it("never follows the mime-icon redirect", async () => {
	// 303 with a location; assert the fetch was called with redirect: "manual"
	// and the result is null
});

it("refuses a non-image body", async () => {
	// 200 with content-type text/html
});

it("asks by id, and by path only when there is no id", async () => {
	// inspect the URL the stub received:
	//   …/index.php/core/preview?fileId=42&x=192&y=192&a=1&mode=fill&forceIcon=0
	//   …/index.php/core/preview.png?file=<encoded path>&x=192&y=192&a=1&mode=fill&forceIcon=0
});
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/server/services/connections/providers/nextcloud-files.preview.test.ts`
Expected: FAIL — `nextcloudPreview` is not exported.

- [x] **Step 3: Implement**

- Prefer `GET {serverUrl}/index.php/core/preview` with `fileId`, `x`/`y` = `size`, `a=1`, `mode=fill`, `forceIcon=0`. With no id, use `core/preview.png` and `file=<normalizeNextcloudPath(path)>`.
- Send the existing basic-auth header and the `AlfyAI` user agent, through `providerFetch`.
- **`redirect: "manual"`**, and any 3xx is `null`.
- `404`, `403` and `400` are `null`; a network error or 5xx throws, so the route can answer 502.
- Accept only a `content-type` starting `image/` and not `image/svg+xml`; a `content-length` over 2 MB is `null` before reading the body.

- [x] **Step 4: Run**

Run: `npx vitest run src/lib/server/services/connections/providers/nextcloud-files`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/services/connections/providers/nextcloud-files.ts \
  src/lib/server/services/connections/providers/nextcloud-files.preview.test.ts
git commit -m "feat(files): fetch a Nextcloud preview without following redirects"
```

---

### Task 4: Serve preview bytes to the browser

**Files:**
- Create: `src/routes/api/connections/nextcloud/preview/+server.ts`
- Test: `src/routes/api/connections/nextcloud/preview/preview.test.ts` (new, following the request builder in `src/routes/api/connections/[id]/nextcloud-folders/nextcloud-folders.test.ts`)

**Interfaces:**
- Consumes: `nextcloudPreview` (Task 3).
- Produces: `GET /api/connections/nextcloud/preview?connectionId=<id>&fileId=<n>&size=96|192` (`&path=` only when there is no id) → image bytes.

- [x] **Step 1: Write the failing tests**

```ts
it("serves an owned connection's preview with private caching", async () => {
	// 200, content-type image/jpeg, cache-control "private, max-age=300",
	// x-content-type-options nosniff
});

it("404s another user's connection without fetching", async () => {
	// expect fetch stub not called
});

it("400s a size it did not ask for", async () => {
	// size=4000
});

it("404s when Nextcloud has no preview", async () => {});
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run src/routes/api/connections/nextcloud/preview/preview.test.ts`
Expected: FAIL — the module does not exist.

- [x] **Step 3: Implement**

Mirror `src/routes/api/connections/immich/thumbnail/[assetId]/+server.ts`:
- `requireApiUser`, then `requireOwnedConnection(userId, connectionId, { guard: (c) => c.provider === "nextcloud", notFoundMessage: "Nextcloud connection not found", mismatchStatus: 404 })`.
- `size` must be `"96"` or `"192"`, else 400 — a wrong size is never forwarded upstream.
- `fileId` must be `/^\d+$/` when present; `path` goes through the adapter's normaliser (it throws, which is a 400).
- 200 with `content-type`, `cache-control: private, max-age=300`, `content-length`, `x-content-type-options: nosniff`.
- `null` from the adapter → 404. A thrown error → 502 with a fixed string, never `err.message`.

- [x] **Step 4: Run**

Run: `npx vitest run src/routes/api/connections/nextcloud/preview/preview.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/routes/api/connections/nextcloud/preview
git commit -m "feat(files): serve Nextcloud previews to the browser"
```

---

### Task 5: The tool result carries the preview and the link

**Files:**
- Modify: `src/lib/server/services/normal-chat-tools/files.ts` (`FilesToolResultItem` ~80, `searchOutcome`, `listOutcome`, `readOutcome`, plus new `buildFilesCards`)
- Modify: `src/lib/server/services/normal-chat-tools/index.ts` (the `files` tool's description and its `entry`, ~2019-2075)
- Test: `src/lib/server/services/normal-chat-tools/files.test.ts`

**Interfaces:**
- Consumes: `FileEntry.fileId` (Task 2).
- Produces:
  - In `messages-types.ts`, beside `ToolCallMapData`:

```ts
export interface ToolCallFileCard {
	name: string;
	path: string;
	size: number;
	mtime: string | null;
	contentType: string | null;
	previewUrl: string | null;
	webUrl: string;
}

export interface ToolCallFilesData {
	connectionId: string;
	cards: ToolCallFileCard[];
	total: number;
}
```

  - `FilesToolResultItem` gains `fileId?: number`, `webUrl?: string`, `previewUrl?: string`.
  - `buildFilesCards(conn: ConnectionPublic, results: FilesToolResultItem[]): ToolCallFilesData | null`
  - constants `FILE_CARD_LIMIT = 6` (in `$lib/utils/tool-calls.ts`; `files.ts` imports it) and `FILE_PREVIEW_SIZE = 192` (in `files.ts`).
  - `FilesToolModelPayload` is unchanged — the model still sees `results`, not cards.

> **The six-card cap is per REPLY.** `FILE_CARD_LIMIT` here bounds ONE call's
> stored payload. The cap spec §4 asks for is computed where the reply's cards
> are assembled, not inside the tool: `MessageBubble` applies `capFileCards`
> (`$lib/utils/tool-calls.ts`) across the reply's `files` calls in result order,
> so a search-then-list reply draws six cards in all, a repeated path once, and
> ONE remainder line. This is the wording the final review corrected.

- [x] **Step 1: Write the failing tests**

```ts
it("gives an image a preview and a link to the file", async () => {
	// a Nextcloud search returning lake.jpg with fileId 42
	// result.previewUrl === "/api/connections/nextcloud/preview?connectionId=conn-1&fileId=42&size=192"
	// result.webUrl ends with "&openfile=42"
});

it("gives a document a link but no preview", async () => {
	// invoice.pdf → previewUrl undefined, webUrl present
});

it("never asks for a OneDrive preview", async () => {
	// a onedrive connection returning a .jpg → previewUrl undefined
});

it("keeps six cards and counts the rest", async () => {
	// nine image results → cards.length === 6, total === 9
});

it("leaves directories out of the cards", async () => {
	// a folder result never appears in cards
});
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

- In each outcome, build `webUrl` once through `webUrlForConn` and reuse it for the citation and the result (do not compute it twice).
- `previewUrl` only when `conn.provider === "nextcloud"`, the entry is not a directory, and its `contentType` (or extension, when the server reported none) is an image the app can draw. Reuse `isSeeableImage` from `$lib/shared/file-types/seeable-image` rather than inventing a list.
- `buildFilesCards` maps results to cards in order, drops directories, slices to `FILE_CARD_LIMIT` (one call's payload bound — the reply's own six-card cap is applied at assembly, see the note above), and reports the total. It returns `null` when the connection is not Nextcloud — that is the OneDrive gate, in one place.
- `index.ts`: the `entry` gains `files: buildFilesCards(conn, modelPayload.results)`. The tool description gains one sentence: image results carry a preview card automatically, and the reply must not paste file URLs.

- [x] **Step 4: Run**

Run: `npx vitest run src/lib/server/services/normal-chat-tools/files.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/services/normal-chat-tools/files.ts \
  src/lib/server/services/normal-chat-tools/index.ts \
  src/lib/server/services/normal-chat-tools/files.test.ts
git commit -m "feat(files): give file results a preview card's data"
```

---

### Task 6: Persist the cards and put them on the wire

**Files:**
- Modify: `src/lib/server/services/messages-types.ts` (beside `ToolCallMapData` ~166, `ToolCallEntry` ~207, `ThinkingSegment` ~240)
- Modify: `src/lib/server/services/chat-turn/stream.ts` (every `map: details?.map` site, ~919-1008)
- Test: the existing tool-call event test that asserts `map` (find it with `grep -rn "map_route" src/lib/server/services/**/*.test.ts`)

**Interfaces:**
- Consumes: `ToolCallFileCard` / `ToolCallFilesData` (Task 5).
- Produces: `files?: ToolCallFilesData | null` on both `ToolCallEntry` and the `tool_call` variant of `ThinkingSegment`.

- [x] **Step 1: Write the failing test**

Beside the existing `map` assertion, feed a tool-call detail carrying `files` and assert the emitted segment's `files.cards[0].webUrl` survives.

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run <that test file>`
Expected: FAIL — `files` is dropped.

- [x] **Step 3: Implement**

Add `files?: ToolCallFilesData | null` to `ToolCallEntry` and to the `tool_call` variant of `ThinkingSegment`; forward it beside `map` at every site in `stream.ts` that already forwards `map` (grep `map: details?.map` and `segment.map =`). Nothing else in the pipeline changes — this is the same JSON hole `map_route` uses, so persistence, replay and the conversation read model come for free.

- [x] **Step 4: Run**

Run: `npx vitest run src/lib/server/services/chat-turn`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/services/messages-types.ts src/lib/server/services/chat-turn/stream.ts
git commit -m "feat(files): persist a call's file cards like a map card"
```

---

### Task 7: Draw the card

**Files:**
- Modify: `src/lib/utils/tool-activity.ts` (`ToolActivityBody` ~82, `buildSettledToolActivityItem` ~818)
- Modify: `src/lib/components/chat/ToolActivityRow.svelte` (body branches)
- Modify: `src/lib/i18n/chat.ts` (`en` and `hu`)
- Test: `src/lib/utils/tool-activity.test.ts`, `src/lib/components/chat/ToolActivityRow.test.ts`

**Interfaces:**
- Consumes: `ToolCallFilesData` / `ToolCallFileCard` (Task 6).
- Produces: body `{ kind: "files"; cards: ToolCallFileCard[]; total: number }`, on a row with `pinned: true` and `alwaysOpen: true`.

- [x] **Step 1: Write the failing tests**

```ts
it("pins a files call that found something to show", () => {
	const item = buildToolActivityItem(segmentWith({ files: filesData }), translate);
	expect(item.pinned).toBe(true);
	expect(item.alwaysOpen).toBe(true);
	expect(item.body).toEqual({ kind: "files", cards: filesData.cards, total: 9 });
});

it("leaves a files call with no cards unpinned", () => {
	// files: { cards: [], total: 0 } → pinned false, body null
});
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/utils/tool-activity.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement the row**

- Add the union member; build it in `buildSettledToolActivityItem` before the generic fallbacks, keyed on `segment.name === "files" && segment.files?.cards.length`.
- `pinned` is exactly what `MessageBubble`'s `deliverableItems` selects, so a pinned row lands in `message-deliverables` below the prose — no `MessageBubble` change and no new slot.
- Row verb: reuse the existing `toolActivity.searched` / `toolActivity.read` keys; `meta` stays empty (a card needs no timing).
- Render in `ToolActivityRow.svelte`: a vertical list, one `<a href={card.webUrl} target="_blank" rel="noopener noreferrer external">` per card, holding either
  - `<img src={card.previewUrl} width="96" height="96" loading="lazy" alt="">` with `onerror` swapping in the glyph, or
  - the file-type glyph from `$lib/components/chat/attachment-file-type` when `previewUrl` is null.
  Name, then `size · date` (the existing size/date formatters, not new ones), then the link label.
- Below the list, when `total > cards.length`, one muted line: `{count} more`.
- New keys, in both dictionaries:

```ts
"toolActivity.filesOpen": "Open in Nextcloud",
"toolActivity.filesMore": "{count} more",
"toolActivity.filesPreviewFailed": "Preview unavailable",
```

- [x] **Step 4: Add the component test and run both**

`ToolActivityRow.test.ts`: a card with `previewUrl: null` renders the glyph and still renders an anchor with the `webUrl`.

Run: `npx vitest run src/lib/utils/tool-activity.test.ts src/lib/components/chat/ToolActivityRow.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/utils/tool-activity.ts src/lib/components/chat/ToolActivityRow.svelte \
  src/lib/i18n/chat.ts src/lib/utils/tool-activity.test.ts \
  src/lib/components/chat/ToolActivityRow.test.ts
git commit -m "feat(files): draw found files as cards under the reply"
```

---

### Task 8: Say it in the Guide

**Files:**
- Modify: `src/lib/components/guide/guide-content.ts`
- Modify: `src/lib/i18n/guide.ts`
- Test: `src/lib/components/guide/guide-content.test.ts`

**Interfaces:** none; this is copy in the app's own map of what a person can do.

- [x] **Step 1: Write the failing test**

Extend the existing connected-files guide entry's assertions: its body mentions the preview card and that the link opens the file in Nextcloud.

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/components/guide/guide-content.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Update the connected-files entry's copy in English and Hungarian. No drawing changes: no pictured control moved.

- [x] **Step 4: Run**

Run: `npx vitest run src/lib/components/guide/guide-content.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/components/guide/guide-content.ts src/lib/i18n/guide.ts \
  src/lib/components/guide/guide-content.test.ts
git commit -m "docs(guide): describe found-file cards"
```

---

### Task 9: Gates

- [x] **Step 1: Run the static gates and the specs that cover this**

```bash
scripts/gates.sh agent "$TMPDIR/alfyai-file-cards" --port 4600 \
  tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts \
  tests/e2e/conversation.spec.ts tests/e2e/feature-guide.spec.ts
```

(The plan first named `tests/e2e/images-pipeline.spec.ts`, which covers
`make_image`; the change is chat rendering, so the AGENTS.md "chat send/stream
behavior" set plus the guide spec is what ran.)

Expected: every step 0. If `check` or `build` reports a warning, fix it — this job is not done with warnings.

- [x] **Step 2: Confirm the Fallow step only reports the four known cycles**

Read the run's Fallow line. A new finding is a regression unless it is intentional public API, and must be fixed or documented in this task, not suppressed.

- [ ] **Step 3: Manual smoke against the app's own build** — **not run in this environment** (no Nextcloud account or server). The four things it checks are listed in the Outcome.

Start the built app, connect a Nextcloud account (or point at a real one), ask for a picture by name, and check: the card draws, the picture loads, the link opens the file itself in Nextcloud, and a reload draws the same card.

- [x] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(files): <what the gate found>"
```

## Outcome

All nine tasks landed on `h3-deploy`; Task 9 changed no code. The fourteen commits:

| Commit | What it did |
| --- | --- |
| `0d02a21` | Ask Nextcloud for each file's `oc:fileid` |
| `f6dd009` | Pin `oc:fileid` in both PROPFIND and SEARCH bodies |
| `7a7df54` | Open the file itself (`openfile=<id>`), not its folder |
| `d3b4a32` | Fetch a Nextcloud preview without following redirects |
| `9198faf` | Serve Nextcloud previews to the browser |
| `d87d714` | Lock the preview route's anonymous 401 |
| `cbcec7b` | Give file results a preview card's data |
| `afa2dc5` | Persist a call's file cards like a map card |
| `73a47d1` | Draw found files as cards under the reply |
| `04cac4b` | Keep a card-rendering `files` call out of the thinking rail |
| `3ee833d` | Describe found-file cards in the Feature Guide |
| `3b0162b` | Say a found Nextcloud file comes back as a card |
| `f9d1dda` | Cap a reply's file cards at six, and close the review gaps (final review wave) |
| `6fae1db` | Reconcile the plan, spec and guide design with what shipped (final review wave) |

The last two commits are the final whole-branch review wave: the reply-level
card cap and its tests, then this documentation reconciliation.

### Plan defects found during implementation

- **`conn` was not in scope in `index.ts`.** Task 5 had `index.ts` call
  `buildFilesCards(conn, …)`, but the connection is resolved inside
  `runFilesTool`. `FilesToolOutcome` gained `cards`, built where the connection
  is, and the tool's `entry` passes `outcome.cards`.
- **`deliverableSegments` was artifact-only.** Task 7 assumed a pinned `files`
  row was already what `MessageBubble`'s deliverables list selected; that list
  filters `isArtifactToolCall` only, so a `files` row rendered nowhere.
  `MessageBubble` gained its own files-row list in the same
  `message-deliverables` block.

### Not verifiable here

This environment has no Nextcloud account and no Nextcloud server, so the manual
smoke (Task 9, Step 3) was skipped rather than claimed. Only the person, on a
real server, can confirm:

1. a real Nextcloud returns `oc:fileid` in both the PROPFIND and the SEARCH
   responses the app sends;
2. `openfile=<id>` lands on the file itself, not its parent folder, on their
   Nextcloud version and folder layout;
3. a real preview renders at the 96 px card size (and the server offers a
   preview for that file type at all);
4. clicking a card opens the file in Nextcloud.

The whole change, including the review wave that capped cards per reply, passed `scripts/gates.sh agent` on 6fae1db77: every step at 0 — check 0 errors and 0 warnings in 9,141 files, vitest 26,562 passed (3 skipped), build with zero warnings, Fallow at its four known circular dependencies with `new_vs_baseline=0` — and Playwright 99 passed, 0 failed, 0 flaky, over chat, streaming, conversation and feature-guide.
