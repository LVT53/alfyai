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

**The rule after the review (F5).** The person's message as written (never the chat's title, which only helps a short message's search; a long message read at its first 4,000 and last 2,000 characters) mentions an Earlier entry when the significant words they share weigh as much as one rare word of the person's bank: a word more than two of the bank's entries and more than a tenth of them hold weighs less, in proportion (`mentionBank`). Words match when equal, or on a stem of four letters with endings of at most two, or of five letters with endings of at most three. Stop words in both languages now include the months, the days of the week, a few time words, "a bit", and the everyday words for work, play, projects, plans and interest. `src/lib/server/services/memory-context/earlier-mention.ts`.

**Tuning (not blind).** On this branch's own fixtures (`src/lib/server/services/memory-context/earlier-mention.fixtures.json`, 20 Earlier entries, 10 English and 10 Hungarian, weighed as one bank; held as a test in `earlier-mention.test.ts`) and part 2's old user turns ([part-2-acceptance/fixtures.json](part-2-acceptance/fixtures.json), the 20 questions and all 69 brainstorm turns), with every Earlier entry assumed in its bank's top three:

| Messages | Bring an Earlier entry | Target |
|---|---|---|
| Unrelated fixtures (EN 10, HU 10) | 0 of 20 | at most 1 in 10 |
| Part 2's old user turns (89) | 2 of 89 ("boil"/"boiler"; a girlfriend named in both) | at most 1 in 10 |
| About an entry (EN 10, HU 10) | 20 of 20 bring their own entry | at least 8 in 10 |
| Cross-language: English entry, Hungarian message | 1 of 10 | reported |

**Blind measurement (once, after the rule was frozen at `1567b86f2`).** [label-migration-acceptance/earlier-blind-messages.json](label-migration-acceptance/earlier-blind-messages.json) was written by an agent that never saw the rule: 86 messages each about one of part 2's extracted temporary or ongoing facts (43 English, 43 Hungarian), 40 unrelated messages (20 and 20), and 10 Hungarian messages about facts written in English. The bank is every config-2 personal fact part 2 extracted (120: its question, brainstorm, lasting, ongoing and temporary statements; the project bank left out), weighed as recall weighs a bank; its 43 temporary and ongoing facts are the Earlier entries, every one assumed in the top three for every message. Command: [label-migration-acceptance/earlier-blind.ts](label-migration-acceptance/earlier-blind.ts); raw output with every id: [label-migration-acceptance/earlier-blind-results.json](label-migration-acceptance/earlier-blind-results.json).

| Messages | Result | Target |
|---|---|---|
| About an entry | **45 of 86 (52%)** bring their own entry (EN 26 of 43, HU 19 of 43) | at least 8 in 10: **missed** |
| Unrelated | **10 of 40 (25%)** bring an Earlier entry (EN 9 of 20, HU 1 of 20) | at most 1 in 10: **missed** |
| Cross-language | **0 of 10** bring their own entry | reported |
| About an entry, bringing another as well | 45 of 86 (84 other entries in all) | reported |

False matches of the unrelated messages (message index: Earlier entries): 1: `v2:ongoing:o-en-10:0#0`; 2: `v2:ongoing:o-en-10:0#0`, `v2:temporary:t-en-07:0#0`; 3: `v2:ongoing:o-en-07:0#0`; 4: `v2:ongoing:o-en-07:0#0`; 5: `v2:ongoing:o-en-01:0#0`, `v2:ongoing:o-en-09:0#0`; 8: `v2:temporary:t-en-01:0#0`; 9: `v2:ongoing:o-en-07:0#0`; 10: `v2:ongoing:o-en-02:0#0`; 14: `v2:ongoing:o-en-07:0#0`; 29: `v2:ongoing:o-hu-07:0#0`.

**What the misses are.** Every one of the 41 missed about-messages shares no significant word with its entry: they name the thing in other words, which no word rule reads. Of the 12 unrelated false matches, 6 are words the stop list lacks ("using", "mostly", "through", "főleg") and 6 are one ordinary word in another sense ("cold", "book", "report", "keeper", "budgeting", "podcasts"). Not retuned after the measurement: the owner decides.

**Limits.** A message about an entry still needs the entry in its bank's top three, which only a real Hindsight measures; the worst case above puts every Earlier entry there for every message. A message mentions an entry written in the other language only through a shared name or word; the model's `memory_context` tool, which ranks by meaning, still returns Earlier entries wherever they rank. No score floor was added to the word rule: Hindsight's recall returns no relevance score at the pin. The app's own reranker supplies one, below.

## The reranker check (2026-11-24)

The word rule missed both blind targets (52% about an entry, 25% unrelated) and cannot bridge two languages, so the orchestrating session measured production's reranker on the same blind set, and the gate now uses it.

**Measurement.** Production's TEI reranker, `bge-reranker-v2-m3` (sigmoid scores, `truncate: true`, at most 32 texts a request, batches of 20), scored every blind-set message (86 about an entry, 40 unrelated, 10 Hungarian about English) against the 43 temporary and ongoing facts of part 2's extraction: 136 messages against 43 entries, 3.1 s in all, run on the box so its key never left it. The worst case is the one above: every Earlier entry counts as ranked in its bank's top three for every message. The word rule's verdicts for the same pairs are in `lex.json`. Method, script and raw scores: [label-migration-acceptance/earlier-rerank/](label-migration-acceptance/earlier-rerank/README.md). Synthetic text only.

| Rule | About an entry | Wrong extra entry as well | Unrelated | Cross-language |
|---|---|---|---|---|
| The word rule (before) | 45 of 86 (52%) | 45 of 86 (52%) | 10 of 40 (25%) | 0 of 10 |
| Reranker score at or above 0.005, alone | 46 of 86 (53%) | 7 of 86 (8%) | 2 of 40 (5%) | 7 of 10 |
| **Built:** score at or above 0.002, or the words agree and the score is at or above 0.0005 | **66 of 86 (77%)** | 14 of 86 (16%) | **3 of 40 (8%)** | **7 of 10 (70%)** |
| Target (spec) | at least 8 in 10 | | at most 1 in 10 | reported |

- **Held out.** The two floors were picked on half the entries and tested on the other half: picked on the even entries and tested on the odd, about 79% about and 7% unrelated; picked on the odd and tested on the even, about 75% and 7%. Both picks land on a main floor of 0.002 and a word floor between 0.0002 and 0.0005. The defaults are `MEMORY_EARLIER_RERANK_MIN` 0.002 and `MEMORY_EARLIER_RERANK_WORD_MIN` 0.0005.
- **Against the targets.** Unrelated is met (8%, at most 10%). About is 77%, just short of 8 in 10 in this worst case. Cross-language goes from none to 7 of 10.
- **Reproduced by the code.** `src/lib/server/services/memory-context/earlier-rerank.acceptance.test.ts` runs the stored scores and word verdicts through `earlierJoins` at the shipped defaults and holds every figure of the table above.

**What runs in a turn.** In `recallMemory`'s per-turn path only (the `memory_context` tool reads no reranker and returns Earlier entries as before), an Earlier entry in its bank's top three joins when the reranker scores it at or above `MEMORY_EARLIER_RERANK_MIN`, or at or above `MEMORY_EARLIER_RERANK_WORD_MIN` when the word rule agrees as well, and never below that. The turn makes one reranker call for all its Earlier candidates (at most six; the person's own words, never the chat's title, cut at their first 4,000 and last 2,000 characters; 500 ms), through the app's TEI reranker client and `TEI_RERANKER_*` settings. A score applies only to the text it was given. Consent is checked again after the call, whatever it answered, and the entries are read again when a score moves an entry from the words' verdict, so edits made meanwhile count then. A score outside 0 to 1 is no score, a query never holds half an emoji, and a missing reranker is said once per process, not on every turn. With no reranker configured, a timeout, an error or an empty answer the word rule decides alone and one content-free line, `[KNOWLEDGE_MEMORY] Earlier rerank unavailable` with a code (`not_configured`, `timeout`, `error`, `empty`), says why; a turn never fails for it. Both floors are decimals from 0 to 1 in Settings, Advanced, Memory, and a word floor set above the main floor reads as the main floor. Code: `memory-context/earlier-rerank.ts`, wired in `memory-context/native.ts`; tests in `earlier-rerank.test.ts` (each branch, the one batched call, the fallbacks) and `native.test.ts` (the whole turn, the title never used as the query, a megabyte message, the tool unchanged, consent and edits during the call).

**Limits.**
- The worst case still assumes every Earlier entry ranks in its bank's top three; the rank half needs a real Hindsight.
- The floors were chosen on this set. The held-out halves are the check; a second blind set would be the proof.
- The measured documents are Hindsight's raw fact strings (with their " | When: … | Involving: …" parts), while a turn scores each entry's published text: Hindsight's observation wording, or the person's own wording after an edit. Scores for observation text may sit higher or lower than for fact text, and the floors are small (0.002). After the deploy, watch the Recall line's `earlier` count per bank (an unrelated message should rarely bring one) and measure again on observation texts if the join rate looks off.
- The measurement covers the reranker only. The cost in a turn was not measured end to end under load: the 3.1 s above covered 5,848 pairs (about half a millisecond a pair), and a turn scores at most six entries, bounded at 500 ms, with the word rule as the fallback.
- A wrong extra entry rides along in 16% of the messages about an entry (the word rule: 52%); the cap of three Earlier entries a turn still holds.
