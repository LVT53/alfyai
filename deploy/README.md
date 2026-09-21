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
6. `npm run check:migrations`, then **back up the database** (see "Database backups" below), then
   `npm run db:prepare` — after the build, immediately before cutover.
7. Atomically flip the `current` symlink to `releases/<sha>/` (`ln -sfn` + `mv -Tf`).
8. Restart the systemd service and poll `/api/health`; on failure, roll back to the previous
   release and exit non-zero.
9. Prune `releases/` to the last 3.

The script restarts the systemd service itself; it does not need a separate PM2/Docker restart
step, and it never mutates the previously-live release while the app is serving traffic.

The `db:prepare` step in the flow above (step 6) is also what the standard runtime entrypoint runs:
`npm start` is `npm run check:migrations && npm run db:prepare && node build`, so a host-managed
`adapter-node` start applies pending Drizzle migrations before serving the built app. SvelteKit
adapter-node reads `HOST` and `PORT` for the listen address, so container-reachable host setups should
use `HOST=0.0.0.0` instead of `127.0.0.1`.

### Deploy-script environment variables

These variables tune `scripts/deploy.sh` / `scripts/deploy-dev.sh` themselves. They are **script-only**
and are not read by the app (app runtime variables are in
[docs/configuration.md](../docs/configuration.md)).

| Variable | Default | What it does |
|---|---:|---|
| `APP_DIR` | current working directory | App root (containing `shared/`, `releases/`, `current`) to deploy into. Set it when the script is invoked from outside the app directory. |
| `DEPLOY_BRANCH` | `main` (`dev` in `deploy-dev.sh`) | Branch fetched and archived into the new release. Rarely overridden outside the two canonical scripts. |
| `SERVICE_NAME` | `langflow-chat.service` (`langflow-chat-dev.service` in `deploy-dev.sh`) | systemd unit restarted after cutover and polled for rollback. |
| `HEALTH_PORT` | `3001` (`3002` in `deploy-dev.sh`) | Port polled at `/api/health` after cutover to decide rollback. Set it if the app listens on a non-default port. |
| `RELEASES_TO_KEEP` | `3` | How many `releases/<sha>/` directories are retained after a successful deploy. Older releases are deleted, not archived. |
| `DB_BACKUP_KEEP` | `7` | How many database backups are retained in `shared/backups/`. The backup taken by the current deploy is never pruned, whatever the ordering says. |
| `DB_BACKUP_REQUIRED` | `1` | When `1`, a failed database backup **aborts the deploy before any migration runs**. Set to `0` to deploy anyway with an unprotected database. |
| `DB_BACKUP_TIMEOUT` | `600` | Wall-clock ceiling (seconds) for the backup copy and for the integrity check, so a stalled filesystem cannot hang a deploy. |

### Database backups

`db:prepare` runs the full Drizzle migration set against the live SQLite file (`shared/data/chat.db`,
WAL mode, ~140 MB in production). There are 110 migrations, 9 of them destructive. Every deploy now
takes a verified copy first, in step 6, before the cutover.

**How the backup is taken**, in order of preference — each step is a fallback for a host that cannot
do the previous one:

1. `sqlite3 "$DB" ".backup '$DEST'"` — SQLite's online backup API. The only strategy that is
   guaranteed consistent while the currently-live release is still writing to the database.
2. better-sqlite3's `.backup()` from the release's own `node_modules`. Same API, no `sqlite3` package
   needed. This is what a minimal Debian host without the `sqlite3` CLI will use.
3. A plain `cp` of the database plus its `-wal` and `-shm` sidecars. **Not** an atomic snapshot — it
   prints a loud warning telling you to install the `sqlite3` package.

Every backup is then verified (`PRAGMA integrity_check` where the CLI is available, otherwise a
non-empty-file check) and deleted again if it does not pass.

**Where they go:** `shared/backups/chat-<UTC timestamp>-<release sha>.db`, directory mode `700`, file
mode `600`. These files contain every conversation and every encrypted credential in the product —
treat them exactly like the database itself. The newest `DB_BACKUP_KEEP` (default 7) are retained.

**If the backup fails, the deploy stops.** This is the only step allowed to do that, and the only
point in the flow where it is safe: nothing has been migrated and the `current` symlink has not been
flipped, so the running service carries on serving the previous release against an untouched
database. Fix the cause (disk space, permissions on `shared/backups`) and re-run. To deploy anyway,
knowingly unprotected:

```bash
DB_BACKUP_REQUIRED=0 ./scripts/deploy.sh
```

On a first install, where the database does not exist yet, the step is skipped quietly.

#### Restoring

The deploy prints the exact restore command in its success line. The shape is:

```bash
# 1. Stop the app so nothing is writing to the database.
sudo systemctl stop langflow-chat.service

# 2. Put the backup in place and drop the stale WAL sidecars, which belong to
#    the database you are replacing, not to the backup.
cp -p /path/to/app/shared/backups/chat-<timestamp>-<sha>.db /path/to/app/shared/data/chat.db
rm -f /path/to/app/shared/data/chat.db-wal /path/to/app/shared/data/chat.db-shm

# 3. Confirm the restored file is sound before starting anything.
sqlite3 /path/to/app/shared/data/chat.db "PRAGMA integrity_check;"   # expect: ok

# 4. Start again.
sudo systemctl start langflow-chat.service
```

If the restore is a rollback from a bad migration, re-point `current` at the previous release
(see "Release layout") **before** starting the service — an old database under new code is exactly
the state the backup exists to avoid being stuck in.

### Obtaining the deploy script itself

Because releases are `git archive` snapshots and the app root is no longer a live working checkout,
the app root's copy of `scripts/deploy.sh` is not automatically updated by a deploy. Refresh it from
the target ref **before** running it, so a deploy always runs the latest flow:

```bash
cd <app root>                 # the dir containing .git, shared/, releases/, current
git fetch origin main
git checkout origin/main -- scripts/deploy.sh scripts/deploy-dev.sh
./scripts/deploy.sh
```

The app root keeps its `.git` precisely so it can (a) hand the deploy script the ref to archive and
(b) supply the latest script via the `git checkout` above. On staging, use `origin/dev` and
`scripts/deploy-dev.sh`.

### Release layout

```
<app root>/
├── shared/
│   ├── .env                   # config/secrets — durable, never per-release
│   ├── data/                  # the SQLite DB + uploaded files — durable, never per-release
│   └── backups/               # pre-migration DB backups, mode 700/600 (see "Database backups")
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

### The sandbox's Python packages, and root-owned release leftovers

`produce_file`'s Python program mode runs in a `python:3.11-slim` container that bind-mounts
`<release>/sandbox-python-env/lib/python3.11/site-packages` read-only at
`/workspace/python-packages`. The deploy fills that directory by asking any host pip to resolve
**wheels for the container's interpreter**, not the host's:

```
pip install --target <release>/sandbox-python-env/lib/python3.11/site-packages \
  --python-version 3.11 --implementation cp --only-binary=:all: \
  --platform manylinux2014_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux_2_28_x86_64 \
  openpyxl xlsxwriter python-docx python-pptx
```

The Python minor version is declared once in `scripts/sandbox-python-version.sh` and once in
`src/lib/server/sandbox/python-version.ts`; a unit test fails if the two disagree, or if the path
the deploy writes to stops matching the path the container mounts. If a host pip is unavailable the
deploy falls back to running the same install inside the sandbox image, as the deploying user and
honouring `DOCKER_HOST` — which is why the step runs *after* the `.env` load.

Afterwards the deploy runs `scripts/verify-sandbox-packages.sh`, which imports `openpyxl`,
`xlsxwriter`, `docx` and `pptx` inside a `python:3.11-slim` container using the real mount, falling
back to a file-presence check when Docker is unreachable. A failure never aborts the deploy — the
chat app still ships — but it prints in red and is repeated in the final summary. Run it by hand on
a box that is producing `ModuleNotFoundError`:

```bash
set -a; source shared/.env; set +a      # DOCKER_HOST
bash current/scripts/verify-sandbox-packages.sh current
```

**Why this had to be fixed (2026-09-17).** The deploy used to build a venv with the *host* python.
The box's `python3` is 3.12, so the packages landed in `.../lib/python3.12/site-packages` while the
container mounted `.../lib/python3.11/site-packages`. Docker creates a missing bind-mount source
automatically — as an **empty, root-owned** directory — so every Python program-mode job failed with
`ModuleNotFoundError: No module named 'openpyxl'`, and that root-owned directory then made every
later `rm -rf` of the release fail with `Permission denied`, ending each deploy non-zero.

**One-off operator cleanup.** The prune step now warns, lists what it could not remove, and
continues instead of failing the deploy. To actually reclaim the space, from an account with sudo
(`alfyroot`):

```bash
# delete the specific leftovers the deploy listed
sudo rm -rf <app root>/releases/<old-sha> [...]

# or hand the whole releases tree back to the deploy user so pruning
# succeeds on its own from now on
sudo chown -R alfydesign:alfydesign <app root>/releases
```

**Exit-code semantics.** The deploy exits `0` when the app is live and healthy, whatever the sandbox
package step and the prune step had to say. Both are best-effort and neither can abort the deploy,
block the restart, or delay the cutover — they run *before* the symlink flip, so they add to the
deploy's wall-clock time but never to the downtime window, and every external command in them is
bounded by `timeout` so a wedged `DOCKER_HOST` or a stalled package index cannot hang a deploy.
A non-zero exit still means what it always meant: the release did not go live (or went live, failed
its health check, and was rolled back). Failures in the best-effort steps surface as `⚠⚠⚠` lines
during the run and are repeated verbatim under `=== N deploy warning(s) ===` after the success
banner, so a green deploy with warnings is still worth reading to the bottom.

**Which copy of the script actually runs.** The deploy never checks out into the app-root working
tree — it only does `git fetch` plus `git archive` — so the two environments pick up a change to the
deploy scripts at different moments:

| | script that runs | how a script change reaches it |
| --- | --- | --- |
| production | `$APP_DIR/scripts/deploy.sh` (app-root checkout) | never automatically — an operator must update that checkout |
| staging | `./current/scripts/deploy-dev.sh` (previous release) | one deploy later: the deploy that ships the change still runs the old script |

So after merging a change to `scripts/deploy*.sh`, on production run once, by hand:

```bash
cd /home/alfydesign/apps/langflow-chat
git fetch origin main && git checkout -B main origin/main   # refresh the app-root checkout only
./scripts/deploy.sh
```

On staging nothing extra is needed — deploy twice, or accept that the first deploy after the change
still runs the previous script. Both scripts therefore tolerate a *mismatch* between the script and
the release tree: the shared helper is sourced from the release when it is there, from the script's
own `scripts/` directory when the release predates it (rolling back by deploying an old sha), and
falls back to stand-ins that skip the optional steps if neither exists. An unguarded `source` would
have aborted a rollback deploy outright under `set -e`.

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
Change one, change both, in the same commit. Steps longer than a few lines live once in
`scripts/deploy-lib.sh`, which both scripts source out of the release they just materialized;
`scripts/deploy.test.ts` compares the two script bodies and fails on drift.

Deploy order for any change:

1. Merge the change onto `dev`, run `scripts/deploy-dev.sh` on staging.
2. Verify staging: `curl -s http://localhost:3002/api/health` returns HTTP 200 with `status: "OK"`
   (see [Health check](#health-check)), and one real chat turn completes end to end at
   `https://ai.dev.alfydesign.com`.
3. Only then merge to `main` and run `scripts/deploy.sh` on production.
4. Verify production the same way on port 3001.

A staging failure is expected and cheap — fix it and redeploy staging (its database is
disposable). A production post-deploy failure means rolling back immediately.

**Restart privileges differ between the two environments.** The application account has a
passwordless sudoers rule to restart the *production* service but **not** the staging service, so
`scripts/deploy-dev.sh` attempts a non-interactive restart and, if it is denied, prints the exact
privileged command to run instead (it does not fail the build). Add a NOPASSWD sudoers rule for
`langflow-chat-dev.service` if you want fully unattended staging restarts.

## Creating a release campaign from a deck

`scripts/create-release-campaign.ts` builds an in-app release campaign out of a prepared deck
directory, so the whole four-slide announcement does not have to be typed and re-uploaded through
Administration → Campaigns by hand.

It is not a SQL script. It calls `announcement-campaigns.ts` and `campaign-assets.ts` — the same
functions `/api/admin/campaigns*` calls — so the draft it writes is the draft the admin UI would
have written: the same identity key and revision arithmetic, the same source+crop asset pair per
image, the same files under `data/campaign-assets/`, and with `--publish` the same publish
validation the Publish button runs.

### The deck

A directory holding `slides.json` and the artwork it references:

| key | required | notes |
|---|---|---|
| `titleEn` / `titleHu` | yes | |
| `bodyEn` / `bodyHu` | yes | |
| `altTextEn` / `altTextHu` | yes | every slide here ships images, and publishing requires localized alt text whenever a slide has one |
| `desktopFile` / `mobileFile` | yes | deck-relative paths; 16:10 and 9:16, at least 1600x1000 and 1080x1920 |
| `actionLabelEn` / `actionLabelHu` / `actionDestination` | optional | all three together; the destination must be on the allowlist in `src/lib/campaign-action-destinations.ts` |

At least four slides. The whole deck is validated before anything is written, and every problem is
reported at once rather than one per run.

**SVG goes in as SVG.** `campaign-assets.ts` accepts `image/svg+xml`, nothing re-encodes or crops
server-side, and `/api/campaign-assets/[id]/content` serves SVG with a CSP
(`img-src data:`) that exists precisely so artwork carrying embedded base64 screenshots renders.
So the vector artwork is stored as-is and stays sharp at any density. Pass `--png-dir <dir>` to
upload pre-rendered PNGs of the same slides instead — the script looks for each `desktopFile` /
`mobileFile` basename with a `.png` extension in that directory. No rasterizer is added to the repo
either way. (For contrast: the admin UI's crop modal always rasterizes to `image/webp` at exactly
1600x1000 / 1080x1920, because a human cropping a phone screenshot needs it to. A deck already at
the target geometry needs no crop, so the script saves the full frame at 1:1.)

### Running it on a server

Run it **from the release directory**. The database comes from `DATABASE_PATH` exactly as the
server resolves it, and the asset files are written to `<cwd>/data/campaign-assets` exactly as the
server writes them — both relative to the working directory, where `data` is the symlink to
`shared/data` (see [Release layout](#release-layout)). The script compares the two and refuses to
run if they are not the same deployment's data directory, rather than writing rows that point at
files the server will never find.

Staging first, as always:

```bash
cd /home/alfydesign/apps/langflow-chat-dev/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck /home/alfydesign/decks/alfyai-release-campaign-2 \
  --name "AlfyAI 2.0" --version 2.0.0 \
  --admin-email you@example.com --dry-run
```

Drop `--dry-run` to create the draft, then review it at `/settings` → Administration → Campaigns
(the pane has no deep link; the sub-tab is local state). Publish from that screen, or re-run with
`--publish` to run the same validation from the command line.

Production, once staging looks right:

```bash
cd /home/alfydesign/apps/langflow-chat/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck /home/alfydesign/decks/alfyai-release-campaign-2 \
  --name "AlfyAI 2.0" --version 2.0.0 \
  --admin-email you@example.com
```

Exit codes: `0` success, `1` refused (bad deck, non-admin author, duplicate campaign, failed
publish validation), `2` bad command line.

### What it will and will not do

- **Draft by default.** `--publish` additionally publishes, which is what makes the campaign
  auto-show to users, so it is deliberately a second, explicit flag.
- **Idempotent.** A second run with the same `--name` and `--version` is refused. `--replace-draft`
  deletes and recreates, but only ever a **draft** — a published or archived campaign is immutable
  and the script will not touch it (neither will `deleteCampaignDraft` underneath it). To correct a
  published campaign, publish a new version or revision, as
  [ADR 0012](../docs/adr/0012-announcement-campaigns-and-first-run-onboarding.md) requires.
- **`--dry-run` writes nothing** — no rows, no files — and prints what it would do, including
  whether it would replace an existing draft.
- **The author must be an admin.** `--admin-email` is resolved against `users`; a missing user or a
  non-admin role is refused with the reason, before anything is written.

### No restart needed

Campaign reads are per-request SQLite reads on both sides — `/api/admin/campaigns` for the editor,
`/api/campaigns/eligible` for the app shell — and neither the services nor the client hold a
campaign cache. A running server picks up a draft or a publish made out-of-process immediately.

Two caveats:

- Asset content is served `Cache-Control: private, max-age=300`, so a browser that already fetched
  an asset id can show the old bytes for up to five minutes if that id's file is replaced. A hard
  reload clears it; a restart does not help.
- The sidebar version badge shows the higher of the package version and the newest **published**
  release campaign — unless `APP_VERSION_OVERRIDE` is set in admin config, which is read from a
  per-process cache the server only refreshes at startup or on an admin-config save. `--publish`
  warns when such a row exists; save any setting in Administration → System (or restart the
  service) to clear it.

### Before running it against production

- Take the campaign to staging first. Staging's database is disposable; production's is not.
- There is no undo for `--publish`. A published campaign can only be **archived**, and archiving is
  an admin-UI action. Create the draft, look at it at both breakpoints in the preview, then publish.
- `--replace-draft` deletes a draft and everything on it. Run it without the flag first and read
  which campaign id it names. The replaced draft's images are **not** deleted — nothing in the app
  reaps unreferenced `campaign_assets` rows or their files, whether they are orphaned from here or
  by removing a slide image in the admin UI — so each replacement adds roughly the deck's own size
  (~2.4 MB for the 2.0 deck) under `shared/data/campaign-assets/`. Harmless, but it does not shrink
  on its own.
- The assets are written by whoever runs the script. On a box where the service runs as a different
  account, check that the new files under `shared/data/campaign-assets/` are readable by the service
  user — an unreadable crop is a 404 the campaign modal papers over with its fallback artwork.

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

- Node.js 22.x (see `package.json` engines and `.nvmrc`)
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
{"status":"OK","draining":false,"activeStreams":0}
```

`scripts/deploy.sh` uses this endpoint two ways: it polls it after cutover to decide whether to roll
back, and — when `ALFYAI_API_SIGNING_KEY` is set — it posts to `/api/admin/drain` and then watches
`activeStreams` fall to zero before restarting, so in-flight chat streams are not cut mid-response.
Without the signing key it skips the drain and relies on graceful shutdown alone.

## Web Research Deployment

Web work runs through the app-owned `research_web` AI SDK tool (and `fetch_url`), which are only
registered when Parallel is configured. Deploy it this way:

1. Deploy the app code. `scripts/deploy.sh` fetches and archives `origin main`, so merge `dev` to
   `main` first, or use staging (`scripts/deploy-dev.sh`) when testing from `dev`.
2. Set `PARALLEL_API_KEY`. Parallel powers web search and page extraction for `research_web`,
   `fetch_url`, and Atlas. Without it, `research_web`/`fetch_url` are omitted from the tool surface and
   Atlas reports as unavailable.
3. Set `BRAVE_SEARCH_API_KEY` only when the separate `image_search` tool should be available.
4. Configure the primary Normal Chat model with `MODEL_1_BASEURL`, `MODEL_1_API_KEY`, and
   `MODEL_1_NAME`, or through `Settings > Administration > System`. The endpoint must expose an
   OpenAI-compatible chat-completions surface.
5. Keep `TEI_RERANKER_URL` configured if you want source and evidence reranking. Search still works
   without it, but diagnostics will show `sourceReranked: false` when reranking is unavailable or not
   confident.
6. Restart the AlfyAI process after changing environment variables.

Post-deploy checks:

- Ask for an exact page-backed value, for example a current price from a product URL.
- Ask for a PDF report with headings, a table, and a bar chart. It should create a successful
  file-production card; `unsupported_document_block` means the running app or document-source contract
  has drifted.
- In the `research_web` tool result diagnostics, expect `selectedSourceCount > 0` and
  `evidenceCandidateCount > 0`.
- For healthy pages, local Readability extraction should produce quality Markdown evidence.
- For prices, dates, availability, specs, and similar exact values, `exactEvidenceCandidateCount`
  should usually be greater than `0`.
- When TEI reranking is configured and confident, `sourceReranked` and `reranked` should usually be
  `true`.

## Operational Caveats

- If you bypass `scripts/deploy.sh`, run `npm run db:prepare` before starting the production server
  (`npm start` already runs it).
- Persist the `data/` directory across deploys so chats, drafts, uploads, and SQLite data survive
  restarts. Under `scripts/deploy.sh`'s release layout this lives at `shared/data/` and is symlinked
  into every `releases/<sha>/`, so no deploy rebuilds or removes it (see
  [Release layout](#release-layout)).
- Office/image normalization (and, for HEIC/HEIF/AVIF, the ImageMagick delegate support) is a
  requirement of **MinerU's own container host**, not of this app: `MINERU_API_URL` can point at a
  MinerU instance running anywhere, and the Node app never shells out to `libreoffice`,
  `ImageMagick`, `ghostscript` or `poppler-utils` itself. If you build or operate that container, see
  [docs/uploads.md](../docs/uploads.md#mineru-operations-host-requirements-for-a-custom-image) for
  the accepted-format list and the AlmaLinux/RHEL delegate setup.
- MinerU handles OCR natively in all backends; no separate OCR service is required.
- A sandboxed file-production run that does not actually write a file to `/output` returns an explicit
  error instead of a silent empty success.
- `produce_file` Python program mode depends on packages the deploy installs per release. If jobs fail
  with `ModuleNotFoundError`, or a deploy warns that old releases could not be pruned, see
  [The sandbox's Python packages, and root-owned release leftovers](#the-sandboxs-python-packages-and-root-owned-release-leftovers).
- Auxiliary services such as title generation and summarization can fail independently without
  necessarily blocking core chat.
- Admin configuration can override selected runtime values after boot; the environment remains the base
  layer, not always the final one.

## Upload Body Size

Production builds patch adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`.

You can still override it explicitly:

- `BODY_SIZE_LIMIT=100M` to match the current default
- a higher value if your deployment needs more headroom

Keep it at or above the application’s current 100MB upload cap so multipart requests are not rejected at the transport layer first.

## Routing coverage + sandbox infrastructure

Two extra host services back the `map_route` tool and the file-production sandbox. They are
installed once, as root, from a checkout of this repo:

```bash
sudo bash deploy/install-routing-infra.sh
```

- `alfyai-docker-proxy.service` — a filtered Docker API (tecnativa docker-socket-proxy) on
  `127.0.0.1:2375`. The app talks to it via `DOCKER_HOST=tcp://127.0.0.1:2375`, so the app user
  never needs docker-group (root-equivalent) access. Only containers/images/exec/start/stop/delete
  are allowed; volumes, networks, swarm, system and build are denied.
- `nominatim.service` — a self-hosted Nominatim geocoder on `127.0.0.1:8089`. The first start
  imports the Hungary extract (20–60 minutes); the routing regions directory is mounted at
  `/regions` so on-demand regions are added to the same database.

After the script finishes, add to `shared/.env` and deploy (or restart the app):

```
DOCKER_HOST=tcp://127.0.0.1:2375
GEOCODER_BASE_URL=http://127.0.0.1:8089
ROUTING_ON_DEMAND_ENABLED=true
ROUTING_REGIONS_DIR=/home/services/routing-regions
ROUTING_GEOCODER_IMPORT_CONTAINER=nominatim
ROUTING_LEGACY_REGION_ID=hungary
```

On-demand regions are managed from Settings → Administration → Routing coverage, or via
`/api/admin/routing-regions`. Each region runs in its own `alfyai-ors-<region>` container
(published on `127.0.0.1:8300-8399`), is stopped after `ROUTING_REGION_IDLE_MINUTES` without use
and restarted on demand.
