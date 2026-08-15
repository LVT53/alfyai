# Advanced Deployment Notes

The primary public deployment path for AlfyAI is documented in the root [README.md](../README.md) and centered on `./scripts/deploy.sh`.

This file exists for operators who want to adapt AlfyAI to a more customized Linux setup, such as:

- systemd-managed application processes
- Apache reverse proxying
- custom host-level service management

## Primary Recommended Flow

For most deployments, use the root workflow:

```bash
cp .env.example .env
# edit .env
./scripts/deploy.sh
```

That script builds each deploy into its own immutable release directory and cuts the live service
over with a single atomic symlink flip (see "Release layout" below). In order:

1. Fetch the target branch (`git fetch origin main`) and resolve its short SHA.
2. Materialize a clean, `.git`-less snapshot into `releases/<sha>/` via `git archive | tar -x`.
3. `npm ci || npm install` inside `releases/<sha>/` (`npm ci` is tried first; the repo falls back to
   `npm install` if the committed lockfile has drifted).
4. Symlink `shared/.env` and `shared/data` into `releases/<sha>/`.
5. `npm run build` inside `releases/<sha>/`.
6. `npm run check:migrations && npm run db:prepare`, after the build, immediately before cutover.
7. Atomically flip the `current` symlink to `releases/<sha>/` (`ln -sfn` + `mv -Tf`).
8. Restart the systemd service and poll `/api/health`; on failure, roll back to the previous
   release and exit non-zero.
9. Prune `releases/` to the last 3.

The script restarts the systemd service itself; it does not need a separate PM2/Docker restart
step, and it never mutates the previously-live release while the app is serving traffic.

### Release layout

```
<app root>/
├── shared/
│   ├── .env                   # config/secrets — durable, never per-release
│   └── data/                  # the SQLite DB + uploaded files — durable, never per-release
├── releases/
│   ├── <sha-N-1>/              # immutable; data & .env are symlinks into ../../shared
│   └── <sha-N>/
└── current -> releases/<sha-N>   # the only path a cutover ever moves
```

`scripts/deploy.sh` (and `scripts/deploy-dev.sh`) assume this layout **already exists** — they
refuse to run with a clear error if `shared/` is missing rather than attempting to build it. The
one-time conversion from a flat checkout to this layout is a separate, service-stopped runbook (see
[docs/adr/0054-atomic-release-cutover.md](../docs/adr/0054-atomic-release-cutover.md)), run once per
environment before the first release-based deploy.

**Rollback** is re-pointing `current` at the previous release directory and restarting the service
(`ln -sfn releases/<previous-sha> current` + `mv -Tf` + restart) — the same atomic flip used for a
normal deploy, just aimed backward. `scripts/deploy.sh` does this automatically when the
post-cutover health check fails. The last 3 releases are always retained so a manual rollback target
is always available.

**Migration ordering — expand/contract.** `db:prepare` runs against the shared database *before*
the symlink flip, so for the interval between migrating and restarting, the still-running old code
sees the new schema, and a rollback runs the old code against the already-migrated database. Both
are only safe when migrations are additive (new nullable columns, new tables that old code ignores).
A migration that **drops or renames** a column in the same release as the code change that stops
using it breaks the old process during the flip window and breaks rollback — this is rejected in
review. Destructive changes ship in a *later* release, once no deployed code references the old
column.

## Staging is a required stop before production

There is a live staging environment that mirrors production, and **every change must be
deployed and verified there before it reaches production**:

| | staging | production |
|---|---|---|
| Deploy script | `scripts/deploy-dev.sh` | `scripts/deploy.sh` |
| Branch pulled | `dev` | `main` |
| systemd service | `langflow-chat-dev.service` | `langflow-chat.service` |
| Port | 3002 | 3001 |
| Public host | `ai.dev.alfydesign.com` | the live site |
| Database | its own, **disposable** | real user data |

`scripts/deploy-dev.sh` is kept **structurally identical** to `scripts/deploy.sh` — they differ
only in the branch pulled and the systemd service restarted — so the two flows cannot drift.
Change one, change both, in the same commit.

Deploy order for any change:

1. Merge the change onto `dev`, run `scripts/deploy-dev.sh` on staging.
2. Verify staging: `curl -s http://localhost:3002/api/health` returns `{"status":"OK"}`, and one
   real chat turn completes end to end at `https://ai.dev.alfydesign.com`.
3. Only then merge to `main` and run `scripts/deploy.sh` on production.
4. Verify production the same way on port 3001.

A staging failure is expected and cheap — fix it and redeploy staging (its database is
disposable). A production post-deploy failure means rolling back immediately.

**Restart privileges differ between the two environments.** The application account has a
passwordless sudoers rule to restart the *production* service but **not** the staging service, so
`scripts/deploy-dev.sh` attempts a non-interactive restart and, if it is denied, prints the exact
privileged command to run instead (it does not fail the build). Add a NOPASSWD sudoers rule for
`langflow-chat-dev.service` if you want fully unattended staging restarts.

## Optional Advanced Linux Setup

The files in this directory can still be used as examples for a more manual host-managed deployment:

- `deploy/langflow-chat.service`
- `deploy/apache-site.conf`
- `deploy/apache-modules.md`

`deploy/langflow-chat.service` matches the real production unit: `WorkingDirectory`,
`EnvironmentFile`, and `ExecStart` all point at the `current` symlink (never a specific
`releases/<sha>/` directory), so a cutover only ever re-points the symlink — the unit file itself
never needs editing or a `daemon-reload` for a normal deploy. The checked-in unit filename is
retained for compatibility with existing operator notes; the service account and path use AlfyAI
naming and do not imply a Langflow runtime.

For a host-managed setup where another local process or container must reach the app over the host bridge network, set `HOST=0.0.0.0` and `PORT=3001` in the environment file that systemd loads rather than hardcoding those values into the unit file itself.

That keeps Apache reverse proxying to `127.0.0.1:3001` on the host while also allowing containers to reach the host at `http://172.17.0.1:3001` when the Docker bridge uses the default subnet.

## Runtime Expectations

- Node.js 20+
- npm
- a writable `data/` directory
- reachable OpenAI-compatible model provider endpoint(s) from the app server
- a configured `.env`

## Health Check

The app exposes:

```bash
curl -s http://localhost:3001/api/health
```

Expected response:

```json
{"status":"OK"}
```

## Upload Body Size

Production builds patch adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`.

You can still override it explicitly:

- `BODY_SIZE_LIMIT=100M` to match the current default
- a higher value if your deployment needs more headroom

Keep it at or above the application’s current 100MB upload cap so multipart requests are not rejected at the transport layer first.
