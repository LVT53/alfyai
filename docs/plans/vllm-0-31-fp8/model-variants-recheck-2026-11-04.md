# Re-check after vLLM 0.33.0: is it time to switch? (2026-11-04)

Method: primary sources only. PyPI JSON, the GitHub API (releases, tags, compare, PRs, PR comments and reviews, files read at tag `v0.33.0` and at `main`), the public Hugging Face API and raw cards, and the plugin repo. Nothing was booted, no weights were downloaded, the box was not touched. Read in full: the test comment on #64739, the lesj0610 plugin's README and `pyproject.toml`, and two cards (PseudoBrain NVFP4, lflare NVFP4-Abliterated). The other new repos were scanned by `config.json` and card header only. "Inferred" marks anything I did not read directly. All dates UTC. This extends [model-variants-check-2026-10-28.md](model-variants-check-2026-10-28.md) and follows its re-check triggers.

**Summary.** Not yet. vLLM 0.33.0 reached PyPI on 2026-11-02, but the piece the 10-28 note was waiting for is not in it. The CSF scale decoder that NVIDIA's FP4-Local needs (watch item #60646) was closed unmerged on 2026-10-30 as "superseded by #64312", and #64312 merged to main on 2026-11-03, after the 0.33.0 branch: `nvfp4_utils.py` and `modelopt.py` have 0 `csf` lines at `v0.33.0` and 36 and 9 on `main`. The second piece, #64739 (shards kept under `tensors/`), is still open. So stock 0.33.0 cannot load FP4-Local; the lesj0610 plugin v0.2.1 bridges both gaps on 0.33.0 (it declares `vllm>=0.32.1rc0` and says it follows #64312 and #64739). The first single-RTX-PRO-6000 (sm_120) evidence for the layout now exists: a commenter on #64739 ran NVIDIA's FP4-Local on v0.33.0 plus the open and post-release PRs and reports a clean load and a 6-hour, 15,164-request soak with 0 errors and 0 preemptions. It is one self-report, measured against RadixArk's NVFP4 build rather than our checkpoint, and it is the base model with no uncensoring. Upgrading vLLM alone gains nothing for our FP8-PLE checkpoint. Recommendation: stay today, do the no-downtime preparation, and trial after 0.34.0 (about 2026-11-15 to 11-17 by cadence, inferred), or earlier by choice with the plugin.

## 1. Verdict table

| # | Item | State on 2026-11-04 | Evidence | What it means for us |
|---|---|---|---|---|
| 1 | vLLM 0.33.0 stable | on PyPI 2026-11-02T10:12:56Z | [PyPI JSON](https://pypi.org/pypi/vllm/json); pins at the tag: torch 2.14.0, torchvision 0.29.0, flashinfer-python 0.7.2.post1, transformers `>=5.16.1,<5.21.0` (`requirements/cuda.txt`, `common.txt`) | New venv needed (ours: torch 2.13.0, flashinfer 0.7.0.post1). Upgrading alone: no gain, see row 2 |
| 2 | Packed NVFP4 PLE ([#56273](https://github.com/vllm-project/vllm/pull/56273)) | in 0.33.0 | merged 2026-10-14; compare = `ahead`; 23 `nvfp4` lines in `qwen4_exp/common/ngram_embedding.py` at the tag | Helps only a checkpoint whose PLE is stored NVFP4; ours is FP8 |
| 3 | CSF scale decode | NOT in 0.33.0 | [#60646](https://github.com/vllm-project/vllm/pull/60646) closed 2026-10-30, comment "Superseded by #64312"; [#63908](https://github.com/vllm-project/vllm/pull/63908) closed 2026-10-31 unmerged; [#64312](https://github.com/vllm-project/vllm/pull/64312) merged 2026-11-03T06:51:52Z (compare = `diverged`; `csf` lines: tag 0, main 36 and 9) | Lands in the next stable |
| 4 | Shards listed under `tensors/` | open | [#64739](https://github.com/vllm-project/vllm/pull/64739), created 2026-10-30, updated 2026-11-04, one bot review, no human review | FP4-Local needs it (or the plugin, or a flattened symlink directory, inferred) |
| 5 | Weights-mapper change the tester also needed | merged, not in 0.33.0 | [#64869](https://github.com/vllm-project/vllm/pull/64869) merged 2026-10-31T09:20Z, compare = `diverged` | In the next stable |
| 6 | Items from the 10-19 and 10-28 notes | mostly unchanged | merged 2026-10-27 but NOT in 0.33.0 (compare = `diverged`): [#60490](https://github.com/vllm-project/vllm/pull/60490) QSA indexer workspace in memory profiling, [#62318](https://github.com/vllm-project/vllm/pull/62318), [#60234](https://github.com/vllm-project/vllm/pull/60234). Still open: [#59848](https://github.com/vllm-project/vllm/pull/59848) and [#60909](https://github.com/vllm-project/vllm/pull/60909) pinning, [#62409](https://github.com/vllm-project/vllm/pull/62409) and issue [#62383](https://github.com/vllm-project/vllm/issues/62383) (262k prefill crash with MTP), [#58863](https://github.com/vllm-project/vllm/pull/58863) and [#59366](https://github.com/vllm-project/vllm/pull/59366) (MTP), [#54846](https://github.com/vllm-project/vllm/pull/54846) and [#64199](https://github.com/vllm-project/vllm/pull/64199) (NVFP4 KV), [#55357](https://github.com/vllm-project/vllm/issues/55357) | Nothing in 0.33.0 helps the current setup |
| 7 | lesj0610 plugin | v0.2.1 (2026-10-31) | [repo](https://github.com/lesj0610/fp4local-abliterated): tags v0.1.0, v0.2.0, v0.2.1; `vllm>=0.32.1rc0`; README: wraps loader functions "and follow vLLM pull requests #64312 (decoding) and #64739 (shards)", decoding switches itself off once vLLM has its own; "Tested with" row still `0.32.1rc1.dev467 (nightly), sm_80, tensor parallel, MTP on`; 0 stars, 0 open issues | Same trial as before with more upstream credibility (the author wrote #64312); SM120, thinking-on and Hungarian still unmeasured |
| 8 | Candidates since 2026-10-28 | nothing better evidenced | no new Qwen LLM ([Qwen org by createdAt](https://huggingface.co/api/models?author=Qwen&sort=createdAt&direction=-1&limit=6): newest are Qwen-Image-2.1 variants and Qwen3.8-Flash-Next); deployed repo last commit 2026-09-17; `nvidia/...-FP4-Local` last modified 2026-10-15; lesj0610 repo, three commits, last 2026-10-25; lflare repos last 2026-10-26 | Section 4 |

## 2. Release facts

- PyPI uploads of the `x.y.0` releases: 0.28.0 2026-08-26, 0.29.0 09-09 (+13 days), 0.30.0 09-22 (+12), 0.31.0 10-05 (+13), 0.32.0 10-18 (+13), 0.33.0 11-02 (+15). The next stable is therefore about 2026-11-15 to 11-17 (inferred; not announced).
- There is no GitHub Release object for `v0.33.0` at check time: the release list shows `v0.33.0rc3` (published 2026-11-02T10:10:05Z), then `v0.32.0`. The 0.33.0 release notes were not read.
- Nine commits separate `v0.33.0rc1` from `v0.33.0` (compare `ahead 9`): Humming kernels (#64257, its revert, #64802), MTP drafts in the Transformers backend (#61270), HiSparse async KV (#63827), MRV2 pipeline-parallel spec-decode (#64458), ROCm AITER (#64567) and CI pins. None touches Qwen4Exp, PLE or QSA.

## 3. The third-party SM120 report (read in full)

[Comment on #64739](https://github.com/vllm-project/vllm/pull/64739), user `chuang44-tiff`, 2026-11-04T14:27Z. Setup as written: 1x RTX PRO 6000 Blackwell Workstation (sm_120, TP1), `nvidia/Qwen3.8-Flash-Next-FP4-Local` @b9ce18a, vLLM v0.33.0 + #64739 (763c900) + #64312 (at e9b2312, before its merge) + the `utils.py` change from #64869. Reported against the RadixArk NVFP4 checkpoint, same flags, MTP K=2 on both (RadixArk with its NVFP4 sidecar, FP4-Local with its own head):

- Load: 73,728 CSF scale tensors decoded, MXFP8 layers on FlashInferCutlass/Marlin, NVFP4 PLE pinned on CPU, weight loading 76-84 s.
- Quality (prefix caching off): greedy exact-answer 30/30 vs 30/30; perplexity 1.533 vs 1.530; per-token prompt log-probs on prose, code, a long document, rare names, German, Chinese and Spanish within 0.006 nats/token.
- KV pool 901k vs 708k tokens (+27%); single-stream decode 164 vs 141 tok/s; 6 streams of ~22k tokens 541 vs 491 tok/s; MTP acceptance ~55% on both; prefill 17.3k vs 15.4k tok/s on a 199k prompt (+8-13% from 4k to 246k).
- Peak system RAM 47 vs 74 GiB (PLE 26.8 GiB NVFP4 vs 47.7 GiB FP8 on disk).
- 6-hour mixed-load soak (prefix caching, tool calls, MTP on): 15,164 requests including 220 prompts of ~202k tokens, 0 errors, 0 preemptions. The author says they moved their daily server to this checkpoint.

Read with care: one account, self-reported, and the baseline is RadixArk NVFP4, not our Orca-based FP8-PLE checkpoint with an external drafter (our measured figures: 169-187 tok/s single-stream at k=3, 631,181-token pool). It is the base model, so it says nothing about uncensoring, thinking-on refusals or Hungarian. It used the PRs, not the plugin.

## 4. Candidates since 2026-10-28

- 105 repos created since 2026-10-28 match the Flash-Next searches; 67 are safetensors-style after dropping GGUF, MLX, EXL3 and AWQ-style names. Almost all are single-uploader with under a few thousand downloads.
- [defnoteatin/PseudoBrain-Qwen3.8-Flash-Next-NVFP4](https://huggingface.co/defnoteatin/PseudoBrain-Qwen3.8-Flash-Next-NVFP4) (2026-10-30, 99.1 GiB, 844 downloads) lists the Huihui abliterated QAD build among its bases but is not the same model: it converts the 12 full-attention layers to 16K sliding-window plus a custom "Quest" memory, needs the author's `pb27_vllm` plugin, and its own evidence is MMLU n=300 85.0% and a 59-task agent run 26 vs 28 for stock (DGX Spark numbers). Skip.
- [lflare/Qwen3.8-Flash-Next-NVFP4-Abliterated](https://huggingface.co/lflare/Qwen3.8-Flash-Next-NVFP4-Abliterated): unchanged since 2026-10-26; thinking-on refusal tables still read "not run". It uses the non-CSF layout, so #56273 in 0.33.0 should be enough for the PLE; nobody has reported a stock boot (inferred).
- No other new repo in the scan is an uncensored NVFP4-PLE build on the standard architecture with evidence beyond its own card (configs and card headers only; two cards read in full).

## 5. What I would do

1. Now, no downtime: the Step 0 baseline probes of the CURRENT model from section 8 of the 10-28 note (refusals with thinking on and off, Hungarian, one long tool task, thinking length). Optionally download the 95.2 GiB checkpoint and build the 0.33 venv.
2. Trial after vLLM 0.34.0 if #64739 (or an equivalent) has merged: then FP4-Local loads on stock, and the only open question is how to deliver the uncensoring (runtime plugin vs a weight-edited FP4-Local build).
3. Earlier, by choice: 0.33.0 stable + plugin v0.2.1 in a 60-90 minute window (rollback is starting the current unit, about 4 minutes).
4. Do not upgrade vLLM on its own.

## 6. Could not verify

1. Whether #64739 merges before the 0.34.0 branch cut.
2. That the plugin itself runs on SM120: its README test row says sm_80, and the SM120 report used the PRs.
3. Thinking-on refusal behaviour, Hungarian quality and agent behaviour for any FP4-Local-based uncensored build.
4. The numbers in section 3 beyond the comment: single report, different baseline, not reproduced.
5. Whether a flattened symlink directory (shards in the root, index rewritten) loads FP4-Local on a main nightly without the plugin (inferred only).
6. The 0.33.0 release notes (no GitHub Release object yet).
7. Most of the 67 new repos (config and card header only).

## 7. Follow-up, same day: could we switch our PLE to NVFP4 and then upgrade vLLM?

The owner's idea. Short answer: yes in principle, and it is the smallest change that keeps the Orca uncensoring and cuts the pinned PLE RAM. It is not a drop-in, and it is a RAM project, not a quality upgrade. Nothing below was run on the box except read-only listings.

**Evidence (read or run 2026-11-04).**
- Selection: at `v0.33.0`, `Qwen4ExpPLEEmbeddingMethod.from_quant_config` returns the NVFP4 method whenever `text_config.ple_embedding_dtype == "nvfp4"` (`vllm/models/qwen4_exp/common/ngram_embedding.py` L186-187). Our live `config.json` says `float8_e4m3fn`.
- Layout the loader accepts (`vllm/models/qwen4_exp/nvidia/ngram_embedding.py` L427-497): per ngram shard `shard_<i>.weight` (U8, [2,500,012, 80]) and `shard_<i>.weight_scale` (E4M3, [2,500,012, 10]), plus ONE layer-level `ngram_embedding.weight_scale_2` (F32). `shard_parameters = ("weight", "weight_scale")`, so any other suffix falls to the regular-weights path. [LIL's checkpoint](https://huggingface.co/local-inference-lab/Qwen3.8-Flash-Next-NVFP4), which [#56273](https://github.com/vllm-project/vllm/pull/56273) was built against, has exactly 128 + 128 + 1 such tensors (26.82 GiB, in `model-00026` to `model-00041-of-00041`) and a single `weight_scale_2` of 3.324236e-05.
- Decode convention (kernel at L546-556): the low nibble is the even element, one E4M3 scale per 16 values, times the global scale.
- [provsalt's `ple-nvfp4-*` shards](https://huggingface.co/provsalt/Qwen3.8-Flash-Next-NVFP4-PLE-NVFP4) (128 files, 26.82 GiB, the repo our MTP drafter came from) use our tensor names but carry a `weight_scale_2` per shard: 128 values from 1.708e-05 to 3.324e-05 (max/min 1.95, 61 distinct values, 1% exact powers of two). By the loader code above they do not load as published (not run); folding the scales into the E4M3 block scales would re-round them (lossy). Their card says stock vLLM cannot load them (written for the 2026-08 plugin).
- Numeric check: three windows of 2,000 rows of provsalt's shard 0 against our live FP8 table (one BF16 scalar scale, 1.9932e-4), decoded low-nibble-first: cosine mean 0.9951 (min 0.9925), relative RMS error mean 9.9% (max 12.7%); high-nibble-first gives cosine about 0. So the content matches, and 4-bit costs about 10% per row against the FP8 table.
- provsalt's own teacher-forced study (32 calibration + 8 held-out prompts, the author's run), NVFP4 PLE only against an FP8-PLE reference: top-1 agreement 91.525%, reference top-1 inside the candidate's top-5 100%, KL 0.015591 nats, NLL +0.019442 nats. LIL and NVIDIA train the PLE tables during QAD ("N-gram embedding tables (PLE) | NVFP4 | Trained"; "joint-refinement updates, which also train the n-gram embedding tables") to absorb the 4-bit error.
- Our table: 128 shards in 10 `model-plefp8-*` files (47.68 GiB), one BF16 scalar `...ngram_embedding.weight_scale` in `model-plefp8-00009`, nine BF16 `.ple.` projection tensors elsewhere, quantisation `ignore` has `*.ple.*`. Its LFS oids differ from RadixArk's `model-plefp8-*` (0 of 10; the sharding may differ), so "same table as Qwen's" still rests on the third-party diff in section 3 of the 10-28 note.

**What it buys.** Pinned PLE RAM from about 65.7 GiB (`shared` 65 GiB on 2026-11-04) to about 36 GiB (26.82 GiB table: 32 GiB weights plus 4 GiB scales after power-of-two rounding; the plugin README says "about 36 GiB"; the #64739 tester measured peak system RAM 74 to 47 GiB). No GPU or KV change (the table is host-side). Box now: swap 25 of 31 GiB used (19 on 10-28), MemAvailable 67 GiB, `/home` 1,017 GiB free.

**What it needs.** vLLM >= 0.33.0 (native NVFP4 PLE; torch 2.14.0, flashinfer-python 0.7.2.post1), so the engine move comes with it. 0.33.0 lacks #60490 (profiler workspace) and #62409 (262k MTP crash), which land with 0.34.

**Two loader-native sources.** (A) extract LIL's 257 PLE tensors by range read (QAD-trained; no conversion code; how that table behaves on Orca's trunk is unmeasured; extract the tensors rather than listing whole files in the index, because vLLM loads every tensor in a listed file). (B) requantise our own FP8 table on the box with one global scale (plain rounding, about provsalt's drift; needs a small quantiser checked with the decode test above, GPU1 has about 33 GiB free). Pick by teacher-forced KL against the live FP8 baseline, A first because it needs no code.

**Plan (nothing run).** Offline, no downtime: build a new checkpoint directory by symlinking the live one except the 10 `model-plefp8-*` files, with the new PLE shards, a rewritten index (drop the 128 FP8 `shard_N.weight` entries and the single `weight_scale`; add the 128 + 128 + 1 NVFP4 entries) and `ple_embedding_dtype: "nvfp4"`; build `/home/alfyws/venvs/vllm-0.33`; capture baseline prompt-logprobs, refusal probes and a tool mini-eval on the live model. Then one 60-90 minute window with a separate trial unit (same flags, `Conflicts=` the live unit, `Restart=no`): boot facts (pinned size, KV pool, swap), KL and top-1 agreement against the baseline on English and Hungarian prompts, a ~260k-token prompt (#62383, #60490), MTP acceptance, throughput. Keep the table with the smaller drift, or roll back (stop the trial unit, start the live one, about 4 minutes).

**Could not verify.** That provsalt's shards fail to load (code reading only); how LIL's table behaves on Orca's trunk; NVFP4 PLE lookup speed on our box; the real pinned size; whether LIL's PLE files hold only PLE tensors.
