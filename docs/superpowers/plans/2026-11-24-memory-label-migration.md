# Memory label migration and the Earlier gate (2026-11-24)

Spec: `docs/superpowers/specs/2026-11-22-memory-redesign-design.md` ("The label migration for existing entries", §5's permanent tester rule, "Testing and acceptance", calls 5, 7 and 15). Branch `claude/memory-label-migration`, cut at `dba73ad32` (parts 1 to 4). Commits carry `Memory-Label-Migration-Task: N`. Synthetic data only; push, deploy, the box and the production run wait for the owner.

## Task 1: Earlier entries only when the message is about them (Build B)

Part 2 measured that 9 of 10 unrelated messages put a temporary entry in a small bank's top three, and Hindsight's recall gives the app no relevance score at the pin (the local reranker scores "Thanks!" at 0.99). So rank alone cannot say "only when mentioned".

- New `memory-context/earlier-mention.ts`: `mentionsMemoryEntry(message, entryText)`. Words are folded with Workspace Search's `foldForSearch` (`src/lib/shared/workspace-search-text.ts`); stop words (English and Hungarian, folded), words under 3 letters and bare numbers do not count; two words match when they are equal or share a prefix of at least 5 letters ("Budapesten" and "Budapest"). The app holds no entities for facts, so the entry's text is what is matched.
- `native.ts`, per-turn path only: an Earlier entry joins a turn when it is in its bank's top three for the message **and** the message mentions it (the message as written plus the recall query, which adds the chat's title to a short message). The `memory_context` tool is unchanged.
- No score floor: recall at the pin returns no score (`include` asks for none and the client keeps none), so the floor is left out.
- Test first: unit tests for the matcher, a `native.test.ts` case for an unrelated message, and a synthetic EN/HU measurement held as a test: unrelated messages at most 1 in 10, messages about an entry at least 8 in 10, the cross-language case reported.

## Task 2: the label migration library (Build A)

`memory-profile/label-migration.ts`, test first (`label-migration.test.ts`, fakes for Hindsight and the model, real SQLite migrations).

- Accounts: every `memory_accounts` row (or the one named). `memoryMigrationGuard` first: excluded and unknown accounts are skipped and counted. Then skipped with a reason: not on Hindsight, not active, Memory off, labels already verified (`labels_unverified_epoch` null or another epoch).
- Per account, one at a time: banks of the current epoch (retired ones left out; a repair-blocked bank fails the account). Raw facts from `client.list()` (`fact_type !== "observation"`), minus facts with a kind in `readFactLabels`. Batches of `FACT_LABEL_BATCH_SIZE` through `classifyMemoryFacts` with `createCurationModel(signal, undefined, memoryAdmissionFor(userId, "background"))`; each answered batch is written at once with `recordClassifiedFactLabels` inside a transaction fenced by `assertMemoryBankFence` (bank epoch and status current), so a crash loses at most the batches in flight. A failed batch gets one more try; a fact the model answered without a usable label is listed unlabelled (`no_label`), a fact whose batches all failed fails the account (`model_unavailable`).
- Verify: list again; every raw fact has a kind or is listed unlabelled with its reason; the fingerprint of the account's published rows (text, native text, support, dates, which rows are visible, the bank's generation and every fact's event date) equals the one taken before. Only then `markMemoryLabelsVerified(tx, userId, epoch)` in a fenced transaction. Stop at the first account that fails.
- Never writes to Hindsight (the client handed to it can only list), never changes text, support, dates or visibility. A re-run skips labelled facts and verified accounts.
- Dry run: the same reads, no model call, no write: accounts, banks, facts, already labelled, to label, estimated calls, skipped by reason.
- Rollback for one account: classifier labels of its current epoch's banks back to unlabelled (event dates kept) and the epoch marked unverified again, through the guard. Exact today because the migration is the only classifier writer.
- Report: counts only, per account: labelled per kind and per subject, unlabelled by reason, verification.

## Task 3: the command and the runbook

- `scripts/memory-label-migration.ts` (argument parsing, backup check and printing in `scripts/memory-label-migration-cli.ts`, unit-tested): dry run by default over every account; `--execute` with `--user <id>` or `--all`, and `--backup <dir>` naming the paired backup (an app SQLite backup that is an app database holding every account to label, and a Hindsight PostgreSQL dump, both recent and taken together); `--rollback --user <id>`. Prints counts and ids, never memory text.
- `docs/plans/hindsight-memory/migration-runbook.md`: the production procedure (dry run, paired backup with Memory workers paused, the owner's go-ahead, one account and its verification, the rest, rollback).

## Task 4: acceptance and gates

- Integration test over synthetic accounts (two ordinary, one tester-flagged): dry run, run, the tester untouched, each account verified, published rows unchanged, every other table unchanged, a resumed run doing nothing new, a crash mid-account resumed. The part 2 local Hindsight is not installed on this Mac any more, so Hindsight is a fake here; the model is Flash-Next in a small live run if time allows.
- `npm run check`, then the agent gate with `tests/e2e/chat.spec.ts tests/e2e/memory-subjects.spec.ts`.
