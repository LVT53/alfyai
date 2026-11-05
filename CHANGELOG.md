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

### Added

- Asking Alfy to save a way of working as a skill ("make this a skill") now
  drafts one: the reply shows a card offering Save private skill or Dismiss, and
  the skill exists only after you save it.
- A reply that drafts a skill shows that card instead of the "add to
  instructions" offer, so one turn asks you to keep the same thing only once.
- Alfy can stop in the middle of a reply to ask you one to three questions with
  answers to click, and the same reply carries on from your answer; you can also
  type your own answer, leave the choice to Alfy ("Decide for me") or close the
  question.
- A chat that is waiting for your answer shows a question mark in the sidebar,
  keeps the question on screen after a reload and on your other devices, and
  takes no new message until you answer or close the question.

### Changed

- A message you send while AlfyAI is being updated now waits instead of failing:
  the message shows "AlfyAI is being updated. Waiting for it to come back..." and
  is sent by itself once the update is done, so you do not press anything. Stop
  ends the wait and puts your words back in the message box, and leaving the chat
  keeps them in its draft. If the update is still running after 8 minutes, the
  message stays with Retry and says to try again in a few minutes.
- A reply that an update cut off now says so ("AlfyAI was updated while this
  reply was being written, so it was cut off") and offers Retry, instead of
  blaming the model provider. If the server finished the reply meanwhile, it
  appears with no error. The reply is never sent again unless you press Retry.
- The "Update available" notice now comes up within seconds of the update instead
  of up to a minute later, and it waits until a message that is waiting for the
  update has been sent, because refreshing the page would lose that message. The
  "update in progress" banner now shows as soon as a message of yours meets the
  update, without a reload or switching tabs, and says what happens: a reply that
  is running finishes first, and a new message is sent when the update is done.
- Editing a message while AlfyAI is being updated now says so ("Send this edit
  again when it's done") instead of saying another reply is running, and it does
  so during the restart too, when it used to say the check had failed.
- A regenerate, "Answer now" or Retry pressed while AlfyAI is being updated now
  waits like a new message, instead of starting a reply the restart then cuts,
  and Stop brings the reply you had back. A deep research (Atlas) request that
  meets the restart waits and is sent again by itself, and starts once.
- A phone that loses its signal, and a tab that is a deploy behind, are no longer
  taken for an update: they get the error they always got. A reply cut off while
  the server was only getting ready to restart, or just after a new version went
  live, is joined again when the server still runs it, instead of being waited
  for or blamed on the update.
- If you leave a chat while a message waits for the update, its words are saved
  as that chat's draft even if the save meets the restart: it is tried again
  every 3 seconds until it lands, for up to 8 minutes, and so is whatever you
  type in that chat meanwhile. If you come back to the chat before the words
  have landed, they are in the message box, and the "Update available" notice
  waits until they have landed.
- Editing a message you sent now happens in the message box at the bottom, not
  in a box inside the message: the pencil puts the text there, the original
  steps back, and what you were writing comes back when you send or cancel. If
  replies after it will be deleted, the box says how many.
- Moving around a long chat is calmer: a short ruler on the left with one orange
  mark for where you are replaces the row of tiny marks, and hovering or
  pressing it lists every turn so you can jump to one. In a narrow chat, such as
  a phone, a small "11 / 30" pill appears once you scroll up and opens the same
  list.
- Chat text is now set in the app's sans-serif face, 14px on a desktop and 15px
  on a phone, with smaller headings, the normal text colour and no backticks
  around inline code.
- Documents, the panel around them, Version previews, the login fields and the
  Knowledge memory cards are now set in the same sans-serif face as the chat, so
  the serif is left to a page's own top title: the Home and project greeting,
  and the titles of Settings, Knowledge, the login page and the error page.
- Apps that Alfy makes are now set in sans-serif throughout, headings included,
  to match the rest of the app; their headings used to be serif. An app made
  earlier keeps its look until you ask Alfy to change it.
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
- Follow-up suggestions, the rail headline and a chat's generated title are
  written in the language you write in, which the model names once after each
  reply, so an email you asked for in another language, or a request for the
  replies in one, does not change it; the short lines shown as Alfy thinks
  follow the interface language.
- Each turn now logs the interface language, the conversation's language and
  what the reply reads as (without any of its text), and the admin stability
  snapshot counts replies that read as Hungarian for people writing English.
- Changing your password signs you out on every other device, and the Profile
  card says so. The device you changed it on stays signed in.
- The skill draft card shows what the skill will do and a few ways to ask for
  it, and once saved it links to the skill in Settings; the question and
  source chips left over from skill sessions are gone.
- Changing your email address asks for your current password, and a wrong one
  counts against the same limit as a wrong password at sign-in. Changing your
  name asks for nothing.

### Fixed

- Bullet and numbered lists in a Document now show their bullets and numbers.
- Alfy no longer answers an English message in Hungarian because a word list
  guessed the language wrong: the model reads the message and replies in its
  language, and a request for a particular language, in the message or in your
  instructions, is followed.
- A sign-in now ends on the server when its time is up. Before, only the
  browser's cookie ended it: the expiry was stored in milliseconds in a column
  read as seconds, so a copied cookie outlived it.
- A reply that drafts a skill now always keeps its draft. About one turn in
  four lost it: the reply's cleanup took the draft for leaked tool output when
  the stream happened to split it in one particular place.
- The skill draft card appears as soon as the reply ends, not only after the
  chat is reloaded.
- A drafted skill is still read when the model leaves off the block's closing
  tag.
- Manage skills in the composer's skill picker opens the Skills manager, not
  the Profile page.
- Answers based on a web search link their sources again. Since late September
  about half of them linked none, because nothing told the model how to cite.
- A draft you type while a reply is coming now survives: it was deleted when the
  reply landed, or when you pressed Regenerate or a follow-up suggestion, and
  was gone after a reload or a switch to another chat.
- Editing a message that had pictures attached, or boxes drawn on a picture, now
  sends them again with the new words; before, the edited message lost them.
- Retry after a message fails now sends that message again, with its files and
  pictures, and leaves every earlier reply alone; Retry after a failed
  Regenerate now gets the reply instead of failing again, with its skill and
  web search; and an edit is checked before anything is deleted (including
  another reply still running), so a message that cannot be sent no longer takes
  the original and its replies with it.
- Retry no longer sends a message twice after a dropped connection: when the
  server had already finished the turn, Retry loads it instead, and when the
  server is still running it, Retry joins it.
- The words in the message box now stay with the chat you typed them in: moving
  to another chat no longer carries them along or loses them, a message put
  back after Stop or a failure joins what you have typed since instead of
  replacing it, words you have already sent no longer come back while a
  file, picture or report is being made, a message waiting behind a running
  reply is kept in its chat when you go to another chat or leave the page, and
  a draft that holds only a file keeps it through a reload.

### Removed

- The incognito switch in the composer's "+" menu and in the mask's card. A
  chat can no longer be taken out of incognito, or put into it once it has
  started — start a new chat to be remembered again. The API refuses both
  writes.

### Security and operations

- The deploy now waits up to 3 minutes for running replies to finish before it
  restarts the server (it used to wait 2 minutes), prints how many are still running every 30
  seconds, and says how long it waited if it gives up. `DRAIN_TIMEOUT_SECONDS`
  sets it (`0` does not wait); a message waiting for an update gives up after 8
  minutes, a time sized for the 180-second default, so do not raise it without
  raising that too. While it waits, new messages (and a regenerate) are turned
  away with the reason `draining` and wait in the browser, so the site stays up
  for everyone; a reply still running at the end is cut by the restart.
- If a deploy stops after it started the drain and before the restart, it now
  undoes the drain on exit; before, the server went on turning new messages away
  until someone restarted it by hand. The deploy also takes only a health answer
  that says the server is not draining for the new server, so the old process
  that is still shutting down does not pass for it.
- Session tokens are stored as SHA-256 hashes, so a copy of the database or a
  backup holds no session anyone can use.
- A five-minute auth sweep deletes sessions that have ended, any row a deploy
  leaves with an impossible expiry, expired two-step sign-in attempts and
  abandoned setups. It no longer rides on the memory maintenance pass.
- `scripts/reset-two-step.ts` (`npm run auth:reset-two-step -- --email <address>`)
  is the recovery path for a lost phone with lost backup codes and for a changed
  `SESSION_SECRET`, which makes stored two-step secrets unreadable.
- Downloading your data, clearing your memory or workspace, and deleting your
  account count wrong passwords against the same limit as changing your email
  or password. Until now a password could be guessed at on those four without
  one.
- If you run AlfyAI behind Apache with your own site file, proxy
  `/api/chat/retry` and the answer route
  (`/api/conversations/<id>/questions/<id>/answer`) unbuffered, as
  `/api/chat/stream` is (see `deploy/apache-site.conf`); otherwise a Retry and a
  carried-on reply arrive in one piece.

### Upgrade notes

- Everyone signs in once after this release: its migration empties the
  `sessions` table, because stored sessions change form. Tell the people who
  use your server before you deploy. Anyone who signs in during the couple of
  minutes between the migration and the restart signs in once more.

## [2.0.0] - 2026-09-17

### Highlights

Every page redrawn on one layout. Every tool the assistant uses is one row in
the chat you can open. Atlas reports cite each figure where it stands.

### Added

- Two-step sign-in is now available for every account, and optional:
  authenticator-app codes at sign-in plus ten one-time backup codes. It is
  turned on and off in Settings > Profile > Account with a current code, and an
  admin can reset it for someone else from the Users pane. "2FA" does not appear
  in the interface.
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
