# vLLM v0.31.0 + FP8 KV migration — plan for the executing agent

> **Status: PLAN ONLY. Nothing in this document has been executed.** Written 2026-10-04 at the end of a long
> investigation. Facts marked "verified 2026-10-04" were checked that day (host reads over SSH, upstream source
> and pages). Anything in §2.6 was **not** verified: read it, do not guess it. Re-check anything that decays
> (versions, PR states, free disk space) before acting on it.

## 0. How to work with this document

1. **You** are an infrastructure agent with SSH access to `alfyroot` (the owner's home server, public
   188.36.122.6, LAN 192.168.1.96, `ssh alfyroot` = root) acting for the owner. The owner decides at every gate.
2. **Gates.** Work in order. At each **GATE (G0…G6, §4)** stop, report in chat, and continue only after the owner
   gives an explicit "yes" **for that gate**. Approval of one gate is never approval of the next. Approval does
   not carry over to a later session: ask again.
3. **Remote commands.** Every shell block below is meant to run on `alfyroot` as
   ```bash
   ssh -T alfyroot bash -s <<'EOF'
   ...commands...
   EOF
   ```
   (quoted `'EOF'`, so nothing expands locally). Keep each call short enough to finish inside the tool timeout;
   run long things in the background with `nohup` and poll.
4. **Labels.** `[READ-ONLY]` changes nothing. `[SAFE-WRITE]` creates files under `/root/v031-migration/` or a
   backup copy; trivially reversible. `[HOST-CHANGE]` changes host state (swap, Docker images, downloads, unit
   files). `[SERVICE-IMPACT]` stops or starts the production inference server (users see downtime).
5. **If the permission system blocks a command, do not rephrase it to get around the block.** Print the exact
   command and ask the owner to run it in their own terminal. (Earlier sessions found prod SSH writes are
   sometimes blocked by the classifier; the heredoc form above is the one that passed.)
6. **Progress file.** After every step append a line to `docs/plans/vllm-0-31-fp8/progress.md` (timestamp, step id,
   result, where the evidence lives). The owner has a weekly usage limit, so another agent may have to resume
   from that file. Keep it current.
7. **Evidence rule.** Never write "done" or "passed" without showing the output of the command that proves it.
8. **When in doubt, stop and ask.** A paused migration costs nothing; a broken production inference server takes
   down the owner's chat app (AlfyAI) and their coding agents.

## 1. Goal, constraints, definition of success

**Goal.** Raise the vLLM KV-cache pool on GPU0 so several users, each running many sub-agents, can share the one
inference server without queueing or preemptions. Today's pool is **337,244 tokens (9.77 GiB, "Maximum concurrency
1.29×" at 262,144 tokens/request)**.

**Constraints (owner's decisions, final):**
- Per-request context stays at the model's **native 262,144** (`--max-model-len 262144`). No YaRN, no longer
  context.
- The model stays **uncensored**.
- **No loss of inference speed** (see the acceptance table in Appendix D for the exact thresholds).
- The app must not need changes: same port **30000**, same `--served-model-name qwen3-6-27b qwen3-8-flash-next
  flash-next`, OpenAI-compatible API unchanged.
- Prefer keeping bulk data on `/home` (1.2 TB free) rather than `/` (53 GB free).
- No code changes in the AlfyAI repo are part of this plan.

**Success =** vLLM v0.31.0 serving an uncensored Flash-Next checkpoint with FP8 KV on GPU0, boot log showing a pool of
**≥ 600,000 tokens** (stretch: ≥ 675,000 ≈ 2×), every acceptance check in Appendix D green, the old server still
available as a one-command rollback.

**Non-goals:** NVFP4 KV cache (vLLM PR #54846, still open), NVFP4 PLE (PR #56273, still open), the Pennyroyal
SGLang fork (plan B only, see §9), moving Docker's data root, touching GPU1 or any other container, post-cutover
soak monitoring, and any cleanup or deletion of the old stack (the owner decides those separately; this plan never
deletes the old stack).

## 2. Facts you can rely on

### 2.1 Host `alfyroot` (verified 2026-10-02 and 2026-10-04)

| Item | Value |
|---|---|
| GPU0 | RTX PRO 6000 Blackwell Workstation, 97,887 MiB total, ~95.3 GiB used by prod vLLM, ~2 GiB free, PCIe Gen5 ×8 |
| GPU1 | RTX PRO 5000 Blackwell 48 GB; hosts `tei-embed`, `tei-rerank` and MinerU's vLLM engine (~14 GiB used). **Do not use it.** |
| RAM | 185.7 GiB total; ~124–133 GB `MemAvailable` (88–96 GiB of it page cache, ~50 GiB charged to Plex); ~46 GiB resident anon |
| Swap | 32 GiB LVM (`almalinux_alfyws-swap`, `/dev/dm-1`) on NVMe, **99% full of cold pages** of idle containers, not thrashing (si/so≈0). `vm.swappiness=10`, zswap off, no PSI files |
| `/` | 200 GB LVM, 53 GB free, 74% used. **Docker's data root `/var/lib/docker` lives here** (overlayfs on the containerd snapshotter) |
| `/home` | 3.3 TB LVM on NVMe, 1.2 TB free. Models in `/home/alfyws/hf_models/` |
| Docker | 43 containers (Matrix, Bitwarden, Immich, Plex, Minecraft, OpenRouteService ×4, Nominatim, MinerU, TEI ×2, SearXNG, …). Images 105 GB; the current vLLM image is 28.7 GB unpacked; build cache 18.7 GB (docker reports 0 B "reclaimable") |
| Toolchain | Python 3.12.14, `uv`, CUDA 13.0/13.1/13.4 under `/usr/local`, driver 615.71.09 (CUDA 13.4) |
| Old venv | `/home/alfyws/venvs/vllm` = vLLM **0.28.0**, torch 2.13.0+cu130 (belongs to the old, disabled 27B unit; it **cannot** serve Flash-Next, which needs ≥ 0.29.0) |

### 2.2 Current production inference server (verified 2026-10-04)

- `systemctl` unit **`vllm-flashnext.service`** (enabled, active since 2026-09-28 16:19 CEST) runs
  `docker run … vllm/vllm-openai:qwen38-flash-next` (vLLM `0.1.dev20073+g8e685d198`), container **`vllm-flashnext`**,
  GPU0 only, port mapping `30000:8000`. Full unit text: **Appendix A**. The owner remembers a venv; the live
  service is Docker (the venv is the old 27B unit, `vllm-qwen27b-heretic.service`, disabled).
- Model: `aday777/Qwen3.8-Flash-Next-Uncensored-NVFP4-MTP` (RTN NVFP4, BF16 attention, MTP inside) at
  `/home/alfyws/hf_models/flashnext/aday-uncensored-nvfp4-mtp`, with the PLE n-gram table served from a 28.8 GB NVFP4
  sidecar (`/home/alfyws/hf_models/flashnext/ple-quant/`, three bind-mounted overlay `.py` files). That overlay cannot be
  ported to newer vLLM, which is why a migration is wanted.
- Boot log of that server: `Model loading took 76.06 GiB`, `Available KV cache memory: 9.77 GiB`, `GPU KV cache
  size: 337,244 tokens, Maximum concurrency for 262,144 tokens per request: 1.29x`, util 0.94, attention block
  1600 tokens, MTP k=3, `--max-num-seqs 16`, prefix caching on, vision working.
- The app (AlfyAI) reaches it at `http://192.168.1.96:30000/v1` through DB row `provider_models.name='qwen3-6-27b'`
  (provider `model1`) in `/home/alfydesign/apps/langflow-chat/shared/data/chat.db`; a Cloudflare tunnel exposes
  it as `https://inference.alfycomms.com/v1` (OpenCode uses that). **Do not touch any of this.**
- Earlier measurements (2026-09-03 → 09-30, use only as a sanity reference; re-measure in Phase A): single-stream
  decode ≈ 111 tok/s median; aggregate 110/197/514/542/585 tok/s at concurrency 1/4/8/16/32; MTP acceptance ≈ 64%
  (≈ 2.9 tokens per step); prefill ≈ 52k tokens in 3.8 s cold, 107k in 4.6 s cold.
- **A restart takes 3–3.5 minutes.** During the boot, `curl` to :30000 gets an instant *connection refused* because
  docker-proxy is up before vLLM is. That is normal. Do not restart-loop or "fix" config during that window.

### 2.3 Workload evidence (why this matters)

2026-09-28 → 10-04 (≈ 6 days of uptime): 4,513 requests, 352M prompt tokens vs 2.5M generated (≈ 78k average
prompt; the last 2 days averaged ≈ 95k), prefix-cache hit rate 91%, **89 preemptions** (64 two days earlier), KV usage
≥ 90% in 46 of 2,982 ten-second log samples, and at one check **2 requests running + 2 waiting for capacity at 74%
pool usage**. The pool is the binding constraint for long agentic sessions.

### 2.4 Upstream (verified 2026-10-04)

- **vLLM v0.31.0** was tagged **2026-10-02** (commit `db9527a`; rc1 2026-09-29 → rc5 2026-10-02). The Docker image
  **`vllm/vllm-openai:v0.31.0`** exists: digest
  `sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3`, 10.13 GB compressed, amd64+arm64,
  last updated 2026-10-04 01:11 UTC. **It is NOT on PyPI yet** (`/pypi/vllm/0.31.0/json` → 404; newest is 0.30.0).
  The GitHub *Releases* list did not show it and its notes page failed to load, so **the release notes were not
  read** (§2.6).
- **FP8 KV for this model's QSA attention** (PR #55557, merged 2026-09-16): present at the v0.31.0 tag
  (`vllm/models/qwen4_exp/nvidia/qsa.py` lists `fp8`/`fp8_e4m3`, views the cache as `float8_e4m3fn`, passes
  `k_scale`/`v_scale` to the kernel). **v0.30.0 does not have it** (BF16-only, "requires a BF16 main KV cache").
  Reported by the PR on a 96 GB RTX PRO 6000: pool 434,886 → 771,704 tokens (×1.77); decode unchanged and prefill
  +2% *without* MTP; **with MTP, draft acceptance fell 0.725 → 0.630 and decode throughput fell 7–11%**. Quality
  checks in the PR were clean (logprob drift at noise level, RULER-lite 15/16 both, needle 12/12 to 768k).
- Side caches (indexer ring, compressed keys) and GDN state stay BF16. FP8 halves the attention page, so vLLM
  raises the attention block from 1600 to roughly 3200 tokens (coarser prefix-cache granularity, negligible at
  ~95k-token prompts).
- **How stock vLLM offloads the PLE table** (PR #54371, merged 2026-09-09; enabled by `VLLM_PLE_CPU_OFFLOAD=1` or
  `--engram-config` with `cpu_offload=true`): the table sits in **pinned host RAM** (not VRAM, no mmap or disk) and a
  GPU kernel on a side CUDA stream reads just the needed rows over PCIe through UVA. There is no CPU worker process
  and no CPU compute; all model compute stays on GPU0. The PR measured decode roughly flat (+1.8–2.9%). Pinned
  means non-swappable and non-reclaimable, which is why B1 and the RAM gate exist. **Taken from the PR text; not yet
  confirmed in the v0.31.0 source** (§2.6-4), so B3 greps for it. Today's setup differs: a separate CPU worker
  process serves a 28.8 GB NVFP4 sidecar from reclaimable page cache.
- **NVFP4 PLE** (PR #56273): still **open**, rebased 2026-10-02, awaiting code-owner review. **Stock v0.31.0 loads
  only FP8/BF16 PLE checkpoints.** Checkpoints with packed-NVFP4 PLE (huginnfork's abliterated build declares
  `ple_embedding_dtype: nvfp4`; also provsalt, local-inference-lab, hibrid) will **not** load on stock.
- **Reference recipe** (vllm-project/recipes PR #1055, open): 1× RTX PRO 6000, TP1, image nightly
  `a9eafde59cbd…` (2026-09-27); command in **Appendix C**. Measured there: KV pool **602,931 tokens (2.30× at
  262,144)**, single-stream decode 128.6–149.0 tok/s, prefill 15.6–17.0k tok/s, 0 preemptions in burn-in, weights
  74.34 GiB, "~51 GB N-gram embedding table in pinned host RAM". Tested at `--max-num-seqs 4` and MTP k=2.
- Another team's stock-v0.30.0 TP=2 recipe reported a **65 GB pinned-memory** footprint for the FP8 PLE table, a
  FlashInfer-autotune deadlock (fix `--no-enable-flashinfer-autotune`), and chat-template errors on system
  messages / `reasoning_effort` values with NVIDIA's checkpoint. Treat all three as things to watch for.

### 2.5 Candidate checkpoint and drafter

- **Main checkpoint:** `jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4` (Hugging Face; abliterated
  OrcaRouter build quantized with ModelOpt 0.46; 329 files; **135,243,553,424 bytes ≈ 126 GiB**; last modified
  2026-09-17; license declared "Qwen Community License 1.0" with conflicting metadata; evidence of testing is "daily
  agentic use" on the author's Pennyroyal/SGLang runtime — **not tested on vLLM**).
  `config.json` (read 2026-10-04): arch `Qwen4ExpForConditionalGeneration`, `quant_method: modelopt`,
  `quant_algo: NVFP4`, `ple_embedding_dtype: float8_e4m3fn` (FP8 PLE, **loadable on stock vLLM**), attention / GDN /
  shared experts / hyper-connections / vision / embeddings / lm_head **not quantized** (BF16), **MTP weights not
  quantized (BF16)**. HF metadata: 8.0B BF16 params, 60.4 GB packed experts, 51.2 GB FP8 PLE.
- **Lineage (verified 2026-10-04 from the Hub's `cardData.base_model` fields):** the model running now,
  `aday777/Qwen3.8-Flash-Next-Uncensored-NVFP4-MTP`, is derived from `mazinb/Qwen3.8-Flash-Next-Uncensored-NVFP4`, whose bases
  are `orcarouter/Qwen3.8-Flash-Next-Uncensored` (the abliterated BF16 model), `primitive-ai/Qwen3.8-Flash-Next-NVFP4` and
  `Qwen/Qwen3.8-Flash-Next`. The candidate `jpezzulli/…ModelOpt-NVFP4` is derived from `OrcaRouter/Qwen3.8-Flash-Next-Uncensored`
  + `Qwen/Qwen3.8-Flash-Next`. **So both are quantizations of the same OrcaRouter abliteration**; only the quantization and
  packaging differ (RTN NVFP4 vs ModelOpt 0.46 NVFP4, BF16 vs FP8 PLE). OrcaRouter's own card reports refusal rates falling
  from 64–100% to ~0–3.3% on harmful prompts with capability within ±2 points of the base; **no refusal numbers exist for
  jpezzulli's conversion** (his evidence is daily agentic use), which is why Appendix D's T4 refusal probe is a hard check.
  License metadata is inconsistent across these repos (Apache-2.0 vs Qwen Community License 1.0); fine for personal use,
  but mention it to the owner.
- **Memory consequence (estimate, from HF metadata + our own boot log):** GPU weights ≈ 74.6 GiB for the main model
  *without* MTP + 4.8 GiB for its BF16 MTP. To avoid the 4.8 GiB, run MTP from a **separate NVFP4 drafter
  directory (~1.5 GiB)** exactly like the reference recipe does. Pool estimates (formula: KV GiB = util × 95.06 −
  weights − 1.77 non-torch − 1.75 activation; FP8 ≈ 61–67k tokens per GiB):

  | Setup | KV memory | Pool (tokens) | vs today |
  |---|---|---|---|
  | **A** main + external NVFP4 drafter, util 0.94 | ~9.8 GiB | **~600–650k** | ~1.8–1.9× |
  | **A+** same, util 0.95 | ~10.8 GiB | ~660–700k | ~2× (≈1 GiB headroom, thin) |
  | **B** main with its own BF16 MTP, no drafter | ~6.4 GiB | ~400–430k | ~1.2–1.3× |

- **Drafter:** the recipe uses a directory `Qwen3.8-Flash-Next-MTP-NVFP4`, said to come from
  `Inferact/Qwen3.8-Flash-Next-NVFP4` (redistributed byte-for-byte by `provsalt/Qwen3.8-Flash-Next-NVFP4-PLE-NVFP4`).
  **How to obtain or build that directory is not verified** (§2.6 item 1). It is the *base* model's MTP head, not
  the uncensored one, so draft acceptance may differ slightly. Speculative decoding is lossless with respect to the main
  model (it verifies every proposed token), so a non-uncensored drafter cannot make the output censored; it only affects the
  acceptance rate. **On-box candidate, unverified:** the current aday777 checkpoint already contains NVFP4 MTP experts from the
  uncensored lineage (`MTP_NVFP4_MANIFEST.json` in its directory); in A3 evaluate whether a drafter directory can be assembled
  from it if the recipe's drafter cannot be obtained.

### 2.6 NOT verified — read the source, do not guess

1. How to produce the drafter directory (read the description and files of vllm-project/recipes **PR #1055**), its
   size, and whether `speculative-config.model` needs tokenizer/config files in it.
2. The v0.31.0 release notes (known issues, flag changes). Try `gh release view v0.31.0 -R vllm-project/vllm` or the
   tag's commit list.
3. That the jpezzulli checkpoint loads and generates correctly on vLLM v0.31.0 at all.
4. The exact environment variable / flag names for PLE host offload in v0.31.0 (`VLLM_PLE_CPU_OFFLOAD`,
   `VLLM_PLE_OFFLOAD_READY_TIMEOUT`, `--engram-config`, …) and the accepted syntax of the FP8 indexer flag
   (`--attention-config.indexer_kv_dtype fp8` as tested in the recipe, or `--attention-config
   '{"indexer_kv_dtype":"fp8"}'`). Inspect the image (step B3), do not assume.
5. Real pool size, MTP acceptance with an external base-model drafter on an uncensored main model, real pinned-RAM
   use (PR #59848, open, says the pinned PLE table is not yet sized exactly), chat-template and tool-parser
   behaviour with the app, vision behaviour.

## 3. Hard safety rules (never)

1. Never run `systemctl restart docker`, `docker system prune`, `docker image prune -a`, `docker volume prune`,
   or `docker rm -f` on anything except `vllm-flashnext-v031`. Never stop, restart, or reconfigure any other
   container.
2. Never delete or modify: the image `vllm/vllm-openai:qwen38-flash-next`, `/etc/systemd/system/vllm-flashnext.service`
   (copies only), `/home/alfyws/hf_models/flashnext/aday-uncensored-nvfp4-mtp`, `/home/alfyws/hf_models/flashnext/ple-quant/`,
   any venv, the app databases, or the app's env files. The old stack is the rollback.
3. Never change the port (30000), the served-model-names, the app DB, the Cloudflare tunnel, firewalld, or anything
   on the router.
4. Never change sysctls (`vm.swappiness` etc.).
5. Run heavy disk I/O (downloads, checksums) only inside a memory-capped transient unit (§6, B4) so page cache
   cannot evict the live server's hot pages or push more memory into swap.
6. Never run two vLLM instances on GPU0. Never use GPU1.
7. No high-concurrency test on production outside the approved window.
8. No repo code changes, no `git commit`/`git push` unless the owner asks. The files in this folder are plain docs.
9. Never print or copy secrets (e.g. `/root/verify-harness.env`). Public Hugging Face downloads need no token; if one
   seems to be needed, ask the owner.
10. Third-party checkpoint hygiene: only `*.safetensors`. If any `*.bin`, `*.pt`, `*.pth`, `*.pkl`, `*.ckpt` exists,
    STOP and report. If any `*.py` exists in the checkpoint directory, **read it** before using
    `--trust-remote-code` and report what it does.
11. Debug boots **one variable at a time**; at most **3 boot attempts per window**; then roll back and report.
12. Never leave the box in a state you have not told the owner about.

## 4. Gates (owner approval required)

| Gate | Before this step | Needed from the owner |
|---|---|---|
| **G0** | Phase A (reads, light baselines on idle prod) | Docker (default) vs venv-on-/home choice (Appendix E); acceptable hours; confirms light test traffic on prod is OK when idle |
| **G1** | B1 swap reset | explicit OK (changes system swap on a prod box) |
| **G2** | B2 build-cache prune + B3 image pull | explicit OK (≈ 10 GB download, ≈ 29 GB unpacked on `/`) |
| **G3** | B4 downloads | explicit OK stating source, filenames and sizes (checkpoint ≈ 126 GiB + drafter) |
| **G4** | B5 create the new unit file (not enabled) | explicit OK |
| **G5** | Phase C maintenance window | date/time, expected downtime (≈ 60–90 min with ≈ 20–30 min of actual outage), rule that you roll back on any red check |
| **G6** | Phase D cutover (enable/disable units) | explicit OK after the acceptance table is green |

## 5. Phase A — reconnaissance and baselines (no downtime)

**A1 `[READ-ONLY]` Verify the host still matches §2.** Expected: container `Up`, GPU0 ≈ 95 GiB used / ≈ 2 GiB free,
`/` ≈ 53 GB free (≥ 45 GB is required later), `/home` ≈ 1.2 TB free, swap ≈ full, 0 established connections when idle.
```bash
systemctl is-active vllm-flashnext; systemctl is-enabled vllm-flashnext
docker ps --filter name=vllm-flashnext --format '{{.Names}}  {{.Image}}  {{.Status}}'
nvidia-smi --query-gpu=index,name,memory.used,memory.free,memory.total --format=csv,noheader
free -m | sed -n '1,3p'; grep -E 'MemAvailable|SwapTotal|SwapFree' /proc/meminfo; sysctl vm.swappiness
df -h / /home | cat; docker system df
curl -s --max-time 5 http://127.0.0.1:30000/metrics | grep -E '^vllm:(num_requests_running|num_requests_waiting|kv_cache_usage_perc|num_preemptions_total|prompt_tokens_total|generation_tokens_total|spec_decode_num_(accepted|draft)_tokens_total)' | grep -v '^#'
echo -n "established connections on :30000 = "; ss -Htn state established '( sport = :30000 )' | wc -l
```
If anything differs materially (different container, different image, GPU0 not ≈ full, a new tenant on GPU0),
**stop and report**.

**A2 `[SAFE-WRITE]` Snapshot the current setup** (also makes the unit backup):
```bash
mkdir -p /root/v031-migration/{baseline,logs,results,corpus,bench}
systemctl cat vllm-flashnext > /root/v031-migration/baseline/old-unit.txt
cp -a /etc/systemd/system/vllm-flashnext.service /etc/systemd/system/vllm-flashnext.service.bak-pre-v031-$(date +%Y%m%d)
docker image inspect vllm/vllm-openai:qwen38-flash-next --format '{{.Id}} size={{.Size}}' > /root/v031-migration/baseline/old-image.txt
docker logs vllm-flashnext 2>&1 | grep -E 'non-default args|Model loading took|Available KV cache memory|GPU KV cache size|Setting attention block size|Free memory on device' | head -12 > /root/v031-migration/baseline/old-boot-lines.txt
curl -s --max-time 5 http://127.0.0.1:30000/metrics > /root/v031-migration/baseline/metrics-start.txt
M=/home/alfyws/hf_models/flashnext/aday-uncensored-nvfp4-mtp
cp -a $M/generation_config.json $M/config.json /root/v031-migration/baseline/
ls $M | grep -iE 'chat_template|tokenizer_config' | while read f; do cp -a "$M/$f" "/root/v031-migration/baseline/old-$f"; done
ls -la /root/v031-migration/baseline/
```

**A3 Research (no host changes).** Write what you find in `docs/plans/vllm-0-31-fp8/findings.md`:
- recipes **PR #1055**: how the MTP drafter directory is made; any update to the tested command (§2.6-1);
- vLLM **v0.31.0** release notes / known issues (§2.6-2);
- the jpezzulli model card for any vLLM notes; whether anyone reports running it on vLLM;
- PyPI status for `vllm==0.31.0` (only matters for Appendix E): `curl -s -o /dev/null -w '%{http_code}\n' https://pypi.org/pypi/vllm/0.31.0/json`.

**A4 `[SAFE-WRITE]` Build the test suite** described in **Appendix D** under `/root/v031-migration/bench/` (use the
python in `/home/alfyws/venvs/vllm/bin`; it already has `openai`/`aiohttp`). Make the prompt corpus from a fixed set
of text (e.g. the repo's `AGENTS.md` and `docs/*.md`, ≥ 400k tokens, copied once to `/root/v031-migration/corpus/`
with its `sha256sum` recorded) so baseline and trial runs use identical prompts. Dry-run each test at tiny scale first.

**A5 Light baselines on live production** (`[READ-ONLY]` for the server, but it does send requests): run **only
when A1 shows 0 running, 0 waiting, 0 established connections**, and stop immediately if a real request arrives.
Run T0, T1, T2 with C ≤ 4, T4, T6 from Appendix D against `http://127.0.0.1:30000/v1`, model `qwen3-6-27b`. Save
raw JSON to `/root/v031-migration/results/old-*.json` and a summary to `baseline/summary.md`. (T3 burst and T5
200k needle wait for the window: they would starve real users.)

**GATE G0 report:** state of host vs §2, what the research found (especially the drafter recipe and release notes),
baseline numbers, the proposed track and the proposed window options.

## 6. Phase B — host preparation (no downtime, needs approvals)

**B1 `[HOST-CHANGE]` Reset swap (GATE G1).** Why: the 32 GiB of swap is full of cold pages, leaving no safety margin
just before a step that pins 51–65 GB of host RAM. Preconditions (all must hold, else stop and report):
- `MemAvailable` ≥ swap-used + 20 GiB (expected: ≈ 127 GiB vs ≈ 32 GiB used);
- `vmstat 1 3` shows `si`/`so` ≈ 0; A1 shows 0 running requests;
- `/etc/fstab` has the swap entry (`grep swap /etc/fstab`) and you recorded the exact device from
  `swapon --show --noheadings --raw`.
```bash
DEV=$(swapon --show --noheadings --raw | awk 'NR==1{print $1}'); echo "swap device: $DEV"
nohup sh -c "swapoff $DEV && swapon $DEV" > /root/v031-migration/logs/swap-reset.log 2>&1 < /dev/null &
# poll every ~20 s until the background job ends:
free -m | sed -n '1,3p'; swapon --show; cat /root/v031-migration/logs/swap-reset.log
```
Abort rule: if `MemAvailable` falls below 20 GiB during the run, `pkill -INT swapoff` (swap stays enabled).
Verify: swap used < 1 GiB, device active again, `dmesg | tail` shows no OOM, and a quick completion on the old
server still decodes at a normal speed (repeat T0). Expected `MemAvailable` afterwards: ≈ 90–100 GiB.
**RAM gate for Phase C: `MemAvailable` ≥ 90 GiB before the new server boots.** If the owner declines B1, tell them
plainly that with swap full an out-of-memory event would trigger the kernel OOM-killer (databases and the new
vLLM are candidates) instead of swapping, and ask for an explicit acceptance of that risk.

**B2 `[HOST-CHANGE]` Free build cache and enforce the disk gate (GATE G2).** `docker builder prune -f` only removes
build cache. Docker reports 0 B reclaimable, so it may free little; measure it. Never use `-a` variants of other prune
commands.
```bash
docker system df
docker builder prune -f
docker system df; df -h / | cat
```
**Disk gate: `/` must show ≥ 45 GB free before the pull** (peak = compressed layers + unpacked image ≈ 39 GB).
If not, stop and ask the owner what to free.

**B3 `[HOST-CHANGE]` Pull and inspect the image (GATE G2).**
```bash
D=sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3
docker pull vllm/vllm-openai@$D
docker tag vllm/vllm-openai@$D vllm/vllm-openai:v0.31.0-pinned
docker image inspect vllm/vllm-openai:v0.31.0-pinned --format 'size={{.Size}} digests={{.RepoDigests}}'
df -h / | cat      # expect >= 15 GB still free
```
If the digest pull is refused or the digest differs from §2.4, **stop and report** (the tag may have been re-pushed);
you may `docker rmi` only the *new* image reference you created. Then inspect the image **without a GPU**:
```bash
I=vllm/vllm-openai:v0.31.0-pinned
P=/usr/local/lib/python3.12/dist-packages/vllm
docker run --rm --entrypoint python3 $I -c "import vllm; print(vllm.__version__)"        # expect 0.31.0
docker run --rm --entrypoint grep $I -n -E "supported_kv_cache_dtypes|float8_e4m3fn" $P/models/qwen4_exp/nvidia/qsa.py | head
docker run --rm --entrypoint grep $I -rn -E "VLLM_PLE|ENGRAM|engram" $P/envs.py | head -20
docker run --rm --entrypoint grep $I -rniE "uva|pinned|cpu_offload" $P/models/qwen4_exp | head -20     # confirms the UVA design
docker run --rm --entrypoint vllm $I serve --help=all 2>/dev/null | grep -iE -A1 "attention-config|--kv-cache-dtype|--mamba-cache-mode|--speculative-config|engram|cpu-offload" | head -60
```
Use the output to settle §2.6-4 and to correct the unit draft in Appendix B **before** staging it. (If the
`$P` path differs, find it with `python3 -c "import vllm,os;print(os.path.dirname(vllm.__file__))"` in the image.)

**B4 `[HOST-CHANGE]` Downloads (GATE G3).** Ask first, stating: source
`huggingface.co/jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4`, 329 files, ≈ 126 GiB, into
`/home/alfyws/hf_models/flashnext/v031/jpezzulli-orcarouter-uncensored-nvfp4/`; plus the drafter per §2.6-1 (state
its source and size). Preconditions: `/home` ≥ 300 GB free; `hf` or `huggingface-cli` present in
`/home/alfyws/venvs/vllm/bin`. Run as user `alfyws`, in a memory-capped, low-priority transient unit, in the
background (resumable; re-running continues):
```bash
sudo -u alfyws mkdir -p /home/alfyws/hf_models/flashnext/v031
systemd-run --unit=v031-dl -p User=alfyws -p MemoryHigh=6G -p MemoryMax=12G -p MemorySwapMax=0 -p IOWeight=20 \
  --collect --working-directory=/home/alfyws \
  /bin/bash -lc 'source /home/alfyws/venvs/vllm/bin/activate && hf download jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4 --local-dir /home/alfyws/hf_models/flashnext/v031/jpezzulli-orcarouter-uncensored-nvfp4 > /home/alfyws/v031-dl.log 2>&1'
# poll: systemctl is-active v031-dl; tail -3 /home/alfyws/v031-dl.log; du -sh /home/alfyws/hf_models/flashnext/v031/*
```
(If `hf` is not the CLI name in that venv's `huggingface_hub`, use `huggingface-cli download` with the same
arguments.) When finished, verify **every file** against the Hub's sizes and sha256 (also in a capped unit; the
checksum pass reads 126 GiB):
```python
import hashlib, json, os, urllib.request
repo = "jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4"
root = "/home/alfyws/hf_models/flashnext/v031/jpezzulli-orcarouter-uncensored-nvfp4"
meta = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}?blobs=true"))
bad = 0
for s in meta["siblings"]:                       # confirm these JSON keys on first run
    p = os.path.join(root, s["rfilename"])
    if not os.path.exists(p): print("MISSING", s["rfilename"]); bad += 1; continue
    if s.get("size") is not None and os.path.getsize(p) != s["size"]:
        print("SIZE MISMATCH", s["rfilename"]); bad += 1; continue
    sha = (s.get("lfs") or {}).get("sha256")
    if sha:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(8 << 20), b""): h.update(chunk)
        if h.hexdigest() != sha: print("SHA MISMATCH", s["rfilename"]); bad += 1
print("files:", len(meta["siblings"]), "problems:", bad)
```
Then the hygiene and parity checks (rule 10 in §3):
```bash
C=/home/alfyws/hf_models/flashnext/v031/jpezzulli-orcarouter-uncensored-nvfp4
ls $C | grep -E '\.(bin|pt|pth|pkl|pickle|ckpt)$' && echo "STOP: pickle-type files present"
ls $C/*.py 2>/dev/null; grep -n auto_map $C/config.json $C/tokenizer_config.json 2>/dev/null
python3 -c "import json;c=json.load(open('$C/config.json'));print(c['architectures'],c['quantization_config'].get('quant_algo'),c.get('ple_embedding_dtype'))"
diff <(python3 -m json.tool /root/v031-migration/baseline/generation_config.json) <(python3 -m json.tool $C/generation_config.json) && echo "generation_config identical"
```
Expected: no pickle files, no `*.py` (or reviewed), `['Qwen4ExpForConditionalGeneration'] NVFP4 float8_e4m3fn`, total size
≈ 135.2 GB. Compare the chat template of the old checkpoint
(`baseline/old-*`) with the new one and note differences (system messages, tools, thinking toggle,
`reasoning_effort`). A different `generation_config.json` matters because clients that send no sampling rely on it
(old defaults: temperature 1.0, top_k 20, top_p 0.95; the app and OpenCode send their own 0.6/0.95/20).

**B5 `[HOST-CHANGE]` Stage the trial unit (GATE G4).** Write `/etc/systemd/system/vllm-flashnext-v031.service` from
**Appendix B** after correcting it with the B3 findings. Then:
```bash
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/vllm-flashnext-v031.service
systemctl is-enabled vllm-flashnext-v031     # must say: disabled
systemctl is-active vllm-flashnext-v031      # must say: inactive
```
Do **not** enable or start it. Confirm the old unit is still enabled and active.

**B6 Pre-window checklist (report at GATE G5):** swap reset done or risk accepted; `MemAvailable` ≥ 90 GiB; `/` ≥ 15 GB
free; image pinned; checkpoint verified; drafter ready; unit staged; backups exist; the owner picked a quiet time;
the test suite is ready; the rollback commands are in front of you (§7 C8).

## 7. Phase C — maintenance window (GATE G5)

Budget 60–90 minutes; real outage ≈ 20–30 minutes. Time-box: if you are not serving traffic on the old stack again
within 2 hours, stop experimenting and roll back.

**C0 Pre-flight (all must be true):** A1 checks pass; 0 running / 0 waiting / 0 established connections for 3 minutes;
the owner has said "go". Log the start time.

**C1 `[SERVICE-IMPACT]` In-window baseline on the OLD server.** Run the heavy tests T2 (full ladder to C=16), T3
(burst 8/16/24) and T5 (200k needle) from Appendix D. Save as `results/old-*.json`. This is the fair "before" for
the A/B. Record `/metrics` deltas (preemptions, spec-decode counters).

**C2 `[SERVICE-IMPACT]` Stop the old server and verify the GPU is free.**
```bash
systemctl stop vllm-flashnext
for i in $(seq 1 30); do u=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i 0); echo "gpu0 used MiB: $u"; [ "$u" -lt 2000 ] && break; sleep 5; done
docker ps -a --filter name=vllm-flashnext --format '{{.Names}} {{.Status}}'      # expect no rows
```
If GPU0 is not freed within 2.5 minutes: **stop, do not kill unknown processes**, report.

**C3 `[SERVICE-IMPACT]` Start the new server and watch the boot.**
```bash
systemctl start vllm-flashnext-v031
# poll (run in short batches; boot may take 6–15 minutes the first time):
for i in $(seq 1 30); do sleep 10; echo "$(date +%T) http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:30000/v1/models)"; done
```
Every ~60 s while booting:
```bash
docker logs --since 90s vllm-flashnext-v031 2>&1 | grep -E 'ERROR|Traceback|OutOfMemory|out of memory|Killed|Autotuning|Capturing|init engine|Application startup|KV cache' | tail -15
free -m | sed -n '1,3p'; grep -E 'MemAvailable|SwapFree' /proc/meminfo
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader -i 0
```
**Abort triggers** (then C8 rollback): host `MemAvailable` < 15 GiB; swap usage growing; any kernel OOM line
(`journalctl -k --since "15 min ago" | grep -iE 'out of memory|oom-kill'`); a Python traceback loop; no listener after
25 minutes. Remember: connection-refused for the first ~3–6 minutes is normal.

**C4 Capture boot facts** (record all in `results/new-boot-lines.txt`):
```bash
docker logs vllm-flashnext-v031 2>&1 | grep -E 'Initializing a V1 LLM engine|Model loading took|Available KV cache memory|GPU KV cache size|Maximum concurrency|Setting attention block size|Free memory on device|kv_cache_dtype' | cut -c1-420
```
**Boot gates:** `kv_cache_dtype=fp8` in the engine init line; `Model loading took` ≈ 76 GiB with the external drafter (≈ 79–80
GiB means the BF16 MTP got loaded: fix the speculative config, do not accept); `GPU KV cache size` ≥ 600,000 tokens (500–600k:
report and let the owner decide; < 500k: treat as failed). Then record `nvidia-smi` free MiB (want ≥ 1,000) and host
`MemAvailable`.

**C5 Functional smoke tests (Appendix D: T0, T4, T6, T7).** The app-level harness T7 runs against **staging**
(`:3002`), which uses this same inference server, so it exercises tool calls, streaming, thinking toggle and file
production without touching production traffic. Any failure here is a hard stop unless a one-variable fix is
obvious and within the 3-boot budget (e.g. switching `--tool-call-parser` to `qwen3_xml`).

**C6 Benchmarks, same suite as the baseline (T1, T2, T3, T5).** Also record the MTP acceptance
(`vllm:spec_decode_num_accepted_tokens_total / vllm:spec_decode_num_draft_tokens_total` deltas), preemptions, peak
`vllm:kv_cache_usage_perc`, `num_requests_waiting_by_reason{reason="capacity"}` peak, GPU free MiB and host
`MemAvailable` at the end of the burst.

**C7 Short soak (≥ 20 min):** replay T3 at C=12 twice, then idle 5 minutes; confirm no errors, no growth of swap
(`pswpin`/`pswpout` deltas in `/proc/vmstat`), no OOM, GPU free ≥ 600 MiB.

**C8 Decide.** Compare against Appendix D's acceptance table.
- **All green →** leave the new server running (the old unit stays *enabled* until G6, so a reboot would bring the old
  stack back, which is the safe default), report, and wait for G6.
- **Any red →** roll back immediately:
```bash
systemctl stop vllm-flashnext-v031
for i in $(seq 1 30); do u=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i 0); echo "gpu0 used MiB: $u"; [ "$u" -lt 2000 ] && break; sleep 5; done
systemctl start vllm-flashnext
# poll /v1/models for up to ~6 minutes, then:
docker logs vllm-flashnext 2>&1 | grep -E 'GPU KV cache size' | tail -1     # expect 337,244 tokens
```
Re-run T0 against the old server and confirm normal decode speed. Report what failed, with evidence. Rollback takes
≈ 4 minutes.

## 8. Phase D — cutover (GATE G6, only if C8 was all green)

```bash
sed -i 's/^Restart=no/Restart=always/' /etc/systemd/system/vllm-flashnext-v031.service
systemctl daemon-reload
systemctl disable vllm-flashnext
systemctl enable vllm-flashnext-v031
systemctl is-enabled vllm-flashnext vllm-flashnext-v031     # disabled / enabled
systemctl is-active vllm-flashnext-v031                      # active
```
Do **not** delete the old unit file, image, checkpoint or sidecar. No app/DB change is needed (same port and names).
Optional, only with the owner's OK: tune later (util 0.95, `num_speculative_tokens`, `qwen3_xml`); see §9.
Then update documentation: the project memory notes (`alfyai-local-model-flashnext.md`,
`alfyai-kv-cache-capacity-fp8-plan.md`, `MEMORY.md` index) and grep the repo for stale references
(`grep -rn "qwen38-flash-next\|vllm-flashnext\|ple-quant" --include='*.md' .`); propose doc edits to the owner,
do not push anything.

**Undo the cutover** (the old stack is intact; use it if the owner reports a problem later, such as garbage output,
a crash loop or an OOM):
```bash
systemctl stop vllm-flashnext-v031
systemctl disable vllm-flashnext-v031
systemctl enable vllm-flashnext
systemctl start vllm-flashnext
# poll /v1/models for up to ~6 minutes, then confirm the old pool and a working completion (T0):
docker logs vllm-flashnext 2>&1 | grep -E 'GPU KV cache size' | tail -1     # expect 337,244 tokens
```

**Out of scope for this plan:** post-cutover soak monitoring and any cleanup. Delete nothing from the old stack
(image, unit, checkpoint, sidecar, venv); the owner will decide that separately.

## 9. Contingencies

| Situation | Action |
|---|---|
| Checkpoint fails to load on v0.31.0 | Collect the traceback; try, **one at a time**: `--distributed-executor-backend mp`; `--quantization modelopt`; the other `--attention-config` syntax; `--no-enable-flashinfer-autotune` if the boot hangs at "Autotuning"; `--ulimit memlock=-1:-1` on `docker run` if pinned allocation fails. After 3 boots: roll back, report. |
| Drafter directory cannot be obtained | Option **B** (checkpoint's own BF16 MTP): expect only ~400–430k tokens (≈ 1.2–1.3×). Ask the owner whether that is still worth it. |
| Pool < 500k with the drafter | Compare `Model loading took` with ~76 GiB; check that `kv_cache_dtype=fp8` is active; check `max-num-seqs`; report numbers. Do not raise util past 0.95. |
| Decode speed −5% or worse (the FP8+MTP acceptance effect upstream warned about) | Try `num_speculative_tokens` 2 (one variable, one boot). If still red, give the owner both numbers (capacity gain vs speed cost); **the owner decides**. |
| Chat template / tool-call problems | Compare templates; try `--tool-call-parser qwen3_xml`; if the template rejects system messages or `reasoning_effort`, report (a fixed template file can be mounted, but only with the owner's OK). |
| Uncensored behaviour regressed (refusals the old model did not give) | Hard red: report, roll back. |
| Host memory pressure / OOM kill | Roll back at once; report pinned-RAM numbers from the logs. |
| Everything else fails | Roll back; the fallbacks (owner's call) are: backport PR #55557 as bind-mounted overlay files on the old image (details in the project memory note `alfyai-kv-cache-capacity-fp8-plan.md`), or the Pennyroyal SGLang v2.5.3 trial (its own docs list a 1-user-oriented runtime with no multi-user validation; ≈ 80 GiB host RAM in RAM-PLE mode), or wait for vLLM PR #56273 and PyPI. |

---

## Appendix A — current production unit (verbatim copy of `/etc/systemd/system/vllm-flashnext.service`, read 2026-10-02)

```ini
[Unit]
Description=vLLM Qwen3.8-Flash-Next Uncensored NVFP4 + NVFP4-PLE(quantized offload) + MTP on GPU0 RTX PRO 6000
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target
Conflicts=vllm-qwen27b-heretic.service

[Service]
Type=simple
# /home/alfyws/hf_models/flashnext/aday-uncensored-nvfp4-mtp and 131072 are filled in by deploy_flashnext.sh
ExecStartPre=-/usr/bin/docker rm -f vllm-flashnext
ExecStart=/usr/bin/docker run --rm --name vllm-flashnext \
  --gpus "device=0" --ipc=host -p 30000:8000 \
  -e VLLM_PLE_QUANT_DIR=/ples_nvfp4 \
  -e VLLM_PLE_CPU_OFFLOAD=1 \
  -e VLLM_PLE_OFFLOAD_READY_TIMEOUT=3600 \
  -e FLASHINFER_DISABLE_VERSION_CHECK=1 \
  -e VLLM_WORKER_MULTIPROC_METHOD=spawn \
  -e HF_HUB_OFFLINE=1 \
  -v /home/alfyws/hf_models/flashnext/ple-quant/worker_image_quant.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/ple_offload/worker.py:ro \
  -v /home/alfyws/hf_models/flashnext/ple-quant/ple_layer_quant.py:/usr/local/lib/python3.12/dist-packages/vllm/models/qwen3_8_flash_next/nvidia/ple_layer.py:ro \
  -v /home/alfyws/hf_models/flashnext/ple-quant/connector_mrv2.py:/usr/local/lib/python3.12/dist-packages/vllm/v1/ple_offload/connector.py:ro \
  -v /home/alfyws/hf_models/flashnext/ple-quant/ples_nvfp4:/ples_nvfp4:ro \
  -v /home/alfyws/hf_models/flashnext/aday-uncensored-nvfp4-mtp:/model:ro \
  vllm/vllm-openai:qwen38-flash-next \
  --model /model \
  --served-model-name qwen3-6-27b qwen3-8-flash-next flash-next \
  --trust-remote-code \
  --distributed-executor-backend mp \
  --gpu-memory-utilization 0.94 \
  --max-model-len 262144 \
  --max-num-seqs 16 \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}'
ExecStop=/usr/bin/docker rm -f vllm-flashnext
Restart=always
RestartSec=15
TimeoutStartSec=1800
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
```

## Appendix B — trial unit draft (`vllm-flashnext-v031.service`) — **correct it with the B3 findings before writing it**

Design: a **separate** unit and container name, disabled, `Restart=no` (no crash loops during the trial),
`Conflicts=` with the old units (systemd conflicts are symmetric), same port and served names so the app needs
nothing. Changes versus Appendix A: no PLE overlay mounts, no NVFP4 sidecar, new image alias, new checkpoint, drafter
mount, FP8 KV + FP8 indexer cache, `--mamba-cache-mode align`, recipe env vars. `--distributed-executor-backend mp`
and `FLASHINFER_DISABLE_VERSION_CHECK` are deliberately **omitted** (add them only if the boot needs them). No
`--language-model-only` (the app uses vision).

```ini
[Unit]
Description=vLLM v0.31.0 Qwen3.8-Flash-Next Uncensored (jpezzulli NVFP4, FP8 PLE) with FP8 KV on GPU0 - TRIAL
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target
Conflicts=vllm-flashnext.service vllm-qwen27b-heretic.service

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f vllm-flashnext-v031
ExecStart=/usr/bin/docker run --rm --name vllm-flashnext-v031 \
  --gpus "device=0" --ipc=host -p 30000:8000 \
  -e VLLM_PLE_CPU_OFFLOAD=1 \
  -e VLLM_PLE_OFFLOAD_READY_TIMEOUT=3600 \
  -e VLLM_SPARSE_INDEXER_MAX_LOGITS_MB=512 \
  -e VLLM_USE_V2_MODEL_RUNNER=1 \
  -e VLLM_WORKER_MULTIPROC_METHOD=spawn \
  -e HF_HUB_OFFLINE=1 \
  -v /home/alfyws/hf_models/flashnext/v031/jpezzulli-orcarouter-uncensored-nvfp4:/model:ro \
  -v /home/alfyws/hf_models/flashnext/v031/mtp-drafter-nvfp4:/drafter:ro \
  vllm/vllm-openai:v0.31.0-pinned \
  --model /model \
  --served-model-name qwen3-6-27b qwen3-8-flash-next flash-next \
  --trust-remote-code \
  --gpu-memory-utilization 0.94 \
  --max-model-len 262144 \
  --max-num-seqs 16 \
  --max-num-batched-tokens 8192 \
  --kv-cache-dtype fp8 \
  --attention-config.indexer_kv_dtype fp8 \
  --mamba-cache-mode align \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3,"model":"/drafter"}'
ExecStop=/usr/bin/docker rm -f vllm-flashnext-v031
Restart=no
RestartSec=15
TimeoutStartSec=1800
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
```

Notes: (a) unknown `VLLM_*` variables only produce a warning, but the *needed* PLE-offload setting must match what B3
found in `envs.py`; (b) if `--attention-config.indexer_kv_dtype fp8` is rejected use
`--attention-config '{"indexer_kv_dtype":"fp8"}'`; (c) the old unit used `qwen3_coder`; the recipe uses `qwen3_xml`.
Start with `qwen3_coder` for parity with what the app was tested against; (d) optional, only after the first good boot:
persist compile caches with `-v /home/alfyws/cache/vllm-v031:/root/.cache` (faster boots; keep it off for the first run);
(e) if `/model` contains a drafter-style MTP and you use Option B (no external drafter), delete the `/drafter` mount and the
`"model":"/drafter"` entry.

## Appendix C — reference commands from upstream (copy, then re-read the PR for updates)

Recipe tested on 1× RTX PRO 6000 (vllm-project/recipes PR #1055, image `vllm/vllm-openai:nightly-a9eafde59cbd55182dc2265cc398b7186f0a0eaa`, 2026-09-27):
```bash
VLLM_USE_V2_MODEL_RUNNER=1 \
VLLM_SPARSE_INDEXER_MAX_LOGITS_MB=512 \
vllm serve RadixArk/Qwen3.8-Flash-Next-NVFP4 \
--trust-remote-code \
--max-model-len 262144 \
--max-num-seqs 4 \
--max-num-batched-tokens 8192 \
--gpu-memory-utilization 0.93 \
--kv-cache-dtype fp8 \
--attention-config.indexer_kv_dtype fp8 \
--mamba-cache-mode align \
--enable-prefix-caching \
--speculative-config '{"method":"mtp","num_speculative_tokens":2,"model":"<drafter-dir>"}' \
--enable-auto-tool-choice \
--tool-call-parser qwen3_xml \
--reasoning-parser qwen3
```
Reported: pool 602,931 tokens, decode 128.6–149.0 tok/s single stream, prefill 15.6–17.0k tok/s, 0 errors / 0 preemptions
(prompts up to 248,784 tokens), `~51 GB` PLE table in pinned host RAM.

## Appendix D — test suite and acceptance table

All tests target `http://127.0.0.1:30000/v1`, model `qwen3-6-27b`, streaming where timing matters. Write them once,
store them in `/root/v031-migration/bench/`, run **identical** prompts (fixed corpus, fixed seeds, `temperature 0`
unless stated) against old and new servers. Save raw JSON and a summary per run.

| Test | What it does | Records |
|---|---|---|
| **T0** smoke | `/v1/models` lists the 3 served names; a "say OK" completion; one with a system message; one with `chat_template_kwargs {"enable_thinking": false}` | pass/fail, `finish_reason` |
| **T1** single-stream | prompts ≈ 1k, 8k, 32k tokens (unique per run, plus one repeat for the cached case), `max_tokens 512`, thinking off, 3 runs each | median decode tok/s (after first token), TTFT cold/cached, MTP acceptance delta |
| **T2** concurrency ladder | C ∈ {1, 4, 8, 16}; each request an unique 8k prompt + 256 output tokens | aggregate decode tok/s, per-stream median |
| **T3** burst (**window only**) | one shared ≈ 8k prefix + a unique ≈ 24k tail per request, C ∈ {8, 16, 24}, `max_tokens 256`; poll `/metrics` every second | TTFT p50/p95, completion time p50/p95, errors, aggregate tok/s, Δ`num_preemptions_total`, peak waiting-by-capacity, peak KV usage |
| **T4** mini-eval | 20 arithmetic word problems with known answers; 10 tool-call prompts with a fixed OpenAI-format `tools` list (valid `tool_calls`, right function and arguments); 5 Hungarian Q&A (language and coherence); 5 borderline-legal prompts (dark fiction, security education) to confirm the new model does not refuse where the old one did not | score per category; compare with the old server |
| **T5** long-context needle (**window only**) | one ≈ 200k-token prompt, needle at 50% depth, ask for it back | pass/fail, TTFT |
| **T6** vision | two generated PNGs with ≈ 10 labelled fields each; ask for a transcription; also a 1280×720 screenshot-style image | pass/fail, prompt tokens |
| **T7** app harness | on the box, against staging: `set -a; . /root/verify-harness.env; set +a; BASE=http://127.0.0.1:3002 node /root/verify-harness.mjs`, then `/root/verify-tools.mjs`, `/root/verify-tools-2.mjs`, `/root/verify-pdf.mjs`. **Do not print the env file.** | pass/fail per script; tool calls, streaming, thinking toggle, file production |

**Acceptance table** (B = old-server baseline measured the same day in C1/A5):

| Check | Green | Red |
|---|---|---|
| Boot pool | `GPU KV cache size` ≥ 600,000 tokens (stretch ≥ 675,000) | < 500,000 (500–600k: owner decides) |
| FP8 active | `kv_cache_dtype=fp8` in the init line; `Model loading took` ≈ 76 GiB | otherwise |
| Single-stream decode (T1, 8k and 32k) | median ≥ 0.95 × B | < 0.95 × B |
| Concurrency C=16 aggregate (T2) | ≥ 0.95 × B | < 0.95 × B |
| Burst C=24 (T3) | 0 errors, preemptions ≤ B's, p95 TTFT ≤ B's | any error, or worse than B |
| MTP acceptance | ≥ 55% (B ≈ 64%) | < 55% (try k=2 once) |
| Mini-eval (T4) | arithmetic ≥ B − 1 of 20; tool calls ≥ B (target 10/10); Hungarian coherent; no new refusals | any regression |
| Needle 200k (T5), vision (T6), app harness (T7) | all pass | any fail |
| Resources after the burst | GPU0 free ≥ 1,000 MiB; host `MemAvailable` ≥ 25 GiB; swap use not growing; no kernel OOM | otherwise |

## Appendix E — Track B: a venv on `/home` instead of Docker (only if the owner prefers it)

Prerequisite: PyPI must have `vllm==0.31.x` (as of 2026-10-04 it does **not**: 404, newest 0.30.0 which lacks FP8 QSA KV).
Re-check first (A3). If available: `uv venv /home/alfyws/venvs/vllm-0.31 --python 3.12`, then
`uv pip install --python /home/alfyws/venvs/vllm-0.31/bin/python vllm==0.31.0` choosing the CUDA 13.0 build (the
existing venv proves torch `+cu130` works with this driver), inspect the pinned torch/transformers versions it pulls,
and write a unit modelled on the old `vllm-qwen27b-heretic.service` (`User=alfyws`, `PATH` containing
`/home/alfyws/venvs/vllm-0.31/bin:/usr/local/cuda/bin`, `ExecStart=…/bin/vllm serve /home/alfyws/hf_models/flashnext/v031/<ckpt> …`
with the **same arguments and env vars as Appendix B**, minus `docker run`). FlashInfer JIT needs `nvcc`
(`/usr/local/cuda/bin/nvcc`, 13.4, present). Everything else (gates, tests, rollback) is identical. Building from the git tag with
precompiled kernels is possible but unverified; do not attempt it without the owner's OK.

## Appendix F — results template (copy into `docs/plans/vllm-0-31-fp8/results-<date>.md`)

| Metric | Old server (B) | New server | Verdict |
|---|---|---|---|
| Pool (tokens) / max concurrency | 337,244 / 1.29× | | |
| Model loading (GiB) / KV memory (GiB) | 76.06 / 9.77 | | |
| T1 decode tok/s, 8k / 32k | | | |
| T2 aggregate tok/s at C=1/4/8/16 | | | |
| MTP acceptance | ≈ 64% | | |
| T3 C=8/16/24: errors, preemptions, TTFT p95 | | | |
| T4 scores | | | |
| T5 / T6 / T7 | | | |
| GPU0 free MiB, host MemAvailable, swap after burst | | | |

## Appendix G — links

- vLLM tag v0.31.0: https://github.com/vllm-project/vllm/releases/tag/v0.31.0 · QSA source at the tag:
  https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/models/qwen4_exp/nvidia/qsa.py
- FP8 KV PR: https://github.com/vllm-project/vllm/pull/55557 · NVFP4 KV (open): https://github.com/vllm-project/vllm/pull/54846
- NVFP4 PLE (open): https://github.com/vllm-project/vllm/pull/56273 · pinned-PLE sizing (open): https://github.com/vllm-project/vllm/pull/59848
- Reference recipe PR: https://github.com/vllm-project/recipes/pull/1055
- Candidate checkpoint: https://huggingface.co/jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4
- Plan-B runtime (not part of this plan): https://github.com/jpezzulli/sglang-rtxpro6000 (latest v2.5.3, 2026-09-28)
- Project memory notes with the full investigation: `alfyai-kv-cache-capacity-fp8-plan.md`, `alfyroot-swap-full-diagnosis.md`,
  `alfyai-local-model-flashnext.md` (the memory directory of this project).
