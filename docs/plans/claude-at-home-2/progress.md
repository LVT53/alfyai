# Feature 2 · Artifacts — progress (resume point)

Read `working-plan.md` first; this file records where the run stands.

## Note on commit hashes (2026-09-25)

The branches of this run were rebuilt on 2026-09-25 from their working trees as snapshot commits, one or two per
branch. Commit hashes cited below that are not on `dev` (anything from `feat/artifacts`, the slice and review
branches, or the Wave 0 follow-ups) no longer resolve; the work they describe is in the snapshots. Lost and being
redone: the Slice 0 data review's six changes (listed under S0 below). The canvas prototype branches are gone;
Slice 3 works from `slice-3.md` and the prototype findings instead.

## State — 2026-09-25 11:20 (see RESUMED below for the current state)

**Plan approved** by the owner (answers in `working-plan.md §12`; rulings 43–46 in `decisions.md`). Wave 0 and
Wave 1 are being dispatched.

- `dev` = `e1388193` (Feature 1 finished by the other group and pushed; this run now owns `dev`).
- Integration branch **`feat/artifacts`**, worktree `.claude/worktrees/art-base` (real `npm ci` install; slice
  worktrees symlink its `node_modules`):
  - `b73ea102` consistency pass (cherry-picked `3977867c`) · `19dee701` working plan ·
    `00ef6d2a` merge of `dev` `e1388193` · then the approval commit (rulings 43–46, plan updates).
- Deploys: dev environment only (owner). `main`/production: only when owner and orchestrator both call it
  polished, with a new announcement campaign.

## Baseline gates at `00ef6d2a` (logs `/tmp/art-baseline2/`, Fallow JSON also at `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json`)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (`ToolActivityRow.svelte` 10, `ThinkingBlock.svelte` 6, `RouteItinerary.svelte` 1) |
| `npx biome check src scripts tests` | clean, 1,883 files |
| `npm run check:migrations` | pass; next free migration `1777140000111`, journal idx 124 |
| `npm test` | 794 files + 1 skipped; 11,981 tests + 2 skipped; 99 s |
| `npm run build` | exit 0; 17 warnings (34 lines: 32 `Unused CSS selector`, 2 `must have an ARIA role`) |
| Fallow | 124 issues (files 13, exports 87, types 9, deps 4, class members 4, unlisted 2, duplicate exports 1, circular 4) |
| Playwright chat + conversation | 22 passed, 37 s (port 5400, after `db:prepare`) |

## RESUMED — 2026-09-25 12:10 (after the owner's app restart)

Verified after the restart: `sonnet` sub-agents run (the probe answered `claude-sonnet-5`), WebFetch works again,
`ANTHROPIC_BASE_URL` in the app's environment is `https://api.anthropic.com` (set by the desktop app), and neither the
active `~/.claude/settings.json` nor any shell profile mentions DeepSeek.

**Owner-approved model split:** Sonnet 5 for **all** implementation (heavy slices included); Opus 5.5 **only** for the
adversarial reviews RV-W0-A (chat scroll), RV-0A (Slice 0 data/ownership), RV-1A (Slice 1 patch protocol) and RV-2A
(Slice 2 sandbox/CSP); Sonnet for every other review.

| Agent | Model | Worktree (port) | Resumed as |
|---|---|---|---|
| W0-A chat scroll | sonnet | `w0-scroll` (5710) | **done** — `26ab96bd` spec (fails 7/15 on `dev`), `6db7f79c` fix (a held position a ResizeObserver re-applies until the reader takes over), `0312f070` formatting; 15/15, streaming 10/10 unchanged, gates exact. **Reviewed** (RV-W0-A, opus): merge with fixes — 14 commits (`97b3bf23`…`4c20db66`): a followed reply ending 167 px under the composer (the stream's rendered markdown ended the follow), a linked message dragging the view back on every later change (production bug), an early linked message opening out of view, the linked flag never releasing, "jump to latest" not holding, the dev-mode `replaceState` error; takeovers (wheel/keys/touch) proven; 300-message thread ≈0.4 ms of observer work. Note for bisect: `08f201c3` is red until `9dd1d0f3`. **Merged into `dev` as `3a2f6da1`** (local). |
| W0-B project files read | sonnet | `w0-pfr` (5720) | **done** — `3e187d77` adds the live e2e (proved red by disabling the fix); the 5 earlier commits checked, no defects; gates exact (12,024 tests, Fallow 124/4 entry-identical). **Reviewed** (RV-W0-B, sonnet): merge, no functional defect; `01cdf0d4` comment rewrap. It found a neighbouring defect — a forked message keeps the original turn's `projectFilesRead` — fixed test-first on the review branch (`442bfff2`: the count now travels with the evidence summary). **Merged into `dev` as `035dbf17`** (local only — not pushed or deployed yet; Wave 0 deploys as one batch); integration gates on `dev` all green: check 0/17, biome clean, 12,027 tests, build 32/2, Fallow 124/4 with 0 new, Playwright 35/35 |
| W0-C small fixes | sonnet | `w0-small` (5730) | **done** — 5 follow-ups `f20cc07f` forks-test race · `8c5ea302` project-switch reset · `41da15de` Files error line + Retry · `1392c21b` `MODEL_2_ENABLED` via env.ts · `f0d1193c` configuration.md; gates exact (12,001 tests). **Reviewed** (RV-W0-C, sonnet): merge as is — every guard proven by mutation (catalogue word/schema/order changes, disabled fork cleanup); `d27408df` adds the missing `E2E_RESET_DATABASE` docs row. Before merging: a Sonnet agent fixes the flaky phone-reflow assertion in project-files.spec.ts (≈:757, 0.4 px, seen twice) on the same branch. Follow-up for a later small batch: move `WEB_RESEARCH_BRIEF_MAX_CHARS` (web-grounding.ts ≈:104) into env.ts, same shape as `3d6e02d4` |
| W0-D reply language | sonnet | `w0-lang` (5740) | **done** — 9 commits `1e420daf`…`6c5ba54f`. Detector: 8/34 English corpus messages misread as Hungarian → 0/34, Hungarian 15/15 kept. Dev-DB evidence (read-only, no text kept): of 5 English→Hungarian replies, 4 were already detected English — causes were a Hungarian memory-profile fact in context (3 first turns) and the model continuing its own Hungarian reply (2). Fix: `resolveResponseLanguage` (explicit request → latest clear → prior user message → `uiLanguage` → en), once per turn for send/stream/retry, shared by prompt, tool-catalogue locale and thought-step classifier; the turn guard now says memory/project/retrieved context and prior replies never set the language. Gates exact (12,006 tests). **Live proof still open** (38/40 calls wasted on a thinking-on harness bug) → check on ai.dev after deploy with a Hungarian memory fact on the test account. **Reviewed** (RV-W0-D, sonnet): merge with fixes — `c0a0b862` short Hungarian replies of known words ("nem jó") now Hungarian, `90e62f52` guard says requested foreign-language content is not a switch, `85373ca8` history lookup scoped to the owner, `b4200bf4` formatting; 12,058 tests. **Merged into `dev` as `1be7969b`** (local). |

**Wave 0 follow-ups (small batch, later):** grow `HUNGARIAN_SHORT_WORDS` from real usage ("Mehet", "Oké", "Rendben"…); a capitalised Hungarian imperative with no other evidence ("Csinálj táblázatot") reads as unknown; title generation (`resolveShortTextLanguage`) could fall back to `uiLanguage` when `titleLanguage` is auto; `runAtlasSendTurn`'s two admin error strings still use raw `detectLanguage`; move `WEB_RESEARCH_BRIEF_MAX_CHARS` into env.ts; the composer's bottom clearance should follow its measured height (a 20-line desktop draft covers the last 85 px of the latest reply — pre-existing); `restoreScrollToPosition` should check the conversation before writing (switch-within-a-frame race). **Owner questions from RV-W0-A:** should every streaming reply be followed, or only while it is thinking (current, per the code comment)? Run the scroll spec on WebKit before trusting iPhone behaviour (needs `npx playwright install webkit`, a download).
| S0 spine | sonnet | `art-s0` (5400) | **done** — Tasks S1–S8 (`8c881739`…`067a5867`): migration `1777140000111_artifacts_spine.sql` (idx 124), service boundary, type-aware panel, one ArtifactCard, list + count button, eval skeleton, AGENTS.md; also fixed two older migration tests that assumed they were the journal's last entry. Gates: check 0/17, 12,087 tests (+106), build 32/2, Fallow identical, containment 23 with no exemption, Playwright 56. Deviations (sound): list rows via ArtifactCard; list selects by `item.id`; selecting an unopened item opens it; flat success bodies. **Integrated** with Wave 0 as `5f6695e5` (the one conflict was structural; both sides' tests kept): 12,186 tests, check 0/17, Fallow identical, Playwright 76/76 — one known flake (5 teardown errors from ThinkingBlock.activity.test.ts: the card's lazy FileProductionCard import resolving after teardown) handed to RV-0B. **RV-0A (opus, data/server) — merge with fixes:** ownership holds everywhere, incognito containment and lifecycle hold, no content in logs, migration byte-identical to drizzle-kit's output. Fixed test-first: `cc9b31f3` an incognito chat could not open its own artifact (route now takes `?conversationId=`, scope still caller-owned only), `28aa3ab6` `parentId: ""` threw an FK error, `58e41d1a` the containment guard missed version/comment reads by artifact id; added `10724609` concurrency, `7d732b3b` delete paths, `ca5aff93` HTTP-layer 401 e2e. 12,200 tests. **RV-0B (sonnet, client) still running** (asked to add `conversationId` to `fetchArtifact`). **Post-review integration step (small Sonnet agent, after both merge):** `{ ok: true, … }` success bodies (ruling 49); `createArtifact` refuses unknown kinds (`invalid_kind`) and blank titles; `ArtifactType` gains `"artifact"` (missed from the brief); slice-0.md's failure-mode 404 body fixed. Rulings 47 (user saves coalesce per 10-minute burst; Alfy versions never) and 48 (App kv total ≤ 512 KiB, Slice 2) recorded for the next wave; slice 1 also clamps `listVersions` limits and refuses whitespace titles. |
| S7 spec | sonnet | `art-docs` | **done** — `docs/plans/claude-at-home-2/slice-7.md` (`dbb927b3`, 1,267 lines): one extra read path for `type: "artifact"` rows merged at the `KnowledgeDocumentItem` level, so the Documents tab, Workspace Search and the knowledge handoff share it; no new route, no migration, no Feature 2 hot file. Orchestrator amendment `8707feb8` binds the chips to the mockup (All · Documents · Canvas · Apps · Slides · Uploaded — produced Files under Uploaded with their format pill; no File chip); ruling 46's wording corrected. Merged into `feat/artifacts` (`486ca3b1`). Slice 7 can land in wave 3 beside Slice 4 |

## (history) PAUSED — 2026-09-25 12:05, owner restarting the app

The owner asked to stop before any reviewer: Opus agents were eating the owner's token limit, and the app needs a
restart so the Sonnet alias works (the DeepSeek mapping was removed from `~/.claude/settings.json` at 11:39, but this
session kept the old mapping in memory). **All six agents were stopped by the orchestrator; no reviewer was ever
dispatched.** Everything below is on disk in each worktree (`.claude/worktrees/<name>`); nothing is pushed or merged.

| Workstream | Branch / worktree (port) | Committed | Uncommitted, left in place | Resume with |
|---|---|---|---|---|
| W0-A chat scroll (#6) | `fix/w0-chat-scroll` / `w0-scroll` (5710) | nothing | the fix: `MessageArea.svelte` (+169), chat `+page.svelte` (+8), `ChatMessagePane.svelte` (+4); new `tests/e2e/chat-scroll-on-load.spec.ts`; scratch `tests/e2e/zz-w0-explore.spec.ts` (delete); before-screenshots and an older `MessageArea.fix-v1.svelte` in `/tmp/w0-scroll/` | it was proving streaming behaviour unchanged against the original code (8/8 on the fix). Finish that check, delete the scratch spec, commit in TDD-sized steps, gates, report |
| W0-B project files read (#1) | `fix/w0-project-files-read` / `w0-pfr` (5720) | `7a2c8d35` count once across ids · `2e421e3a` count tool reads · `03d7ba7a` read_generated_file records its file · `16994929` memory_context records attachments · `4b6a3e71` docs | `tests/fixtures/ai/openai-compatible-scenarios.ts`, `tests/mocks/ai-provider/openai-compatible-provider.ts` (a builder for the live-delivery-path test, "two-chunk convention with usage") | finish the live-path test, gates, report |
| W0-C small fixes (#2–#5) | `fix/w0-small` / `w0-small` (5730) | 6 commits `3d6e02d4`…`4424ddef` — first report accepted, gates at baseline | nothing | the five follow-ups (forks-test race, project-switch staleness, Files error line, `MODEL_2_ENABLED` re-parse in `providers.ts:589`, configuration.md harness section) — none started |
| W0-D reply language (#7) | `fix/w0-language` / `w0-lang` (5740) | nothing | scratch `src/lib/server/services/zz-scratch-lang-dump.test.ts` (investigation dump; delete before committing) | restart the root-cause investigation (its findings were lost with the agent); include the forwarded finding that the tool-catalogue locale is also chosen per message (`shared-normal-chat-model-run-helpers.ts` ≈ :436) |
| S0 spine | `feat/artifacts-s0` / `art-s0` (5400) | `8c881739` three tables · `442df264` service boundary · `37fac2a8` versions/comments/kv · `a6b2b53b` scope + erasure + archive · `b6854001` i18n names | `src/routes/(app)/chat/[conversationId]/page-runtime.test.ts` (it was fixing a harness mock for `recordDocumentWorkspaceOpen`) | continue slice-0 from the panel tasks (S5 onward); verify S1–S4 and the i18n commit against slice-0.md first |
| S7 spec | `feat/artifacts-docs` / `art-docs` (—) | nothing | nothing | restart |

**Owner's cost signal (2026-09-25):** "Opus models are REALLY eating up my token limit." Before resuming, confirm the
model split: proposed — Sonnet for all implementation (including the resumed heavy workstreams), Opus only for the
adversarial reviews of the riskiest areas (S0 data/ownership, S1 patch protocol, S2 sandbox/CSP, W0-A chat scroll),
Sonnet reviewers elsewhere.

**Commit trailer (decided 2026-09-25):** from now on every agent ends commits with its own harness attribution
(the model that actually wrote it — e.g. `Claude Sonnet 5`, `Claude Opus 5.5`); the harness says that line yields
only to CLAUDE.md or memory rules, and `plan.md`'s "Claude Code" line is neither. Earlier commits keep theirs.

**Local-only E2E failures to ignore:** `everyday-redesign-screens.spec.ts` "knowledge documents tab" needs Docker
(absent on this Mac); `project-files.spec.ts` phone reflow flaked once in a batch and passed alone.

**Usage limit hit ≈16:00, 2026-09-25** (all agents got 429 "session limit, resets 4pm"). Resumed at 17:0x by the
owner's "try again": the three interrupted agents (W0-D, S0, RV-W0-A) were **resumed with their context** (their work
was on disk: W0-D 8 commits, S0 9 commits + uncommitted routes/client/read-model; RV-W0-A nothing yet), and two small
Sonnet agents started (the fork fix on `rv-w0b`, RV-W0-C). The session cwd was moved off `art-base`: agents inherit it,
and W0-C found itself started inside `art-base` (it noticed and switched).

**Merging into `dev`:** the main checkout holds `dev` (clean), so merges happen there with `git merge --no-ff -F <msgfile>`
(`-F -` is not accepted by `git merge`). Integration gates run in the detached worktree `.claude/worktrees/dev-int`
(own `node_modules`, Playwright port 5610) via the scratchpad script `gates.sh <worktree> <port> <label> [specs…]`,
which writes `/tmp/gates-<label>/summary.txt` and compares Fallow entries to the baseline with positions ignored.

**Dev integration after three Wave 0 merges (`3a2f6da1`):** check 0/17, biome clean, build 32/2, Fallow 124/4 with 0 new,
Playwright 60/60; unit tests 12,057 passed with 3 failures that all pass in isolation 3/3 (fork refresh-queue, a settings
component timeout, a MinerU poll-count assertion) — load average was ≈20 with agents looping Playwright. Re-run the full
suite on a quieter machine before the deploy. Language baseline on the OLD ai.dev code (`/root/verify-language.mjs`):
clean English prompts 6/9 correct (misses were numeric replies + one empty turn), **trap prompts 1/5** — Győr, "only
really … city's energy policy", "Any company …", "résumé … café" all answered in Hungarian (the owner's bug, reproduced).

**Wave 0 complete (18:24):** all four reviewed fixes merged into `dev` (`035dbf17` project files read,
`1be7969b` reply language, `3a2f6da1` chat scroll, `98e36903` small fixes). Final pre-deploy gates on `98e36903` (quieter
machine): check 0/17, biome clean, **12,080 tests, 0 errors**, build 32/2, Fallow 124/4 with no new entry (one position
drift in env.ts), **Playwright 109/109** across 11 specs. `dev` pushed (`e1388193..98e36903`), dev environment deploy
started, and `dev` merged into `feat/artifacts` (Slice 0 picks it up when it merges `feat/artifacts` before reporting).

**Wave 0 deployed and verified on ai.dev (release `98e36903`, healthy, DB backed up first).** Language check on the
real model, same prompts: trap prompts 1/5 → **5/5 English** (Győr, "only really … energy policy", "Any company …",
"résumé … café"); Hungarian stays Hungarian (poem, "Írj egy checklistet a hétvégére"); Hungarian→English switch works;
English with the Hungarian memory fact stays English; the only "misses" are the numeric answers 144/169 (no words to
judge). Journal since deploy: only the known thought-step abort and web-citation-audit warnings.

**Next:** S0 continues (then RV-0A opus + RV-0B sonnet); the S7 spec starts (sonnet, `art-docs`, fast-forwarded to
`feat/artifacts`); a Sonnet agent takes the Wave 0 follow-ups on `fix/w0-followups` (`w0-follow`, port 5750), led by
`top_k` never reaching vLLM (AI SDK warns "topK is not supported" on every call).

**Worktree cleanup (owner's request, 2026-09-25):** 35 finished worktrees (Feature 1's `ws-*`/`fix-*`/`brave-meitner`,
this run's finished Wave 0 and review worktrees, two canvas prototypes, the round-1 document-editor prototype whose
13 edits were identical to round 2) plus Fallow's 3 temp caches removed with `git worktree remove`; ~57 GB freed
(181 → 239 GB). Branches all kept; 48 uncommitted screenshots/prototype files backed up to
`~/.cache/alfyai-artifacts/worktree-leftovers/`. Remaining: main checkout, `art-base`, `art-s0`, `rv-0b`, `dev-int`,
`w0-follow`, `rv-w0f`, prototypes r2 + apps-quality, `campaign-dev`, `campaign-incognito`.

**Wave 0 follow-ups done** (`fix/w0-followups`, 7 commits `a6df4f79`…`e868f8f5`, 12,131 tests, gates exact): `top_k` now
reaches vLLM (the AI SDK dropped it), qwen sampling on control/title paths, more short Hungarian words, title language
falls back to uiLanguage, the two-part scroll-restore race, Atlas strings via the resolver, `WEB_RESEARCH_BRIEF_MAX_CHARS`
via env.ts. **In review:** RV-W0-F (sonnet) in `rv-w0f` (5560), also fixing the same sampling gap in
`task-state/control-model.ts`.

**State after the rebuild (2026-09-25, evening):**
- `dev` = `9d239cf7`, pushed and **deployed to ai.dev** (Wave 0 + its reviewed follow-ups; since this deploy the
  dev journal shows **0** "topK not supported" warnings — top_k now reaches vLLM).
- Rebuilt branches (snapshot commits): `feat/artifacts` `65da935d` (`art-base`), `feat/artifacts-s0` `4f670188`
  (`art-s0`), `feat/artifacts-s0-review-client` `6f0532f9` (`rv-0b`: the 7 client-review fixes), `fix/w0-followups`
  `3cb77aaa` + `fix/w0-followups-review` `42205adb` (merged into `dev` as `9d239cf7`), `campaign/2-1-deck` `a77e4f66`
  (current `dev` + the campaign 2.1 copy draft; `tmp-capture/` untracked; to be expanded for the release after
  Feature 2), `campaign-incognito` detached at `30882887` as before.
- Reference prototypes r2 (document editor) and apps-quality remain as plain folders
  `.claude/worktrees/agent-a883f7e86c2b442fd` and `.claude/worktrees/agent-afcaa6f617ee84abe` (not in git; read the
  files directly). The canvas prototypes are gone.
- **Running:** a Sonnet agent in `rv-0b` redoes the data review's six changes and the post-review items (ruling 49
  `ok: true`, createArtifact kind/title validation, `ArtifactType` "artifact", the count button's aria-pressed,
  slice-0.md fixes). Then: merge into `feat/artifacts-s0` → `feat/artifacts` → `dev`, gates, deploy, Wave 2.
- Owner, 2026-09-25: push only `dev` (feature branches stay local).

## Environment facts learned this session

- No Context7 / Svelte MCP tool in this session → official docs via WebFetch (working again since the restart) and
  the installed packages' `.d.ts`.
- Found by W0-C: the tool catalogue's locale is chosen per message by `detectLanguage` → forwarded to W0-D (language).
- Reading `~/.config/opencode/opencode.json` is blocked (credential); live model access goes through
  `ssh -N -L 30000:192.168.1.96:30000 alfyroot` in the **same** command as its user, model `qwen3-6-27b`.
- `scripts/deploy-dev.sh` deploys `origin/$DEPLOY_BRANCH` (default `dev`); classifier-safe command shape in the
  staging-verify-harness memory.
- Playwright in a fresh worktree needs `DATABASE_PATH="$PWD/data/playwright-e2e-chat.db" npm run db:prepare`
  first (the web server starts before `globalSetup`).
- i18n namespaces are now discovered from `src/lib/i18n/index.ts` by the validator and the parity test
  (`1e5a32df`, `2a30d85c`).

## Next action

Wait for the five agents' reports; review Wave 0 (three Opus reviewers) and merge it into `dev`; deploy the dev
environment; merge `dev` into `feat/artifacts`; review S0 (two Opus reviewers) before dispatching Wave 2.
