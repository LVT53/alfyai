# Deploys cut over atomically between immutable release directories

Proposed. AlfyAI will deploy by building each release into its own immutable `releases/<git-sha>/`
directory and cutting the live service over with a single atomic `current` symlink flip, instead of
mutating the one live checkout in place. Durable state — the SQLite database, uploaded files, and
the environment file — lives in a shared directory that no deploy ever rebuilds or removes.

## Why

The current `scripts/deploy.sh` mutates the serving directory while it serves. Step 5 runs
`rm -rf "$APP_DIR/build"` *before* the rebuild and restart, so for the ~2 minutes a build takes,
the running process 404s on static chunks and fails hot-path dynamic `import()`s against a
half-empty `build/`. `git pull` and `npm install` also mutate the live tree. There is no rollback:
the previous build is gone. Every slice in the deepening programme becomes a deploy, so this window
is paid repeatedly.

An immutable-release layout removes the window: the new release is built to the side, and the live
service only ever moves by re-pointing one symlink and restarting. Rollback becomes re-pointing the
symlink at the previous release.

## Verified production reality (2026-08-15, on the box)

The repo's `deploy/*` templates were wrong; this ADR is written against what is actually deployed.

- App root is **`/home/alfydesign/apps/langflow-chat`**, service user **`alfydesign`**, systemd unit
  **`langflow-chat.service`** (`WorkingDirectory` and `ExecStart` both under that root, port 3001).
  The checked-in `deploy/langflow-chat.service` template (`/opt/alfyai`, user `alfyai`) is corrected
  to match, and gains an explicit `TimeoutStopSec` (the live unit sets none).
- The live unit has **no `TimeoutStopSec`** and **no `SHUTDOWN_TIMEOUT`** (the latter is D2's job).
- **`data/` is 650 MB of durable state** — `chat.db` (124 MB), `chat-files/` (153 dirs of generated
  files), `campaign-assets/`, `avatars/`, `knowledge/`. **`.env`** holds config and secrets. Both are
  `.gitignore`d, so a fresh release checkout does not contain them. They MUST be shared, never
  per-release, never rebuilt.
- Disk: apps live on `/home` (1.7 TB free). Three retained releases (~950 MB node_modules + ~45 MB
  build + source each) are a rounding error.
- `npm ci` **fails repo-wide** at `main@1cdf51a3` (committed lockfile drift: `protobufjs 7.6.0` vs
  `7.6.5`). Prod works because `deploy.sh` uses lenient `npm install`. The new script therefore tries
  `npm ci` and falls back to `npm install` on failure, so it becomes reproducible for free once the
  lockfile is repaired without breaking deploys until then.

## The layout

```
/home/alfydesign/apps/langflow-chat/          # app root (unchanged path)
├── shared/
│   ├── .env                                  # the one config/secret file
│   └── data/                                 # the DB + uploaded files (650 MB, durable)
├── releases/
│   ├── <sha-N-1>/                            # immutable; data & .env are symlinks into ../../shared
│   └── <sha-N>/
└── current -> releases/<sha-N>               # the only thing a cutover moves
```

Each release directory is a full checkout with its own `node_modules/` and `build/`, plus two
symlinks created before it goes live: `data -> ../../shared/data` and `.env -> ../../shared/.env`.
`DATABASE_PATH` stays the relative `./data/chat.db`; with `WorkingDirectory` pointed at `current`
(which resolves to `releases/<sha>`), it resolves through the symlink to the shared DB. The systemd
unit references the stable `current` path — `WorkingDirectory=.../current`,
`ExecStart=/usr/bin/node .../current/build/index.js`, `EnvironmentFile=.../current/.env` — so a
cutover never edits the unit.

`app-version.ts` reads `package.json` via `resolve(process.cwd(), "package.json")`. `process.cwd()`
is the resolved physical release path (Node's `getcwd` resolves the `current` symlink), and
`package.json` is present in every release, so version resolution is correct per release. This ADR
adds a test asserting that under a symlinked working directory rather than changing the code.

## The deploy sequence (per release)

1. Materialize the new release into `releases/<sha>/` (checkout/rsync) — never touching the live one.
2. `npm ci || npm install` **inside `releases/<sha>/`**.
3. Symlink `shared/.env` and `shared/data` into `releases/<sha>/`.
4. `npm run build` inside `releases/<sha>/`.
5. `npm run check:migrations && npm run db:prepare` from `releases/<sha>/`, **after build, immediately
   before the flip** (today it runs at step 4, before the build).
6. **Flip**: `ln -sfn releases/<sha> current.tmp && mv -Tf current.tmp current` — an atomic rename.
7. `systemctl restart langflow-chat.service`.
8. Poll `/api/health`; on failure, **roll back** (step below) and stop.
9. Prune `releases/` to the last 3.

Draining the in-flight streams before the restart is D2's addition; D1 leaves the restart as-is.

## Migration ordering — expand/contract

`db:prepare` runs against the **shared** DB before the flip, so for the interval between migration
and restart the still-running **old** code sees the **new** schema, and a rollback runs the old code
against the migrated DB. Both are safe only if migrations are **additive (expand)**: new nullable
columns and new tables that old code ignores. A migration that **drops or renames** a column in the
same release as the code change breaks the old process during the flip window and breaks rollback,
and is rejected in review (this is also a programme halt condition). Destructive **contract**
migrations ship in a *later* release, after no deployed code references the old column.

## Rollback

Keep the last 3 releases. To roll back: `ln -sfn releases/<previous-sha> current` (atomic) and
restart. Because migrations are additive, the previous release runs correctly against the
already-migrated shared DB. This is documented and exercised once on staging as part of D1.

## One-time migration from the flat layout

The existing environments serve directly from the flat checkout. Converting to this layout is a
one-time, service-stopped operation per environment (staging first, then production), distinct from
the ongoing `deploy.sh`:

1. Stop the service (brief downtime — the only downtime in the whole change).
2. `mkdir shared`; `mv .env shared/.env`; `mv data shared/data` (a same-filesystem rename, instant).
3. Create `releases/<current-sha>/` from a fresh build, with `data`/`.env` symlinks into `shared`.
4. `ln -sfn releases/<current-sha> current`.
5. Update the systemd unit to the `current` paths + `daemon-reload`.
6. Start the service; verify health and one real turn.

On staging this runs under D1's normal staging-first flow and is fully reversible (disposable DB).
On production it is gated behind a green staging soak and a dry run, and is itself reversible by
restoring the unit and pointing it back at the flat `build/`.

## Considered Options

- Keep mutating the live checkout (today). Rejected: the rebuild window and no rollback are the
  whole problem.
- Atomic `build/` swap only (`mv build build.old && mv build.new build`), no release dirs. Rejected:
  it closes the rebuild window but gives no rollback target and no isolation of `npm install`; the
  acceptance requires retained releases and symlink rollback.
- Full blue/green with two live processes. Deferred to D2's ADR amendment and out of scope here:
  `ensureAtlasWorker` recovers *all* running jobs assuming the prior process is dead, and
  `interval-job.ts` has no leader election, so two live processes would double-run background work.

## Consequences

- `scripts/deploy.sh` is rewritten to the sequence above; `scripts/deploy-dev.sh` is updated in the
  same change to stay structurally identical (branch `dev`, `langflow-chat-dev.service`).
- `deploy/langflow-chat.service` is corrected to the real path/user, pointed at `current`, and given
  an explicit `TimeoutStopSec`. `deploy/README.md` and `README.md` document the release layout,
  rollback, and the expand/contract policy.
- `npm start` still runs `check:migrations && db:prepare` (AGENTS.md requirement) — unchanged.
- `/api/health` is unchanged in this slice (D2 extends its body).
- Rollback is a symlink flip; the last 3 releases are retained.
- D2 amends this ADR with the draining contract (drain before the step-7 restart) and states its
  relationship to ADR-0041.
