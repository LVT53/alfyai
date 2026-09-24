# Feature 1 · Workspaces — progress

**Purpose:** a fresh session must be able to resume from this file alone. Update it at the end of every phase.

Last updated: 2026-09-24 (implementation session 2 — Phase 0 done, Wave 1 in flight)

## State

| Phase | State |
|---|---|
| Phase 0 — branch and environment | **complete** |
| Phase 1 — plan | **complete and approved** |
| Phase 2 — implementation | **Wave 1 in flight** (Slice A ∥ Slice B) |
| Phase 3 — adversarial review | not started |
| Phase 4 — verify for real | not started |

### Phase 0 result (2026-09-24)

- `feat/workspaces` = `98a34dfd` (dev) + `77dc3c77` (cherry-picked ADR-0064/0065) + `2718f718`
  (spec, mockups, handoff prompt, plan, decisions, all seven slices).
- `dev` == `origin/dev` == `origin/main` == `98a34dfd` — the base is clean and in sync.
- Worktrees: `.claude/worktrees/ws-a` (`feat/workspaces-a`) and `.claude/worktrees/ws-b`
  (`feat/workspaces-b`), both off `feat/workspaces`, each with a **cloned** `node_modules`
  (APFS `cp -Rc`, 9s, so parallel Vite caches cannot race) and a `data/` directory.
- Wave 1 dispatched: Slice A and Slice B, one agent each, both Opus.

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

Wave 1 is running. When both agents report: merge `feat/workspaces-a` and `feat/workspaces-b` into
`feat/workspaces`, dispatch the **Phase 3 adversarial reviewers** for the wave (Opus, never the implementers),
write `review-wave-1.md`, then merge `feat/workspaces` into `dev`, push `dev`, and run the dev deploy above for
the first end-to-end check. Then Wave 2 = Slice C off the merged `feat/workspaces`.
