# Hand-off to Codex: the AlfyAI thread of 2026-11-10

Written by Claude Code (Sonnet 5.5) at the owner's request, 2026-11-10 13:52 UTC. Facts were checked against git and the code that day. "(notes)" marks what comes from Claude's memory notes and was not re-checked.

## 0. Start here

Run Codex in `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai`. It reads the root `AGENTS.md` by itself. Read the `AGENTS.md` of every folder before you change code in it (the root file lists them).

Paste this as the first message:

> Read `docs/plans/codex-handoff-2026-11-10/HANDOFF.md` in full, then do section 4 in order. Commit locally in small commits. Do not push, deploy or touch production without my explicit word in the same message. During design, ask me one question at a time.

Words you will meet: **Alfy** is the assistant. **Atlas** is the deep-research job. **ai.dev** is the staging site, **alfyroot** the box both sites run on. **Flash-Next** is the local chat model. **MinerU** reads documents and photos. **Parallel** is the web search and page-extract API. **Immich** holds the person's photos.

## 1. How the owner works

- **Answers:** short and plain, the point first. The owner reads English and Hungarian. Every label, error, empty state and aria string in the app needs both, in short natural Hungarian.
- **UX:** few choices; self-hostable; no cross-account sharing (a hard no); a private family app, so licences are not a blocker.
- **Design flow:** brainstorm one question at a time, starting from a real moment. Draw a mockup for every UI/UX answer in AlfyAI's own tokens (`src/app.css`; `docs/plans/image-generation/wireframes.html` shows the style). Write `docs/plans/<topic>/design.md`. Let a fresh reviewer read it as the builder and settle their questions. Write the plan. Build in small tasks, each by a fresh implementer and then a fresh reviewer, with the strongest model on the risky tasks and the final whole-branch review. Finish with an independent adversarial review before anything goes to production.
- **Gates:** `scripts/gates.sh agent <out-dir> --port <base> <the e2e specs you changed>` once at the end (about 4 minutes). While iterating use `npm run check`, `npm test` and `npm run build`, and never run check or test while a build runs. Lint with `npx biome check src scripts tests`. Use Node 22: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` (the default Node 26 breaks `better-sqlite3`).
- **Git:** small commits whose messages explain why. Never push without the owner's explicit request, and push explicit SHAs (`git push origin <sha>:refs/heads/dev`), never a branch name. Production is built from `origin/main`, ai.dev from `origin/dev`. A conditional message ("if it looks fine, deploy") is not a deploy word.
- **Production and staging:** ssh to the box needs the owner's OK and Tailscale; never print keys. Never use the owner's real data for tests: public datasets or synthetic text only, and list what was read and written.
- **Docs check:** before writing Svelte 5, SvelteKit, Drizzle, Tailwind, Vitest or Playwright code, check the current docs (Context7 or the Svelte MCP if you have them, otherwise the official sites) and say what you checked.

## 2. Where the code and the deployments stand (13:52 UTC)

- `origin/main` = `origin/dev` = `aba3e8fbe`. Production and ai.dev both run it. Today's releases, oldest first: `271a5fa6e` (HEIC decode in a worker thread), `5b3b5b0d5` (Feature Guide and a Knowledge list picture fix), `22ab441dd` (the 4B embedder, switched on in production on the owner's word), `aba3e8fbe` (document search order fix). The full deploy log is the memory note `alfyai-deployed-code-is-origin-main.md`.
- The main checkout's local `dev` (`fbfeed369`) is 54 commits behind `origin/dev` and has 4 of its own. Do not build on it: `git fetch origin`, then cut worktrees from `origin/dev` (`git worktree add .claude/worktrees/<name> -b <branch> origin/dev`).
- Shipped and finished: sidebar multi-select, vision and images, Ask me first, the Feature Guide, and the four traced chat bugs (`f88897c54` Retry gate, `b1eebe6dd` throwing write executor, `ed57ce793` cancelled landing message, `26bc67ccc` last admin). The owner was right that the bugs were done.
- Other sessions' unmerged local work, not yours to touch: branches `claude/quizzical-volhard-52c88f` (older documents join the search by vector and name) and `claude/quirky-bouman-f2c637` (working-set age fix), plus some review worktrees. The memory index lists each one.

## 3. What this thread decided

The owner asked what is left on the to-develop list and what to build next for end users. Claude checked the owner's ranked six (notes: `alfyai-feature-backlog-owner-order.md`). #1 sidebar multi-select, #2 image generation with vision and #5 Ask me first are shipped. #3 attach an earlier chat, #4 AI to-do list and #6 scheduled tasks are untouched. Claude also found a project the owner chose on 2026-10-14 that was never built: **file analysis** (ADR-0064 goal 3). Then:

1. **File analysis goes first.** The owner approved a mockup ("looks very good"): `docs/plans/file-analysis/mockup-v1.html`. Nothing is designed or built beyond the mockup and the brief.
2. **Clock and timezone goes second.** It is built; see 4.1.
3. **Everything else comes later:** scheduled tasks plus timers (the owner's own interest: a harness change that lets the model use timers and other time tools), attach an earlier chat, the AI to-do list (test the real model's list-keeping first), and a regenerate that keeps both versions.
4. **Browser exploration is benched.** The owner meant a real headless browser that clicks (JavaScript pages, screenshots). That is a large chain. Two cheaper levels exist; see section 5.
5. **Remote computers stays paused.** The embedding upgrade was on hold that morning and was then shipped on the owner's word.

## 4. Do these in order

### 4.1 Land the clock-and-timezone branch (built, not merged)

- Branch `claude/jovial-bartik-de5d4c`, worktree `.claude/worktrees/jovial-bartik-de5d4c`, 10 local commits `8d590ac6d..7a5849d7e` (36 files, +1,717/-32). It is cut from `271a5fa6e`, so it is 28 commits behind `origin/main`. None of those 28 adds a migration (deploy log), so the branch's migration `1777140000124` (`users.time_zone`) should order cleanly; `npm run check:migrations` confirms.
- Its own gate passed on its tip: `scripts/gates.sh agent` ALL GATES PASSED in 4m20s (check 0/0, 24,452 unit tests including the tool-catalogue ceiling, Fallow 0 new, Playwright 54 passed, 0 flaky).
- What it does:
  - Each turn the model is told the person's local date, time of day and zone: `[SYSTEM TIME CONTEXT: The person's local date and time is …, 14:35 (Europe/Budapest, UTC+01:00). This line is the current time: …]`. The UTC offset is there because the night the clocks go back has two 02:30s.
  - With no stored zone it says the zone is unknown and gives no time of day.
  - `users.time_zone` stores an IANA name. The browser saves its own zone without a prompt, when none is stored or when that browser's zone changed since it last looked. A zone the person picked stays.
  - A Time zone row sits at the end of Settings → Preferences, in English and Hungarian: 13 common zones plus the stored and the device's zone.
  - No tool was added. Wording that pointed at a date/time tool that never existed is gone from the base prompt and the turn line. `src/lib/server/prompts.ts` line 129 is a legacy snapshot marked "never edit" and was left; a test guards it.
- Commits: `8d590ac6d` zone validation and the local-moment formatter (`src/lib/shared/time-zone.ts`); `532a54312` the time line and reworded base prompt; `ce9e992d9` column, migration and preferences-route validation; `43b6d4d55` one stored-zone read per turn in `prepareOutboundContext`; `f386d0177` the browser saves its zone; `2a9317a22` the Settings row; `80d56d2c2` the device's zone under its own `optgroup` heading; `34b0470d9` `tests/e2e/time-zone.spec.ts`; `85c5a6b1e` AGENTS.md updates; `7a5849d7e` a Fallow fix.
- The builder's own follow-ups, none done: the account data archive does not list the zone (a one-row change); the home-screen figures still use the server's zone (moving them changes which week a message counts in); anyone who never loads the app in a browser keeps a null zone; month and day boundaries in a zone have no helper yet, and file analysis will need one.
- Its hand-over note: `/Users/lvt53/Library/Application Support/Claude/side-session-notes/local_6346ff39-c80f-4932-839c-807f68cfb3c1/time-zone-clock-handover.md`.
- **To do:**
  1. Run the owner's independent review pass: a fresh, adversarial, read-only reviewer on the settings route validation, the "never overwrite a picked zone" rule, DST correctness, and the claim that the new line costs no cache.
  2. Merge `origin/dev` into the branch (or rebase), then re-run `scripts/gates.sh agent` on the merged commit with `tests/e2e/time-zone.spec.ts tests/e2e/settings-admin.spec.ts tests/e2e/chat.spec.ts`.
  3. Tell the owner the result and ask whether to merge into `dev`, push, and deploy. Do none of those without their word.

### 4.2 Start the file-analysis design

Use `docs/plans/file-analysis/brief.md` (the full starting brief) and `docs/plans/file-analysis/mockup-v1.html` (open it in a browser). Your first message to the owner: say they can skip the questions and have you draft the design from what is in the brief, then ask one open question about a real moment. Suggested: the last time someone at home had a spreadsheet or export they wished Alfy could just read, and what it looked like. (Hungarian bank exports are often semicolon-separated with decimal commas and Windows-1250 text, which decides how careful the reader must be.)

### 4.3 Do not start

Browser exploration (benched), Remote computers (paused), anything on the later list (section 6), and any deploy.

## 5. Facts to build on

**File analysis (checked today).**
- `SANDBOX_PYTHON_PACKAGES` is only openpyxl, xlsxwriter, python-docx and python-pptx (`src/lib/server/sandbox/python-version.ts:40`). Deploy installs them into a site-packages folder mounted read-only at `/workspace/python-packages` (`scripts/deploy-lib.sh`).
- `src/lib/server/sandbox/config.ts` binds only those packages (Python) and node_modules (JavaScript), so no upload reaches the container. `/workspace` is a 50 MB tmpfs (`config.ts:371`). The container has no network, runs as UID 1000 on a read-only root with capabilities dropped, and has a 60 s timeout, 1 GB of memory and 100 processes. Outputs are collected in memory and never written to the host disk. `src/lib/server/sandbox/AGENTS.md` is binding.
- `run_python` is a scratch tool (`src/lib/server/services/normal-chat-tools/run-python.ts`; its description is at `normal-chat-tools/index.ts:384`). `produce_file` makes durable job-backed file cards (`src/lib/server/services/file-production/`). A produced file draws only as a row (name, size, Open, Download) in `src/lib/components/chat/FileProductionCard.svelte`, so the mockup's inline chart preview is new UI.
- The tool catalogue is held by a token tripwire: `CATALOGUE_TOKEN_CEILING = 5518` in `src/lib/server/services/normal-chat-tools/index.test.ts`, with a snapshot in `tool-catalogue.en.snapshot.txt`. Widen the `run_python` and `produce_file` text instead of adding a tool, and pay for every added word.
- An untested idea of Claude's: send the upload into the container through the Docker archive API (into its tmpfs) instead of bind-mounting a host copy. That keeps the "nothing touches the host disk" rule and keeps one person's file out of any shared path.

**Time and scheduled tasks (notes plus today's checks).**
- Before the clock branch the model got only today's date in the server's zone.
- No timer, notify or schedule tool exists. Only Atlas sends web push (`src/lib/server/services/browser-push.ts`, `static/browser-push-sw.js`).
- The sidebar has no running or unread dots; the multi-select build left them out and #6 needs them.
- The job engine is ready for a scheduled-task kind (ADR-0069, `src/lib/server/services/jobs/AGENTS.md`).
- Sketched shape: first slice one-shot reminders plus push, then recurring schedules with a structured "when" (days and time, not RRULE). Runs are read-only (writes stay pending writes that wait for a click). Each run is an ordinary chat in a "Scheduled" folder. One tool with set, list and cancel actions spares the catalogue.
- Open design question: when a timer fires, is it only a push, or does Alfy come back and do the task?

**Browser exploration (benched).**
- ADR-0068's per-turn check already treats an address inside an earlier tool result (`fetch_url`, `research_web`; up to 2,000 per result) as allowed, so following a link needs no exemption. Only an address the model writes is refused (`src/lib/server/services/url-provenance/`).
- `fetch_url` is Parallel Extract, and its tool text tells the model not to use it to find pages.
- A turn allows 20 tool steps, a fetched page adds up to about 12k tokens re-sent on every step, and Flash-Next gets no prefix-cache hits (notes). Link-by-link browsing by the main model is therefore slow.
- Levels: (1) numbered links on fetched pages, so the model picks an id and never writes a URL; (2) a bounded server-side explore loop run like an Atlas job; (3) a real headless browser with controlled egress, which also adds prompt-injection risk.

## 6. Later list

Order after the first two: scheduled tasks and timers; attach an earlier chat (the owner's #3; swap it with the previous one if they want it sooner); then the AI to-do list and a regenerate that keeps both versions.

Small extras that each need only the owner's yes:
- Option 1 for the multi-picture "pasted-on" look: one guidance line for `make_image`.
- Re-extracting documents parsed before MinerU 4.1, so old charts and formulas come back.
- Chats past about 100 messages cannot scroll back: `hasMoreMessages` is set in `src/routes/(app)/chat/[conversationId]/+page.ts` and no component reads it.

## 7. What does not carry over from Claude Code

- **Memory notes:** `/Users/lvt53/.claude/projects/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/memory/` (index: `MEMORY.md`). Read these first: `alfyai-feature-backlog-owner-order.md`, `alfyai-deployed-code-is-origin-main.md`, `alfyai-clock-timezone-branch-2026-11.md`, `alfyai-claude-at-home-roadmap.md`, `alfyai-hungarian-ui-copy.md`, `alfyai-orchestrate-dont-code.md`, `alfyai-independent-review-after-agent-batches.md`, `alfyai-dev-process-speed.md`, `feedback-no-owner-data-for-tests.md`, `alfyai-push-explicit-sha-not-branch.md`, `alfyai-harness-tools-ops-state.md`. They are Claude's notes. Where they differ from git or the code, trust git and the code.
- **Session cards and linked sessions** do not exist in Codex. Use one worktree per task (`git worktree add`) and one thread per worktree. Claude's own sessions are still open in the Claude app; do not edit their worktrees while they might run.
- **Inline visual widgets** are gone. The mockup lives as the HTML file above. Write new mockups as HTML files under `docs/plans/<topic>/`, and as PNG if you can, since the owner sometimes reads away from the computer.
- **Skills and plugins** (brainstorming, writing-plans, subagent-driven development): their steps are written out in section 1.

## 8. Waiting on the owner

- The clock branch: the review result, then merge, push and deploy (their word).
- File analysis: their answer to the opening question.
- The three small yes/no extras in section 6.
- Feature Guide: the Hungarian check and four calls (the Atlas-only draft over Try it, the "delete your account" clause, the toast style, the tablet "?" size) were never settled (notes).
- After the 4B embedder switch, the old `tei-embed` (0.6B, :7997) stays up for rollback until they say.
- Other open threads are in the memory index, for example the turn-completion review, whose fix has not started.
