# Sandbox — Sandboxed File Production

Sandboxed container execution for AI-generated file production. Isolated Python/Node runtime with no network access.

## Structure

| File | Purpose |
|------|---------|
| `config.ts` | Docker container lifecycle, image warmup, exec monitoring |
| `config.test.ts` | Container lifecycle tests |

## Key Behavior (not in parent)

- **Image warmup**: `ensureSandboxImage()` runs at startup and first use; warms `python:3.11-slim` and `node:22-bookworm-slim`
- **Security model**: `NetworkMode: 'none'`, non-root UID 1000:1000, readonly rootfs with writable tmpfs for `/output` and `/tmp`
- **Exec monitoring**: Polls Docker exec inspect for `Running === false` before reading output — prevents race with early stream close
- **Output collection**: Tries Docker archive path first, falls back to in-container readback for tmpfs-backed outputs
- **Cleanup**: Kills throwaway container immediately instead of waiting through idle stop timeout (~10s saving)

## Log Prefixes

| Prefix | Source |
|--------|--------|
| `[FILE_PRODUCTION]` | Sandbox runtime, image warmup, readback warnings |
| `[SANDBOX]` | Container lifecycle events |

## Anti-Patterns

- **No network in containers**: Network access was explicitly removed; do not re-enable
- **No root in containers**: Containers run as UID 1000; root access is blocked
- **No host disk writes**: Archive contents are collected in-memory only; never write to host filesystem

## Sandbox Execution And File Production

- Sandbox configuration:
  - [`src/lib/server/sandbox/config.ts`](config.ts)
- Sandbox execution service:
  - [`src/lib/server/services/sandbox-execution.ts`](../services/sandbox-execution.ts)
- File production API:
  - [`src/routes/api/chat/files/produce/+server.ts`](../../../routes/api/chat/files/produce/+server.ts)
- Chat-linked file storage:
  - [`src/lib/server/services/chat-files.ts`](../services/chat-files.ts)


Security model:

- **Container isolation**: Docker containers with no network access (`NetworkMode: 'none'`)
- **Non-root execution**: Containers run as UID 1000:1000, not root
- **Capability dropping**: All Linux capabilities dropped (`CapDrop: ['ALL']`, `Privileged: false`)
- **Resource limits**: 60s timeout, 1GB memory, 50MB max file size, 100 process limit
- **Readonly rootfs**: Container filesystem is readonly; writable tmpfs for `/output` and `/tmp`
- **In-memory extraction**: Generated files are collected in-memory only. Prefer the Docker archive path first, but keep the in-container `/output` inspection and controlled readback fallback available when archive reads miss tmpfs-backed outputs. Never write sandbox contents to host disk.
- **Path traversal protection**: Rejects `..`, absolute paths, null bytes, symlinks, devices
- **Aggregate limits**: Max 20 output files, 50MB total output
- **Image bootstrap**: The sandbox config auto-pulls the pinned base image on first use if it is missing, but the app process still needs working Docker daemon access and image-pull permission on the host


Do not:

- add network access to sandbox containers
- run containers as root
- write tar contents to host filesystem
- bypass timeout/resource limits
- add new languages without security review
