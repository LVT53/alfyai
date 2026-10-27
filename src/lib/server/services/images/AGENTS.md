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
