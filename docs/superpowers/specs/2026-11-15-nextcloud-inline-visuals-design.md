# Nextcloud files in the reply: a picture card and a working link

Date: 2026-11-15
Status: design, awaiting implementation plan

## Why

Someone asked AlfyAI to find a picture in their Nextcloud. It found the right
file and answered with its name and path. To believe the answer they had to
leave the chat and open Nextcloud — the round trip they asked chat to save them.

Two cases came out of that, and they are different jobs:

- **A picture.** Show the picture itself, small, in the reply.
- **Anything else.** Hand over a link that opens the file in Nextcloud.

The second case already half exists: every `files` result carries a Nextcloud
Files-app deep link (`nextcloudWebUiUrl` in `normal-chat-tools/files.ts`), but
the reply surfaces it as a citation row rather than something to click in place.

## The decision, as the person made it

1. **A small square preview beside the file's name, size and date, with the
   Nextcloud link underneath** — option C of the mockup
   (`.superpowers/brainstorm/71700-1794701779/content/01-image-size.html`).
2. **The link is Nextcloud's own URL.** No downloader, no copy of the file
   pulled through AlfyAI, no chooser. "No extra code or fanciness there."
3. **Several matches repeat the same card** into a short row. The person was
   unsure whether they want one or many; one treatment covers both.
4. **AlfyAI may look at the picture it found**, not only hand it over — gated,
   see "Looking" below. The person said yes to this knowing the consequence.
5. **Nextcloud only.** OneDrive keeps exactly today's behaviour.

## Goals

- A found image is recognisable in the reply, without leaving the chat.
- A found document is one click away, in a new tab, with the chat still where
  it was.
- No new table, no new job, no migration.

## Non-goals

- No gallery, no file browser, no previews of documents. A PDF or a scan gets
  the file-type glyph and the link, not a rendered page.
- No download path through AlfyAI.
- No previews for OneDrive.
- No video or audio thumbnails.

## Anti-goals

Each of these would be a failure even if the feature "works":

- The Nextcloud app password, or any signed URL carrying it, reachable from the
  browser.
- A reply that turns into a wall of previews because a folder search matched
  forty JPEGs.
- A cloud model receiving a picture off the person's own server without their
  consent, or without the app saying so.
- A broken or missing preview rendering as a broken image. It must degrade to
  the file-type glyph and still link.

## Constraints that bind it

- **ADR-0068.** The preview address is fetched by the browser without a click.
  It is allowed because it comes from a *tool result* — the `files` tool's own
  output — never from the model's text. `$lib/shared/url-provenance.ts` is the
  shared vocabulary; the markdown sanitizer drops any `src` whose address is not
  proven. An image the reply shows must therefore be one the tool result named.
- **The credential never leaves the server.** The browser holds only an
  app-relative URL with a connection id; the route resolves the secret
  server-side, exactly as `api/connections/immich/thumbnail/[assetId]` does.
- **Vision rules.** If the model is to look, every picture it is sent comes out
  of `prepareImageForModel`, spends the turn's shared thumbnail budget
  (`StepImageQueue`), and only reaches a provider whose `imageMessageParts` is
  explicitly true. A cloud model gets connector pixels only per the person's own
  setting — the decision `decidePhotoLook` already makes for Immich.
- **The preview endpoint is Nextcloud's** (verified against
  `core/Controller/PreviewController.php`, Nextcloud master):
  - `GET /index.php/core/preview.png?file=<path>&x=<w>&y=<h>&a=1&mode=fill&forceIcon=0`
    — by path, `NoAdminRequired`, `NoCSRFRequired`, basic auth works.
  - `GET /index.php/core/preview?fileId=<id>&x=&y=…` — by numeric file id, which
    this app does not currently collect (the adapter requests no `oc:fileid`).
  - `forceIcon=false` answers **404** when no preview exists (or **303** to a
    mime icon if `mimeFallback=true`); `forceIcon=true` silently returns an
    icon, which must not be mistaken for a preview.
  - Both forms take basic auth and need no admin. With a file id in hand (§1)
    the id form is used; the path form stays as the fallback for a server that
    returns none.

## How it works

### 1. Adapter — a file id, a link that opens the file, and a preview

**The file id, because the link must land on the file.** The person was
explicit: opening the folder is not enough.

- `PROPFIND_BODY` and `searchRequestBody` both ask for `<oc:fileid/>` — search
  is the main "find a picture" path, so asking only on list would miss it.
- `parseResponseElement` reads it, `NcFile` carries `fileId?: number`, and
  `FileEntry` (the shared superset in `normal-chat-tools/files.ts`) passes it on.
- `nextcloudWebUiUrl` builds
  `/index.php/apps/files/?dir=<dir>&openfile=<fileId>` — the NC19+ form its own
  comment already calls preferred and currently cannot use — and keeps today's
  `?dir=&scrollto=` only for a result with no id.
- **This changes every existing files citation**, not just the new card: an old
  result now links to the file rather than its folder. That is what was asked
  for, and it is a visible behaviour change the plan must call out; the existing
  `files` tests assert on these URLs and will need updating.

**The preview.** `nextcloudPreview(conn, secret, { fileId, path, size })` in
`connections/providers/nextcloud-files.ts`, beside the other reads:

- Prefers `GET /index.php/core/preview?fileId=<id>&x=&y=&a=1&mode=fill&forceIcon=0`:
  no path to encode and get wrong, and `getFirstNodeById` is already scoped to
  the person's own folder.
- Falls back to `core/preview.png?file=<path>` through
  `normalizeNextcloudPath` (the file's one chokepoint) when there is no id.
- Returns `{ bytes, contentType }`, or `null` on 404 / a non-`image/*`
  content type / an over-cap body.
- **Sets `redirect: "manual"` and treats any 3xx as "no preview".**
  `providerFetch` passes no `redirect` option, so fetch's default `follow`
  applies — and the endpoint's own 303-to-mime-icon (`mimeFallback`) means a
  followed redirect would hand back a *type icon*, silently drawn as the
  picture's preview. This is the one place the Immich route's shape must not be
  copied unread.

### 2. Route — one new proxy

`GET /api/connections/nextcloud/preview?connectionId=&fileId=&size=`
(`&path=` only when the result carries no id)

- `requireApiUser`, then `requireOwnedConnection(…, provider === "nextcloud")`
  — an unknown id and another user's id both 404 identically.
- `fileId` must be a positive integer; `path`, when used, goes through the
  adapter's normaliser and never reaches a URL raw.
- `size` clamped to the two values the UI asks for (96 and 192); anything else
  is 400, not a hint to Nextcloud for a 4000px image.
- Answers bytes with `content-type`, `private, max-age=300`,
  `x-content-type-options: nosniff`, `content-length` — the Immich route's
  headers, for the Immich route's reasons.
- On failure: 404 for "no preview", 502 otherwise, never `err.message` from an
  unknown throw.

### 3. Tool result — two fields

`FilesToolResultItem` gains:

- `previewUrl?: string` — the app route above, only for `image/*` results on a
  Nextcloud connection.
- `webUrl: string` — the Files-app link already computed for citations, now on
  the item so the card does not have to re-derive it.

No field for nominating results: the model cannot name result paths before the
call returns, so it cannot choose which results to show. The card is derived
from the results themselves. (`look` in §5 is the only new input, and it exists
for looking, not for choosing cards.)

**One new per-call field, shaped like `map`.** A persisted tool call keeps
`outputSummary`, a 1,500-character `resultDigest`, `candidates`, flat
`metadata` and `map` — never `results[]` (`ToolCallEntry`,
`messages-types.ts`; `StreamToolCallDetails`, `chat-turn/stream.ts`). So the
card would show a name and a link after a reload, and lose size, date and the
preview address. Add `files?: ToolCallFilesData` to `ToolCallEntry` and the
`tool_call` thinking segment, carrying the card rows exactly as the reply draws
them, the way `map` already carries a route card. Emit it on the tool-call
stream event too, so the live turn and a reload agree. No new table, no
migration — this is a JSON field on an existing row.

### 4. The card

- `files-card-view.ts` — a pure mapper from a stored `files` tool result to card
  rows: `{ name, meta, previewUrl | null, glyph, webUrl }`. Pure, tested without
  a browser, in the shape `image-card-view.ts` and `write-card-view.ts` already
  use.
- A card component drawing the row: preview (or glyph) on the left, name and
  `size · date` beside it, "Open in Nextcloud" underneath. The whole card is one
  link to `webUrl`, `target="_blank"`, so the conversation stays put. Using the
  card replaces the in-app lightbox for these images: the picture's job is to
  confirm "that one", and the click's job is to get the person to the file.
- Placement: **below the reply's prose**, in the `message-deliverables` area
  `MessageBubble.svelte` already uses for artifact cards. The person asked for
  the card *in the answer*; the two cheaper placements are both wrong —
  `ToolActivityRow`'s expandable body hides it behind a chevron, and
  `FileProductionCard`'s pinned row lives inside `ThinkingBlock`, above the
  prose and only once the rail collapses. Below the prose also keeps F16
  ("nothing inserted above prose while streaming") intact: the card arrives
  under the text as it grows.
- Source of truth: the turn's per-call `files` field (§3), so a reload draws
  the same cards. The live turn reads the same field from the stream event.
- **What becomes a card:** results that are not directories — directories are
  filtered out (which is what the citation builder already does, and why
  `webUrl` stays optional on the item). Images get the preview; every other
  type gets the glyph and the link. A `list` of fifty entries draws the cap and
  no more.
- **Cap: six cards per reply**, not per call — a reply that searches and then
  lists would otherwise draw twelve. Taken in result order across the reply's
  `files` calls, so the cap is computed where the reply's cards are assembled.
- **OneDrive draws no cards.** The mapper gates on the Nextcloud provider, so
  the label is always "Open in Nextcloud" and nothing claims a preview OneDrive
  cannot serve.
- A failed preview request hides the image and shows the glyph. It never shows
  a broken-image icon and never removes the link.

### 5. Looking — the gated half

Only when the model asks (`look: true`, mirroring the `photos` tool):

- **Scope: the `image/*` results of that same call**, in result order, at most
  six, and never more than the turn's `StepImageQueue` has left. A `list` with
  `look` sends the folder's pictures the call returned, not the folder; a look
  that finds the budget spent says so in the result and still returns the
  listing, exactly as `BUDGET_SPENT` does for photos. Nothing downloads until
  the decision below allows it.
- The same `decidePhotoLook` decision the Immich thumbnails use: a cloud chat
  model for a person who keeps connector content local gets no pixels; a model
  that cannot see gets none; the local-model description path is reused, not
  reimplemented.
- Previews queued on the turn's `StepImageQueue` (`prepareImageForModel`, 512
  px), so the turn's eight-thumbnail budget is shared with Immich photos rather
  than doubled.
- The activity row says what was looked at, in the existing vocabulary.

This is separable from the card. The card ships without it; looking is its own
step, and the person's answer covers only what happens once it exists.

### 6. What the model is told

One line added to the `files` tool description: image results carry a preview
card automatically, and the model should not paste file URLs into its reply.
Nothing in the system prompt changes.

## Calls I made, open to challenge

- 96px square in the reply, 192px requested (2× displays).
- Images get a preview; every other type gets a glyph, in v1.
- Six cards per reply, automatic rather than model-chosen; directories are
  filtered out.
- Cards below the prose, not inside the tool row and not pinned above it.
- Clicking the card opens Nextcloud rather than a lightbox.
- `oc:fileid` on both PROPFIND bodies, so the link opens the file and the
  preview can use the id form; the path form is only a fallback.
- OneDrive draws no cards at all: the mapper gates on the Nextcloud provider.

## Left to the builder

- Confirm `openfile=<fileId>` lands on the file on a real server, and whether
  the fallback path form needs a leading slash (`normalizeNextcloudPath` yields
  none today). Both are cheap to check against one live connection.
- Whether `oc:has-preview` is worth a PROPFIND round trip. The 404 fallback is
  cheaper and already handled; reading the property would only save a request.
- Whether the new `files` field rides the existing tool-call stream event or
  needs one more wire field, and whether the conversation-detail read model must
  project it (the card must survive a reload either way).
- End-to-end coverage: the harness has no Nextcloud fake today. Decide between a
  route stub in Playwright and unit-only coverage, and say which.
- Prefetch on hover, and whether the six requests should be lazy (`loading="lazy"`
  is probably enough).

## Done means

- A reply that found one image shows one card; one that found several shows a
  short row.
- A reply that found a PDF shows the glyph and a link that opens that file in
  Nextcloud, not its folder.
- Existing files citations open the file too, and the tests that asserted the
  old folder URL were updated with a reason, not deleted.
- Nothing in the browser can reach the app password.
- Localised in English and Hungarian; the Feature Guide entry for connected
  files describes the preview card and the link.
- `npm run check` clean, `npm test` green, the Fallow step unchanged from its
  baseline, and the named e2e specs for chatting and images run in full.
