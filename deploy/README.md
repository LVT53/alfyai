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

That script currently does exactly this:

1. `git pull origin main`
2. `npm install`
3. `npm run build`
4. `npm run db:prepare`

It does **not** restart a running process manager automatically. If you use PM2, systemd, Docker, or another supervisor, restart or reload it yourself after the script completes.

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

Treat them as optional examples, not the canonical deployment path. The checked-in unit filename is retained for compatibility with existing operator notes, but the sample service account and path use AlfyAI naming and do not imply a Langflow runtime.

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
