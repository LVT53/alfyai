# Feature 1 · Workspaces — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. **Read this file first, then your slice's file.** Each `slice-*.md` is a self-contained plan for
> one agent.

**Goal:** Ship "Claude at home" item 1 — Personal Instructions, Project (Folder) Instructions, Folder
Knowledge, the project page, `/instruction` with AI suggestions, the home projects row — and remove "Manage
context sources" and the home suggestion chips, plus the Parallel free monthly allowance.

**Architecture:** Instructions are **user-typed standing guidance stored on a row** (`users.personal_instructions`,
`projects.instructions`) and rendered into the **system message** after Response Style, so they apply on every
turn including the shallow path and incognito, and stay byte-identical across turns of a conversation so the
provider prefix cache survives. Folder Knowledge is a **new link table** (`project_knowledge_links`) pointing
at ordinary library artifacts, never a copy, resolved through the existing linked-sources and
`read_generated_file` machinery. One modal component is the only editing surface for every entry point.
Slice B changes Parallel *billing* only: the allowance is applied inside the existing `recordParallelUsage`
write.

**Tech Stack:** SvelteKit + Svelte 5 runes, Drizzle ORM on better-sqlite3, Vercel AI SDK tools, Tailwind with
`src/app.css` tokens, Lucide icons, Vitest, Playwright, Biome, Fallow.

**Spec:** `docs/plans/claude-at-home-1-workspaces-spec.md`. Mockups:
`docs/plans/claude-at-home-1-workspaces-mockups.html` (§M1–§M9; open it in a browser). Owner sign-off:
ADR-0064 item 1, ADR-0065 (context only — Living Documents are a later feature and are out of scope here).

## Global Constraints

Copied verbatim from the spec and the handoff; every task in every slice implicitly includes these.

- **Node 22 only.** `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` on every npm/npx/vitest/playwright call.
  Node 26 breaks `better-sqlite3`.
- **Precedence, highest to lowest:** current message → Project Instructions → Personal Instructions → Memory →
  Style. Do not reopen.
- **Instructions apply on every turn**, shallow path and incognito included, because they live in the system
  message, not the packet. The system message plus tool schemas stay **byte-identical between turns** until the
  user edits their instructions.
- **AI suggestions never appear in incognito.** `/instruction` still works there.
- **Length limit: 2,000 characters** each. Rejected with a `400`. **Never silently truncate.**
- **One editing surface:** every entry point opens the same `InstructionsDialog`. Nothing is saved without the
  user seeing the full text.
- **The folder token.** A project appears as a token (folder icon + name), never in running text. The personal
  scope is the token "[user icon] You". HU token: "[user icon] Te".
- **Folder Knowledge:** files are ordinary Library Documents; linking never copies; unlinking never deletes.
- **i18n:** every new string exists in English and natural Hungarian in the same commit; parity tests pass.
- **Icons:** Lucide via `@lucide/svelte` only; never inline `<svg>` icons. Colours and spacing from `src/app.css`
  tokens, never hard-coded.
- **Boundaries** (AGENTS.md): routes are thin adapters; browser fetches in `src/lib/client/api/`; runtime config
  through `env.ts` → `config-store.ts`; prompt assembly in `normal-chat-context.ts`; knowledge logic behind
  `knowledge.ts`; persisted message metadata in `messages.ts`; model tools in `normal-chat-tools/` with their
  usage guidance in the tool interface (ADR-0055).
- **Schema:** every new table needs a Drizzle migration **and** a `_journal.json` entry;
  `npm run check:migrations` must pass; new user-scoped tables must be registered in
  `src/lib/server/services/account-lifecycle/user-scoped-tables.ts` or the completeness guard fails.
- **Commits:** small, focused, explaining *why*. Stage by explicit path. **Never** bare `git stash`. End every
  commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- **Never push and never deploy to production** without the owner's explicit go-ahead.
- **`npm run lint` is broken** by nested worktrees (biome finds nested roots under `.claude/worktrees`). Lint
  `npx biome check src scripts tests` instead and say so in reports.

## Review Focus

The five failure modes the spec implies but no single task's happy path exercises. Each is pinned by a test in
the task named next to it.

1. **An instruction that is exactly at or just over 2,000 characters.** The browser counter and the server
   check must agree on what "a character" is (code points, not UTF-16 units) for Hungarian accents and emoji,
   and the over-limit case must be a `400`, never a truncation (Slice C, Task C1 + Task C3).
2. **An instruction containing text that looks like prompt structure** — `## Project Instructions`, a `<preserve>`
   tag, "translation-preserved". Section boundaries must not move, and `stripDeprecatedPromptSections`
   (`normal-chat-context.ts:521` → `prompts.ts:311-317`) must not silently delete a user's paragraph, because
   it currently deletes any paragraph containing those tokens (Slice C, Task C4).
3. **A project with more linked files than the packet cap** — the `## Project Files` section must emit
   "+N more", stay inside its character budget, and never emit a half-truncated name (Slice E, Task E5).
4. **Two Parallel calls recorded at the allowance boundary**, including from different users, must not let the
   server-wide month total exceed the allowance (Slice B, Task B2).
5. **Deleting a project that has linked files** — the library files, their bytes and their rows must survive;
   the instructions and the links must go; the home projects row and the sidebar must not keep a ghost (Slice
   D, Task D2; Slice E, Task E2).

---

## Slice order, dependencies and parallelism

```
Wave 1   A (removals)   ∥   B (Parallel allowance)          — disjoint file sets
Wave 2   C (Personal Instructions)                          — needs wave 1 landed (chat page/MessageBubble)
Wave 3   D (Project Instructions + project page)            — needs C's dialog component
Wave 4   E (Folder Knowledge)                               — needs D's project page and Files-modal entry point
Wave 5   F (/instruction + AI suggestions)  ∥  G (home)      — both need D; F also needs C
```

**Why this order.** The spec's own suggestion is A and B first, then C → D → E → F, with G after D. G is moved
to the last wave rather than running beside E because **G's project card needs E's `project_knowledge_links`
table for its file count** and D's `hasInstructions` flag — an earlier G would ship a card that cannot fill two
of its three lines.

**The honest finding: this feature is almost entirely serial.** Of the seven slices, exactly two pairs can run
concurrently. Everything else is blocked by a shared file or a missing dependency:

- D needs C's `InstructionsDialog`; E needs D's project page; F needs C and D; G needs D and E.
- A must precede C (both edit `MessageBubble.svelte`) and D and F (all three edit the chat page).
- B is independent of everything.

**Where parallelism is genuinely available:** **A ∥ B** is unconditional and disjoint. **F ∥ G** works with one
rule: `src/lib/i18n/chat.ts` is a serialized hot file — land G's deletions of `home.suggest.*` first, then F
adds its keys and rebases that one file.

**Where parallelism is NOT available, and must not be attempted:**

| Hot file | Slices | Rule |
|---|---|---|
| `src/lib/server/services/messages.ts` | C, E, F | one writer at a time; C → E → F |
| `src/lib/components/chat/ResponseAuditDetails.svelte` | C, E | C → E |
| `src/lib/server/services/normal-chat-context.ts` | C, D | C → D |
| `src/routes/(app)/chat/[conversationId]/+page.svelte` | A, D, F | A → D → F |
| `src/routes/(app)/+page.svelte` (landing) | D, G | D → G |
| `src/lib/i18n/chat.ts` | A, E, F, G | A first (deletions), then E, then G's deletions, then F |
| `src/lib/i18n/projects.ts` (new) | D, E, G | D creates it; E and G append to the en/hu objects in place |
| `src/lib/components/home/HomeSurface.svelte` (new) | D, E, G | D creates it; E adds the files half of the quiet line; G swaps the chips for the cards |
| `src/lib/i18n/settings.ts` | B, C | B → C |
| `src/lib/components/chat/MessageBubble.svelte` | A, C, F | A → C → F |

## Model assignment (handoff §Phase 2)

| Work | Model | Why |
|---|---|---|
| Slice A (migration + data deletion + wide removal) | **Opus-class** | a wrong `DELETE` or an over-deletion is expensive |
| Slice B (billing transaction, config plumbing) | **Opus-class** | money math and a transaction |
| Slice C, D, F (prompt/model-facing text, tool interface) | **Opus-class** | prefix-cache and precedence mistakes are subtle |
| Slice E (knowledge retrieval, ownership checks) | **Opus-class** | auth/ownership and retrieval authority |
| Slice G, and the UI/i18n/test halves of A, C, D | Sonnet-class is fine | mechanical against a frozen contract |
| **All adversarial reviewers** | **Opus-class**, never the implementer | the whole point of Phase 3 |

Never let a sub-agent inherit the session model for reviews (owner standing preference).

---

## Phase 0 — branch and environment (do this before Wave 1)

Verified against the tree on 2026-09-24:

- `claude/brave-meitner-98df21` is `7812c08e` + exactly one commit, `fc7f713d`
  ("Record the 'Claude at home' goals and the Living Document decision"), which touches `AGENTS.md`,
  `CONTEXT.md`, `docs/adr/0064-…`, `docs/adr/0065-…`, `docs/adr/README.md`.
- `dev` is **30+ commits ahead** of `7812c08e` and does **not** contain `fc7f713d`.
- A dry-run merge of `fc7f713d` into `dev` is **conflict-free** (no shared files changed on `dev` since the
  merge base).
- The three feature documents (`claude-at-home-1-workspaces-spec.md`, `…-mockups.html`,
  `…-handoff-prompt.md`) are **untracked** on that branch — they must be **added and committed**, not
  cherry-picked.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
git fetch origin
git checkout -b feat/workspaces dev
git cherry-pick fc7f713d                       # clean; verified conflict-free
git add docs/plans/claude-at-home-1-workspaces-spec.md \
        docs/plans/claude-at-home-1-workspaces-mockups.html \
        docs/plans/claude-at-home-1-handoff-prompt.md \
        docs/plans/claude-at-home-1
git commit -m "Add the Workspaces spec, mockups and implementation plan

Product decisions were signed off on 2026-09-24; these documents carry them
so every agent works from the same frozen text."
```

Each slice then runs on its own branch or worktree off `feat/workspaces`:

```bash
git worktree add .claude/worktrees/ws-<slice> -b feat/workspaces-<slice> feat/workspaces
cd .claude/worktrees/ws-<slice>
ln -s /Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/node_modules node_modules
mkdir -p data
```

`npm run lint` will be broken in that worktree — that is expected, not a defect (see Global Constraints).

**Staging:** after a slice or a coherent group passes review, merge to `dev` and deploy to the dev environment
(`ai.dev.alfydesign`, `langflow-chat-dev` on the box) for live verification. Its data may be changed freely.
**Production** (`main` → `ai.alfydesign`) only on the owner's word.

## Phase 3 — adversarial review (per wave, mandatory)

After each wave, one reviewer per disjoint area, on an Opus-class model, in its own worktree, never the
implementer. Every reviewer hunts, in this order:

1. auth and ownership gaps (can user A read or link user B's project, file or instruction?)
2. incognito leaks (instructions are allowed; suggestions and learned data are not)
3. prompt-prefix-cache breakage (any turn-varying text that reached the system message)
4. precedence errors (project vs personal vs memory vs style vs the current message)
5. off-by-one at the Parallel allowance boundary
6. race conditions (two turns, two users, the same month)
7. missing EN/HU keys and keys that exist in only one locale
8. Svelte 5 reactivity bugs (`$state` captured by value, prop mutated locally, `state_referenced_locally`)
9. mobile layout against §M1–§M9 at 390×844
10. dead code left behind by Slice A or Slice G

**Rule: for every defect, write a failing test first, then fix it.** Run the full suite after the fixes.
Summarize in `docs/plans/claude-at-home-1/review-<batch>.md`.

## Phase 4 — verification for real

Local (scratch DB) and then staging. Walk every entry point and compare against the mockup file:

- Settings → Profile → Assistant behaviour → the Personal instructions row (§M7)
- the project page: sidebar hover button, breadcrumb segment, home project card (§M1)
- `/instruction` inside and outside a project, and in incognito (§M3)
- an AI suggestion → Review (§M4)
- the Files modal: link, unlink, upload, add from library (§M5)
- the Info popover → Sources (§M8)
- the Parallel meter (§M9)
- the home projects row (§M6)

Real-model checks on staging:

- personal and project instructions change the answers
- project instructions beat personal instructions
- an explicit "from now on…" produces exactly one suggestion row, and never in incognito
- project files are listed on short messages and read only when relevant
- the compaction indicator still renders (Slice A kept it)

Then read the staging service journal for new warnings.

## Verification checklist (every slice)

- [ ] Each task's tests were seen failing first, then green.
- [ ] `npm run check` — 0 errors, 0 warnings.
- [ ] `npx biome check src scripts tests` — clean (`npm run lint` is broken by nested worktrees; say so).
- [ ] `npm test` — green.
- [ ] `npm run build` — **0 warnings**.
- [ ] `npm run check:migrations` after any schema change; `npm run db:prepare` runs clean.
- [ ] `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json` — no new
      findings, no new broad ignores, and report whether the five known circular-dependency findings changed.
- [ ] The targeted Playwright suites from the spec: `chat.spec.ts`, `conversation.spec.ts`,
      `settings-admin.spec.ts`, `home-*.spec.ts`, plus the new specs each slice lists.
- [ ] Real-app visual check at **1440×900 and 390×844, light and dark**, against the mockup section named in
      the slice.
- [ ] i18n parity: `src/lib/i18n.test.ts` green, and any new prefix added to `AUDITED_PREFIXES` in
      `src/lib/i18n.test-helpers.ts`.

## Reporting and progress

- After each phase: commit hashes that landed, the gate results **with real numbers**, review findings fixed,
  and open questions.
- Keep `docs/plans/claude-at-home-1/progress.md` current so a fresh session can resume from it.

## Owner decisions already made (do not reopen)

1. Precedence: message → project → personal → memory → style.
2. Instructions in the system message, after Response Style, stable per conversation.
3. Instructions apply in incognito; AI suggestions never do.
4. Folder Knowledge: names plus a one-line summary on every turn; content read only when needed.
5. One modal is the only editing surface.
6. The folder token, never running text.
7. 2,000 characters, `400` on overflow, never silently truncated.
8. Deleting a project deletes its instructions and links, never its library files; moving a chat switches
   instructions from the next turn.
9. `/remember` unchanged; `/instruction` is new; the token is English in both locales.
10. Slice A removes "Manage context sources" everywhere but keeps `/document`/`/source` and the compaction
    indicator.
11. Slice B: the allowance is server-wide, `$5` by default, admin-overridable, recomputed retroactively;
    users see no UI change.
12. Slice G removes the home suggestion chips **including their backend and event log**.

## Owner decisions (ratified 2026-09-24)

All open questions raised by this plan were put to the owner and answered. **`decisions.md` is the master
record**; each slice document repeats the decisions that affect it. Where a slice document and `decisions.md`
disagree, `decisions.md` wins. No slice's scope, file ownership or test list changed as a result.

| # | Question | Decision |
|---|---|---|
| 1 | Response Style stops being the last system-message section | **Change the order, keep the guarantee:** update `normal-chat-context.test.ts:738` to pin `… Runtime Guidance → Response Style → Your Instructions → Project Instructions`. The assertion is not deleted, and the dropped `endsWith` clause is named in the commit message. |
| 2 | Where instruction text is read | **Resolved outside prompt assembly and passed in** through `PrepareOutboundChatContextParams`. No DB reads in `normal-chat-context.ts`. |
| 3 | `stripDeprecatedPromptSections` can eat a user's paragraph | **Append the instruction sections after the stripper runs.** Indentation protects the section shape only; the user's words are never rewritten or escaped. |
| 4 | The one-way `DELETE` of user pins/exclusions | **Proceed.** The rows are unreachable once the writer is deleted. Report the affected row count and dry-run against a scratch DB copy first. |
| 5 | `projectId` vs `folderId` | **`projectId` in code, "project" in UI copy.** |
