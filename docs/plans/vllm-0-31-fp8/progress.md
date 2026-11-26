# Progress — vLLM v0.31.0 + FP8 KV migration

Keep this file current after **every** step (the owner has a weekly usage limit; another agent may have to resume
from here). Format: `YYYY-MM-DD HH:MM | step | result | evidence path or command output summary`.
Status values: `todo`, `doing`, `done`, `blocked`, `skipped (reason)`, `rolled back`.

Phase A executed 2026-10-04 (A1–A5 done; read-only + SAFE-WRITE only; no host state changed). Stopped at GATE G0.

## Gate log (owner approvals — quote the owner's message)

| Gate | Asked (date) | Answer (date, quote) |
|---|---|---|
| G0 track + hours | | |
| G1 swap reset | | |
| G2 prune + image pull | | |
| G3 downloads | | |
| G4 stage unit | | |
| G5 maintenance window | | |
| G6 cutover | | |

## Steps

| Step | Status | Notes / evidence |
|---|---|---|
| A1 verify host vs plan §2 | done | 2026-10-04: host matches §2 (unit active+enabled, container Up 6d, GPU0 95299/2043 MiB, RAM 126.8 GB avail, swap 32335/32767, /home 1.2 TB free, 0 running/waiting/estab). EXCEPTIONS: `/` = 40 GB free / 81% used (expected ~53; B2 gate needs >=45) and docker images 119.2 GB (was 105). Evidence: A1 output in chat |
| A2 snapshot + unit backup | done | 2026-10-04 16:01: created /root/v031-migration/{baseline,logs,results,corpus,bench}; old-unit.txt, old-image.txt (sha256:fc120ece… size 28.74 GB), old-boot-lines.txt (76.06 GiB, block 1600, KV 9.77 GiB, 337,244 tok, 1.29x), metrics-start.txt, old config/generation_config/chat_template/tokenizer_config. Unit backup /etc/systemd/system/vllm-flashnext.service.bak-pre-v031-20261004. Evidence: A2 output in chat |
| A3 research (drafter recipe, v0.31.0 notes, PyPI) | done | 2026-10-04: findings in `findings.md`. Drafter = provsalt @48d98195…, 8 files, 1,656,173,237 B, MTP sha256 0d44e6d7…; no v0.31.0 GitHub release (tag db9527a, digest verified); VLLM_PLE_CPU_OFFLOAD removed → `--engram-config`; PyPI 0.31.0 = 404 (venv track not viable) |
| A4 build test suite | done | 2026-10-04: authored T0–T6 + metrics + t7.sh + corpus builder + image gen; transferred to `/root/v031-migration/{bench,corpus}`; corpus 2,146,564 B (~537k est tokens), SHA256SUMS verify OK; dry-run OK on server venv python |
| A5 light baselines (idle prod) | done | 2026-10-04 14:08–14:11Z, box idle throughout; results in `/root/v031-migration/results/` (t0,t1,t2 C=1/4,t4,t6,all-baseline). t1 medians 167/169/143 tok/s (1k/8k/32k), MTP acc 61.7%; t2 agg 128 (C=1) / 192 (C=4); t4 18/20 arith, 10/10 tools, 0/5 refusals; t6 27/27 vision labels |
| **GATE G0 report** | doing | 2026-10-04: reported in chat; awaiting owner answers (Docker/venv, hours, test traffic, disk) |
| B1 swap reset | done | 2026-10-04 14:14Z: preconditions OK (MemAvail 123.9 GiB, si/so≈0, 0 running). swapoff/swapon /dev/dm-1 → swap used 0B, device active, MemAvailable 92.6 GiB, no OOM, T0 passes post-reset. Evidence: swap-reset.log, t0-old-postswap-*.json |
| B2 build-cache prune + disk gate | done | 2026-10-04: removed unreferenced ladaapp/lada:latest (13.7 GB, owner-approved); `/` = 52.36 GiB free (>=45 gate). builder prune=0B, image prune=419.5MB. old vLLM image + prod container intact |
| B3 image pull + offline inspection | done | 2026-10-04: pulled by digest (matches), tagged vllm/vllm-openai:v0.31.0-pinned, size 32.2GB, `vllm 0.31.0`. Inspected: qsa supported_kv_cache_dtypes=[auto,bfloat16,fp8,fp8_e4m3]; no VLLM_PLE/ENGRAM env in envs.py; EngramConfig.cpu_offload default True; --attention-config/-ac and --engram-config take JSON dicts; IndexerKVDType=[auto,bf16,fp8,mxfp4,nvfp4]; qwen4_exp_mtp MTP type; tool parsers qwen3_coder+qwen3_xml present; envs VLLM_SPARSE_INDEXER_MAX_LOGITS_MB/VLLM_USE_V2_MODEL_RUNNER/VLLM_WORKER_MULTIPROC_METHOD present. NOTE: `vllm serve --help` cannot run without GPU |
| B4 downloads + verification + hygiene | done | 2026-10-04 17:12: main checkpoint 220/220 files, **all sha256 verified, problems=0, param_bytes=135,253,671,102**; hygiene clean (no pickle/py); generation_config + chat_template byte-identical to old. Drafter 8 files, MTP sha256 0d44e6d7… matches, index trimmed (6173 entries). NOTE: hf CLI stalled at 4 MiB/s; switched remaining 19 files to parallel curl (188 MiB/s). Evidence: v031-verify journal |
| B5 stage trial unit | done | 2026-10-04: /etc/systemd/system/vllm-flashnext-v031.service staged (corrected: --engram-config '{"cpu_offload": true}', JSON attention-config, no VLLM_PLE_* envs); systemd-analyze verify OK; new unit disabled/inactive, old unit enabled/active |
| B6 pre-window checklist | done | 2026-10-04 17:13: MemAvailable 105.3 GiB (>=90); `/` 23 GB free (>=15); swap 13.5 GB used (cold, si/so=0); GPU0 95299 used (frees on stop); prod idle 0/0/0; old unit active+enabled, new unit inactive+disabled; image pinned; 206 shards + drafter present; unit staged; backups present; no OOM. ALL GREEN -> awaiting owner GO for maintenance window |
| **GATE G5 maintenance window** | approved | 2026-10-04: owner "You can go!" + pre-approved full cutover (G6) "if all seems fine". Window starting now |
| C0 pre-flight | done | 2026-10-04: idle 0/0/0 confirmed 3 min (15:33:59–15:36:49Z) |
| C1 in-window baseline on old server | done | 2026-10-04 15:37–15:40Z. T2 full ladder agg C=1/4/8/16 = 91/159/241/251 tok/s, 0 errors. T3 C=8/16/24: 0 errors, p95 TTFT 14.7/35.7/46.7 s, peak_wait_cap 6/14/22, peak_kv .789/.996/1.0, preemptions_delta 16. T5 needle pass, TTFT 15.0s. Evidence: results/t2-old-*T153743Z, t3-old-*T153945Z, t5-old-*T154014Z |
| C0 pre-flight | todo | |
| C1 in-window baseline on old server | todo | |
| C2 stop old server, GPU free | todo | |
| C3 start new server, boot watch | todo | |
| C4 boot facts (pool, loading GiB, fp8) | todo | |
| C2 stop old server, GPU free | done | 2026-10-04 15:41:00Z: `systemctl stop vllm-flashnext`; GPU0 fell to 2 MiB instantly; no container. old unit inactive (shows "failed" stop-path only) |
| C3 start new server, boot watch | done | 2026-10-04 15:41:09–15:44:09Z: UP after 180s, http=200, Application startup complete |
| C4 boot facts (pool, loading GiB, fp8) | done | 2026-10-04: kv_cache_dtype=fp8; **Model loading took 76.09 GiB**; **GPU KV cache size: 628,636 tokens, max concurrency 2.40x** (was 337,244/1.29x); attention block 3200; speculative mtp model=/drafter k=3; served names OK; GPU0 free 6338 MiB; MemAvailable 63.6 GiB; no OOM; si/so~0. ALL BOOT GATES GREEN |
| C5 smoke tests (T0, T4, T6, T7) | done | 2026-10-04: T0 pass; T4 first run 9/10 tool (flaky, #4), re-run **10/10**, arith 19/20, Hungarian 4/5, 0/5 refusals; T6 pass 27/27; T7 verify-harness + verify-pdf pass, verify-tools/-2 pass once DOC_PATH supplied (earlier fail = missing DOC_PATH, not serving) |
| C6 benchmarks (T1, T2, T3, T5) | done | 2026-10-04: T1 medians 173/169/187 tok/s (1k/8k/32k) vs B 167/169/143; MTP acc 63.4% (B 61.7%); T2 agg C=1/4/8/16 = 98/226/280/**311** vs B 91/159/241/251; T3 C=8/16/24 0 errors, p95 TTFT 12.4/24.6/39.5 vs B 14.7/35.7/46.7, preemptions_delta **1** vs 16, peak_kv .65/.98/.98; T5 pass TTFT 11.5s (B 15.0). GPU free 2312 MiB, MemAvail 63.3 GiB, no OOM |
| C7 soak >= 20 min | done | 2026-10-04: T3 x2 (preemptions 0/1, 0 errors) + 5 min idle; GPU free 2312 MiB stable; MemAvailable 63.3 GiB; no OOM; swap ~flat (90 MB churn) |
| C8 decision: keep or roll back | done | **ALL GREEN -> keep**. See `results-2026-10-04.md` |
| D cutover | done | 2026-10-04: Restart=always; daemon-reload; old unit disabled / new unit enabled+active; port 30000 serving 3 names; old unit file/image/ckpt/sidecar intact (rollback) |
| C6 benchmarks (T1, T2, T3, T5) | todo | |
| C7 soak ≥ 20 min | todo | |
| C8 decision: keep or roll back | todo | |
| D cutover | todo | |

2026-10-05 | venv port | done | vLLM 0.31.0 from PyPI in `/home/alfyws/venvs/vllm-0.31`, unit `vllm-flashnext.service`; Docker images and unit removed; see `venv-port-2026-10-05.md`
