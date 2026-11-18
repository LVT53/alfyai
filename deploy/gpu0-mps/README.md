# GPU0 under NVIDIA MPS

GPU0 on the box (RTX PRO 6000) runs two tenants, the chat model (`vllm-flashnext.service`) and the read-aloud voice (`zonos3.service`). Since 2026-11-18 both run as clients of NVIDIA's Multi-Process Service (MPS), at the owner's decision.

**Why.** Without MPS the card took turns between the two programs. When the chat model was busy (long agent runs, Atlas), its turns ran back to back, and the voice's many small steps waited in line. A reading then stalled at almost every sentence. Under MPS both programs' work runs on the card at the same time.

**Measured** with `bench.py` (kept in the orchestrator's scratchpad, made-up text). Under load means two agent-like request streams to the chat model, each with a new 6,000-token prompt.

| | Before MPS | After MPS |
|---|---|---|
| Voice, chat model idle | 7.07× playback | 6.86× playback |
| Voice, chat model under load | **1.23× playback**; first sentence 4.29 s, slowest 5.0 s | **5.22× playback**; first sentence 0.91 s, slowest 1.22 s |
| Chat model, one 600-token reply | 135.4 tok/s | 137.8 tok/s |
| Chat model while the voice talks (400 tokens) | −10.5% (2026-11-16, see the speech service README) | 124.5 tok/s against 126.9 alone (within noise) |
| Chat model's KV cache | 511,562 tokens, 1.95× at 262,144 | 511,562 tokens, 1.95× at 262,144 |

The chat model's own process shows about 6 GB less in `nvidia-smi` under MPS (88,938 MiB against 95,070). That is only how the card attributes memory: the model load (76.09 GiB) and the KV cache are identical.

## Files

| File | Installed as |
|---|---|
| `nvidia-mps-gpu0.service` | `/etc/systemd/system/nvidia-mps-gpu0.service` (enabled) |
| `vllm-flashnext.service.d/mps.conf` | `/etc/systemd/system/vllm-flashnext.service.d/mps.conf` |
| `zonos3.service.d/mps.conf` | `/etc/systemd/system/zonos3.service.d/mps.conf` |

The daemon covers GPU0 only: `CUDA_VISIBLE_DEVICES=0`, in PCI bus order. Its pipe is `/run/nvidia-mps-gpu0` and its logs are in `/var/log/nvidia-mps-gpu0`. The GPU1 tenants (ComfyUI, TEI, MinerU's vLLM) never see that pipe, so they run exactly as before.

It runs as `alfyws` because an MPS server serves one Linux user at a time, and both clients run as `alfyws`. A GPU0 program run as another user would wait for the server to go away, so never add a GPU0 tenant under another user without changing this.

The drop-ins use `Wants=`, not `Requires=`. If the daemon is down, the clients start without MPS, take turns as before, and keep working.

## Install

This is what was done on 2026-11-18 (chat downtime 2 min 08 s):
1. Copy the three files into place and run `systemctl daemon-reload`.
2. Wait until vLLM has no running requests.
3. `systemctl stop speech-service zonos3 vllm-flashnext`, then wait until GPU0 has no processes left.
4. `systemctl enable --now nvidia-mps-gpu0`.
5. `systemctl start vllm-flashnext` and wait for `/v1/models` to answer 200. That takes about 2 minutes.
6. `systemctl start zonos3 speech-service`.

## Check

- `nvidia-smi` lists `nvidia-cuda-mps-server` on GPU0, and both `VLLM::EngineCore` and `zonos3-server` with type **`M+C`** (an MPS client).
- `sudo -u alfyws env CUDA_MPS_PIPE_DIRECTORY=/run/nvidia-mps-gpu0 sh -c 'echo get_server_list | nvidia-cuda-mps-control'` prints the server's process id.

## Risk

The MPS server is shared, so a fault in it takes both clients down until they restart. The daemon has `Restart=on-failure`, vLLM has `Restart=always` and zonos3 has `Restart=on-failure`.

## Rollback

1. `systemctl stop speech-service zonos3 vllm-flashnext`.
2. `systemctl disable --now nvidia-mps-gpu0`.
3. Rename both `mps.conf` drop-ins to `mps.conf.disabled`, then run `systemctl daemon-reload`.
4. `systemctl start vllm-flashnext` and wait for 200, then `systemctl start zonos3 speech-service`.

Expect about 2 minutes of chat downtime.
