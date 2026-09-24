# Feature 1 · Workspaces — progress

**Purpose:** a fresh session must be able to resume from this file alone. Update it at the end of every phase.

Last updated: 2026-09-24 (implementation session 2 — Phase 0 done, Wave 1 in flight)

## State

| Phase | State |
|---|---|
| Phase 0 — branch and environment | **complete** |
| Phase 1 — plan | **complete and approved** |
| Phase 2 — implementation | **Waves 1–4 merged** (A–E); **Wave 5 (F ∥ G) in flight** |
| Phase 3 — adversarial review | Waves 1–3 reviewed and fixed; **Slice E under review** |
| Phase 4 — verify for real | Waves 1–4 deployed to dev; E built; real-model checks pending |

### Wave 3 (Slice D, Project Instructions + the project page) — merged and deployed `6d59195d`

Seven commits, 49 files (+4 554 / −1 909). Adds `projects.instructions` (migration `1777140000108`, journal idx
121), the `/projects/[projectId]` page built on the extracted `HomeSurface`, the third entry point (the chat-header
breadcrumb is now a link), and `listRecentlyActiveProjects` for Slice G to consume.

**Verified on dev with a real model** (the checks the implementer explicitly left to the orchestrator):

| Check | Result |
|---|---|
| A project instruction changes the answer | **pass** — a real reply carried the token |
| It still applies on a **one-word** message | **pass** — proof it lives on the system message, not the turn packet |
| **Project instructions outrank personal instructions** | **pass** — with contradictory tokens set, only the project's appeared |
| Project page renders (name + Instructions quiet line) | **pass** |
| The project list payload carries `hasInstructions` and **never the text** | **pass** — independently confirmed |

Probe: `/tmp/ws-visual/probe-project-instructions.mjs` (cleans up after itself).

### Two out-of-plan fixes the owner asked for (2026-09-24)

Both branch from `dev`, neither touches the feature's files, and both are being verified the same way as
everything else (failing test first, mutation check, gates):

| Branch | Bug | Owner's call |
|---|---|---|
| `fix/context-ring-popover-mobile` | The context-ring popover is anchored at the ring's left edge, so at 390×844 it runs **197px** off screen (measured). Pre-existing — the component had no `@media` rules at `98a34dfd` either. | "Fix it please." |
| `fix/admin-config-number-canonicalisation` | `admin-config-registry.ts` canonicalises an accepted number with `String(parsed)`, which emits exponent notation below ~`1e-6` (`0.0000001` → `1e-7`); the same validator's text check rejects `e`, so the stored value 400s on the next save and the admin page can no longer save that field. Affects **any** `number`-controlled admin setting. | Chose the minimal fix: never emit exponent notation, rather than teaching the validator to accept it or adding a new rejection reason with EN/HU strings. |
| `fix/live-chat-evidence-metadata` | On a **live** chat page the Info popover shows **no evidence rows at all** until the conversation detail is reloaded, so the Sources area — not just the new project-files row — is missing right after a turn. Recorded evidence: `/tmp/slice-e-run-dd.log` (`no Project files row (attempt 1, stage live)` … `Project files row found (stage reloaded)`). Pre-existing; found by Slice E while building its capture harness. | Owner: "Fix the pre-existing bug too." |

**Both landed and are deployed** as `fb7b46c7`. Each was proved by a failing test first plus a revert-and-reproduce mutation check, and each was then verified by the orchestrator independently of its author:

- **Popover:** measured on the *deployed* build at 390×844 — panel left 229 → 4, width 358 → 382, right edge **587 → 386** (inside the viewport), bottom 756 (clears the composer). Desktop is pinned untouched by a byte-identical computed-style comparison at 1440×900.
- **Canonicalisation:** driven directly against the merged tree — `0.0000001` stores as `"0.0000001"` and re-validates idempotently; `2.50`/`.5`/`5.00`/`-0` are unchanged; and typing `1e3` is *still* rejected, which is precisely the property that distinguishes this fix from the broader option the owner declined. The agent also found a genuinely involved **second site** (`config-store.ts`, the read path that seeds the admin field) without which the field would still have displayed `1e-7`.

**Owner also resolved the production row count** (recorded in `review-wave-1.md`): the migration may run without a
count first — "is fine, no one used it" — matching dev's measured zero.

### Wave 4 (Slice E, Folder Knowledge) — merged `fecb790a`, under review

Thirteen commits, 64 files, migration `1777140000109` (journal idx 122). Adds the `project_knowledge_links`
table, the two Files dialogs, the protected `## Project Files` section, on-demand file reading, the read-count
row, and archive/erasure coverage. The `home_suggestion_events` removal is Wave 5's (Slice G).

**The cap (plan Review Focus 3) is proven at the character level:** 35 files → 30 entries + `+5 more` with the
31st name *absent* from the constructed prompt (dropped whole, never clipped); 40 wide entries → 28 lines +
`+12 more` where the character cap bites before the entry cap; and a 1 600-character filename → the body is
exactly `+2 more` with the name's first 120 characters absent everywhere.

**Ownership and non-destruction** are covered by tests on both sides of the boundary — cross-user link, list,
name-resolution and unlink all refused, with "writes nothing" asserted; unlink leaves the artifact and its bytes,
a second unlink is a no-op, project deletion keeps the library files, and deleting a library file leaves no
dangling link.

**Slice E found two of its own defects** during the mockup check and fixed both (`34888d93`, `c282c212`).

**Verified on dev with a real model** (deployed `5eab8541`), the checks the implementer could not run:

| Check | Result |
|---|---|
| Upload a file directly into a project (the upload-link path) | pass |
| It becomes linked to that project | pass |
| **A real turn answers from the file's content** — asked for a booking reference held only in the uploaded file, and the reply contained it | pass |
| Unlink succeeds | pass |
| **The library file still exists after unlinking** | pass |
| The project no longer lists it | pass |

That third row is the heart of the feature: the file's *content* reached the model on demand, not just its name.
Probe `/tmp/ws-visual/probe-folder-knowledge.mjs` (uploads, verifies, unlinks, and leaves the project as it found
it — the uploaded file stays in the library, which is the correct end state).

**Three findings the orchestrator should carry, none of them Slice E's:**

- **(a) Pre-existing and broader than this slice:** on a *live* chat page the Info popover shows **no evidence
  rows at all** until the conversation detail is reloaded — the streamed message object does not carry the
  persisted `metadataJson`. It affects every evidence row, not just project files. Needs its own ticket.
- **(b)** the mention path fails open for `resolveProjectFileMentions` (`context-selection.ts:708-730`) — flagged
  to the reviewer rather than fixed unilaterally.
- **(c)** an E2E normalisation lag: a turn started before the background normaliser lands sees a source document
  with no text. App behaviour, not a test workaround.

**One order-sensitive constraint the reviewer must check:** in `MessageBubble.svelte`,
`.info-container .info-popover.info-popover-forced-closed` must stay **after** the `@media (hover: hover)` hover
rule — order, not specificity, is what makes the press win, and the unit test pins the behaviour but not the
sheet order.

### Wave 5, Slice G — merged `bc910efc`, deployed `3aeea01f`, verified

Two commits. The removal is total and guarded: the rail component, the service, its test, the rate limiter and
its test are deleted; `home_suggestion_events` is gone from `schema.ts`, `prepare-db.ts` and
`user-scoped-tables.ts`; the incognito allow-list no longer exempts the deleted file; `HomeSummary` carries no
`suggestions`; the summary endpoint accepts only the one remaining action. A guard test
(`home-sources-removal.test.ts`) pins the removal, and it deliberately exempts `drizzle/` because migrations are
immutable — the historical CREATE stays, the DROP (`…110`, journal idx 123) is the fix.

**Verified on dev** at 1440×900 and 390×844, light and dark, with the theme asserted before each dark capture:
the "Projects" heading and card render with an accessible name, the first card fits inside the viewport at both
widths, there is no horizontal page scroll, **no suggestion/chip elements remain on the home surface**, and there
were zero page errors in all four variants. The screenshot confirms it visually: folder icon + "Q3 Review
mock-seed" + "5 chats · active 28 minutes ago", between the composer and the conversations list.

**A deviation worth keeping:** the slice document named i18n keys that do not exist (`instructions.projectStats`
and friends); the real ones are `projects.stats` etc. from Slice D. The agent used the real keys — the slice's own
instruction said to reuse Slice D's keys rather than add a second vocabulary — which is why the stats line reads
"active 28 minutes ago" rather than §M6's "28 minutes ago".

### Wave 4 review outcome (Slice E) — merged `e0275a04`, deployed `6a5b8fe8`

See `review-wave-4.md`. Eleven commits; the consequential ones were a **race that could resurrect a removed
file row** (the list was assigned from whichever read resolved last), a **Files modal with no phone layout**, an
**order-sensitive CSS rule** nothing else would have caught, and **five dead incognito allow-list exemptions**
that could never be consulted — now removed, with the honesty test requiring every entry to be reachable so a
stale exemption fails the suite. Ownership, non-destruction (checked against the bytes on disk, not just rows),
the "+N more" cap and the failing-open mention path were all attacked and cleared.

### Wave 5, Slice G review — merged `69df01c4`

Four commits. Two real defects and one coverage gap: a test name that still referenced the deleted feature, a
stale incognito allow-list reason (the service now reads the projects row too), and — the useful one — **nothing
proved the DROP migration reaches an already-deployed database**. That test now exists and was proved to have
teeth by lowering the journal `when` and watching the table survive. Decision 12 (total removal) and decision 9
(rule placement in the query, not a client filter) were both cleared, and the F/G overlap hunks were verified to
have removed only dead wiring with no composer regression.

Reported and not fixed, for the record: `home-summary.ts:48` reads `process.env.HOME_SUMMARY_CACHE_TTL_MS`
directly instead of through `env.ts` (an `AGENTS.md` violation, pre-existing at the slice's base); `CHANGELOG.md`
has no `[Unreleased] Removed` entry for the chips; the removal guard scans only `src`/`tests`/`scripts` (verified
harmless today); and the slice's checklist item "Fallow **fewer** findings" is met as *equal*, not fewer — the
reviewer said so rather than letting it pass.

### Two more fixes in flight, from review findings

- `fix/live-chat-evidence-metadata` — the owner's request: the Info popover loses every evidence row after a turn
  until a detail reload. The agent must establish which of two causes is real before changing anything.
- `fix/upload-link-failure` — an unexpected failure while linking a project upload can 500 a request whose bytes
  are already saved and skip extraction registration, leaving the file permanently unusable. The reviewer reasoned
  this without reproducing it, so the agent must **reproduce it or prove it impossible** first. Also carries a
  one-line empty-state fix in the Files modal.

### Wave 5, Slice F — in flight

### Wave 5 (Slice F ∥ Slice G) — the parallel decision, recorded

Both are cut from the merged `feat/workspaces` at `fecb790a`, in parallel. The plan's rule is kept in the briefs:
**G owns the deletions in `src/lib/i18n/chat.ts`** (the `home.suggest.*` block) and F adds its own keys in its own
region, so the two merge cleanly instead of colliding in that file. F must not build G's home row and G must not
build F's `/instruction`; both are told so explicitly, plus the standing rule about not editing Slice C's dialog.

The judgement is the same as the C∥D and D∥E overlaps: the shared surfaces are distinct regions of the same
files, and a conflict would be small and local. Recorded so it can be undone if the merge turns out dirty.


Started **before** Slice D's review finished, deliberately: E's only file overlap with D is
`src/lib/components/home/HomeSurface.svelte`, where E adds the files half of the quiet line in a distinct region,
so a conflict would be small and local. Everything else in E is new files or its own territory. E branches from
the merged `feat/workspaces` at `6d59195d`.

**The tunnel to dev dies with the shell that starts it.** `nohup … &` does not survive the tool's process
cleanup; a backgrounded `ssh -N` is reaped as soon as the command returns. Start the tunnel and the browser
script **in the same command** (`ssh -N -L 3010:127.0.0.1:3002 alfyroot & … ; kill $!`). Verified twice.


### Wave 2 (Slice C, Personal Instructions) — merged as `94d00b89`

Seven commits, 52 files (+3 044 / −22). Adds `users.personal_instructions` (migration
`1777140000107`, journal idx 120 — the doc's idx 118 was stale), the shared code-point limit in
`src/lib/shared/instructions.ts`, the single `InstructionsDialog` every entry point reuses, the system-message
section, the audit row, and the archive/erasure coverage.

**Deliberate change to the wave discipline, recorded so it can be undone if it goes wrong:** Slice C's review and
Slice D's implementation now run **in parallel** instead of strictly serial. The plan serialises them because D
needs C's dialog, but that dependency is a frozen, documented component contract, and D is instructed to
**consume `InstructionsDialog.svelte` / `ScopeToken.svelte` and never edit them** — if D needs a change it must
report it instead. Risk: if C's reviewer changes that contract, the two must be reconciled at merge; the impact is
confined to the dialog's props, which D only reads. Everything after D stays serial.


### Wave 1 review outcome (2026-09-24) — `review-wave-1.md`

Both reviews found real defects, all fixed test-first and merged:

- **Slice A:** three dead remnants removed (plus a fourth, `mapTaskEvidenceLink`, found by a hand sweep because
  Fallow is blind under `src/lib/server/services/**`), and **the "inert" premise retracted** — the pin/exclude
  surface's effect chain was live; only its display chain was dead. See the correction under `decisions.md`
  decision 6.
- **Slice B:** the admin allowance field **rewrote the digits as they were typed** — typing `2.5` into a field
  showing `5.00` produced `2.005` — fixed with an e2e test; and a false `docs/configuration.md` caveat about
  what saving the allowance does to the month already booked.
- **Open for the owner:** `admin-config-registry.ts:938-941` canonicalises a sub-micro allowance to `1e-7`, which
  its own regex then rejects on the next save (400). Pre-existing validator behaviour, needs a design call.

Integrated gates at `66a37cbc`: check 0 errors/17 pre-existing warnings; biome 1 pre-existing; **11 692 tests
passed**; build exit 0 with the same 17 pre-existing warnings (34 lines); migrations pass; Fallow 124 issues,
4 cycles, no new suppressions.


### Wave 1 result (2026-09-24)

- **Slice A** — `feat/workspaces-a`, 4 commits, 58 files, +466/−3563: the panel surface, the task-steering
  endpoint, the Context Sources projection and the stored user pins/exclusions are gone. Migration
  `1777140000106_retire_user_evidence_preferences.sql` (dry run on a prod-shaped copy: 3 of 8 rows, idempotent,
  FK/integrity clean).
- **Slice B** — `feat/workspaces-b`, 9 commits, 26 files: the server-wide Parallel free monthly allowance, applied
  inside `recordParallelUsage`'s transaction, with a replay script and an admin meter.
- Merged into `feat/workspaces` as `063f9cf3`; the two slices' changed-file sets are provably disjoint
  (`comm -12` of the two name lists is empty), so the merges were clean.

**Gates measured by the orchestrator on the merged tree** (authoritative — the implementers disagreed):

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, **17 warnings**, all pre-existing: `RouteItinerary.svelte` ×1, `ToolActivityRow.svelte` ×10, `ThinkingBlock.svelte` ×6. None of the three is touched by this wave (`git diff --name-only 98a34dfd..HEAD` lists none of them), and an unchanged file cannot emit a changed warning, so they are inherited, not introduced. **Both the "0 warnings" gates in the plan are unmeetable on this repo as it stands** — the honest gate is "no new diagnostics", per `AGENTS.md`. |
| `npm run build` | exit 0, but it **does** emit the same 17 warnings — 34 log lines, because each warning is printed once in the SSR pass and once in the client pass. Slice A was right and Slice B was wrong. **Do not grep the build log for the word "warn":** `vite-plugin-svelte` prints them as `… [vite-plugin-svelte] <file>:<line> Unused CSS selector "…"` with no "warning" anywhere, which is why Slice B counted zero. Count `Unused CSS selector` + `must have an ARIA role` instead. |
| `npx biome check src scripts tests` | 1836 files, **1 warning**, pre-existing (`MessageEvidenceDetails.svelte:298`). |
| `npm run check:migrations` | passes. |
| `npm test` | **774 files passed, 1 skipped (775); 11685 tests passed, 2 skipped (11687)**, exit 0, 104 s. |

Known pre-existing quirks, confirmed on a pristine baseline by both agents: `npx drizzle-kit generate` fails
with "Interactive prompts require a TTY"; Fallow reports **4** circular-dependency findings where `AGENTS.md`
says five (the "five" is stale).

### Phase 0 result (2026-09-24)

- `feat/workspaces` = `98a34dfd` (dev) + `77dc3c77` (cherry-picked ADR-0064/0065) + `2718f718`
  (spec, mockups, handoff prompt, plan, decisions, all seven slices).
- `dev` == `origin/dev` == `origin/main` == `98a34dfd` — the base is clean and in sync.
- Worktrees: `.claude/worktrees/ws-a` (`feat/workspaces-a`) and `.claude/worktrees/ws-b`
  (`feat/workspaces-b`), both off `feat/workspaces`, each with a **cloned** `node_modules`
  (APFS `cp -Rc`, 9s, so parallel Vite caches cannot race) and a `data/` directory.
- Wave 1 dispatched: Slice A and Slice B, one agent each. **All sub-agents run on the supplied DeepSeek model**
  (owner instruction 2026-09-24: never dispatch a Claude model) — omit the `model` parameter on every `Agent`
  call so the sub-agent inherits the session model. The first dispatch used `model: "opus"`; those two agents
  were stopped early, their uncommitted work saved to `/tmp/ws-claude-attempts/` and the worktrees reset, then
  both slices were re-dispatched on DeepSeek.

### Dev verification of Wave 2 — Personal Instructions (2026-09-24)

Deployed as `57bec090`. Migrations 121/121 applied, `users.personal_instructions` exists, and the bundle carries
the instructions namespace (6 files) and `personalInstructions` (18).

Verified in a browser **against the deployed environment**, light and dark:

- Settings → Profile → Assistant behaviour → **Personal instructions** row present; the shared dialog opens; the
  counter reads `n / 2000`.
- **Boundary, measured on dev:** exactly **2 000 accented code points** (`árvíztűrőtükörfúrógép` repeated) are
  accepted with Save **enabled**; **2 001** (2 000 `a` + one emoji) keeps every code point in the field, never
  truncates, and disables Save. The dark pass's counter read `2000 / 2000`, which independently proves the light
  pass's save persisted.
- **Real-model proof:** with the instruction *"Always end every reply with the exact token PURPLEHIPPO…"* set, a
  real turn on dev returned a reply containing the token; after clearing it, the next real turn did not.
  Zero page errors throughout. Scripts: `/tmp/ws-visual/probe-instructions.mjs`, `probe-live-turn.mjs`.

**Two probe bugs I hit and fixed — neither was an app defect, and the first run's "failure" was meaningless:**
1. The first live-turn run reported `instructions applied = false`, but the URL had stayed on `/` — the message
   was never sent, so it measured the home page. **Enter does not submit the landing composer**; click the send
   control instead.
2. The first "at-limit" case only reached 440 code points (the repeat count was too small), so it proved nothing
   about the boundary. Fixed to build exactly 2 000.

### Dev verification of Wave 1 (2026-09-24)

The owner said the dev environment is a playhouse and that the prod cutover happens only after **all** waves, so
the pre-cutover prod row count is a deferred item, not an open risk.

- **What is deployed:** `current -> releases/66a37cbc`, service healthy, journal clean since the restart (no
  errors or warnings), migration applied (dev went 119 → 120 applied migrations), the 33 existing
  `selected|system` evidence links untouched, and the migration matched **0 rows** on dev.
- **Bundle proof with a control.** Comparing the previous release against the new one:
  `Manage context sources` 3 files → **0**, `task-steering` 7 → **0**, `parallelFreeMonthlyUsd` 0 → **9**. The
  old release's non-zero counts are what make the zeros evidence. (Note: these strings live in `build/server`,
  not `build/client/assets` — searching only the client bundle proves nothing either way.)
- **Rendered check on the deployed instance.** `visual-test@local` was created on dev
  (`scripts/ensure-visual-test-user.ts`, the repo's own browser-verification account) and
  `scripts/seed-mock-conversation.ts` seeded a conversation. Driving the *deployed* environment through an SSH
  tunnel (dev is not reachable from the Mac) at 1440×900 and 390×844, light and dark: the ring popover renders
  CONTEXT ROOM, Compaction "LLM fallback", "Sources included", "What AlfyAI remembers" and the three layer chips,
  with **no** manage control and no Pinned/Excluded rows. Zero page errors in all four variants.
  Harness: `/tmp/ws-visual/verify.mjs` (outside the repo; symlinks the repo's `node_modules`).
- **Two traps that made an earlier pass prove nothing**, recorded so nobody repeats them:
  1. The first run reported "16 screenshots, light and dark" while the light and dark files were **byte-identical
     (same md5)**. `initTheme` prefers the **server-side** preference over `localStorage`, so seeding
     `localStorage.theme` is silently overridden. The harness now PATCHes `/api/settings/preferences` and asserts
     `document.documentElement.classList` actually contains `dark` before it claims a dark pass.
  2. Dev shows a release-campaign modal that swallows clicks; the harness dismisses it before interacting.
- **Ring shows 0% on the seeded conversation** — not a regression. The ring derives `promptTokens` from
  `contextStatus.promptTokens`, which the mock seed stores as `0` (`estimatedTokens` is 98000). That derivation
  is untouched by this wave (`git diff 98a34dfd..HEAD -- ContextUsageRing.svelte` changes only `contextSources`
  code), and `contextStatus` is intact in the conversation-detail API payload.
- **Pre-existing mobile defect noticed, NOT caused by this wave and deliberately not fixed:** on a 390px
  viewport the ring popover is anchored at the ring's left edge and overflows the right edge by **197px**
  (measured: panel x=229 width=358 in a 390px viewport). There were **no `@media` rules in this component at the
  base commit either**, and the wave's diff touches no positioning CSS — only the removed manage button's
  `.popover-action` rules. Reported for the owner; fixing it is outside the approved plan.

### Deploy facts for the dev environment (verified 2026-09-24)

- Dev = `langflow-chat-dev.service` on `:3002`, app dir `/home/alfydesign/apps/langflow-chat-dev`,
  release layout with `current -> releases/<sha>` (ADR-0054).
- The deploy **fetches from `origin`**: `git -C $APP_DIR fetch origin $DEPLOY_BRANCH` then
  `git archive origin/$DEPLOY_BRANCH`. So code only reaches the box through a pushed branch —
  deploying to dev therefore requires pushing `dev`. **Prod (`main`) is not touched.**
- Dev deploy command (works unattended):
  `ssh -T -o ConnectTimeout=8 -o BatchMode=yes alfyroot 'sudo -u alfydesign -H bash -c "cd /home/alfydesign/apps/langflow-chat-dev && APP_DIR=/home/alfydesign/apps/langflow-chat-dev ./current/scripts/deploy-dev.sh"'`
- `alfydesign` **does** have `(ALL) NOPASSWD: /usr/bin/systemctl restart langflow-chat-dev.service`,
  so the restart caveat in `deploy-dev.sh` is stale; restarts do not need `alfyroot`. The same
  NOPASSWD list also covers `langflow-chat.service` (prod) — **never** run that one.
- The deploy verifies migrations, **backs up the DB**, runs `npm run db:prepare`, then flips
  `current` atomically. Dev DB: `shared/data/chat.db` (113 MB, its data may be changed freely).
- Phase 4 harness on the box: `/root/verify-harness.mjs`, `/root/verify-pdf.mjs`,
  `/root/verify-tools.mjs`, creds in `/root/verify-harness.env` (staging only).
- Local Playwright browsers are installed; `scripts/campaign-shots.ts` is the template for a
  desktop+mobile screenshot pass against a deployed URL (login through `/api/auth/login`).

**The owner ratified all 24 open questions on 2026-09-24.** The master record is `decisions.md`; each slice
repeats the decisions that affect it. Where a slice and `decisions.md` disagree, `decisions.md` wins. No slice's
scope, file ownership or test list changed as a result of the answers.

## Phase 1 deliverables

- `docs/plans/claude-at-home-1/plan.md` — slice order, dependencies, parallelism, hot-file table, wave plan,
  model assignment, Phase 0 commands, verification protocol, owner decisions, open questions.
- `docs/plans/claude-at-home-1/slice-A.md` — Manage context sources + the Context Sources projection removal.
- `docs/plans/claude-at-home-1/slice-B.md` — Parallel free monthly allowance.
- `docs/plans/claude-at-home-1/slice-C.md` — Personal Instructions.
- `docs/plans/claude-at-home-1/slice-D.md` — Project Instructions and the project page.
- `docs/plans/claude-at-home-1/slice-E.md` — Folder Knowledge: the link table, the Files modal, the protected
  `## Project Files` section, and the three content-on-demand paths.
- `docs/plans/claude-at-home-1/slice-F.md` — `/instruction` and AI instruction suggestions.
- `docs/plans/claude-at-home-1/slice-G.md` — home chips out, projects row in.

## Facts established during planning (do not re-derive)

- `claude/brave-meitner-98df21` = `7812c08e` + one commit `fc7f713d` (ADR-0064/0065, AGENTS.md, CONTEXT.md).
  `dev` is 30+ commits ahead of the base and does not contain `fc7f713d`. Cherry-picking `fc7f713d` onto `dev`
  is **conflict-free** (verified with `git merge-tree`).
- The three feature documents in `docs/plans/` are **untracked** on that branch — add and commit them, do not
  cherry-pick them.
- `npm run lint` cannot be used with nested worktrees; lint `npx biome check src scripts tests`.
- `tests/e2e/global-setup.ts` seeds `admin@local` / `admin123` and uses `data/playwright-e2e-chat.db`;
  `playwright.config.ts` sets `HOME_SUMMARY_CACHE_TTL_MS=0` so home tests are not cached.
- The incognito containment guards live in `tests/cross-cutting/incognito-{conversation,artifact}-containment.test.ts`
  and work by scanning `src/lib/server` for files that read the protected tables; a new such file needs either a
  scope marker or an `ALLOWED_WITHOUT_SCOPE` entry **with a reason**, and a stale entry fails the suite.
- `normal-chat-context.ts` has **no project awareness and reads no project data** today; Slice D threads the
  resolved text in as a parameter.
- The system message is assembled in one place: the `sections` array in `buildOutboundSystemPrompt`
  (`normal-chat-context.ts:501-521`), joined with `"\n\n"` and passed through `stripDeprecatedPromptSections`,
  which silently deletes any paragraph containing `<preserve>`, "preserve tags" or "translation-preserved".
- `normal-chat-context.test.ts:738` currently pins `## Response Style` as the **last** section. Slice C
  intentionally changes that; the assertion is replaced, not deleted.
- Parallel rows in `usage_events` are identified by `modelId LIKE 'parallel:%'`; there is no `provider` column.
  `recordParallelUsage` has no transaction today.
- The landing page's content must move into `src/lib/components/home/HomeSurface.svelte`; the existing landing
  specs must pass **unmodified** as the proof that nothing changed.
- No `/projects` route exists today.

## Decisions this plan made where the spec was silent

All ratified by the owner on 2026-09-24. Full texts and reasoning in `decisions.md`.

1. Response Style stops being the last system-message section (Slice C) — the order assertion is updated, not
   deleted.
2. Instructions are resolved outside prompt assembly and passed in (Slice C).
3. The 2,000-character limit counts Unicode code points (Slice C).
4. The instruction sections are appended **after** `stripDeprecatedPromptSections` runs, so the stripper never
   scans user text (Slice C).
5. One scope at a time in the dialog; the visible scope is the only one saved (Slice C).
6. The project page keeps the incognito arm (Slice D).
7. The quiet line under the project composer ships in two steps, instructions first (Slice D, Slice E).
8. `listRecentlyActiveProjects` lives in `projects.ts`, and the home row consumes it (Slice D, Slice G).
9. A project with no chats gets no home card (Slice G).
10. `suggest_instruction` is registered per conversation, not gated per turn (Slice F), with a named fallback:
    an accept filter inside the tool's `execute` body if staging shows spurious offers.

## Next action

Wave 1 is deployed to dev. **Slice C (Personal Instructions) is in flight** in `ws-c` (`feat/workspaces-c`), cut
from the merged `feat/workspaces`. When it lands: review it adversarially (a fresh agent, never the implementer),
fix, merge, deploy to dev again, then Wave 3 = Slice D.

**Standing rule learned in Wave 1: partition Playwright ports.** Every worktree defaults `E2E_PORT` to 5175, and
Slice A's agent killed Slice B's dev server to free the port. Give every agent a distinct `E2E_PORT`.

**Standing rule: never grep the build log for the word "warn".** `vite-plugin-svelte` prints warnings as
`[vite-plugin-svelte] <file> Unused CSS selector "…"` with no such word, so that count reports zero. Count
`Unused CSS selector` + `must have an ARIA role`; each warning appears twice (SSR pass + client pass).
`feat/workspaces`, dispatch the **Phase 3 adversarial reviewers** for the wave (DeepSeek, never the implementers),
write `review-wave-1.md`, then merge `feat/workspaces` into `dev`, push `dev`, and run the dev deploy above for
the first end-to-end check. Then Wave 2 = Slice C off the merged `feat/workspaces`.
