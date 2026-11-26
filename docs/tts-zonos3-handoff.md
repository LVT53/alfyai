# Handoff — ZONOS3-Mini TTS (infrastructure complete, app **not** wired)

**Status:** the TTS service is installed, running and stress-tested on the GPU box. **AlfyAI has no
idea it exists** — no config, no service module, no UI, no ADR. This document is everything needed to
continue.

**Date:** 2026-11-16. **Verified live state:** 2026-11-16 10:44 UTC (service uptime 10 h 20 m, stable).

---

## TL;DR

- A ZONOS3-Mini TTS server runs as `zonos3.service` on the GPU box at `127.0.0.1:1919`.
- It fits **inside the VRAM that was already free on GPU0**. vLLM was **not** changed, not restarted,
  not reconfigured — it keeps its full 511K-token KV pool.
- The trick is `--zac-cpu`: the model backbone runs on the GPU, the waveform decoder on the CPU.
  Full-GPU mode does **not** fit.
- Measured cost to AlfyAI: **~0.1 s added to time-to-first-audio**. The LLM's own time-to-first-sentence
  dominates (~0.65 s warm). vLLM throughput lost ~2% (within noise) while 4 TTS requests ran.
- **One operational rule:** `systemctl stop zonos3` before restarting `vllm-flashnext`
  (see [Residual risk](#residual-risk-unproven)).

---

## Why ZONOS3-Mini (the model decision)

The session started from `ConwayResearch/Underdog-Woof` and moved twice. The reasoning, so it is not
relitigated:

| Candidate | Verdict | Why |
|---|---|---|
| **Underdog-Woof** | rejected | [Underdog Non-Commercial 1.0](https://huggingface.co/ConwayResearch/Underdog-Woof/raw/main/LICENSE): non-commercial only, and §4 requires a "Voice by Underdog Woof" credit link wherever audio plays. Runtime is hand-rolled numpy with **no ONNX export** (would need a Python sidecar or a JS port). ~10 days old with 10 downloads, and the 1.42% WER is a vendor benchmark on a number/date-normalization set — it measures text normalization, not naturalness. |
| **Kokoro-82M** | superseded | Apache-2.0 and ONNX (and `onnxruntime-node` is already a dependency), but English-centric, so it did not solve Hungarian. |
| **Pocket TTS** | superseded | CC-BY-4.0, built for CPU streaming, 6 languages — but not Hungarian. |
| **ZONOS3-Mini** | **chosen** | Apache-2.0, **43 languages including `hu`**, native frame-level streaming, 800M params / ~100M active (latent MoE), and an OpenAI-compatible `/v1/audio/speech` with PCM streaming. |

Hungarian was decisive: AlfyAI answers in the language the person writes in (ruling 79), so an
English-only voice would have left the assistant mute in half its conversations.

---

## Verified live state

All three SSH users (`alfyws`, `alfydesign`, `alfyroot`) are the **same physical host**, so the app
reaches TTS on loopback with no tunnel.

| Item | Value |
|---|---|
| Unit | `/etc/systemd/system/zonos3.service`, `enabled`, `active` |
| Listens | `127.0.0.1:1919` (loopback only) |
| Executable | `/home/alfyws/opt/zonos3/servers/ggml/build-cuda/zonos3-server` (19.7 MB) |
| Model dir | `/home/alfyws/opt/zonos3/servers/ggml/gguf/` (1.08 GB active) |
| Host RAM | `MemoryCurrent` ≈ **1.38 GB** |
| GPU0 | RTX PRO 6000 Blackwell Workstation Edition, 97,887 MiB; **653–755 MiB free** with TTS up |
| GPU0 held by TTS | **1.44 GiB peak** (95,210 → 96,689 MiB card usage; free 2,132 → 653 MiB) |
| GPU1 | RTX PRO 5000 Blackwell, 48,935 MiB — untouched, runs ComfyUI/MinerU/TEI |
| vLLM | `vllm-flashnext.service`, **untouched**: `--gpu-memory-utilization 0.92`, process holds 92.84 GiB, KV pool 8.24 GiB / 511,562 tokens / 1.95× at 262,144 |

### The installed unit (verbatim)

```ini
[Unit]
Description=ZONOS3-Mini TTS (ggml CUDA; backbone on GPU0, decoder on CPU)
Documentation=https://github.com/Zyphra/ZONOS3
After=network-online.target vllm-flashnext.service
Wants=network-online.target

[Service]
Type=simple
User=alfyws
Group=alfyws
WorkingDirectory=/home/alfyws/opt/zonos3/servers/ggml
Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID
Environment=CUDA_VISIBLE_DEVICES=0
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/alfyws/opt/zonos3/servers/ggml/build-cuda/zonos3-server gguf/backbone-ptq.gguf --gpu --zac-cpu --zac gguf/zac-keep2.gguf --spk-encoder gguf/spk-encoder.gguf --steer gguf/steer.gguf --tts-default-voices-dir gguf/voices --host 127.0.0.1 --port 1919 --batch 2 --max 1500
Restart=on-failure
RestartSec=5
MemoryMax=8G

[Install]
WantedBy=multi-user.target
```

**Why each flag:** `--zac-cpu` is the whole trick (see below). `--zac gguf/zac-keep2.gguf` pins a
single decoder — without it the server auto-loads `zac.gguf` too and OOMs. `--max 1500` is ~100 s of
audio per request and costs almost nothing in VRAM (measured: 755 MiB free at `--max 1500` vs 759 MiB
at `--max 600`). `--batch 2` keeps slot memory bounded. `After=vllm-flashnext.service` sets boot order
so vLLM claims its 92.8 GiB first.

### Build provenance (for a rebuild)

| | |
|---|---|
| ZONOS3 repo | `96d9e0e`, 2026-11-13 (shallow clone, `--recurse-submodules`) |
| ggml submodule | `a05c9922` |
| Toolchain | rustc 1.100.0, cmake 3.31.8, CUDA **13.4** (`/usr/local/cuda`), driver 615.71.10 |
| Build | `cd servers/ggml && cmake -B build-cuda -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build-cuda -j16` |

Rust was installed for this build (`~/.cargo`); it is required because CMake compiles the
`third_party/zyphra-textnorm` submodule with cargo.

---

## Measurements (measured, not estimated)

Environment: live vLLM + live Zonos on the production GPU box, `--batch 2 --max 1500`, decoder on CPU.
Voice: **Imogen** (`default_b78b28baf5c31a1d`) for every test.

### Synthesis

| Test | Audio | Time | Realtime factor | First audio |
|---|---|---|---|---|
| English, 144 chars | 14.1 s | 1.67 s | **8.4×** | **20 ms** |
| Hungarian, 118 chars, no digits | 10.5 s | 1.39 s | 7.6× | 1.38 s* |
| Hungarian with dates/prices | 10.9 s | 1.48 s | 7.4× | 1.48 s* |
| Long text, 537 chars | 31.1 s | 3.58 s | 8.7× | 3.6 ms |
| 4 concurrent, 144 chars each | ~14 s each | 2.4–3.0 s | ~5.8× | 2–3 ms |
| Long text at `--max 1500` | 37.7 s | 4.32 s | 8.7× | 25 ms |

\* `/v2/generate` with `stream: false` buffers the whole response, so its "first audio" figure is
really total time. Use `/v1/audio/speech` for genuine streaming.

### Time to first audible syllable in a chat

Two paths measured separately, then added.

| Stage | Measured |
|---|---|
| LLM first token (28k-token prompt, warm prefix cache) | 0.47 s |
| LLM first token, cold cache | 0.66 s |
| **LLM first speakable sentence, warm** | **0.65 s** |
| LLM first speakable sentence, cold | 0.82 s |
| Zonos first audio bytes | 20–100 ms |
| Transport + browser jitter buffer (estimated, not measured) | 0.12–0.30 s |
| **Total, warm** | **≈ 0.9–1.1 s** |
| **Total, first message of a conversation** | **≈ 1.1–1.3 s** |

**TTS is roughly 10% of that.** The number to optimise is the LLM, not the voice. No thinking phase
appeared in any run (`reasoning_content` was never emitted).

### Impact on the chat model

| | tok/s |
|---|---|
| vLLM alone | 123.7 |
| vLLM while 4 TTS requests run | 121.3 |

≈2%, within noise. This refuted the earlier concern that concurrent LLM decode and TTS would fight for
SMs: with the decoder on CPU the GPU work is only a brief 0.58 GiB backbone pass.

---

## Decisions and the evidence behind them

### 1. vLLM was left alone

The original plan was `--gpu-memory-utilization` 0.95 → 0.92. **It was already 0.92** (the plan docs
were stale; the unit and the running process both said 0.92).

More importantly, the arithmetic that motivated the change was wrong. vLLM's own startup log:

```
Desired GPU memory utilization (0.92, 87.45 GiB)
  weights + non-torch        76.85 GiB
  peak activation             2.36 GiB
  CUDAGraph                   0.27 GiB
  Available KV cache          8.24 GiB  -> 511,562 tokens, 1.95x at 262K
```

The KV pool is only **8.24 GiB** — weights dominate. So each 0.01 of utilization is ~0.95 GiB **of KV**,
and dropping to 0.89 would have cut the pool by **35%** (511K → ~332K tokens, 1.95× → 1.27×). That was
a far worse trade than first estimated. It turned out to be unnecessary.

Note the ~5 GiB that vLLM's process holds beyond its accounted total (92.84 GiB vs 87.72 GiB): that is
the vision-IPC reservation plus the MTP drafter (`--speculative-config … num_speculative_tokens: 3`),
which sit outside the utilization budget.

If KV ever *does* need to shrink, prefer `--kv-cache-memory=<bytes>` (vLLM itself suggests this) over
twiddling the fraction — it is deterministic.

### 2. ggml runtime, not the CUDA/Mini-SGLang server

The model card's default Linux path is the Mini-SGLang CUDA server. It is the wrong tool here:

- It pins **CUDA 12.8**; this box has **13.0 / 13.1 / 13.4** only.
- ~9 GB of PyTorch weights, and "the first CUDA start JIT-compiles kernels" for minutes.
- Its server default is `memory_ratio=0.5` — **half the GPU** for the KV cache. On a shared card that
  is an instant OOM for vLLM.

The ggml server is C++/GGUF, ~1.08 GB of weights, builds happily against CUDA 13.4, and needs no Python
at runtime.

### 3. `--zac-cpu` because full-GPU does not fit

Full `--gpu` **crashed with CUDA OOM** (SIGABRT) after loading the backbone (0.58 GiB / 190 tensors):

```
CUDA error: out of memory
  in function cublas_handle ... cudaMalloc(&cublas_workspaces[...])
```

2,132 MiB was not enough for backbone + context buffers + cuBLAS workspaces. Moving the waveform
decoder to the CPU dropped GPU residency to 1.44 GiB and it fits with 653 MiB to spare. Loss: the decode
step runs on CPU — but the measured result is still 8.4× realtime, so it costs nothing that matters.

There is **no `-ngl` / layer-offload dial** here (unlike llama.cpp): `--gpu` vs `--cpu` is all-or-nothing,
with `--zac-cpu` / `--zac-gpu` as the only split.

---

## Gotchas that cost a run each

1. **`zac.gguf` auto-loads next to the backbone.** Leaving the full 9.3 GB download in `gguf/` makes the
   server load a *second*, full-size decoder (2.2 GB) and OOM immediately. Either pass
   `--zac gguf/zac-keep2.gguf` explicitly (unit does this) **and/or** keep the extras parked.
2. **7.9 GB is parked in `gguf/_unused/`** — `zac.gguf`, `zac-encoder.gguf`, `ssl-teacher.gguf`,
   `backbone-ptq-edit.gguf`. **Do not move them back into `gguf/`.** The encoder/teacher pair is only
   needed for raw-reference voice cloning; the default voice embeddings need only `spk-encoder.gguf`.
3. **Default backend on Linux is CPU.** `--gpu` must be passed explicitly.
4. **Voice ids are hashes, not names.** `GET /v2/speakers` returns `label` and `original_name`; the
   canonical table is `gguf/voices/README.md`. **Imogen = `default_b78b28baf5c31a1d`.**
5. **The model emits Markdown.** A real first sentence came back as
   `A **queue** is first-in, first-out: …`. Fed raw, Imogen says "asterisk asterisk". The chunker
   **must** strip Markdown, code fences, URLs and emoji before synthesis.
6. **Hungarian text normalization is not covered.** NeMo normalization ships for English, Mandarin,
   Japanese, Korean, German, Spanish, French, Italian and Portuguese; Hungarian passes through as
   written. Numbers/dates in Hungarian are unverified — listen before trusting.
7. **No Hungarian voice preset ships.** `gguf/voices/` has 27 voices across 10 languages, none Hungarian.
   Tests above used the **British-English Imogen embedding to speak Hungarian** (Zonos supports
   cross-lingual cloning). It produced fluent-length audio but **its Hungarian quality is unaudited** —
   this is the "we would need a good source" gap, still open.
8. **`alfyws` has no sudo** (password required). `alfyroot` is passwordless and is the account for
   `systemctl`/`/etc` work.
9. **SSH from the agent sandbox needs** `-o ControlMaster=no -o ControlPath=none`, otherwise the
   control socket fails to bind outside the workspace (`Operation not permitted`).
10. **Bind is loopback only** (`--host 127.0.0.1`). Fine because everything is one host; change only
    deliberately.
11. **`--max` is a hard audio cap.** At 1500 frames ≈ 100 s; a longer answer truncates.
12. The `--gpu` OOM leaves a core dump in `/var/lib/systemd/coredump/` (one was removed).

---

## What is left to build (app side)

Nothing below exists yet. Suggested order.

### 1. ADR — next free number is **0070**

`docs/adr/0070-*.md`. Record: TTS runs on GPU0 alongside vLLM with the decoder on CPU; why the CUDA
server was rejected; why the KV pool was not traded; the degraded-gracefully rule (TTS down must never
break a chat turn — see `AGENTS.md` "Auxiliary services … should degrade gracefully").

### 2. Config

Per the repo rules, a new runtime setting touches **four** places:

- `src/lib/server/env.ts` — parsing and defaults (`TTS_URL`, `TTS_ENABLED`, `TTS_VOICE`)
- `src/lib/server/config-store.ts` — normalization plus admin override; register the key in the
  override list (near `COMFYUI_URL`, around line 76 / 825)
- `README.md` and `.env.example`
- the settings/admin loaders if it should be user-visible

Default to `TTS_URL=http://127.0.0.1:1919` and `TTS_ENABLED=false` until the pipeline is proven.

### 3. Server service module

`src/lib/server/services/tts/` — model it on `src/lib/server/services/images/comfyui/`:

- plain `fetch` with an injectable `fetchImpl`, like `mineru/client.ts`
- the base URL read through `config-store.ts`, **never** `$lib/server/outbound`
- **nothing a model writes becomes an address** (ADR-0068)
- a fake client for tests, mirroring `comfyui/testing/fake-comfyui.ts`
- a provider interface so the model behind `TTS_URL` can change without touching the pipeline

Endpoints: `POST /v1/audio/speech` (`response_format: pcm`, 44.1 kHz mono f32, streams) or
`POST /v2/generate` (`stream: true`). `GET /v2/speakers` lists voices. `GET /v2/capabilities` describes
decoders and features.

### 4. The pipeline

- **Sentence chunker** over the existing chat token stream, with Markdown/code/URL/emoji stripping.
  Cut at sentence boundaries; if the first sentence exceeds ~120 chars, cut at a comma to start sooner.
- **Transport** to the browser. `src/lib/services/` owns the stream protocol; `images/take-events.ts`
  is the precedent for a per-turn SSE side-channel.
- **Playback** — a Web Audio queue of scheduled `AudioBufferSourceNode`s. Needs a user gesture to
  `AudioContext.resume()`, and ~100–150 ms of buffered audio before starting to avoid underrun.
- **Controls** — play/stop, plus clean cancellation when the turn is aborted or the person barges in.
- **A "Voice" toggle** in the composer area, with EN + HU strings.

### 5. Feature Guide

`AGENTS.md` requires the guide to change with the feature:
`src/lib/components/guide/guide-content.ts` and `src/lib/i18n/guide.ts`, plus the section drawing if a
pictured control changes, plus a Show me spotlight marker and an e2e line.

### 6. Tests

- Unit: chunker boundaries, Markdown stripping, PCM chunk framing.
- Unit: the TTS client against the fake.
- e2e: toggle on, a turn streams, audio element/queue engages, stop works. New spec joins the release
  gate by existing.

Run `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port <base>` with the specs that cover the changed
surface.

---

## Runbook

```bash
ssh alfyws   'systemctl status zonos3'
ssh alfyws   'journalctl -u zonos3 -n 80 --no-pager'
ssh alfyroot 'systemctl restart zonos3'

# voices
ssh alfyws 'curl -s localhost:1919/v2/speakers | jq -r ".speakers[] | \"\(.label)  \(.id)\""'
# capabilities
ssh alfyws 'curl -s localhost:1919/v2/capabilities | jq'

# speak (PCM f32 44.1k mono -> wav)
ssh alfyws 'curl -s -X POST localhost:1919/v1/audio/speech -H "Content-Type: application/json" \
  -d "{\"model\":\"zonos3\",\"input\":\"Hello.\",\"voice\":\"default_b78b28baf5c31a1d\",\"response_format\":\"pcm\"}" \
  -o /tmp/o.pcm && ffmpeg -y -f f32le -ar 44100 -ac 1 -i /tmp/o.pcm /tmp/o.wav'

# watch the GPU while speaking
ssh alfyws 'nvidia-smi --query-gpu=memory.used,memory.free --format=csv -l 1 -i 0'
```

**Before restarting vLLM:**

```bash
ssh alfyroot 'systemctl stop zonos3 && systemctl restart vllm-flashnext && systemctl start zonos3'
```

---

## Residual risk (unproven)

Zonos holds 1.44 GiB of GPU (and ~1.38 GB of host RAM) permanently. If `vllm-flashnext.service` restarts while Zonos is resident, vLLM
needs ~92.84 GiB of the 95.59 GiB card and is left with only ~1.3 GiB of slack — probably enough,
**but it was deliberately not tested**, because testing it means a live chat outage.

This was **not** closed with `Conflicts=`/`ExecStartPre=`, because a typo in the production vLLM unit
could take chat down permanently. The operational rule is the mitigation. Options if you want it closed
properly:

- test one supervised vLLM restart at a time you can lose chat for a couple of minutes, then either
  accept it or act on the result;
- or add `ExecStartPre=-/usr/bin/systemctl stop zonos3.service` to the vLLM unit — `daemon-reload`
  only, **no restart needed** — accepting that TTS stays down after any vLLM restart until started.

Boot ordering is already safe (`After=vllm-flashnext.service`), so a reboot is fine.

---

## Verified vs assumed

Counted as **verified** (run on the live box): live unit and flags; GPU0/GPU1 memory attribution; vLLM
KV pool and utilization; ggml build; OOM at full `--gpu`; the service running, restarting and
synthesising; all synthesis timings; the LLM first-sentence timings; the vLLM tok/s comparison;
service state after 10 h.

Counted as **assumed / not measured**:

- browser transport and jitter-buffer cost (0.12–0.30 s) — no browser in the loop yet.
- the end-to-end chat figure is therefore a sum of measured parts, not one measurement.
- **Hungarian quality with an English voice embedding** — audio was produced, intelligibility was not
  judged by a Hungarian speaker.
- whether a vLLM restart survives Zonos resident.
- `--batch 2` is untested above 4 concurrent requests; `--max 1500` truncation behaviour past 100 s.
- real AlfyAI turns add context assembly and may include a control-model hop, which the synthetic
  28k-prompt test did not include.
