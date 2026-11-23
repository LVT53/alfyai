# Memory redesign, part 2: what gets remembered and how it is labelled — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New memories skip requests, reactions and brainstorm steps; a later statement settles an earlier plan; every new fact gets a kind and a subject inside Hindsight's own extraction; an app-side label store gives old and new entries one read path; entries age at read time (Earlier) and recall treats Earlier entries as the spec says.

**Architecture:** The bank configuration gains new mission wording and two `entity_labels` groups (`kind`, `subject`, both `tag: true`), so Hindsight writes `kind:<value>` and `subject:<value>` into each new fact's tags at no extra call. A bank configured by the previous release is upgraded once, through the same single-submission fence a new bank uses, and `verifyConfig` compares deeply. Labels live app-side in `memory_fact_labels`, keyed by bank and Hindsight fact id: publication copies a fact's label tags and event date there, and the classifier (for the label migration and the fallback) writes there too, so recall and the Memory page read one table. Earlier is decided at read time from the entry's kind, its last mention, its event date and whether the person wrote it, with thresholds from config-store.

**Tech Stack:** SvelteKit server code in TypeScript, Drizzle on better-sqlite3, Vitest, the Hindsight HTTP client (`memory-profile/hindsight-client.ts`), Hindsight 9fb28dbd (`entity_labels`, `dry-run-extract`), Biome, Fallow.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md`, section 2 in full, "Calls I made" 1, 2, 3, 6, 8 and 10, "Left to the builder", "Testing and acceptance", "Constraints". Part 1 (`docs/superpowers/plans/2026-11-23-memory-recall-part-1.md`) is built and merged into local `main`.

## Global Constraints

- Docs checked before code: Vitest (mocks, `test.each`), Drizzle better-sqlite3 transactions and `onConflictDoUpdate`, and Hindsight's own source at the pin for `entity_labels`, tags and `dry-run-extract` (`engine/retain/entity_labels.py`, `fact_extraction.py:1419-1500, 2367-2420, 3879-3897`, `api/http.py:2934-3060, 5305-5376`, `engine/response_models.py:278-336`).
- Synthetic data only, never a real person's memories or chats; the tester account is untouched (this part migrates no data).
- Everything written into a model request is ASCII English with no language name and no reply-language instruction (ruling 79). This covers the missions, the label descriptions, the classifier prompt and the recall lines.
- No added model call on the person's turn. Labels come from the extraction Hindsight already runs; the classifier is called only by the label migration and a background fallback, never on a turn.
- Recall writes nothing. Only a new fact (Hindsight's assertion dates, as part 1 reads them) ages or revives an entry.
- An entry with no dated source has no age and never becomes Earlier; never invent "today" for an undated fact.
- Kind values `lasting`, `ongoing`, `temporary`. Personal subjects `about_you`, `home_family`, `work_study`, `health`, `projects`, `interests`, `other`; project subjects `goals_decisions`, `people`, `facts_figures`, `plans_status`, `other` ("Calls I made" 1, as slugs; the page words are part 3's).
- Unlabelled means lasting: no kind shown, never Earlier.
- Thresholds (config-store, whole days 1 to 3650): `MEMORY_TEMPORARY_EARLIER_DAYS` 21, `MEMORY_ONGOING_QUIET_DAYS` 21, `MEMORY_ONGOING_EARLIER_DAYS` 90.
- At most three Earlier entries per turn, each from the top three positions of its bank's message ranking; never in the core.
- Node 22 first on `PATH`; `npm run check` 0/0, Biome clean, build 0 warnings, Fallow no new finding. Commit only the task's files, trailer `Memory-Part-2-Task: N`. Nothing pushed or deployed.

## Review Focus

1. **A bank configured by the previous release** (every production bank): its next delivery must upgrade it once and carry on, never fail on `native_config_mismatch`; a curation, recovery or preview on a bank not yet upgraded must still pass verification. Tests: Task 1, "upgrades a bank configured by the previous release" and "accepts the previous release's config where it only verifies".
2. **A label the extractor invents** (`subject:pets`, a project subject on a personal bank): never stored as a label; the fact stays unlabelled (lasting). A known value in other letter case (`kind:Lasting`, which Hindsight's own check lets through) reads as that value. Test: Task 2, "keeps only known labels for the bank's kind".
3. **An entry whose supporting facts disagree** (one says temporary, a newer one lasting): the newest fact's label wins; an entry the person added or edited never ages whatever its label. Tests: Task 2, "takes the newest fact's labels" and Task 3, "never ages an entry the person wrote".
4. **A temporary entry with a future event date** (an exam in two months): current until three weeks after the event, not three weeks after it was said. Test: Task 3, "counts a temporary entry from the later of its mention and its event".
5. **An Earlier entry that ranks fourth for the message, or a fourth Earlier entry**: left out of the turn; the tool still returns it, marked. Tests: Task 4, "admits an Earlier entry only from the top three of its bank's ranking" and "keeps at most three Earlier entries in a turn".

---

### Task 1: Bank configuration 2 (missions, labels, deep verification, upgrade)

**Files:**
- Modify: `src/lib/memory-types.ts` (kind and subject lists, shared with the page)
- Modify: `src/lib/server/services/memory-profile/contracts.ts`
- Modify: `src/lib/server/services/memory-profile/hindsight-client.ts` (`configure`, `verifyConfig`, `memories` parse)
- Modify: `src/lib/server/services/memory-profile/bank-configuration.ts`
- Modify: `src/lib/server/services/memory-profile/migration.ts:853`
- Test: `src/lib/server/services/memory-profile/hindsight-client.test.ts`, `bank-configuration.test.ts` (new), the integration tests whose fakes answer `GET /config`

**Interfaces:**
- Produces in `$lib/memory-types.ts`: `MEMORY_KINDS = ["lasting", "ongoing", "temporary"] as const`, `type MemoryKind`; `PERSONAL_MEMORY_SUBJECTS`, `PROJECT_MEMORY_SUBJECTS` (as above), `type MemorySubject`; `memorySubjectsFor(kind: MemoryScope["kind"]): readonly MemorySubject[]`.
- Produces in `contracts.ts`: `NATIVE_BANK_CONFIG_VERSION = "alfyai-bank-config-2"` (stored once a bank's config 2 is verified; `HINDSIGHT_ENGINE_COMMIT` is what the previous release stored for config 1); `PREVIOUS_NATIVE_BANK_CONFIG` (config 1, byte for byte); `nativeBankConfig(kind: MemoryScope["kind"])`; `NATIVE_BANK_CONFIG = nativeBankConfig("personal")` (kept for the tests' fakes); `CURRENT_NATIVE_BANK_CONFIGS` (both kinds); `KNOWN_NATIVE_BANK_CONFIGS` (config 1 and both of config 2); `isVerifiedNativeBankConfigVersion(version: string | null): boolean`; `NATIVE_KIND_LABEL_DESCRIPTIONS` and `nativeSubjectLabelDescriptions(kind)` (the one source of the label words, reused by the classifier).
- Produces in `NativeMemory`: `tags?: string[]`, `occurred_start?: string | null`, `occurred_end?: string | null`.
- Produces in `HindsightClient`: `configure(config: NativeBankConfig, beforeDispatch)`; `verifyConfig(accepted: readonly NativeBankConfig[] = KNOWN_NATIVE_BANK_CONFIGS)`: passes when the live config deep-equals one accepted config on every key that config names (arrays and objects compared by value, key order ignored).
- Produces in `bank-configuration.ts`: `verifySubmittedBankConfig(client, accepted = CURRENT_NATIVE_BANK_CONFIGS)`; `ensureConfiguredBank(...)`: version 2 verifies against config 2; `HINDSIGHT_ENGINE_COMMIT` (config 1, verified) is upgraded with a plain PATCH that a retry may send again, keeping its version until a readback proves config 2 (review Important 1: a sentinel that only a config 2 readback could clear froze a bank that holds data, its Clear Memory and erasure included); `PENDING` (a creation, by either release) is settled by any known config, and a config 1 readback is then upgraded; no version configures a new bank as today. Version writes are compare-and-set; a config 2 bank is verified against its own kind's config. Rollback: `restorePreviousNativeBankConfig` and `scripts/memory-bank-config-restore.ts` (review Important 2).

Mission wording (config 2; config 1's sentences are kept, these are added):
- Retain: "Requests to the assistant, reactions to its suggestions and the intermediate steps of a brainstorm or a choice are not memories. When a choice settles, remember its outcome if it is likely to matter beyond this chat."
- Observations: "When a later statement settles an earlier wish or plan about the same thing, keep only the settled state. When something really changes in the world (a move, a new job), state the new value as current and keep the old value only as earlier history in the same observation; never write an end date or a date the person did not state." The correction sentence stays as it is.

Labels (`entity_labels`, both `type: "value"`, `optional: true`, `tag: true`): `kind` with the three values and descriptions that lean to lasting when unsure; `subject` with the bank kind's list. An entry with no label reads as lasting.

- [ ] Write failing tests: `verifyConfig` "compares array and object keys by value" (an `entity_labels` with one changed description fails; the same labels with keys reordered pass); "accepts the previous release's config where it only verifies"; `ensureConfiguredBank` "upgrades a bank configured by the previous release" (fence writes PENDING before the PATCH, PATCH body is config 2 for the bank's kind, version 2 after readback), "verifies a bank already on config 2 without a PATCH", "holds an upgrade whose PATCH did not land" (`native_config_unconfirmed`, retryable), "configures a project bank with the project subjects"; mission words are ASCII.
- [ ] Run them, see them fail; implement; run them and the integration suites whose fakes answer `GET /config` (`delivery-job`, `curation`, `migration`, `dependency-repair`), updating their "already configured" rows to `NATIVE_BANK_CONFIG_VERSION`.
- [ ] Commit `Memory-Part-2-Task: 1`.

### Task 2: The fact label store and its one read path

**Files:**
- Modify: `src/lib/server/db/schema.ts`; Create: `drizzle/1777140000140_memory_fact_labels.sql`, journal entry
- Create: `src/lib/server/services/memory-profile/fact-labels.ts`, `fact-labels.test.ts`
- Modify: `src/lib/server/services/memory-profile/publication.ts` (`publishNativeSnapshot` records labels)

**Interfaces:**
- Table `memory_fact_labels`: `bank_id` (FK `memory_banks.id` on delete cascade), `native_fact_id`, `kind` (nullable), `subject` (nullable), `origin` (`extraction` | `classifier`), `event_at` (timestamp, nullable: the fact's `occurred_end ?? occurred_start`), `updated_at`; primary key (`bank_id`, `native_fact_id`). No user column: it goes with its bank (Clear Memory and erasure delete banks; a scope move retires its bank, whose label rows stay, unread, until the bank row goes).
- `labelsFromNativeTags(tags: readonly string[] | undefined, kind: MemoryScope["kind"]): { kind: MemoryKind | null; subject: MemorySubject | null }` — exact lowercase `kind:` / `subject:` values from the bank kind's lists; anything else is ignored.
- `recordNativeFactLabels(tx: Tx, bankId: string, scopeKind: MemoryScope["kind"], memories: readonly NativeMemory[]): void` — for each raw fact in a published snapshot: inserts or updates its event date and, unless the row came from the classifier, its extraction labels; deletes rows of facts no longer in the snapshot. Writes only what changed.
- `recordClassifiedFactLabels(tx: Tx, bankId: string, labels: ReadonlyMap<string, { kind: MemoryKind; subject: MemorySubject }>): void` — the label migration's and the fallback's writer; origin `classifier`; keeps the event date.
- `readFactLabels(database: DatabaseInstance | Tx, bankId: string): Map<string, FactLabels>` where `FactLabels = { kind: MemoryKind | null; subject: MemorySubject | null; eventAt: string | null; origin: "extraction" | "classifier" }`.
- `isAuthoredMemorySource(source: { eventId: string; context: string }): boolean` — a Memory page add or edit (`manual:` event) or a migrated user-authored item (`migrationAuthoredId` in its context).
- `entryLabels(facts: readonly EntryFact[], labels: ReadonlyMap<string, FactLabels>): EntryLabels`, `EntryFact = { id: string; saidAtMs: number; authored: boolean }`, `EntryLabels = { kind: MemoryKind | null; subject: MemorySubject | null; eventAt: string | null; authored: boolean }`: kind and subject from the newest-said fact that has one (ties by fact id), the latest event date of any fact, authored when any fact is.

- [ ] Write failing tests: "keeps only known labels for the bank's kind"; "records a published fact's labels and event date"; "keeps a classifier's labels when the fact is published again"; "removes labels of facts gone from the snapshot"; "takes the newest fact's labels"; "an entry is authored when any of its facts is"; "labels go with their bank" (bank delete cascades).
- [ ] Run, fail, implement, pass; `npm run check:migrations`.
- [ ] Commit `Memory-Part-2-Task: 2`.

### Task 3: Earlier, decided at read time

**Files:**
- Create: `src/lib/server/services/memory-profile/entry-time.ts`, `entry-time.test.ts`
- Modify: `src/lib/server/env.ts`, `src/lib/server/config-store.ts`, `src/lib/config/admin-config-registry.ts`, `src/lib/i18n/settings.ts` (EN and HU), `.env.example`, `docs/configuration.md`, `README.md`, and the registry and config tests part 1 touched

**Interfaces:**
- `MemoryAgingThresholds = { temporaryEarlierDays: number; ongoingQuietDays: number; ongoingEarlierDays: number }`; `getMemoryAgingThresholds(): MemoryAgingThresholds` in `config-store.ts`.
- `type MemoryTimeState = "current" | "quiet" | "earlier"`; `memoryEntryTimeState(entry: { kind: MemoryKind | null; lastMentionedAt: string | null; eventAt: string | null; authored: boolean }, now: Date, thresholds: MemoryAgingThresholds): MemoryTimeState`. Authored, unlabelled or lasting: current. Temporary: earlier once `now` is at least `temporaryEarlierDays` whole days after the later of `lastMentionedAt` and `eventAt`. Ongoing: from `lastMentionedAt`, quiet at `ongoingQuietDays`, earlier at `ongoingEarlierDays`. No usable date: current.

- [ ] Failing tests: "counts a temporary entry from the later of its mention and its event"; "marks an ongoing entry quiet, then earlier"; "never ages a lasting, unlabelled or undated entry"; "never ages an entry the person wrote"; settings parse strictly (whole days 1 to 3650, anything else keeps the default) and admin overrides apply.
- [ ] Run, fail, implement, pass. Commit `Memory-Part-2-Task: 3`.

### Task 4: Recall reads the labels

**Files:**
- Modify: `src/lib/memory-types.ts` (`AdmittedMemoryEvidence`), `src/lib/server/services/memory-context/native.ts`, `recall-format.ts`, `persona.ts`, `src/lib/server/services/chat-turn/context-selection.ts` (passes the turn's clock)
- Test: `recall-format.test.ts`, `native.test.ts`

**Interfaces:**
- `AdmittedMemoryEvidence` gains `kind?: MemoryKind | null`, `timeState?: MemoryTimeState`, `earlierStates?: Array<{ text: string; saidAt: string | null }>` (the tool only).
- `recallMemory(userId, { ..., now?: Date })`: the turn's clock decides Earlier. Per bank one `readFactLabels` read. Earlier rows leave the core list, and the core puts lasting and unlabelled entries first (spec part 1; review Minor 3); on the per-turn path an Earlier row stays in a message list only at positions 0 to 2 of its bank's verified message ranking, and at most three per turn (best position first, the person's bank first on a tie); the tool keeps Earlier rows wherever they rank and adds each row's earlier-state notes, parsed from the published `nativeText` (`(YYYY-MM-DD HH:MM: text)`, newest first). The log line adds `earlier`.
- Row format: `- text (said 3 weeks ago)` unlabelled; `- text (temporary, said 3 weeks ago)` labelled; `- text (earlier, temporary, said 2 months ago)` Earlier; an earlier-state note `  - earlier: <text> (said 1 year ago)` under its row. `RECALL_EARLIER_NOTE` opens the rows, after `RECALL_TIMES_NOTE`, only when a row is Earlier or carries a note; recall reserves its tokens like the heading's. `recallLineTokens` covers the longest suffix; notes are counted with `recallEarlierStatesTokens`.

- [ ] Failing tests: format ("shows the kind once labelled", "marks an Earlier entry", "lists earlier states under their entry", "opens with the earlier note only when needed", "never costs more than recallLineTokens"); recall ("keeps Earlier entries out of the core", "admits an Earlier entry only from the top three of its bank's ranking", "keeps at most three Earlier entries in a turn", "the tool returns Earlier entries and earlier states, marked", "a new fact makes an entry current again", "a labelled row reaches the model with its kind").
- [ ] Run, fail, implement, pass; then the focused set (memory-context, context-selection, normal-chat-context, persona-v2, English purity). Commit `Memory-Part-2-Task: 4`.

### Task 5: The fact classifier

**Files:**
- Create: `src/lib/server/services/memory-profile/fact-classifier.ts`, `fact-classifier.test.ts`

**Interfaces:**
- `FACT_LABEL_BATCH_SIZE = 20`; `classifyMemoryFacts(input: { scope: MemoryScope["kind"]; facts: ReadonlyArray<{ id: string; text: string }> }, model: CurationModel): Promise<Map<string, { kind: MemoryKind; subject: MemorySubject }>>` — one call per batch through `createCurationModel` (the admission-gated memory model path, `resolveModelCallSampling` inside `sendJsonControlMessage`, temperature 0, thinking off), English prompt from the same label descriptions as the bank config, facts as data under short ids; an answer for an unknown id, or a value off the lists, is dropped; a failed batch labels nothing of its own and the rest go on; the call throws `NativeMemoryError("memory_label_unavailable", true)` only when every batch failed (review Minor 5). Never on a turn: its callers are the label migration and the fallback.

- [ ] Failing tests: "labels a batch from one call"; "splits more than twenty facts into batches"; "drops answers for unknown ids and values off the lists"; "uses the project subjects for a project bank"; "its prompt is ASCII English and names no language".
- [ ] Run, fail, implement, pass. Commit `Memory-Part-2-Task: 5`.

### Task 6: Rules

- Modify: `src/lib/server/services/memory-profile/AGENTS.md` (labels, the store, Earlier, config 2 and its upgrade, the classifier's callers). Commit `Memory-Part-2-Task: 6`.

### Task 7: Acceptance on the local model

**Files:**
- Create: `docs/plans/hindsight-memory/part-2-acceptance/` (fixtures, runner, results JSON), `docs/plans/hindsight-memory/part-2-acceptance.md`

A Hindsight at the pin on this Mac (embedded Postgres, ONNX, FlashRank), Flash-Next through `inference.alfycomms.com` with `ALFY_API_KEY` from `~/.dsh/.env` (never printed), at most three model calls in flight. Synthetic chats, at least 20 per category, half Hungarian.
- Extraction (`dry-run-extract`, config 1 against config 2 on the same chats): question-only chats leave no fact in at least 18 of 20; a settled brainstorm leaves at most its outcome in at least 16 of 20; plainly stated lasting facts kept at least as often as with config 1.
- Labels (config 2's extraction, and the classifier on the same facts): kind right for at least 85%, subject for at least 80%, at most 1 in 20 lasting facts labelled temporary or ongoing.
- Consolidation (retain and consolidate on scratch banks): a real-world change leaves the new state current and the old one as earlier history in at least 16 of 20; a correction leaves no trace of the wrong value.
- Time: the Task 3 and Task 4 tests on the fake clock.
- Regression gate: what of the lifecycle, current-list and integrated-benchmark harnesses can run tonight runs; the rest is recorded as not run, with the command.

- [ ] Run, record counts only, commit `Memory-Part-2-Task: 7`.

### Task 8: Gate, review, fixes

- [ ] `scripts/gates.sh agent "$TMPDIR/alfyai-gates-part2" --port 5100 tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts` once, after checking no other gate or Playwright run is going.
- [ ] One Opus whole-branch review; fix Critical and Important, each with a test that failed first. Commit with `Memory-Part-2-Task: 8`.
