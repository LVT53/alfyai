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

### Changed

- Incognito is now chosen once, before a chat exists, and stays on for that
  chat's whole life. A mask button sits in the top-right corner of the new-chat
  page (and in the phone header); tapping it tints the stage, dashes the
  composer and replaces the greeting, and the chat it starts is incognito from
  its first message. What incognito means has not changed: the chat is saved
  and you can revisit it, but nothing from it is learned into memory, counted
  in analytics or used to personalise later replies.
- An incognito chat opens with a single "Off the record from here" mark above
  its first message, and the mask in the composer opens a card that says what
  incognito means for that chat and offers a new chat.

### Removed

- The incognito switch in the composer's "+" menu and in the mask's card. A
  chat can no longer be taken out of incognito, or put into it once it has
  started — start a new chat to be remembered again. The API refuses both
  writes.

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

- AlfyAI requires Node.js 22.x. Newer Node breaks the `better-sqlite3` native
  build. See `.nvmrc`.
- Refresh the production checkout once before deploying, so the app root picks
  up the new deploy script. As the deploy user, in the app root:
  `git fetch origin main && git checkout -B main origin/main`.
- Deploy with `scripts/deploy.sh`. It applies pending database migrations for
  you. Deploy to staging with `scripts/deploy-dev.sh` and verify there first.
- From this release the deploy backs the database up into `shared/backups/`
  before it applies migrations, keeping the newest 7 (`DB_BACKUP_KEEP`). A
  backup that fails **aborts the deploy before any migration runs**, leaving
  the previous release serving an untouched database; `DB_BACKUP_REQUIRED=0`
  downgrades that to a warning. The directory is `chmod 700` and the copies are
  `chmod 600` — they contain every conversation and every encrypted credential,
  so back them up and delete them like the database itself. Each successful
  backup prints its own restore command.
- From this release the server refuses to start in production unless
  `SESSION_SECRET` is at least 32 characters and is not one of the placeholders
  that ship in this repository; set a real one in `shared/.env` first with
  `SESSION_SECRET=$(openssl rand -hex 32)`. `npm run build` is deliberately
  unaffected, so a missing secret cannot fail a deploy at the build step — it
  fails at startup, where the deploy's health poll rolls the release back.
  Connector credentials are encrypted with a key derived from it, so an
  instance that ran on the development default must also have every user
  reconnect their accounts, and changing an existing secret has the same cost.
- Repeated failed logins are throttled, per account and per client address. It
  is a throttle, not a lockout: over the budget each attempt waits out an
  escalating delay (up to 8s) and only one runs at a time, but a **correct**
  password is still accepted and clears the budget, so nobody can lock an
  account by guessing at it. Nothing to configure. Optionally, if Apache is the
  sole ingress, set `ADDRESS_HEADER=x-forwarded-for` and `XFF_DEPTH=1` in
  `shared/.env` to switch the per-address budget on — without them every
  request looks like it came from the proxy's loopback address and only the
  per-account budget applies. Do not set them if the Node port is reachable
  directly: the header would be forgeable.
- Responses carry security headers. The Content-Security-Policy only reports
  what it would have blocked until `CSP_MODE` switches it to enforcing; read
  the reports before switching. `CSP_MODE` is an `.env` value read at startup,
  so `report-only` (the default) and `off` are both one restart away and need
  no redeploy.
- Your `.env` and the `data` directory — database, uploaded files, map tiles,
  routing regions — live in `shared/`, which no deploy rebuilds or removes.

[Unreleased]: https://github.com/LVT53/alfyai/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/LVT53/alfyai/releases/tag/v2.0.0
