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

**Wave 1 (Slice 0) DONE and deployed (2026-09-25 ~22:45).** Merged: review fixes → `feat/artifacts-s0` `f8f7dd3a` →
`feat/artifacts` `1a56d92f` → `dev` `2bf644aa` (pushed). Gates on `dev`: check 0/17, biome clean, **12,264 tests**, build 32/2,
Fallow 124/4 with 0 new, **Playwright 89/89**. ai.dev runs `2bf644aa`: DB backed up, the three artifact tables exist, 0 journal
errors; live API check (`/root/verify-artifacts-spine.mjs`): a produced PDF lists as a File artifact (`ok: true`), the
conversation detail carries it, opening it answers `ok: true` with no versions, a missing id is a 404 `{ ok:false,
reason:"not_found" }`, no session is 401. `feat/artifacts` fast-forwarded to `dev` `2bf644aa`.

**Wave 2 dispatched (sonnet ×3, from `2bf644aa`):** S5a in `art-s5a` (5410) — the three tools as a family shell with a per-kind
dispatch seam (no creatable kind), the catalogue, descriptions EN+HU, timeouts, the harness core; S1 in `art-s1` (5420) —
Documents, T4/T10's @Alfy path/T13 blocked on 5a; S2 in `art-s2` (5430) — Apps, A7/A8-tool/A9 blocked on 5a. Blocked agents
merge `feat/artifacts` themselves once 5a has merged there, else stop and report. Reviews after: RV-5a (sonnet), RV-1A
(opus, patch protocol), RV-1B (sonnet, editor), RV-2A (opus, sandbox/CSP), RV-2B (sonnet, generation).

**Slice 5a DONE (2026-09-26 ~00:30), in review.** `feat/artifacts-s5a` in `art-s5a`, HEAD `cb9a0775` (4 commits on
`2bf644aa`: `1b24cf93` catalogue, `05b0f80c` the three tools, `623473b9` harness core, `cb9a0775` retry wiring). Gates:
check 0/17, biome clean, **12,356 tests**, build 32/2, Fallow 124/4 identical, containment 24 unchanged, Playwright 37/37.
Catalogue ceiling raised once to `{ en: 4830, hu: 7850 }` (measured 4,804 / 7,823), snapshots regenerated. Its
deviations are confirmed as **ruling 50** (three per-tool registries, the refusal union widened by type slices,
candidates on a failed edit, read defaults to "full", per-case circuit breaker, bare `tsx`). Two notes: it built the
harness from the ADR text because the apps-quality prototype is a folder, not a branch (Slice 2 aligns its suites with
the folder); and it opened the real `~/.config/opencode/opencode.json` to learn the fallback's shape (it reports no key
copied anywhere; the owner has been told; RV-5a greps the diff). S1 and S2 were sent the seam API.
**RV-5a (sonnet) running** in `rv-5a` (branch `feat/artifacts-s5a-review` from `cb9a0775`, port 5570): byte stability,
scope fields, containment incl. the catalogue read, catalogue text hygiene, EN/HU parity, tool behaviour and caps,
gating, harness key rule. Findings → `review-5a.md` on its branch.

**Slice 2 unblocked part DONE (2026-09-26), waiting on 5a.** `feat/artifacts-s2` in `art-s2`, 10 commits
`155d002c`…`ed0b09fc` (A1–A6, A8 route/service, A10, E2E): contract + audit, thinking-off generation, verification,
the sandboxed frame + bootstrap + exact CSP, App storage with ruling 48's total cap, AppBody (Preview/Code, download,
regenerate), containment +2, archive escaping, erasure/Clear Memory integration, 7 E2E. Gates: check 0/17, biome clean,
**12,479 tests**, build 32/2, Fallow 124/4 with 0 new, containment 26, Playwright 34/34. Blocked: A7 (the App create
handler), A8's tool part, A9 (app + verification suites, live eval). Decisions on its deviations: accepted — dark
tokens from `.dark`, the stricter fence rule (an unfenced answer is never accepted), `requireApiUser`, the
`metadataPatch` parameter on `updateArtifactBody` (S1's ruling-47 change lands in the same function: keep both at
merge), the download route, no UI line for `invalid_key`/`not_found`; **not accepted** — the self-attested repair
check (**ruling 52**: re-verify, compare claim lists, bounded); its `ArtifactBodyProps` gap becomes **ruling 51**
(fix agent in `art-bodyprops`, branch `feat/artifacts-bodyprops`, port 5490). Its note that `AGENTS.md` says "five"
known cycles while the baseline has four goes to S5b's doc fixes (T6). Lesson for every brief: a route file exporting
anything but its verbs passes `npm run check` and fails `npm run build`.

**RV-5a done → Slice 5a merged into `feat/artifacts` as `20e73213` (2026-09-26).** Verdict "merge with fixes": 4
defects fixed test-first on `feat/artifacts-s5a-review` (`a2e2d8c4` read/edit reached another of the user's own
conversations, now pinned to the calling conversation; `c6dfe4bb` catalogue titles collapsed to one line;
`e4ffe2d6` a failed catalogue read is logged; `5a8778c6` `--only` no longer empties the known-bad gate) plus the
catalogue-read containment case (`81699f93`); 12,364 tests; live smoke through the tunnel accepted (thinking off, no
key). The branch was fast-forwarded to `4ba32b9c` and merged. Its open questions and a gap it missed (the handlers
never received the envelope's abort signal) are **ruling 53**; **S5a resumed** for that follow-up (abort signal,
read bound, `MAX_CREATE_ARTIFACT_CALLS_PER_TURN = 3`). Gates on `feat/artifacts` running (`/tmp/gates-fa-5a/`).

**2026-09-26 ~00:50.** Gates on `feat/artifacts` at the 5a merge `20e73213`: check 0/17, biome clean, **12,364 tests**,
build 32/2, Fallow 124/4 with 0 new, Playwright 27/27 (chat + conversation + artifacts-panel). The ruling-51 fix
(`ab0edb85`: `ArtifactBodyProps.conversationId`, `DocumentWorkspace` prop, the chat page supplies it; 2 tests; its own
gates green, 27/27 Playwright) merged as **`62c4eb55`**. **S2's agent ran out of context** on resume ("Prompt is too
long"), with nothing uncommitted (`ed0b09fc`, tree clean); **S2b (sonnet)** continues in `art-s2` (5430) from a full
brief: merge `feat/artifacts`, ruling 51 in AppBody, ruling 52 in verify.ts, A9 suites + live eval (tunnel port
30430), A8 tool wording, then A7 once 5a's ruling-53 follow-up is merged (else stop, "blocked on 5a follow-up").
S1 told it is unblocked. Lesson: long-running implementers need a context-economy line in their brief.

**Ruling 53 landed (2026-09-26 ~01:10).** S5a's follow-up `ab29d9f5` (abort signal into all three handlers, proven on
the real wiring for both the tool timeout and the turn's stop), `7ea8157c` (read bound at `MAX_INLINE_TEXT_CHARS`
100,000 exported from `files.ts`; `truncated` + `omittedChars`/`omittedBlocks`; catalogue snapshots unchanged),
`25771975` (`MAX_CREATE_ARTIFACT_CALLS_PER_TURN = 3`, checked and counted before the first await, so parallel calls
cannot pass it); 12,375 tests, gates clean. Read by the orchestrator, merged as **`365083f2`**; check 0/17, the
tools/artifacts/workspace tests 1,079/1,079. S1 and S2b told; S2b's A7 is unblocked. 5a is complete.

**2026-09-26 03:00–03:50.** The API usage limit stopped S1 and S2b mid-task at ~01:30; both resumed at 03:00 (S1 clean
at `6196e671`; S2b with uncommitted ruling-52 work). **S1 reported (HEAD `bb398b5e`, 12,557 tests, gates clean, containment
28, Playwright 29/29):** T1–T7, T4 (the three Document handlers, abort-aware) and T13 (the document suite) done;
**T8–T12 not started** (its context was spent). Its "live" eval ran through the harness's opencode-config fallback, not
the tunnel, so it measured an unknown provider (the owner was told) → **ruling 54** (fallback removed; explicit
endpoint only; fixtures re-recorded from qwen3-6-27b). S1 added Tiptap 3.31.3 (7 packages, pinned) and has its own
real `node_modules`; `art-base`'s install lacks Tiptap, so `npm install` is needed there when S1 merges into
`feat/artifacts` (do it at a quiet moment: other worktrees symlink it). Accepted deviations: the directory split
(pure engine in `src/lib/shared/artifact-document/`, editor in `components/artifacts/document/`), Tiptap-named
factory options, `applyDocumentPatch` returning `versionId`, the Document-only `POST /api/artifacts/document`
("save as new" after a delete; reviewers check its scope), 8 eval cases. Dispatched (sonnet): **S1b** in `art-s1`
(5420) T8/T9/T11; **S1c** in `art-s1c` (branch `feat/artifacts-s1-comments` from `bb398b5e`, `node_modules` →
`art-s1`'s, port 5520) T13 re-record + T10 + T12, with a file split and `DocumentBody.svelte` as the one shared
file; **evalkey fix** in `art-evalkey` (branch `feat/artifacts-evalkey`). S2b told about ruling 54.

**2026-09-26 ~04:30. S2b reported** (`feat/artifacts-s2` HEAD `2d8d0cbf`, 12,643 tests, containment 30, Playwright 34):
ruling 51 in AppBody/AppFrame (`6776c087`, the kv bridge now carries the conversation too), ruling 52 re-verification
with a 25 s deadline (`28eea958`), the `app` + `verification` suites (`0256529c`, `15d34f52`; live on qwen3-6-27b via
the tunnel: app 10/10 by the static audit, verification 3 good + 1 acceptable), the shared generate→verify pipeline
(`7fb0f681`), **A7 the App create handler** (`00968af4`, abort-aware) and A7.5's timeout assertion (`43975886`); A8's
tool wording checked, no change. Three gaps → **rulings 55–57**: the handler chose the language with
`detectLanguage(brief)` (3/10 English prompts gave Hungarian Apps; its hand audit caught it), A9's headless-browser
pass was skipped, and the verifier's `research_web` import closed a new cycle (Fallow 125 / 5). Its note that the
harness's default `--out results` lands outside `.gitignore` went to the evalkey agent. Dispatched: **S2c** (sonnet,
`art-s2`, 5430) for rulings 55–57 + a fresh live run; **RV-2A** (opus, `rv-2a`, branch
`feat/artifacts-s2-review-sandbox` from `2d8d0cbf`, 5580) on the sandbox/CSP/bridge/kv/export, which S2c does not
touch. RV-2B (sonnet) follows S2c. **Evalkey fix done** (`1d23ec0c`: explicit endpoint required, fallback and its
tests removed, README tunnel recipe; 12,374 tests; Fallow 124/4) plus `719dc60f` (the default `--out` is the harness's own gitignored `results/`; `run.ts`'s `fixturesRoot` no longer uses `new URL('.', import.meta.url)`, which Vite rewrites under vitest); read and merged as **`2e3b19b2`** (harness tests 46/46). S2c told to merge it before touching `run.ts`.

**RV-2A done (opus, 2026-09-26 ~05:30): "merge with these fixes".** Branch `feat/artifacts-s2-review-sandbox` HEAD
`0a4cf01d`: six fixes on `2d8d0cbf`. `16db33bb` **High**: switching Apps in the rail reused one iframe element, so the
outgoing App's storage calls hit the incoming App's kv (39/40 in Chromium); now one element per `src`. `36845442`:
regenerate did not send the conversation (incognito 404). `c13b263c`: no cap on a frame's pending storage requests
(now 4 at once, queue of 256). `88cea7cd`: BigInt/cyclic values hung the bridge. `be4100cb`: the bootstrap splice
matched `<header>` and went before a doctype, and was quadratic (2.3 s at 192 KB), now linear. `f9963db8`: stale
verify/glitch/Code after a switch. 12,657 tests, Playwright 35. Its open questions → **ruling 58** (forms allowed with
`form-action 'none'`; dialogs/eval forbidden by contract and audit; navigation/WebRTC are violations; a load
tripwire; the eval runs apps inside the real frame and CSP; runtime hardening). Dispatched: S2c told about the
contract/audit/eval half (before its live run); **S2d** (sonnet, in `rv-2a`, port 5580) does the runtime half on
the review branch. Then: merge the review branch into `feat/artifacts-s2` after S2c, and RV-2B (sonnet) covers
generation/verification/eval plus S2d's runtime changes.

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

RV-5a reports and the ruling-51 fix lands → merge both into `feat/artifacts` (gates in `art-base`) → resume S2
(A7, A8 tool part, A9 + ruling 52) and let S1 pick up the merge. Then wait for S1/S2's reports → RV-1A (opus), RV-1B,
RV-2A (opus), RV-2B → merge wave 2 → `dev` → push → deploy dev → real-model checks. Review ports: RV-5a 5570; next
free 5580, 5590, 5620, 5630 (5600 is Phase 4's, 5610 was used).
