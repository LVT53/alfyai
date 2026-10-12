# Alfy Works on Your Computers Through an Outbound Agent

Status: Proposed (2026-10-12).

A person's own computers (macOS, Linux, Windows 11) can be paired with their AlfyAI account. From any chat, Alfy can then read and change files, run commands, and use the computer's network for addresses the person allows. In the first version it does not use the person's signed-in tools.

This takes back the "desktop, terminal and platform integration" item that [ADR-0064](0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md) parked. The owner decided it section by section on 2026-10-11 and 2026-10-12, and an Opus peer review on 2026-10-12 sharpened it. The implementation spec is [`docs/plans/claude-at-home-3-computers-spec.md`](../plans/claude-at-home-3-computers-spec.md), and the research is in [`docs/plans/claude-at-home-3/research.md`](../plans/claude-at-home-3/research.md).

## Decisions

**1. Our own agent on each computer, alfy-remote, dials out to AlfyAI.**
- It keeps one outgoing HTTPS connection: server-sent events down, POST up.
- Nothing on the computer listens for connections.
- The AlfyAI server and the inference box can never be paired.

Rejected:
- **SSH from the server:** the server would hold a key to every computer, routers would need open ports, and nothing on the computer would enforce limits.
- **Relaying to OpenCode or MCP servers, rejected for now:** their permissions assume someone at the keyboard, and the limits would live in code we don't control. A later "hand this task to OpenCode" stays possible.

**2. alfy-remote is plain JavaScript on an official Node runtime, installed with one terminal paste from the person's own AlfyAI server.**
- No native app, no paid code signing, and no unsigned native helpers of our own. Windows Smart App Control blocks unsigned native code but does not inspect scripts that Node runs.
- Updates carry our own Ed25519 signature, made with a key that is never on the server.

Rejected:
- **An unsigned native app:** every user clicks past an OS warning.
- **A browser tab:** it can't run commands.
- **Docker:** Linux commands only.

**3. Safety is one checker plus one fixed floor.**
- **The checker** is one model call per step. It judges the step, quoted as data, against what the person typed. Typed means persisted with its origin: never follow-up chips, pastes, quotes, imports or instructions. The checker sees nothing else (no tool output, web pages, file contents or Alfy's own text), and answers allow, ask or block with one plain-language sentence.
- **The floor** is enforced on the computer by the operating system's sandbox and cannot be changed from the chat:
  - the chosen folders only;
  - secrets and Unix sockets unreadable;
  - network closed by default and opened per step;
  - local services on the computer out of reach;
  - AlfyAI's own server and the inference box never reachable, by name or by any of their addresses;
  - credentials stripped from commands' environment;
  - code-runs-later files read-only;
  - the agent's own files out of reach.
- **The fences:** Anthropic's sandbox-runtime on macOS and Linux, Microsoft's MXC on Windows 11.

Rejected:
- **Per-step approvals:** dozens of taps per task.
- **A five-layer design** with snapshots and per-task mandates: too many moving parts to maintain.
- **A checker alone:** classifiers miss. Anthropic reports 17% for its own on real overeager actions, and chains of harmless-looking steps beat step-level checks.

**4. No signed-in tools in v1.** Pushing, `gh` and `ssh` need the person's keys, tokens or agent sockets. Exposing them would undo the floor: on Linux, allowing one Unix socket allows them all, including the Docker socket and D-Bus. Local git commits work. Proxy-side credential injection is the path to adding these later.

**5. The model is uncensored, so no safety property relies on it refusing.** Every rule must hold when the model actively tries to do the wrong thing.

**6. Computers are Connections.**
- They appear as their own group in Settings → Connections.
- They appear as rows in the composer's Connections list ([ADR-0044](0044-connections-ui-redesign.md)).
- Alfy picks the computer and folder from the person's words. Setting the working folder is itself a step the checker judges.
- A live computer line above the composer shows where Alfy is working, and opens into the approval card when Alfy needs the person. A waiting approval also sends a browser push notification.

**7. Windows 10 and phones are not targets.** Phones are where people chat and approve.

## Context

The owner uses AlfyAI from everywhere, including a phone, but it couldn't touch a real computer the way local harnesses (OpenCode, deepseek-harness) can. The feature had been parked because of its security weight.

Three facts set the shape:
- **The model is uncensored.**
- **AlfyAI's server must never become reachable through a paired machine.** The owner's laptop holds root SSH to it.
- **The owner rejected anything that makes a person babysit dozens of approvals.**

Research found that the shipped approach elsewhere is a classifier judging actions against the user's request, plus OS isolation and egress control as the real boundary (Claude Code auto mode, Codex, Copilot CLI). It also found that Windows 11 now has a Microsoft-signed container (MXC, GA 2026-10-07) that a script-only agent can use without admin rights.

## Consequences

**New code:**
- a subsystem under `src/lib/server/services/computers/`;
- a new top-level `alfy-remote/` package (the agent; its command has the same name);
- shared schemas in `src/lib/shared/computers/`;
- new tables, routes and an Apache `LocationMatch` for the agent link;
- an origin on user messages, so the checker can tell typed text from everything else.

**One server-wide off switch** (`COMPUTERS_ENABLED`, default off) for emergencies; there is no per-person switch.

**Changes to existing behavior:**
- Computer turns get a higher step and time ceiling than chat turns.
- The upstream idle timer pauses while a computer tool runs, and computer turns never take the non-stream fallback.
- An approval parks the turn and resumes it, rather than ending it as Connections' pending writes do. Pending writes are unchanged.

**Ongoing maintenance:**
- Both sandboxes are pinned, and a per-platform escape suite gates every version bump.
- The checker is measured on a fixed evaluation set before release and after any prompt or model change.

**Prerequisite:** today's model-output leak channels (markdown images to any address, the favicon proxy, `fetch_url` with any URL, permissive CSRF origins) are closed before this ships.
