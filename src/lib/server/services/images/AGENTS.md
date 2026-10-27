# Images

Making and changing pictures: the ComfyUI client and its fake, graphs, pixel guards, picture files, cards and takes, the image job. Parent rules: `src/lib/server/services/AGENTS.md`.

## ComfyUI (`comfyui/`)

- **Address.** `COMFYUI_URL` only (`RuntimeConfig.comfyuiUrl` in `config-store.ts`), reached with plain `fetch` (injectable `fetchImpl`, as `mineru/client.ts` does), never `$lib/server/outbound`. Nothing a model writes becomes an address (ADR-0068).
- **Routes.** Only `POST /upload/image`, `POST /prompt`, `GET /queue`, `POST /queue` (delete), `GET /history/{id}`, `GET /view`, `POST /interrupt`, `POST /free`, `GET /system_stats` (Tool Health) and the `/ws` socket. Add no other route without a ruling.
- **Interrupt rule.** `POST /interrupt` only when `GET /queue` shows our own prompt running. `cancel(promptId, { interrupt })` deletes a pending prompt either way; for a running one it interrupts only with `interrupt: true` (the card's Stop) and otherwise answers `"running"` and leaves it. The turn-abort path passes `false`: a take ComfyUI has started finishes onto its card.
- **One writer.** Nothing outside `services/jobs/` writes `image_jobs` lifecycle columns; this folder never touches job state.
- **No facade cycle.** `services/artifacts/` imports `images/files.ts` only. `images/` modules must not import the artifacts facade.
- **Storage.** Picture files live under `data/image-files/<conversationId>/` with a relative `storage_path`; `data/image-files` is in `storageRoots()` and every unlink goes through `resolveDeletablePath`.
- **Result pictures.** Graphs end in `PreviewImage`, so results are `type: "temp"` (cleared on a ComfyUI restart); `ComfyImageRef.type` also allows `input` and `output`. Uploaded inputs persist on the GPU box until a cleanup is set up (plan 2c).
- **Socket.** One WebSocket per client, opened on the first `submit`. It only adds progress events; polling `/queue` and `/history` decides every outcome, so a client with no socket still finishes.

## The fake (`comfyui/testing/fake-comfyui.ts`)

A real loopback HTTP and WebSocket server for unit and Playwright tests. It imports Node built-ins and sharp only, so specs may import it by relative path. Options: `steps`, `stepDelayMs`, `startDelayMs`, `fail` (`reject` | `execution`), `render` (override per call or through `setOptions`); controls: `holdQueue`, `restart` (forgets prompts and history, keeps uploads). Tests that run the real client over the fake start with `// @vitest-environment node` (jsdom's `Event` and `FormData` do not mix with Node's WebSocket and fetch).

## Takes on the job engine

A take is one render of a card: a job of the `image` kind (`image-job.ts`, tables `image_jobs` and `image_job_attempts`; the card is `image_cards`). The engine owns every lifecycle transition; this folder writes only the take's own columns (`queue_ahead`, `progress_percent`, `eta_seconds`, `phase_at`, `result_file_id`, `measures_json`, `cancel_interrupt`…). `held_until` and `phase_at` are milliseconds; every `mode: "timestamp"` column is unix seconds.

| File | Owns |
|---|---|
| `take-request.ts` | `TakeRequest` (what `request_json` holds), `parseTakeRequest` (null for anything unreadable), `StoredTakeMeasures`, `IMAGE_RENDER_DEADLINE_MS` (shared by the kind and the handler so neither imports the other) |
| `image-job.ts` | the kind's definition (six at once install-wide, four per person, so prompts reach ComfyUI together and its queue orders them), `enqueueTake`, `cancelTake`, `retryTake`, `cancelImageTakesForUser` (quiesce, Clear Workspace), `cancelImageTakesForConversation` (chat delete, before any picture file is removed) |
| `image-runner.ts` | the handler, loaded on the first claim: upload inputs, build the graph, submit, checkpoint the prompt id, follow, guard an edit, store the PNG, succeed |
| `idle-free.ts` | `scheduleIdleFree` (one unref'd timer on `globalThis`, re-armed after every take, `IMAGE_IDLE_FREE_MS` 15 min measured in plan 2c) and `freeIfIdle(client)` |
| `comfy-client.ts` | the only place a client is made from `getConfig().comfyuiUrl` |
| `testing/` | `fixture.ts` (migrated database), `run-takes.ts` (`drainImageTakes`, a thin wrapper over the engine's `drain`) |

- **No import cycle.** `image-job.ts` loads `image-runner.ts` dynamically; the runner never imports `image-job.ts` (the deadline lives in `take-request.ts`). Card code that imports `image-job.ts` (`card-actions.ts`, not `cards.ts`) must not be imported by the runner.
- **Two Stops.** `cancelTake(userId, takeId, { interrupt })`: the card's Stop (`true`, the default) may interrupt our own running prompt; the composer's Stop (`false`) only deletes a prompt still waiting in ComfyUI's queue and leaves a started render alone (the call answers false and the take is not cancelled). The kind of Stop is written on the take (`cancel_interrupt`) before the engine cancels it, so the run that gets the abort, in this process or another, acts on the right one. Bulk cancels (erasure, chat delete) always interrupt.
- **Failure codes.** unreachable `image_server_unreachable` (retryable), rejected graph or `GraphBuildError` `image_graph_rejected` (not), failed render `image_render_failed`, timeout `image_render_timeout`, missing result `image_result_missing` (all retryable), missing input file `image_input_missing` (not), no address `image_server_not_configured` (not), unreadable request `image_request_invalid` (not). Only `image_worker_lost` is requeued by the policy (three attempts, 2 s apart); everything else waits for the person's Retry.
- **Resume.** A later attempt that finds `{ promptId }` in the checkpoint follows that prompt. Once the checkpoint is written, `unreachable` and `bad_response` while following are transient: the follow is retried for `FOLLOW_GRACE_MS` (60 s, longer than a ~26 s reload, capped by `IMAGE_RENDER_DEADLINE_MS`). Before the submit, `unreachable` fails the take at once. When ComfyUI is back and no longer knows the prompt (or its temp picture is gone), the take is submitted once more, once per run; a second miss fails `image_result_missing`. The fake's `outage(ms)` is the faithful reload (refuses connections, then forgets); `restart()` is zero-downtime.
- **A stopped take stores nothing.** After `storeImageFile` the runner checks the signal, and if `ctx.succeed` is refused it removes the picture by path (`discardStoredImageFile`), row or no row, because a chat's cleanup may already have run.
- **Seeds.** `enqueueTake` redraws a seed that is on `request.avoidSeeds` (never the seed that made an input). `retryTake` re-renders a failed or cancelled take with its own seed, which is not an input's.
