# The GPU box's ComfyUI sweeps

The three ComfyUI servers on GPU1 (Qwen `comfyui.service` on :8188, H3 `comfyui-h3.service` on :8189, LTX `comfyui-ltx.service` on :8190) keep every input and output a take leaves. Qwen's and H3's are swept daily by `comfyui-clean.timer` and `comfyui-h3-clean.timer`, installed on the box by their plans (image-generation 2c, minimax-h3-image) and kept only there. The LTX server's sweep is kept here (review I-5, `docs/plans/video-review-2026-11-17/review.md`): `comfyui-ltx-clean.service` and `comfyui-ltx-clean.timer`, the same shape, held to the app's video render deadline by `tests/integration/comfyui-ltx-sweep.test.ts`.

## Install

Every change on the box needs the owner's OK first (`alfyroot` for systemd).

```bash
scp deploy/comfyui/comfyui-ltx-clean.service deploy/comfyui/comfyui-ltx-clean.timer alfyroot:/tmp/
```

```bash
ssh alfyroot 'sudo install -m 0644 /tmp/comfyui-ltx-clean.service /tmp/comfyui-ltx-clean.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now comfyui-ltx-clean.timer && systemctl list-timers comfyui-ltx-clean.timer --no-pager'
```

Expected: the timer listed with its next run at midnight. Starting the service once (`sudo systemctl start comfyui-ltx-clean.service`) removes what gathered before it: on 17 Nov, 25 clips (64 MB) and 31 guide stills (56 MB) from 15 Nov on.

Rollback: `sudo systemctl disable --now comfyui-ltx-clean.timer`, remove the two files from `/etc/systemd/system/`, `sudo systemctl daemon-reload`.

The other half of I-5, ComfyUI writing the caption and the node graph into every clip's tags, is `--disable-metadata` on `comfyui-ltx.service`'s `ExecStart`: the owner's call (the app already strips the tags from the clips it stores).

## NumPy without huge pages (all three servers)

`numpy-hugepage.conf` is a drop-in for `comfyui.service`, `comfyui-h3.service` and `comfyui-ltx.service`: `NUMPY_MADVISE_HUGEPAGE=0`. NumPy asks for transparent huge pages on every large array; with the box's `defrag=madvise` the kernel may then compact memory inside the page fault, and around every 12 MP picture (PreviewImage's save, LoadImage) that stalled H3 for 4-27 s in about half of its jobs while the GPU sat idle. Measured and reproduced in `docs/plans/minimax-h3-image/speed-investigation-2026-11-18.md` (7.5 s with the hint, 0.05 s without). It changes no pixel. Installed on the box on 2026-11-18 on the owner's word.

Install (restart each server only while its queue is empty):

```bash
scp deploy/comfyui/numpy-hugepage.conf alfyroot:/tmp/
```

```bash
ssh alfyroot 'for u in comfyui comfyui-h3 comfyui-ltx; do sudo install -D -m 0644 /tmp/numpy-hugepage.conf /etc/systemd/system/$u.service.d/numpy-hugepage.conf; done && sudo systemctl daemon-reload && systemctl show comfyui-h3 -p Environment --value'
```

Then `sudo systemctl restart comfyui comfyui-h3 comfyui-ltx` once all three queues are empty. Check: `tr '\0' '\n' < /proc/$(systemctl show comfyui-h3 -p MainPID --value)/environ | grep NUMPY` prints the variable.

Rollback: remove the three `numpy-hugepage.conf` files, `sudo systemctl daemon-reload`, restart the three servers.
