# Feature 3 · Computers — implementation spec

Owner decisions 2026-10-11 and 2026-10-12, recorded in [ADR-0067](../adr/0067-alfy-works-on-your-computers-through-an-outbound-agent.md). That ADR takes back the "desktop, terminal and platform integration" item [ADR-0064](../adr/0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md) had parked.

- **Research** behind the decisions (prior art, Windows sandboxing, installing without paid signing, the deepseek-harness approval study, code constraints, srt facts confirmed in review): [`claude-at-home-3/research.md`](./claude-at-home-3/research.md).
- **Design target:** [`claude-at-home-3-computers-mockups.html`](./claude-at-home-3-computers-mockups.html).

Status: the design was approved section by section in conversation. An Opus peer review on 2026-10-12 raised 29 findings, all folded in below. The owner's answers to the review's questions are in §10. Nothing is built yet.

## 1. What this is

A person pairs their own computers (macOS, Linux, Windows 11) with their AlfyAI account. From any chat, on any device including a phone, Alfy can then work on those computers:

| Job | Examples |
|---|---|
| Harness work | Read, search and edit code; run tests and builds; commit with git; fix what fails |
| Everyday chores | Find, move, rename and tidy files; bring a file from the computer into the chat; save a file Alfy made onto the computer |
| Reach-through | Use the computer's network for web addresses and local-network web panels (a NAS, a printer) the person allows |

Not in v1:
- signed-in tools: pushing, `gh`, `ssh` (§2, item 8);
- screen control (seeing and clicking the desktop);
- long-running background processes (dev servers, watchers);
- phones as targets;
- Windows 10.

Sharing a computer with another account is a hard no.

## 2. Decisions (do not reopen)

1. **Computers are the targets; phones are where you chat and approve.** iOS and Android can't host a program that runs commands like this.
2. **Remote first.** The person is usually not at the computer, so every approval happens in the chat, and a waiting approval sends a browser push notification (item 21).
3. **Our own agent dials out.** A small program on the computer, **alfy-remote**, opens one outgoing HTTPS connection to AlfyAI and keeps it open:
   - server-sent events go down, POST requests come up;
   - it's the chat stream's mechanism, so it fits adapter-node and Apache with no WebSockets;
   - nothing on the computer listens for connections.

   Rejected:
   - **SSH from the server:** the server would hold a key to every computer, routers would need open ports, and nothing on the computer would enforce limits.
   - **Relaying to OpenCode or MCP servers, rejected for now:** their permissions assume someone at the keyboard, and the floor would live in code that changes under us. A later "hand this task to OpenCode on my Mac" stays possible.
4. **alfy-remote is plain JavaScript on Node, installed with one terminal paste.**
   - The installer brings an official, signed Node runtime into one folder.
   - No native app, no paid code signing, and no native helper binaries of our own. Windows Smart App Control blocks unsigned native code but does not inspect scripts that Node runs.
   - Third-party binaries the fences need are fetched from their official releases with pinned SHA-256: ripgrep for srt on macOS and Linux, and Microsoft's signed `wxc-exec.exe` on Windows.

   Rejected:
   - **An unsigned native app:** everyone clicks past an OS warning.
   - **A browser tab:** no commands.
   - **Docker:** Linux commands only.
5. **macOS, Linux and Windows 11 at launch. Windows 10 is out of scope.**
6. **Safety is one checker plus one fixed floor.** The checker is the only part that gets tuned. The floor is set once on the computer and holds when the checker is wrong.

   Rejected:
   - **Per-step approvals:** dozens of taps per task.
   - **A five-layer design** with snapshots, per-task mandates and a separate "your words" layer: too many moving parts.
   - **A checker alone:** a classifier misses, and Anthropic reports 17% of overeager actions for its own.
7. **The floor** (§6.2) is enforced on the computer by the operating system's sandbox and cannot be changed from the chat:
   - only the chosen folders;
   - secrets unreadable;
   - network closed by default and opened per step to the destination the checker approved, with local services on the computer out of reach (item 9);
   - AlfyAI's own server and the inference box never reachable;
   - credentials stripped from commands' environment;
   - well-known code-runs-later files read-only;
   - alfy-remote's own files out of reach.
8. **No signed-in tools in v1.**
   - **Why:** pushing, `gh` and `ssh` need the person's keys, tokens or agent sockets. The floor never exposes those, and on Linux allowing one Unix socket allows them all, the Docker socket and D-Bus included, which is a full escape.
   - **What still works:** git commits locally; pushing, `gh` and `ssh` stay with the person.
   - **Later:** the fence's proxy could add a token to requests for one named host (srt's credential injection), so Alfy never sees it.
9. **Local services on the computer are out of reach in v1**, except a `127.0.0.1:<port>` address a step names and the checker approves (HTTP only). A command may still start and use its own local servers inside the step, such as a test server.
10. **Fences:** Anthropic's sandbox-runtime (srt) on macOS and Linux, Microsoft's MXC container on Windows 11. Both are their vendors' code; we pin versions and feed them one shared policy. srt's built-in protections apply on every platform (§6.2).
11. **The checker** (§6.3) is one model call per step that isn't a plain read inside the chosen folders. It sees only what the person typed and the step, quoted as data, and answers allow, ask or block with one plain-language sentence.
12. **The ask is the computer line opened up**, docked above the composer. It shows:
    - the checker's question and sentence;
    - one line of facts the server computed;
    - the exact command, collapsed;
    - Skip and Allow.

    There is no timeout.
13. **A chat gets a computer through the composer's Connections control** ([ADR-0044](../adr/0044-connections-ui-redesign.md)). Computers are rows in its account list, like accounts. Alfy picks the computer and working folder from the person's words, and asks in the chat when that's unclear. There is no new composer button.
14. **A live computer line above the composer** shows which computer and folder a chat is using and what Alfy is doing. It's the "status line" of the design conversation, renamed because AlfyAI already has thought-step status lines. Rejected: a pill inside the composer, the chat header, a composer glyph, or the work card alone.
15. **Computers live in Settings → Connections** as their own group, with the compact rows and centered detail window of ADR-0044.
16. **Pairing starts in the signed-in session** and is confirmed with the same three words on both screens. Folders are chosen on the computer and can only be changed there. **The AlfyAI server and the inference box can never be paired.**
17. **Cloud models are allowed**, behind a one-time notice like the Cloud-Connector Warning, with its own acknowledgement. The server enforces it (§4.5).
18. **Not in incognito chats.** Every step goes into a security log that is always kept.
19. **No per-person switch, but one server-wide off switch for emergencies.** Turning `COMPUTERS_ENABLED` off (admin config, effect *live*, default off) has three effects at once:
    - the computer tools leave every turn;
    - agent links are told to stand down;
    - Settings shows that an administrator turned computers off.

    The feature lives on dev until the owner moves it to prod.
20. **An offline computer stops the step.** Nothing is queued for later.
21. **A waiting ask sends a browser push notification** through the existing `browser-push.ts` (as Atlas does), so a person away from the chat knows Alfy is waiting.
22. **One step at a time per computer.** Steps from other chats wait their turn. srt's per-command network lists attribute traffic; they do not separate concurrent commands.
23. **Agent updates carry our own Ed25519 signature.** The key is never on the server, the public key is pinned in alfy-remote, and older versions are refused.
24. **Distribution: only from the person's own AlfyAI server.** No npm for now.
25. **Prerequisite:** today's model-output leak channels are closed first, as their own task:
    - markdown images to any `https:` address;
    - the favicon proxy;
    - `fetch_url` with any URL;
    - `csrf.trustedOrigins: ['*']`.

## 3. Vocabulary

Added to CONTEXT.md in slice 0.

- **Computer**: one paired machine; one row per pairing.
- **alfy-remote**: the program on the computer, and its command. Code calls it the agent; user-facing copy always says "alfy-remote".
- **Agent link**: the server end of one computer's connection.
- **Chosen folders**: the folders picked on the computer. Nothing outside them, apart from read-only system and toolchain paths, exists for Alfy.
- **Binding**: which computer and working folder a chat is using, persisted per conversation.
- **Working folder**: the folder a chat works in, inside the chosen folders.
- **Step**: one action Alfy proposes on a computer: a file action, a command or a transfer.
- **Floor**: the fixed rules alfy-remote enforces through the OS sandbox (§6.2).
- **Checker**: the server's one model call per step (§6.3).
- **Ask**: a step the checker sent to the person.
- **Computer line**: the line above the composer that names the computer and folder and says what Alfy is doing. It opens into the ask. It is distinct from the thought-step status line (`short-local-text.ts`).
- **Typed text**: the parts of a person's message they typed themselves in this conversation (§6.3). Only typed text grants permission.
- **Protected hosts**: every address no step may reach (§6.2).

## 4. The experience

Every string ships in English and Hungarian. Icons come from Lucide (the mockups use Tabler stand-ins). Dark mode follows the app's tokens.

### 4.1 Adding a computer

Settings → Connections → Computers → **Add a computer** opens a centered dialog:
- platform tabs: **macOS · Linux** and **Windows**;
- one line to paste:
  - macOS and Linux: `curl -fsSL <server>/api/computers/install | sh -s <code>`;
  - Windows: `$env:ALFY_REMOTE_CODE='<code>'; irm <server>/api/computers/install.ps1 | iex`;
- **the code** is single-use, made by this signed-in session, and expires after 10 minutes. Claims are rate-limited per code and per address;
- **once the computer claims the code**, the dialog shows its name and OS, then three words, with **Cancel** and **They match**. Both sides compute the words as `H(code ‖ alfy-remote's public key ‖ a server nonce chosen after the claim)`, mapped to one fixed word list that both screens use whatever the UI language. A swapped key gives different words. Words don't stop an attacker who reads them aloud to the person, which is why the dialog names the claimed computer.

On the computer, the installer:
1. **Checks it isn't running on a protected host.** It refuses to pair when any of its own interface addresses is a protected host, and the server likewise refuses claims arriving from its own addresses.
2. **Downloads the official Node runtime** and checks it against a SHA-256 pinned in the installer itself; on Windows it also checks the Authenticode signer.
3. **Installs alfy-remote** into `~/.alfy-remote` (Windows: `%LOCALAPPDATA%\alfy-remote`).
4. **On macOS and Linux, fetches ripgrep** from its official release (pinned SHA-256) when `rg` is missing. **On Linux, checks for bubblewrap and socat.** Without them the computer is file-only, and the installer says which packages to install.
5. **Asks:** "Pair this computer with levente@… (Levente) on `<server>`?", shows the same three words, and waits for `y`. Answers are read from `/dev/tty`, because stdin is the piped script.
6. **Asks which folders Alfy may use.** It suggests Projects, Documents and Desktop (the ones that exist), unticked; the person ticks what Alfy may use, or adds a folder.
   - **Refused folders:** the home folder itself, system folders, folders of startup items (LaunchAgents, autostart, the Windows Startup folder), and any ancestor of secret locations or of alfy-remote's own folder (for example `~/Library`, `~/.config`, `%APPDATA%`).
   - **macOS privacy prompts:** it touches each chosen folder once while the person is there, so the one-time prompts for Documents, Desktop and Downloads appear now, not later on an empty desk.
7. **Captures the person's login-shell PATH** once, so commands find their tools later.
8. **Registers itself to start at login** and connects.
   - macOS: a LaunchAgent; macOS shows a "background item added" notice.
   - Linux: a systemd user unit, with `loginctl enable-linger` on headless machines. Without systemd it says to keep `alfy-remote run` going in a terminal or tmux.
   - Windows: `HKCU\…\Run` with a hidden PowerShell start; a brief console flash at login is accepted.

The script body is wrapped in a function that runs only after the whole script has downloaded, so a cut-off download runs nothing.

The computer then shows as Online in Settings.

alfy-remote's commands: `alfy-remote status`, `alfy-remote pause`, `alfy-remote resume`, `alfy-remote folders`, `alfy-remote logs`, `alfy-remote remove`, and `alfy-remote run` (foreground).

### 4.2 Settings

The Computers group lists each computer with:
- an icon for its kind;
- its name;
- OS and folder count;
- status: Online, Offline · last seen, or Paused;
- a ⋯ menu: Pause or Resume, Rename, Remove.

A last row adds a computer.

The detail window shows:
- name, OS, status and the alfy-remote version;
- the chosen folders, read-only, with "Changed only on the computer: `alfy-remote folders`";
- **Available in chats**, on by default as with other connections;
- the most recent steps;
- **Pause**, and **Remove computer** (with a confirm).

When `COMPUTERS_ENABLED` is off, the group says an administrator turned computers off.

### 4.3 In a chat

- **The Connections control.** Computers appear as rows in the composer's Connections list, and can be switched off for a chat like accounts. The plug is enabled when the person has any computer, even with no accounts. The server takes the intersection, as `resolveActiveCapabilities` does for accounts.
- **Picking a computer.** Alfy may use any computer that's switched on for the chat and Available in chats. It picks the computer and working folder from the person's words; when that's unclear it asks in the chat, the way it already settles multi-account choices.
- **The binding.** The chosen computer and working folder are persisted for the chat. **Setting or changing the working folder is a step:** the checker allows it only when the person's typed words name that folder. Otherwise it asks. That way, an injected instruction can't move the work into `~/Documents`.
- **One at a time.** A chat works with one computer at a time. Switching computers is a step of its own, and the computer line changes with it. A file goes from one computer to another through the chat (`to_chat`, then `to_computer`).
- **The computer line.** From the first step it sits above the composer, separate from it. It shows the computer, the folder, and the current state:
  - *working*: a short live description built from the step itself, never from model prose;
  - *waiting for the computer*: the computer is busy with another chat's step;
  - *idle*;
  - *offline*;
  - *paused*;
  - *waiting for you*.
- **Tapping the computer line** gives:
  - **Change folder or computer:** a picker sheet of the person's computers and their chosen folders. Picking one is a typed choice, so it counts as named.
  - **Pause.**
  - **Let go:** the chat stops using the computer.
- **The work card.** Each turn's transcript shows the computer and folder, with one line per step, built deterministically from the step. A blocked step is always shown, with **Why**. Its reason is stored in the security log and shown to the person only, never to Alfy.

### 4.4 The ask

When the checker says ask, the computer line opens:
- **Header:** computer · folder · *Waiting for you*.
- **The checker's question and sentence**, for example "Delete 3 screen recordings (18 GB)?" and "They'd be gone for good, not moved to the Trash."
- **A facts line the server computes from the step**, never from model text. For example: "Deletes 3 files · 18 GB · nothing leaves the computer".
- **The exact command**, collapsed, in monospace.
- **Skip** and **Allow.**

Keys:
- With an empty composer, Cmd/Ctrl+Enter allows and Esc skips.
- The keys arm one second after the ask appears, so a reflexive second send can't approve an unseen step.
- They work only while focus is in the composer or the ask. Enter alone does nothing.
- With text typed in the composer (placeholder "Or tell Alfy what to do instead…"), Cmd/Ctrl+Enter skips the step and sends the text as the person's instruction.

Waiting and afterwards:
- **No timeout.**
- **A browser push notification** goes out when the ask appears.
- **It survives a refresh.**
- **The chat shows a dot in the sidebar**, computed from server state, so every device shows it.
- **A repeat of a step the person skipped** is blocked until their next typed message.
- **After the answer**, the work card keeps one quiet line: *you allowed it* or *you skipped it*.

**Accessibility.**
- State changes are announced politely (`aria-live`), with nothing announced for the live working text.
- The command is a disclosure button.
- Focus never jumps into the ask uninvited.

### 4.5 Cloud models

The first time a turn would involve a computer with a cloud model, a notice like the Cloud-Connector Warning explains that file contents and command output will go to that provider. The acknowledgement (`users.computer_cloud_ack`) is sticky and separate from the one for accounts.

- **The server enforces it.** It leaves the computer tools out of any turn whose model, failover target or checker model is a cloud model while `computer_cloud_ack` is false. That covers queued follow-ups, resumed runs and timeout failover, which bypass the client's pre-send check.
- **"Not now"** runs the turn without computers.

### 4.6 State rules

- **Stop** while an ask waits skips the ask and ends the turn.
- **A new message** in that chat, from any device, answers the ask as *instead*: the step is skipped, the parked turn ends, and the text is an ordinary new message.
- **The ask is voided**, and the parked turn ends, by any of: editing, regenerating or deleting anything at or before the parked turn; switching Connections off; removing the computer; or turning `COMPUTERS_ENABLED` off.
- **Pause** stops future steps on that computer in every chat. A step already running finishes. A pause made on the computer (`alfy-remote pause`) can only be resumed there.
- **Let go** cancels a running step in that chat.
- **Forks** start with no computer bound.
- **Offline:** the step fails with "MacBook Pro is offline", and Alfy says so. Nothing queues.
- **Removed:** the key is revoked and the live link closed at once. alfy-remote uninstalls itself only when the server answers with an explicit "revoked", never on an unknown key. `alfy-remote remove` does it locally.

## 5. How it works

### 5.1 Pieces

**Server:** `src/lib/server/services/computers/`, with one facade `index.ts` that callers import from, like the artifacts boundary. Inside it:
- registry and pairing;
- the agent link;
- bindings;
- steps (build, hash, summarize, route, record);
- the checker (prompt, schema and bands);
- asks and parking;
- deterministic rules (fast path, hard blocks, flags);
- the security log.

Logs use the `[COMPUTERS]` prefix.

**Chat turn:**
- the resume route imports chat-turn only through the `chat-turn/index.ts` facade;
- a terminal metadata field marks a parked turn;
- `conversation-detail/read-model.ts` carries the chat's binding and any waiting ask.

**Model tools:** `src/lib/server/services/normal-chat-tools/computer.ts`, with the rules written on the tool (ADR-0055).

**Browser:**
- the Settings group and its dialogs under `src/routes/(app)/settings/_components/connections/`;
- the computer line and the ask under `src/lib/components/chat/`;
- the parked state in `src/lib/client/normal-chat-client-turn-runtime.ts` (ADR-0060);
- the calls in `src/lib/client/api/computers.ts`.

**Shared, browser-safe:** `src/lib/shared/computers/` holds the zod schemas for steps, results, link messages and the protocol version, imported by the server and by alfy-remote alike.

**alfy-remote:** a new top-level `alfy-remote/` package (TypeScript, bundled to one file). The repo gates cover it:
- Biome's include list;
- an entry in `.fallowrc.json`;
- vitest and typecheck;
- a build-and-sign script.

### 5.2 One step, end to end

1. **The model calls a computer tool.**
2. **The server builds the step:** computer, working folder, action, arguments, and the network destinations the step declares. It is serialized canonically and hashed. Write and edit contents enter the step as path, size, hash and the first lines.
3. **The server writes the step's one-line summary** from the action and arguments. The work card, the computer line and the security log use that summary; model prose never reaches them.
4. **Deterministic rules run first.**
   - A plain read (`computer_files` `list`, `read`, `search`) inside the chosen folders is allowed without the checker.
   - Anything that touches protected hosts or secret paths is blocked.
   - Flags such as writes to auto-run files can only raise a step's band, never lower it.
5. **Otherwise the checker answers** allow, ask or block (§6.3).
6. **An ask parks the run** (§5.4), and a push notification goes out.
7. **An allowed step waits for its computer to be free** (one step at a time), then goes down the link with its hash and the server's signature.
8. **alfy-remote checks the signature and the hash**, and that every path lies inside the chosen folders. Then it runs the step behind the floor:
   - commands **and** its own file actions run inside the fence;
   - only the approved destinations are open;
   - every process the step started ends with the step: a process group (bubblewrap's PID namespace on Linux) or a job object on Windows.
9. **Output streams back**, capped, with known secret patterns masked by alfy-remote.
10. **The server records the outcome**, and the model gets a model-safe result:
    - The recorded tool call's model-facing summary is one fixed word: *done*, *blocked* or *skipped*. Reasons live only in the security log, so history replay on later turns can't show them to Alfy.
    - Recorded write and edit inputs keep a hash and a length, never the content, as `sanitizeProduceFileInput` does for files.

### 5.3 The agent link

- **Routes:**
  - `GET /api/computers/link`: server-sent events to alfy-remote (steps, cancels, pause, revoked, heartbeats every 15 s).
  - `POST /api/computers/link/steps/:id`: output chunks and results.
  - `GET /api/computers/install` and `/api/computers/install.ps1`: public; they return the scripts as plain text.
  - `GET /api/computers/bundle/:version` and the update manifest.
- **Authentication.**
  - alfy-remote signs a server nonce with its private key (Ed25519, `node:crypto`) and gets a short-lived link token.
  - Agent credentials reach only these routes.
  - `hooks.server.ts` matches the link routes by prefix (`PUBLIC_PATHS` is an exact match today), and the routes authenticate alfy-remote themselves.
  - The server's step-signing key is an app-level Ed25519 key, pinned at pairing, never a TLS pin.
- **Rules:**
  - one live link per computer;
  - revocation closes it at once;
  - links don't count against the chat stream capacity;
  - a protocol-version handshake answers a too-old alfy-remote with "needs update";
  - every message from alfy-remote is schema-checked and size-capped.
- **Apache** gets a `LocationMatch` for the link like the chat stream's (no buffering, no gzip). `deploy/apache-site.conf` and `deploy/README.md` change together.
- **Restarts.** A restart drops every link, and alfy-remote reconnects with jittered backoff. A step that's running when its link drops is stopped after a 30-second grace and reported as interrupted when alfy-remote reconnects.

### 5.4 Long tasks and waiting

- **Ceilings.** Computer turns get more room than chat turns: `COMPUTERS_TURN_MAX_STEPS` model steps (start at 50) and `COMPUTERS_TURN_MAX_MINUTES` (start at 20), both config keys. Today's limits are 14 model steps (`chat-turn/reasoning-depth-effort.ts`) and 300 s (`REQUEST_TIMEOUT_MS`).
- **Timers.**
  - The upstream idle timer (`min(150 s, timeout/2)` in `stream-orchestrator.ts`) pauses while a computer tool runs.
  - The turn timer becomes a per-turn value.
  - Computer turns never take the non-stream fallback (`stream-fallback.ts` re-runs with tools still enabled and could repeat a step); a fallback ends the turn instead.
- **Context.** Each step's output reaches the model capped at 16 KB. After the last three steps, older outputs in the same turn are replaced by their digests (`prepareStep`), so 50 steps don't fill the 262k window.
- **Parking: an ask always parks the run.**
  1. The turn's stream ends with the ask persisted.
  2. The run's in-turn model messages are kept on the ask row, because the persisted tool calls hold only 1,500-character digests.
  3. **A parked turn is saved but not completed:** no follow-up chips, title, memory judge or analytics until the resumed run ends.
  4. **The answer is claimed once,** with one conditional update as `claimPendingWrite` does, so a phone and a desktop answering together resume once.
  5. The server resumes from the stored messages with the real result of the waiting step.
  6. Open pages find the resumed run through `/api/chat/stream/status?conversationId` (`active-streams.ts`) and attach through the existing reconnect path. It reads as one reply.
- **Pending writes are unchanged.** Connections' pending writes end the turn and the model never learns the outcome; this feature doesn't touch them.

### 5.5 Model tools

**When they're present.** All of these must hold:
- the turn has Connections on;
- the person has at least one paired computer with Available in chats on (whether it's online is not a condition, which keeps the tool catalogue stable);
- the chat isn't incognito;
- `COMPUTERS_ENABLED` is on;
- a checker model is configured;
- the cloud rule (§4.5) allows it.

Their EN and HU descriptions carry the rules (ADR-0055). The neighbouring tools' "do not use" clauses (`files`, `run_python`, `read_generated_file`) point to them. The catalogue snapshots and `CATALOGUE_TOKEN_CEILING` move in the same commit, and each tool gets a `TOOL_TIMEOUTS_MS` entry.

The tools:
- **`computer_files`:** `list`, `read` (with ranges), `search` (names and content), `write`, `edit` (exact replacement), `move` and `trash`. They run inside the fence under the same rules as commands. Text is decoded with its detected encoding, and edits keep the file's line endings. Reading a `.env*` file returns the variable names with the values masked; commands still read the real file.
- **`computer_run`:** a command in the working folder.
  - **Shells:** the person's login shell on macOS and Linux; PowerShell 7 if installed, otherwise Windows PowerShell 5.1, on Windows. The description names which.
  - **A time limit:** default 120 s, up to 600 s.
  - **Destinations:** a list of the network destinations it needs.
  - **It returns** the exit status and output, capped at 16 KB to the model.
  - **The tool's envelope timeout** follows the step's own limit plus a margin; today's envelope maximum is 120 s.
- **`computer_transfer`:** `to_chat` makes a file a chat attachment through Knowledge Upload Intake; `to_computer` saves a chat file or a generated file into a chosen folder. It's capped at the upload limits (`maxFileUploadSize`, `BODY_SIZE_LIMIT`), chunked, and refuses types the intake refuses.

**Turn guidance.** The turn guidance (`normal-chat-context.ts`) lists the person's computers: name, OS, online state and chosen folders. It also gives the chat's binding.

### 5.6 Data

New tables, each with a drizzle migration, registered in `account-lifecycle/user-scoped-tables.ts`:
- **`computers`:** id, user, name, OS, alfy-remote version, public key, available in chats, paused, paused-on-computer, last seen, created, revoked.
- **`computer_pairings`:** code hash, user, expiry, claim attempts, server nonce, the claimed computer facts, confirmed or used.
- **`conversation_computers`:** the binding (conversation, user, computer, working folder, bound at).
- **`computer_steps`** (the security log): id, user, computer, conversation and message, step hash, the deterministic summary (secrets masked, never output), decision, band, decided by (rule, checker or person), the reason (shown to the person only), timings, result status.
  - Deleting a chat keeps the rows with the conversation cleared.
  - Rows are deleted with their computer, or with the account.
- **`computer_asks`:** step, user, state (waiting, allowed, skipped, instead, void), the checker's question and sentence, the facts line, the stored in-turn model messages, claimed and answered at.
- **`users.computer_cloud_ack`:** sticky, like `connection_cloud_ack`.
- **Message origin.** User messages gain `origin` (`typed`, `chip`, `imported`, `copied`) and `typedRanges`, which exclude pasted spans and quote-chip expansions (§6.3).

Other data rules:
- **Agent tokens** are stored as hashes, not in the connections vault, whose key derivation runs on every call.
- **Quiesce on account erasure:** revoke every computer, close links, cancel running steps, void asks.
- **The account archive** (ADR-0032) lists the computers and their security log.
- **Admin and analytics views** of this feature stay content-free.
- **New config keys** go into `config-store.ts` with README and `.env.example` entries:
  - `COMPUTERS_ENABLED`;
  - `COMPUTERS_PROTECTED_HOSTS`;
  - `COMPUTERS_TURN_MAX_STEPS`, `COMPUTERS_TURN_MAX_MINUTES`;
  - `COMPUTERS_CHECKER_MODEL`, `COMPUTERS_CHECKER_TIMEOUT_MS`.

### 5.7 alfy-remote on the computer

- **Package.** One JS bundle with no native addons, plus the official Node runtime.
- **Files.** They live in `~/.alfy-remote` or `%LOCALAPPDATA%\alfy-remote`:
  - runtime and bundle;
  - config: the server address, the chosen folders, the captured PATH, and the pinned public keys for the server's steps and for updates;
  - the computer's private key;
  - a local log.

  The fence hides this folder from every step. The key is a file with owner-only permissions rather than an OS keystore entry, because a pure-JS program can't reach keystores without native code.
- **Updates.**
  - The manifest names the bundle and the Node runtime, each with a signature.
  - alfy-remote verifies both with the pinned key and refuses anything older than what it runs.
  - The owner signs releases offline (`scripts/sign-alfy-remote.ts`), and `scripts/deploy.sh` only publishes the signed files. The key is never on the server.

## 6. Security

### 6.1 Threats and what stops them

| Threat | Stopped by |
|---|---|
| Alfy is prompt-injected or overeager | The checker (only typed text authorizes), the floor, the ask |
| Model-written text (a command, a file name, file contents) tries to steer the checker or the ask | The step goes to the checker quoted, write contents as path, size, hash and head. The ask always shows the server-computed facts line, and summaries are deterministic |
| AlfyAI's server is hacked | The floor is set on the computer; the server can tighten it, never loosen it. Updates need the offline key. Worst case: the chosen folders' contents can be read, changed or sent out, but nothing else on the computer, and never to protected hosts |
| A command tries to reach AlfyAI's server (the owner's Mac has root SSH to it) | Protected hosts are refused by name and by every address (§6.2). SSH keys and agent sockets are unreadable. Optional hardening: a touch-required FIDO2 key for alfyroot's root login |
| Someone pairs the AlfyAI server itself | Refused on both sides (§4.1) |
| A stolen agent key or token | Bound to one computer, revocable at once (the link closes), reaches only the agent link |
| A fake or broken alfy-remote attacks the server | The link accepts only schema-checked, size-capped answers to steps it sent, one link per computer |
| Another AlfyAI user | Steps route only to the owner's computers, and no admin feature reaches into a computer. Whoever runs the server holds the step-signing key and the checker config; that is the "server is hacked" row. Family members should know it before the family rollout |
| Steps or reasons replayed into later turns | A fixed one-word model-facing summary. Write and edit contents are hashed in `messages.tool_calls`, and reasons live only in the security log |
| Data leaves through Alfy's server-side tools | The prerequisite leak fix (§2, item 25) |

### 6.2 The floor

The same rules apply on every platform. alfy-remote builds one policy per step. Wherever the fence is degraded, it counts as no fence: seccomp missing (Unix sockets left open), a glob srt skipped, ripgrep, bubblewrap or socat missing, or the MXC probe failing.

- **Folders.** Reads and writes go only inside the chosen folders, plus a read-only allow list and a few writable caches.
  - **Read-only allow list:** system paths; toolchains such as Homebrew, nvm, pyenv, rustup and `~/.local/bin`; `~/.gitconfig`.
  - **Writable caches:** `~/.npm`, `~/.cache` and TMPDIR.
  - Slice 0 produces the exact lists per platform.
  - **macOS and Linux:** srt hides the home folder (`denyRead` on `/Users` or `/home`) and lets the chosen folders and the allow list back in (`allowRead`).
  - **Windows:** MXC `readwritePaths` = the chosen folders, `readonlyPaths` = the allow list, `deniedPaths` = secrets.
- **Secrets** are always unreadable, even inside chosen folders:
  - `~/.ssh`;
  - `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`;
  - browser profile folders;
  - macOS keychains (`~/Library/Keychains`) and the Windows credential stores;
  - password managers' data folders.
- **Unix sockets** stay blocked (srt's default): the Docker socket, D-Bus and the ssh-agent socket. `allowAllUnixSockets` is never used. On macOS, srt's Apple Events option stays off.
- **Network.** Closed by default.
  - A step's approved destinations (host and port) are a subset of what it declared, minus protected hosts. The proxy admits only those, and only for that step.
  - Local services on the computer are out of reach (srt already denies loopback), except an approved `127.0.0.1:<port>` over HTTP. `allowLocalBinding` lets a command use its own servers inside the step.
  - DNS goes through the fence's proxy, so lookups can't carry data out to arbitrary names.
  - **Windows:** slice 0 chooses between the agent's own proxy and MXC's direct per-step egress rules. MXC's proxy mode needs the private-network capability, which also accepts connections from the LAN.
- **Protected hosts.** The server sends the list at pairing and on every connect, built from:
  - its own interface addresses (`os.networkInterfaces()`, so the LAN, IPv6 and Tailscale addresses are covered);
  - every v4 and v6 address of its public name;
  - every model provider's base-URL host (this is how the inference box is identified);
  - `COMPUTERS_PROTECTED_HOSTS`.

  alfy-remote adds its configured server's addresses itself and keeps the union, so the server can add hosts but never remove one. srt receives each entry both as a deny IP literal and as a resolved-address deny, because allow-listed IP literals skip srt's resolved-address check and RFC1918 isn't in its default deny set. MXC receives explicit blocks.
- **Environment.** Variables whose names contain KEY, TOKEN, SECRET or PASSWORD are removed from commands' environment.
- **Code that runs later.** srt's fixed write denials apply on every platform, so they're read-only:
  - `.git/config`, `.git/hooks/` and `.gitmodules`;
  - `.vscode/`, `.idea/` and `.mcp.json`;
  - shell rc files.

  This means `git push -u` and remote edits stay with the person. Writes to other well-known auto-run files (`.husky/`, `.claude/settings*.json`, `.envrc`, `.github/workflows/`, `package.json` scripts) carry a deterministic flag that raises them to medium.
- **alfy-remote itself.** Its folder is unreadable and unwritable for every step, and nothing written in a chosen folder can change its settings.
- **File actions run inside the fence.** If there's no fence (Linux without bubblewrap and socat), file actions still work through alfy-remote's own checks:
  - real paths resolved;
  - UNC and device paths refused (`\\localhost\c$`, `\\wsl$`), along with 8.3 short names and trailing dots;
  - no writes to files with more than one hard link.

  Commands are refused until there's a fence. alfy-remote never runs a command unfenced.

### 6.3 The checker

**Authority.** Only typed text grants permission. User messages are persisted with an `origin` and `typedRanges`, and the server reads authority only from persisted rows, never from the request body.
- **Grants nothing:** follow-up chips (`handleSendFollowUp`), pasted spans (the composer marks text that arrives by paste), quote-chip expansions (`expandQuotesIntoMessage`), imported or forked rows, and rows written before this feature.
- **Never authorize:** personal instructions, folder instructions and skills.
- A choice made in a picker the server rendered (the computer line's "Change folder or computer") counts as typed.

**Input, and nothing else:**
- **Typed text from this conversation**, newest last, capped.
- **The step, as quoted data:** action, arguments, the declared destinations, the working folder, write contents as path, size, hash and head, and the deterministic flags.
- **Facts:** the computer's name and OS, the chosen folders, the protected hosts.
- **The steps already taken this turn**, as a bare list of actions, never their output.

It never sees tool output, web pages, emails, file contents beyond a write's head, or Alfy's own text.

**Bands:**
- **Low:** reads, and changes inside the working folder that the person's request covers, including deleting what Alfy created this turn. These are allowed.
- **Medium:** irreversible changes to existing things, anything that leaves the computer, installs, changes outside the working folder, setting the working folder, and flagged auto-run files. These are allowed only if the person's typed words name the action and its target. Otherwise they ask.
- **High:** reading or sending secrets, reaching protected hosts, disabling protections, or anything the person didn't ask for that could harm them. These are blocked, and a block is never offered as an ask.

Ambiguity asks; it never allows.

**Output.** A fixed JSON shape:
- the band and the decision;
- a short question and one sentence for the person, in the turn's reply language (`resolveTurnResponseLanguage`);
- the approved destinations, which must be a subset of the declared ones.

The raw text is parsed with a duplicate-key check. Extra or duplicate keys, malformed output, an error or a timeout all count as no, and the step becomes an ask. Anything the deterministic rules mark as high was already blocked before the checker ran.

**Run.**
- One call through `normal-chat-control-model.ts`: model `COMPUTERS_CHECKER_MODEL` (default `model2`), timeout `COMPUTERS_CHECKER_TIMEOUT_MS` (default 20 s, not the 300 s request timeout), the response schema sent explicitly, thinking off, and deterministic sampling (listed with its reason in `sampling.test.ts`).
- With no checker model configured, the computer tools are not offered.
- Switching to a separate safety model (for example `gpt-oss-safeguard-20b`) means a new config value plus a prompt variant for it.

**Hand-back.** Three blocks in a row, or twenty in one chat, end the run and hand back to the person with a plain message. Both counters reset with the person's next typed message.

**Measured.** A fixed evaluation set of real tasks and injection attempts (§8) runs before release and after every prompt or model change. The thresholds live with the set.

## 7. Slices

0. **Groundwork.**
   - ADR-0067 and the vocabulary; confirm the leak-fix task has landed.
   - Spikes, with findings recorded before slice 1:
     - **srt on the owner's Mac and Linux box:** the hidden home with the chosen folders let back in; the read-only allow list, writable caches and PATH capture; per-step network; protected hosts by IP; ripgrep; linger; escape probes.
     - **MXC on Windows 11 25H2 x64 VMs on the Linux host** (KVM, fully updated, nested virtualization on in case it's needed): **both Home and Pro**, with Smart App Control on where a clean install allows it. Also: the proxy-or-direct-egress choice, the shell, and git under MXC.
     - **Parking and resuming** a turn end to end, on a fake tool.
     - **Ed25519** in `node:crypto` on all three platforms.
1. **Pairing and presence.** alfy-remote's skeleton and installers, pairing (code, words, keys, the server-machine refusal), the agent link, protected hosts, the Settings group and detail, online and offline, Pause, Remove, signed updates. No steps yet.
2. **Files, the checker and asks.**
   - `computer_files` and `computer_transfer`, run inside the fence;
   - message origin and typed text;
   - the checker with its schema and bands;
   - bindings;
   - asks with parking and resuming, and the push notification;
   - the computer line and the ask;
   - the work card and blocked lines;
   - the cloud rule;
   - the security log.
3. **Commands behind the floor.**
   - `computer_run`, and the srt and MXC adapters;
   - the per-step proxy, local-service rules, environment scrubbing and output masking;
   - processes ending with the step;
   - the timer and fallback rules;
   - the escape suite.
4. **Long tasks and polish.** Turn ceilings and context digesting, hand-back, the sidebar dot, surviving a refresh, accessibility, the Hungarian review.

The feature ships to dev after slice 4, and moves to prod when the owner says so.

## 8. Testing

- **Escape suite**, per platform, against the pinned sandbox versions. It probes:
  - reads and writes outside the chosen folders;
  - secrets inside and outside them;
  - alfy-remote's own folder;
  - the code-runs-later files;
  - environment leaks;
  - Unix sockets (Docker, D-Bus, ssh-agent);
  - on macOS: `open`, `osascript`, `pbpaste` and `security find-generic-password`;
  - DNS lookups as a channel;
  - case and Unicode-normalization variants of denied paths;
  - hard links, and `/proc/*/root` and `/proc/*/cwd`;
  - UNC and `\\wsl$` paths;
  - processes surviving with `setsid` or `nohup`;
  - a chosen folder holding many git repos (srt's bubblewrap argument limit);
  - network to unapproved destinations;
  - protected hosts by name, IP (v4 and v6), LAN and Tailscale address, alternate DNS and redirects.

  It runs before each release and on every sandbox version bump.
- **Checker evaluation set:** real tasks (harness, chores, reach-through) labelled allow, ask or block, plus injection attempts:
  - in files, web pages and emails the model has read;
  - in command text and file names the model writes;
  - in follow-up chips;
  - in pasted text.

  It reports misses (allowed when it shouldn't be) and needless asks.
- **Unit and protocol tests:**
  - pairing: expiry, single use, rate limits, word mismatch, server-machine refusal;
  - signatures and nonces, and step hashing (no check-then-swap);
  - link authentication, the version handshake, size caps;
  - authority: chips, pastes, forks, imports and old rows grant nothing;
  - the one-word model-facing summary and hashed write inputs in `messages.tool_calls`;
  - exactly-once answers and the void rules;
  - the cloud rule, including failover and resumes;
  - the idle timer and no-fallback rules;
  - fail-closed paths.
- **Playwright with a fake alfy-remote:**
  - the Settings group and dialogs;
  - the Connections rows;
  - the computer line states;
  - the ask (keys and their one-second arming, refresh, sidebar dot);
  - blocked lines and the cloud notice.

  The specs join `scripts/gates.sh`.
- **Manual on real machines:** the owner's Mac and Linux box, and the Windows 11 Home and Pro VMs.
- **The usual gates from AGENTS.md:** check, biome (now including `alfy-remote/`), migrations, tests, build, the chunk check, Fallow.

## 9. Risks

- **MXC is days old and still rolling out.** Its Home-edition support is unverified, and it has open bugs with Git Bash and with path resolution in git and Node. Slice 0 decides whether Windows makes launch.
- **srt is a beta with weekly releases.** It's pinned, and the escape suite gates every bump. Its fixed protections (the code-runs-later files) can't be switched off.
- **The checker will miss some cases.** It runs on a smaller, uncensored model, and chains of harmless-looking steps beat any step-level check. The floor and the per-step network rule are what hold.
- **Host-level approval is coarse.** Approving a destination allows any action on that host. The checker sees the full command, but the proxy can only judge hosts.
- **Platform friction:**
  - Linux needs bubblewrap and socat; without them the computer is file-only until the person installs them (with sudo).
  - macOS asks once per protected folder (setup triggers it) and shows a background-item notice.
  - Windows shows a console flash at login.
- **Parking and resuming touches several layers at once:** the chat-turn pipeline, the browser runtime and the stream contract. Slice 0 spikes it.
- **Code Alfy writes can run later**, when the person runs their tests, scripts or editor tasks. The floor can't judge that. As with any coding agent, the person reviews what changed.
- **Without signed-in tools, v1 is less capable** than the "everything" the owner first asked for. Proxy-side credential injection is the path back.

## 10. Owner decisions on open questions (2026-10-12)

From the first draft:
1. **Emergency switch:** yes, one server-wide off switch (§2, item 19).
2. **Name:** the program and its command are **alfy-remote**.
3. **Folders at setup:** suggested (Projects, Documents, Desktop), not pre-ticked.
4. **Distribution:** only from the person's AlfyAI server, which was the recommendation when the owner was unsure. No npm for now.

From the peer review (the owner accepted every recommended answer):

5. **Signed-in tools in v1:** no (§2, item 8).
6. **`.env` values:** masked when read through `computer_files`; names kept (§5.5).
7. **Push notification for a waiting ask:** yes (§2, item 21).
8. **Code-runs-later files read-only everywhere:** yes, srt's list on every platform; no `git push -u` or remote edits by Alfy (§6.2).
9. **Local services on the computer:** out of reach, except a step-approved `127.0.0.1:<port>` over HTTP (§2, item 9).
