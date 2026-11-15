# Video in AlfyAI: implementation plan

Date: 2026-11-15. Follows `feasibility.md` in this folder (measurements). This document is
the build contract: slices, write scopes, tests, and the review gates. The orchestrator
owns this file; implementers change only their own scope.

## Goal

A person can ask AlfyAI for a short video. The chat model calls `make_video` with a
motion idea and a length (5 s default, 10 s on request); the take renders two 5 s LTX
segments (10 s) or one (5 s), chains them, stores an mp4 with a poster, and puts a card
in the chat that looks like the picture card and plays in place.

While a video take renders, the card shows the same shell as a picture take: the source
still (or nothing), the card's own shimmer, one status line, and a time on the right —
an estimate when the render reports one, otherwise a clock that counts up.

The picture card gets the same time. It is the same change: one rule for both bodies.

## Non-goals

- No video editing (no trim, no extend, no re-animate), no audio-only, no 1080p tier
  (measured at 76 s; 720p is the product size).
- No change to the Qwen or H3 still paths beyond the card's time line.
- No transparent video, no marks on video, no Before/After compare for video.
- No new top-level service folder: video lives under `src/lib/server/services/images/`
  until it earns its own boundary.
- No deploy in this plan. The orchestrator stops before staging/production.

## The UI contract (grounded, not drawn)

The picture card today is `ImageCardBody.svelte` + `image-card-view.ts`. Its state machine
is `takeState(take, now)`:

| status | condition | state |
|---|---|---|
| queued | — | `waiting` (`ahead`) |
| running | phase `submitted` | `waiting` (`queueAhead`) |
| running | phase `starting` and phase has lasted `STARTING_SHOWN_AFTER_MS` | `starting` |
| running | otherwise | `making` (`etaSeconds`, `progressPercent`) |
| succeeded | — | `ready` |
| cancelled | — | `stopped` |
| failed | — | `failed` |
| — | — | `blocked` / `gone` |

While `busy` the stage has exactly one child — the shimmer layer — and both the state
line and the detail are emitted into **`sr-only` spans**. There is no picture under the
shimmer, no progress bar, and no visible text at all. That is the real reason no
estimate is on screen: `etaSeconds` is written only from a render's progress events
(`image-runner.ts`), `etaLabel` returns null when there is none, and even when it is set
the string only reaches a screen reader. `phaseAt` is on every take view, so elapsed
time is always computable.

**The rule, for both bodies:** a small visible caption inside the shimmer layer shows
the estimate when there is one ("about 8 s left") and otherwise the time this phase has
taken ("0:07"). It is positioned absolutely (bottom-left, the `.image-card-checking`
recipe), so it adds no height and cannot move the aspect box; it is `aria-hidden`, so the
live region still announces only the state and never the ticking time.

Everything else about the card stays as it is: same stage, same aspect box, same
shimmer, same footer, same buttons, no picture under the shimmer (the reference below
died with this audit). A video card reuses that shell and adds exactly three things: a
`VIDEO` badge on the stage, a duration badge when ready, and a play control with a
player. It does not restyle the card.

The implementers read the components for the exact markup and CSS; this document does
not restate them, and no mockup overrides them.

## Data and boundaries

- New artifact kind `video` (`src/lib/shared/artifacts/kinds.ts`), body
  `{ v: 1, fileId, posterFileId, width, height, durationMs, sourceFileId }`.
- `image_files` gains `duration_ms` (nullable integer) — the one new column; a video's
  poster and thumb are derived paths beside `<id>.mp4`, like `.thumb.png` / `.display.webp`.
- Serving: `GET /api/images/files/[fileId]` learns `video/mp4`, `?variant=poster`, and
  **`Range` support** (Safari will not play without it). `?download=1` stays the original.
- Take kinds: a `video` job kind beside `image`, its own limits (1 global, 1 per user)
  and its own deadline constant in its own request module.
- Engines: `otherPictureModels(model)` replaces `otherPictureModel()` so a third engine
  cannot free the wrong server; `COMFYUI_LTX_URL` + `VIDEO_MODEL` are separate from
  `IMAGE_MODEL`, which keeps meaning "which engine makes stills".

## Slices

| # | Outcome | Owner | Write scope | Tests |
|---|---|---|---|---|
| 1 | A picture take always shows a time: estimate when known, clock otherwise | worker-eta | `components/artifacts/image/image-card-view.ts`, `ImageCardBody.svelte`, `image-card-view.test.ts`, `ImageCardBody.test.ts`, `i18n/artifacts.ts` | view unit tests for `stateWords`/elapsed; component test for the detail slot |
| 2 | The `video` kind exists end to end on the server: stored mp4 + poster, served with Range | worker-kind | `shared/artifacts/kinds.ts`, `shared/artifacts/video-body.ts`, `db/schema.ts` + migration, `services/images/video-files.ts`, `routes/api/images/files/[fileId]/+server.ts`, `services/artifacts/serialize/video.ts`, `kinds.test.ts` | migration check; video-files unit tests; route tests for range/poster/download |
| 3 | A video card renders and plays: poster, play, duration, loop, keys | worker-card (after 2) | `components/artifacts/video/**`, `components/artifacts/artifact-bodies.ts`, `ImageCardBody.svelte` only if the shell needs a shared prop, `i18n/artifacts.ts` | component tests; e2e `images-video.spec.ts` |
| 3b | The card is reachable: its data and its buttons reach the chat | worker-wiring (after 3) | `conversation-detail/read-model.ts` + its page loader, `chat/[conversationId]/+page.svelte`, `_helpers.ts`, `MessageBubble.svelte` (props only), a video action client | read-model test; `_helpers` poll test; e2e that a video card appears and its Stop works |
| 4 | A video take runs: LTX graph, two-segment chain, store, settle | worker-runner (after 2) | `services/images/video/{job,request,runner}.ts`, `comfyui/ltx-templates.ts`, graph JSON, `comfyui/client.ts` (`readHistory` media), `idle-free.ts` | runner unit tests over the fake; chain test with two prompts |
| 5 | The chat model can ask for a video: tool, config, caption | worker-tool (after 4) | `normal-chat-tools/make-video.ts`, `index.ts`, `shared.ts` (timeouts), `env.ts`, `config-store.ts`, `admin-config-registry.ts`, `IntegrationsPage.svelte`, `i18n/settings.ts` | tool tests; config tests; catalogue snapshot |
| 6 | ~~The explicit filter covers video~~ — absorbed into slice 4: the runner samples five frames and checks each before anything is stored, failing closed | worker-runner | — | runner tests (`video_blocked`, `video_unchecked`, nothing stored) |
| 7 | An adversarial review of the whole change, by sub-agents who wrote none of it, before anything is deployed | reviewers a-d (after 6) | read-only | findings report, then a re-review of every fix |
| 8 | A clip can be downloaded as a GIF as well as an mp4 | worker-gif (after 4) | `video-files.ts` (gif path + cache), `video/media.ts` (the conversion), the serving route's `?format=gif`, the card's More menu and the panel's download action, i18n | conversion unit test over a stub, route tests (content type, disposition, cache, cleanup), i18n parity |

Slices 1 and 2 are independent and start together. 3 and 4 both follow 2 and do not share
files. 5 follows 4. 6 follows 4.


## Slice 7: the adversarial review gate

Deployment is blocked until this slice passes. It is not an implementation slice; it is the
one that decides whether the other six are true.

**Who.** Four independent sub-agents that wrote none of the code, run in parallel, each
read-only (they report, they do not edit). They see the plan, the diff and the repository —
not my conclusions, not each other's findings, and not the implementers' reports. A
reviewer that finds nothing must say what it could not verify; a clean report from a
reviewer who did not try to break the thing is a failed review.

**Angles, disjoint so the four do not duplicate each other.**

| Reviewer | Owns | Looks for |
|---|---|---|
| A — correctness and lifecycle | the job kind, the runner, the chain, checkpoint/resume, cancel/retry/Stop, SSE and the 750 ms poll | a take that can be submitted twice; a chain that loses its second segment on restart; a cancel that leaves the model rendering; a poll that reads a settled card as active forever; progress or ETA written after success |
| B — security and data | ownership scoping on every new route and variant, `Range` parsing, path derivation and cleanup, the migration, the explicit filter | a video or poster readable by someone who could not read the picture; a byte range that over-reads or under-reports; a cleanup that leaves the mp4 or deletes the poster; a migration that is not expand-only or does not replay; a filter path that fails open |
| C — UX, states and accessibility | the card and player, every state including failed/blocked/stopped/gone, keyboard operation, loop, focus, screen-reader announcements, EN and HU | a state with no way out; a player that traps focus or has no keyboard path; loop that keeps playing after the chat is left; a string in one language only; a control that reads differently from the picture card |
| D — tests and gaps | what the suite now claims versus what it proves | behaviour with no test; a test that would pass with the feature removed; a flaky assertion (animation, polling, timing); a gate step that cannot fail; a spec that only exercises the fake in a way the real service would not |

**What they exercise.** Beyond reading: reviewer B replays the migration on a copy of the
production-shaped database and probes the route with hostile ranges and foreign ids;
reviewer C drives the built app against the fake and uses the player with the keyboard
only, then with reduced motion; reviewer A kills the process mid-take and restarts it, and
stops a take at each phase. Findings need file:line, why it is wrong, how to reproduce, and
a severity.

**Finding levels and the bar.**

- **blocker** — data loss, a security or ownership hole, a take that can hang or double-submit, a migration that cannot replay, the filter failing open.
- **major** — a user-visible state with no exit, a wrong or missing announcement, a language gap, a chain that silently produces one segment, a test that does not test the thing.
- **minor** — polish, wording, a comment that is now false.
- **nit** — taste.

Zero blockers, zero majors, every minor either fixed or recorded with a reason. Every fix is
re-reviewed by the reviewer who raised it (or a fresh one for the same angle) — a fix is not
accepted because it compiles.

**Then, and only then.** `scripts/gates.sh agent …` green in full, the migration replay
recorded, one end-to-end video take proven over the fake, and a staging smoke before
production. Deployment stays a separate, explicit step: the gate says the change is ready,
not that it should ship.

## Slice 8: GIF download

A clip downloads as an mp4 by default and as a GIF on request. On demand, never at store
time: most people download the mp4, and a GIF costs CPU and disk that nothing would use.

- **Route.** `GET /api/images/files/<id>?download=1&format=gif` answers `image/gif` with
  `Content-Disposition: attachment`. `format=mp4` (or absent) is today's behaviour, byte
  for byte. The GIF ignores `Range` (it is small and whole); the mp4 keeps its ranges.
  Ownership scoping is the picture route's own, unchanged.
- **Cached beside the clip.** `<id>.gif` is derived from `storage_path` like `.poster.webp`
  and `.thumb.webp`, made once and served thereafter; the first request makes it
  atomically (write a temp file, rename), one generation in flight per file, a file that
  is not a whole GIF removed and made again once, and a failure falls back to a clear
  error rather than a different format. It is deleted with the clip by every path that
  deletes the clip.
- **The conversion.** ffmpeg through the video take's `media.ts` (the same runner ffmpeg
  already used for the chain): `fps=12`, long edge **480** and never enlarged,
  `flags=lanczos`, a `palettegen`/`paletteuse` pair (`stats_mode=diff`,
  `dither=bayer:bayer_scale=5:diff_mode=rectangle`), `-loop 0`, no audio — a GIF has none,
  and the card does not pretend otherwise.
- **UI.** The card's More menu gains "Download as GIF" under Download, and the panel's
  Download gains the same choice; both are disabled while the take has no file. EN and HU
  for both labels. The mp4 stays the default in both places.

Why 480 px and 12 fps: a 5 s 704×1280 clip at full size is tens of megabytes as a GIF and
looks worse than the mp4; at 480 px and 12 fps it is a few megabytes and still reads at
chat size. The constants live in `video/media.ts`, not in the route.

## Beyond generation: restore, refine, in/outpaint (explore, not committed)

Three capabilities Lightricks ships as **IC-LoRAs** on the same 22B transformer. They are
recorded here so the shape is known; none is in the build queue yet, and each has a
precondition that is the owner's to clear.

| Capability | What it is | Precondition | Reality on this card |
|---|---|---|---|
| **Restore** | reference-conditioned pass that cleans, de-noises and colourises damaged or low-bitrate footage; window 960x544 x 97 frames, overlapping tiles fused every step, long clips chained | the LoRA is **gated** on HF: an account must accept the licence and the box needs a token | the tiled design keeps VRAM tied to the tile, not the frame, so it fits the 26.3 GiB ceiling; cost is minutes per clip, not seconds |
| **Refine Details** | rebuilds texture, edges and grain on soft, compressed or upscaled footage; 1024x576 tiles fused every step | same gated access | a community report puts 97 frames at 768x1376→1216x2112 at 206 s on a 32 GB card; ours is slower per pixel |
| **In/outpainting** | mask-conditioned fill or extension of a clip, two-stage, blended with the original; reuses the 2.3 in-outpainting IC-LoRA, documented as 2.5-compatible | gated; and the **product** work is a mask editor over time | the model side is the small half; painting and tracking a mask on a moving clip is the large half |

**Prerequisites before any of them is a slice:**

1. **A Hugging Face token with the licences accepted.** Both LoRAs answer 401 without
   auth, and no trustworthy mirror exists. Only the account holder can accept them.
2. **Uploaded video.** "Restore an attached clip" needs an attachment path that accepts
   mp4 at all: intake validation, storage, serving with Range, a player for attachments,
   and the vision rules for what a model may be sent of a clip. That is a slice in itself
   and comes before any restore work.
3. **LoRA on a quantised base.** Our transformer is NVFP4; an IC-LoRA has to be applied
   through ComfyUI's quantised LoRA path. That is a measurement, not an assumption.

**On still images, do not use LTX.** It is a video model: a still would be a one-frame
clip, and its temporal conditioning has nothing to work with. For pictures the right tools
are the ones we have (H3's edit path for changes, Qwen or H3 for a re-render) or a
dedicated image upscaler — a different model, not this pipeline.

**On image in-painting, we already have it**: H3's edit graph with marks covers "change
this region of a picture", and it is shipped. Video in-painting is the new thing, and its
cost is the mask UI, not the model.

## Review gates

1. Each worker: TDD note, focused tests, `npm run check` if types moved.
2. Orchestrator: diff review against this contract — no restyled card, no unrelated
   change, EN **and** HU strings, Svelte 5 runes, `@lucide/svelte` icons, config through
   `config-store.ts`.
3. One full gate at the end:
   `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610 tests/e2e/images.spec.ts tests/e2e/images-pipeline.spec.ts tests/e2e/images-video.spec.ts`
4. No deploy.

## Risks

- **The kinds union is load-bearing.** Adding `video` touches the panel, the card
  registry, evidence rows and the guide. Slice 2 owns the union and the serializer; a
  half-added kind breaks surfaces we are not testing.
- **Range requests** are easy to get subtly wrong (byte ranges, ETag per representation,
  `206` and `416`). The route has its own tests; do not "simplify" them.
- **Card visibility during a take** is the thing I got wrong twice. Slice 1's tests must
  assert the rendered line, not just the helper's return value.
- **Two engines, one card shell.** If the video card starts forking `ImageCardBody`'s
  markup, stop and bring it back to a shared piece rather than two copies.

## Decisions taken

- **`make_video` is hidden when `COMFYUI_LTX_URL` is empty**, exactly as `make_image` is
  absent when no picture service is configured. Tool registration gates on
  `isVideoMakingConfigured`, and no refusal path is needed for a tool that is not there.
- **The Feature Guide entry ships with slice 5**, the slice that makes video reachable
  from chat, not with the card in slice 3. The repository rule is that a user-facing
  feature updates its guide entry in the same change; before `make_video` exists there is
  nothing a person can do, and a guide entry for an unreachable feature is a lie. Slice 5
  therefore owns `guide-content.ts`, `i18n/guide.ts` and the drawing if it shows a
  control that changes.
