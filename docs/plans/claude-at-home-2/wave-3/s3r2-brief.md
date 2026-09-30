# Canvas agent S3-R2 · photos and live web on the board, and Refresh (Slice 3 T2's rest + T7's refresh)

S3-R1 built the Insert menu's "From this chat" section, its ownership-scoped listing, and the File, App, chart and map
blocks. You add the two blocks the spec flags as **review focus** because nothing in the chat can be reused for them
(ruling 16): **photos** and **live web** — and the Refresh action that re-runs a live-web read. The refresh route makes an
outbound read on the user's behalf: it gets an Opus security review, so make every rule a test.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3r2`, branch
  `feat/artifacts-s3-live` (from `feat/artifacts` after S3-R1's merge), e2e port **5500**, label `s3r2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3r2-report.md`;
  screenshots `…/scratchpad/w3/shots/s3r2/`.
- The orchestrator names the parallel agent when you start. You own `nodes/{Photo,LiveWeb}Node.svelte`, their registry
  rows, the listing's photo and web sources, the refresh route and its service function, and your own e2e file
  `tests/e2e/artifact-canvas-live.spec.ts`.

## Read first

`wave-3/common.md`; the hand-offs of `s3r1-report.md` (the listing and the Insert section), `s3b-report.md`,
`s3p-report.md` (a photo's `imageUrl` must be a same-origin path; a live-web source URL must be http(s)). Rulings 16, 51,
53, 57 (`research_web` has its own module), 64. `slice-3.md` by range: 171–302 (the `photo` and `liveweb` data shapes),
399–414 (their registry rows), 740–750 and 1162–1182 (the refresh route and its failure modes), 1879–1938 (T7: the
refresh tests). Reuse: `chat/ImageLightbox.svelte` (a body-portalled full view, not an in-node gallery), the chat's
source-list rendering for web results, `normal-chat-tools/photos.ts` and the Immich thumbnail proxy route, and
`normal-chat-tools/research-web-tool.ts` / `web-grounding.ts` (the one place web sources are shaped — no second shape).

## Step 1 · Photos

The listing gains this chat's photo results (the Immich searches its replies showed), and `PhotoNode` shows a thumbnail
grid of the same-origin proxy URLs; a click opens `ImageLightbox` over the page. Tests: the URL rule holds at insert and
on load (a foreign URL never reaches an `<img>`), the lightbox opens and returns focus, a missing thumbnail shows a quiet
placeholder, an incognito chat's photos are listed only for that chat.

## Step 2 · Live web and Refresh

- The listing gains this chat's web results (the sources a `research_web` call returned, with its query), and the Insert
  section also takes a **new query** ("Search the web…") that runs `research_web` server-side and inserts the snapshot.
  `LiveWebNode` shows the query, the sources as the chat shows them, and "updated N min ago"; past its freshness window
  (spec) it says it is stale.
- `POST /api/artifacts/[id]/blocks/[nodeId]/refresh`: `requireApiUser`, the facade's ownership scope (incognito by
  `?conversationId=`), only a `liveweb` node (a map refresh only if the stored map data carries its own request —
  otherwise a 422, and say so in the report), re-run `research_web` with the stored query (never a URL taken from the
  body), write the new sources back as **one version authored by the user** (a refresh is the user's act, not an Alfy
  change to review), and leave the snapshot untouched with a 422 on failure. Bounded time, abort on client disconnect.
- Tests (T7's refresh list, 1897–1899, plus): another user's board → 404; a non-liveweb node → 422; the query is the
  stored one; the stored sources pass the http(s) rule; no board content or query text in logs.

## Proof

Screenshots you look at yourself: a board with a photo grid and a live-web block (desktop light/dark, 390×844), the
lightbox open, a stale block, a failed refresh; Hungarian. Report the editor chunk size before and after. Full gates once.
