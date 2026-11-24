# Label migration and Earlier gate: acceptance (2026-11-24)

Plan: [2026-11-24-memory-label-migration.md](../../superpowers/plans/2026-11-24-memory-label-migration.md). Branch `claude/memory-label-migration`. Counts only; every account, fact and message here is invented.

## The label migration

**Method.** [label-migration-acceptance/run.ts](label-migration-acceptance/run.ts) builds a fresh app database with the app's own migrations and three synthetic accounts: A (a config-2 personal bank of 30 facts and a config-1 project bank of 10), B (a personal bank of 30), and a tester-flagged account (10). The facts are part 2's synthetic statements ([part-2-acceptance/fixtures.json](part-2-acceptance/fixtures.json), half English, half Hungarian), each bank with published entries and a dated label. Hindsight is an in-process stand-in that can only list: part 2's local engine is no longer installed on this Mac, and the migration only lists a bank's facts. The model is Flash-Next (`qwen3-6-27b`) through `inference.alfycomms.com`, called with the classifier's own prompt and schema, at most three calls in flight. The admission-gated model path (`createCurationModel` at background priority in the account's lane) and the Hindsight client are covered by `label-migration.test.ts`, not by this run. Raw output: [label-migration-acceptance/results.json](label-migration-acceptance/results.json).

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx svelte-kit sync
node --import tsx docs/plans/hindsight-memory/label-migration-acceptance/run.ts
```

| Check | Result |
|---|---|
| Dry run | 3 accounts, 1 skipped (`excluded`), 3 banks, 70 facts, 70 to label, 5 calls estimated; nothing written, no model call |
| Run | `done`: 70 labelled in 5 calls, 9 s, at most 2 in flight; A and B verified (`verification=passed`), A's config-1 bank labelled like the rest and left on config 1 |
| Published rows | fingerprint unchanged for both accounts; every table but the label store identical before and after |
| The tester | its banks never listed, its label rows unchanged, still unverified (today's page) |
| Resumed run | `done`, 0 model calls, 0 labelled, 2 skipped `already_verified`, 1 `excluded` |
| Labels against the fixtures | kind 69/70 (99%), subject 61/70 (87%), lasting labelled temporary or ongoing 0/26 (spec targets 85%, 80%, at most 1 in 20) |

The integration tests (`src/lib/server/services/memory-profile/label-migration.test.ts`, real SQLite migrations, fakes for Hindsight and the model) hold the rest: the tester skipped and never read in a dry run, a run, and when named alone; an unknown account skipped; an interrupted run keeping its written batch and the next run labelling only the rest; a fact without a usable label listed `no_label` with the account verified; failed model calls failing the account and stopping the run before the next; published rows changed during a run failing verification; every bank of the epoch (config 1 and 2) labelled before verification; the default model asked at background priority in the account's tenant lane; the rollback keeping event dates and refusing the tester. The command's arguments, its paired-backup check and its report lines are in `scripts/memory-label-migration-cli.test.ts`.

## Earlier entries only when the message mentions them

**Method.** `src/lib/server/services/memory-context/earlier-mention.fixtures.json`: 20 Earlier entries (10 English, 10 Hungarian, temporary things from part 2's fixtures, worded as Hindsight words its entries), 20 unrelated messages (part 2's 10 plus 10 more, half in each language), 20 messages each about one entry, and 10 cross-language pairs (an English entry, a Hungarian message about it). The worst case for rank is assumed: every Earlier entry is in its bank's top three for every message (part 2 measured 9 of 10 unrelated messages doing that in a 55-entry bank), so the gate is the mention alone. Held as a test (`earlier-mention.test.ts`).

| Messages | Bring an Earlier entry | Target |
|---|---|---|
| Unrelated (EN 10, HU 10) | 0 of 20 (EN 0, HU 0) | at most 1 in 10 |
| About an entry (EN 10, HU 10) | 20 of 20 bring their own entry (EN 10, HU 10), none brings another | at least 8 in 10 |
| Cross-language: English entry, Hungarian message | 1 of 10 (only "design stúdió" shares words) | reported |

**Limits.** The fixtures were written knowing the rule, so these are the rule's numbers on ordinary phrasing, not a blind test; part 2's ten unrelated messages, written before the gate, are among them (0 of 10). A message about an entry still needs the entry in its bank's top three, which only a real Hindsight measures. A message mentions an entry written in the other language only through a shared name or word; the model's `memory_context` tool, which ranks by meaning, still returns Earlier entries wherever they rank. No score floor was added: Hindsight's recall returns no relevance score at the pin.
