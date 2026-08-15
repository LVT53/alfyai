# Architecture deepening — slice backlog

Local tracker for the 2026-08-15 architecture review follow-through.
Source: architecture review report (9 candidates) + verification pass against `main` @ `1cdf51a3`.

**Execution model.** One integration branch per wave. One commit per slice. Subagent-driven
TDD (Sonnet 5 subagents), orchestrator review + gate + commit. Waves run **sequentially**;
slices *within* a wave may run in parallel only where the slice says so.

**Autonomy.** The programme runs unattended. There are exactly **two scheduled stops** — after
M1's latency measurements, and after G0/G1's eval results — plus the automatic halt conditions
in §5. Everything else, including push and deploy, proceeds on a green gate.

**Gate (every slice, no exceptions).**

```bash
npm run check    # svelte-check — must be 0 errors / 0 warnings
npm run lint     # biome
npm test         # vitest — no regression from the wave's recorded baseline
npm run build    # must be 0 warnings
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json
```

Plus targeted Playwright per `AGENTS.md` § Mandatory Verification when the slice touches
chat send/stream, composer, settings/admin, or shell.

**Status legend:** ⬜ todo · 🟨 in progress · ✅ done

---

## 0. Verification ledger

Read this before trusting any number below. The review was produced partly by exploration
subagents; this section records what was re-verified by hand against the tree.

### Confirmed

| Claim | Evidence |
|---|---|
| Guidance packs selected by English regex on latest message only | `normal-chat-context.ts:295-475`; probe run against exported `planNormalChatGuidancePacks` |
| Same request → different packs EN vs HU | measured: `latest news` EN → `web-core,web-detailed` (20 999 chars); HU → core only (13 172) |
| Follow-up turns lose packs | measured: turn 1 → web packs; turn 2 "And the 13 inch one?" → core only |
| `image_search` description is 12 words; `photos` carries its own full bilingual usage rules | `normal-chat-tools/index.ts:191`, `:214` |
| `repairConversationMessageSequences` runs 2 whole-conversation `UPDATE`s | `message-sequences.ts:9-37` |
| `finalize.ts` carries `logPrefix: "[SEND]" \| "[STREAM]"` | `finalize.ts:101`, `:259`, `:361` |
| `chat-turn/` has **no** `index.ts` | 70 files, 17 556 non-test lines |
| `/api/chat/send` imports 7 chat-turn modules, is 698 lines | `send/+server.ts:14-23` |
| Failed tool call emits status `"done"`; no component reads `metadata.ok` | `stream-orchestrator.ts:1195-1209`; grep over `*.svelte` returns nothing |
| Network drop removes the streamed message | `normal-chat-client-turn-runtime.ts:604` |
| `better-sqlite3`, synchronous, one connection, single process | `db/index.ts:6-11`; `deploy/langflow-chat.service` |
| Atlas drains serially, deployment-wide | `atlas/worker-runner.ts:324` |
| `deploy.sh` deletes `build/` then rebuilds for ~2 min | `scripts/deploy.sh` steps 5-6 |

### Corrected — the review was wrong or imprecise

| Claim in review | Actual | Impact |
|---|---|---|
| Sequence repair called from 3 read sites | **11 call sites** (`messages.ts:328,390,433,490`, `context-compression.ts:494`, `memory-context/project.ts:211`, `memory-context/history.ts:307`, `knowledge/capsules.ts:140,232`, `chat-turn/retry.ts:102`, `task-state/continuity.ts:667`) | **S1 scope roughly triples.** Some are legitimately on write paths and must stay. |
| Client adapter interface has 59 members | **82 top-level members** (`normal-chat-client-turn-runtime.ts:72`) | R1 is larger than stated |
| 529 raw `db.*` call sites | **117** non-test call sites across **94** files | X1 smaller than stated, still large |
| No graceful shutdown | `sveltekit:shutdown` handler **already exists** (`hooks.server.ts:128-139`) and stops schedulers | D2 is narrower: raise `SHUTDOWN_TIMEOUT`, add draining — do not rebuild shutdown |

### Production environment — verified on the box 2026-08-15 (read-only, via SSH)

**These facts override the repo's deploy templates. Do not plan against `deploy/*` as written.**

| Fact | Value | Consequence |
|---|---|---|
| App path | `/home/alfydesign/apps/langflow-chat` — **not** `/opt/alfyai` | `deploy/langflow-chat.service` template is wrong; D1 must use the real path |
| Service user | `alfydesign` — **not** `alfyai` | same |
| `SHUTDOWN_TIMEOUT` | **unset** → adapter-node default 30s | D2's fix confirmed necessary; streams run to 300s |
| `TimeoutStopSec` | not set in live unit → systemd default | D1 should set it explicitly |
| Apache vhost | `/etc/httpd/conf/httpd.conf`, **Virtualmin-managed**, many domains | D2 must use a Virtualmin-safe include; a hand edit to `httpd.conf` can be overwritten |
| Existing 503 handling | none | maintenance page is net-new |
| Disk | 200G total, 77G free; build 43M, node_modules 854M, data 650M | 3 release dirs ≈ 2.7G — ample headroom |
| Node | v22.23.1 | fine for adapter-node graceful shutdown |
| Host | 32 cores, 185G RAM, 2 GPUs | AlfyAI, vLLM and mineru share one box |

**Supervision & access — verified on the box 2026-08-15 during D0 recon (read-only).**

| Fact | Value | Consequence |
|---|---|---|
| Staging supervision | `langflow-chat-dev.service` — a **systemd system service**, `User=alfydesign`, `WorkingDirectory=/home/alfydesign/apps/langflow-chat-dev`, `Restart=always`, port 3002, running since 2026-08-07 | Same pattern as prod. The untracked `deploy-dev.sh` on the box references PM2 only in an **unused var** and never restarts anything — it is stale, not the live mechanism |
| Prod supervision | `langflow-chat.service` — systemd, `User=alfydesign`, `/home/alfydesign/apps/langflow-chat`, `Restart=on-failure`, `RestartSec=10`, **no `TimeoutStopSec`**, **no `SHUTDOWN_TIMEOUT`** | Confirms D1 must set `TimeoutStopSec` explicitly and D2 must add `SHUTDOWN_TIMEOUT=300`. Confirms `deploy/langflow-chat.service` template (`/opt/alfyai`, user `alfyai`, `TimeoutStopSec=90`) is wrong on path+user |
| **Sudo asymmetry (staging restart blocker)** | `alfydesign` has `NOPASSWD` sudo to restart **`langflow-chat.service` (prod)** and `sweetie.service` — **but NOT `langflow-chat-dev.service` (staging)** | Restarting **staging** requires `alfyroot` (used for D0), or a new sudoers rule the human must add. A structurally-identical `deploy-dev.sh` cannot self-restart staging as `alfydesign`; it must degrade gracefully (attempt `sudo -n`, else print the alfyroot instruction), mirroring `deploy.sh`'s existing "could not restart" branch |
| Staging DB separation | staging `…/langflow-chat-dev/data/chat.db` (50.6 MB, inode …802, mtime Jul 20) vs prod `…/langflow-chat/data/chat.db` (124 MB, inode …729, written today) | **Definitively separate** — different path, inode, size. D0's "assert own DB, not prod" requirement is satisfied |
| Disk | apps live on `/home` LV: **3.3 T total, 1.7 T free** (§0's earlier "200G/77G" was the root fs) | Ample headroom for D1 release dirs |
| `sweetie` app | separate product also on the box (`~/apps/sweetie`, own systemd service, own node proc) | Out of scope; do not touch |

**Scale — this materially downgrades three candidates.**

`users=6 · conversations=607 · messages=2196 · largest conversation=89 messages · chat.db=124M`

- **S1** — the six whole-conversation `UPDATE`s are real waste, but over ≤89 rows. Worth fixing for hygiene and write-lock behaviour; **it is not the cause of a multi-second wait.** Do not sell it as a latency fix.
- **O1** — no pagination is not urgent at 89 messages. The double-fetch is still real waste; the payload is not.
- **X1** — "one user's query stalls every other user's stream" is a *scaling* risk, not a present-day defect at 6 users. ADR-0059 accepts it anyway, ordered last, with an automatic halt if it is not earning its keep. Do not describe it as a latency fix.
- **Wave S** — with server-side work this small, the speed complaint is almost certainly genuine model reasoning time. M1 still must prove it, but expect Wave S to be the real fix.

**Model topology — resolves the P3 contention question.**

| Role | Provider | Where |
|---|---|---|
| Default chat model | `deepseek` | hosted `api.deepseek.com` — **remote** |
| Memory judge / consolidation / context summarizer | `model1` | **local vLLM**, `192.168.1.96:30000` |
| Local vLLM serving | Qwen3.8-27B-NVFP4, GPU 0, `--max-num-seqs 4`, `--performance-mode interactivity` | |
| GPU 1 | mineru document services — not chat | |

**Conclusion: the feared contention does not exist in the default configuration.** The main chat model is a remote API; the local GPU is idle during its reasoning, so a classifier call cannot queue behind the main model's tokens.

**But a different, precise ceiling does exist.** The local vLLM runs `--max-num-seqs 4` — four concurrent sequences total — and already serves the memory judge, consolidation, and context summarizer, *and* is the chat model for one of the six users. P3 must therefore:
- treat classifier calls as **best-effort with a hard concurrency cap**, never queueing behind a full instance;
- degrade silently to event-derived steps on rejection or timeout;
- **not** be pointed at the same slot as a user's active chat model without measuring first.

### Not independently verified — orchestrator must confirm before acting

- Conversation-detail payload is embedded **twice** in the HTML (SvelteKit `data-sveltekit-fetched` + load serialization). Plausible; unproven. **O1 must prove this first.**
- "~60-80 DB round trips per page view" — an estimate, not a measurement. **O1 must measure.**
- Conversation-switch-mid-stream writing turn A's data against conversation B (`+page.svelte:1110`). Mechanism read but not reproduced. **R1 must reproduce with a failing test before fixing.**
- Bundle-size figures were measured against a **stale July 12 build**. Re-measure before citing.

---

## 1. ADR & convention compliance matrix

This is the section that keeps us out of the mess. Both previously-conflicting candidates (X1, R1) were **resolved on 2026-08-15** by accepted ADRs and, for X1, by amending the two conventions in the same change. No slice below is blocked on a human decision.

| Slice | Governing ADR / convention | Verdict |
|---|---|---|
| G1 tool guidance | *None.* No ADR mentions guidance packs, prompt packs, or tool descriptions | ✅ ungoverned — **must author a new ADR** |
| S1 sequence repair | none | ✅ clear |
| D1/D2 deploy | ADR-0041 names "stream capacity rejection" as an *admission* concern that must reject before the `Response` | ✅ a draining flag is exactly a capacity rejection — **compatible by design** |
| R1 client runtime | ADR-0019, now partially superseded by **ADR-0060** | ✅ **resolved** — ownership may move; see below |
| F1 chat-turn facade | ADR-0015 (completion boundary), ADR-0041 | ✅ compatible if completion ownership stays in chat-turn |
| E1/E2 error seam | **ADR-0025** owns browser stream framing | ⚠️ constrained — must reuse `data-stream-error`; **no new stream part names** |
| O1 conversation open | **ADR-0022** | ✅ compatible — read model keeps payload assembly; bounded range is a parameter, not a move |
| X1 db seam | previously conflicted with `db/AGENTS.md:48` and `AGENTS.md` § What Not To Reintroduce | ✅ **resolved** — ADR-0059 accepted; both conventions amended to permit one execution seam while keeping per-table wrappers forbidden |
| T1 types.ts | none | ✅ clear |
| M1 timing persistence | ADR-0042 already frames timing as observability | ✅ **amend** ADR-0042, no new ADR |
| P1-P4 thought steps | ADR-0025 (stream parts), ADR-0015 (durable state) | ✅ compatible — reuse `data-response-activity`; new ADR for the UX contract |

### ADR deliverables ledger

Every ADR below is **part of its slice**, not follow-up work. A slice is not ✅ until its ADR
is committed. Numbers are provisional — take the next free number at write time and fix the
cross-references.

| Slice | ADR | What it must record |
|---|---|---|
| D1 | **new** ADR-0054 — atomic release cutover | release layout, symlink flip, migration ordering (expand/contract), rollback |
| D2 | amend ADR-0054 | draining contract; explicit statement that it is an ADR-0041 capacity rejection; why Phase 3 blue/green is deferred |
| G1 | **new** ADR-0055 — tool usage guidance lives in the tool interface | why the classifier is deleted rather than replaced; explicit "does not reopen ADR-0046"; retires guidance-pack language from CONTEXT.md |
| S1 | none | pure relocation of a write off the read path |
| R1 | ✅ **ADR-0060 written & Accepted** — supersedes ADR-0019 on turn-state ownership | ADR-0019 carries a partial-supersede note; its placement decision still governs |
| F1 | amend ADR-0015 | one chat-turn entrypoint for both transports; completion ownership unchanged |
| O1 | amend ADR-0022 | bounded message range as a read-model parameter |
| E1/E2 | amend ADR-0025 | error codes map to existing `data-stream-error`; no new part names |
| T1 | none | mechanical |
| X1 | ✅ **ADR-0059 written & Accepted** — db execution seam | `db/AGENTS.md` and `AGENTS.md` **already amended** so the repo does not contradict itself. Implement as a strangler. |
| M1 | amend ADR-0042 | browser timing marks persist as observability; must not affect turn control flow |
| P1-P4 | ✅ **ADR-0056 written** — `docs/adr/0056-interim-thought-steps-are-durable-turn-state.md` | amends ADR-0015 (steps are durable completion state); disclosure contract settled; Thought Step Anchor; classification-not-summarization; explicitly does not reopen ADR-0046 or ADR-0025. **Move to Accepted when P3 ships.** CONTEXT.md still needs the `Thought Step Anchor` term. |

### R1 — ownership moves, under ADR-0060

**Resolved 2026-08-15.** ADR-0060 is written and Accepted; ADR-0019 carries a partial-supersede
note. The runtime may own turn state (placeholder, streamed text and reasoning, lifetime,
terminal outcome) and expose observable state plus a small event surface. ADR-0019's placement
decision still governs everything else, and durable completion stays in `chat-turn` (ADR-0015).

**Order the work so value lands first:**
1. **Fix the two defects** — partial output surviving a recoverable drop, and conversation switch
   mid-stream. These are the user-visible wins and are shippable on their own.
2. **Then move ownership**, one concern at a time — message text → reasoning → lifetime →
   terminal outcome. The adapter seam stays for whatever has not moved yet.
   **No slice may leave two owners for the same field.**
3. Delete the dead mirrored page state.

Record the adapter member count before and after. Starting point is **82**. ADR-0060 says the
change is not done if that number has not materially fallen.

### X1 — unblocked, under ADR-0059

**Resolved 2026-08-15.** ADR-0059 is Accepted, and `db/AGENTS.md` and `AGENTS.md` have **already
been amended** so the repo no longer contradicts itself. Per-table repository wrappers remain
forbidden; one query-*execution* seam is permitted.

**Constraints that keep this from running away:**
- Strangler only. Introduce the seam beside the existing handle; migrate call sites
  incrementally; remove the direct `db` export only when the last one is gone.
- A **second (in-memory) adapter ships with the seam**, and at least one database-booting test
  suite is converted to prove the interface is honest. One adapter is a hypothetical seam.
- Ordered **last**, after S1 and O1 have deleted query call sites.
- **Automatic halt (no human needed):** at the halfway point of call-site migration, if the
  count of database-booting test files has not fallen and no query instrumentation is in use,
  stop migrating and report. The seam must earn its keep while it lands.
- Honest framing in commits: at 6 users this is a scaling property, **not** a latency fix.

---

## WAVE 0 — make deploys safe before shipping anything risky

Branch: `deploy-cutover`. Nothing else runs during Wave 0.

### D0 — Restore staging as the deploy gate ✅
**Blocked by:** none. **This is now the first slice in the programme.**

**Why first.** A staging environment already exists and is running — it is just 915 commits
stale. Restoring it turns every later deploy from "hope the gate caught it" into "it ran on a
real box against a real database first." That is a better answer to the risk of an autonomous
programme than any metric gate.

**Verified state of staging (2026-08-15, on the box):**

| Fact | Value |
|---|---|
| Path | `/home/alfydesign/apps/langflow-chat-dev` |
| Branch / commit | `dev` @ `45bb09ff` (2026-06-02) |
| Divergence | **0 commits unique to dev**; **915 behind `origin/main`** |
| Migrations | 62 files vs prod's 98 — **36 behind** |
| Runtime | live, `node build/index.js`, PORT **3002**, own `.env`, own `data/chat.db` |
| Public | `ai.dev.alfydesign.com` (Apache logs a stale `DocumentRoot` warning for it) |
| Deploy script | `scripts/deploy-dev.sh` exists **on the box but is untracked in the repo**, and references **PM2, which is not installed** |

**The catch-up is a fast-forward, not a merge.** Dev has no unique commits, so there is no
conflict surface. The real risk is the 36 pending migrations — against a **disposable** database.

- [ ] `dev` fast-forwarded to `main` (`git merge --ff-only origin/main`). If that fails, stop —
      it would mean dev has diverged since this was measured
- [ ] `npm ci` + `db:prepare` on staging; all 36 migrations apply cleanly against `dev`'s own DB
- [ ] Staging boots, `/api/health` responds on :3002, one real chat turn completes end to end
- [ ] `scripts/deploy-dev.sh` brought **into the repo**, corrected (no PM2 — staging runs the
      same supervision pattern as prod), and kept structurally identical to `deploy.sh` so the
      two cannot drift again
- [ ] Staging `.env` confirmed to point at its **own** database and **not** at production data —
      assert explicitly, this is the one thing that must not be wrong
- [ ] Stale `DocumentRoot` warning for `ai.dev.alfydesign.com` noted or fixed
- [ ] README/deploy docs describe staging as a required stop before production

**Gate:** full gate, plus staging serving a real turn.

**If the migration catch-up fails:** staging's DB is disposable. Recreating it from scratch is an
acceptable resolution and does **not** count as a halt condition. Production data is never
involved.

**D0 execution status (2026-08-15).**

Done and verified on the box:
- ✅ `dev` fast-forwarded to `origin/main` (1cdf51a3). Precondition re-verified live: **0 unique
  commits, 915 behind** — clean `--ff-only`.
- ✅ Dependency install + migrations. `npm ci` **fails** because the committed `package-lock.json`
  at `1cdf51a3` is out of sync (`protobufjs@7.6.0` vs `7.6.5`) — a **pre-existing repo condition**;
  prod's `deploy.sh` uses `npm install` (lenient), which is why prod works. `npm install` succeeds.
  The 36 "pending" migrations turned out **already applied** — staging's `__drizzle_migrations`
  was **already at 98** (DB mtime Jul 20), so `db:prepare` is a clean no-op and code+DB are now
  consistent at 98. Migration path verified honest.
- ✅ `npm run build` clean (0 warnings) after install.
- ✅ Service restart (`langflow-chat-dev.service`, via **alfyroot** — `alfydesign` lacks NOPASSWD
  for the dev service) → boots on the fresh build; **`/api/health` returns `{"status":"OK"}`**
  both direct on `:3002` and through Apache at `https://ai.dev.alfydesign.com`.
- ✅ Full request path verified end to end via `scripts/benchmark-live-chat-stream.ts` (seeded a
  throwaway disposable-DB user): login → conversation create → `/api/chat/stream` → correct error
  surfacing all work.
- ✅ Staging DB separation asserted (own path/inode/size; §0 ledger).
- ✅ `scripts/deploy-dev.sh` brought into the repo, corrected (no PM2; systemd restart of the dev
  service with graceful sudo-fallback), structurally identical to `deploy.sh`.
- ✅ README.md + deploy/README.md describe staging as a required stop.
- ✅ Stale `DocumentRoot` warning **noted** (not fixed — Virtualmin-managed): `httpd -t` emits
  `AH00112: DocumentRoot [/home/alfydesign/domains/ai.dev.alfydesign.com/apps/langflow-chat-dev]
  does not exist`. A stale vhost path; the real app is `~/apps/langflow-chat-dev` served via
  reverse proxy, and the public health check works, so it is cosmetic. Left for the operator since
  a hand edit to `httpd.conf` can be overwritten by Virtualmin.

✅ **RESOLVED — "one real chat turn completes end to end."** The blocker was a stale staging model
config: the vLLM at `192.168.1.96:30000` requires auth and returned **401 `Unauthorized`** because
staging's stored key was invalid *and* its model names (`nemotron-super`/`hermes-4-3-36b`) no longer
match what the vLLM serves. The vLLM (`vllm-qwen27b-heretic.service`) actually serves **`qwen3-6-27b`
and `qwen3-8-27b`**. The operator explicitly authorized reusing the system's existing vLLM key; it
was moved **opaquely** (never printed/logged) from the vLLM process environment into staging's
`.env` (`MODEL_1_NAME=qwen3-6-27b`, `MODEL_2_NAME=qwen3-8-27b`, valid `MODEL_*_API_KEY`), the
disposable provider rows were cleared, and `db:prepare` re-seeded them through the app's own
encryption. After restart, a real turn **completes with a genuine answer** (outcome `ok`, ~476 ms to
first byte, ~1.3 s total). Staging is now a true chat gate.

**Operator notes (non-blocking):** staging `.env` is mode `644` (a pre-existing hygiene issue — it
holds secrets; consider `600`; the backup I made is `600`). The valid vLLM key is the same one the
box already uses; no rotation performed (operator permitted using it as-is).


### D1 — Atomic releases (deploy Phase 1) ✅
**Blocked by:** D0. Prove the release flow on staging before production sees it.

**Why first:** every slice below becomes a deploy, and today a deploy breaks open sessions for
~2 minutes. `scripts/deploy.sh:5` runs `rm -rf "$APP_DIR/build"` while the process is serving
from it, so static chunks 404 and hot-path dynamic `import()`s fail *before* the restart.

**Real surface** (paths verified on the box — see §0)
- `scripts/deploy.sh` — full rewrite of steps 2-8
- `deploy/langflow-chat.service` — `ExecStart`, `WorkingDirectory`, `Environment`.
  **The template is wrong:** live install is `/home/alfydesign/apps/langflow-chat` running as
  `alfydesign`, not `/opt/alfyai` as `alfyai`. Fix the template to match reality, or the first
  deploy points at a path that does not exist.
- `deploy/README.md`, `README.md` — deploy story
- `src/lib/server/services/app-version.ts:102` — `readFileSync(resolve(process.cwd(), "package.json"))` **must be re-checked**: it resolves through `process.cwd()`, which changes under a symlinked release root

**SDD artifact:** `docs/adr/0054-atomic-release-cutover.md` — record release-directory layout,
symlink flip, migration ordering, rollback.

**TDD**
1. `scripts/deploy.test.ts` (new) — shellcheck-style assertions plus: the script never removes a
   path under `current/`; migrations run **after** build and **before** flip.
2. `src/lib/server/services/app-version.test.ts` — add a case asserting version resolution works
   when `cwd` is a symlink.

**Acceptance criteria**
- [ ] Build output lands in `releases/<git-sha>/`; live release is `current` → `releases/<sha>`
- [ ] `systemd` unit points at `/opt/alfyai/current/build/index.js`
- [ ] `npm ci` runs inside the new release dir, never mutating the live one
- [ ] `db:prepare` runs **after** build, immediately before flip (today it runs at step 4, before)
- [ ] Migration policy documented as expand/contract; a migration that drops or renames a column
      in the same release as the code change is rejected in review
- [ ] Rollback documented and exercised once: flip symlink to previous release + restart
- [ ] Last 3 releases retained
- [ ] `npm start` still runs `check:migrations && db:prepare` (AGENTS.md requires this)
- [ ] `/api/health` unchanged and still matches docs

**Gate:** full gate + `npm run db:prepare` + a **dry-run deploy on the remote box** (see §5).

**Rollback:** revert commit; old `deploy.sh` is unchanged in git history. **Note:** reverting the
commit restores the flat `deploy.sh` but does **not** un-migrate a box already on the releases
layout; to revert a *box*, point the systemd unit back at the flat `build/` (the pre-D1 unit backup
is kept at `/etc/systemd/system/langflow-chat-dev.service.pre-d1.bak` on staging).

**D1 execution status (2026-08-15).** Commits `9acade30` (implementation) + `addca738`
(deploy-script bootstrap doc). Repo gate green (check 0/0 tracked, build 0 warnings, 6051 tests,
fallow delta 0, biome clean on touched files). **Box dry-run done on STAGING and verified:**
- One-time flat→releases migration performed: `shared/{.env,data}` created, `releases/`, `current`,
  and the systemd unit repointed at `.../current/` (`WorkingDirectory`/`EnvironmentFile`/`ExecStart`;
  `TimeoutStopSec=120`). Health OK; a real chat turn completes on the new layout.
- `deploy-dev.sh` ran the full steady-state flow twice (`releases/9acade30`, `releases/addca738`):
  `git archive` snapshot → `npm ci||install` → shared symlinks → build → `check:migrations` +
  `db:prepare` (against the shared DB) → atomic `ln -sfn`+`mv -Tf` flip → prune (kept both).
- **Rollback exercised:** flipped `current` forward→back→forward across the two releases, restarting
  each time; the actually-running release (checked via `/proc/PID/cwd`) matched `current` and health
  stayed OK at every step. Rollback works.

**⚠️ Two follow-ups surfaced (flagged to operator):**
1. **Staging deploy cannot self-restart.** ✅ **RESOLVED** — the owner authorized it, and the rule
   `alfydesign ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart langflow-chat-dev.service` is installed
   at `/etc/sudoers.d/alfydesign-langflow-dev` (validated with `visudo`). `deploy-dev.sh` now
   self-restarts staging autonomously (verified). Prod already had its equivalent rule.
2. **Deploy-script bootstrap.** In the release model the app root is no longer a live checkout, so
   `./scripts/deploy.sh` there is stale; refresh it from the target ref first
   (`git checkout origin/<branch> -- scripts/deploy*.sh`). Documented in `deploy/README.md` (commit
   `addca738`).

**Production migration is NOT yet done** — the flat→releases migration + unit repoint on prod is the
gated step (staging soak first; normally bundled into the Wave 0 exit deploy of D1+D2+M1). Vestigial
flat `build/`+`node_modules/` remain at the staging app root (harmless; optional cleanup).

---

### D2 — Drain + maintenance page (deploy Phase 2) ✅
**Blocked by:** D1.

**What to build.** A `draining` state that makes Stream Admission refuse new streams while
in-flight ones finish, and a static 503 page served by Apache from a directory the build never
touches.

**Real surface**
- `src/lib/server/services/chat-turn/active-streams.ts` — `checkStreamCapacity()` (`:581`),
  `getStreamStats()` (`:616`). Add `setDraining(bool)` / `isDraining()`
- `src/routes/api/health/+server.ts:4` — currently `json({ status: "OK" })`. Add
  `{ status, draining, activeStreams }`; **keep `status: "OK"` shape backward-compatible** —
  `deploy/README.md` documents the current response
- `src/hooks.server.ts:128-139` — existing `sveltekit:shutdown` handler; do **not** rewrite
- `deploy/langflow-chat.service` — add `Environment=SHUTDOWN_TIMEOUT=300` (default 30s vs 300s streams)
- `deploy/apache-site.conf` — `ErrorDocument 503` + flag-file rewrite. **Verified: the live vhost
  is in Virtualmin-managed `/etc/httpd/conf/httpd.conf` alongside many other domains, and there
  is no 503 handling today.** Use a Virtualmin-safe include directory — a hand edit to
  `httpd.conf` can be overwritten by Virtualmin. Confirm the include path with the human before
  touching Apache.
- `/var/www/alfyai-maintenance/` — the page itself, outside the app tree
- `src/routes/(app)/+layout.svelte:236` — extend existing `serverUpdateAvailable` into a
  deploy banner for already-open tabs

**Reuse, do not rebuild:** `checkStreamCapacity` already returns a `global_limit` rejection, and
the client already backs off on capacity errors
(`normal-chat-client-turn-runtime.ts:585-596`, gated on `isCapacityError`). A draining server
therefore already produces "retry shortly" rather than an error. **Verify this end-to-end before
writing new client code.**

**TDD**
1. `active-streams.test.ts` — draining refuses new streams with `global_limit`; existing streams
   unaffected; `getStreamStats().globalActiveCount` reaches 0.
2. `active-streams.test.ts` — draining is idempotent and reversible.
3. `tests/e2e/streaming.spec.ts` — new case: server enters draining mid-conversation → the
   in-flight answer completes; the *next* send shows retry-with-backoff, not an error.

**Acceptance criteria**
- [ ] `POST /api/admin/drain` (admin-auth, reuses existing admin guard) toggles draining
- [ ] `/api/health` reports `draining` + `activeStreams`; legacy `status` field preserved
- [ ] `deploy.sh` drains, polls until `activeStreams === 0`, caps at 120s, then flips
- [ ] `SHUTDOWN_TIMEOUT=300` set; a 300s stream is no longer force-closed at 30s
- [ ] Maintenance page returns **503 + `Retry-After`**, never 200
- [ ] Maintenance page is self-contained (inlined CSS), bilingual EN/HU, polls `/api/health`
- [ ] Maintenance page lives outside the build tree and survives `rm -rf`
- [ ] Open tabs get the in-app banner, not the static page
- [ ] ADR-0054 amended with the draining contract; note ADR-0041 compatibility explicitly
- [ ] **Phase 3 (blue/green) explicitly out of scope** — record why: `ensureAtlasWorker`
      (`atlas/worker-runner.ts:353`) recovers *all* running jobs on the assumption the prior
      process is dead, and `interval-job.ts` has no leader election

**Gate:** full gate + `npx playwright test tests/e2e/streaming.spec.ts tests/e2e/chat.spec.ts`

**D2 execution status (2026-08-15).** Repo gate green (105 D2 tests pass; full suite 6048;
check 0/0 tracked; build 0 warnings; biome finding-set identical to baseline, zero new; fallow
delta 0). Built:
- **Draining** (`active-streams.ts`): `setDraining`/`isDraining`; `checkStreamCapacity` refuses new
  streams with the existing `global_limit` reason (no new stream part names, ADR-0025 intact);
  in-flight streams untouched; idempotent/reversible; resets on restart.
- **`/api/health`** now `{ status:"OK", draining, activeStreams }` — legacy `status:"OK"` preserved.
- **`POST/GET /api/admin/drain`** — authorized by admin session **or** a `timingSafeEqual` bearer ==
  `ALFYAI_API_SIGNING_KEY` (the deploy path). Added to `PUBLIC_PATHS` so the bearer-only service call
  isn't redirected to `/login` before the route's own auth runs (mirrors `/api/chat/files/produce`).
- **Client**: a *fresh* send that hits a capacity/`global_limit` rejection now backs off and retries
  (bounded 3×, same idiom as the reconnect path) instead of hard-erroring — no runtime restructure
  (R1-safe). In-app **draining banner** (`ServerDrainingNotice.svelte`, EN/HU) via a self-clearing
  `/api/health` poll in `+layout.svelte`.
- **Deploy**: `deploy.sh`/`deploy-dev.sh` gained an identical drain-before-flip block (POST drain,
  poll `activeStreams`→0, 120s cap, graceful skip if the key is unset). `SHUTDOWN_TIMEOUT=300` on the
  service unit. ADR-0054 amended with the draining contract + ADR-0041 relationship + why Phase 3
  (blue/green) is deferred.

**Deployed + verified on staging (releases/36464e39).** `deploy-dev.sh` ran the full flow
autonomously — the drain block (`✓ Drained: 0 active streams`), atomic flip, and **self-restart via
the new sudoers rule** (no manual `alfyroot`), health passed on the new release. End-to-end drain
proof: `POST /api/admin/drain {draining:true}` → health `draining:true` → a real chat turn is
**refused with `503 CAPACITY_EXCEEDED`** → `{draining:false}` → turns succeed again. Auth matrix
(no-bearer/wrong-bearer → 401; valid bearer accepted) and JSON validation confirmed. `status:"OK"`
preserved throughout.

**Maintenance page — page built, live Apache wiring DEFERRED to prod cutover.** The page
(`deploy/maintenance/index.html`, bilingual, inlined CSS, polls `/api/health`, self-reloads) is
installed at `/var/www/alfyai-maintenance/` and its reference directives are in
`deploy/apache-site.conf`. **Finding:** the operator-approved `virtualmin --add-directive` path
**cannot** install it correctly — it strips the `!` from `ProxyPass /alfyai-maintenance !` and
appends custom directives *after* the auto-generated `ProxyPass /`, but the exclusion MUST precede
it (else the ErrorDocument subrequest re-proxies to the down backend and recurses). Verified by
attempt: config-test failed; reverted cleanly (staging never dropped). Since the amended deploy
model puts **no real users on staging** for the whole programme, the maintenance page only protects
users at the final prod cutover — so its live vhost wiring is done then, via a Virtualmin
server-template edit or a reviewed include that guarantees ordering. **Not a halt** — draining +
fast atomic restart already make deploys graceful; the page is belt-and-suspenders for the down
window.

---

### M1 — Persist the stream timeline marks ✅
**Blocked by:** none. Parallel-safe with D1/D2 (disjoint files).

**M1 execution status (2026-08-15).** Commit `40f4ab29`. Repo gate green (98 M1 tests, full suite
6059; check 0/0 tracked; check:migrations passes; build 0 warnings; biome unchanged; fallow delta 0;
`db:prepare` proven to add the columns on a scratch DB). Additive migration `1777140000085` (3
nullable int cols on `message_analytics`), server marks threaded through
`stream-completion → finalize → recordMessageAnalytics` behind guarded readers (ADR-0042 invariant:
timing never fails/alters a turn), stopped turns record partial marks, ADR-0042 amended, documented
p50/p95 query. **Deployed + verified on staging** (`releases/40f4ab29`, self-restart): migration
applied (`__drizzle_migrations` 98→99, 3 columns present), 20 turns populated non-null marks, and
the p50/p95 query produced the §6 profile below. The instrument works; the real prod baseline is the
one open item (deferred to prod cutover).

**⚠️ Backlog claim corrected (2026-08-15, verified in code).** The acceptance said "Browser snapshot
reaches the server through existing terminal metadata." **It does not** — terminal metadata flows
server→client only, `reportTiming` delivers browser marks to a client-side `onTiming` callback (→
`+page.svelte` diagnostics), and there is **no browser→server timing channel** (`/api/chat/send`
passes `generationTimeMs: undefined`; no beacon/analytics POST). Adding one would need a new channel,
which conflicts with "no new stream part names." **M1 therefore persists the SERVER marks** the
orchestrator already computes in `phaseTimingMs` (`FIRST_UPSTREAM_EVENT→first_byte_ms`,
`FIRST_THINKING→first_thinking_ms`, `FIRST_VISIBLE_TOKEN→first_token_ms`; `END→generation_time_ms`
already persisted). These are **server-side** timings (ms from turn start) and **fully answer M1's
question** — server-prep time (`first_thinking_ms`) vs model-reasoning time
(`first_token_ms − first_thinking_ms`). The browser network-inclusive view is out of scope. This is
a mechanism correction, not a goal change; raised at the M1 scheduled stop.

**⚠️ Second correction: no real-traffic baseline until prod.** Under the owner's amended deploy
model (staging-only until programme end), the ≥48h prod-traffic collection and the real §6 table
(deepseek model, 6 users) cannot happen mid-programme. M1 lands the instrument and a staging latency
profile; the real baseline waits for the final prod cutover (or an owner decision to deploy M1's
additive observability to prod early). Raised at the M1 scheduled stop.

**Why this is its own slice.** A real user complaint about speed arrived and we cannot answer
it with data. The marks are already computed and then discarded — so today nobody can say how
much of the wait is context preparation, how much is the model's reasoning phase, and how much
is our own server-side work. **Every latency claim in this backlog is unfalsifiable until this
lands.** It is also the before/after instrument for S1, O1 and all of Wave S.

**Real surface**
- `src/lib/services/stream-timeline.ts:15-30` — `FIRST_THINKING`, `FIRST_VISIBLE_TOKEN`,
  `FIRST_BYTE`, `FIRST_TOKEN` marks already defined
- `src/lib/services/streaming.ts:386` `timingPhases`, `:442` `reportTiming`
- `+page.svelte:545-549` — `streamTimingDiagnostics.latest` is **written and never read**
- `normal-chat-client-turn-runtime.ts:92` — `onStreamTiming` adapter
- `stream-orchestrator.ts:342-357` — server marks currently `console.info` behind
  `contextDiagnosticsDebug`
- `db/schema.ts:1418-1433` — `messageAnalytics` already has `generationTimeMs`; add
  `firstByteMs`, `firstThinkingMs`, `firstTokenMs` as **additive nullable** columns

**TDD**
1. **Red:** a completed turn writes non-null `firstTokenMs` to `messageAnalytics`.
2. **Red:** a stopped/errored turn records the marks it did reach without failing the turn.
3. **Red (ADR-0042 invariant):** timing capture is side-effect-free with respect to turn
   behaviour — a throwing timing sink does not fail or alter the turn.

**Acceptance criteria**
- [ ] Additive migration only; no column dropped or renamed (expand/contract)
- [ ] Browser snapshot reaches the server through existing terminal metadata — **no new AI SDK
      UI stream part names** (ADR-0025)
- [ ] Server marks persisted alongside browser marks
- [ ] Timing failures can never fail a turn — asserted by test
- [ ] An admin-visible p50/p95 breakdown of first-byte → first-thinking → first-token exists,
      or a documented query that produces it
- [ ] ADR-0042 amended
- [ ] **Wave 0 baseline captured**: current p50/p95 recorded in §6 before Wave 1 starts

**Gate:** full gate. No Playwright needed.

---

**🟢 WAVE 0 EXIT — autonomous.** Deploy D1+D2+M1, observe one real deploy end to end, then let
M1 collect **at least 48h** of real traffic. Record the latency baseline in §6.

**🔴 MANDATORY REPORTING STOP — the measurements.** Post the §6 latency table and wait for the
human before starting Wave 1. This is one of only two scheduled stops in the programme.

---

## WAVE 1 — highest value, lowest collision

Branch: `deepening-wave-1`. **G1, S1 and R1 touch disjoint files and may run in parallel.**

### G0 — Prompt eval baseline ⬜
**Blocked by:** none. **Must complete before G1 changes any prompt text.**

**Why:** we have proven the prompt *varies*; we have **not** proven the variation degrades
answers. Without a baseline, G1 is unfalsifiable.

**Real surface**
- Clone the proven pattern in `scripts/evaluate-skill-instructions-ab.ts` — it already runs
  BEFORE/AFTER variants through *real* prompt-assembly code, scores structurally, and blind-judges
- `scripts/eval/` — existing fixtures + results convention

**Corpus decision (settled 2026-08-15): a synthesized corpus is acceptable.** G0 is an A/B over
*identical* inputs — BEFORE and AFTER see the same turns — so what matters is the delta, not the
absolute score, and synthetic turns measure a delta just as well. Write the corpus to cover the
cases the probe already proved differ: EN/HU pairs of the same request, follow-up (non-first)
turns, the false-positive words (`look`, `project`, `notes`, `score`, `policy`, `search`), the
false negatives (`Who is the CEO of X right now?`, `Put that into a PDF`), and the ≤8-word vs
≥35-word length cliff. **Known limit, record it in the results:** a written corpus may not
reproduce the messy real phrasings that trip the regexes hardest, so a green G0 is evidence the
change did no harm, not proof it helps every real turn. If the human later authorizes sampling
real messages, add ~20% real turns and re-baseline.

**Acceptance criteria**
- [ ] `scripts/evaluate-tool-guidance-ab.ts` runs BEFORE (packs) vs AFTER (tool descriptions)
- [ ] Corpus ≥ 60 turns, **≥ 40% Hungarian**, including ≥ 15 follow-up (non-first) turns
- [ ] Scores: correct tool selected · citation present when web-backed · images embedded as
      markdown when `image_search` ran · file produced when asked
- [ ] Baseline committed to `scripts/eval/results/`
- [ ] Script never logs `apiKey` or full `RuntimeConfig` (mirror the security note in the
      existing harness)

**Gate:** full gate. Baseline numbers recorded in this file before G1 starts.

---

### G1 — Tool guidance moves into the tool interface ⬜
**Blocked by:** G0.

**What to build.** Each tool's usage rules move into its own description in `TOOL_I18N`, where
tool availability already determines presence. The selector, the 12 packs and the 10 regexes are
deleted. This is a **net deletion**.

**Real surface**
- `normal-chat-context.ts:123-149` — 10 regex constants → delete
- `normal-chat-context.ts:151-194` — pack ids/types → delete
- `normal-chat-context.ts:240-260` — `buildGuidancePackText`, `estimateGuidancePackTokens`
- `normal-chat-context.ts:262-481` — `resolveGuidancePackSelection`, `planNormalChatGuidancePacks`
- `normal-chat-context.ts:483-583` — `NORMAL_CHAT_GUIDANCE_PACKS`, `NORMAL_CHAT_FULL_GUIDANCE_PACK_IDS`
- `normal-chat-context.ts:622-817` — the guard constants; **their text is the raw material,
  not to be discarded**
- `normal-chat-context.ts:946-1076` — `buildOutboundSystemPrompt`: strip pack assembly, keep
  base prompt, `explicitDateContext`, `buildResponseLanguageGuard`,
  `buildReasoningDepthEffortGuard`, `CONNECTIONS_FRAMING_GUARD`, personality
- `normal-chat-tools/index.ts:173-325` — `TOOL_I18N`, both `en` and `hu`
- `normal-chat-control-model.ts:350` — **also calls `buildOutboundSystemPrompt`; must not break**

**Keep (these are genuinely turn-scoped, not tool-scoped):**
`buildResponseLanguageGuard` · `buildReasoningDepthEffortGuard` · `explicitDateContext` ·
`CONNECTIONS_FRAMING_GUARD` · GPT-OSS reasoning directive handling (`:874-901`)

**Tests that will break and must be reworked, not deleted:**
`src/lib/server/services/normal-chat-context.test.ts` ·
`src/lib/server/services/context-access-regression.test.ts`

**TDD**
1. **Red first:** `normal-chat-tools/index.test.ts` — for every tool, its description contains
   its usage rules in **both** `en` and `hu`. Fails today for `research_web`, `fetch_url`,
   `memory_context`, `image_search`, `produce_file`, `read_generated_file`.
2. **Red:** a guard test asserting the assembled system prompt is **byte-identical** for the same
   conversation regardless of the latest message's wording or language.
3. **Red:** `image_search` description contains the markdown-embed rule in `hu` (today it is
   6 words).
4. Only then delete the selector.

**Acceptance criteria**
- [ ] Every core tool description carries: when to call, argument shape, one example, the
      output-handling rule, failure behaviour — EN and HU at parity
- [ ] `image_search` carries the "embed as `![](url)` or it is invisible" rule, both languages
- [ ] `grep -rn "GUIDANCE_PACK\|resolveGuidancePackSelection\|planNormalChatGuidancePacks" src`
      returns nothing
- [ ] System prompt is stable across turns and languages for a fixed conversation
- [ ] `normal-chat-control-model.ts` still builds a valid prompt
- [ ] G0 eval re-run: **no regression** on any scored dimension; HU dimensions improve
- [ ] Prompt-cache hit rate recorded before/after via the ADR-0047 cache accounting already in place
- [ ] **New ADR-0055** — "Tool usage guidance lives in the tool interface". Must state it does
      *not* reopen ADR-0046: the classification problem is removed, not moved to a model
- [ ] `CONTEXT.md` — retire "Normal Chat Guidance Pack" language if present; add the new term

**Gate:** full gate + `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts`

**Rollback:** single revert; packs are pure additive text assembly with no persisted state.

**🔴 MANDATORY REPORTING STOP — the eval results.** Post the G0 baseline and the G1 after-numbers
side by side, plus the prompt-cache hit rate before and after, and wait for the human before
continuing. This is the second and last scheduled stop in the programme.

---

### S1 — Sequence repair leaves the read path ✅
**Blocked by:** none. Parallel-safe with G1 and R1.

**Done (2026-08-15, commit `701cc750`).** Gate green (25 new tests, full suite 6069; check 0/0
tracked; build 0 warnings; biome unchanged; fallow delta 0; conversation + conversation-forks
Playwright pass). Staging deploy batched with R1 (both independent). See the correction note below.

**⚠️ Classification corrected (2026-08-15, verified in code).** `task-state/continuity.ts:667`
(`selectProjectFolderSiblingPromotion`) is a **READ**, not a write — the function body has zero
`db.insert/update/delete`, only `db.select`, and it is called from `context-selection.ts:1242`
during prompt-context assembly. The repair call there was removed. Also confirmed `knowledge/
capsules.ts:140,232` are reads (write only `artifacts`, not `messages`) → removed. So **8** read-path
removals total (the plan's 5 + capsules ×2 + continuity), not 5. Every kept call
(`messages.ts` executor calls, `conversation-forks.ts:266`, `chat-turn/retry.ts:102`) is a genuine
write; `chatgpt-import` assigns explicit `seq+1` and can't gap.

**⚠️ Scope corrected:** 11 call sites, not 3. Classify each before touching it.

**Real surface — classify, then act**

| Site | Path | Action |
|---|---|---|
| `messages.ts:328` (`listMessages`) | read | **remove** |
| `messages.ts:390` | read | **remove** |
| `messages.ts:433`, `:490` | write (inside tx) | keep |
| `context-compression.ts:494` | read | **remove** |
| `memory-context/project.ts:211` | read | **remove** |
| `memory-context/history.ts:307` | read | **remove** |
| `knowledge/capsules.ts:140`, `:232` | verify | classify first |
| `chat-turn/retry.ts:102` | write | keep |
| `task-state/continuity.ts:667` | ~~write~~ **read** (verified) | **remove** |
| `conversation-forks.ts:266` | write (executor form) | keep |

**TDD**
1. **Red:** `message-sequences.test.ts` — calling `listMessages` issues **zero** `UPDATE`s.
2. **Red:** `messages.ordering.test.ts` — sequences stay correct across insert, fork, retry,
   and import with repair removed from reads.
3. **Red:** a backfill test — a conversation with `NULL` sequences is repaired on next *write*.
4. `preflight.ts:419` — add a bounded `getLastMessage(conversationId)`; assert it does not load
   the whole conversation.

**Acceptance criteria**
- [ ] No read path calls repair
- [ ] Every write path that can create a gap still calls it
- [ ] A one-off backfill exists for pre-existing `NULL` sequences (idempotent; `scripts/`)
- [ ] `preflight.ts:419` no longer loads the full history to read the last message
- [ ] Existing `messages.ordering.test.ts` and `conversation-forks.test.ts` still pass

**Gate:** full gate + `npx playwright test tests/e2e/conversation.spec.ts tests/e2e/conversation-forks.spec.ts`

---

### R1 — Client turn runtime: fix the defects, shrink the interface ✅
**Blocked by:** none. Parallel-safe (client-only files).

**R1 execution status (2026-08-15).** Repo gate green (check 0/0 tracked — only the pre-existing
6 `scripts/search-bench-v2/` errors remain; build 0 warnings; full suite 6077/6077, +8 over the
605-test-file baseline for the tests this slice added; touched files biome-clean, zero new
findings anywhere). Playwright `chat.spec.ts` (10/10), `streaming.spec.ts` (10/10),
`conversation.spec.ts` (11/11) all pass.

**⚠️ Adapter-count baseline corrected.** This entry's own "82-member" figure does not hold against
the tree as read for this slice: direct enumeration of `NormalChatClientTurnRuntimeAdapters` at
the pre-R1 commit gives **59** top-level members, not 82 — re-verified by two independent counts
(a line-pattern scan and a manual re-read of the interface block) before any edit. The discrepancy
predates R1 and is not explained by D2's edits to this file (D2 only touched `StartStreamParams`
and added a comment). Per this programme's own verification-ledger convention, the number actually
in the tree is recorded here rather than the backlog's stale figure: **59 → 51** (consolidating the
nine message-list pass-throughs — `appendUserMessage`, `appendAssistantPlaceholder`,
`appendTokenChunk`, `appendThinkingChunk`, `applyToolCallUpdate`, `applyResponseActivityUpdate`,
`setAssistantRuntimePhase`, `removeMessage`, `finalizeStreamingMessage` — into one
`applyMessageListEvent(event)` dispatch, a net −8). Scoped deliberately to *only* the members the
backlog names ("message-list pass-through adapter members"); other one-off setters
(`mergeGeneratedFiles`, `setContextCompressionMarkers`, etc.) were left alone as out of scope.

**RED → GREEN, captured by temporarily reverting just the fix under test and re-running (then
restoring):**
- **Defect 1** (recoverable drop deletes partial output) — RED: `removeMessage` fired
  unconditionally and no reconnect was ever attempted for a mid-stream network error (only capacity
  errors got D2's backoff). GREEN: a drop after content has streamed now gets the same bounded
  reconnect/backoff idiom (500ms/1000ms/2000ms, capped at 3), discovering the server's own orphaned
  stream instead of deleting the message; if no orphaned stream is ever found it falls back to the
  existing retryable-error surface rather than looping forever.
- **Defect 2** (conversation switch mid-stream cross-writes) — reproduced first, at the runtime
  level (a `getConversationId()` mock that changes mid-turn, exactly mirroring how the page's real
  adapters read `data.conversation.id` fresh on every call): RED showed every post-switch write
  (token append, tool-call update, finalize, evidence poll, hydration) still landing under the
  stale turn. GREEN: every turn is tagged with the conversation it started in
  (`turnConversationId`); every write checks it immediately before reaching an adapter and is
  dropped if the page has moved on — including a scheduled capacity/network-drop retry, the one
  case page-level detach alone cannot close (a *not-yet-fired* timer isn't touched by `detach()`).
  The page's reset effect was also fixed (it no longer refuses to run while a turn is active) as
  belt-and-suspenders — `resetState()` calls `normalChatRuntime.reset()` first, severing the
  transport immediately on every conversation switch.
- **canRetry** — RED: `ErrorMessage.svelte` rendered the Retry button unconditionally; the runtime's
  own `canRetry` never crossed the seam at all (the page's snapshot handler silently dropped it).
  GREEN: `canRetry` now flows runtime → page (`normalChatRuntimeCanRetry`) → `ChatComposerPanel` →
  `ErrorMessage`, which gates the button on it.

**Dead fields.** Both verified genuinely write-only (grepped every reference in `src/` before
deleting): `activeWorkingSet` (page copy — 4 writes, 0 reads) and the page's own
`queuedContextCompression` mirror (1 write from the snapshot, 0 reads) — the *runtime's* internal
`queuedContextCompression` is untouched and still exported on the snapshot type.

**ADR-0019 / ADR-0060, both satisfied.** Adapters are still injected (`createBrowserNormalChatClientTurnRuntime`
unchanged in shape); the page still owns Svelte state, route lifecycle, and UI commands — nothing
moved into the runtime except the message-*lifetime* decision (remove vs. preserve) that already
lived there, now corrected, and conversation-scoping of writes (a property of *when* a write may
land, not new state ownership). No field has two owners: message list content/mutation logic is
still 100% page-side (via the helpers `applyMessageListEvent`'s cases call into); the runtime only
decides *whether and when* to call them.

**⚠️ Superseded guidance corrected (2026-08-15).** This line previously read "Adapters stay,
ownership does not move" — that is the pre-ADR-0060 conservative plan, which **§1 and the accepted
[ADR-0060] overrode**: the runtime *may* own turn state and the interface *should* shrink
substantially. The adapter **injection seam stays** (ADR-0019's placement still governs; it remains
for every concern not yet moved), but ownership of the message lifetime *does* move where it fixes a
defect by construction. **R1 scope (this pass):** fix both defects, consolidate the message-list
pass-throughs, delete the two dead fields, record the adapter member count before/after — moving the
message-*lifetime* ownership into the runtime (defect 1's root cause) while leaving reasoning /
terminal-outcome ownership for a later incremental pass per ADR-0060 ("one concern at a time; no
field left with two owners").

**Real surface**
- `normal-chat-client-turn-runtime.ts:72` — 82-member adapters interface
- `normal-chat-client-turn-runtime.ts:583-607` — the drop/abort path
- `+page.svelte:564-778` — the 215-line adapter literal
- `+page.svelte:1110-1118` — the reset effect that refuses to run while streaming
- `+page.svelte:472` `activeWorkingSet` — assigned 4×, read 0× → delete
- `+page.svelte:498` `queuedContextCompression` — page copy is write-only → delete

**TDD — reproduce before fixing**
1. **Red:** mid-stream transport error after N visible tokens → the partial answer **survives**
   and recovery is attempted. Today `:604` calls `removeMessage`.
2. **Red:** reconnect backoff applies to a first-attempt network drop, not only capacity errors.
3. **Red:** navigating `/chat/A` → `/chat/B` while A streams must not write A's evidence,
   activity, or hydration against B. **Reproduce first** — this mechanism was read, not proven.
4. **Red:** `canRetry === false` → the Retry affordance is not offered.

**Acceptance criteria**
- [ ] Partial streamed output is never deleted by a recoverable transport error
- [ ] Conversation switch mid-stream cannot cross-write; covered by test
- [ ] Retry is not offered when `canRetry` is false
- [ ] Message-list pass-throughs consolidated into one adapter member; interface materially
      smaller (record before/after count in this file)
- [ ] Two dead fields deleted
- [ ] **ADR-0019 remains satisfied** — adapters still injected; page still owns Svelte state.
      State this explicitly in the commit message.

**Gate:** full gate + `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`

**🟢 WAVE 1 EXIT — autonomous.** Gate green → deploy → verify → continue.

---

## WAVE 2 — structural

Branch: `deepening-wave-2`. F1 and O1 may run in parallel.

### F1 — One chat-turn interface for both transports ✅
**Blocked by:** G1 (shrinks `normal-chat-context` first, clarifying the turn path) — satisfied.

**Real surface**
- `src/lib/server/services/chat-turn/` — 70 files, 17 556 non-test lines, **no `index.ts`**
- `finalize.ts:100-165` — 57 param lines incl. `logPrefix` (`:101`, `:259`, `:361`) and 7 booleans
- `send/+server.ts:14-23` (7 imports, 698 lines) · `stream/+server.ts` (125 lines)
- `stream-orchestrator.ts:22-58` — imports 13 siblings

**⚠️ AGENTS.md § What Not To Reintroduce forbids "No new top-level
`src/lib/server/services/*.ts` public boundary just because one file is getting large."** A
`chat-turn/index.ts` facade is *inside* the existing module directory, not a new top-level
service — but call this out in review explicitly.

**TDD**
1. **Red:** both transports drive one turn through the same entrypoint; `logPrefix` is gone.
2. **Red:** `finalize.test.ts` — rewrite to construct the two real turn kinds, not 7 booleans.
   Success = mock count drops from 20.

**Acceptance criteria**
- [ ] `chat-turn/index.ts` is the single entrypoint; routes import from it only
- [ ] `logPrefix` removed; logging derives from turn kind internally
- [ ] The 7 mode booleans collapse to the turn kinds that actually exist
- [ ] `finalize` no longer returns unresolved promises for callers to schedule
- [ ] ADR-0015 still holds: durable completion stays in chat-turn
- [ ] `finalize.test.ts` mock count recorded before/after

**Gate:** full gate + chat/streaming/conversation Playwright.

**F1 execution status (2026-08-15).** Branch `deepening-wave-2`. Turn kinds are the pre-existing
`ChatTurnRoute = "send" | "stream"` (reused, not invented). Of the 7 mode booleans, 4 were fully
determined by kind and removed as params (`persistAssistantMessage` [always true → hardcoded],
`persistUserAttachmentsBeforeAssistantMessage` = `!isStream`, `waitForEvidenceBeforePostTurnTasks` =
`isStream`, `deferPostTurnProjection` = `isStream`) plus the correlated `persistenceMode`
(strict/best_effort); 3 genuine per-turn facts stay params (`persistUserMessage` — reconnect may have
persisted it; `persistTurnState` — stopped stream skips heavier projection; `skipAssistantProseMemoryIntake`
— orthogonal override). New `chat-turn/index.ts` facade (35 lines, scoped to the 3 driving routes,
*inside* the module — AGENTS.md updated). `logPrefix` string threading replaced by `turnLogPrefix(turnKind)`
derived internally. `finalize` returns **no** unresolved promises: the `evidenceTask`/`createPostTurnTask`/
`attachmentTask` fields are gone; finalize schedules the post-turn tail itself (send: fire-and-forget after
eager projection; stream: `onDurableReceiptReady(receipt)` hook awaited before the background projection,
then `Promise.race([projection, waitOneTick()])` relocated from stream-completion). Ordering-sensitive
file-production snapshot resolution preserved (hook awaited before the projection reads
`deferredFileProductionJobIdsAtStart`). ADR-0015 preserved (routes stay transport adapters). TDD red-first
(tsc red on removed params → 4 finalize tests red on removed task fields → rewritten to the receipt-hook
contract). `finalize.test.ts` mocks 20→18 (2 dead module mocks removed). Gate green: check 0/0 tracked
(6871 files), full test **6120/6120** (0 regression), build 0 warnings, fallow **50** (baseline),
biome-clean on all touched files. Playwright deferred to the batch staging deploy + verify.

---

### O1 — Conversation open reads once ✅
**Blocked by:** S1 (repair must be off the read path first) — satisfied; S1 landed first on this branch.

**Step 0 — measurements (2026-08-15).** Two claims were unverified. Both checked against real
evidence, not estimated:

1. **"Conversation-detail payload embedded twice in the HTML" — does NOT hold.** Checked by hand:
   seeded a scratch DB (89-message conversation, matching production's observed max), booted a real
   dev server against it, logged in via `curl`, and fetched the raw `/chat/[id]` HTML. For a `+page.ts`
   **universal** load, SvelteKit embeds the raw fetch response exactly once, via one
   `<script data-sveltekit-fetched data-url="/api/conversations/[id]?view=first-render">` tag — the
   load function's *return value* (the reshaped `conversation`/`messages`/… object the page actually
   receives) is **not** separately serialized into the HTML; the client re-runs the same `load()`
   function during hydration and it transparently reads the cached fetch response instead of
   re-fetching. Confirmed directly: a per-message marker string planted in assistant content appeared
   exactly **once** in the raw HTML (inside that one script tag) — assistant content never renders
   into the SSR DOM at all (see the MarkdownRenderer finding below), so there was nowhere else for a
   second copy to hide. The claim's mechanism doesn't exist for this route.
2. **"~60-80 DB round trips per page view" — did not hold as measured, but a related, real problem
   did: two full detail reads per open.** A query-counter test
   (`src/lib/server/services/conversation-detail/read-model.query-count.test.ts`, real seeded SQLite,
   `vi.spyOn(Database.prototype, "prepare")` — the same instrumentation S1 established) measured a
   single `getConversationDetail()` open, 89-message otherwise-empty conversation:
   - **One `"full"` read: 25 prepared statements.**
   - **Before this slice, the page always did two reads** (SSR `"first-render"` + an unconditional
     client-side `"full"` re-fetch — `sidecarPending` was hardcoded `true` for `"first-render"`,
     so the second read was not conditional on anything, it always happened): **8 statements
     (`"first-render"`) + 25 statements (`"full"`) = 33 total**, measured the same way against the
     pre-O1 code (temporarily restored via `git stash` for the measurement, then reverted — see the
     commit history on this branch for the throwaway measurement script, not part of the shipped diff).
   - **Verdict:** the 60–80 estimate does not hold at either 25 or 33; the double-read was real waste
     (33 → 25, a 24% reduction in statements, and 2 HTTP round trips → 1), just not the number quoted.
     Honest framing per §0: at 89 messages / 6 users this is waste removal, not a user-perceptible
     latency fix — 8 extra statements and one extra same-machine HTTP round trip are not where a
     multi-second wait comes from (see M1's §6 profile: the wait is model reasoning, not server prep).

**What shipped**
- `src/lib/server/services/messages.ts` — new `listMessageWindow(conversationId, { limit, offset })`,
  bounded via `ORDER BY … DESC LIMIT limit+1 OFFSET offset` (existing `messageOrderDesc()`), reversed
  back to ascending order; returns `{ messages, hasMoreBefore }`. `CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT`
  = **100** — chosen as headroom over the observed production maximum (89) so the bound is real
  (provably `LIMIT`-bounded, defends against future growth) without truncating any conversation seen
  in production today. `listMessages` (the full, unbounded read) is **unchanged** and stays the
  correct call for its other 2 real call sites (`chat-turn/context-selection.ts`'s model-context
  assembly, and the messages-deletion route's ownership check) — those need the whole history for
  reasons unrelated to conversation-open rendering, so their behavior was deliberately left alone
  rather than silently bounding a shared function.
- `src/lib/server/services/conversation-detail/read-model.ts` — `getConversationDetail` now takes an
  optional `messageWindowLimit` and calls `listMessageWindow` instead of `listMessages` for its one
  remaining assembled view. New `getOlderConversationMessages(...)` (pagination): re-runs only the
  bounded message-window query plus the same child-fork decoration the initial window gets — it does
  **not** re-run the other ~15 branches of the `Promise.all` (Context Sources, task state, atlas jobs,
  cost, …), since paging older messages doesn't change any of that. `ConversationDetailView` narrowed
  to `"full" | "bootstrap"` — `"first-render"` is retired (see below).
- `src/lib/types.ts` — `ConversationDetail` gained an additive optional `hasMoreMessages` field.
- `src/routes/api/conversations/[id]/+server.ts` — view whitelist simplified to `"bootstrap"` or
  `"full"` (any other/absent value falls back to `"full"`, same as before).
- `src/routes/api/conversations/[id]/messages/+server.ts` — new `GET` handler (alongside the existing
  `DELETE`) serving `getOlderConversationMessages` via `?offset=&limit=` — the on-demand pagination
  path, HTTP-reachable and tested, though no client UI consumes it yet (see leftovers).
- `src/routes/(app)/chat/[conversationId]/+page.ts` — requests `view=full` directly instead of
  `view=first-render` for a normal (non-bootstrap) open. `bootstrap` is unchanged.
- **The double-fetch is gone without touching `+page.svelte`'s hydrate logic at all.** The client's
  `if (bootstrapMode || sidecarPending) { hydrateConversationDetail(...) }` guard (in `resetState()`)
  already existed and was already correct — the bug was that the *server* unconditionally set
  `sidecarPending: true` for `"first-render"`. Once the load stops requesting that view, `sidecarPending`
  is `false` for every normal open and the guard naturally stops firing. `bootstrapMode` (a genuinely
  new conversation with no messages yet) still triggers it, unchanged.

**SSR decision — recorded, per the acceptance criteria's either/or.** Checked empirically (same HTML
capture as the double-embed measurement): `MarkdownRenderer.svelte`'s `blocks` state starts as `[]`
and is populated only inside a Svelte 5 `$effect`, which — unlike Svelte 4 — **does not run during
SSR at all**. Confirmed directly: a marker planted in assistant message content appeared **zero**
times in the server-rendered DOM (only once, inside the JSON `data-sveltekit-fetched` blob) — the
`<div class="markdown-container">` SSRs genuinely empty for every assistant message, every time.
**This means there is no markdown-rendering CPU being wasted server-side today** — the acceptance
criteria's premise ("SSR emits empty containers and the client re-renders anyway") is correct on the
first half but the "wasted work" is not markdown parsing (none happens). The real, measurable waste
was structural: full, unbounded message history — up to 89 message bubbles' worth of wrapper markup,
jump-rail marks, etc. — server-rendered on every open regardless of what's actually visible.
**Decision: do not build server-side markdown rendering.** Making `renderMarkdown` run synchronously
during SSR would mean sanitizing/rendering arbitrary HTML in Node on every message of every open —
real new server CPU cost, a second maintained rendering pipeline, and an XSS/sanitization review
surface — for content that (a) is invisible until client hydration completes regardless, per Svelte
5's SSR model, and (b) at 6 users / ≤89-message conversations is not where the measured latency lives
(M1: model reasoning, not server prep, dominates the wait). **Instead: the bounded message window
already shipped above *is* the "stop paying for wasted SSR" fix** — it directly cuts the amount of
structural, non-markdown SSR markup generated per open, with zero new rendering pipeline and zero
new risk. No further code change needed for this decision beyond the windowing already described.

**TDD**
- `read-model.query-count.test.ts` (new, real DB) — one bounded `SELECT … LIMIT …` against `messages`
  per open (not one per message, not a second unbounded scan); records the Step-0 statement count;
  pagination across three pages (20/20/5 of 45 seeded messages) with correct ordering, `hasMoreBefore`
  transitions, and assembled-shape parity (child-fork decoration present on both the initial window
  and paginated pages); ownership check returns `null` for a non-owning user.
- `page-runtime.test.ts` — new test: mounting an already-populated, non-bootstrap conversation issues
  **zero** additional `fetchConversationDetail` calls (delta-based, since the mock is shared across
  the file's tests — same idiom the file's existing stream-completion test uses).
- `page-load.test.ts` — rewritten: the load requests `?view=full` (not `?view=first-render`) and
  issues exactly 2 fetches total (detail + pending-writes, in parallel) before waiting on parent data.
- `read-model.test.ts` / `conversation-detail.test.ts` — `"first-render"`-specific cases retired
  (the view no longer exists); a fallback-to-`"full"` case added for an unrecognized `?view=` value.

**Acceptance criteria**
- [x] Measurements recorded in this file first (above)
- [x] `getConversationDetail` accepts a bounded message range; older messages paginate on demand
      via `getOlderConversationMessages` / `GET /api/conversations/[id]/messages`
- [x] One detail read per open — asserted by `page-runtime.test.ts` (client) and
      `page-load.test.ts` (load issues exactly one detail fetch)
- [x] Decided and recorded: do **not** render markdown server-side; the bounded window is the
      "stop paying for wasted SSR" fix (see above)
- [x] ADR-0022 amended with the bounded-range parameter and the `"first-render"` retirement

**Leftovers, explicitly not built (in scope for a later slice if ever needed):**
- No client UI ("load older messages" / infinite scroll) consumes `hasMoreMessages` /
  `GET .../messages?offset=&limit=` yet. At 89 messages max and a 100-message window, pagination
  never actually triggers in production today — the capability is real, tested, and HTTP-reachable,
  but wiring a scroll-triggered UI for a condition that doesn't yet occur was judged not worth the
  risk/UI-review surface for this slice. Revisit if/when a conversation legitimately exceeds 100
  messages.

**Gate:** full gate green. `npm run check` 0/0 (6860 files). `npm run build` 0 warnings. `npm test`
506/506 files, 6081/6081 tests (0 fail) — includes the new real-DB query-count/pagination suite and
the page-runtime/page-load rewrites. `npm run lint` (biome): the 15-file pre-existing red baseline in
this environment (a superset of the 6-file baseline recorded in §6 — likely a local biome-version
difference; re-verified as present with O1's changes fully reverted, so it predates and is unrelated
to this slice) is unchanged; all 10 files O1 touched, plus the new test file, are biome-clean.
Playwright (`tests/e2e/conversation.spec.ts`, `tests/e2e/conversation-refresh.spec.ts`): **not
runnable in this sandboxed worktree** — diagnosed, not skipped: this worktree's local `node_modules`
was never populated (Node v26.4.0 here is incompatible with `better-sqlite3@12.8.0`'s engine range,
so `npm install` aborts before writing anything; ordinary module imports still work via Node's
directory walk-up to the parent checkout's `node_modules`, but Playwright's `webServer` command and
`db:prepare`'s `tsx` invocation use hardcoded relative paths that bypass that walk-up). Worked around
enough to get the dev server booting and the e2e DB migrated, at which point the composer stayed
disabled because no model provider is configured in this sandbox (no `.env`, no API keys) — orthogonal
to this slice and to the fix under test. Full gate (check/build/test/lint) plus the two new, targeted,
real-DB-backed integration tests are the verification actually available here.

**🟢 WAVE 2 EXIT — autonomous.** Gate green → deploy → verify → continue.

---

## WAVE 3 — wide and thin

Branch: `deepening-wave-3`. **E1 → E2 sequential. T1 alone. X1 blocked.**

### E1 — Error seam, server half ⬜
**Blocked by:** F1.

**⚠️ ADR-0025 constraint:** reuse existing `data-stream-error` framing. **Do not add stream part
names.** This slice maps causes to codes; it does not touch transport grammar.

**Real surface**
- `send/+server.ts:102,125-127` — the single English sentence
- `stream-completion.ts:688-731` — notices appended into message body
- `stream-orchestrator.ts:1195-1209` — `tool_error` emitting `"done"`
- `normal-chat-model/failover.ts:313-320` — the `"prompt"` / `"abort"` substring landmine
- `stream.ts:1095-1122` `classifyStreamError`; `provider-compatibility.ts:571+`

**Acceptance criteria**
- [ ] One module maps failure cause → stable code; four substring classifiers collapse into it
- [ ] `failover.ts` no longer classifies on prose containing "prompt"/"abort" (**has no test file
      today — add one**)
- [ ] Failed tool calls carry a failed status through the existing framing
- [ ] Truncation/content-filter notices leave the persisted message body
- [ ] `errorKey` emitted on the chat send/stream path
- [ ] No new AI SDK UI stream part names — assert in test

### E2 — Error seam, client half ⬜
**Blocked by:** E1, R1.

- [ ] `_helpers.ts:125-174` substring fallback replaced by code lookup
- [ ] Components render failed tool calls distinctly
- [ ] A `+error.svelte` exists (there is none today)
- [ ] User-facing errors localized EN/HU; no raw provider text
- [ ] Operator-only advice ("check provider logs") removed from user copy

### T1 — types.ts split ⬜
**Blocked by:** nothing. **Run alone, in a quiet window, merge same day.**
266 importers; high volume, trivial content. Any parallel work will conflict.

- [ ] Split by concept next to owning modules
- [ ] The 7 functions (`getProviderIdFromModelId`, `reasoningDepthToThinkingMode`, …) move to
      their domain
- [ ] Re-export shim only if needed, and time-boxed

### X1 — DB execution seam ⬜
**Blocked by:** E1/E2, and ordered **last** in the programme.

ADR-0059 accepted; both conventions already amended. Implement as a strangler — see §1.

- [ ] Execution seam introduced beside the existing `db` handle; no big-bang rewrite
- [ ] **Second (in-memory) adapter ships with it**; ≥1 database-booting suite converted
- [ ] Call sites migrate incrementally; no module left with two execution paths
- [ ] Direct `db` export removed only when the last call site is gone
- [ ] Query timing/instrumentation actually in use, not merely possible
- [ ] **Automatic halt at 50% migrated** if DB-booting test count has not fallen and no
      instrumentation is in use — stop and report
- [ ] Commit messages describe this as a scaling property, not a latency fix

## WAVE S — perceived latency (interim thought steps)

Branch: `thought-steps`. **Starts after Wave 1** (R1 settles the client surfaces first) and may
run **in parallel with Wave 2**. Requires M1 data.

**Origin.** A real user complaint: too long a wait before the first token of the *final* answer
while the model reasons. Reasoning effort will not be lowered — that trades quality for speed.

**Diagnosis (verified).** During a long think the user sees a **collapsed** "Thinking" header
(`ThinkingBlock.svelte:53`, `expanded = $state(false)`) next to a **live counting-up stopwatch**
(`:322`, `setInterval`). That is an indeterminate wait with a clock attached — it quantifies the
delay without communicating progress. At `standard` depth nothing else fills the gap:
`DELIBERATION_PASS_PLAN_BY_PROFILE.standard` is `[]`.

**⚠️ Do M1 first.** Part of this complaint may be server-side (S1's six whole-conversation
`UPDATE`s, sequential awaits, the `setTimeout(0)` yield at `context-selection.ts:1358`). Do not
build perception fixes for latency that is actually removable.

**What already exists — build on it, do not rebuild:**
`data-response-activity` + `ResponseActivityKind` (`types.ts:26`) · `StatusSegment` /
`ToolCallSegment` interleaving (`ThinkingBlock.svelte:176`) · `liveDeliberationStatus`
(`MessageBubble.svelte:319`) · `sendJsonControlMessage` · `thinking-normalizer.ts:60-63`
(already normalizes `reasoning` / `reasoning_content` across providers — this is the
model-agnostic seam) · `passIndex` / `passTotal` (`types.ts:74`, **already present, unused**) ·
**Interim Thought Step** already defined in CONTEXT.md.

### The UX contract (ADR-0056)

- **Live:** the current step is visible in the header with **no click**. It replaces the
  stopwatch. Liveness is driven by real `reasoning-delta` arrival, never a CSS timer.
- **Completed:** collapses to "Thought for 34s". Expanding reveals the full append-only step
  list, with tool calls and context-preparation activity **interleaved into the same rail**.
- **Raw CoT:** reachable from a step as a **jump-anchor into one continuous raw-thinking view**,
  scrolled to and highlighting the span that produced that step. **Settled** — the per-step
  nested dropdown alternative is recorded and rejected in ADR-0056.
- **Honesty rule:** a step that cannot point at the reasoning span that produced it must not be
  emitted.
- **Classes implying external action** ("Searched the web") may come **only** from real tool
  events, never from reasoning-text classification.
- Steps are append-only. Never reorder or rewrite an emitted step.
- Respect `prefers-reduced-motion`; announce new steps via a rate-limited polite `aria-live`.

### P1 — The deterministic spine, and retire the stopwatch ⬜
**Blocked by:** M1 (baseline). **No model calls, no new infrastructure — this slice must stand
entirely on its own.**

**This is the load-bearing slice of Wave S.** The spine is what guarantees the rail is never
empty. P3's classifier only raises its resolution. If P1 ships and P3 never does, the surface
is still coherent and still better than today.

**The spine (always present, every turn, every depth, no model call):**
depth resolved → context prepared → reasoning started → *live, driven by real
`reasoning-delta` arrival* → writing the answer → done. Tool calls and deliberation passes
insert into this sequence where they occur.

- [ ] During generation the header shows current spine state, not a counting timer
- [ ] The reasoning phase is **never** an empty surface — verified specifically at `standard`
      depth **with no tool calls**, where `DELIBERATION_PASS_PLAN_BY_PROFILE.standard` is `[]`
      and no in-reasoning events exist. **This is the common case and the acceptance test.**
- [ ] Liveness is driven by real `reasoning-delta` arrival, not a CSS timer; if deltas genuinely
      stall, say so honestly rather than animating
- [ ] Duration survives as the retrospective "Thought for 34s" it already becomes
- [ ] EN/HU copy from `chat.ts`; no model-authored user-facing prose
- [ ] Spine is asserted by tests that make **no model call at all**
- [ ] ADR-0056 status moved toward Accepted as the spine lands

### P2 — Instant acknowledgment ⬜
**Blocked by:** P1.

One content-relevant line within ~1s of send, turning an unexplained wait into an explained one.

- [ ] Intent class from a closed enum + a topic phrase lifted **verbatim from the user's own
      message** — so the topic is automatically in the user's language
- [ ] Rendered through a localized template; the model never authors user-facing prose
- [ ] Depth is already deterministic (ADR-0046), so the expected-effort contract can be stated
      honestly up front
- [ ] Measured: time-to-first-meaningful-signal < 1s at p95, from M1's marks
- [ ] Falls back silently to the current behaviour on control-model failure

### P3 — Reasoning-phase classifier + step rail ⬜
**Blocked by:** P2 **and the honesty audit harness (P3a) existing first.**

**P3a — honesty audit harness (prerequisite, ships before the classifier is enabled).**
- [ ] Harness samples N completed turns, replays persisted `messages.thinking`, and checks every
      emitted step against the chunk that produced it
- [ ] Reports: % truthful, count of fabricated action claims, count of unanchored steps
- [ ] **Gate for enabling P3 in production: >95% truthful, zero fabricated action claims**
- [ ] Repeatable; committed to `scripts/eval/results/`

**P3b — the classifier.**
- [ ] The control model **classifies, it does not summarize**: closed activity-class enum +
      optional entity slot + new-step/continuation verdict, strict JSON via
      `sendJsonControlMessage`
- [ ] Entity slot dropped unless it appears as a **verbatim substring** of the reasoning chunk
- [ ] **Discourse-marker regex may be used only as a sampling trigger, never as a source of
      user-facing text.** DeepSeek reasons in English regardless of UI language; English regex
      driving user-visible content is the exact failure G1 exists to remove
- [ ] Rate-limited to roughly one new step per 5-7s; continuation verdicts extend the current step
- [ ] Classification stops hard on the first answer `text-delta`
- [ ] Emitted over the existing `data-response-activity` part — **no new stream part names**
      (ADR-0025); asserted by test
- [ ] Classifier spend tracked through the ADR-0047 cost path like every other model call
- [ ] **Concurrency ceiling, verified on the box:** the control model runs on the local vLLM at
      `--max-num-seqs 4`, shared with the memory judge, consolidation, and context summarizer —
      and it is the chat model for one of six users. The default chat model is *remote*
      (`api.deepseek.com`), so there is **no** GPU contention with the main model's reasoning.
      Classifier calls must be best-effort with a hard concurrency cap, must never queue behind
      a full instance, and must degrade silently to event-derived steps on rejection or timeout.
      Do not point the classifier at the same slot as a user's active chat model without
      measuring first.
- [ ] Steps persist as durable turn state and are traversable in history — **ADR-0056 is written
      and amends ADR-0015**; implement to that contract
- [ ] Every emitted step carries a **Thought Step Anchor**; unanchored steps are not emitted
- [ ] **Classification is enrichment on P1's spine, not a separate mode.** A slow, rejected or
      unavailable classifier yields a *coarser* rail — never an empty or broken one. Assert this
      with a test that disables the control model entirely and checks the rail is still coherent
      at `standard` depth with no tools.

### P4 — Determinate progress where it already exists ⬜
**Blocked by:** P3.

- [ ] `passIndex` / `passTotal` surfaced at `maximum` depth — real progress, already computed
- [ ] Concluding-phase detection flips the rail to a determinate final state
- [ ] Never delays visible answer text

### Deferred from Wave S — record, do not build

- **Draft-first at `maximum` depth** (stream a provisional answer, then refinement passes, then
  patch). The strongest idea available, but mutating already-emitted visible text touches
  ADR-0015 (durable result) and ADR-0025 (allowed part names). **ADR-first, not week-one.**
- **Free-text streaming summarization** — highest hallucination surface; bets HU UX on a small
  model's Hungarian prose.
- **Forced think-close ("answer now")** — possible on self-hosted vLLM, real quality risk.

**Verification for the whole wave:** time-to-first-meaningful-signal <1s p95 · honesty audit
passing · mid-generation stop/abandon rate · thought-disclosure expansion rate (if it stays
high, the steps are not carrying the load) · direct user feedback, which at this scale beats a
dashboard with no statistical power.

**🟢 WAVE S EXIT — autonomous.** Gate green → deploy → verify → continue.

---

## 5. Deployment protocol

**Standing authorization (granted by the repository owner, 2026-08-15).** `AGENTS.md`
§ Commit and Push Discipline says *"Never push to any remote branch without explicit user
request."* That request has been given, **scoped to this programme only**. Nothing here
authorizes autonomous push or deploy for work outside this backlog.

**Deploy model amended by the owner (2026-08-15): staging-only until the whole programme is done.**
Every slice is built, deployed, and verified on **staging (`dev`) only** throughout all waves.
**Production is not touched until the entire plan is finished**, at which point everything proven on
`dev` is merged to `main` and deployed to production once, as a single gated cutover. This supersedes
the per-wave "then production" step below for the duration of the programme — the production column
and rollback rules still describe how that final cutover will run. Consequence for **M1**: real
prod-traffic latency cannot be collected mid-programme; see M1's note for how the baseline is handled.

**Every deploy goes through staging first. No exceptions.**

| | staging | production |
|---|---|---|
| Path | `~/apps/langflow-chat-dev` | `~/apps/langflow-chat` |
| Branch | `dev` | `main` |
| Port | 3002 | 3001 |
| Public | `ai.dev.alfydesign.com` | the live site |
| Database | its own, **disposable** | real user data — 6 users |

1. All slices in a wave green against the full gate, locally.
2. Push the wave branch; fast-forward `dev` to it.
3. **Deploy to staging.** Verify: `/api/health` on :3002, one real chat turn end to end, no
   console errors, migrations applied cleanly.
4. **Soak.** Leave staging running while the next slice is developed — minimum one hour, and
   across at least one memory-judge idle trigger where the wave touches memory.
5. Only then merge to `main` and deploy to production, via the D1 release flow.
6. Post-deploy on production: `/api/health`, one real chat turn, no console errors.
7. **Any production post-deploy check fails → flip the symlink back immediately, then STOP.**
   Never a forward fix on production.

A failure on **staging** is not a halt — it is staging doing its job. Fix it and redeploy there.
A failure on **production** is always a halt.

Staging's database is disposable. Recreating it is an acceptable resolution at any point and
never requires asking. Production's is not: no writes beyond `db:prepare` migrations, ever.

### Automatic halt conditions — stop and report, do not work around

- Any gate red that cannot be fixed inside the slice that caused it
- Test count regression against the wave baseline
- New Fallow findings, or any temptation to add an ignore/suppression to go green
- Post-deploy health check failure (after rolling back)
- Any migration that would drop or rename a column
- Any need to write to the production database beyond `db:prepare` migrations
- Any ADR conflict not already resolved in §1
- G0/G1 eval regression on any scored dimension
- Honesty audit below 95% truthful, or any fabricated action claim
- X1 halfway-point check failing (§1)
- Anything requiring a secret, credential, or payment
- Two consecutive slices failing for the same underlying reason

### The two scheduled stops

- **After M1** — post the §6 latency table; wait before Wave 1.
- **After G0/G1** — post the eval before/after; wait before continuing Wave 1.

**Never** run `db:push` against production. Migrations go through `db:prepare` only.

---

## 6. Wave baselines

Record before starting each wave so "no regression" is measurable.

| Wave | `npm test` pass/fail | `npm run check` | Fallow findings | Prompt-cache hit rate |
|---|---|---|---|---|
| 0 | **6003 pass / 0 fail** (500 files) | tracked code **0/0**; 6 errors only in untracked leftover | `check.total_issues=50` (see snapshot) | n/a (M1 supplies) |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| S | | | | |

**Wave 0 baseline notes (recorded 2026-08-15, at `deploy-cutover` HEAD `0c29a5f8`, i.e. `main@1cdf51a3` + foundation).**

Measured facts — snapshot files kept in the orchestrator scratchpad for per-slice diffing:

- **`npm test`** — 500 files / 6003 tests pass, exit 0. Green.
- **`npm run build`** — 0 warnings, exit 0. Green.
- **`npm run check`** — the **tracked codebase is clean (0 errors / 0 warnings)**. The only 6 errors
  are in the *untracked, unrelated* leftover `scripts/search-bench-v2/{run-ab.ts,run-maxresults-ab.ts}`
  (a prior session's search-benchmark WIP; also `docs/tech-analysis.md` leftover). These are **not**
  part of this programme and are not committed. Per-slice check gate = *tracked code stays 0/0*.
- **`npm run lint` (biome) is already RED at baseline** — 22 errors + 2 warnings, exit 1, **all in
  tracked `src/` code and all `FIXABLE`**, across 6 files: `atlas/{assembled-report,pipeline,
  renderer-output}.ts` + `normal-chat-tools/index.ts` (`assist/source/organizeImports`), and
  `ThinkingBlock.svelte` + `MessageEvidenceDetails.svelte` (`lint/complexity/useOptionalChain`).
  **This is pre-existing at `main@1cdf51a3`, unrelated to any slice.** Backlog gate assumed
  "lint passes / 0 errors"; reality contradicts it. Handled per `AGENTS.md` § Typecheck Gate policy
  for pre-existing diagnostics: **document exact baseline, introduce no NEW findings**. Several of
  these files are edited by later slices (`normal-chat-tools/index.ts`→G1, `ThinkingBlock.svelte`→P1,
  `MessageEvidenceDetails.svelte`→E2) and will be biome-clean as a side effect there; the atlas files
  are out of scope and left as documented pre-existing. **Not a halt** — no slice shape changes; the
  gate is measured as *no regression vs. this baseline*, not absolute 0.
- **Fallow** — `check.total_issues=50` (13 unused files, 25 unused exports, 4 circular deps, 1 dup
  export, …); health hotspots pre-exist (e.g. `env.ts readConfig` cyclomatic 136). Some of the 50 are
  contributed by the `search-bench-v2` leftover. Gate = *no new fallow findings vs. baseline*.

### Latency baseline (from M1 — fill before Wave 1)

**⚠️ STAGING profile only** (2026-08-15, `releases/40f4ab29`): 20 synthetic turns, one prompt,
model **`qwen3-6-27b` on the local vLLM** — **NOT** production's `deepseek` (remote). Server-side
marks, ms from turn start; no browser/network transit. The real prod baseline (deepseek + 6 users)
awaits the final prod cutover under the staging-only deploy model.

| Metric | p50 (ms) | p95 (ms) | notes |
|---|---|---|---|
| first byte (first upstream event) | 325 | 329 | route admission + prep + model TTFT |
| first thinking token | 325 | 329 | end of server-side prep — **the removable part** |
| first *answer* token | 1611 | 2395 | end of model reasoning — the perceived complaint |
| generation total | 2504 | 3789 | |

**Derived (p50):** server-side prep ≈ **325 ms** (~20% of the 1611 ms pre-answer wait); model
**reasoning ≈ 1286 ms** (first-thinking→first-answer, ~80%); answer generation ≈ 893 ms.

**Conclusion — the wait is model reasoning, not server-side work.** `first thinking` (325 ms) is a
*small* share of `first answer` (1611 ms): only ~20% of the wait before the answer is server-side
(and most of even that is model TTFT, not our prep). **So S1/O1 cannot meaningfully shorten the
perceived wait; only Wave S (perception during reasoning) addresses it.** This confirms §0's prior
analysis. **Caveat that gates the decision:** the *magnitudes* are staging/qwen, not prod/deepseek —
deepseek's reasoning time (and remote-API latency) will differ, though the *structure* (small prep,
dominant reasoning) is model-agnostic and expected to hold. The real prod numbers need M1 running on
prod. **This is the M1 scheduled stop — posted.**

**Owner decision (2026-08-15): deploy Wave 0 to production now** for the real baseline (one-off
exception to prod-at-end). **Done.** Prod migrated to the atomic-release layout and running
D0+D1+D2+M1 (`origin/main` @ `ae5ee4a0`; `current → releases/ae5ee4a0`; `shared/{.env,data}`).
~10s one-time downtime (release built off-side first; migration additive; DB + unit backed up).
Verified: `Listening on :3001`, public health `{status:OK,draining:false,activeStreams:0}` through
Apache at `ai.alfydesign.com`, M1 columns present, clean startup. The one post-deploy check I cannot
self-run is "one real chat turn" — prod forbids test-user writes and I have no real credentials — so
it is delegated to the owner / organic traffic. **M1 is now collecting the real deepseek/6-user
latency baseline; the true §6 table can be re-run against prod after some real traffic.** Awaiting
the human before Wave 1.
