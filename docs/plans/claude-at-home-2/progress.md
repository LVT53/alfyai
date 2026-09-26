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

**Slice 5a DONE (2026-09-26), in review.** `feat/artifacts-s5a` in `art-s5a`, HEAD `cb9a0775` (4 commits on
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

**2026-09-26.** Gates on `feat/artifacts` at the 5a merge `20e73213`: check 0/17, biome clean, **12,364 tests**,
build 32/2, Fallow 124/4 with 0 new, Playwright 27/27 (chat + conversation + artifacts-panel). The ruling-51 fix
(`ab0edb85`: `ArtifactBodyProps.conversationId`, `DocumentWorkspace` prop, the chat page supplies it; 2 tests; its own
gates green, 27/27 Playwright) merged as **`62c4eb55`**. **S2's agent ran out of context** on resume ("Prompt is too
long"), with nothing uncommitted (`ed0b09fc`, tree clean); **S2b (sonnet)** continues in `art-s2` (5430) from a full
brief: merge `feat/artifacts`, ruling 51 in AppBody, ruling 52 in verify.ts, A9 suites + live eval (tunnel port
30430), A8 tool wording, then A7 once 5a's ruling-53 follow-up is merged (else stop, "blocked on 5a follow-up").
S1 told it is unblocked. Lesson: long-running implementers need a context-economy line in their brief.

**Ruling 53 landed (2026-09-26).** S5a's follow-up `ab29d9f5` (abort signal into all three handlers, proven on
the real wiring for both the tool timeout and the turn's stop), `7ea8157c` (read bound at `MAX_INLINE_TEXT_CHARS`
100,000 exported from `files.ts`; `truncated` + `omittedChars`/`omittedBlocks`; catalogue snapshots unchanged),
`25771975` (`MAX_CREATE_ARTIFACT_CALLS_PER_TURN = 3`, checked and counted before the first await, so parallel calls
cannot pass it); 12,375 tests, gates clean. Read by the orchestrator, merged as **`365083f2`**; check 0/17, the
tools/artifacts/workspace tests 1,079/1,079. S1 and S2b told; S2b's A7 is unblocked. 5a is complete.

**2026-09-26 (morning).** The API usage limit stopped S1 and S2b mid-task at ~01:30; both resumed at 03:00 (S1 clean
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

**2026-09-26. S2b reported** (`feat/artifacts-s2` HEAD `2d8d0cbf`, 12,643 tests, containment 30, Playwright 34):
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

**RV-2A done (opus, 2026-09-26): "merge with these fixes".** Branch `feat/artifacts-s2-review-sandbox` HEAD
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

**S2d done (2026-09-26).** `feat/artifacts-s2-review-sandbox` HEAD `69a99a4b` (on RV-2A's `0a4cf01d`): ruling 58's runtime
half. `3ff7c447` sandbox `allow-scripts allow-forms` from one `APP_IFRAME_SANDBOX` constant (CSP derives from it;
AppFrame's literal pinned equal), `7d712761` the load tripwire + localized notice, `d936b18b` bootstrap replies only
from `window.parent`, `ccaa0212` same-key ordering + an 8 MiB queued-bytes cap, `c476ec8f` non-string key dropped
+ kv read `no-store`, `c227a100` localized download errors and a "session ended" notice. That notice is a narrow
branch in `hooks.server.ts`, inside the existing no-user check, for exactly `/api/artifacts/<id>/app` + `Sec-Fetch-Dest:
iframe`; never public, tested with the route's HTML asserted absent. `69a99a4b` the Code tab loads Shiki on demand.
12,690 tests (+33), Playwright 37, containment 30, gates clean except the known extra cycle; one MinerU timing flake
passes alone. Read by the orchestrator. Waiting: S2c → merge this branch into `feat/artifacts-s2` → RV-2B.

**S1c done (2026-09-26).** `feat/artifacts-s1-comments` HEAD `e73c7003`, 20 commits on `bb398b5e`: the document
eval **re-recorded from qwen3-6-27b** via the tunnel (`98e0c6af`; live 7/7 good, known-bad failed as it must, replay
7/7); T10 (shared anchor vocabulary + the Document's text resolver, comments + `@Alfy` routes, the margin/thread/card/
bubble, `@Alfy` reads through `readDocumentForAlfy` first so its patches meet the same snapshot guard as
`edit_artifact`); T12 (block → `GeneratedDocumentSource`, the export route, the download sheet, ruling 36's ticks in
all four renderers, proven per renderer). 12,686 tests, Fallow 124/4 0 new, Playwright 31, containment 28.
For review: the margin is a flat scrollable list of threads, not placed against each block ("the margin shows it
against the right block", T10 step 1) → RV-1B compares with the prototype editor; Resolve/Reopen is a toggle (fine);
anchor scoring constants are its own; `no-ad-hoc-maps.test.ts` allowlist entries for the export route/sheet.
Waiting: S1b (T11) → merge `feat/artifacts-s1-comments` into `feat/artifacts-s1` (shared: `DocumentBody.svelte`,
`toolbar-actions.ts`, i18n) → RV-1A (opus) + RV-1B (sonnet).

**S2c done (2026-09-26).** `feat/artifacts-s2` HEAD `5b5abc99`: `8e95e36c` ruling 55 (handler `language` from
`ctx.language`; regenerate uses the resolver), `4fd87001` ruling 57 (`research-web-tool.ts` pure move; snapshots
unchanged without `-u`; Fallow back to 124/4), `c0796775` + `408ecaf8` ruling 56 (the core's optional `evaluate`
step; the P1 browser pass ported, with a language-mismatch check), `35f000df` + `21936ad8` ruling 58 generation half
(the browser pass runs inside the real sandbox attribute + CSP + bootstrap; contract rule 11; audit `no-dialogs`/
`no-eval` glitches and `no-navigate`/`no-webrtc` violations with retry-once-then-refuse; bounded tag regexes),
`ced83c15` live recordings. **Live on qwen3-6-27b, before the forms change merged:** app 6 good / 4 acceptable / 0 bad
(P1: 10/10 works). Across 40 page runs: 4 console errors, all "Blocked form submission" (apps 02/03/05/08; 03 and 08
had a dead main action); 1 uncaught exception (app-09 "labels is not defined", a real model bug); 0 blocked
requests. Storage used 5/10 (P1 9/10); 12.9–30.5 s. **Language 10/10.** The new ruling-58 rules touched 0/10.
Verification: 3 good, 1 acceptable, 0 bad. Not captured: completion tokens (`client.ts` returns text only). Gallery
not built (reporting only, deferred). 12,703 tests, Playwright 34, containment 30. **Merged the review branch
(`69a99a4b`: RV-2A + S2d) into `feat/artifacts-s2` with no conflicts**; gates on the merge running
(`/tmp/gates-s2-merged/`). Next: RV-2B (sonnet), which also re-runs the app suite live with forms allowed.

**S1b done (2026-09-26).** `feat/artifacts-s1` HEAD `bd0bdc1f`: `61b80e18` T8 (the `AlfyChange` mark, Keep/Undo
through the engine's inverses against a live editor, `ChangeBar`, `AlfyWriting`, the shared `RefusalNotice`),
`9c1f734c` T9 (`Tabs`, chips, the `TrackerChip` node storing canonical tokens whatever the UI language, `card-view.ts`,
tabs saved through the body route), `ad1540a4` T11 (`MobileToolbar` from the same action list; `artifact-document.spec.ts`,
9 tests), `bd0bdc1f` Fallow cleanup. 12,631 tests, Fallow 124/4, Playwright 36. **Found, marked with `test.fail()` in
the e2e:** a **critical** crash, `RangeError: Maximum call stack size exceeded` from `readMarkdown` + the table
extension's `fixTables` under sustained real-browser edits (typing, adding a tab, changing a chip), which jsdom never
exercised; and opening a Document from the **mobile** panel list does not reliably reach the editor. **Gaps against
the spec:** T8's live trigger is not wired (no "Alfy is writing: {label}" while an edit is in flight, no marks when a
chat-turn `edit_artifact` lands; only `@Alfy` has a hook), and T9.7's card preview (subtitle, first five tickable task
items, ticking writes the document) has no call site because the card summary carries no body. With S1c's flat margin
("the margin shows it against the right block"), these become Slice 1's integration work. **The S1b/S1c merge
conflicts structurally** (`DocumentBody.svelte` ×6, its test ×8, i18n ×2): aborted and given to **S1d** (sonnet,
`art-s1`, 5420) as step 0; after it reports, S1d gets the crash, mobile-open and margin placement, and a parallel
**S1e** gets the live channel (T8) and the card preview (T9.7) from the merge commit.

**Slice 1 merged in its own branch (2026-09-26):** S1d merged S1c into `feat/artifacts-s1` as **`4b4445a1`** (template
rebuilt so Tabs + the desktop/mobile toolbar pair live inside S1c's `document-main` beside the margin; the test file's
describe blocks re-assembled from each side; i18n both sides): check 0/17, 544 artifact tests, Playwright 18/18 (7 are
the known crash under `test.fail()`). Dispatched in parallel from it: **S1d** (resumed, `art-s1`, 5420): the editor
crash first, mobile open, the margin against each block, the export facade re-export; **S1e** (sonnet, `art-s1e`,
branch `feat/artifacts-s1-live`, `node_modules` → `art-s1`'s, 5530): T8 live (stream tool parts → "Alfy is writing",
marks + Keep/Undo from inverses, refusal notice; one `DocumentWorkspace` prop, one `DocumentBody` hook) and T9.7 (a
bounded server-side Document preview on the card summary, ticking as a user edit).

**RV-2B done → Slice 2 merged into `feat/artifacts` as `f91addb8` (2026-09-26).** Verdict "ship with the four
fixes": `469b6fe4` the `no-navigate` audit rule missed `window['location']=` and flagged any object's `.location`
(an address field would be refused); `e9e19bce` an app with an unrelated unsettled claim could ship as "repaired";
`0cfe0734` a trailing slash slipped past the "session ended" branch and rendered the real login form in the sandbox;
`c1d3288f` regenerate ignored aborts. Harness: `client.ts` now returns `usage`, cases record `durationMs`. **Live on
qwen3-6-27b, forms allowed:** committed recordings 10 good / 0 bad, 0/0/0 console/uncaught/blocked over 40 runs,
storage 7/10, 16.4–23.8 s, 3,088–4,512 completion tokens (P1 2,486–3,607); a second live run 8 good / 2 acceptable
/ 0 bad. The storage gap is the one-click smoke test's variance (accepted). The verification suite's known-bad was
model-driven and passed live → **ruling 59** (known-bad fixtures are recorded answers, never model calls; S5b's T9).
`feat/artifacts-s2` fast-forwarded to `9110c4cc` and merged. Gates on `feat/artifacts` running (`/tmp/gates-fa-s2/`).

**Gates on `feat/artifacts` at the Slice 2 merge `f91addb8`:** check 0/17, biome clean, **12,760 tests**, build 32/2, Fallow 124/4
with 0 new, Playwright 37/37 (chat + conversation + artifact-app + artifacts-panel), containment 30/30.
**Wave 3's independent parts dispatched (sonnet, from `c7c7587f`):** **S7** in `art-s7` (5480), the whole of slice-7 with
its binding amendment; **S6** in `art-s6` (5460), T1/T2/T5 only, stopping after them. **Migration numbers reserved:**
S6 `1777140000112` (journal idx 125); later slices take 113, 114, … in merge order, and the orchestrator assigns each
before dispatch. Still running: S1d (crash, mobile open, margin), S1e (live marks, card preview). Next: when both
report, merge `feat/artifacts-s1-live` into `feat/artifacts-s1`, then RV-1A (opus) + RV-1B (sonnet).

**S1d done (2026-09-26).** `feat/artifacts-s1` HEAD `dfbd1575`. **The crash's root cause:** `readMarkdown`'s two marker
transactions (and `ensureBlockIds`/`loadMarkdown`) dispatched without Tiptap's `preventUpdate`, so each fired
`update` → `handleUpdate` → `currentCanonicalMarkdown()` → `readMarkdown` again, synchronously, until the stack
overflowed (`fixTables`/`isActive` were only where it happened to break); `document-editor.test.ts` never mounted an
`onUpdate`. Fixed at the source (`840300dd`) + a sustained-edit e2e (typing, a table cell, a tab, a chip). Mobile
open fixed (`f6118c95` + `faa28950`, own identifiers for the mobile shell), margin threads placed beside their block
in document order without overlap, orphans grouped (`932865ec`; a pure `margin-layout.ts`; caught a
content-box-vs-border-box overlap), export through the facade (`b792e962`). 12,772 tests, Playwright 43, Fallow
124/4, containment 28. Left for RV-1B: the mobile toolbar measures 53 px against its 48 px budget (one `test.fail()`),
and two dead functions in `extensions.ts` (the 2 biome warnings). A stale `node_modules/.vite` cache once failed
every e2e with a hydration error; clearing `.vite` + `.svelte-kit` fixed it (worth remembering).

**S6 T1/T2/T5 done (2026-09-26, 10:29).** `feat/artifacts-s6` HEAD `ff7646f2`: `34205fff` the seen table
(`drizzle/1777140000112_artifact_tour_states.sql`, idx 125, hand-written like the last ~15 migrations; archived and
erased through the existing registries), `fd80f5ae` the shared types + shipped defaults + resolver (published snapshot
wins, archived means no tour), `327ddbd2` the admin seed/edit/publish (`artifact_tour` campaign type, the
summary-first + three-standard publish rule mirrored in the client checklist), two follow-ups. 12,810 tests, Playwright
31. Accepted deviations: EN wording "first-open tour" (the i18n test forbids "artifact" in any dictionary value),
`defaultVersionFor` widened (else the four drafts collided), `seedArtifactTours` in `client/api/campaigns.ts` (T3
reuses it), the dialog's type picker stays seed-only. Fallow +1 (`ArtifactTourState`, consumed by T3): accepted
until T3 lands. T3/T4/T6/T7 wait on all four kinds' panels and Slice 5b.

**S1e and S7 done (2026-09-26, before the fourth usage-limit stop).** **S1e** (`feat/artifacts-s1-live`, 15 commits): T8 live:
`edit_artifact`'s Document handler puts `appliedCount` + `refusedBlocksJson` on the tool-call metadata; the chat page
maps the latest create/edit segment to an `alfyActivity` prop on `DocumentWorkspace`; the body rebuilds outcomes +
inverses from the tool's own ops, the refused blocks and its pre-edit blocks, then marks through the lazy boundary;
`@Alfy` replies use the same pipeline. T9.7: a bounded server `documentPreview` (tabs, first five tasks, total) on the
card summary, `readTaskBlock` shared by server and client, ticks through `toggleDocumentTask` (the normal body save).
Its T8-live e2e was `test.fail()` only because of the crash S1d fixed. Deviation: **no in-chat card for any new
kind exists** (only File has one in `ToolActivityRow`); slice-2 A7.4 ("the card renders during the turn") and spec
§5 require it; no slice owned it → a cross-kind task after Slice 1 merges, before the Wave 2 deploy.
**S7** (`feat/artifacts-s7` HEAD `50fffbf9`, 7 commits): the listing merge, typed search for every kind, the Documents
tab's six chips / Version column / type pill / Delete-only actions, search labels + icons, containment (33), e2e; 12,804
tests, Playwright 51. It found that `type:"artifact"` rows are not in `core.ts`'s conversation-required ownership set.
**Merged `feat/artifacts-s1-live` into `feat/artifacts-s1` as `e17c6f09` (no conflicts)**; gates running
(`/tmp/gates-s1-merged/`). Remaining `test.fail()`: the mobile toolbar at 53 px (RV-1B) and S1e's T8-live test (should
now pass). **RV-7 (sonnet) dispatched** in `rv-7` (5610), hunting that ownership edge first.

**Slice 1 combined and in review (2026-09-26, 13:07).** Gates on `feat/artifacts-s1` `e17c6f09`: check 0/17, biome 2 warnings
(dead code), **12,823 tests**, build 32/2, Fallow 124/4 with 0 new, Playwright 46 (the two `test.fail()`s: the 53 px
mobile toolbar, and S1e's T8-live test, which fails on a strict-mode locator, not the old crash). **RV-1A** (opus,
`rv-1a`, branch `feat/artifacts-s1-review-engine`, 5620) on the engine/server; **RV-1B** (sonnet, `rv-1b`,
`feat/artifacts-s1-review-editor`, 5630) on the editor/UI, owning the two `test.fail()`s and the dead code.
**SC** (sonnet, `art-card`, branch `feat/artifacts-chatcard` from `feat/artifacts` `34fcdaaa`, `node_modules` →
`art-s1`'s, 5640): step 0 merges `feat/artifacts-s1` into the App line (11 conflicts, found by a trial merge; the one
needing thought is `record.ts`: ruling-47 coalescing + Slice 2's `metadataPatch` together), step 1 builds the
in-chat card for every kind. Merge order after the reviews: `feat/artifacts-chatcard` → `feat/artifacts`, then
`feat/artifacts-s1` (review fixes only; the merge base is `e17c6f09`), then RV-7's S7.

**RV-7 done → Slice 7 merged into `feat/artifacts` as `d1364b54` (2026-09-26).** Verdict "ship with the two fixes":
`01e1754f` **critical containment leak**: `core.ts`'s canonical ownership exempted only `generated_output`/`work_capsule`
from the user-stamp fallback, so a `type:"artifact"` row preserved after its conversation's deletion (an outside
reference, e.g. a fork's link; `conversation_id` SET NULL) resurfaced in the Documents tab and search for its owner,
**incognito ones included**. Now `artifact` needs a live conversation link too; `isArtifactDeletableByUser` unchanged.
The containment suite covers it (34). `4865aa24`: the merged search sort's tie-break ignored the caller's sort key.
12,806 tests, Playwright 51. Open: the chip row's exact position vs the mockup (check in the Phase 4 walk). Gates on
`feat/artifacts` running (`/tmp/gates-fa-s7/`).

**Gates on `feat/artifacts` at the Slice 7 merge `d1364b54`:** check 0/17, biome clean, **12,806 tests**, build 32/2, Fallow 124/4
with 0 new, containment 34; Playwright 60/61. The one failure (`knowledge.spec.ts:222`) was order-dependent: a
substring `name: "Upload"` locator with `.first()` hit the new "Filter: Uploaded" chip whenever the library had rows.
It passed alone, and was reproduced deliberately by a fix agent → `78cad9af` (`exact: true`), fast-forwarded onto
`feat/artifacts`. No other ambiguous locators found.

**Owner request (2026-09-26): extract a shared focus-trap utility.** No earlier mention of it in this session; the
duplication is real: `DialogShell.svelte` has the careful trap (rendered-only focusables, topmost-only), and
`SearchModal`, `LinkedDocumentPicker`, `KnowledgeMemoryView/Modal` and Slice 1's `MobileToolbar` sheet hand-roll their
own; Slice 4 will need more. **Pass one** (sonnet, `art-focus`, branch `feat/artifacts-focus-trap` from `92cd7f2e`,
5660): the utility (from DialogShell's behaviour, attachment or action chosen against the Svelte 5.55 docs) and the
existing app dialogs, behaviour pinned by tests first. **Pass two** after Slice 1 merges: the Feature 2 sheets.

**SC done (2026-09-26).** `feat/artifacts-chatcard` HEAD `302e8bfc`. Step 0: `27a614e6` merges `feat/artifacts-s1` (`e17c6f09`) into the App
line (11 conflicts, both sides kept; `record.ts` took Slice 1's `updateArtifactBody`, where the metadataPatch merge runs
after either branch, with tests for coalesced-save-with-patch and Alfy-with-patch-appends; `client/api/artifacts.ts`
and `cases.test.ts` rebuilt from both blobs), `220ad0ab` gate fixes. Step 1: `45027cce` the in-chat card for every kind
(`create_artifact`/`edit_artifact` → a pinned `ArtifactCard` with Created/Edited, "Creating …" while running, nothing
for a refusal; `chrome="body"` now shows the full header for every kind but File; Open reuses `onOpenDocument` with
`conversationId`; ThinkingBlock enriches it with the Document preview after a reload; ticks share the panel's
write path), `302e8bfc` e2e with a fake-provider `create_artifact` scenario. 13,223 tests, Playwright 58/58, Fallow
124/4, containment 30. Deviations: no App verification subtitle on the card (no App preview field yet), no App
chat e2e (the create path runs real generation). **RV-SC (sonnet)** dispatched in `rv-sc` (branch
`feat/artifacts-chatcard-review`, 5670) on the merge and the card.

**Owner decisions (2026-09-26, weekly limit at 74%):** finish Wave 2, deploy it to **dev** with the tool-description trim, give the owner
sample tasks, then **pause until the weekly reset** (Mon 2026-09-28 ~10:00 IST); Waves 3–4 each run in a **fresh
orchestrator session** from this file. The campaign waits. Production only on the owner's word (it would need the
trim, which this wave now includes, plus a campaign). **Trim agent** (sonnet, `art-adv`, branch
`feat/artifacts-advertise` from `302e8bfc`): the advertised kinds are derived from `CREATE_ARTIFACT_HANDLERS`
(Document + App), and the three descriptions, the `artifactType` enum and the base-prompt paragraph (`prompts.ts:49`)
are assembled from per-kind fragments; snapshots regenerated; ceiling lowered.
**Final integration order:** `feat/artifacts-s1` ← `rv-1a` + `rv-1b` branches; `feat/artifacts-chatcard` ← `rv-sc` branch +
`feat/artifacts-advertise` + `feat/artifacts-s1`; `feat/artifacts` ← `feat/artifacts-chatcard` + `feat/artifacts-focus-trap`
(pass one); `npm install` in `art-base` (Tiptap); full gates; `dev` ← `feat/artifacts` in the main checkout, gates in
`dev-int`, push, deploy, real-model checks on ai.dev.

**RV-SC done (2026-09-26).** Verdict "merge": the Docs×Apps merge verified clean (both parents diffed against the result, nothing
lost, all three eval suites register, coalescing composes with `metadataPatch`, no Alfy write or restore coalesces);
one card defect fixed test-first (`7b67b293`): `chrome="body"` drew the title and icon a second time under the tool
row's own line, the regression slice-0 S6 had pinned, so the no-header rule is restored. Streaming cost measured ~0.18 ms
per re-render at 300×300. `feat/artifacts-chatcard` fast-forwarded to `7453b2f1` (13,226 tests, Playwright 63/63 with
one load flake that passes alone). Its open question (a refused tick may not revert the checkbox) was sent to RV-1B.

**Focus-trap pass one merged as `8c45ae03` (2026-09-26).** `src/lib/utils/focus-trap.ts` (a Svelte 5 attachment, `{@attach focusTrap(…)}`,
chosen per the docs; `getFocusableElements`, `trapTabKey`, `createFocusTrapStack`, options `selector/isTopmost/onEscape/
focus/restoreFocusOnCleanup/onTab`). Migrated DialogShell (its own stack instance, since CampaignModal joins it),
LinkedDocumentPicker, KnowledgeMemoryModal, KnowledgeMemoryView (three dialogs), ConversationJumpRail (custom `onTab`);
SearchModal shares only the lookup (its wrap is direction-sensitive). Skipped with reasons: MessageInput (autocomplete),
ProfilePictureEditor/ProviderForm (already DialogShell), ModelList. Every existing dialog test passed unmodified; +31
tests; gates at baseline (12,837 on its base). **Pass two** (after Wave 3 starts or earlier): the Feature 2 sheets
(Document mobile "More" sheet, download sheet) plus `campaigns/CampaignModal.svelte` and
`campaign-admin/CampaignCropModal.svelte` (the agent's task chip was withdrawn in favour of this). Not independently
reviewed yet: include it in the final review.

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
