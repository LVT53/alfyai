# Phase A findings — vLLM v0.31.0 + FP8 KV migration

Research for plan §2.6 (read the source, do not guess). Written 2026-10-04. Sources re-checked that day.
Status of each item: **verified** unless marked otherwise.

## 1. The NVFP4 MTP drafter recipe (§2.6-1) — verified

The drafter is produced exactly as documented in **vllm-project/recipes PR #1055** (OPEN, single commit
`604b883a`, 2026-10-01; the only changed file is `models/Qwen/Qwen3.8-Flash-Next.yaml`; no human comments, only
bots). The tested command has **not changed** since it was measured on the 2026-09-27 nightly.

**Source (pinned):** `provsalt/Qwen3.8-Flash-Next-NVFP4-PLE-NVFP4` at revision
`48d98195ac8da8ff10d9ee497b5d52e7817f058d`. The MTP weight file is byte-for-byte identical to the origin
`Inferact/Qwen3.8-Flash-Next-NVFP4` (HF LFS sha256 match, below).

**Exact recipe (copy verbatim):**

```bash
D=/home/alfyws/hf_models/flashnext/v031/mtp-drafter-nvfp4
hf download provsalt/Qwen3.8-Flash-Next-NVFP4-PLE-NVFP4 \
  --revision 48d98195ac8da8ff10d9ee497b5d52e7817f058d --local-dir "$D" \
  nvfp4_experts_mtp.safetensors model.safetensors.index.json config.json \
  generation_config.json tokenizer.json tokenizer_config.json vocab.json merges.txt
python3 - "$D" <<'PY'
import json, os, struct, sys
d, f = sys.argv[1], "nvfp4_experts_mtp.safetensors"
p = os.path.join(d, "model.safetensors.index.json")
idx = json.load(open(p))
idx["weight_map"] = {k: v for k, v in idx["weight_map"].items() if v == f}
with open(os.path.join(d, f), "rb") as fh:
    header_len = struct.unpack("<Q", fh.read(8))[0]
idx["metadata"]["total_size"] = os.path.getsize(os.path.join(d, f)) - 8 - header_len
json.dump(idx, open(p, "w"))
PY
sha256sum "$D/nvfp4_experts_mtp.safetensors"
# expect 0d44e6d705d2313c713e60114e56874adf358ed5f646dc8704bb5be15f5ddbf7
```

**Files and sizes (exact bytes):**

| File | Bytes |
|---|---|
| `nvfp4_experts_mtp.safetensors` | 1,597,441,088 |
| `model.safetensors.index.json` (before trim) | 35,742,446 |
| `tokenizer.json` | 12,809,320 |
| `vocab.json` | 6,722,759 |
| `merges.txt` | 3,353,259 |
| `config.json` | 86,235 |
| `tokenizer_config.json` | 17,928 |
| `generation_config.json` | 202 |
| **download total** | **1,656,173,237 B ≈ 1.542 GiB** |

Final directory after the index trim ≈ 1.62 GB. MTP file sha256 = `0d44e6d705d2313c713e60114e56874adf358ed5f646dc8704bb5be15f5ddbf7`.

**What `--speculative-config {"method":"mtp","model":"<dir>"}` actually requires from that directory** (vLLM
source at a current SHA `f98d1fc4`):
- **Required:** `config.json` (the draft `ModelConfig` loads it; `model_type: qwen4_exp` is what triggers the
  `qwen4_exp → qwen4_exp_mtp` / `Qwen4ExpMTP` architecture swap) and a `model.safetensors.index.json` whose
  `weight_map` references only files that exist (otherwise `filter_duplicate_safetensors_files` raises
  `FileNotFoundError: Weight files referenced in index but missing`). The weights file itself.
- **Not required by vLLM:** the tokenizer files — the draft tokenizer resolves to the **target model's** tokenizer
  (`use_heterogeneous_vocab` defaults False and is rejected for method != `draft_model`). The recipe still ships
  them; keep the tested 8-file set for reproducibility.
- `metadata.total_size` has no reader in current vLLM main; the rewrite is harmless/for consistency.

**Risk:** PR #1055 is unmerged; `provsalt` main may drift → always use the pinned revision + sha256 check above.

## 2. vLLM v0.31.0 release notes / known issues (§2.6-2) — verified (no official release notes exist)

- **There is no GitHub Release object for `v0.31.0`** (only the bare git tag, at commit
  `db9527a46873454610df6dbedf79a36d6bf1a7f6`, 2026-10-02; latest published release is still v0.30.0). RC timeline
  confirmed: rc1 2026-09-29 → rc5 2026-10-02 (= final tag). So "release notes" must be reconstructed.
- **Docker image digest verified** against §2.4: `vllm/vllm-openai:v0.31.0` →
  `sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3` (multi-arch manifest; pushed 2026-10-04).
- `#55557` (FP8-e4m3 main KV on the QSA path) is **merged and included** in v0.31.0.
- `#56273` (NVFP4 PLE), `#59848` (exact-size pinned PLE) and `#54846` (NVFP4 KV on QSA) are still **open**; the
  NVFP4-on-QSA KV is **not** in v0.31.0.
- **Removed flag:** `--enable-mamba-fine-grained-prefix-cache` → replaced by `--enable-mamba-shared-prefix-checkpoint`.
- **Removed env var (breaking):** `VLLM_PLE_CPU_OFFLOAD` was **removed** by PR #57937 (commit `54020c3c3`),
  included in v0.31.0. It is now **silently ignored**. The replacement is the `--engram-config` JSON flag;
  `EngramConfig.cpu_offload` defaults to **True**. To turn offload off you must now pass
  `--engram-config '{"cpu_offload": false}'`. EngramConfig fields: `cpu_offload: bool = True`,
  `embedding_across_dp: bool = False`, `dp_shared_memory: bool | None = None`, `use_thp: bool = False`
  (`use_thp` requires `cpu_offload=True` and `dp_shared_memory=False`).
- `VLLM_SPARSE_INDEXER_MAX_LOGITS_MB` (default 512) and `VLLM_USE_V2_MODEL_RUNNER` (default None/auto) **exist in
  both v0.30 and v0.31** (not new).
- `indexer_kv_dtype` is a field of `AttentionConfig` (default `"auto"`, accepts `fp8`/`mxfp4`/`nvfp4`); syntax
  `--attention-config '{"indexer_kv_dtype":"fp8"}'` or `-ac`. The dot-form `--attention-config.indexer_kv_dtype fp8`
  used in the recipe/plan still needs B3 confirmation against the shipped image.
- `--kv-cache-dtype` accepts `fp8`, `fp8_e4m3`, …; `--mamba-cache-mode` ∈ {`all`,`align`,`none`}.
- `--enable-flashinfer-autotune` is `bool|None` (default auto) and exposes `--no-enable-flashinfer-autotune`
  (BooleanOptionalAction).
- No official "known issues" list; carried risks are the open PRs above plus the MTP issue below.

**Consequence for the plan's Appendix B unit:** the env vars `VLLM_PLE_CPU_OFFLOAD` and
`VLLM_PLE_OFFLOAD_READY_TIMEOUT` must **not** be relied on in v0.31.0. Replace with `--engram-config`
(offload defaults on) and confirm the exact accepted JSON in step B3.

## 3. Candidate checkpoint on vLLM v0.31.0 (§2.6-3) — verified format; loading not yet boot-tested

Checkpoint `jpezzulli/OrcaRouter-Qwen3.8-Flash-Next-Uncensored-ModelOpt-NVFP4`: **125.96 GiB, 220 files**
(206 `*.safetensors` + 14 support), matching the plan's ~126 GiB. **No pickle/`.py` files** (rule 10 hygiene OK).

- `config.json`: `architectures: ["Qwen4ExpForConditionalGeneration"]`, `model_type: qwen4_exp`,
  `quant_method: modelopt`, `quant_algo: NVFP4` (group 16, producer modelopt 0.46.0), no `auto_map`;
  `text_config.ple_embedding_dtype: float8_e4m3fn`, `max_position_embeddings: 262144`, 48 layers, 512 experts /
  top-10, `mtp_num_hidden_layers: 1`.
- **Quant split (verified from safetensors headers):** routed experts NVFP4 (U8 packed + F8_E4M3 block scale +
  F32 global scale); the 51B PLE table FP8 E4M3 (128 × `shard_N.weight` `F8_E4M3 [2500012,160]` + one BF16
  `ngram_embedding.weight_scale`); attention/GDN/routers/shared experts/hyper-connections/PLE-conv/vision/
  embeddings/lm_head **and MTP are BF16**.
- **v0.31.0 stock support (verified in-tag):** `Qwen4ExpForConditionalGeneration` and `Qwen4ExpMTP` are registered;
  ModelOpt NVFP4 is supported; the FP8 PLE layout is exactly what `Qwen4ExpPLEFp8EmbeddingMethod` loads (same
  layout that stock v0.30.0 accepted in issue #59868); `--kv-cache-dtype fp8` IS supported by the QSA backend
  (`supported_kv_cache_dtypes = ["auto","bfloat16","fp8","fp8_e4m3"]`, dequant inside the QSA kernel — note the
  earlier "#55357 QSA is bf16-only" comment was from a September nightly, before #55557 landed).
- **Chat template and `generation_config.json` are byte-identical to the current production checkpoint**
  (template sha256 `c3cf9e34…`, both 169 lines; gen config temp 1.0 / top_k 20 / top_p 0.95). No app-facing
  template/parser change expected.
- **No one has published running this exact repo on vLLM** (0 HF discussions; card targets Pennyroyal/SGLang only).
  The closest analogue (RadixArk, same NVFP4-experts + FP8-PLE layout) booted on the day-0 image after a 3-line
  patch that is now the in-tree FP8-PLE path.
- **Open risks to carry into the maintenance window:**
  - **#55357** — `qwen4_exp` + MTP spec decode shows episodic **0% draft acceptance + repetition collapse** on
    SM120 (engine-level, open). This threatens both the external NVFP4 drafter (Option A) and the in-checkpoint
    BF16 MTP (Option B). Watch the C4/C6 acceptance number; roll back if it collapses.
  - **#59868** — FP8 PLE pinned-host lookup kernel fails to compile on **sm_86 (Ampere)**; fine on SM120/SM121.
    Our GPU is SM120-class, so this should not bite (B3/C3 confirm).
  - **#55515** — PLE requires `PP=1`; **#56088** — DeepSpec DFlash/DSpark drafters blocked (not our family).
  - PLE offload is effectively mandatory: 52 GB FP8 table + ~78 GB backbone > 96 GB, so `--engram-config`
    `cpu_offload` must be on.
- **Note on the two "drafter" repos in §2.5:** `Inferact/Qwen3.8-Flash-Next-NVFP4` is a full model with a **BF16**
  PLE (not a drafter, not FP8); `provsalt/…-PLE-NVFP4` is a full checkpoint whose **packed NVFP4 PLE** needs an
  external plugin (stock vLLM cannot load it). Neither is a standalone drafter; the actual drafter is only the
  8-file subdirectory downloaded in §1 above.

## 4. PyPI status (Appendix E gate) — verified

`https://pypi.org/pypi/vllm/0.31.0/json` → **404**; latest on PyPI is **0.30.0**. So the **venv-on-/home track
(Appendix E) is not currently viable**; Docker is the only path for v0.31.0 today.

## 5. Direct consequence / plan corrections to carry into Phase B

1. **Drafter (G3):** source `provsalt/Qwen3.8-Flash-Next-NVFP4-PLE-NVFP4` @
   `48d98195ac8da8ff10d9ee497b5d52e7817f058d`; 8 files; **1,656,173,237 B ≈ 1.54 GiB** (final dir ~1.62 GB); MTP
   sha256 `0d44e6d7…`.
2. **Appendix B unit:** remove `VLLM_PLE_CPU_OFFLOAD` and `VLLM_PLE_OFFLOAD_READY_TIMEOUT` (dead in v0.31.0);
   use `--engram-config` (cpu_offload on by default). Confirm exact JSON + env-var set in **B3** before writing the
   unit.
3. Option A (external NVFP4 drafter) vs Option B (in-checkpoint BF16 MTP): both are code-supported in v0.31.0;
   the drafter is the higher-risk element only because of the still-open MTP issue #55357, which also affects B.
   The owner may choose; the plan's default remains Option A.

## 6. Corrected trial unit draft (PROVISIONAL — finalise after B3 image inspection, before G4)

Corrections vs plan **Appendix B**, driven by §2 and §5 above:

- Image: `vllm/vllm-openai:v0.31.0-pinned` (digest-pinned, verified).
- Mounts: checkpoint `…/v031/jpezzulli-orcarouter-uncensored-nvfp4:/model:ro` and
  `…/v031/mtp-drafter-nvfp4:/drafter:ro`; **no** PLE overlay `.py` files, no `ple-quant` sidecar.
- **Remove** `-e VLLM_PLE_CPU_OFFLOAD=…` and `-e VLLM_PLE_OFFLOAD_READY_TIMEOUT=…` (dead/ignored in v0.31.0).
  Replace PLE offload with the `--engram-config` flag (EngramConfig `cpu_offload` defaults **true**; pass it
  explicitly for clarity). **Exact JSON syntax must be confirmed in B3** (candidates:
  `--engram-config '{"cpu_offload": true}'`).
- Keep `-e VLLM_SPARSE_INDEXER_MAX_LOGITS_MB=512`, `-e VLLM_USE_V2_MODEL_RUNNER=1`,
  `-e VLLM_WORKER_MULTIPROC_METHOD=spawn`, `-e HF_HUB_OFFLINE=1` (all valid in v0.31.0 except the last two which
  are environment-agnostic; confirm `VLLM_WORKER_MULTIPROC_METHOD` name in B3).
- Flags: same as Appendix B — `--kv-cache-dtype fp8`, `--attention-config.indexer_kv_dtype fp8` (or JSON form),
  `--mamba-cache-mode align`, `--max-num-batched-tokens 8192`, `--served-model-name qwen3-6-27b qwen3-8-flash-next
  flash-next`, `--max-model-len 262144`, `--max-num-seqs 16`, `--enable-chunked-prefill`, `--enable-prefix-caching`,
  `--enable-auto-tool-choice`, `--tool-call-parser qwen3_coder`, `--reasoning-parser qwen3`,
  `--speculative-config '{"method":"mtp","num_speculative_tokens":3,"model":"/drafter"}'`.
- Keep `Restart=no`, `Conflicts=vllm-flashnext.service vllm-qwen27b-heretic.service`, separate container name
  `vllm-flashnext-v031`, port `30000:8000`. Add `--distributed-executor-backend mp` / `-e
  FLASHINFER_DISABLE_VERSION_CHECK=1` / `--no-enable-flashinfer-autotune` only if B3/C3 shows they are needed.
- `metadata.total_size` / `VLLM_PLE_OFFLOAD_READY_TIMEOUT` have no reader in v0.31.0 → omit.
