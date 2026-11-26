# vLLM's NVMe KV Pool and a 1M-Token Context for AlfyAI

Primary sources checked on 23 November 2026: vLLM tag `v0.34.0` (tag commit `62d4bc3c7`, committed 14 November, released 16 November), vLLM `main` at `c865edc19` (23 November 11:34 UTC), the ROCm/MoRI repository's `main` as fetched on 23 November, NVIDIA's GPUDirect Storage (GDS) documentation, Linux 6.12 source, and the Qwen model card. Nothing on the inference box was touched. Box facts (boot log, config, GDS user space, hardware) come from the coordinator's measurements and are labelled as such.

## Verdict

The feature in the blog post is not a vLLM NVMe tier. It is vLLM's `UMBPStoreConnector` talking to AMD's MoRI UMBP pool server, and the NVMe tier lives in that server: append-only 256 MiB segment files, read with O_DIRECT through io_uring into a DRAM staging buffer, with a DRAM write buffer in front. The connector itself already ships in v0.34.0 (our version, DRAM-pool documentation only); lazy offload exists only on main. But UMBP is ROCm/HIP code: its documented requirements are MoRI built with UMBP, `/dev/kfd` and HIP IPC, MoRI's support matrix lists only AMD Instinct GPUs, every measurement is on MI355X, and I found no NVIDIA runtime or PR. So for alfyroot it is **blocked on v0.34.0 and on main**. GPUDirect Storage does not rescue it: UMBP does not use it for NVMe, and on this box GDS would most likely run in compatibility mode (host bounce buffer), because `nvidia_fs` is absent, NVIDIA documents GDS mode only for data-center and desktop-Quadro-class GPUs, and the upstream kernel's P2P host-bridge whitelist at 6.12 lists only Intel parts. What it would give if it ran is prefix-reuse capacity (a hit is loaded back into GPU blocks), never room for one huge active request, and our GPU pool is not under pressure (the coordinator's figures: 16.8% peak this boot). Sizing arithmetic, derived from the code and matching the boot log to 0.01%: 13.4 KiB per cached token at FP8, 41.9 MiB per 3,200-token block, plus about 118 MB per recurrent-state checkpoint, so 100 GiB holds about 72 conversations of 100k tokens. The 1M question is not decided by NVMe at all. One 1,048,576-token request needs 353 pool blocks (14.4 GiB) against 275 now (11.25 GiB), the model card's YaRN route crashes with MTP and CUDA graphs when a prefill crosses 262,144 (issue 62383, fix PR 62409 still open, unchanged at v0.34.0 and main), and NVFP4 KV (PR 54846) is unmerged. The only mechanism I found that lets one request exceed the GPU pool is HiSparse for QSA (PR 59209, merged 19 November, main only, host DRAM, experimental, measured on GB300 rather than SM120). **Added after review:** UMBP is not the only NVMe route in vLLM. v0.34.0 ships its own CUDA-capable tiered offload (`OffloadingConnector` with `TieringOffloadingSpec`: a pinned-DRAM tier plus an O_DIRECT filesystem tier); section 7 covers it, and it has not been run on our model.

## How the sources were read

Read by me, verbatim: GitHub raw files at the `v0.34.0` tag and at `c865edc19`, `gh api` metadata for pull requests, issues, releases and `compare` (ancestry), the MoRI repository files named below, Linux `drivers/pci/p2pdma.c` at `v6.12`, the Hugging Face model card and `config.json`. Read through a summarising fetch tool, so paraphrases rather than verbatim text: the NVIDIA GDS documentation pages and a search-engine summary of Crucial's pages (Crucial's own site refused automated requests). The vLLM blog post is a secondary write-up and was followed into the code and docs that own each claim. Line numbers refer to the ref named in the same row.

## 1. What the feature is

### 1.1 Which release carries what

| Piece | Status | Evidence |
| --- | --- | --- |
| `UMBPStoreConnector` (connector, scheduler, worker, embedded and standalone runtimes) | In v0.34.0 | Parts 1, 2, 3, 5 and 7 of the ten-part series ([#61789](https://github.com/vllm-project/vllm/pull/61789) `a97d19d79`, #61790, #61791, #61793, [#61795](https://github.com/vllm-project/vllm/pull/61795) `32d6ddea1`) and the layout bugfix #64677 are ancestors of the tag (`gh api compare`, status "ahead"). Registered at [`kv_connector/factory.py:259-261`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/distributed/kv_transfer/kv_connector/factory.py#L259-L261). Usage doc exists at the tag: [`docs/features/umbp_store_connector_usage.md`](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/umbp_store_connector_usage.md). |
| Lazy offload (`lazy_offload`, part 9, [#61797](https://github.com/vllm-project/vllm/pull/61797), merged 11 November, `7f079220d`) | main only | Not an ancestor of the tag; the string does not occur in any UMBP file at the tag. |
| `dedup_tp_replicated_kv` (#64715, `ee263bc88`) | main only | Present in the main copy of the doc, absent from the tag's. |
| UMBP's NVMe pool tier | Not in vLLM (it is MoRI's); vLLM's own CPU + filesystem tier is a separate feature, see section 7 | The v0.34.0 doc describes UMBP as host-DRAM pool management. The tier policy is a MoRI JSON file ([blog](https://vllm.ai/blog/2026-11-23-skip-the-dram-tier), run recipe). Honouring `UMBP_SSD_SEGMENT_SIZE` needs MoRI #967, merged 17 November per the blog (not read). |
| Latest vLLM release | v0.34.0 | `gh api releases`: nothing newer as of 23 November. |

The blog says the series ended on 13 November. I confirmed parts 1, 2, 3, 5, 7 and 9 in the commit history of `vllm/distributed/kv_transfer/kv_connector/v1/umbp`; parts 4, 6, 8 and 10 were not enumerated.

### 1.2 What "skip the DRAM tier" means mechanically

It means no large DRAM pool tier. It does not mean direct GPU to NVMe DMA.

- A node-local server process, `umbp_standalone_server`, owns the pool. Engines reach it over a UNIX socket (TCP is rejected). Workers register their GPU allocations through HIP IPC and the server runs the transfers, so no KV bytes cross the socket ([v0.34.0 doc](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/umbp_store_connector_usage.md), standalone section; `runtime/standalone.py:8` and the `from mori.cpp import` at `:173`).
- The NVMe tier keeps KV in segment files on a local file system and reads them with direct I/O through io_uring, so the page cache never serves a read. Direct I/O is the MoRI default (`UMBP_SSD_DIRECT_IO=1`); if the file system rejects `O_DIRECT` a startup probe silently falls back to buffered I/O ([MoRI pure-SSD doc](https://github.com/ROCm/mori/blob/main/src/umbp/doc/pure-ssd-mode.md), "Direct I/O" section and troubleshooting table; read).
- DRAM stays in the path in two places. New KV lands in a write buffer (64 GB in most runs, 4 MiB at the smallest the policy accepts) and moves to the drives when the buffer evicts it. A read from the drives goes into a 16 GiB staging buffer and is copied to the GPU from there ([blog](https://vllm.ai/blog/2026-11-23-skip-the-dram-tier), "How a KV pool works"). MoRI's SSD staging arena defaults to 4 GiB worth (pure-SSD doc, Sizing table).
- GDS is not what was measured. UMBP does contain an optional AMD hipFile engine that reads a segment range straight into GPU memory "with no host bounce" ([`src/umbp/CMakeLists.txt:462-472`](https://github.com/ROCm/mori/blob/main/src/umbp/CMakeLists.txt), read), but the blog's NVMe runs describe DRAM staging. A code search of ROCm/mori for `cufile` found nothing.

### 1.3 Flags and system requirements

From the blog's Kimi-K3 recipe and the v0.34.0 doc (both read):

```bash
umbp_standalone_server unix:///run/umbp/pool.sock          # with UMBP_BACKEND_POLICY=policy.json,
                                                           # UMBP_SSD_SEGMENT_SIZE=268435456, UMBP_SSD_VERIFY_CRC=0,
                                                           # UMBP_SSD_DURABILITY=relaxed, UMBP_DRAM_CAPACITY=<bytes>
vllm serve <model> --enable-prefix-caching --kv-transfer-config '{"kv_connector":"UMBPStoreConnector",
  "kv_role":"kv_both","kv_load_failure_policy":"recompute","kv_connector_extra_config":
  {"mode":"standalone","endpoint":"/run/umbp/pool.sock","load_async":true,"lookup_async":true}}'
```

- Requirements stated in the doc: MoRI built with UMBP (`BUILD_UMBP=ON`, needs gRPC and Protobuf development packages), prefix caching on, the server needs `/dev/kfd` and `/dev/dri` and the engines' host IPC namespace; pipeline parallelism is rejected (`connector.py:119-122`). In the blog's tests: Linux 6.8, ext4 with no RAID, two Micron 7450 PRO 3.84 TB drives per node, MI355X GPUs.
- Options that matter ([doc](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/umbp_store_connector_usage.md)): `load_async` (forced on for models with Mamba-style or sparse-attention indexer layers), `lookup_async`, `lookup_timeout_ms` (default 1000, a late lookup counts as a miss), `save_decode_cache` (default false), `enable_partial_hash_hits`, `kv_load_failure_policy: recompute` (the default `fail` aborts a request whose block was evicted between lookup and load).

### 1.4 Capacity, eviction and write policy

- Capacity is set in bytes outside vLLM. DRAM: `UMBP_DRAM_CAPACITY` on the server (embedded mode: `capacity_bytes`, default 64 GiB per worker). SSD: the tier policy JSON names the drives and their capacities; its schema has per-tier `offload_trigger` (`on_evict` or `watermark`), `promote_trigger` (default `never`) and `high_watermark`/`low_watermark` ([MoRI tier-policy doc](https://github.com/ROCm/mori/blob/main/docs/UMBP-TIER-MANAGEMENT-BENCHMARK.md), lines 42-80; the exact SSD capacity key was not read). The blog's runs used `on_evict` and `never`, so a hit on the drives is always read from the drives.
- Eviction is LRU, coldest first, with a "touch" mechanism so GPU-resident prefixes are not evicted first (blog, lesson 2; the touch PRs are MoRI #779/#882, not read). The NVMe tier only appends. Evicting a block frees nothing until a whole segment file is deleted; space is reclaimed by dropping the files with the fewest live blocks, which throws away live KV. Hence the 256 MiB segment setting (blog, lesson 1; MoRI troubleshooting row "SSD used is well above the live data").
- Metadata and padding: capacity is charged in padded on-disk bytes, values padded to 4 KiB (pure-SSD doc, Sizing). The UMBP master keeps its block index in memory or in Redis ([overview](https://github.com/ROCm/mori/blob/main/docs/umbp-overview.md)); where the standalone server keeps its own index was not read, so I found no fixed metadata share of the NVMe. Dead records and segment slack are workload dependent and were not quantified in any source.
- Writes: at v0.34.0 stores are submitted once per step after the forward pass (doc, Limitations) and the blog states every block the GPU computes is written, so this is eager write-through, not write-on-evict. Decode-produced blocks are skipped unless `save_decode_cache`. On main, `lazy_offload` (default false) instead stores reusable blocks taken from the GPU free queue before they are evicted ([#61797](https://github.com/vllm-project/vllm/pull/61797) body; the PR gives no NVMe write-volume saving). More than half of Kimi-K3's NVMe writes were recurrent-state checkpoints (blog); `--prefix-cache-retention-interval` adds periodic ones ([`config/cache.py:285-291`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/config/cache.py#L285-L291), present at v0.34.0, default 0).

### 1.5 What it measured and its stated limits

All on 16 MI355X GPUs, Kimi-K3 (24 MLA layers, about 14 KB of KV per token) and DeepSeek-V4-Pro (about 5.5 KB per token at FP8), AgentX and kvlab traces ([blog](https://vllm.ai/blog/2026-11-23-skip-the-dram-tier)):

- A 1.8 TB NVMe pool matched a 1.8 TB DRAM pool within 1% at 48, 70 and 96 sessions (hit rates within 0.08% of prompt tokens); the pool served at most 16% of prompt tokens. Without the write buffer NVMe was 6.7% slower at 96 sessions on one machine pair.
- Stated limits: heavy-read regimes not compared; light traffic pays about 0.4 s per 128K-token hit; mostly single runs; every run on MI355X; "a dense model without MLA stores many times more" per token; the writes wear the drives (about 11 drive writes a day at 96 sessions on two 1-DWPD drives, roughly five and a half months to rated life); a distributed pool is future work.

## 2. Which kind of capacity?

### 2.1 It is (a): reusable prefix blocks

UMBP restores a prefix that has left GPU memory when a later request shares it; the restore lands in GPU blocks the scheduler allocates, and the request waits for an asynchronous load ([doc](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/umbp_store_connector_usage.md), first paragraph and `load_async`). It gives nothing for (b), the active KV of one running request.

- The boot-log "GPU KV cache size" and the admission limit do not change. At v0.34.0 both come from the device pool only: `get_max_concurrency_for_kv_cache_config` ([`kv_cache_utils.py:1082`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/v1/core/kv_cache_utils.py#L1082)) divides `kv_cache_config.num_blocks` by the blocks one max-length request needs, and the log line ([`:1169-1176`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/v1/core/kv_cache_utils.py#L1169-L1176)) only appends " + host" when `hisparse_config` is set. HiSparse is the one path that adds host groups to that arithmetic (section 6).
- Given the coordinator's figures (peak KV use 16.8% this boot, 63% maximum over the 0.34 boot, at most two waiting requests, prefix hit rate p50 57-71% in whole 3,200-token blocks), more pool capacity helps only conversations whose gap between turns outlives the GPU prefix cache. The blog's own method measures that: for each reused block, the time since its last use; a pool keeping KV for time T misses every block with a longer gap (blog, "Pick the retention").

### 2.2 What a restore costs

Measured by MoRI, primary but on different hardware: SGLang HiCache, Kimi-K2.6-MXFP4, TP8, eight drives of which six were remote. For a 128K prefix the time to first token was about 0.29 s from GPU memory, 0.45 s from DRAM, 0.84 s from NVMe and 7.7 s for a cold recompute ([pure-SSD doc, "Measured: L1 vs L2 vs L3"](https://github.com/ROCm/mori/blob/main/src/umbp/doc/pure-ssd-mode.md), lines 214-231). The blog adds that with no queue NVMe costs about 0.4 s more than DRAM, and that under load the load finishes inside the prefill-queue wait.

For our bytes the following is arithmetic, not measurement. A 100k-token prefix is 31 blocks of 43,929,600 B plus one 117,964,800 B state snapshot, 1,479,782,400 B (1.48 GB). At an assumed 7 to 14 GB/s from a Gen5 x4 drive that is 0.11 to 0.21 s of drive time, plus the DRAM-to-GPU copy. The T710's sequential-read rating was not verified, and the same drive also serves the PLE table every decode step and swap, so contention is likely. Recompute at the measured SM120 prefill speed of 9,724 tokens per second ([#54846](https://github.com/vllm-project/vllm/pull/54846), FP8, 12.8k-token miss) takes about 10.3 s for 100k tokens.

## 3. Does it work with our stack?

Answer. **v0.34.0: blocked.** UMBP imports MoRI (`vllm/distributed/kv_transfer/kv_connector/v1/umbp/runtime/standalone.py:173`, `from mori.cpp import`), and MoRI's UMBP is a ROCm/HIP build whose server needs `/dev/kfd` and HIP IPC, so there is no pool server to talk to on an NVIDIA box. **main (`c865edc19`): blocked for the same reason**; the only host-memory mechanism for this model is HiSparse (section 6), which is main-only. A second, declared blocker is `Qwen4ExpQSABackend.supports_kv_connector()` returning False (`vllm/models/qwen4_exp/nvidia/qsa.py:168-169` at the tag, `:258-259` on main); I found no code that enforces it for this model (see the table). No PR that would unblock UMBP on NVIDIA was found.

| Check | v0.34.0 | main (`c865edc19`) | Verdict |
| --- | --- | --- | --- |
| UMBP on NVIDIA GPUs | HIP only: doc requires `/dev/kfd`, `/dev/dri` and HIP IPC; `runtime/standalone.py:8,173` | same | **Blocked.** MoRI's hardware matrix lists MI308X, MI300X, MI325X, MI355X ([README lines 227-236](https://github.com/ROCm/mori/blob/main/README.md)); UMBP core links `hip::host` and builds `device_gather.hip` ([`src/umbp/CMakeLists.txt:104,127-129`](https://github.com/ROCm/mori/blob/main/src/umbp/CMakeLists.txt)). The top-level CMake has a CUDA branch ([`CMakeLists.txt:200-211`](https://github.com/ROCm/mori/blob/main/CMakeLists.txt)), so I cannot rule out that some other MoRI component builds on CUDA; the UMBP data plane I read has no CUDA counterpart. |
| Validated platform | MI350X (gfx950) per [#61797](https://github.com/vllm-project/vllm/pull/61797) validation | same | No NVIDIA validation in any PR I read. |
| QSA backend flag | `Qwen4ExpQSABackend.supports_kv_connector()` returns False ([`nvidia/qsa.py:168-169`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/models/qwen4_exp/nvidia/qsa.py#L168-L169)) | same, [`:258-259`](https://github.com/vllm-project/vllm/blob/c865edc19b67a8951d2c40af210c335e64e4f58f/vllm/models/qwen4_exp/nvidia/qsa.py#L258-L259) | Declared, but see next row. |
| Generic check | `backend.py:345-346` appends "KV connector not supported" when `use_kv_connector` and the flag is False; `use_kv_connector` is set at `selector.py:140-142` for any configured connector | `backend.py:360-361`, `selector.py:142-144` | The QSA layer does not go through the selector: it assigns `self.attn_backend = Qwen4ExpQSABackend` (`nvidia/qsa.py:420`) and returns it from `get_attn_backend` (`:489`). A code search of main for `supports_kv_connector` finds only `backend.py`, the two QSA files, ROCm backends and a test. **My earlier note that this flag stops all connector offload for this model is not reproduced; no enforcing caller found, no run test** (v0.34.0 callers cannot be searched with the code-search API). |
| Other connectors with this model | PR #60861 was closed on 23 October as superseded by #61601 (merged 20 October, in v0.34.0), whose author reports resumed prefills from OffloadingConnector loads read exactly the cold-computed PLE state, 48 of 48 rows, difference 0 (PR comments) | same | Offload connectors have been exercised with this model by contributors. The tracking issue [#55922](https://github.com/vllm-project/vllm/issues/55922) still lists "CPU offload: TODO" and "heterogeneous PD not supported". |
| Hybrid cache manager | `UMBPStoreConnector(KVConnectorBase_V1, SupportsHMA)` (`connector.py:100`) | same | Supported in principle. |
| GDN state with prefix caching | Mamba "align" groups are stored through a boundary hand-off from core (`scheduler.py:197-209`, `:1186-1240`); a state page is stored as a full page | same plus more code | Supported in principle; not run with this model. |
| `--mamba-cache-mode align` | Deprecated no-op ([#63830](https://github.com/vllm-project/vllm/pull/63830) body, citing #64838); field still in `config/cache.py:314` | Flag removed (#63830, merged 20 November) | Drop the flag when moving past v0.34.0. |
| Sparse indexer groups | Recognised: indexer groups force async load (`scheduler.py:218-240`) | same | In principle. |
| MTP draft KV | Connector raises `NotImplementedError` if a draft (eagle) group is not prefix-cacheable (`connector.py:123-135`) | #66234 (20 November) reworked EAGLE block dropping | **Not verified** for our external-drafter MTP. |
| FP8 main KV plus BF16 side caches | Main KV is `FullAttentionSpec` with uint8 (FP8) storage (`nvidia/qsa.py:492-500`). Raw-key ring: `CircularBufferSpec`, BF16 (`common/qsa_indexer.py:848-866`). Compressed keys: `MLAAttentionSpec`, one row per 4 tokens, indexer dtype (`:869-880`; `nvidia/qsa_indexer.py:165-181`) | same | The layout planner handles regions generically; not verified for ring or compressed-key groups. |
| 3,200-token block vs hash block | Connector resolves both sizes (`scheduler.py:186`); hits end on 3,200 boundaries unless `enable_partial_hash_hits` | same | Whole-block hits, matching the coordinator's observation. |
| MPS and SM120 | No source mentions either for UMBP. The connector's `kv_cache_access` returns "registers" ("registers the device KV cache with an RDMA engine", `connector.py:104-106`) | same (#66605) | **Not verified.** |

PRs that would unblock UMBP on NVIDIA: none found. I searched the vLLM tree and PR titles for UMBP and HiSparse only; I did not search MoRI issues for a CUDA port.

### GPUDirect Storage on this box

- The shipped feature does not need GDS, so this only matters for a hypothetical NVIDIA-side NVMe connector. vLLM main also has `lmcache_connector`, `mooncake_store`, `hf3fs`, `flexkv` and the native `OffloadingConnector` in its tree; I did not evaluate any of them.
- **GPU eligibility.** NVIDIA's support matrix (v1.20, read through the fetch tool) puts data-center GPUs and desktop Quadro cards with compute capability above 6 in "GDS mode" and every other card in compatibility mode. It names neither Blackwell nor RTX PRO, so whether the RTX PRO 6000 Blackwell Workstation counts is **not verified** ([support matrix](https://docs.nvidia.com/gpudirect-storage/release-notes/support-matrix.html)).
- **nvidia-fs.** The module is absent on the box (coordinator). NVIDIA's repository `NVIDIA/gds-nvidia-fs` is at v2.31.5 (20 October); I found no statement that it builds for AlmaLinux 10.2 / el10 kernel 6.12 (release notes and README yielded no distro lines). NVIDIA's known-issues page says that from driver R580.82.05 the module must be rebuilt after `nvidia.ko` installs, which needs dkms or a manual build here ([known issues](https://docs.nvidia.com/gpudirect-storage/release-notes/known-issues.html)).
- **The module-free path.** NVIDIA's overview guide describes an NVMe P2PDMA path needing CUDA 12.8+, a Linux 6.2+ kernel that ships PCI P2PDMA, and the open-RM driver 570+ with registration keys, with no `nvidia-fs.ko` for NVMe ([software architecture](https://docs.nvidia.com/gpudirect-storage/overview-guide/software-architecture.html)). Our driver (615.71.10) and libcufile 1.19.1.55 would nominally qualify. Two caveats: the kernel allows P2P through a host bridge only if it is whitelisted, and the v6.12 list has only Intel entries, none from AMD ([`drivers/pci/p2pdma.c:425-444` and `:484-509`](https://github.com/torvalds/linux/blob/v6.12/drivers/pci/p2pdma.c#L425-L444)); the AlmaLinux kernel may carry backports and a check of master returned nothing, so this is unconfirmed for AM5. NVIDIA also lists a KASLR problem for NVMe P2PDMA on x86_64 (workaround `nokaslr`).
- **IOMMU, XFS, LVM.** None of the NVIDIA pages I fetched mention the IOMMU. A search summary of NVIDIA's filesystem matrix places ext4 and XFS in an enterprise tier (page not read); LVM is not addressed anywhere I read. O_DIRECT must be used exclusively for the file.
- **Compatibility mode** uses ordinary POSIX I/O staged through host memory and lacks the GDS benefit, and cuFile falls to it when GDS conditions fail, such as a missing `nvidia-fs.ko` or a non-GDS mount ([O_DIRECT guide](https://docs.nvidia.com/gpudirect-storage/o-direct-guide/gpudirect-storage-requirements.html), [overview](https://docs.nvidia.com/gpudirect-storage/overview-guide/software-architecture.html)). In that mode a DRAM bounce buffer is back, so "skip DRAM" is lost.
- Read-only box checks that would settle it: `grep p2pdma_pgmap_ops /proc/kallsyms` (NVIDIA's own check), `zgrep CONFIG_PCI_P2PDMA /boot/config-$(uname -r)`, `dmesg | grep -i p2pdma` for the whitelist warning, and the installed `gdscheck` platform report. I did not run them.

## 4. Cost per token and what N GiB of NVMe holds

### 4.1 Bytes per token (derived from the code)

Configuration: 36 GDN layers, 12 QSA layers plus one MTP full-attention layer, 2 KV heads, head size 256 for K and V, indexer 1 KV head of size 128 with compress ratio 4 (model [`config.json`](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/main/config.json), read, plus the coordinator's measurement of our checkpoint).

| Cache | Spec in code | Per token per layer | FP8 total (13 layers) | BF16 total |
| --- | --- | --- | --- | --- |
| Main K and V | `FullAttentionSpec`, 2 heads, 256 + 256 | 1,024 B FP8, 2,048 B BF16 | 13,312 B | 26,624 B |
| Compressed indexer keys | `MLAAttentionSpec`, 1 head x 128, one row per 4 tokens | 32 B FP8, 64 B BF16 | 416 B | 832 B |
| **Total** | | | **13,728 B = 13.41 KiB** | 27,456 B = 26.81 KiB |
| NVFP4 main KV | not in v0.34.0 or main; [#54846](https://github.com/vllm-project/vllm/pull/54846) open | pool line 8.320 KiB vs FP8 13.477 KiB, ratio 0.617 | about 8.5 KB (estimate) | |

Assumptions: the MTP layer is FP8 and has its own indexer; FP8 indexer rows carry no scale bytes. Both are consistent with the boot log (4.2) but not independently read. Fixed per-sequence state: raw-key ring, `CircularBufferSpec` of round-up(4 + 3 draft tokens, 4) = 8 rows x 128 x 2 B = 2 KiB per layer; per GDN layer 48 x 128 x 128 x 4 B = 3,145,728 B of fp32 state plus a short-convolution state of 3 x 10,240 channels = 61,440 B (the 10,240 channels, 2 x 2,048 + 6,144, and the bf16 dtype are my assumptions from the standard GDN layout), padded by vLLM to the attention page size 3,276,800 B (`mamba_page_size_padded` exists for this, `config/cache.py` at the tag), so **36 layers = 117,964,800 B (112.5 MiB) per snapshot**. The PLE short-convolution state (checkpointed since #61601) is an additional cache group whose size I did not derive.

### 4.2 Reconciling the boot log

The log's token figure is not a per-token capacity. `get_kv_cache_capacity` returns `int(max_concurrency * max_model_len)` and `max_concurrency` is `num_blocks` divided by the blocks one max-length request needs summed over all cache groups (`kv_cache_utils.py:1082-1106`). Blocks per request from the coordinator's lines: 260 / 2.43 = 107.0 and 275 / 2.57 = 107.0, and 262,144 / 107 = 2,449.9 tokens per block, which reproduces both logged values exactly (260 x 262,144 / 107 = 636,985; 275 x 262,144 / 107 = 673,734). Of the 107, 82 are attention pages (ceil(262,144 / 3,200)); the other 25 are non-attention groups whose composition I did not verify.

A pool block is 11.25 GiB / 275 = 43,925,802 B = 41.89 MiB. My derivation: 13 x 3,276,800 B (main KV pages, 3,200 tokens at 1,024 B) + 13 x 102,400 B (800 compressed rows x 128 B) = 43,929,600 B, a difference of 0.009%; the earlier boot (10.64 GiB / 260) differs by 0.026%. So the true KV cost is 13.41 KiB per attention token, 3,200 tokens per block, and the "17.5 KiB per pool token" figure is that cost plus the per-request overhead the log divides in (the other 25 blocks per max-length request). It also explains the 3,200-token block: GDN state per layer, 3,207,168 B, must fit one attention page, and 3,200 x 1,024 B = 3,276,800 B is the first multiple that does (this is my inference from the sizes). PR #54846's "13.477 KiB per token" is the same engine pool-line metric measured with MTP off, so it is not directly comparable to 13.41 KiB. BF16 to FP8 measured 1.77x in [#55557](https://github.com/vllm-project/vllm/pull/55557) and 1.889x in #54846 rather than my arithmetic 2.0x; the cause is not verified.

### 4.3 What a connector writes for a cached prefix of N tokens

The UMBP scheduler keys objects by block hash and cache group (`scheduler.py:1205-1240`). For N tokens that is floor(N / 3,200) blocks of attention-group pages and compressed-key pages, 43,929,600 B per block in total across 13 layers (a partial tail is not cached, hits come in whole blocks), plus recurrent-state snapshots at the boundaries core retains (`scheduler.py:1186-1240`). With the default `prefix_cache_retention_interval` of 0 core retains only semantic checkpoints (the latest replay boundary and shared-prefix junctions, `config/cache.py:285-291`), roughly one per prompt; a positive interval must be a multiple of the 3,200-token block, so 6,400 is the smallest useful one.

### 4.4 Table: reusable prefix held per NVMe tier size

Raw capacity, FP8 main KV and FP8 indexer, MTP on. "Attention-only" ignores snapshots. Conversation counts charge one snapshot per conversation (default retention); the last column charges a snapshot every 6,400 tokens. Cost per conversation: 100k tokens = 31 blocks + 1 snapshot = 1.378 GiB; 262,144 tokens = 81 blocks + 1 snapshot = 3.424 GiB; with a checkpoint every 6,400 tokens 100k = 3.026 GiB and 262,144 = 7.818 GiB.

| NVMe tier | Attention-only tokens (78,215 per GiB) | 100k-token conversations | 262,144-token conversations | Same, checkpoint every 6,400 tokens (100k / 262k) |
| --- | ---: | ---: | ---: | ---: |
| 100 GiB | 7.82 M | 72 | 29 | 33 / 12 |
| 250 GiB | 19.55 M | 181 | 73 | 82 / 31 |
| 500 GiB | 39.11 M | 362 | 146 | 165 / 63 |
| 1 TiB | 80.09 M | 743 | 299 | 338 / 130 |

For scale, the GPU pool is 11.25 GiB, so 100 GiB is about 8.9 times it. Formula: counts = floor(GiB / cost per conversation), cost = floor(N / 3,200) x 43,929,600 B + snapshots x 117,964,800 B.

### 4.5 What to subtract, and write endurance

- Metadata proper: SSD records are padded to 4 KiB, at most 0.01% of a 42.6 MB attention object and 0.3% of a 1.33 MB indexer object if each is its own object (the object split is not verified). The block index lives in server memory.
- Not quantified by any source: dead records awaiting segment deletion, eviction watermarks and the LRU slack. Every 10% reserved takes 10% off every count above. MoRI exposes `live_bytes` and used bytes metrics to measure it.
- DRAM that must still exist: about 4 GiB of read staging by default and a write buffer of at least 4 MiB, out of roughly 117 GiB available.
- Endurance: the Crucial T710 4 TB is rated 2,400 TBW with a five-year warranty according to a search-engine summary of Crucial's flyer and listings; Crucial's own pages refused automated access, so the official datasheet was not read. 2,400 TBW over five years is 1.315 TB per day, which is 95.8 M newly computed tokens per day at 13,728 B (13.7 GB per million tokens), or about 11,100 state snapshots per day at 118 MB. With eager write-through the snapshots can dominate a chatty workload: 1,000 turns a day with one snapshot each is 118 GB a day (43 TB a year, 1.8% of the rating per year). The coordinator's drive shows 18.1 TB written and 1% used.

## 5. One request of 1,048,576 tokens

### 5.1 Vendor route

The model card says the context is 262,144 natively and extensible up to 1,000,000 tokens, and that the production Qwen3.8-Flash is the version with 1M by default ([README](https://huggingface.co/Qwen/Qwen3.8-Flash-Next), lines 19 and 71). For longer texts it recommends YaRN: set `rope_type` "yarn" and `factor` 4.0 with `original_max_position_embeddings` 262144 in `text_config.rope_parameters`, in `config.json` or in vLLM with `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1`, `--hf-overrides '{"text_config":{"rope_parameters":{...}}}'` and `--max-model-len 1000000` (lines 596-640). It warns that every framework implements static YaRN, so the factor stays constant regardless of input length and short-text quality can suffer; it advises changing the config only when long contexts are needed and lowering the factor to fit (for example 2.0 for 524,288). Our checkpoint's own config has `rope_type` "default" (coordinator). The cost of static YaRN on 70-100k-token prompts is not quantified in any source I found.

### 5.2 Quality evidence

- [#55557](https://github.com/vllm-project/vllm/pull/55557) (merged 16 September, in v0.34.0), on an RTX PRO 6000 Blackwell (SM120): FP8 KV pool 771,704 tokens vs 434,886 at BF16 at `--max-model-len 262144`, util 0.91 (1.77x); needle at about 125K 3/3; with YaRN x4 at `--max-model-len 791104`, 12/12 needles up to 768,938 tokens. Its main tests ran without MTP.
- [#54846](https://github.com/vllm-project/vllm/pull/54846) (open): NVFP4 KV on SM120 had 70/70 needles to 235k, but perplexity 0.37% to 0.59% worse, and on aggregation tasks near 1M the vLLM NVFP4 path scored 6/12 where SGLang scored 8/8 (p = 0.077), unresolved. MTP was not part of its tests.
- A keyword search of the model card found no long-context benchmark figures (its agentic scores are footnoted as 256K-window runs); I did not read the whole card.

### 5.3 Known bugs at and after 262,144

- Issue [#62383](https://github.com/vllm-project/vllm/issues/62383) (open): a single prefill that crosses 262,144 kills the engine with a CUDA illegal memory access under the YaRN override with MTP and CUDA graphs; a regression since v0.32.0, fine on 0.31.1; reported on H200, reproduced on SM120 in the fix PR.
- Fix [#62409](https://github.com/vllm-project/vllm/pull/62409) is open and blocked, last updated 29 October. The cause: with YaRN the rotary table is sized from the pre-scaling window, so positions beyond 262,144 read past it. At both `v0.34.0` and `main`, `mrope.py:349-350` still reads `cache_max_position_num = max_position_embeddings * positions_factor`, so neither carries the fix. Per the PR, the fault needs speculative decoding plus CUDA graphs, so our MTP setup is exactly exposed. A 1M attempt today needs MTP off or the fix applied.

### 5.4 Resource cost of one request

| Item | Number | Basis |
| --- | --- | --- |
| Attention blocks | 328 | ceil(1,048,576 / 3,200) |
| Blocks per max-length request | 353 (14.44 GiB) | 328 + 25 non-attention blocks (derived from the log, constant assumed) |
| Pool today | 275 blocks (11.25 GiB) | coordinator's boot log |
| Longest request that fits today | about 800,000 tokens | (275 - 25) x 3,200 |
| 1,000,000 tokens (vendor figure) | 338 blocks (13.83 GiB) | same formula |
| At NVFP4 (if #54846 lands) | about 8.3 GiB of KV plus 0.1 GiB of state | 1,048,576 x 13,728 B x 0.617; the page re-alignment effect is not modelled |
| With HiSparse (main) | host about 13.0 GiB, GPU about 0.4 GiB of indexer keys plus hot rows and state | 13 layers x 1,024 B x 1,048,576; section 6 |
| Prefill, lower bound | 94 to 108 s | 1,048,576 at 11,200 tokens per second ([#55557](https://github.com/vllm-project/vllm/pull/55557)) or 9,724 ([#54846](https://github.com/vllm-project/vllm/pull/54846)), both measured on short prompts; the real figure at 1M is not verified. #54846 reports NVFP4 prefill 2.00x slower at 1M. |
| Indexer logits | 512 MiB default budget | `VLLM_SPARSE_INDEXER_MAX_LOGITS_MB` ([`envs.py:63`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/envs.py#L63)), reserved at memory profiling per [#60490](https://github.com/vllm-project/vllm/pull/60490) (merged 27 October, in v0.34.0) |

On FP8 the request does not fit the current pool, and vLLM refuses such a configuration at startup with an "estimated maximum model length" error (the failure shown in #60490's validation). Even where it fits it would take the whole pool, so the usual 70-100k-token traffic would be starved while it runs. By the PR's description, decode logits are an fp32 `[decode tokens, compressed columns]` tensor; at 1M that is 262,144 columns, about 1 MiB per row, so 64 rows (16 sequences with MTP 3) are about 64 MiB (my arithmetic), well inside the budget. The prefill logits layout was not read.

Verdict on 1M: not on v0.34.0 with our flags. It needs three things: the #62409 rope fix (or MTP off), about 3.3 GiB more pool or a smaller KV format (NVFP4, unmerged, with a flagged 1M quality question) or HiSparse (main only), and tolerance for a minutes-long prefill that monopolises the pool.

## 6. HiSparse (`hisparse_config` in the AttentionConfig log)

HiSparse keeps the main K/V of sparse-attention layers in pinned host memory and keeps only the indexer-selected top-k rows resident on the GPU. It is host DRAM only: the design doc speaks of pinned host memory and registered host views, and I found no disk or NVMe mention in it ([`docs/design/hisparse.md`](https://github.com/vllm-project/vllm/blob/c865edc19b67a8951d2c40af210c335e64e4f58f/docs/design/hisparse.md), grep). Status in the doc: experimental.

- **Release status.** The framework is in v0.34.0: `HiSparseConfig` ("HiSparse sparse-MLA KV offloading", fields `device_buffer_size` and `eager_host_mirror`) at [`config/attention.py:20-33`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/config/attention.py#L20-L33), the `hisparse_config` field at `:175-179` (Model Runner V2 only; inferred when `HiSparseConnector` is configured), `HiSparseConnector` registered at `factory.py:225-227`. At v0.34.0 it targets sparse MLA (DeepSeek-style). Nothing in `models/qwen4_exp` at the tag mentions it, and the tag's doc has no QSA section. **Support for our model's QSA is [#59209](https://github.com/vllm-project/vllm/pull/59209), merged 19 November (`5e921de21`), after the tag: main only, no release yet.**
- **Enabling it on main.** `--kv-transfer-config '{"kv_connector":"HiSparseConnector","kv_role":"kv_both","kv_connector_extra_config":{"host_pool_gib":8}}'` (doc, "QSA models"). The surface is moving: the open PR #68771 adds `hisparse_config.host_pool_gib`.
- **What stays where (QSA).** Main K/V goes to host; indexer compressed keys, raw-key rings and GDN state stay in their normal GPU cache groups. The device layout becomes BLNHC. Prefix caching reuses whole scheduler pages. Draft (MTP) layers reuse the target's selections; their host mirror runs at the start of the next step. FP8 and BF16 main KV are supported (the PR's disaggregated benchmark used FP8-E4M3 main KV, BF16 indexer, FP32 GDN, MTP3, max context 1,048,576, 3,328-token pages).
- **Limits.** Decode context parallelism rejected; QSA with disaggregated prefill needs a separate NIXL change (#68281); `host_pool_gib` is per data-parallel replica and physical use can exceed it (padding, replicated heads); a request being admitted is charged its full footprint while running requests are charged only their tail pages (startup logs print a "HiSparse steady-state maximum concurrency" line).
- **Measured (GB300, TP2, not SM120).** Single engine: peak running requests 64 to 179 at 256 clients, with 5.3% lower throughput; low concurrency cost: 105.66 to 97.40 output tokens per second (-7.8%) for one 32k-in/512-out request and 1,143 to 869 (-24.0%) for eight 60k-in/10k-out requests; disaggregated 3P1D: +38% to +43% throughput at 16 to 64 open roots. A steady decode trace showed the fused resolver at 0.084 ms per rank per step and 7.5 ms vs 10.1 ms step intervals.
- **Meaning for us.** If it works on SM120, it is the only route I found that lets one request exceed the GPU pool, and a 1M request would need about 13 GiB of the box's roughly 117 GiB available RAM. It would also help prefix residency only for the main K/V (the indexer group would still need a generic offloader, which the doc says `OffloadingConnector` can do). It does not use NVMe, and it costs decode speed at low concurrency, which is our usual regime. SM120 and MPS behaviour, and the combination with `indexer_kv_dtype=fp8`, MTP and our checkpoint, are not verified.

## 7. Addendum: vLLM's own CPU + filesystem tier (added after the first pass)

Read by the coordinator after the report, from the v0.34.0 files named below (copies of the files were downloaded and searched). It corrects the "Not in vLLM" row in section 1.1 and the "I did not evaluate any of them" remark in section 3: UMBP is not the only NVMe route, and the native one is not ROCm-bound.

- **What it is.** `OffloadingConnector` with `"spec_name": "TieringOffloadingSpec"` gives a pinned-host-memory primary tier plus secondary tiers. The filesystem tier is `{"type": "fs", "root_dir": ..., "n_read_threads": ..., "n_write_threads": ...}` ([`docs/features/kv_offloading_usage.md` at v0.34.0](https://github.com/vllm-project/vllm/blob/v0.34.0/docs/features/kv_offloading_usage.md), lines 3-15, 72-96, 238-251). The doc says the connector supports CUDA, ROCm and XPU (line 6). Code: `vllm/v1/kv_offload/tiering/spec.py` and `vllm/v1/kv_offload/tiering/fs/{io,manager,thread_pool}.py`.
- **DRAM is not skipped.** Only the CPU tier has direct GPU access; every GPU-to-secondary transfer is staged through it (doc line 15; design principle 2 in the `tiering/manager.py` docstring). `cpu_bytes_to_use` is required. A small value keeps DRAM a gateway rather than a pool.
- **Eager write-through.** "Always offload to all tiers": a chunk stored to the primary tier is cascaded to every secondary tier (`tiering/manager.py` docstring, principle 1; `:950-952`). So NVMe writes equal all offloaded prompt blocks, as with UMBP. Decode blocks are skipped by default (`offload_prompt_only: true`).
- **I/O path.** O_DIRECT, with a start-up probe and a buffered fallback ([`tiering/fs/io.py:25-26, 41-55, 95-113`](https://github.com/vllm-project/vllm/blob/v0.34.0/vllm/v1/kv_offload/tiering/fs/io.py)), staged through host memory. No cuFile or GDS, so the box's missing `nvidia_fs` does not matter for it.
- **No capacity cap and no eviction.** The doc's FS key table has no size key, and a search of `tiering/fs/manager.py` for capacity, evict, unlink, quota, statvfs and disk_usage finds nothing at v0.34.0 or main. The tier grows until the disk is full, so a deployment needs its own bound (an XFS group quota, or a cleanup job). The doc tells the operator to delete orphaned digest folders by hand (line 451). What the tier does when a write fails on a full disk was not read.
- **Persistence.** "Secondary tiers are intentionally not reset: persistent stores" (`tiering/manager.py:1256`), so the NVMe cache survives an engine restart. A config change that alters the run digest (model, block size, parallelism, dtype) starts a new folder and orphans the old one.
- **Hybrid models.** `OffloadingConnector(KVConnectorBase_V1, SupportsHMA)` (`offloading_connector.py:56`) and it asserts a `HybridKVCacheCoordinator` (`:193`). The doc section on hybrid attention and recurrent models (with `blocks_per_chunk: 1`) exists on main only. #61601 (internal prefill checkpoints for the PLE short conv, merged 20 October) is an ancestor of v0.34.0; the report in section 3 says #60861 was closed as superseded by it (not re-checked).
- **Sizing.** Same cache groups, so the per-token and per-snapshot costs in section 4 apply. The retention is the filesystem tier's size, because everything is cascaded to it; the DRAM tier is a cache in front.
- **Host RAM (coordinator's box facts).** About 117 GiB available, of which the 47.7 GiB PLE table must stay in page cache for `disk_offload`. A pinned DRAM tier above roughly 32 GiB would start to squeeze that (arithmetic, not measured).
- **Not verified:** that it starts and gives correct output with our flags (FP8 KV, BF16 indexer side caches, external-drafter MTP, `supports_kv_connector() == False` on the QSA backend, MPS, SM120). No run on our setup is documented anywhere I read. Testing it needs a maintenance window on GPU0.

## Not verified

1. Whether any NVIDIA/CUDA build of UMBP or MoRI exists or is planned; I read only the CMake fragments and docs named above and did not search MoRI issues.
2. Whether UMBP's layout planner handles QSA's group types end to end (raw-key ring, compressed keys with `tokens_per_state=4`, the PLE short-convolution group) and our external-drafter MTP groups (the `connector.py:123-135` check); nothing was run.
3. Whether `supports_kv_connector() == False` on QSA blocks anything at runtime at v0.34.0 (no enforcing caller found on main; v0.34.0 cannot be code-searched); the earlier "no offload at all" conclusion is unreproduced either way.
4. What the 25 non-attention blocks per max-length request consist of; my 353-block figure assumes they stay constant with length.
5. GDS on the RTX PRO 6000 Blackwell Workstation (not named in NVIDIA's pages), the IOMMU requirement (not in the fetched pages), XFS on LVM, nvidia-fs support for el10 kernel 6.12, whether AlmaLinux's kernel has `CONFIG_PCI_P2PDMA` and an AMD host-bridge whitelist backport, and the master-branch whitelist (the fetch returned nothing). The NVIDIA pages were read through a summarising tool.
6. The T710's TBW and sequential speeds from Crucial's own datasheet (2,400 TBW is from a search-engine summary only).
7. Restore latency and bandwidth on a single local Gen5 NVMe for our blocks: only arithmetic, plus MoRI's eight-drive Kimi-K2.6 figures; contention with PLE-table reads and swap on the same drive is unquantified.
8. UMBP write volume on our traffic (needs the write rate and reuse-gap distribution), the saving from `lazy_offload`, and the object granularity on disk.
9. The MoRI policy-JSON key for SSD capacity, and the PRs MoRI #779, #882, #967 (taken from the blog).
10. HiSparse on SM120 and under MPS, with FP8 indexer cache and MTP on our checkpoint, and its `host_pool_gib` accounting for 2 KV heads; the benchmarks are GB300.
11. Prefill time, throughput and answer quality at 1M for our checkpoint (FP8 KV, YaRN x4, MTP); no source gives them. The cost of static YaRN on 70-100k prompts is unmeasured.
12. How main behaves when given the removed `--mamba-cache-mode` flag (the PR says removed; the failure mode was not tested).
13. The prefill logits layout and its memory at 1M in the QSA indexer (only the decode description and the 512 MiB budget were read).
