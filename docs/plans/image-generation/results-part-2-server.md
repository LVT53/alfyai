# Images part 2: the picture server, results

Results of plan 2c (the picture server). Tasks 1-2 written by agent claude-opus-5-5 on 2026-10-27. All times UTC unless marked CET (the box's local time). The owner authorised alfyroot work for plan 2c without per-command approval (PROMPT.md, 2026-10-27).

## Survey

Taken 2026-10-27 11:40 UTC on alfyroot (`alfyws.alfyserver.hu`, AlmaLinux 10.2, kernel 6.12.0-211.67.1.el10_2, 32 CPUs).

### GPUs and driver

| index | PCI bus id | name | driver | total | used | free |
|---|---|---|---|---|---|---|
| 0 | 00000000:01:00.0 | RTX PRO 6000 Blackwell Workstation | 615.71.09 | 97887 MiB | 93364 MiB | 3978 MiB |
| 1 | 00000000:03:00.0 | RTX PRO 5000 Blackwell (SM 12.0) | 615.71.09 | 48935 MiB | 15002 MiB | 33494 MiB |

Driver 615.71.09 is at or above 580: the plan goes on.

Compute apps on GPU1 (bus 00000000:03:00.0):

| pid | process | GPU1 memory | what it is |
|---|---|---|---|
| 18545 | VLLM::EngineCore | 11002 MiB | MinerU's VLM server: docker container `mineru-openai-server` (image `mineru:latest`, `--gpu-memory-utilization 0.23`), host port 127.0.0.1:30001 |
| 5702 | text-embeddings-router | 1532 MiB | TEI `tei-rerank` (bge-reranker-v2-m3), 127.0.0.1:7998 |
| 5705 | text-embeddings-router | 1594 MiB | TEI `tei-embed` (qwen3-embedding-0.6b), 127.0.0.1:7997 |
| 2769 | mineru-kit api-server (alfydesign) | 848 MiB | `mineru4.service` 4.0.12, 127.0.0.1:8002 |

GPU0 holds vLLM `vllm-flashnext.service` (93224 MiB). Note: the "VLLM::EngineCore" on GPU1 is MinerU's VLM backend, not the chat model.

### Host

- Memory: 185 GiB total, 113 used, 72 GiB available; swap 32 GiB LVM partition (`/dev/dm-1`) with 20.8 GiB used (65%); `vm.swappiness=10`.
- Disk: `/home` 3.3T, 1.1T free (ComfyUI goes here); `/` 200G, 56G free.
- Python: `/usr/bin/python3.12` = Python 3.12.15 (system). No user-level route needed. `/usr/local/bin/uv` also exists, unused.
- Port 8188: free.
- Services: `vllm-flashnext.service` (GPU0, User=alfyws, `CUDA_DEVICE_ORDER=PCI_BUS_ID`, `CUDA_VISIBLE_DEVICES=0`), `mineru4.service` (User=alfydesign, `CUDA_VISIBLE_DEVICES=1`, `MemoryMax=32G`), `mineru4-dev.service` (CPU only, :8003); TEI runs in docker under `alfyai-tei.slice` (`MemoryMax=16G`, `MemorySwapMax=0`).
- User `alfyws`: uid 1000, groups alfyws, wheel, docker. `/home/alfyws/venvs` held ctq, llm-compressor, paddle-ocr-service, vllm, vllm-0.31; `/home/alfyws/opt` had no comfyui.
- Health URLs found: TEI `http://127.0.0.1:7997/health` and `http://127.0.0.1:7998/health` (200); MinerU `http://127.0.0.1:8002/v1/health` (200, unauthenticated; `/health` returns 401/404, the API lives under `/v1`); MinerU VLM `http://127.0.0.1:30001/health` (200).

### Decisions

| Decision | Value | Reason |
|---|---|---|
| GPU1 index under `CUDA_DEVICE_ORDER=PCI_BUS_ID` | 1 | bus 00000000:03:00.0 is index 1 in nvidia-smi (PCI order); the same convention as vllm-flashnext's unit |
| Python | system `/usr/bin/python3.12` (3.12.15) | 3.12+ is installed; no user-level install needed |
| User and paths | `alfyws`; venv `/home/alfyws/venvs/comfyui`, code `/home/alfyws/opt/comfyui` | the plan's default; alfyws already runs the GPU services' venvs |
| `MemoryMax` | 24G (+ `MemorySwapMax=0`) | half of the ~72 GiB available beside the resident services is ~36 GiB, capped at 24G by the plan; no-swap per the alfyroot swap note (systemd service cgroup, so `memory.swap.max` holds: verified 0) |
| Text encoder | INT8-ConvRot (`qwen3vl_8b_int8_convrot.safetensors`) | GPU1 had 33.5 GiB free, above the 26 GiB threshold |
| `--disable-pinned-memory` | on | swap use 20.8 of 32 GiB, above half; also sidesteps the pin-steal race behind silently ignored edit prompts (#17187 / #16900; #17370 says the race returns under torch.compile even after #17297) |

## Install

Done 2026-10-27 11:41-11:50 UTC by agent over root ssh; venv, clone and downloads ran as `alfyws` (`sudo -u alfyws -H`).

### Step 1: venv and torch

- `/usr/bin/python3.12 -m venv /home/alfyws/venvs/comfyui`; pip upgraded 23.3.2 -> 26.2.2.
- `pip install torch==2.14.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130` -> torch 2.14.1+cu130, torchvision 0.29.1+cu130, torchaudio 2.11.0+cu130, triton 3.8.0.
- Check with `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1`: `2.14.1+cu130 13.0 NVIDIA RTX PRO 5000 Blackwell (12, 0)`.
- Logs on the box: `/home/alfyws/comfyui-install-torch.log`, `/home/alfyws/comfyui-install-reqs.log`, `/home/alfyws/comfyui-download.log`.

### Step 2: ComfyUI pinned

- Cloned `https://github.com/Comfy-Org/ComfyUI.git` to `/home/alfyws/opt/comfyui` (master was 426f5eea, v0.43.0, 2026-10-26).
- Tags at/after v0.41.3: v0.41.3 8713616f (10-17), v0.42.0 355cd6b1 (10-18), v0.42.1 63be2f9b, v0.42.2 49634b4c, v0.42.3 edb3db00, v0.42.4 3f438ca6 (10-21), v0.42.5 483dae43 (10-23), v0.43.0 426f5eea (10-26).
- **Chosen: v0.43.0, commit `426f5eea52a7ece1dd599fff4cb6cd1f352ddd24`.** Why: it is the only tag containing PR #17297 "Sync offload streams before stealing a pin" (merge commit a071826f, 2026-10-22), the fix for the pinned-memory race that #17187 traced to (silently ignored Qwen edit prompts); v0.42.5 does not contain it. Its notes report no INT8-ConvRot or ignored-prompt regression. #17098 (INT8-ConvRot noise on an RTX 5060 Ti, comfy-kitchen 0.2.37/0.2.38) is still open but unreproduced on an RTX 5090; this card's smoke render below is clean. #17187 is open but its root cause is the pin-steal race (fixed by #17297, and avoided entirely here with `--disable-pinned-memory`).

### Step 3: requirements, comfy-kitchen, xformers

- `pip install -r requirements.txt` kept torch 2.14.1+cu130.
- **comfy-kitchen 0.2.40, not 0.2.39.** v0.43.0's requirements pin `comfy-kitchen==0.2.40` with `comfy-aimdo==0.6.0` (v0.42.5 pinned 0.2.39 / 0.5.6). Downgrading would run the tag against a kitchen it was not released with; the plan allows 0.2.39 only "if the pinned ComfyUI accepts it". The noise reports were on 0.2.37/0.2.38; the smoke render on 0.2.40 is clean. `system_stats` reports installed == required for every comfy package.
- xformers: not installed. Attention: "Using pytorch attention" (SDPA).
- Also installed: frontend 1.57.4, workflow-templates 0.11.97 (json 0.1.123), embedded-docs 0.5.15, transformers 5.21.0, huggingface_hub 2.3.0 (`hf` CLI 2.3.0, came with the requirements; the plan's separate `huggingface_hub[cli]` install was not needed). Full freeze in the appendix.

### Step 4: weights

Repository `Comfy-Org/Qwen-Image-2.1` (name as in the plan), revision `0217efd1d9c9452e84f6448903d6e21bfa171ffd`. Its listing: diffusion_models/{qwen_image_2.1_bf16, qwen_image_2.1_int8_convrot, qwen_image_2.1_turbo_bf16, qwen_image_2.1_turbo_int8_convrot}; loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16; model_patches/qwen_image_2.1_fun_controlnet_union_{bf16,int8_convrot}; text_encoders/{qwen3vl_8b_bf16, qwen3vl_8b_int8_convrot, qwen3vl_8b_w4a8, qwen3.5_9b_qwen_image_2.1_pe_{i2i,t2i}.int8_convrot, qwen3.5_9b_qwen_image_2.1_pe_{i2i,t2i}_w4a8}; vae/qwen_image_2.1_vae_bf16. Note: the plan's "Qwen3-VL-8B encoder" is `qwen3vl_8b_*`; the `qwen3.5_9b_*_pe_*` files are optional prompt enhancers for the `TextGenerate` node (not downloaded; the app writes its own prompts).

Downloaded with `hf download ... --local-dir /home/alfyws/opt/comfyui/models/hf-qwen-image-2.1` (about 80 s), symlinked into `models/diffusion_models`, `models/text_encoders`, `models/vae`. sha256 equals the Hub's LFS sha256 for all three.

| File (repo path) | bytes | sha256 |
|---|---|---|
| diffusion_models/qwen_image_2.1_int8_convrot.safetensors | 7256783064 | cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d |
| text_encoders/qwen3vl_8b_int8_convrot.safetensors | 9350798360 | 8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f |
| vae/qwen_image_2.1_vae_bf16.safetensors | 675509688 | bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9 |

Total 17.28 GB (16.1 GiB). Disk after install: venv 6.9G, `/home/alfyws/opt/comfyui` 17G; `/home` still 1.1T free.

### Step 5: the unit

`/etc/systemd/system/comfyui.service`, as written:

```ini
# ComfyUI picture server for AlfyAI (plan 2c, installed 2026-10-27). ComfyUI v0.43.0 (426f5eea).
# Rollback: systemctl disable --now comfyui.service comfyui-clean.timer; rm this file and comfyui-clean.{service,timer}; daemon-reload.
[Unit]
Description=ComfyUI picture server (Qwen-Image 2.1) on GPU1, for ai.dev and production
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=alfyws
Group=alfyws
WorkingDirectory=/home/alfyws/opt/comfyui
Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID
Environment=CUDA_VISIBLE_DEVICES=1
Environment=PYTHONUNBUFFERED=1
Environment=HF_HUB_OFFLINE=1
Environment=DO_NOT_TRACK=1
# --reserve-vram 4 is provisional (Task 4 sets it from measurements).
# --disable-pinned-memory: host swap was 20.8 of 32 GiB used at install (above half), and it avoids the
# pinned-memory steal race behind silently ignored edit prompts (ComfyUI #17187/#16900/#17370).
ExecStart=/home/alfyws/venvs/comfyui/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --reserve-vram 4 --disable-pinned-memory
Restart=on-failure
RestartSec=5
# Half the host memory available beside the resident services (~72 GiB at install), capped at 24G; never swap.
MemoryMax=24G
MemorySwapMax=0

[Install]
WantedBy=multi-user.target
```

Note: the plan said "no flag turns Dynamic VRAM off"; v0.43.0 has `--disable-dynamic-vram`. It is not used: Dynamic VRAM stays on, as the maintainers advise.

Started 2026-10-27 11:47:33 UTC (12:47:33 CET); `enabled`, `active (running)`, answering HTTP 200 within 5 s. Startup log: `Total VRAM 48494 MB, total RAM 24576 MB`, `RAM limited by cgroup to 24576 MB`, `Device: cuda:0 NVIDIA RTX PRO 5000 Blackwell : cudaMallocAsync`, `Using pytorch attention`, `DynamicVRAM support detected and enabled`, `Using RAM pressure cache`. comfy_kitchen backends: cuda available, triton available-but-disabled, eager available. Native ops listed: mxfp8, convrot_w4a4, float8_e5m2, nvfp4, float8_e4m3fn, asym_w4a8_int8, int8_tensorwise, w6a8_int8.

`ss -ltnp`: `127.0.0.1:8188` only. cgroup: `MemoryMax=25769803776`, `memory.swap.max` = 0, `MemorySwapCurrent=0`.

`/system_stats`: one device, `cuda:0 NVIDIA RTX PRO 5000 Blackwell : cudaMallocAsync`, `vram_total` 50850103296 (47.4 GiB), comfyui_version 0.43.0, `ram_total` 25769803776 (the cgroup limit).

### Step 6: daily clean-up

`/etc/systemd/system/comfyui-clean.service`:

```ini
[Unit]
Description=Delete ComfyUI inputs and outputs older than a day (plan 2c)

[Service]
Type=oneshot
User=alfyws
Group=alfyws
ExecStart=/usr/bin/find /home/alfyws/opt/comfyui/input /home/alfyws/opt/comfyui/output -type f -mmin +1440 -delete
```

`/etc/systemd/system/comfyui-clean.timer`:

```ini
[Unit]
Description=Daily clean-up of ComfyUI inputs and outputs (plan 2c)

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enabled with `systemctl enable --now comfyui-clean.timer`; next run Wed 2026-10-28 00:00:00 CET.

### Step 7: neighbours and footprint

| Moment | GPU1 used | GPU1 free | ComfyUI process on GPU1 | ComfyUI host RAM | host available / swap used |
|---|---|---|---|---|---|
| Before install | 15002 MiB | 33494 MiB | - | - | 72 GiB / 20.8 GiB |
| ComfyUI idle, nothing loaded (after start) | 15341 MiB | 33154 MiB | 334 MiB | 0.7 GiB | 71 GiB / 20 GiB |
| During smoke render (peak, 500 ms samples) | 31835 MiB | ~17100 MiB | ~16.8 GiB (peak minus 15002 baseline) | 3.26 GiB peak | - |
| After render, models still resident | 30363 MiB | 18132 MiB | ~15.0 GiB | 3.2 GiB | 70 GiB / 20 GiB |
| After `POST /free {"unload_models":true,"free_memory":true}` | 15579 MiB | 32916 MiB | 572 MiB | 3.2 GiB | - |

**Idle footprint: about 0.3-0.6 GiB on GPU1 with nothing loaded; about 15 GiB while the models stay resident after a render until `/free` is called** (the app's `IMAGE_IDLE_FREE_MS` does that).

Smoke render (not a plan step, added to prove the install works and INT8-ConvRot is not noise on SM120): a minimal API graph (UNETLoader -> QwenImage21Cache auto -> KSampler; CLIPLoader `type=qwen_image`; TextEncodeQwenImage21 resolution 1024; EmptyLatentImage 1248x832; euler/simple, 40 steps, cfg 1, seed 424242; VAEDecode; SaveImage), prompt "a cosy living room with a grey linen sofa against the left wall, evening light". Cold (models loaded from disk) **26.15 s** "Prompt executed". Result: a coherent photographic living room, grey sofa on the left, 1248x832; no noise. The picture was deleted from ComfyUI's output afterwards. The log names the DiT `model_type FLUX`/`QwenImage21`, VAE `WanVAE`.

Neighbours after install and after the render: TEI embed 200, TEI rerank 200, MinerU `/v1/health` 200, MinerU VLM 200; `vllm-flashnext.service` and `mineru4.service` active; ComfyUI `NRestarts=0`.

### Files and changes outside the ComfyUI folders

- Created: `/etc/systemd/system/comfyui.service`, `comfyui-clean.service`, `comfyui-clean.timer` and their `wants` symlinks; the three install logs in `/home/alfyws/` (listed under Step 1); the Hub's README in alfyws's HF cache (`~/.cache/huggingface`, read to check the file layout).
- Nothing else changed: no package manager, no change to vLLM, TEI, MinerU, driver, Apache, Tailscale, users or firewall.
- Rollback: `systemctl disable --now comfyui.service comfyui-clean.timer`, remove the three unit files, `systemctl daemon-reload`, then delete `/home/alfyws/opt/comfyui` and `/home/alfyws/venvs/comfyui`.

## Graphs

### Templates found

The workflow templates live in the venv's package `comfyui_workflow_templates_json` 0.1.123 (meta-package `comfyui-workflow-templates` 0.11.97), folder `/home/alfyws/venvs/comfyui/lib/python3.12/site-packages/comfyui_workflow_templates_json/templates/`. Qwen-Image 2.1 templates (UI format, with subgraphs; not API format):

| Template | Full path | Notes |
|---|---|---|
| Text to image | `.../comfyui_workflow_templates_json/templates/image_qwen_image_2_1_t2i.json` | UNETLoader `qwen_image_2.1_int8_convrot`, CLIPLoader `qwen3vl_8b_int8_convrot` type `qwen_image`, VAE bf16, QwenImage21Cache (auto, default), TextEncodeQwenImage21 (resolution 1024), EmptyLatentImage, KSampler (25 steps, cfg 1, euler, simple), SaveImageAdvanced (png); optional prompt enhancer (TextGenerate + `qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot` behind a ComfySwitchNode, off) |
| Image edit | `.../templates/image_qwen_image_2_1_image_edit.json` | 2 LoadImage -> BatchImagesNode -> TextEncodeQwenImage21 `images`; same loaders; optional `pe_i2i` enhancer; ImageCompare preview |
| Turbo text to image | `.../templates/image_qwen_image_2_1_turbo_t2i.json` | turbo DiT (not installed), SamplerCustomAdvanced + ManualSigmas, 8 steps |
| Turbo image edit | `.../templates/image_qwen_image_2_1_turbo_image_edit.json` | turbo DiT (not installed), 1 LoadImage |
| Remove background | `.../templates/image_qwen_image_2_1_background_removal.json` | 1 LoadImage -> edit path, SaveImageAdvanced png 8-bit; transparent output from an input picture |

Thumbnails are in `.../comfyui_workflow_templates_media_assets_02/templates/image_qwen_image_2_1_*.webp`.

**RGBA/transparent:** there is no separate transparent text-to-image template. The t2i template's note says a transparent image comes from the same graph by wrapping the prompt: "This is an RGBA format image with transparency. `[your description]`. The image has an alpha channel and a transparent background." and saving as PNG. The `background_removal` template is the image-to-transparent path. (Other non-2.1 transparent/layer templates: `image_qwen_image_layered.json`, `image_qwen_image_layered_control.json`, API-node ones.) Checked by Task 3, see "Transparent route" below.

### Export method and why

Method: **script conversion by hand of the UI-format templates, not Playwright "Export (API)"**. The owner's browser was not available and a headless export would have given the same graph only after the same subgraph flattening; the two templates are small (t2i: 9 live nodes, edit: 9 plus ten `LoadImage`). I read each template's subgraph (`definitions.subgraphs[0]`: nodes, links, exposed inputs), took widget order from the server's `GET /object_info`, resolved the two `ComfySwitchNode`s at their template defaults (`false`: the prompt enhancer stays off, the sampler's latent is the `EmptyLatentImage`), dropped the enhancer branch (`TextGenerate`, `PreviewAny`, the `pe_*` `CLIPLoader`, the system-prompt node, `BatchImagesNode`, which only fed the enhancer) and the `SaveImageAdvanced`/`ImageCompare` nodes, and wrote the API JSON. The result was verified by submitting it to the real server (below). Files: `src/lib/server/services/images/comfyui/graphs/qwen-image-2.1-{generate,edit}.api.json`.

Graph (both): `UNETLoader` (1) -> `QwenImage21Cache` auto/default (2) -> `KSampler` (7, euler/simple, 40 steps, cfg 1, denoise 1); `CLIPLoader` type `qwen_image` (3) -> `TextEncodeQwenImage21` (5, resolution 1024, empty negative prompt) -> positive/negative; `EmptyLatentImage` (6) -> latent; `VAELoader` (4) -> `VAEDecode` (8) -> `PreviewImage` (9). The edit graph adds `vae` to the encoder and ten `LoadImage` nodes (11-20), each linked into the encoder's `images.image_1` ... `images.image_10`.

Installed file names used: diffusion `qwen_image_2.1_int8_convrot.safetensors`, text encoder `qwen3vl_8b_int8_convrot.safetensors`, VAE `qwen_image_2.1_vae_bf16.safetensors`.

### Corrections to what the brief assumed

- **The real edit template does not use one `BatchImagesNode` into the encoder.** In the template, `BatchImagesNode` only feeds the optional prompt enhancer (`TextGenerate`). The encoder itself takes each picture on its own autogrow input `images.image_N` (the subgraph exposes `image_1` ... `image_10`; the node accepts 16). So plan 2a's slot-map shape (one `LoadImage` -> one encoder input) fits unchanged; no shape change was needed. The template ships with 10 slots, so the 4-picture default cap is met without extending anything.
- The sampler starts from the `EmptyLatentImage` at the width and height we write (switch off), not from the reference picture's latent; the encoder's `resolution` (1024) only sizes the references it reads. That is why edit output keeps the canvas from `canvasForEdit` (here 1248x832 for a 1248x832 input).
- Default steps in the templates are 25; the app writes 40 (`QWEN_STEPS`) and CFG 1 through the slots.

### Real renders (through the tunnel, GPU1, models warm from earlier use)

Both via `scripts/images/try-render.ts`, built by the app's `graphFor` / `buildPromptGraph`, `canvasForNewPicture` / `canvasForEdit`, `freshSeed`. Pictures kept outside the repo in `/home/lvt53/alfyai-handoff/composites/`.

| Run | Prompt | Size | Wall time (upload to download) |
|---|---|---|---|
| generate | "a cosy living room with a grey linen sofa against the left wall, evening light" | 1248x832 | 11.7 s |
| edit of that result | "make the sofa dark green, keep everything else exactly as it is" | 1248x832 | 14.1 s |

- `try-render-generate.png`: a bright, plausible photographic living room; a large grey woven-fabric corner sofa along the left, a low marble-top coffee table on a faded rug, a wooden armchair with a striped cushion by a big window with beige curtains and a street view. Sofa is on the left as asked; the light is more daylight than evening (the model's reading of "evening light").
- `try-render-edit.png`: the same room; only the sofa changed, now a deep green textured fabric; wall, curtains, window, table, rug, armchair, cushions and floor look unchanged to the eye. Texture of the sofa kept.

### PreviewImage and alpha

PNGs from `PreviewImage` (`type: "temp"`) arrive as 4-channel PNGs. For ordinary pictures the alpha channel is present but near-opaque (min 252, max 255 on the generate picture), so callers that need an opaque RGB picture should flatten. The VAE decodes RGBA natively, which is why the next point works.

### Transparent route

Tested: the t2i template's wrap ("This is an RGBA format image with transparency. [description] The image has an alpha channel and a transparent background.") on the generate graph, saved through `PreviewImage`, gave a **real alpha channel**: for "A red ceramic mug with a white heart" 853,093 of 1,038,336 pixels were fully transparent (alpha < 8), 180,436 opaque (> 247) and 4,807 in between (soft edge); the mug cut out cleanly (the RGB under the transparent pixels is purple fill, as expected). So PreviewImage does not lose alpha. Registered `generate-transparent` (same graph, prompt wrapped by `wrapTransparentPrompt` inside `buildPromptGraph`). No `edit-transparent`: the only transparent edit-style template is `background_removal`, a different graph (image-to-cutout, not an edit of a described change); `graphFor("edit", true)` still falls back to the plain edit with `transparentApplied: false`. One sample only; the model may ignore the wrap on some prompts, so the guards (plan 2a) should still check alpha on the result.

## Measurements

(Task 4.)

## Tuning

(Task 5.)

## Acceptance

(Task 6.)

## Appendix: pip freeze of /home/alfyws/venvs/comfyui (2026-10-27)

```
aiohappyeyeballs==2.7.1
aiohttp==3.14.5
aiosignal==1.4.0
alembic==1.20.1
annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.15.1
attrs==26.1.0
av==19.0.2
blake3==1.0.11
certifi==2026.10.23
charset-normalizer==3.5.2
click==8.5.0
comfy-aimdo==0.6.0
comfy-angle==0.1.1
comfy-kitchen==0.2.40
comfyui-embedded-docs==0.5.15
comfyui-workflow-templates-core==0.3.388
comfyui-workflow-templates-json==0.1.123
comfyui-workflow-templates-media-api==0.3.84
comfyui-workflow-templates-media-assets-01==0.1.48
comfyui-workflow-templates-media-assets-02==0.1.24
comfyui-workflow-templates-media-image==0.3.160
comfyui-workflow-templates-media-other==0.3.229
comfyui-workflow-templates-media-video==0.3.101
comfyui_frontend_package==1.57.4
comfyui_workflow_templates==0.11.97
cuda-bindings==13.3.1
cuda-pathfinder==1.6.0
cuda-toolkit==13.0.3.0
einops==0.8.2
filelock==3.32.3
frozenlist==1.8.0
fsspec==2026.7.0
h11==0.16.0
hf-xet==1.7.0
httpcore2==2.16.0
httpx2==2.16.0
huggingface_hub==2.3.0
idna==3.20
Jinja2==3.1.6
kornia==0.9.0
kornia_rs==0.2.0
Mako==1.4.3
markdown-it-py==4.2.0
MarkupSafe==3.0.3
mdurl==0.1.2
mpmath==1.3.0
multidict==7.2.1
networkx==3.6.1
numpy==2.5.2
nvidia-cublas==13.1.1.3
nvidia-cuda-cupti==13.0.85
nvidia-cuda-nvrtc==13.0.88
nvidia-cuda-runtime==13.0.96
nvidia-cudnn-cu13==9.24.0.43
nvidia-cufft==12.0.0.61
nvidia-cufile==1.15.1.6
nvidia-curand==10.4.0.35
nvidia-cusolver==12.0.4.66
nvidia-cusparse==12.6.3.3
nvidia-cusparselt-cu13==0.8.1
nvidia-nccl-cu13==2.30.7
nvidia-nvjitlink==13.3.33
nvidia-nvshmem-cu13==3.4.5
nvidia-nvtx==13.0.85
packaging==26.3
pillow==12.3.0
propcache==0.5.4
psutil==7.2.2
pydantic==2.14.1
pydantic-settings==2.16.1
pydantic_core==2.50.1
Pygments==2.21.0
PyOpenGL==3.1.10
python-dotenv==1.2.4
PyYAML==6.0.3
regex==2026.9.29
requests==2.34.2
rich==15.0.0
safetensors==0.8.0
scipy==1.18.1
sentencepiece==0.2.2
setuptools==78.1.0
shellingham==1.5.4
simpleeval==1.0.8
spandrel==0.4.2
SQLAlchemy==2.1.6
sympy==1.14.0
tokenizers==0.23.3
torch==2.14.1+cu130
torchaudio==2.11.0+cu130
torchsde==0.2.6
torchvision==0.29.1+cu130
tqdm==4.70.1
trampoline==0.1.2
transformers==5.21.0
triton==3.8.0
truststore==0.10.5
typer==0.27.3
typing-inspection==0.4.4
typing_extensions==4.16.0
urllib3==2.8.0
yarl==1.25.1
```
