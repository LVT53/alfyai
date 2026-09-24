# AlfyAI

AlfyAI is a self-hosted SvelteKit chat application for OpenAI-compatible AI workflows through the
Vercel AI SDK. It provides streaming chat with roughly 18 app-owned model-facing tools (web research,
routing/maps, file production, connected accounts, and more), a user-scoped knowledge base, local
judge-gated long-term memory ("Memory v2"), a Connections subsystem for linking external accounts, and
SQLite persistence — all in a single Node deployment.

## Stack At A Glance

- SvelteKit with Svelte 5 and Tailwind CSS 4
- `@sveltejs/adapter-node` for Node server deployment
- SQLite with `better-sqlite3` and Drizzle ORM
- Vercel AI SDK (`ai` v6) with OpenAI-compatible providers for Normal Chat
- OpenAI-compatible endpoints for chat, title generation, and optional context summarization
- Optional Hugging Face Text Embeddings Inference (TEI) endpoints for embeddings and reranking
- MinerU (Docker) for document/upload extraction and OCR
- Optional Sentry error monitoring and performance tracing

## Features

- **Streaming chat** over Server-Sent Events, with AI-generated conversation titles and project
  folders.
- **App-owned tools** — ~18 model-facing tools including web research and page fetch (`research_web`,
  `fetch_url`, when Parallel is configured), maps and routing (`map_route`), file production
  (`produce_file`, `run_python`), memory, image search, and connected-account tools. See
  [docs/architecture.md](docs/architecture.md#tools).
- **Atlas deep-research reports** — long-form, cited reports with selectable v1/v2/v3 pipelines. See
  [docs/atlas.md](docs/atlas.md).
- **Memory v2** — local, judge-gated long-term memory with no external memory service. See
  [docs/architecture.md](docs/architecture.md#memory-v2-local-judge-gated).
- **Connections** — link Google, Nextcloud, GitHub, IMAP, CalDAV, Immich, Plex, OwnTracks, and more,
  and expose their data to chat tools. See [docs/architecture.md](docs/architecture.md#connections).
- **Knowledge base and working documents** — file-backed uploads, a shared rich previewer, and
  version history. Uploads are extracted through MinerU; see [docs/uploads.md](docs/uploads.md).
- **Maps and routing** — inline map cards and self-hosted OpenRouteService routing with optional
  on-demand regions and GTFS transit. See [docs/routing.md](docs/routing.md).

## Quick Start (Local Development)

Requires **Node.js 22.x** (see `.nvmrc`).

```bash
npm install
cp .env.example .env
# edit .env — at minimum set SESSION_SECRET and your MODEL_1_* endpoint
npm run dev
```

Then create an initial account from the CLI:

```bash
# Creates a NORMAL user. The default credentials are admin@local / admin123,
# but the account role is "user" — the name is only a default, not an admin grant.
npm run seed

# To create (or promote) an ADMIN, use seed-admin with the --admin flag:
npx tsx scripts/seed-admin.ts --email=admin@example.com --password=secret123 --name="Admin User" --admin
```

There is no first-user auto-promotion — `npm run seed` never produces an admin. Once you can sign in as
an admin, ongoing account management lives in the app UI under `Settings > Administration > Users`
(create users, promote/demote admins, revoke sessions, delete users).

## Configuration

Configuration is environment-variable first, with selected values optionally overridden later in the
admin UI. The essentials:

- `SESSION_SECRET` — **required in production**: a server started with `NODE_ENV=production` refuses
  to boot without a real one (`openssl rand -hex 32`). It also derives the encryption keys for stored
  connection and provider credentials, so changing it makes those undecryptable. Outside production
  it falls back to an insecure built-in value and warns once.
- `MODEL_1_BASEURL`, `MODEL_1_API_KEY`, `MODEL_1_NAME` — the primary OpenAI-compatible chat model.
- `PARALLEL_API_KEY` — enables web research (`research_web` / `fetch_url`) and Atlas.
- `PARALLEL_FREE_MONTHLY_USD` — server-wide Parallel spend every calendar month is free for
  (default `5`). Calls past it are billed to the user who made them.
- `DATABASE_PATH` — SQLite location (default `./data/chat.db`).

The complete reference — every variable, default, and caveat — is in
[docs/configuration.md](docs/configuration.md).

## Development

```bash
npm run check   # Type check with svelte-check
npm run lint    # Lint with Biome
npm test        # Unit/integration tests (Vitest)
npm run build   # Production build
```

Node 22.x is required. `npm run build` runs the Vite build and then patches adapter-node so the default
`BODY_SIZE_LIMIT` becomes `100M`.

## Testing

- **Unit / integration:** Vitest (`npm test`). A guard test,
  `src/lib/server/services/no-honcho.test.ts`, enforces that the retired external memory substrate
  stays out of the code.
- **End-to-end:** Playwright (`npm run test:e2e`) covers critical browser flows such as login, chat
  streaming, conversations, and admin settings. Playwright runs set `PLAYWRIGHT_TEST=1`, and the
  conversation-title endpoint returns `null` in that mode so browser tests do not depend on an external
  title-generation service.
- **Atlas report quality:** `scripts/atlas-eval.ts` measures and compares Atlas pipelines against a
  live deployment. See [docs/atlas.md](docs/atlas.md#report-quality-evaluation-scriptsatlas-evalts).

## Deployment

`scripts/deploy.sh` builds each deploy into its own immutable `releases/<sha>/` directory and cuts the
live service over with a single atomic symlink flip, then restarts the systemd unit and polls
`/api/health` (rolling back on failure). Every change deploys to **staging** first
(`scripts/deploy-dev.sh`) and is verified there before production. For host-managed `adapter-node`
runs, `npm start` runs `npm run check:migrations && npm run db:prepare && node build`, applying pending
Drizzle migrations before serving. Full runbook, release layout, staging flow, and operational caveats
are in [deploy/README.md](deploy/README.md).

## Architecture

AlfyAI runs as a single SvelteKit application with server routes, client UI, and SQLite persistence in
one repository. Server hooks validate sessions, load config overrides, and start optional schedulers; a
shared chat-turn pipeline handles request parsing, model execution over the Vercel AI SDK, tool calls,
memory/context updates, and persistence. Subsystems (Memory v2, Connections, MinerU extraction, maps
and routing, Atlas) sit behind server service boundaries. The full picture, with links to the relevant
ADRs, is in [docs/architecture.md](docs/architecture.md).

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — what changed in each release, and upgrade notes
- [docs/configuration.md](docs/configuration.md) — complete environment-variable reference
- [docs/architecture.md](docs/architecture.md) — architecture and subsystems
- [docs/atlas.md](docs/atlas.md) — Atlas deep-research pipelines, tuning, and evaluation
- [docs/routing.md](docs/routing.md) — maps, `map_route`, on-demand regions, and GTFS transit
- [docs/uploads.md](docs/uploads.md) — MinerU extraction, accepted formats, and host setup
- [deploy/README.md](deploy/README.md) — deployment runbook and operations
- [docs/adr/README.md](docs/adr/README.md) — architecture decision records
- [AGENTS.md](AGENTS.md) — agent-facing codebase guide
