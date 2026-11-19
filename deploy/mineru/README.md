# MinerU 4.2 on the GPU box

Uploaded documents are read by MinerU on the GPU box (`alfyroot`), on GPU1 only. Both apps call the address in their `admin_config` row `MINERU_API_URL`, `http://127.0.0.1:8004`. How the app talks to MinerU is in [docs/uploads.md](../../docs/uploads.md); the services table, the VLM container and the 4.1 cutover record are in [deploy/README.md](../README.md#document-extraction-service-mineru). This folder holds the 4.2 unit and its watchdog.

| Unit | MinerU | Listens on | Role |
|---|---|---|---|
| `mineru42.service` | 4.2.3 | `127.0.0.1:8004` | the MinerU server both apps call (enabled) |
| `mineru42-watchdog.timer` | | | restarts `mineru42` when only a restart clears its refusal (below) |

4.2.3 took 4.1.7's place on the same port on 2026-11-18, so no app setting changed. 4.1.7 (`mineru41.service`) was retired the same evening: its unit and files are deleted (below). `mineru42` still declares `Conflicts=` and `After=` on `mineru41.service`, which systemd applies both ways, for a 4.1.7 installed again for a rollback: starting one stops the other, and the stop finishes before the start.

## Files

| File | Installed as |
|---|---|
| `mineru42.service` | `/etc/systemd/system/mineru42.service` (enabled) |
| `mineru-watchdog.sh` | `/usr/local/sbin/mineru-watchdog` (root, 0755) |
| `mineru42-watchdog.service` | `/etc/systemd/system/mineru42-watchdog.service` |
| `mineru42-watchdog.timer` | `/etc/systemd/system/mineru42-watchdog.timer` (enabled) |

**`mineru42` passes `--api-key` on its command line** (no environment fallback), so what `systemctl status` and `ps` print for it holds the key: never run either unfiltered on it. The safe checks: `systemctl is-active mineru42`, `curl -s http://127.0.0.1:8004/v1/health` (health is public, and its `version` says which MinerU answers) and `journalctl -u mineru42 -n 50`.

## What the unit sets

`mineru42.service` was made from 4.1.7's `mineru41.service`, with these changes:

- the venv `/home/alfydesign/apps/mineru4/.venv-4.2.3` (`mineru[torch]==4.2.3`, `docvortex==0.6.24` pinned, Python 3.12.15);
- `MINERU_HOME=/home/alfydesign/m42p`, a **copy** of 4.1.7's `m41p` (models, telemetry seeded off), not a shared one: 4.2.0 and later rewrite the models' `.mineru_complete` markers when they load them, which would have changed what 4.1.7 loaded while both were installed. A home for a reinstalled 4.1.7 must be its own for the same reason;
- the upload directory `/home/alfydesign/apps/mineru4/uploads-42` (two servers must not share one: it holds a lock);
- `--task-timeout 3600` (below), and `Conflicts=` plus `After=` on `mineru41.service`;
- `CUDA_DEVICE_ORDER=PCI_BUS_ID` beside `CUDA_VISIBLE_DEVICES=1`, so "1" is the card `nvidia-smi` calls GPU1;
- `HF_HUB_OFFLINE=1`: 4.2 asks HuggingFace for model metadata when it loads the models, and the models are all in `MINERU_HOME` already. A CPU-only instance with it set started and parsed a PDF, a PNG and a DOCX on 2026-11-18, with text identical to 4.1.7's;
- `ReadWritePaths` covering `apps/mineru4` and `m42p`.

The key is the one both apps already send: `EnvironmentFile=/home/alfydesign/apps/mineru4/mineru4.env` (`MINERU4_API_KEY`), so the swap needs no key change.

## The hang guard and its watchdog

4.2.3 stops a file whose execution outlives `--task-timeout` (3600 s, the default; the clock starts when the file gets a parse slot, so queueing and uploading do not count). That file ends `failed` with `task_timeout`, every other file in flight at that moment with `worker_restarted`, and from then on `/v1/health` and every new task answer **503 `task_timeout` until the process restarts**. It never exits, so `Restart=on-failure` never fires. A dead parse engine does the same with 503 `engine_dead`.

`mineru42-watchdog.timer` runs `mineru-watchdog` every minute (from three minutes after boot). It restarts `mineru42` when health answers 503 `task_timeout` or `engine_dead`, and leaves everything else alone: a healthy server, a 503 that clears by itself (`engine_unavailable`, `server_shutting_down`), a server that does not answer (down or starting: systemd's business) and a unit that is not running, such as `mineru42` after a rollback. It holds back while the unit has been up less than five minutes, so an engine that dies at every start is restarted every five minutes at most, not every minute. Health is public, so the watchdog reads no key. Every restart, and every restart held back, is in the journal:

```bash
journalctl -t mineru-watchdog
```

A restart makes MinerU forget every task. The app absorbs that: its jobs create their tasks again ([docs/uploads.md](../../docs/uploads.md#restarts-and-a-server-that-forgot)). While the guard holds, the app reads the 503 as an outage and waits (`unavailable`, no attempt spent); the file that tripped it reads `timeout`, the others `job_failed`, and all of them are retried. The app's own deadline (`MINERU_JOB_TIMEOUT_MS`, five minutes by default) cancels a remote task long before the guard's hour, but a cancel cannot stop a parse stuck in a native call, so the guard is what frees the slot.

The test of the script's decisions runs on any machine: `npx vitest run tests/integration/mineru-watchdog.test.ts`.

## Install (2026-11-18)

Every change on the box needs the owner's OK first. The apps must already run the client that reads 4.2's error codes (`37221ca86`) before the swap: an older client reads a locked or corrupt document as a retryable failure. As root on the box:

1. The venv, as `alfydesign` (from `/home/alfydesign`: uv reads `uv.toml` from the current directory):

   ```bash
   runuser -u alfydesign -- env -i HOME=/home/alfydesign PATH=/usr/local/bin:/usr/bin:/bin uv venv --python /usr/bin/python3.12 --no-python-downloads --seed /home/alfydesign/apps/mineru4/.venv-4.2.3
   ```

   ```bash
   runuser -u alfydesign -- env -i HOME=/home/alfydesign PATH=/usr/local/bin:/usr/bin:/bin uv pip install --python /home/alfydesign/apps/mineru4/.venv-4.2.3/bin/python --no-cache "mineru[torch]==4.2.3" docvortex==0.6.24 mineru-vl-utils==2.0.9 mineru-llama-cpp==0.2.1 torch==2.15.0 torchvision==0.29.2 transformers==5.22.1
   ```

2. The home and the upload directory, as `alfydesign`: `cp -a /home/alfydesign/m41p /home/alfydesign/m42p` (it keeps `telemetry_state=disabled`; check with `sqlite3 -readonly /home/alfydesign/m42p/doclib.db 'select * from telemetry_state'`) and `mkdir /home/alfydesign/apps/mineru4/uploads-42`.
3. The units: `install -m 0644 mineru42.service mineru42-watchdog.service mineru42-watchdog.timer /etc/systemd/system/`, `install -m 0755 mineru-watchdog.sh /usr/local/sbin/mineru-watchdog`, `systemctl daemon-reload`. `mineru41.service` is not edited: systemd applies a `Conflicts=` both ways, and the `After=mineru41.service` beside it makes the stop finish before the start, so the two never race for the port.
4. The swap, once no task is in flight: `systemctl disable --now mineru41`, then `systemctl enable --now mineru42`. `curl -s http://127.0.0.1:8004/v1/health` says `4.2.3` a few seconds later.
5. The watchdog: `systemctl enable --now mineru42-watchdog.timer`, then `systemctl list-timers mineru42-watchdog.timer --no-pager` lists its next run.

## Rollback

4.1.7 was retired on 2026-11-18 (below), so a rollback means installing it again first. The 4.1 record in [deploy/README.md](../README.md#document-extraction-service-mineru) has what it needs:
- a venv with `mineru[torch]==4.1.7` on Python 3.12;
- a home of its own (not `m42p`), with telemetry seeded off and the models from `mineru-kit models download --tier standard --small-backend torch --source auto`;
- an upload directory of its own;
- a `mineru41.service` on `127.0.0.1:8004` that reads the same `mineru4.env`.

With that unit installed, the swap back needs no app change:

```bash
systemctl disable --now mineru42-watchdog.timer mineru42 && systemctl enable --now mineru41
```

The app's 4.2 client reads 4.1.7 as before: 4.1.7 never sends the codes 4.2 added. Tasks in flight at the swap are forgotten, and the app creates them again like after any restart.

## 4.1.7 retired (2026-11-18)

At the owner's word, the evening of the swap:

1. **A check that nothing used 4.1.7's files.** Nothing in `m42p`, the 4.2.3 venv, the unit files, cron or the key file named them; the only mention was a 2026-11-09 download log copied over with the models. No symlink in `m42p` or the venv pointed outside them, and none of `mineru42`'s processes had a file under them open or mapped.
2. **A cold start without them.** The files were moved aside and `mineru42` restarted. It was healthy in 5 s, and the first parse loaded its models from `m42p` and gave the same text as before.
3. **The deletion**, by full path, 6.9 GB in all:
   - `/etc/systemd/system/mineru41.service`, then `systemctl daemon-reload`;
   - `/home/alfydesign/apps/mineru4/.venv-4.1.7`;
   - `/home/alfydesign/m41p`;
   - `/home/alfydesign/apps/mineru4/uploads-41`.

`/home/alfydesign/apps/mineru4/mineru4.env` stays: `mineru42` reads the key from it. Never remove it.
