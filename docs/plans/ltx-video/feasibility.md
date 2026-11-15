# LTX-2.5 image-to-video on alfyroot: feasibility

Date: 2026-11-15. Measured on the production GPU, not estimated. Everything below was
run through the H3 ComfyUI service (`comfyui-h3.service`, 127.0.0.1:8189) with the
production stack live.

**Verdict: yes, at 5 s and up to 2 MP, chained after an H3 still.** The card holds it
(peak 48,464 of 48,935 MiB, i.e. the same edge H3 already runs at), a warm 720p clip
costs 16-24 s, and 10 s clips are not usable because the scene drifts. It is a third
engine on one GPU, so H3 and LTX can never be resident together, and the app has to
grow a second job kind rather than a flag.

Samples in `samples/`. This document is the record of the trial; nothing here is
implemented yet.

## What was measured

GPU1 is a 48,935 MiB card with **19.9 GiB of non-ComfyUI residents** (embedding
router 8.1, MinerU's vLLM 9.3, reranker 1.5, mineru-kit 1.0). With both ComfyUIs
idle the ceiling is **26.3 GiB**, and H3 at 12 MP already consumes ~26.2 GiB of it.

Model: `ltx-2.5-22b-distilled-transformer-nvfp4` (18.72 GB) + `gemma4-12b` int8
encoder (15.37 GB) + video/audio VAEs + spatial upscaler. 36 GB on disk in
`/home/alfyws/opt/ltx-models`, symlinked into the H3 worktree's `models/`.

| test | output | time | peak GPU1 | notes |
|---|---|---|---|---|
| 5 s, 1280x704, cold | 4.2 MB | **53.1 s** | 48,126 | includes encoder + DiT staging |
| 5 s, 704x1280, warm | 2.1 MB | **27.1 s** | 48,430 | 19-24 s after the first |
| 5 s, 1920x1088 | 8.1 MB | **76.2 s** | 48,192 | full HD, no decode failure |
| 5 s, 704x1280, conv VAE | 2.5 MB | **16.1 s** | 48,430 | 1.5x faster than the diffusion VAE |
| 10 s, 704x1280 | 6.5 MB | 38.1 s | 48,464 | **not usable, see Limits** |
| 5 s, 2 MP (1088x1920) | 4.4 MB | 47.3 s | 48,472 | quality holds |
| 5 s, 960x960 hands | 7.8 MB | 25.1 s | 48,464 | hands survive |
| 5 s, 1152x768 two people | 5.3 MB | 20.0 s | 48,312 | **subject drift** |

Audio is generated jointly and muxed: 48 kHz stereo AAC, alongside h264 video.

### The VAE

LTX ships only bf16 VAEs; there is no int8 VAE. An fp16 conversion was made and
tested — it loads and runs at the same speed as bf16 with visually identical output,
so it is not worth doing (and it is unsupported). The lever is **which decoder**:

| decoder | time (5 s, 704x1280) | high-pass detail |
|---|---|---|
| diffusion VAE, bf16 | 24.0 s | 0.0146 |
| **conv VAE, bf16** | **16.1 s** | **0.0176** |

The conv decoder is faster and measurably crisper on lace and hair. Use it.

### Where the time goes

Per prompt ComfyUI re-stages **14.6 GB Gemma encoder + 17.8 GB DiT + 0.95 GB
upscaler**, because the encoder and the transformer cannot co-reside in 26 GiB. A
cold clip pays that; later clips on the same process do not. Resubmitting an
identical graph returns in 0.01 s (ComfyUI caches it). Batching several clips into
one graph is impossible — peak is already 48.4 of 48.9 GiB.

## Limits observed

- **Duration: 5 s yes, 10 s no.** Over 241 frames the subject drifts: at 10 s the
  model invented a translucent gown and its own lighting, and the face changed. 5 s
  clips stay on-model. Treat 5 s as the product length.
- **Camera instructions are weakly obeyed.** "The camera remains completely still on
  a tripod" held framing for all 121 frames. "A very slight push-in" — even the
  official caption prompt's phrasing — overshoots and ends on a dark crop of the
  subject. Prefer a static camera in the house style.
- **Multiple subjects drift.** With two people the model picks one, pushes in and
  crops the other out of frame. Single-subject clips are reliable; group shots are
  not.
- **Text stays legible** but the framing drifts into a crop, so a menu board loses
  its edges.
- **Hands are fine** — the kneading-hands clip keeps plausible fingers and dough.

## Prompting: use the official instruction, not our guesses

ComfyUI ships the caption instruction the LTX enhancer uses:
`LTX24_I2V_SYSTEM_PROMPT` in `comfy_extras/nodes_textgen.py` (4,661 chars). It
specifies first-frame grounding, one continuous take, objective observable
description, a mandatory shot type + camera motion + viewpoint woven into prose, a
soundscape, chronological flow, and 150-220 words.

**Vendor that text into the app and pin it.** Because it is a model-facing prompt, a
ComfyUI upgrade must not change our captions silently.

Feed it to the **GPU0 chat model** rather than the bundled `gemma4_e2b` enhancer:

- GPU0 already serves an uncensored model on `127.0.0.1:30000` (OpenAI-compatible,
  `qwen3-6-27b`), and a 184-word LTX caption costs **1.7 s / 229 tokens**.
- It adds no VRAM to the card that renders, and it removes the 5.2 GB enhancer model
  from the download and from GPU1 entirely.
- It can carry a house rule on top of the official text: static camera unless the
  user asks to move, 5 s, single subject, no on-screen text. The model follows the
  official style closely when given it (shot type, camera statement, soundscape all
  present).

Also strip container metadata before serving: ComfyUI writes the **whole prompt and
node graph** into the mp4 tags. `--disable-metadata` or `ffmpeg -map_metadata -1`.

## The explicit-picture filter must cover video

This is a requirement, not a detail. When the filter is on for a person, video goes
through the same two gates pictures do, with the same failure codes, so a blocked
clip is never stored and never served:

1. **Before rendering** — `picture-check/request-terms.ts` over the prompt and title,
   refusing `explicit_request` before a card or take exists. Reused unchanged.
2. **After rendering** — the Falconsai classifier over a **sample of frames** (poster
   plus about four across the clip: 0/25/50/75/100%), not one PNG. Any frame over the
   threshold fails the take `image_blocked`; a check that cannot run fails
   `image_unchecked` (fail closed). Five frames is ~0.75 s on the CPU.

A video shows far more than a single frame, so sampling matters more here than for a
still. Uploaded source photos follow the existing rule (they are not classified; only
what the model generated is), and the source still was already classified when it
was made.

The policy switch, the admin exemption and the incognito rule are all reused as-is.

## Licence: read before building

Open weights are **not** watermarked; the hosted API always is (PixelSeal + AudioSeal).
Marking ships as a separate opt-in MIT pack. There is no C2PA anywhere. The licence
forbids removing watermarking/provenance *where present*, defeating filters, and
requires an "AI-generated" disclaimer plus making the licence and AUP enforceable
terms for hosted users.

The **Acceptable Use Policy prohibits sexually explicit content** and "sexual fetishes
or fantasies", and restricts apps with "sexually explicit or suggestive content". That
is close enough to this app's picture use case that it needs a lawyer's read before
video ships. It is a licensing risk, not a technical one.

## What a first slice looks like

Not `make_image` with a flag: a second tool, a second job kind and a video artifact.

1. `VIDEO_MODEL` / `COMFYUI_LTX_URL` + `isVideoMakingConfigured`, separate from
   `IMAGE_MODEL` (which means "which engine makes stills").
2. `otherPictureModels(model): ImageModel[]` replacing `otherPictureModel()`, so the
   pre-take `/free` clears every other engine and never the take's own address.
   Today's two-valued version would free the wrong server.
3. A third ComfyUI unit on `:8190` with
   `Conflicts=comfyui.service comfyui-h3.service`, so systemd enforces the
   one-at-a-time rule that is currently only the app's courtesy.
4. `video_jobs` + `video/video-{job,request,runner,files}.ts`, `<id>.mp4` +
   `<id>.poster.webp`, `duration_ms` on the file row, and `Range` support on the
   serving route (Safari will not play otherwise).
5. `make_video` tool, one still + a motion idea, 5 s fixed, caption from the GPU0
   model.
6. The filter gates above.

The card shows the poster, a play control, the duration and the still it came from.

## Chaining two 5 s clips

Measured: clip A (5 s, locked camera, seed 1001), its **last frame** extracted and fed as
the guide for clip B (seed 1002). Each render was **19.0 s** with the model already
warm, so a 10 s result costs ~38 s against 38.1 s for a single 10 s clip — no saving,
but every clip stays inside the stable window.

- **The seam is invisible.** Frames either side of the join (118-121 of the concatenated
  file) continue the same pose and lighting; ffmpeg concat of two h264 clips is enough.
- **Drift does not reset.** Clip B wandered anyway: by its last frame the model had
  invented a satin robe and pushed the camera in, despite a "camera stays completely
  still" caption. Two 5 s clips accumulate roughly the drift of one 10 s clip, just in
  two steps.

So chaining is mechanically sound but not yet a quality fix. The obvious next
experiment is the shipped **FLF2V** graph, which pins both the first and the last frame
of a segment, so the second half cannot wander off its endpoint.

## Open questions

- Does the caption improvement hold across subjects? One still proved the mechanism,
  not the distribution.
- The 10 s drift may be fixable by splitting into two 5 s clips and chaining the last
  frame, but that doubles cost and drift compounds.
- Whether the 5 s limit is a property of the distilled checkpoint or of our guide
  strength (`LTXVImgToVideoInplace` at 0.7/1.0).

## Replication

- Weights: `/home/alfyws/opt/ltx-models` (36 GB), symlinked into
  `/home/alfyws/opt/comfyui-h3/models/{diffusion_models,text_encoders,vae,latent_upscale_models,checkpoints}`.
  The audio VAE belongs in `models/checkpoints` (`LTXVAudioVAELoader` reads that
  folder) and is loaded by `LTXVAudioVAELoader`, not `VAELoader`.
- Graph: the shipped `video_ltx2_5_i2v` template is a UI subgraph; its API form was
  exported from the ComfyUI frontend (`app.graphToPrompt()`) and the enhancer branch
  removed. The audio-VAE node in the template exports as `VAELoader` and must be
  corrected to `LTXVAudioVAELoader`.
- Seeds 1001/424242 with the harbour and pin-up stills; the scripts used are in
  `/tmp/ltx_*.py` on the box.
