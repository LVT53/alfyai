# vLLM 0.34.0 against our Flash-Next setup (2026-11-18)

**The owner's question:** "check it against our solution, see if it can be upgraded cleanly now."

**Verdict: yes.** 0.34.0 has the native support we were waiting for, PLE disk offload. Our setup moves to it with no code changes. Nothing was installed on the box; every reading below was read-only.

## What we run today (read from the box)
- **Install:** vLLM 0.31.0 from PyPI in `/home/alfyws/venvs/vllm-0.31`. It has **no local patches**: all 2,771 `.py` files match the wheel's RECORD hashes.
- **Unit:** `vllm-flashnext.service` with these flags:
  - `--gpu-memory-utilization 0.92`, `--max-model-len 262144`, `--max-num-seqs 16`, `--max-num-batched-tokens 8192`;
  - `--kv-cache-dtype fp8`, `--attention-config '{"indexer_kv_dtype":"fp8"}'`;
  - `--engram-config '{"cpu_offload": true}'`, `--mamba-cache-mode align`;
  - chunked prefill, prefix caching, `--tool-call-parser qwen3_coder`, `--reasoning-parser qwen3`;
  - MTP with the external NVFP4 drafter (3 tokens);
  - env `VLLM_SPARSE_INDEXER_MAX_LOGITS_MB=512` and `VLLM_USE_V2_MODEL_RUNNER=1`.
- **The N-gram table:** FP8, pinned in host RAM (`shared` 66 GiB in `free`). Swap was **31 of 31 GiB** at 17:3x CET.
- **Storage:** the checkpoint (126 GB) is on `/home`, an LVM volume on the NVMe drive (Crucial T710), not on the SATA disks.

## What 0.34.0 brings for us (`tools/recheck-vllm-stable.py v0.34.0`, the release notes, the files at the tag)
- **PLE disk offload, #59958 (merged 2026-10-30, first in 0.34):** `--engram-config '{"disk_offload": true}'`.
  - The table stays in the checkpoint's safetensors files, and each step reads only its rows with `preadv`.
  - No table is held in GPU memory or pinned host memory; rows sit in the reclaimable page cache.
  - Formats BF16, FP8 and NVFP4, so our FP8 table qualifies. CUDA graphs are unchanged. It takes precedence over `cpu_offload`.
  - It needs local NVMe, which we have.
  - Measured on DGX Spark only: decode within 3.5%, TTFT +11% warm and +20% cold, MTP acceptance flat, GSM8K flat.
  - Docs: read the PLE shard files once after start for a fast first request; the checkpoint must not change while serving.
  - **This is what frees the ~66 GiB of pinned RAM** with our current Orca checkpoint, so no NVFP4 table or FP4-Local switch is needed for the RAM.
- **Fixes and gains:**
  - QSA indexer prefill workspace counted in memory profiling (#60490): the OOM risk at high utilisation.
  - Quantized q/k/v plus the BF16 QSA indexer loading (#62318).
  - Idle sampler writes skipped, about 10-11% faster small-batch decode (#62748).
  - Sampler warmed up after graph capture, so memory no longer grows under load (#62560; our drift).
  - MTP memory down about 512 MiB (#63996, more KV).
  - Long-context int32 overflow (#63761).
  - Fast Start weight-cache restarts for ModelOpt NVFP4 (#63672 and others).
  - FlashInfer 0.7.3.
- **Still not in 0.34.0:**
  - exact-size pinning #59848 (moot with disk offload);
  - #62409, the prefill crossing 262,144 with MTP and cudagraphs (we cap at 262,144, so it is inferred not hit, as before);
  - NVFP4 KV on QSA #54846;
  - #64739, shards in a subfolder, merged 2026-11-17 after the release; it matters only for NVIDIA's FP4-Local checkpoint.

## Our flags at v0.34.0
- **All still valid with the same meaning:**
  - `EngramConfig`: `cpu_offload`, `disk_offload`, `embedding_across_dp`, `dp_shared_memory`, `use_thp`;
  - `MambaCacheMode` `align`;
  - `IndexerKVDType` includes `fp8`;
  - `qwen3_coder` maps to `Qwen3EngineToolParser` and `qwen3` to `Qwen3ParserReasoningAdapter`, as in 0.31;
  - `VLLM_SPARSE_INDEXER_MAX_LOGITS_MB`.
- **One to drop:** `VLLM_USE_V2_MODEL_RUNNER` is gone from `envs.py`, because model runner V1 was removed.

## Install
- A new venv is needed. `uv pip compile` for Linux x86_64 and Python 3.12 resolves 199 packages (`v0.34.0-resolved-linux-py312.txt` here): torch 2.14.0+cu130, torchvision 0.29.0, flashinfer-python 0.7.3, nvidia-cutlass-dsl 4.8.0, NCCL cu13 2.30.7.
- FlashInfer's prebuilt `flashinfer-cubin` 0.7.3 and `flashinfer-jit-cache` 0.7.3+cu130 exist on flashinfer.ai.
- Behaviour changes since 0.31 (from earlier checks): `max_tokens` is clamped instead of rejected, parsers are built at startup, CORS defaults to none, transformers is 5.2x.

## How it would go (needs the owner's go-ahead: production)
1. **Prepare, with no downtime:**
   - `/home/alfyws/venvs/vllm-0.34` beside 0.31, using the resolved set plus the two FlashInfer wheels;
   - a cache root `~/.cache/vllm-0.34`;
   - a unit copy with the same flags, `{"disk_offload": true}` and without `VLLM_USE_V2_MODEL_RUNNER`.
2. **One window:** GPU0 is full by design, so this is a cutover.
   - Stop the old unit and start the new one. The first boot is slower while the caches are cold.
   - Smoke tests: models, tool call, Hungarian, vision, MTP acceptance.
   - Measure decode and TTFT against the 0.31 numbers, plus host RAM and swap.
   - If disk offload measures badly, restart with `cpu_offload` to isolate the engine change.
3. **Rollback:** start the old unit (about 3 minutes).

Under MPS the kernel set changes, so keep watching for Xid 13 (the owner's one-week check).

## The extensible KV cache and Zonos on GPU0 (the owner's question, same day)

0.34's headline change is that the **extensible KV cache is on by default** ([#56492](https://github.com/vllm-project/vllm/pull/56492)).
- **How it works:** the cache's whole address range is reserved as virtual memory. After CUDA graph capture and warmup, each worker measures the memory really free and the transient peaks it really saw. The engine then commits the final block count **once**, by mapping physical pages into the reserved range. It does not grow later while serving.
- **New default:** when `--gpu-memory-utilization` is unset, it now defaults to **1.0**, and the cache takes everything free on the device minus a measured reserve and margin. Unset, that would squeeze zonos3: vLLM would take whatever zonos3 had not yet allocated when vLLM's warmup ended (zonos3 needs about 1.5 GB), and a zonos3 restart or a boot where vLLM warms up first could then fail.
- **An explicit value is a hard cap.** The docs at v0.34.0 (`docs/configuration/optimization.md`): "an explicit value is a hard cap on everything the instance uses". The PR: "The utilization setting remains a cap for sharing a GPU". **Our unit already passes `--gpu-memory-utilization 0.92`**: vLLM stays within 0.92 x 97.9 GB = 90.1 GB whatever else is on the card and whichever unit starts first, leaving zonos3 and the MPS server the same ~7.8 GB as today. 0.34 logs a warning that the cap "keeps free memory out of the KV cache"; that is expected.
- **KV size at our cap:** the PR measured caches 1-4% *smaller* than the old sizing at an explicit 0.92, because it now subtracts the graph and warmup memory it measured. Two 0.34 changes give some back: the draft (MTP) KV cache now takes the target's dtype, FP8 (#65198), and MTP memory is about 512 MiB lower (#63996). So expect roughly today's 511,562 tokens; measure it in the window.
- **Unit rules for 0.34:**
  - Keep `--gpu-memory-utilization 0.92`, with a comment that it must never be removed (zonos3 shares GPU0).
  - The fallback switch is `--no-enable-extensible-kv-cache`, which restores the old estimate-based sizing exactly, if the new cache misbehaves under MPS. It uses the CUDA VMM API, which zonos3's ggml also uses under MPS ("VMM: yes"), but vLLM's CI does not run it under MPS.
- The default block size changed from 16 to 64 (#63231). Our attention block is set by the hybrid-model padding (3200), so it is unaffected.

## Prepared (the owner's "Surely yes", 2026-11-18 ~17:33 UTC)
- **Venv:** `/home/alfyws/venvs/vllm-0.34` (19 GB, built in 1 min 40 s at nice 10 / idle IO, as alfyws).
  - Built from `/home/alfyws/v034-venv-constraints.txt`, the resolved set, plus `flashinfer-cubin==0.7.3` and `flashinfer-jit-cache==0.7.3+cu130`.
  - `uv pip check`: 207 packages compatible. Freeze: `v0.34.0-venv-freeze.txt`.
- **Parse check, with the GPUs hidden:** the live unit's flags, with `disk_offload`, parse with 0.34's own server parser (`vllm.entrypoints.common.cli_args`). `qwen3_coder` resolves to `Qwen3EngineToolParser` and `qwen3` to `Qwen3ParserReasoningAdapter`.
- **Draft unit:** `vllm-flashnext-0.34.service.draft` (not installed).
- **Production untouched:** the live unit, the 0.31 venv and GPU0.

## Using the extensible KV cache with zonos3 (the owner: "if it's useful we should switch to it")
**It is possible, and it is useful.** The cap (`--gpu-memory-utilization`) limits everything the vLLM instance uses, so the rest of GPU0 stays zonos3's whichever process starts first. Inside the cap, vLLM now sizes the KV cache from what it measured after warmup instead of an estimate plus slack.

**What GPU0 shows now** (18:4x CET, read-only):

| | MiB |
|---|---|
| total | 97,887 |
| used | 93,820 |
| free | 3,521 (the rest is driver-reserved) |
| vLLM | 92,256 |
| zonos3 | 1,372 (1,492 measured as its fixed need on 2026-11-18) |
| MPS server | 52 |

At 16:57, before the fault, used was 96,562 MiB and only 1,325 MiB was free.

**What this means:**
- vLLM 0.31's budget at 0.92 is 90,056 MiB, yet it holds about 92.3 GB, and probably more after hours of load: about 2.7 GB more at 16:57. The estimate-based sizing does not count what vLLM allocates after profiling (its own startup note: "0.9200 is equivalent to 0.9141 without CUDA graph memory profiling"). 0.34 fixes the known part of the growth: the sampler warm-up stops memory growth under load (#62560). Today that growth comes out of zonos3's room.
- With 0.34's measured sizing, **at the same 0.92 the KV cache would shrink** by about the uncounted ~2.2 GiB, to roughly 6 GiB and about 370k tokens instead of 511,562. vLLM would stop borrowing from zonos3's room.
- **Starting point for the window:** `--gpu-memory-utilization 0.95` (92,993 MiB cap). That leaves 4,894 MiB for zonos3 (about 1.5 GB), the MPS server and the driver reserve: about 2.8 GB of margin, twice what was free before the fault. Expected KV: around today's size (about 7.5 to 8.5 GiB; the transient reserve vLLM keeps is unknown until it logs it).
- **In the window:**
  1. Read vLLM's startup report: KV size, the transient reserve, and the exact `--kv-cache-memory` it logs.
  2. Run a synthetic reading through the speech service and record zonos3's peak memory.
  3. Then pick between 0.94 and 0.96.

  Never leave the flag unset: the 1.0 default would fill the card.

## SWITCHED (2026-11-18, the owner's "You can switch the vLLM now, clean up the older version")
- **Downtime:** stop at 18:50:04 CET with 0 running or waiting requests; serving again at 18:52:39. Chat was out for **2 min 35 s**.
- **Unit:** `/etc/systemd/system/vllm-flashnext.service` now runs `/home/alfyws/venvs/vllm-0.34` with `--engram-config '{"cpu_offload": false, "disk_offload": true}'`, `--gpu-memory-utilization 0.95` (commented as a hard cap) and no `VLLM_USE_V2_MODEL_RUNNER`. The backup `vllm-flashnext.service.bak-0.31-20261118` sits beside it (a copy is `vllm-flashnext-0.31.service` here).
- **Startup report:**
  - `EngramConfig(cpu_offload=False, disk_offload=True)`; the PLE is FP8 (`Qwen4ExpPLEFp8EmbeddingMethod`).
  - Model loading took 75.42 GiB (was 76.09).
  - The extensible cache: the "cap 90.31 GiB, keeping 1.38 GiB of free device memory out of the KV cache"; 1.99 GiB kept for transients.
  - **GPU KV cache 636,985 tokens, 2.43x at 262,144** (was 511,562, 1.95x): **+24.5%**.
- **Smoke tests on the box, made-up text only:** all pass.
  - models lists the three names;
  - English and Hungarian give coherent answers, finish `stop`;
  - the `qwen3_coder` tool call parses (`get_weather {"city": "Szeged"}`);
  - vision reads a red square;
  - decode 129.4 tok/s single stream (0.31 measured 135 to 138, so about -5%, in line with disk offload's -3.5%);
  - a 15.5k-token prompt reaches its first token in 946 ms cold and 869 ms warm;
  - MTP per-position acceptance is 0.644 / 0.372 / 0.205 (first token as before, about 63-64%).
- **zonos3 beside it:** two readings (Imogen and Berta, 24 clips, 0 errors). zonos3 peaked at 1,402 MiB, and GPU0's free memory stayed at 3,563 MiB or more. No Xid since the switch.
- **Host RAM (`free -m`, before -> after):**

  | | Before | After |
  |---|---|---|
  | used | 121,000 MiB | 52,470 MiB |
  | shared | 68,078 MiB (the pinned PLE) | 2,320 MiB |
  | available | 69,201 MiB | 137,732 MiB |

  Swap still shows 32.5 of 32.8 GiB used: old pages that drain as they are touched. Nothing new is swapped with 138 GB available.
- **0.31 deleted:**
  - `/home/alfyws/venvs/vllm-0.31` (17 GB; 154 root-owned `__pycache__` files needed root);
  - `/home/alfyws/.cache/vllm-0.31` (123 MB);
  - `/home/alfyws/v031-venv-constraints.txt` and `v031-venv-build.sh`.

  Their copies are here (`v0.31.0-venv-constraints.txt`, `v0.31.0-venv-build.sh`), so a rollback means rebuilding 0.31 from them (a few minutes with the uv cache) and restoring the backup unit.
- **Left alone:** the older `/home/alfyws/venvs/vllm` (0.28, used by the bench scripts and the disabled 27B unit), the unused aday777 checkpoint (~75 GB) and the `ple-quant` sidecar (28.8 GB).
