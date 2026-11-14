# Picture timing: where the seconds between ComfyUI and the visible picture go

Date: 2026-11-14. Worktree `ui-wishes-2026-11` (branch `wishes/nov-2026`).
Probe: `tests/e2e/images-take-timing.spec.ts` (inert unless `IMAGE_TIMING=1`; the
download probe below is inert unless `IMAGE_TIMING_BYTES=1`).
The timeline probe is measurement only. The download probe it led to is the
evidence for the display-variant fix (last section).

## What was measured

One real turn through the app's own `make_image` tool: the fake OpenAI-compatible
provider calls it, the real image job sends the graph to a fake ComfyUI, the real
runner stores the PNG, and the chat page draws the card. The fake ComfyUI is set
to a known **2 s** render (4 steps x 500 ms).

Command (Node 22, production build, one worker, one server):

```bash
IMAGE_TIMING=1 npx playwright test tests/e2e/images-take-timing.spec.ts \
  --project=chromium --reporter=line --workers=1
```

The spec samples the DOM (page clock), the e2e SQLite file and the fake's own
state every ~100 ms, and watches `/api/conversations/<id>` reads with
`page.on("response")`. Page-vs-spec clock skew stayed at 0-21 ms, so DOM stamps
and the server's `/`-relative stamps are comparable.

Server clock note: `phase_at` is exact milliseconds (server `Date.now()`);
`created_at`, `started_at` and `completed_at` are unix **seconds**, so they only
show the second. The `t+ms` column below is relative to the Send click; a DOM or
poll stamp is accurate to about one ~100 ms sample, a `phase_at` is exact.

## Measured table (canonical run, 2026-11-14 18:42:34 local)

| event | t+ms | clock | source |
|---|---:|---|---|
| SEND pressed | 0 | 18:42:34.706 | spec |
| `POST /api/chat/stream` starts | 208 | 18:42:34.914 | network |
| make_image tool row is **running** | 404 | 18:42:35.110 | DOM (`data-activity-key="call_fake_make_image"`, `data-status`) |
| fake ComfyUI received `POST /prompt` | 405 | 18:42:35.111 | spec poll of the fake |
| `image_jobs` row exists | 405 | 18:42:35.111 | DB (`created_at` 18:42:35.000) |
| `image_jobs.phase = starting` | 405 | 18:42:35.111 | DB, `phase_at` 18:42:35.034 |
| `image_jobs.phase = rendering` | 916 | 18:42:35.622 | DB, `phase_at` 18:42:35.534 |
| `image_jobs.phase = finishing` | 2429 | 18:42:37.135 | DB, `phase_at` 18:42:37.060 |
| fake ComfyUI prompt **done** | 2429 | 18:42:37.135 | fake's own status map |
| `image_jobs.status = succeeded` | 2429 | 18:42:37.135 | DB (`completed_at` 18:42:37.000) |
| `result_file_id` set | 2429 | 18:42:37.135 | DB |
| picture file exists on disk | 2429 | 18:42:37.135 | `existsSync(data/image-files/<chat>/<id>.png)` |
| `held_until` becomes null (released) | 2429 | 18:42:37.135 | DB (was `now + 130 s` at enqueue) |
| `image_cards.picked_take_id` set | 2429 | 18:42:37.135 | DB |
| make_image tool row **done** | 2428 | 18:42:37.134 | DOM |
| assistant final text visible | 2428 | 18:42:37.134 | DOM |
| assistant reply persisted | 2429 | 18:42:37.135 | DB (`messages` row, `created_at` 18:42:37.000) |
| **card element appears** | **2428** | 18:42:37.134 | DOM (`message-deliverables artifact-card`) |
| **card state = ready (real take)** | **2428** | 18:42:37.134 | DOM (`image-card-body[data-state="ready"]` + `image-card-picture`) |
| **`<img>` loaded (`naturalWidth > 0`)** | **2526** | 18:42:37.232 | DOM (560 px thumbnail decoded) |

DB transitions (the whole job row), one row per observed change:

| t+ms | status | phase | phase_at | held_until | result_file_id | picked_take | file on disk |
|---:|---|---|---:|---|---|---|---|
| 405 | running | starting | t+328 | set (130 s left) | - | - | - |
| 916 | running | rendering | t+828 | set (129 s left) | - | - | - |
| 2429 | succeeded | finishing | t+2354 | null | `97b6d052-...` | `285f5b16-...` | true |

## The gap: fake ComfyUI finished -> image visible

Anchored on the server's exact clock (`phase_at(finishing)` = the moment the
follow saw the prompt complete), not on a 100 ms sample:

| from -> to | gap |
|---|---:|
| fake finished -> take succeeded / file stored / card pick / hold released | ~6-20 ms (all in one commit window; the detail read below already saw it) |
| fake finished -> card element drawn (already the real take) | **74 ms** |
| fake finished -> `<img>` decoded and on screen | **172 ms** |

Across four consecutive runs (2 s fake): card element at **73-76 ms** after
`phase_at(finishing)`, `<img>` at **170-173 ms**. Send -> visible PNG was
**2526-2535 ms**, of which the fake's own 2026 ms render is about **80 %**.

## Card vs the stream's tool call, and the detail read

- The card never appears while `make_image` is still running: the running row
  existed at t+404, and the card element first appeared in the same sample as
  the row's `done` (t+2428). There is no earlier placeholder card element at all
  (`withImageCard` draws nothing until the card id/take is known and the read
  model holds it).
- Exactly **one** `/api/conversations/<id>` read happened in the whole turn:

  | # | start t+ | end t+ | duration | HTTP | cards | already had the card | picked take | take status | held | file |
  |---:|---:|---:|---:|---:|---:|---|---|---|---|---|
  | 1 | 2389 | 2396 | 7 ms | 200 | 1 | **yes** | `285f5b16-...` | succeeded | false | `97b6d052-...` |

  It started **after** the take settled (server success at ~t+2360-2385) and
  ended before the card element was sampled (t+2428). Its JSON already carried
  the succeeded take, the pick and the file id, so the card needed no further
  read.
- **No 2.5 s poll read occurred.** The `pollForImageCards` effect arms when the
  streaming `make_image` call is running (t+404); its first interval would have
  fired around t+2.9 s, after the turn was already over. The single read above is
  the runtime's tool-completion hydration, not the poll. A 2.5 s poll cannot
  explain a late picture on this path.

## Which segment dominates

With the fake at 2 s, the dominant segment is the picture server's own render:
**2026 ms of the 2526 ms** from Send to a visible picture (80 %). Everything the
app does after the picture server finishes - store the PNG, succeed the take,
release the 130 s hold, settle the card pick, return the tool result, hydrate the
chat detail, render the card, decode the thumbnail - cost **172 ms** in total
(74 ms to the card, 98 ms more for the image itself). The only multi-second
number in the chain is the generation time itself.

This is evidence about the 2 s fake path only. A real ComfyUI that takes 5-10 s
was not measured here.

## What could not be measured, and why

- **"The assistant reply finishes" in the browser.** `MessageBubble` draws its
  `.message-actions` row (Copy, Regenerate, follow-up chips) only once
  `message.isStreaming` is false. In this probe that row never appeared: not
  within the 1.5 s settle window after the picture (last sample t+4047,
  `replyEnded=false`), and not within a 120 s diagnostic run of the same turn.
  The server had already persisted the assistant row at t+2429, and the final
  text and the card were both on screen. The probe therefore reports the reply's
  **durable** finish (t+2429) as the reply-end stamp; the client-side rendering
  of "finished" is unmeasured. Whether this is the fake-provider harness (the
  message list kept its streaming placeholder) or a real client behaviour was not
  investigated further.
- **The SSE request's end.** `page.on("requestfinished")` for
  `POST /api/chat/stream` never fired, including a 1.5 s (and a 120 s) wait after
  the final text. The probe records the request start (208 ms) and the final text
  instead of a transport close.
- **ComfyUI's real render time, the 5-10 s case, and production hardware.** The
  fake renders in ~2 s on the CPU beside a single worker; no GPU box, network or
  deploy environment was involved.
- **First-byte/first-paint of the PNG.** Only "the browser decoded it"
  (`naturalWidth > 0`, `is-loaded`) is recorded; the load itself was not
  instrumented at the network layer.

## Runs

Four runs on 2026-11-14, the same chain each time; the numbers in this document
are run 5 (18:42). Runs 2-4: card 2438/2431/2437, `<img>` 2535/2528/2535,
`phase_at(finishing)` 2362/2358/2363, each detail read 7-9 ms with the card
already in it.

## The download: which copy the card asks for (2026-11-14, later that day)

The 172 ms above was measured with a small fake PNG. The card's `srcset` was
`thumb 320w, full <width>w`, so any card wider than 320 CSS px at DPR 2 chose
the **original**: at 1280 x 900 the card's `sizes` is 560 px, i.e. 1120 device
px, and the smallest candidate at least that wide was the full PNG. Production
pictures are 2-18 MB, so the real-world wait after ComfyUI was the download,
not the app chain.

Probe (the same spec, second mode): a 2048 x 2048 fake render (4,041,652-byte
PNG, the size class of a production picture), a 1280 x 900 DPR-2 page, and a
CDP `Network.emulateNetworkConditions` throttle of **400 ms latency,
51,200 B/s down** (applied after hydration, so the app's own assets were not
what was being measured; the detail reads, the SSE stream and the picture were).
It records the picture URL the card requested, the response's transfer size
(`Network.loadingFinished.encodedDataLength`) and the time from the take
settling (job `succeeded`) to `<img>` decoded (`naturalWidth > 0`).

```bash
IMAGE_TIMING_BYTES=1 npx playwright test tests/e2e/images-take-timing.spec.ts \
  --project=chromium --reporter=line --workers=1
```

| | before (fixed 320w/full srcset) | after (`?variant=display`) |
|---|---|---|
| URL the card requested | `/api/images/files/<id>?conversationId=…` (`full`) | `…?variant=display&conversationId=…` |
| response | `200 image/png` | `200 image/webp` |
| transfer size | **4,041,652 B** (4.04 MB) | **611,558 B** (0.61 MB) |
| take settled -> `<img>` decoded | **81,229 ms** | **13,599 ms** |
| whole probe | 1.6 min | 26.8 s |

The difference is the picture download: 4.04 MB at 50 KB/s is ~81 s; the
display copy is ~12 s. The app-side chain around it is the same.

**Caveat on the byte ratio.** The fake is smooth colour at 2048 px, which
lossless WebP predicts unusually well: it compresses 6.6x (85 % fewer bytes).
A real photo's lossless WebP is normally 20-40 % smaller than its PNG at the
same pixels, and the 2048 -> 1600 resize removes another ~39 % of the pixels,
so production should see roughly 40-60 % of the PNG's bytes - still the whole
download saved, just less dramatic than the synthetic picture. The URL choice
(`display`, never `full`) and the 1600 px identity are what the fix guarantees.

**Cost of the copy.** It is made once, at store time, before the take settles:
sharp resizes to 1600 and lossless-encodes it in **~725 ms** on this Mac for
both the 2048 px and the 4224 px fake (encoding is on the 1600 px output, so
the cost tracks the output, not the 12 MP input; add the resize read of the
larger PNG). The probe's take settled 723 ms later than the baseline's, which
is this encode. That is the price of never making the person wait for the
original on a slow line; it is paid once per picture, on the server.

## Identity: the display copy is the original at 1600

`storeImageFile` writes `<id>.display.webp` only when the long edge is past
`IMAGE_DISPLAY_LONG_EDGE = 1600`: sharp `fit: "inside"`, `withoutEnlargement`,
`.webp({ lossless: true, exact: true })` (alpha kept; sharp zeroes the RGB
under a fully transparent pixel before encoding, which is invisible and changes
nothing on screen). A picture within 1600 has no variant (its original is
served).

`files.test.ts` decodes both files and downsamples the original to the
variant's size with the same kernel (sharp's default `lanczos3`):

| picture | long edge | PSNR vs the same-kernel downsample |
|---|---:|---:|
| opaque 2048x1536 | 1600x1200 | **Infinity** (pixel-identical) |
| transparent 2048x1536 (alpha 0 / 128 / 255 bands) | 1600x1200 | **Infinity** (pixel-identical) |

Lossless WebP clears the "visibly identical" bar trivially: `files.test.ts`
now asserts **Infinity** for both cases, so a lossy encoder that merely reached
the old PSNR >= 40 dB bar fails the test. The transparent copy keeps alpha 0,
128 and 255 exactly, so the checkerboard and Before / After crossfade behave as
before.

`tests/e2e/images.spec.ts` ("a DPR-2 phone and a large picture") holds the
browser side: at 390x844 DPR 2 with the same 2048 px fake, the card's
`currentSrc` is `?variant=display`, its `srcset` carries the `1600w`
descriptor, and no request for the full PNG is made. The card now also names
its real box (`sizes` 92vw under 768, 352 px above), so a tall picture at a
1280x900 DPR-2 desktop takes its 900w display copy instead of the master
(`"a DPR-2 desktop and a tall picture"`).
