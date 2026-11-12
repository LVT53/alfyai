# MiniMax-H3-Image on alfyroot: pre-install assessment

> **Update, 2026-11-12 (after the first production run): the 4 MP tier was wrong, and
> so was the checkpoint.** Everything below about fit and speed still holds, but two
> choices made here were replaced:
>
> 1. **4 MP was the wrong canvas.** 4 MP is the model's documented *floor*, not its
>    working size. At 4 MP a full-body person gives the face about 250 px, and the
>    model fills that with wax and chroma mottle; the same prompt at 12-17 MP has
>    pores and individual hairs. The app now renders H3 at **12 MP** (4224x2816 and
>    the other four shapes), and `print` is still a no-op.
> 2. **The NVFP4 checkpoint was the wrong file.** `minimax_h3_image_pruned_nvfp4`
>    is a community re-quant (4.99 bits/param, W4A4, no convrot), not the file the
>    official workflow uses. Measured against Comfy-Org's
>    `minimax_h3_image_pruned_int8_convrot` (8.35 bits/param, W8A16) at the same
>    seed and canvas, int8 is clearly better: real skin texture and eyelashes where
>    NVFP4 is waxy. It also fits: GPU peak 48,384 of 48,935 MiB at 12 and 17 MP,
>    because ComfyUI evicts the 15 GB text encoder while sampling. The app now loads
>    the int8 file.
>
> Measured after the change, 1664 px-wide, seed 424242, 6 steps, CFG 1: 12 MP
> renders in 15-21 s and produces 13-21 MB PNGs; 17 MP renders in 28 s and 22 MB.
> The service's own cgroup cap had to move: `MemoryMax=32G` was sized for 4 MP and
> the int8 model stages 19,999 MB, so the 12 MP peak hit the cap exactly. It is now
> 44G.
>
> The 4 MP numbers in this document are kept as the record of the trial.


Date: 2026-11-12. Scope: read-only inspection of the production picture stack on the
`alfyroot` SSH box (`alfyws.alfyserver.hu`), the MiniMax-H3-Image release and its
NVFP4/GGUF quants, and the AlfyAI integration changes a replacement would need.


## TL;DR

**The isolated 4 MP trial passed on 2026-11-12.** H3-Image fits at the edge after
the 0.6B removal and MinerU 0.2, and it is much faster than Qwen at 4 MP: **3.0 s**
text-to-image (warm) versus Qwen 4 MP **46.2 s** and the current 1 MP p50 **10 s**.
The 4 MP edit was 14.7 s cold; quality is competitive to better on the synthetic room
test. The 4 MP target is validated. The remaining work is the AlfyAI integration
(model switch, 4 MP canvas, 6-step/CFG-1 graphs, `<Picture N>` prompts, transparency
fallback, print/storage, ComfyUI 0.44), not a question of fit or speed.

The trial details are below. The three earlier technical concerns are now measured:
fit is a knife edge (0.3-1.7 GiB free), speed is a clear win at 4 MP, and the
integration is still a moderate refactor.

## What is running now

| Item | Current production state |
|---|---|
| Host | `alfyroot` -> `alfyws.alfyserver.hu`; AlmaLinux; 185 GiB RAM, 31 GiB swap (20 GiB used) |
| GPU0 | RTX PRO 6000 Blackwell, 96 GB; 95,210 MiB (93.0 GiB) used by vLLM Flash-Next (chat model); 2.1 GiB free |
| GPU1 | RTX PRO 5000 Blackwell, 48 GB; 20,861 MiB (20.4 GiB) used, **27.0 GiB free** |
| GPU1 residents | MinerU vLLM 9.64 GiB (0.2 util), Qwen3-Embedding-4B TEI 8.25 GiB, bge reranker 1.53 GiB, ComfyUI ~0.56 GiB; the old 0.6B TEI was removed 2026-11-12 |
| Picture server | ComfyUI **v0.43.0**, commit `426f5eea`, installed 2026-10-27; systemd `comfyui.service`; `127.0.0.1:8188`; GPU1; `--reserve-vram 4.5 --disable-pinned-memory`; `MemoryMax=24G`, `MemorySwapMax=0` |
| Active model | **Qwen-Image-2.1 int8 ConvRot**: DiT 6.8 GB, Qwen3-VL-8B int8 text encoder 8.8 GB, VAE bf16 0.645 GB; 30 steps, CFG 1 |
| Unused file | `NoctQ_V4_int8_convrot.safetensors` (6.8 GB) is symlinked in `models/diffusion_models/` but the active graphs load `qwen_image_2.1_int8_convrot.safetensors`; the `templates.ts` comment mentioning NoctQ is stale |
| App integration | `src/lib/server/services/images/`: API-format graphs (`qwen-image-2.1-{generate,edit}.api.json`), `QWEN_STEPS=30`, 10 image slots, transparent route, `PreviewImage`; job engine, guards, marks, explicit-picture filter |
| Production app | release `573cf3589`; health `{"status":"OK","draining":false,"activeStreams":0}`; `COMFYUI_URL=http://127.0.0.1:8188` in `admin_config` |
| Picture latency | 83 succeeded `image_jobs`: min 6 s, **p50 10 s**, p90 15 s, max 25 s, avg 10.49 s |

The active model is the official Qwen-Image-2.1 int8 ConvRot, not the NoctQ file. The
box is already carrying three GPU1 services besides ComfyUI; that is why the free
VRAM is half the card.


## Trial results (2026-11-12)

The isolated trial ran on GPU1 on a separate ComfyUI **0.44.0** worktree/venv at
commit `ede4e5fe8d`, `comfy-kitchen 0.2.41`, templates 0.11.103, port **8189**,
`MemoryMax=32G`, `--reserve-vram 2`. The live `comfyui.service` (0.43/Qwen) stayed
untouched. The three model files matched the HF LFS SHA-256s.

Fit (nvidia-smi, MiB):

| State | Used | Free |
|---|---:|---:|
| Base after 0.6B removal + MinerU 0.2 | 20,861 | 27,634 |
| H3 loaded, 4 MP peak | 48,192 | 303 |
| H3 loaded, 16 MP run | 46,784 | 1,711 |

All three H3 models (TE 14,956 MB staged, DiT 11,948 MB, VAE 1,114 MB) plus the
20.8 GB of other GPU1 services fit, but at a knife edge: 0.3-1.7 GiB free. The 4 MP
and 16 MP runs completed with no OOM. The 24 GiB cgroup would not have held it; the
trial's 32 GiB did. The production unit's `--reserve-vram 4.5` will need retuning
(the trial used 2).

Speed (wall time from `POST /prompt` to completed history, steady runs):

| Size | H3 NVFP4 |
|---|---:|
| 1 MP | 1.0 s |
| 2 MP | 1.5-2.5 s |
| 4 MP | 3.0 s (first 4.0 s) |
| 8 MP | 7.0-7.8 s |
| 16 MP | 17.9 s |
| Model load | 11.7 s (first 1 MP run) |

Qwen on the same box: **46.2 s** for a 4 MP t2i and **52.8 s** for a 4 MP edit; the
production Qwen 1 MP p50 is 10 s. H3 at 4 MP is **~3x faster than the current 1 MP
p50** at 4x the pixels, and **~15x faster than Qwen at 4 MP**. The H3 4 MP edit was
14.7 s cold (model load included); an identical repeat was 0.5 s (ComfyUI cache), so
a fresh-seed warm edit is expected around 3-4 s; that was not separately measured.

Quality: the 4 MP H3 t2i is more photographic and detailed than Qwen's 4 MP render
on the same prompt. Both render the "ALFY" poster correctly; H3's secondary poster
text is gibberish while Qwen's is clean. The 4 MP H3 edit replaced the sofa with
green velvet and kept the room, pillows, rug, window and poster stable; the Qwen edit
also kept the room but moved the sofa geometry a little more. On this synthetic room
test H3 is at least as good, and clearer on the edit. Samples:
`docs/plans/minimax-h3-image/samples/`.

4 MP is the target: 7-8 MB PNG, 3 s warm, 14.7 s cold. 8 MP is 7-8 s and 14 MB;
16 MP is 17.9 s and 30 MB, above the 25 MB file-production cap, so it stays optional
and needs a cap/downscale if offered.


## What H3-Image is

| Item | H3-Image |
|---|---|
| Release | 2026-11-10, `MiniMaxAI/MiniMax-H3-Image` |
| Architecture | 33.1B dense single-stream DiT (H3 without audio), Qwen3-VL-32B text encoder (33.4B), 0.58B image VAE (24 latent channels, 16x downsampling) |
| Sampling | Distilled to **6 steps, CFG 1**, no negative prompt |
| Canvas | Effective range ~4-20 MP; best at ~16 MP; 4096x4096, 4736x3552, 5472x3072, 6272x2688 etc. |
| References | Up to 16 in the model card; the ComfyUI node accepts `images.image_1..100`, `image_1` is the edit target, prompt refers to `<Picture 1>`, `<Picture 2>`... |
| Alpha / mask | No alpha path in the ComfyUI template or conditioning node; no mask input (the app's pixel guard would still composite) |

Official Comfy-Org repack (`Comfy-Org/MiniMax-H3-Image`):

| File | Size |
|---|---:|
| `minimax_h3_image_pruned_bf16.safetensors` | 40.23 GB |
| `minimax_h3_image_pruned_int8_convrot.safetensors` | 20.98 GB (19.54 GiB) |
| `minimax_h3_image_pruned_w4a8.safetensors` | 12.55 GB (11.69 GiB) |
| `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | 27.14 GB (25.28 GiB) |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15.69 GB (14.61 GiB) |
| `qwen3.5_9b_w4a8_gptq.safetensors` (optional prompt enhancer) | 7.34 GB (6.84 GiB) |
| `minimax_h3_image_vae_fp16.safetensors` | 1.17 GB (1.09 GiB) |

Community NVFP4, the file the request points at indirectly:

- The link given is the **GGUF** repo (`LSDJesus/MiniMax-H3-Image-GGUF`), which holds
  Q2-Q6 GGUF files (9.25-17.5 GB) and requires a ComfyUI-GGUF patch for the
  `minimax_h3` architecture. The NVFP4 file is in the sibling repo
  **`LSDJesus/MiniMax-H3-Image-fp8-nvfp4`**: `minimax_h3_image_pruned_nvfp4.safetensors`,
  12.54 GB (11.68 GiB). It is a drop-in native ComfyUI loader file, no custom node.
- Quantisation covers the same 200 layers (95.8% of weights); the token refiner,
  condition projection, adaLN basis, patch/output projections and norms stay BF16/F32.
  It keeps the per-block int8 attention setting and the PDD metadata.
- Published sampling on RTX PRO 6000 at 2048x2048: **3.4 steps/s NVFP4**, 2.6 int8
  ConvRot, 2.5 w4a8, 2.1 fp8. The card calls int8 ConvRot the most faithful format
  in its own comparisons. No LPIPS/SSIM for NVFP4; only comparison renders.
- Supply chain: the NVFP4 DiT is a community quant (4 likes, ~5.4k downloads at
  inspection), not a MiniMax or Comfy-Org build. Pin SHA-256 and prefer the official
  w4a8 (same 12.55 GB size) if the 1.31-1.36x NVFP4 sampling edge is not worth the
  provenance concern.

### ComfyUI support is newer than v0.44.0

The model card says "ComfyUI 0.44", but the H3-Image support PR
([#17655](https://github.com/Comfy-Org/ComfyUI/pull/17655), "feat: Support
MiniMax-H3-image") merged **2026-11-10 15:11 UTC**, commit
`ede4e5fe8d15445c6fcd6828d70b202c22f9502c`. The v0.44.0 release was published
2026-11-04, before that PR. **Pin the commit, not the tag.** At that commit the
requirements are:

- `comfy-kitchen==0.2.41` (current 0.2.40)
- `comfyui-workflow-templates==0.11.103` (current 0.11.97)
- `comfyui-frontend-package==1.58.5` (current 1.57.4)
- `comfyui-embedded-docs==0.5.16` (current 0.5.15)
- `torch` unpinned (current 2.14.1+cu130 is fine)

The PR tested t2i and edit at 1024x1024 and 2048x2048 in BF16 and int8 on a single
RTX 5090, and compared the output against the official SGLang pipeline. That is
useful evidence that the model runs on 32 GB with ComfyUI's loading, but it does not
measure the 5000 or the 48 GB box.

## Fit: all-resident at the edge after cleanup

| Precision stack | DiT | Text encoder | VAE | Total |
|---|---:|---:|---:|---:|
| Qwen 2.1 int8 (current) | 6.8 GB | 8.8 GB | 0.645 GB | 16.2 GB / 15.1 GiB |
| H3 NVFP4 (community) | 12.54 GB | 15.69 GB | 1.17 GB | **29.4 GB / 27.4 GiB** |
| H3 w4a8 (official) | 12.55 GB | 15.69 GB | 1.17 GB | 29.4 GB / 27.4 GiB |
| H3 int8 ConvRot (official) | 20.98 GB | 27.14 GB | 1.17 GB | 49.3 GB / 45.9 GiB |

After the 0.6B removal and MinerU 0.2, GPU1 has **27.0 GiB free**. The trial loaded
all three H3 models plus the 20.8 GB of other GPU1 services: **48,192 MiB used,
303 MiB free** at the 4 MP peak. The file-size math said 0.4 GiB over; the actual
loader staged 26-27 GiB and the card held it. It fits, but at a knife edge, not with
comfortable headroom. The 24 GiB cgroup would not; the trial's 32 GiB did. The
production `--reserve-vram 4.5` may evict/reload (the trial used 2); tune it during
the integration.

- The largest single H3 model is the text encoder at 14.61 GiB. If the production
  loader evicts, the sequential path still fits; the trial's all-resident path is the
  fast one measured above.
- The 96 GB GPU is the natural home for H3 but has 95,210 MiB (93.0 GiB) used by the
  chat model. The 48 GB 5000 is the only card, and it is at its limit: 4 MP is safe,
  16 MP is tight, 8 MP is the practical maximum if the file-size cap matters.
- The official **int8 ConvRot** (the quality default) does not fit even
  sequentially at 25.28 GiB for the text encoder alone; it is not an option on this
  box. The choice is NVFP4 or w4a8, both 12.5 GiB DiT + 14.6 GiB TE.

### The 0.6B embedder was removed

The app's admin config is on `qwen3-embedding-4b` at `http://127.0.0.1:7999`; that
container (`tei-embed-4b`) stayed up. The old `tei-embed` 0.6B on port 7997 was the
pre-switch rollback container (the embedded-switch memory note says "old
`tei-embed` kept"). It is not used by prod. On 2026-11-12 it was stopped, its
container and compose service were removed, and its 1.2 GB model directory was
deleted; this freed **1.56 GiB** of GPU memory. The old rollback script now points
at a removed port and is no longer a working rollback.

### How much MinerU can be shaved

The vLLM backend is **MinerU2.5-Pro-2605-1.2B**: 2.16 GiB of BF16 weights,
`max_model_len=8192`, and **4.94 GiB of CUDA graph memory**. At
`--gpu-memory-utilization 0.23` it used 10.87 GiB. The fixed model + CUDA graph +
overhead is ~7-8 GiB; the rest is KV cache. On 2026-11-12 the setting was lowered to
**0.2** and the container was recreated. It uses **9.64 GiB**, freeing 1.23 GiB.
Three public PDFs (15, 16 and 26 pages) and a two-at-once run all completed (14-30 s),
with the container healthy, restart count 0, and no error/oom lines. For these
documents 0.2 holds. Freeing ~5 GiB would still need
`--enforce-eager`/disabling CUDA graph memory, a lower `--max-model-len`, or lower
concurrency — all of which can slow or limit extraction and need a longer-document
test. The 0.6B removal plus the MinerU shave bought ~2.8 GiB. The trial then fit all three
H3 models and the base services at 0.3-1.7 GiB free, so it was enough at a knife
edge, but not comfortable.

## Speed: the 4 MP trial is a clear win

The trial measured H3 at 1.0 s (1 MP), 1.5-2.5 s (2 MP), 3.0 s (4 MP), 7.0-7.8 s
(8 MP) and 17.9 s (16 MP), all warm after an 11.7 s model load. Qwen on the same
box took **46.2 s** for 4 MP t2i and **52.8 s** for 4 MP edit; the production Qwen
1 MP p50 is 10 s. The earlier estimate of 8-15 s at 4 MP was pessimistic: the 33B
FP4 model is efficient at its intended 4 MP canvas, while Qwen at 4 MP is slow.

| Case | Current Qwen | H3 NVFP4 (measured) |
|---|---|---|
| 1 MP (current normal) | **p50 10 s, p90 15 s** (83 jobs) | 1.0 s, below the model's intended range |
| 4 MP (target) | 46.2 s t2i / 52.8 s edit | **3.0 s t2i**; 14.7 s cold edit |
| 8 MP | not used | 7.0-7.8 s, 14 MB |
| 16 MP | not used | 17.9 s, 30 MB |
| Sampling | 30 steps at 1 MP | 6 steps; the trial is the real comparison |

H3 at 4 MP is **~3x faster than the current 1 MP p50** at 4x the pixels, and ~15x
faster than Qwen at 4 MP. The 16 MP tier is 1.8x the current p50, within the 2x
budget, but its 30 MB PNG exceeds the 25 MB file-production cap.

The 6-step schedule may give less per-seed variety; test it against "another take"
and retries. NVFP4's main advantage remains size: 12.54 GB versus 20.98 GB for int8,
and the same 12.55 GB as the official w4a8. The trial used the community NVFP4; the
official w4a8 is the safer file if the 1.3x sampling edge is not needed.

## AlfyAI integration: what would change

The good news: the graph builder's slot abstraction mostly maps to H3. The
`MiniMaxH3ImageConditioning` node takes `clip`, optional `vae`, `prompt`, `width`,
`height` and `images.image_1..N`; it outputs `positive` and the image `LATENT`. The
existing `GraphTemplate` slots (prompt, seed, steps, cfg, width, height, image load
nodes, output) fit that shape. The current `templates.contract.test.ts` pins the
Qwen node (`TextEncodeQwenImage21`) and model files; those tests would need an H3
variant.

| Action / assumption | H3 mapping | Work |
|---|---|---|
| Generate | H3 t2i via `MiniMaxH3ImageConditioning` with no images; prompt + 2048x2048 | New graph JSON + template |
| Edit / change | `images.image_1` is the base; `images.image_2..N` references; prompt uses `<Picture N>` | Graph + prompt rules; base first |
| Multi-reference | Node accepts up to 100; model card says 16; app cap is 4 and graph has 10 slots | Raise cap/slots if desired |
| Steps / CFG | 6 / 1, fixed by the distilled model | Per-template `steps`/`cfg`; `QWEN_STEPS` hardcode must go |
| Print | 4 MP normal; 8 MP/16 MP optional; 16 MP is 30 MB, above the 25 MB file cap | 4 MP canvas; `MAX_SIDE` 2752 -> 6272; cap/downscale; tool text; wait budget |
| Transparent | No alpha path in the H3 graph/VAE | Refuse `transparent` for H3 or add a post-process; current `graphFor` silently falls back to opaque |
| Prompt | Model card expects a detailed English caption; template has an optional 9B W4A8 prompt enhancer (7.34 GB, separate `TextGenerateV2` pass) | App's chat model can expand instead; needs a prompt/tool-description change; or accept the extra model/time |
| Marks | H3 conditioning has no mask input; the app's marked copy is a visual hint, not a mask | Prompt change; test H3's behaviour with marks; keep the pixel guard |
| Seed / retry / another take | Same sampler; seed is a KSampler input | No structural change; test variety |
| Explicit-picture filter | Runs on the finished PNG; 4-20 MP input | Check classifier latency/timeout; resizing |
| Title / summary / card / takes | Unchanged | None |
| `startNew` | t2i, no images | None |

Code paths that need touching:

- `src/lib/server/services/images/comfyui/templates.ts` — per-model templates,
  `H3_STEPS=6`, `H3_CFG=1`, `graphFor(mode, transparent, model)`,
  `buildPromptGraph` uses template steps/cfg; H3 graph JSONs.
- `src/lib/server/services/images/requests.ts` — graph selection, slot count,
  reference cap, transparent policy.
- `src/lib/server/services/images/canvas.ts` — 1 MP -> 4 MP normal; 8/16 MP
  optional print; `MAX_SIDE` -> 6272; new `NEW_PICTURE_CANVAS`; the 1024x1024 Qwen
  avoidance is model-specific; the 16 MP 30 MB file cap.
- `src/lib/server/services/images/image-runner.ts` — `mayBeSeeThrough` false for H3;
  guard sizes; output `PreviewImage` (replace the template's `SaveImage`).
- `src/lib/server/services/normal-chat-tools/make-image.ts` — tool description:
  print is 16 MP (slow), transparent unsupported, prompt tags `<Picture N>`,
  detailed caption; `IMAGE_TOOL_WAIT_MS` (100 s) may be too short for 16 MP.
- `src/lib/server/config-store.ts` / `env.ts` — a model selector
  (`IMAGE_MODEL=qwen|h3` or similar), admin override, README/.env.example.
- `src/lib/server/services/images/comfyui/templates.contract.test.ts`,
  `templates.test.ts`, image e2e specs — model-specific assertions; a real-ComfyUI
  smoke test (the current e2e uses the fake).
- UI/storage: 16 MP PNGs can be 20-40 MB; `FILE_PRODUCTION_MAX_IMAGE_BYTES` is
  25 MB; check the file-production path and document rendering. Thumbnails are 320 px
  (`IMAGE_THUMB_LONG_EDGE`), so cards stay light, but full downloads and four takes
  per card grow.
- Ops: ComfyUI at `ede4e5fe8d` with `comfy-kitchen 0.2.41`, templates 0.11.103,
  frontend 1.58.5; model files (29.4 GB) in a new `hf-minimax-h3-image` dir with
  pinned hashes; `MemoryMax=32G`; retune `--reserve-vram`; keep the 0.43.0/Qwen
  release for rollback; a separate instance/port for the trial.
- Tests: graph contract, slot map, 6 steps/CFG 1, 4 MP/16 MP sizes, transparency
  refusal, `<Picture N>` prompt, 10/16 references, 16 MP file-production size,
  a real 5090/5000 smoke run.

The code refactor is moderate (the slot abstraction does most of the work). The
ops and validation are the larger challenge: a ComfyUI 0.44 upgrade on the same box,
a 24 GiB RAM cap, a shared 48 GB GPU, and no real-server test in the current gates.

## Recommendation

**The trial passed. Keep Qwen live as the rollback while the integration is built.**

1. **Keep the trial assets.** ComfyUI 0.44 at `ede4e5fe8d`, `comfy-kitchen 0.2.41`,
   templates 0.11.103, the `comfyui-h3` worktree/venv, the H3 NVFP4/TE/VAE files and
   the benchmark/compare scripts. The live 0.43/Qwen service stays until the switch.
2. **Refactor with a switch.** Add `IMAGE_MODEL=qwen|h3`, H3 graph JSONs, 6 steps /
   CFG 1, 4 MP normal, 8 MP/16 MP optional print (16 MP 30 MB > 25 MB cap; cap or
   downscale), `<Picture N>` prompts, transparent refusal/fallback, 4 MP storage/UI,
   tool text and the tests above. Keep Qwen as the rollback.
3. **Tune the box.** `MemoryMax=32G`; the trial used `--reserve-vram 2` versus the
   live 4.5; the 0.6B is gone, MinerU is at 0.2, the 4B embedder and reranker stay.
   The 4 MP peak leaves 0.3 GiB free; the 16 MP is tight. The 4B/reranker are in use.
4. **Staging first**, then production on the owner's word. Verify the 4 MP card,
   panel, History, Download, vision and file-production paths at the new size; the
   16 MP tier only if the 25 MB cap is handled.

The speed target is met at 4 MP: 3 s warm, 14.7 s cold, versus the current 10 s p50.
The 16 MP tier is optional; the 4 MP tier is the production choice.

## Sources

- Model card: https://huggingface.co/MiniMaxAI/MiniMax-H3-Image
- Comfy-Org repack: https://huggingface.co/Comfy-Org/MiniMax-H3-Image
- Community NVFP4/fp8: https://huggingface.co/LSDJesus/MiniMax-H3-Image-fp8-nvfp4
- Community GGUF (the link in the request): https://huggingface.co/LSDJesus/MiniMax-H3-Image-GGUF
- ComfyUI H3-Image PR: https://github.com/Comfy-Org/ComfyUI/pull/17655
- ComfyUI v0.44.0 release: https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.44.0
- ComfyUI H3 tutorial: https://docs.comfy.org/tutorials/image/minimax/minimax-h3-image
- H3 ComfyUI t2i template: https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_minimax_h3_image_t2i.json
- H3 ComfyUI edit template: https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_minimax_h3_image_edit.json
- vLLM recipe (single-GPU/RTX PRO 6000/4090 notes): https://recipes.vllm.ai/MiniMaxAI/MiniMax-H3-Image
- SGLang cookbook: https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3-Image
- Current app graph/canvas/tool code: `src/lib/server/services/images/comfyui/templates.ts`,
  `src/lib/server/services/images/canvas.ts`,
  `src/lib/server/services/normal-chat-tools/make-image.ts`,
  `src/lib/server/services/images/files.ts`,
  `src/lib/server/services/images/AGENTS.md`
