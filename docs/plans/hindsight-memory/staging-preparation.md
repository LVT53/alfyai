# Private Memory staging preparation

The isolated staging stack uses the deployment files from AlfyAI `eb1bc237cf9fd409bcd80407c138365fa1a4a329` and Hindsight source `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`. Staging uses a fresh synthetic app database and dedicated native credentials. The production app and canonical staging app retain their existing deployments.

## CPU baseline staging infrastructure

| Resource | Setting |
| --- | --- |
| Host and Docker project | `alfydesign`, `alfyai-memory-stage` |
| Root-owned configuration | `/etc/alfyai-memory/stage`, mode 0700, with mode-0600 secret files |
| PostgreSQL | Dedicated PostgreSQL 17 and pgvector. The data directory is `/home/.alfyai-native-memory/stage/pgdata`. PostgreSQL has no published port. |
| Hindsight API | `http://127.0.0.1:18892`, published on loopback |
| Docker bridge | `172.30.40.0/28`, gateway `172.30.40.1` |
| Staging app and activity | `http://172.30.40.1:13002`, with authenticated activity at `/api/internal/memory-admission` |
| Local inference | `qwen3-6-27b` on the same host at `http://172.30.40.1:30000/v1`. Curation uses the authenticated Hindsight admission gateway. |
| Hindsight limits | One replica and process, four CPUs, 8 GiB memory, `OMP_NUM_THREADS=4`. Overnight mode is off and inference admits one background request at a time. |
| Worker recovery | Persistent native worker ID `alfyai-memory-stage` |
| PostgreSQL limits | Two CPUs and 2 GiB memory |
| Logging | Native request traces and OpenTelemetry traces disabled. Native log level warning. Installed vLLM 0.34.0 defaults to request logging disabled, with no active request-logging or trace flags. |
| Model cache and artifacts | Stage-specific directories `cache` and `artifacts` under `/home/.alfyai-native-memory/stage`. The restricted artifact directory holds build and image integrity records. |

The pre-start check resolved exactly one loopback port for Hindsight, no PostgreSQL port, both intended bind mounts and the dedicated bridge. It verified the archived deployment source checksums and the empty staging PostgreSQL directory. The Docker build context allows only the Dockerfile and three extension sources.

### Startup evidence

- Running AMD64 Hindsight image ID `sha256:50f9dfcdfa094720d99d5d95f74a50c1c77655291085da63e69729941788f762`. The running image's engine commit file reported the expected pinned source.
- Running AMD64 PostgreSQL image ID and registry digest `sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd`.
- The protected `images.tar.gz` archive SHA-256 is `4082f1500987ef35d48aa9934f2617dc95e2cf1b377c8ba828fcaaf5f90a1d95`. The deployment uses local image tags tied to these IDs and disables builds and pulls at startup.
- PostgreSQL had zero AlfyAI tenant schemas before and after first Hindsight startup. The API reported a healthy database connection. Authenticated inference status reported zero active and completed requests. Authenticated model metadata from inside the container returned HTTP 200 and included `qwen3-6-27b`.
- Startup completed with approximately 1.44 GiB Hindsight memory and 39 MiB PostgreSQL memory against their observed container limits. The host had 117 GiB available RAM and a one-minute load average of 1.90 on 32 CPUs after startup.
- First startup warned that recovery of interrupted jobs requires a persistent worker ID. Two subsequent recreations retained `alfyai-memory-stage` on the same native image without the warning. PostgreSQL retained its original container and had zero tenant schemas before application testing.
- The baseline warms ONNX E5 and FlashRank public assets, then starts with the Hugging Face cache offline. Both recreated containers were healthy. The protected model archive `model-assets.tar.gz` has SHA-256 `90926ee8f2b0ef7f87445d83c7ac5d8d84c56a21bd02ba60391a2d11810b7d87` and includes 30 independently verified asset paths and their relative symlinks.

## Isolated GPU staging infrastructure

GPU staging runs as `alfyai-memory-stage-gpu`. It uses the exact baseline native and PostgreSQL images with a fresh database at `/home/.alfyai-native-memory/stage-gpu/pgdata` and independent credentials in root-owned `/etc/alfyai-memory/stage-gpu`. The API publishes to `127.0.0.1:18894`. Hindsight uses `172.30.43.2` on its own bridge and its native worker ID is `alfyai-memory-stage-gpu`. The CPU baseline continues at `127.0.0.1:18892`.

The host transport listens only at `172.30.43.1:17998`. Requests from the host and from the PostgreSQL sibling returned HTTP 403. PostgreSQL publishes no port. Both stock Hindsight adapters completed requests from the native container and incremented their separate transport counters. The exact local GPU services use `/qwen3-embedding-4b` and `/bge-reranker-v2-m3` through existing authenticated TEI 1.9.3. An eight-item request with about 3,000 synthetic characters per item took 262 ms for 1,024-dimensional embeddings and 30 ms for reranking. These were direct requests to the existing services.

The isolated app candidate `7a575210d` binds to `172.30.43.1:13003`. From the running native container, its admission callback returned HTTP 401 without credentials and HTTP 200 with the matching stage admission key. The authenticated sample was healthy, inactive and 1 ms old. Overnight mode stayed off. The callback recreation kept the same native image, PostgreSQL container and retrieval transport.

The first staged English edit reached the application, then settled with `memory_preparation_failed`. At the quiescent boundaries of that attempt, the native gateway counted 17 and 22 completed dispatches and 5 and 7 admission refusals, with peak concurrency one. Its completion counter includes upstream error responses. The retrieval transport counted 64 and 66 embeddings and 28 reranks at both boundaries. No native operations remained pending or processing after settlement. These observations confirm activity through the shared gateway. The app-side failure still needs a successful correction and replay.

### Matched retrieval comparison

The fixture froze 24 passages and 12 labelled English, Hungarian and cross-language queries. Both runs used the same AMD64 host, pinned Hindsight image and stock adapter factories. Each adapter embedded the passages, selected eight by cosine similarity and reranked that shortlist. The GPU run used the deployed private transport and the fixture's exact query prefix, `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `, with a newline before `Query`. The CPU ran first in a disposable network-disabled container with the read-only model cache. The GPU ran second in the isolated Hindsight container. Both initialized their adapters before timing. There was no separate query warm-up, and the single timed run evaluated queries serially in fixture order. [Frozen fixture](gpu-retrieval-benchmark.json) · [Harness](gpu-retrieval-benchmark.py) · [Raw paired scores](gpu-retrieval-paired-results.json)

| Measure | CPU ONNX E5 and FlashRank | GPU Qwen and BGE |
| --- | ---: | ---: |
| Expected passage first by embedding | 9/12 | 12/12 |
| Expected passage in the embedding shortlist | 10/12 | 12/12 |
| Expected passage first after reranking | 8/12 | 12/12 |
| Expected passage first after reranking on cross-language queries | 0/4 | 4/4 |
| Median query embedding and reranking | 32.38 ms | 40.92 ms |
| Adapter process CPU time for all passages and queries | 1,395.59 ms | 71.58 ms |
| Peak adapter process memory | 1,392.93 MiB | 132.72 MiB |

The existing shared TEI services and transport added approximately 714 ms of measured CPU time during the GPU sampling window. That counter also includes any ambient service activity. GPU 1 memory stayed at 22,250 MiB, with utilization sampled at 0% before and 4% after the paired run. The separate eight-item wire probe sampled 99% immediately after dispatch. The comparison measures this small synthetic retrieval set and does not establish application latency under concurrent traffic.

To reproduce a profile, make the two evidence files available to the validated Linux native image and run `python gpu-retrieval-benchmark.py gpu-retrieval-benchmark.json` in that profile's native environment. Use the CPU Compose settings and warmed offline cache for ONNX/FlashRank. Run the GPU profile inside the native container with the private transport and matching 1,024-dimensional OpenAI/TEI configuration. The harness exercises adapter retrieval directly. It leaves the application database and native banks out of these scores.

A second run on the same host reproduced the embedding and reranking ranks for all 24 profile/query pairs using the saved harness. It checked fixture SHA-256 `74c77429d5f2fe1ccbd53557b363dcce133e6fe9ef1769cd3a3908f55076f1cc`, harness SHA-256 `7ae0e4ba9554ef8b526efdd0f6b215c1059e263508c4b4545d73273e3425a063`, and the running GPU query prefix's 92 UTF-8 bytes at SHA-256 `df4b2898bf22e00bacddddd489243a3f8793730e38b842ec10161cebd94d36d6`.

### Interrupted native operation recovery

A synthetic retain parent `93582600-9e8a-4f03-81e9-d30bcf2d2878` created child `cab08bf7-b56b-4e1a-988a-9e0c8dda777a`. PostgreSQL showed that child `processing` under `alfyai-memory-stage-gpu` with retry count 0 before and after SIGKILL of only the isolated native container. Recreating the container with the same image and worker ID left PostgreSQL and the transport in place. The original child completed with retry count 1 and the parent completed through the API. Its document returned four facts, including the expected telescope storage detail. The initial probe observed the batch parent rather than its processing child and finished without interrupting a container. The recovery probe used a new operation and made no manual database changes.

## Stop and recover staging

Stop the isolated app before the stage backend. On the host, the following command stops only the staging Hindsight and PostgreSQL containers and keeps their data directories intact.

```sh
cd /etc/alfyai-memory/stage
docker compose -p alfyai-memory-stage --env-file native-db.env \
  -f compose.yaml -f compose.stage.yaml -f compose.images.yaml stop hindsight postgres
```

Verify the archived image checksum and expected image IDs before recreating a container with `up -d --no-build --pull never`. An app restore needs a matched SQLite database, PostgreSQL dump and key bundle. Preserve the recorded Hindsight URL, including port 18892, by stopping the original staging API before publishing the isolated restore API at that address. Keep the restored app under `HINDSIGHT_RESTORE_HOLD=true` until the privacy decisions in the restored state have been verified. [Native backup and restore procedure](../../../deploy/hindsight/README.md#backup-restore-and-upgrades)

## Planned GPU restore verification

Capture both a matched older pair with a synthetic canary and a queued job, and a newer pair after acknowledged synthetic erasure and native cleanup. Stop the isolated app and drain native operations before taking each SQLite and PostgreSQL backup. Keep database dumps and matching key material in restricted storage.

Use a fresh restore project on `172.30.44.0/28`, with the relay bound to `172.30.44.1:17998`, Hindsight at `172.30.44.2` and PostgreSQL at `172.30.44.3`. The relay explicitly trusts the restore Hindsight IP. Stop the original isolated app and native API before assigning `127.0.0.1:18894` to the restore API. This preserves the stored Hindsight bindings without modifying rows.

Boot the older restored app with `HINDSIGHT_RESTORE_HOLD=true` and the restored Hindsight API stopped. Verify HTTP 503 and that the queued job stays unclaimed. Keep that pair held. Verify the newer pair's acknowledged privacy decisions before restoring it in a separate database directory and bringing its service up.
