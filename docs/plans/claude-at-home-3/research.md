# Feature 3 · Computers: research behind the decisions

Collected 2026-10-12 by research subagents and a read-only code study. Every claim carries its source. Before a number is quoted elsewhere, re-check it against the source: some come from secondary write-ups. The decisions they led to are in [`../claude-at-home-3-computers-spec.md`](../claude-at-home-3-computers-spec.md).

## 1. Sandboxes for agent commands

**Anthropic sandbox-runtime (srt).** `@anthropic-ai/sandbox-runtime` 0.0.79, Apache-2.0, "Beta Research Preview", Node ≥ 22.12 ([repo](https://github.com/anthropic-experimental/sandbox-runtime)).
- OS-level, no container. Reads are open unless `denyRead`; writes are denied unless `allowWrite`. Network is denied by default, through an HTTP/SOCKS proxy with a domain allowlist.
- macOS uses Seatbelt. Linux uses bubblewrap plus socat.
- Called from Node: `SandboxManager.wrapWithSandbox(cmd)` returns a string for `spawn(cmd, {shell: true})`.
- Its own caveats: allowing github.com permits pushes to any repo; domain fronting is possible; it covers shell commands only.
- **Hiding the home folder works.** `denyRead: ["/Users"]` (`/home` on Linux) plus `allowRead` for the chosen subfolders: allowRead beats denyRead, and a narrower denyRead inside still holds. On bubblewrap the denied directory becomes an empty tmpfs with allowed paths bound back over it, and globs cover only entries that exist at wrap time. Under a home deny, `~/.npm/_logs` needs `allowWrite`.
- **Windows (alpha).**
  - One UAC prompt (`windows-install`) creates a hidden local user `srt-sandbox` and machine-wide WFP filters (only loopback to the proxy ports). Launch goes through `CreateProcessWithLogonW`, then a restricted token and a job object.
  - It bundles `srt-win.exe` (Rust), with no signing step found, so Smart App Control may block it.
  - Open issues: per-user toolchains are invisible, DNS isn't fenced, `initialize()` can block for up to 60 s, and the sandbox user can't stat the parents of granted folders.

**Microsoft MXC (Microsoft eXecution Container)**, GA on Windows 11 on 2026-10-07 ([repo](https://github.com/microsoft/mxc), MIT; [Windows blog](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/)).
- Policy: read-only, read-write and denied paths; default-deny; WFP egress rules.
- The BaseContainer tier is an OS API: no admin, no host ACL changes.
- Requirement: Windows 11 24H2 ≥ 26100.9278 or 25H2 ≥ 26200.9278 (the Sept 2026 updates); still rolling out.
- Codex, GitHub Copilot CLI and VS Code use it on Windows ([Copilot docs](https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/using-local-sandboxing), [VS Code docs](https://code.visualstudio.com/docs/agents/run/agent-sandboxing)).
- `@microsoft/mxc-sdk` 1.0.0 carries Microsoft ESRP signing logs. Its `bin/x64/wxc-exec.exe` takes JSON requests ("non-SDK consumption"). Use the exe, not the SDK: the SDK pulls in koffi and node-pty, which ship unsigned `.node` files.
- Open bugs: Git Bash/MSYS2 fails ([#1061](https://github.com/microsoft/mxc/issues/1061)), and `GetFinalPathNameByHandleW` breaks git and Node `realpath.native` ([#1464](https://github.com/microsoft/mxc/issues/1464)).
- Codex and Copilot docs say Windows proxy mode needs "allow local network". So explicit blocks matter (an explicit block beats an allow).
- Not verified: ARM64 builds, and support on Home edition.

**Other Windows options considered.**
- Microsoft's Agent Workspace: still an Insider private preview.
- Windows Sandbox: not on Home; networking is only on or off.
- Low-integrity labels: confine writes only.
- WSL2: works on Home, but needs admin plus a reboot and runs Linux commands.
- Building our own with Node 26's experimental `node:ffi`: possible, but we'd own it.

**Others' choices.** Claude Code and Cursor require WSL2 on Windows. Copilot CLI and VS Code use MXC. Gemini CLI uses Low-IL labels or Docker. OpenCode does not sandbox at all ([SECURITY.md](https://raw.githubusercontent.com/anomalyco/opencode/dev/SECURITY.md)).

**Codex CLI** ([sandboxing](https://learn.chatgpt.com/docs/sandboxing)): macOS uses Seatbelt; Linux uses bubblewrap plus seccomp; Windows uses MXC, or an "elevated" mode (two local users, firewall rules, ACLs) or an "unelevated" one. It keeps `.git` read-only.

## 2. Installing on Windows without paid signing

- **Smart App Control** allows only code signed by a Trusted Root CA, or code with good cloud reputation ([Learn](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)).
  - It checks every module the loader loads (EXE, DLL, MSI) and scripts run by Microsoft hosts (PowerShell, wscript, mshta).
  - Node is an "unenlightened" host, so `node.exe agent.js` is not inspected ([script enforcement](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/script-enforcement)).
  - Unsigned `.node` addons are blocked: a Cursor user hit this ([report](https://forum.cursor.com/t/windows-11-pro-smart-app-control-cursor-agent-fails-to-start-because-merkle-tree-napi-win32-x64-msvc-node-is-blocked/164831)).
  - Since April 2026 it can be re-enabled without reinstalling. Win10 has no Smart App Control.
- **The official `node.exe` is Authenticode-signed** (the build signs it; DigiCert KeyLocker since 2023, [PR](https://github.com/nodejs/node/pull/50956)). The zip extracts without admin.
- **The `irm … | iex` pattern works.** Execution policy Restricted blocks `.ps1` files, not piped strings, and Microsoft says it is "not a security boundary" ([docs](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)). Avoid `Add-Type`, because App Control script enforcement puts PowerShell in Constrained Language Mode.
- **Start at login without admin:** `HKCU\…\Run` with a hidden PowerShell start. A brief console flash remains; only a signed GUI launcher removes it.
- **Free signing:** SignPath Foundation, for OSI-licensed public projects with CI builds; it doesn't cover macOS. Certum Open Source costs about €49. Azure Artifact Signing is unavailable to individuals outside the US and Canada. Apple has no free notarization path, but `curl` sets no quarantine attribute, so notarization doesn't matter for a script installed this way.

## 3. Approvals and prompt injection

- **Claude Code auto mode** ([Anthropic](https://anthropic.com/engineering/claude-code-auto-mode), March 2026).
  - Its classifier sees only user messages and bare tool calls; assistant text and tool results are stripped.
  - After 3 consecutive or 20 total blocks it hands back to the human.
  - Reported: 0.4% false positives, 17% misses on 52 real overeager actions, 5.7% misses on synthetic exfiltration.
- **A chain of harmless-looking steps reached code execution in 3–4 of 5 runs** ([Rehberger, Aug 2026](https://embracethered.com/blog/posts/2026/breaking-claude-code-opus-5-and-automode/)). Anthropic's conclusion: the real boundary is OS isolation plus egress control.
- **The consensus is that prompt injection is unsolved at the model level, so use structural limits:**
  - [the lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/);
  - [Meta's Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/);
  - [CaMeL](https://arxiv.org/abs/2503.18813);
  - adaptive attacks beat 12 defences ([paper](https://arxiv.org/abs/2510.09023)).

  The shipped recipe: judge the action against the user's own request without the untrusted content, plus deterministic gates (Claude Code; Chrome's User Alignment Critic).
- **Vercel AI SDK.** The repo uses `ai ^6.0.193`. v6 `needsApproval` ends the turn and keeps the approval in client history, where it can be forged unless HMAC-signed. v7 renames it `toolApproval`. We keep approval state on the server instead.
- **Guard models:** none is built to judge shell commands.
  - Prompt Guard 2 can be evaded.
  - Qwen3Guard covers content safety.
  - Granite Guardian 4.1 can check calls against the request.
  - `gpt-oss-safeguard-20b` (3.6B active, about 16 GB) takes the policy at inference time: the candidate if our checker misses too much.

## 4. deepseek-harness approvals (read-only code study, dsh v0.2.1-alpha.2)

**What it does.**
- Its LLM judge ("Auto review", `packages/experimental/auto-review/src/index.ts`) is an opt-in experiment, off by default.
- The default is an OS sandbox that fences writes only, plus one-shot approvals in a panel that replaces the composer. The sidebar shows a dot while it waits, and prompts survive a refresh.

**Borrowed.**
- Only server-attested typed text authorizes. Pasted, attached and tool content counts as facts.
- A tier rubric (low allow; medium only if the request names the action and target; high never).
- A closed verdict format where any failure denies.
- The checked step is frozen and executed byte for byte.
- The checker's reasons are kept out of the agent's context.
- Credential-named variables are scrubbed.
- A ledger of what the agent created this session.
- Every verdict is logged.

**Avoided.**
- "High" turning into an allow-once prompt.
- The judge sharing the agent's model and reading agent-written arguments without a strict diet.
- Enter approving by default.
- No timeout handling.
- Allow verdicts going unlogged.

## 5. Pairing and updates

- **The OAuth device flow (RFC 8628) is the most-phished login flow of 2025–26** ([Microsoft, Apr 2026](https://www.microsoft.com/en-us/security/blog/2026/04/06/ai-enabled-device-code-phishing-campaign-april-2026/)). So pairing starts in the signed-in session, and both screens show the same short words (a ZRTP-style short authentication string).
- **Updates:** signed with a key that isn't on the server and pinned in the binary, with no downgrades ([TUF](https://theupdateframework.io/docs/metadata/) for the fuller model). Ed25519 is in `node:crypto`.
- **Remote Control precedents:** Claude Code Remote Control ([docs](https://code.claude.com/docs/en/remote-control)) and Codex Remote ([docs](https://learn.chatgpt.com/docs/remote-connections)) connect outbound only, with short-lived credentials and per-device revoke.

## 6. Code constraints found in AlfyAI (branch dev at 31f0c158)

- **Turn limits.**
  - At most 14 steps per turn (`chat-turn/reasoning-depth-effort.ts`), and `stagnantProgress` stops repeated identical calls.
  - At most 300 s per turn (`REQUEST_TIMEOUT_MS`), with a 150 s upstream idle limit.
  - Per-tool timeouts sit in `normal-chat-tools/shared.ts` `TOOL_TIMEOUTS_MS`: no default, 120 s maximum today.
- **Connections' pending writes end the turn, and the model never learns the outcome** (`connections/pending-writes.ts`, `WriteConfirmCard.svelte`).
- **Transport.** adapter-node, no custom server, no WebSocket. Apache with an SSE `LocationMatch` and `ProxyTimeout 300` (`deploy/apache-site.conf`). Drain knows only chat streams.
- **Existing leak channels** (fixed by a separate task first):
  - markdown images are unproxied (`services/markdown.ts`) with CSP `img-src https:`;
  - the favicon proxy fetches hosts the model chose;
  - `fetch_url` takes any URL;
  - `csrf.trustedOrigins: ['*']`.
- **Persistence.** Tool inputs and result digests (up to 1,500 characters) persist in `messages.tool_calls` and replay, incognito included.
- **Vault.** The connections vault derives its key by PBKDF2 on every call, so agent tokens are stored as hashes instead.
- **Cloud warning.** The Cloud-Connector Warning lives in `connections/locality.ts` (`isCloudModel`, sticky `users.connection_cloud_ack`) and `CloudConnectorWarningModal.svelte`.

## 7. srt facts confirmed in the peer review (2026-10-12)

From the srt README, checked by the Opus reviewer and spot-checked again.

**Fixed write denials.** srt always denies writes to:
- `.git/config`, `.git/hooks/` and `.gitmodules`;
- `.vscode/`, `.idea/` and `.mcp.json`;
- shell rc files (`.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`) and `.gitconfig`.

None of these can be overridden, so `git push -u` (which writes `.git/config`) can't run inside the fence.

**Unix sockets.** They're blocked by default.
- macOS can allow individual socket paths.
- Linux enforces the block with seccomp, which can't filter by path, so it's all or none: allowing the ssh-agent socket would also allow the Docker socket and D-Bus.
- Without seccomp, sockets are unrestricted and srt only warns.

**Network.**
- **Resolved-address check.** Before dialing an allowed host name, srt checks its resolved address against a denied set: loopback, unspecified, link-local, multicast, broadcast, cloud metadata, and the computer's own addresses. RFC1918 private ranges are not in it.
- **Literals skip the check.** Allow-listed IP literals skip the resolved-address check, while deny-listed literals always win. So protected hosts must be given as deny literals as well as names.
- **Local binding.** `allowLocalBinding` lets a command bind local ports for its own servers.
- **Per-command lists** attribute violations to a command; they are not a boundary between commands running at the same time.
- **ssh.** It ignores proxy variables. Only git-over-ssh gets a `ProxyCommand`, through `GIT_SSH_COMMAND`.

**Dependencies.** ripgrep is required on macOS and Linux (deny-path detection). Linux also needs bubblewrap and socat. On Ubuntu 24.04+, AppArmor's unprivileged-userns restriction needs care.
