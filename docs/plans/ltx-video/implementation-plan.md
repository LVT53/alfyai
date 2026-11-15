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
| 4 | A video take runs: LTX graph, two-segment chain, store, settle | worker-runner (after 2) | `services/images/video/{job,request,runner}.ts`, `comfyui/ltx-templates.ts`, graph JSON, `comfyui/client.ts` (`readHistory` media), `idle-free.ts` | runner unit tests over the fake; chain test with two prompts |
| 5 | The chat model can ask for a video: tool, config, caption | worker-tool (after 4) | `normal-chat-tools/make-video.ts`, `index.ts`, `shared.ts` (timeouts), `env.ts`, `config-store.ts`, `admin-config-registry.ts`, `IntegrationsPage.svelte`, `i18n/settings.ts` | tool tests; config tests; catalogue snapshot |
| 6 | The explicit filter covers video | worker-filter (after 4) | `services/images/picture-check/{index,policy}.ts` (sampled frames), `image-runner` video branch | blocked/unchecked tests |

Slices 1 and 2 are independent and start together. 3 and 4 both follow 2 and do not share
files. 5 follows 4. 6 follows 4.

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
