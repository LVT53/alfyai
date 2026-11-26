# Memory part 3: the Memory page (layout C) and the Overview sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A labelled account sees its Memory as a subject index with an Overview sheet; an account whose labels are not verified keeps today's list.

**Architecture:** One read model (`memory-profile/subject-read.ts`) groups the published rows by subject and age, building each entry exactly as recall does (one shared `entry-view.ts`). `KnowledgeMemoryView` keeps every mutation, dialog and guarantee and gains a `layout` prop: `"subjects"` draws the new index, opened subject and Earlier folds; `"list"` is today's page. The Overview is one local-model call through the memory model path (`createCurationModel`), stored one row per bank and deleted by triggers whenever the bank's entries change.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, SQLite + Drizzle (hand-numbered migrations), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md` (§3, "Testing and acceptance", "Calls I made" 1, 3, 6, 9 to 13). Part 2's contract: `memory-part-2-interfaces.md` in the shared notes folder. Mockups: `docs/design/memory-redesign/` 3, 4, 6 to 10.

## Global Constraints

- Subject lists (storage slugs in `src/lib/memory-types.ts`): personal About you, Home and family, Work and study, Health, Projects, Interests, Other; project banks Goals and decisions, People, Facts and figures, Plans and status, Other.
- Thresholds come from `getMemoryAgingThresholds()` only; the page decides current, quiet and Earlier with `memoryEntryTimeState` on one clock per request.
- An entry is built as recall builds it: supporting facts are `row.sourceIdsJson` ids looked up in `admittedNativeFacts`, labels from `readFactLabels`, `entryLabels`, `entryLastSaidAt(factSaidTimes)`.
- Earlier line: only the dated notes `parseEarlierStates(row.nativeText, row.text)` finds; never an invented date or end date; the entry's own text unchanged (decision recorded below).
- Exact copy: "Writing your overview…"; "Written just now from your N current entries. It is written again whenever your Memory changes, and it is never sent to chats."; "Written from your 120 most recent entries of 300"; buttons Rewrite and Done.
- Every string in English and Hungarian; Hungarian short, natural, fits its row at 360 and 390 px; no keyboard chords on touch screens.
- Model-facing text is ASCII English (ruling 79); the Overview names the account's UI language, like the persona summary (a screen, not a turn).
- Migrations `drizzle/1777140000143_*.sql` and `…144_*.sql`, `when` = the number; part 4 owns 141 and 142 (journal `idx` 154 and 155 are left for them; ours are 156 and 157).
- Overview model call: `createCurationModel` (Hindsight's admission gateway); after part 4 merges it passes `memoryAdmissionFor(userId, "interactive")`.
- Synthetic test data only. Tester rule: nothing here migrates Memory data.
- Gates: `npm run check` 0/0, build zero warnings, Fallow no new finding, `npx biome check src scripts tests`.

## Decisions fixed by this plan

1. **Earlier line source.** Hindsight's `GET /memories/{id}/history` is not used. At the pin, observation history is a table written on every observation update (`_append_observation_history`, consolidator.py) with `changed_at = now()` (the consolidation run, not when the old statement was said); it keeps `previous_text`, which holds corrected and edited wording, so showing it would bring back text the person corrected or edited (an anti-goal); there is one call per memory and no batch reader. The page shows only `parseEarlierStates`'s dated notes.
2. **Labels-verified state is per epoch.** `memory_accounts.labels_unverified_epoch` (nullable). Labels are verified when it is null or differs from the account's epoch. Migration 143 sets it to the current epoch for every account that already has a bank in its current epoch (those banks may hold facts from before config 2). A new account, and any new epoch (Clear Memory, erasure, part 5's fresh start), starts with banks created at config 2, so it reads verified with no write. At runtime, `ensureConfiguredBank` marks the epoch unverified whenever a config-1 bank is upgraded in place or a pending creation lands as config 1 (covers the deploy race and a rollback then roll-forward). The label migration clears it through `markMemoryLabelsVerified(tx, userId, epoch)`.
3. **Projects row:** like every row, the count of its current entries, plus "active" when any of its entries is ongoing and current; never a count of projects (spec §3 and mockups 3, 8, 9).
4. **Search, as today:** a query swaps the index for today's flat result rows (`/api/knowledge/memory?query=`), each opening today's detail.
5. **Overview storage:** `memory_overviews`, one row per bank (no history), with the fingerprint of the entries it was written from and its language. Triggers delete it when the bank's generation changes, a revocation is written, a source's state or facts change, a label row changes, the account's epoch, lifecycle or authority changes, or Memory is switched off; the bank's deletion cascades. A read whose current entries no longer match the fingerprint deletes it. A write stores only if the entries are unchanged after the model returns.
6. **Overview input:** current and quiet entries (what the page shows as current), most recently mentioned first, grouped by subject, cut at `OVERVIEW_INPUT_TOKEN_BUDGET = 6000` tokens; "of N" is the scope's current count.
7. **Overview sampling:** person-read (no machine temperature), so it takes the family profile and Rewrite can word it anew: `CurationModel` gains an optional sixth argument `{ readBy: "person", schemaName }`.
8. **Phone or computer:** one markup, a container query at 720 px on the Memory card: below it an opened subject replaces the index (pushed screen, back link "Memory"); at or above it the index becomes a list beside the subject pane, and without a subject it shows as tiles.

## Review Focus

1. A removal while the Overview sheet is open or writing: the rewrite and anything stored must never contain the removed text (Task 4: `writeMemoryOverview` re-reads the fingerprint before storing; trigger test on revocation).
2. An account between part 2's deploy and the label migration that creates a project bank at config 2 must still see today's page (Task 1: unverified epoch survives a new config-2 bank).
3. A subject with 1,000+ entries, and a 5,000-entry bank: the index must stay small and fast (Task 3 size test, paging at 100).
4. A Workspace Search link to an entry opens that entry's detail on the new page, and Back returns to the index with the search filled (Task 5 e2e).
5. Hungarian rows at 360 px: subject names, "Korábbiak", "aktív", "{n} hete csendes" and the Overview row never overflow or clip (Task 7 e2e overflow checks).

## File Structure

- `drizzle/1777140000143_memory_labels_unverified_epoch.sql`, `drizzle/1777140000144_memory_overviews.sql`, `drizzle/meta/_journal.json`, `scripts/prepare-db.ts`, `src/lib/server/db/schema.ts` — storage.
- `src/lib/server/services/memory-profile/labels-verified.ts` — the state's reader and writers.
- `src/lib/server/services/memory-profile/entry-view.ts` — one entry's kind, subject, last mention and time state; used by recall and the page.
- `src/lib/server/services/memory-profile/subject-read.ts` — the subject index and a subject's entries.
- `src/lib/server/services/memory-profile/overview.ts` — the Overview: read, write, the one model call, storage.
- `src/routes/api/knowledge/memory/subjects/+server.ts`, `subjects/[subject]/+server.ts`, `scope-overview/+server.ts` — thin adapters.
- `src/lib/memory-types.ts`, `src/lib/client/api/memory.ts` — shared types and browser calls.
- `src/routes/(app)/knowledge/_components/`: `KnowledgeMemoryView.svelte` (layout prop, subject state), `MemorySubjectIndex.svelte`, `MemorySubjectPane.svelte`, `MemoryEarlierFold.svelte`, `MemoryOverviewSheet.svelte`, `memory-subjects.css`, `memory-when.ts`; `+page.server.ts` and `+page.svelte` pass the layout.
- `src/lib/i18n/knowledge.ts` (words), `src/lib/i18n/guide.ts`, `src/lib/components/drawings/DrawnMemoryProfile.svelte`, `src/lib/components/guide/drawings/drawings.test.ts`.
- `tests/e2e/memory-subjects.spec.ts`; `tests/e2e/memory-replacement.spec.ts` and other Memory-tab specs keep today's page by marking the e2e admin unverified.

---

### Task 1: The labels-verified state and the page switch

**Files:** Create `drizzle/1777140000143_memory_labels_unverified_epoch.sql`, `src/lib/server/services/memory-profile/labels-verified.ts`, `labels-verified.test.ts`. Modify `drizzle/meta/_journal.json` (idx 156, when 1777140000143), `src/lib/server/db/schema.ts` (`memoryAccounts.labelsUnverifiedEpoch: integer("labels_unverified_epoch")`), `scripts/prepare-db.ts` (required column), `bank-configuration.ts`, `src/routes/(app)/knowledge/+page.server.ts`.

**Interfaces — Produces:**
- `memoryLabelsVerified(userId: string, database?: Pick<DatabaseInstance, "select">): boolean`
- `markMemoryLabelsVerified(tx: Tx, userId: string, epoch: number): boolean` (true when it cleared the mark; a no-op for another epoch)
- `markMemoryLabelsUnverified(tx: Tx, userId: string, epoch: number): void` (only while the account is at that epoch)
- `memoryPageLayout(userId: string): MemoryPageLayout` (`"subjects"` when verified) — `+page.server.ts` returns `memoryLayout`.

Migration SQL: add the column; `UPDATE memory_accounts SET labels_unverified_epoch = epoch WHERE EXISTS (SELECT 1 FROM memory_banks b WHERE b.user_id = memory_accounts.user_id AND b.epoch = memory_accounts.epoch)`.

- [ ] Tests (`labels-verified.test.ts`, bootEngine harness): `a user with no Memory account gets the new page`; `an account marked for its epoch keeps today's page until the writer clears it`; `the writer does nothing for another epoch`; `a new epoch (Clear Memory) reads verified`; `a new config-2 bank does not verify an unverified epoch`; `upgrading a config-1 bank marks the epoch unverified` (drive `ensureConfiguredBank` with a fake client as `bank-config.test.ts` does); `the migration marks accounts with a bank in their current epoch and no other` (apply the SQL to a fresh harness DB).
- [ ] Run, see them fail; implement; run `npx vitest run src/lib/server/services/memory-profile/labels-verified.test.ts src/lib/server/services/memory-profile/bank-config.test.ts`.
- [ ] Commit `Memory-Part-3-Task: 1`.

### Task 2: One entry view for recall and the page

**Files:** Create `memory-profile/entry-view.ts`, `entry-view.test.ts`. Modify `memory-context/native.ts` (`entryOf` uses it).

**Interfaces — Produces:**
- `type AdmittedFact = ReturnType<typeof admittedNativeFacts>[number]`
- `groupFactsById(facts: readonly AdmittedFact[]): Map<string, AdmittedFact[]>`
- `memoryEntryView(input: { sourceIds: readonly unknown[]; factsById: ReadonlyMap<string, readonly AdmittedFact[]>; labels: ReadonlyMap<string, FactLabels> }, now: Date, thresholds: MemoryAgingThresholds): { kind: MemoryKind | null; subject: MemorySubject | null; lastMentionedAt: string | null; timeState: MemoryTimeState; authored: boolean }`

- [ ] Tests: `an entry takes its newest fact's labels and last mention`; `a person-written entry never ages`; `an id the facts do not hold is ignored`. Existing `native.test.ts` must pass unchanged.
- [ ] Implement; run `npx vitest run src/lib/server/services/memory-profile/entry-view.test.ts src/lib/server/services/memory-context/`.
- [ ] Commit `Memory-Part-3-Task: 2`.

### Task 3: The subject read model, its routes and browser calls

**Files:** Create `memory-profile/subject-read.ts`, `subject-read.test.ts`, `subject-read.size.test.ts`, `src/routes/api/knowledge/memory/subjects/+server.ts`, `subjects/[subject]/+server.ts`. Modify `src/lib/memory-types.ts`, `src/lib/client/api/memory.ts` (+ test).

**Interfaces — Produces (types in `memory-types.ts`):**
- `MemoryPageLayout = "subjects" | "list"`; `MemoryEarlierState { text; saidAt: string | null }`
- `MemorySubjectEntry { ref; text; lastMentionedAt: string | null; kind: MemoryKind | null; timeState: "current" | "quiet" | "earlier"; quietWeeks: number | null; earlierStates: MemoryEarlierState[] }`
- `MemorySubjectSummary { subject: MemorySubject; count; preview; active: boolean; earlierCount; earlierPreview: string[] }`
- `MemorySubjectIndex { authority; scope; generation; status; subjects: MemorySubjectSummary[]; earlier: { count; preview: string[] }; currentCount }`
- `MemorySubjectKey = MemorySubject | "all"`; `MemorySubjectPage { scope; generation; subject: MemorySubjectKey; state: "current" | "earlier"; entries: MemorySubjectEntry[]; total; nextCursor: string | null }`
- Server: `readScopeEntries(userId, scope, now): { bank; generation; entries: ScopeEntry[] }` (`ScopeEntry = MemorySubjectEntry & { subject: MemorySubject }`, every published row, most recently mentioned first, unlabelled subject → `"other"`), `readMemorySubjectIndex(userId, scope, now?)`, `listMemorySubject(userId, { scope, subject, state, cursor? }, now?)` (page size 100; cursor = base64url `{ generation, subject, state, offset }`; a cursor for another generation → `MemoryRequestError("stale_memory", 409)`).
- Browser: `fetchMemorySubjectIndex(scope, signal?, fetcher?)`, `fetchMemorySubject({ scope, subject, state, cursor? }, signal?, fetcher?)`.

Rules: count, preview and order use current + quiet entries; hidden when count is 0; `active` = an `ongoing` entry whose state is current; `quietWeeks` = whole weeks since the last mention, server clock; previews of Earlier are up to 3 texts with the final full stop dropped; status and authority as `listMemory` reports them (memory off, not native, no bank → empty index with that status).

- [ ] Tests: `groups current entries by subject in list order and hides empty subjects`; `previews the most recently mentioned current entry`; `folds Earlier entries into the subject and the index`; `marks Projects active only for a current ongoing entry`; `an ongoing entry quiet for 24 days says 3 weeks`; `an unlabelled entry sits under Other and stays current`; `an entry shows only dated earlier states`; `pages a subject by 100 and refuses a cursor from another generation`; `a project bank uses the project subjects`; `memory off returns an empty index with status off`; route tests for 400 on an unknown subject. Size test: 5,000 synthetic entries, logs index/subject read times and JSON bytes, asserts the index under 2 s and under 20 KB.
- [ ] Implement; run `npx vitest run src/lib/server/services/memory-profile/subject-read.test.ts src/lib/server/services/memory-profile/subject-read.size.test.ts src/lib/client/api/memory.test.ts`.
- [ ] Commit `Memory-Part-3-Task: 3`.

### Task 4: The Overview: storage, service, route

**Files:** Create `drizzle/1777140000144_memory_overviews.sql`, `memory-profile/overview.ts`, `overview.test.ts`, `src/routes/api/knowledge/memory/scope-overview/+server.ts`. Modify journal (idx 157), `schema.ts` (`memoryOverviews`), `scripts/prepare-db.ts` (required table), `account-lifecycle/user-scoped-tables.ts` (cascade, resets memory and workspace), `memory-profile/curation.ts` (sixth argument), `memory-types.ts`, `client/api/memory.ts`.

**Interfaces — Produces:**
- Table `memory_overviews(bank_id PK → memory_banks ON DELETE CASCADE, user_id → users ON DELETE CASCADE, language, text, entries_hash, written_from, current_count, created_at)` plus the triggers of Decision 5.
- `CurationCallOptions { readBy?: "machine" | "person"; schemaName?: string }` as `CurationModel`'s sixth argument; `readBy: "person"` sends no machine temperature.
- `MemoryOverview { state: "written" | "none"; currentCount; text: string | null; writtenFrom: number | null; writtenAt: string | null }`
- `readMemoryOverview(userId, scope, now?): MemoryOverview`; `writeMemoryOverview(userId, scope, { rewrite: boolean; signal?: AbortSignal; model?: CurationModel; now?: Date }): Promise<MemoryOverview>` (one call in flight per bank; `MemoryRequestError("overview_empty", 409)` with no current entries, `("overview_changed", 409)` when entries changed twice during writing, `NativeMemoryError` passes through as 503).
- `composeMemoryOverview(input: { scopeKind; projectName: string | null; personName: string | null; language: "en" | "hu"; entries: Array<{ subject: string; text: string; kind: MemoryKind | null }> }, model: CurationModel): Promise<string>` — the one model call; schema `{ overview: string }`, thinking off, `{ readBy: "person", schemaName: "memory_overview" }`.
- `OVERVIEW_INPUT_TOKEN_BUDGET = 6000`; `selectOverviewEntries(entries, budget)`.
- Browser: `fetchMemoryOverview(scope, signal?)`, `writeMemoryOverview(scope, rewrite, signal?)`.

- [ ] Tests (fake `CurationModel` that records its input): `writes only from the entries the page shows as current`; `after a removal the stored overview is gone and a rewrite never sees the removed text`; `nothing is stored after an entry changes` (new generation, revocation, source revoked, label change, epoch bump, Memory off, bank deleted); `a stored overview is discarded when the entries no longer match`; `a big scope is written from its most recent entries that fit and says so`; `writes in the account's language and names no other`; `the prompt is ASCII English`; `two writes at once share one model call`; `an entry change during writing stores nothing`; `only overview.ts reads memory_overviews`; `the person-read call sends no machine temperature` (curation test).
- [ ] Implement; run `npx vitest run src/lib/server/services/memory-profile/overview.test.ts src/lib/server/services/memory-profile/curation.test.ts src/lib/server/services/account-lifecycle/`.
- [ ] Commit `Memory-Part-3-Task: 4`.

### Task 5: The new page

**Files:** Create the four components, `memory-subjects.css`, `memory-when.ts` (+ test). Modify `KnowledgeMemoryView.svelte`, `memory-visit.ts` (`subject?: string | null`), `knowledge/+page.svelte`, `src/lib/i18n/knowledge.ts`.

**Interfaces — Consumes:** Task 3's and 4's browser calls. **Produces:** `KnowledgeMemoryView` prop `layout: MemoryPageLayout`; `memory-when.ts`: `lastMentionedWords(iso: string | null, now: Date, language: "en" | "hu"): string | null` (within 6 days relative, else day and month, the year when not this year), `saidWords(iso: string | null, language): string | null` (month and year).

Words (keys `memorySubjects.*`, both languages): subject names per slug; `add` "Add"/"Hozzáadás"; `search` "Search Memory"/"Keresés a Memóriában"; `overviewPersonal` "Overview of you"/"Áttekintés rólad"; `overviewProject` "Overview of this project"/"Áttekintés a projektről"; `overviewHint` "Written when you open it"/"Megnyitáskor készül"; `writing` "Writing your overview…"/"Készül az áttekintésed…"; `writingFrom` "From your {count} current entries." (plural); `writtenNow`, `writtenNowRecent` (the 120 of 300 form), `writtenAt`, `writtenAtRecent`; `rewrite` "Rewrite"/"Újraírás"; `done` "Done"/"Kész"; `active` "active"/"aktív"; `quiet` "quiet {weeks} weeks"/"{weeks} hete csendes"; `earlier` "Earlier"/"Korábbiak"; `earlierIn` "Earlier in {subject}"/"Korábbiak ebben a témában"; `lastMentioned` "Last mentioned {when}"/"Utoljára említve: {when}"; `earlierState` "Earlier: {text} · said {when}"/"Korábban: {text} · {when}"; `earlierStateUndated`; `back` "Memory"/"Memória"; failures and empty states.

- [ ] Tests: `memory-when.test.ts` (both languages, today/yesterday/3 days/date/other year); `KnowledgeMemoryView.test.ts` gains `the subjects layout draws the index and opens a subject`.
- [ ] Implement; run those tests.
- [ ] Commit `Memory-Part-3-Task: 5`.

### Task 6: The Feature Guide

**Files:** `src/lib/i18n/guide.ts` (memory line in both languages: subjects, Earlier, the Overview), `DrawnMemoryProfile.svelte` (scope, Add, the Overview row with `Sparkle`, search, three subject rows, the Earlier row; words from `memorySubjects.*` keys), `drawings.test.ts` (keys). The spotlight marker `knowledge.memory` stays on the Memory tab.

- [ ] Update the drawing test's expected keys first; run `npx vitest run src/lib/components/guide/`; implement; commit `Memory-Part-3-Task: 6`.

### Task 7: End to end, size, docs

**Files:** Create `tests/e2e/memory-subjects.spec.ts`. Modify Memory-tab specs to mark the admin unverified where they test today's page (`markAdminMemoryLabelsUnverified` / `clearAdminMemoryAccount` helpers in `tests/e2e/helpers.ts`). Docs: `memory-profile/AGENTS.md` (part 3 paragraph), `src/routes/AGENTS.md` (three routes), `src/lib/components/AGENTS.md` if the dialog note needs it.

- [ ] Spec (route-mocked fixtures like `memory-replacement.spec.ts`): phone 390×844 and desktop 1280×800, English and Hungarian: the index (counts, previews, active, hidden subject, Earlier row), an opened subject (pushed screen with back link; second pane with the index as a list), the Earlier line and quiet weeks, the Overview sheet (writing then written, Rewrite, Done; centred dialog on desktop), a Workspace Search link opening one entry, no horizontal overflow at 360 px in Hungarian. Tag one test `@smoke`.
- [ ] Run the specs alone, then the gate.
- [ ] Commit `Memory-Part-3-Task: 7`.
