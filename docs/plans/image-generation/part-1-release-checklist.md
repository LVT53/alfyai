# Alfy can see (part 1): release checklist

What to check, do and decide before part 1 ships. The design is [`design.md`](./design.md) (part 1 is sections 1 to 4), the plan is [`plan-part-1-vision.md`](./plan-part-1-vision.md), and the rules of the code are in `src/lib/server/services/vision/AGENTS.md`. Ask the owner before anything that reads a server's database or box.

## Before merging

- [ ] Dev has not taken migration number `1777140000119` (`drizzle/1777140000119_image_descriptions.sql`, the `image_descriptions` table). Check again just before the merge.

## Checks on the servers before shipping

- [ ] **Image limit.** Flash-Next's vLLM must accept at least 16 images per request (`--limit-mm-per-prompt`; the encoder cache was profiled with one max-size image). A turn sends up to 8 attached pictures (`MAX_TURN_IMAGES`), and the step after a photo look adds up to 8 thumbnails (`STEP_IMAGE_TURN_BUDGET`) to the same request: 16 in all. An over-limit request fails with a 400, which nothing retries, after the `photos` tool has already run. If the limit must stay lower, cap a look's share at the server limit minus the turn's picture count.
- [ ] **Old model rows.** Read-only select, on staging and production, of the `provider_models` rows whose `capabilities_json` mentions `imageMessageParts`. A legacy shape would show as ticked.
- [ ] **sharp on Linux.** After `npm ci` on the box, sharp's `linux-x64` binary is installed and it renders an SVG.
- [ ] **HEIC on ai.dev.** A portrait iPhone HEIC comes out upright. `heic-convert` output has no EXIF, so libheif must apply the rotation stored in the container.
- [ ] **A photo with no text, on staging.** MinerU 4 should answer `empty_result` for a text-free iPhone HEIC. If it answers anything else, the composer chip shows a muted failure clause and the Library row a red "Failed".
- [ ] **The photos timeout.** On Flash-Next, a `photos` call with a describing look plus the Option A summary fits the tool's 20 s timeout. The summary has no deadline of its own.

## Deploy steps

- [ ] Tick "Can see images" on Flash-Next right after the deploy. Until then every turn with a picture tells the model that it cannot see.
- [ ] Tick the summarising model (`memoryConsolidationModel`) too, if people with local summarising on should get local descriptions of their Immich photos.
- [ ] Confirm that both model rows' base URLs are private addresses. A public hostname or a Tailscale `100.x` address counts as cloud (`isPrivateHostname`, `connections/host-locality.ts`), and the cloud rules for Immich photos then apply to that model.

## Measure on ai.dev

- [ ] Whether the background description call, which runs alongside the turn's own model call, slows the time to the first word. If it does, schedule it after the stream ends.
- [ ] What re-sending the attached pictures on every tool step of a tool-heavy turn costs.

## Questions for the owner

- The one-time cloud-connector warning says "Data from your connected accounts (like calendar, email, or files)". Should it now name photos? Its acknowledgement is permanent.
- Should the turn's 8-thumbnail budget reset for a fallback attempt? Today it stays spent, which is the cautious choice.
- Attached pictures get only the transient "Looking at the image…" line and no persistent "Looked at the photo" row, which design section 4.1 asked for. Accept that, or ask for the row?
- BMP pictures are not shown to the model (the prebuilt image library cannot decode them). The design listed bmp; TIF and SVG are shown instead. Accept that?

## Follow-ups

- HEIC decoding blocks the event loop, about 0.8 s for a 12 MP photo. The cheap mitigation is to hand heic-decode's raw RGBA straight to sharp. A worker thread if that is not enough.
- Record usage for the description call before any paid cloud model is ticked "Can see images". Today its spend is not recorded.
- Label each image part ("Picture N: name"). This is the first task of part 2's plan.
- Attempt-aware connector gates. This gap was there before part 1. The text of a connector tool result (photo file names and places, and every other connector's) on a failover attempt is gated for the model the turn started on, not for the attempt's own. It can happen on a plain-loop failover after tools ran, and on a stream whose primary fails before its first output. Fix it before Option A is relied on with a cloud failover target. The code is in `normal-chat-tools/connector-distill.ts`, `normal-chat-tools/index.ts` and `chat-turn/shared-normal-chat-model-run-helpers.ts`.
