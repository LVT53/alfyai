# Changelog

All notable changes to AlfyAI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and AlfyAI follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

<!--
How to write entries.

Write for the people who run and use AlfyAI, not for whoever wrote the commit.
Say what changed for them, and why when that is not obvious from the change.
One plain sentence per item. No marketing adjectives, no emoji, no commit
subjects pasted in. Group items under Added, Changed, Fixed, Removed or
Deprecated, and put anything a self-hoster must act on under "Security and
operations". "Upgrade notes" is for instructions, phrased as instructions.
Add work under [Unreleased] as it lands and rename that heading on release.
-->

## [Unreleased]

Nothing yet.

## [2.0.0] - 2026-09-17

### Highlights

Every page redrawn on one layout. Every tool the assistant uses is one row in
the chat you can open. Atlas reports cite each figure where it stands.

### Added

- Maps and transit. Ask for a route by car, on foot, by bike, by public
  transport or a mix, and get a map card with turn-by-turn directions, or a
  journey with departure times, changes and platforms. Regions are built on
  demand, and `map_route` reports its actual coverage.
- Ten connectors you can add: Nextcloud, Immich, email over IMAP, Google, Apple
  iCloud, Plex, OwnTracks, GitHub, OneDrive and generic CalDAV. The first five
  accept writes; the rest are read-only for now. Each connection shows what it
  was granted and when it was last used.
- Six AI styles, chosen from the composer: Default, Brief, Thinking partner,
  Storyteller, Technical and Warm.
- A "Used" row in the assistant's footer, listing only what you chose for that
  turn — a skill, a search forced with `/web`, an Atlas job — and not what the
  model reached for on its own. Regenerating keeps the row.
- Composer commands, among them `/think`, `/web`, `/skill` and `$name`.
- An admin System screen of seven pages plus a read-only Diagnostics page, with
  fourteen settings moved out of environment variables into admin config, each
  stating when it takes effect; a sortable Users table; and a Campaigns editor
  built around the slide.

### Changed

- The home screen, composer and plus menu, Profile, Connections, Knowledge
  Base, Documents, the admin panes and the login page were rebuilt on one
  layout, with the same type, spacing and controls throughout. Skills, Atlas,
  files, images and quotes are one pill shape wherever they appear.
- Incognito is shown by a mask face on the avatar, composer and sidebar instead
  of a notice row.
- Every tool call in the thinking block is one row you can open: search, page
  reads, maps, files, memory, skills and the Python sandbox. Two follow-ups sit
  under each reply.
- The three-step reasoning depth ladder is replaced by one Thinking toggle,
  thorough or quick.
- Atlas reports are rebuilt to reason from an evidence bank. Corroboration is
  counted over the fact rather than over the citation, so citing one source
  twice no longer reads as agreement: green where two independent sources
  agree, orange for a single source, red where a figure is inferred. Source
  favicons are served by the app, not fetched by your browser, and a report
  carries a Limitations list and downloads as HTML, Markdown or PDF.
- Each tool's usage rules live on its own description, in both languages,
  naming the sibling tool to use instead. The catalogue is nineteen tools, held
  under a measured token budget by a test.
- Analytics counts a "message" as a message you wrote. Cost and tokens continue
  to count every call the platform made on your behalf.
- `read_generated_file` reads any file in the conversation, not only generated
  ones, with an offset window and a passage search. Asking for more of a
  document already in play re-serves it deeper, with no tool call.
- Deploys build into an immutable release directory and cut over by one atomic
  symlink flip, with a health check and rollback. In-flight chat streams are
  drained before the cutover.

### Fixed

- Python program-mode files work again: sandbox packages are installed for the
  interpreter the container actually runs, and a deploy verifies they import
  there. A file with no output type is refused at intake, not after the run.
- Multi-word document searches split on whitespace, not on a literal `\s`, so
  chunk ranking no longer treats a whole query as one token.

### Security and operations

- Rate limits on memory notes, activity events, home suggestions and provider
  re-checks.
- Artifact patches, activity events and file reads are scoped to their owner.
- The map tile proxy refuses non-image upstream responses.
- Dependency vulnerabilities reported by `npm audit` cut to a handful.

### Upgrade notes

<!-- verify before release: db backup, SESSION_SECRET hard-fail, login rate limit, security headers -->

- AlfyAI requires Node.js 22.x. Newer Node breaks the `better-sqlite3` native
  build. See `.nvmrc`.
- Refresh the production checkout once before deploying, so the app root picks
  up the new deploy script. As the deploy user, in the app root:
  `git fetch origin main && git checkout -B main origin/main`.
- Deploy with `scripts/deploy.sh`. It applies pending database migrations for
  you. Deploy to staging with `scripts/deploy-dev.sh` and verify there first.
- From this release the deploy copies the database into `shared/backups/`
  before it applies migrations, and keeps only the most recent copies.
- From this release the server refuses to start in production unless
  `SESSION_SECRET` is at least 32 characters; set it in `shared/.env` first.
  Connector credentials are encrypted with a key derived from it, so an
  instance that ran on the development default must also have every user
  reconnect their accounts.
- Repeated failed logins for one account are rate limited, so an account being
  guessed at stops answering for a while. Nothing to configure.
- Responses carry security headers. The Content-Security-Policy only reports
  what it would have blocked until `CSP_MODE` switches it to enforcing; read
  the reports before switching.
- Your `.env` and the `data` directory — database, uploaded files, map tiles,
  routing regions — live in `shared/`, which no deploy rebuilds or removes.

[Unreleased]: https://github.com/LVT53/alfyai/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/LVT53/alfyai/releases/tag/v2.0.0
