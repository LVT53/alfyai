# The Overview's Hungarian: a probe on the real model and a prompt change (2026-11-24)

The Overview (`memory-profile/overview.ts`, Memory part 3) is one paragraph the local model writes when a person opens it, in the account's UI language. The part 3 probe (seven cases, three runs each) found two faults (a non-word and an odd conditional) in nine Hungarian personal paragraphs and changed nothing, because 21 samples cannot show that a prompt change helps. The owner asked for the Hungarian to be looked at again, on synthetic data only. This note is that look: the inputs, the method, five rounds of counts, the prompt change they led to, and what it does not fix.

No real overview was read and no production or owner data was used. Both scopes are invented (a person called Kata, a garden-shed project); the names are common Hungarian given names chosen for the probe and stand for no one.

## Inputs

[`overview-hungarian-2026-11-24/personal.json`](overview-hungarian-2026-11-24/personal.json) (30 entries across the personal subjects, kinds `lasting`, `ongoing` and `temporary`, newest first) and [`project.json`](overview-hungarian-2026-11-24/project.json) (12 entries across the project subjects). They are worded the way Hindsight words a Hungarian account's entries: one third-person sentence each, "A felhasználó ...", with the loan words Hindsight leaves in ("freelance", "boulderezik", "sci-fi"). One entry holds a past ("korábban Szegeden élt"), so a mention of it is faithful and a mention of any other past is not.

## Method

- **The real code path.** A temporary vitest test (deleted; never committed) called the app's own `composeMemoryOverview` for each scope and language, with a `CurationModel` that sends the same request `createCurationModel` sends: `sendJsonControlMessageViaProvider`, thinking off, no temperature of its own (the call is person-read, so the qwen family's profile: temperature 0.6, top_p 0.95, top_k 20), the strict `memory_edit` JSON schema, 8,192 output tokens. It went straight to `https://inference.alfycomms.com/v1` as `qwen3-6-27b`, the served name production uses (it resolves to Flash-Next), without the gateway's admission headers. The key was read from the owner's dsh env at run time and never printed, logged or stored; three calls were in flight at most.
- **Per round:** 2 scopes x 2 UI languages (`hu` and `en`, both over the same Hungarian entries) x 5 runs = 20 calls, about 15 seconds. Every call answered; none was refused or timed out.
- **Counted by reading** (one reader, all Hungarian outputs; the English ones for the rounds named below), with these categories:
  - **E** an English word left in a Hungarian paragraph;
  - **U** unnatural: a word or clause a native writer would not write (a wrong word, broken grammar, a relative clause with the wrong antecedent, a missing article before a name such as "Bakonyban");
  - **I** invented or moved: a detail the entries do not hold, a time carried from one entry to another, "learning" turned into "does", a causal link no entry makes;
  - **L** longer than six sentences; **P** a mention of a removed or earlier entry the entries do not hold; **W** the wrong language.
- **Counted by a script** (`overview-hungarian-2026-11-24/outputs/tally.py`, over the saved outputs): "freelance", "japánt tanul" (the wrong word for "learns Japanese"), "Bakonyban" with no article, "Peter" for "Péter", more than six or fewer than three sentences, a mention of memory or entries, markup.

## Results

Hungarian paragraphs, 10 a round (5 personal, 5 project). Rounds are cumulative: each adds to the one before it.

| Round | Prompt | E | U | I | L | slips a paragraph | paragraphs with a slip |
|---|---|---|---|---|---|---|---|
| before | the prompt on `main` (`8f401d4f9`) | 5 | 9 | 4 | 0 | 1.8 | 6 of 10 |
| after 1 | + the paragraph's own words, each detail kept with its entry, short sentences, not every entry | 5 | 5 | 1 | 1 | 1.2 | 6 of 10 |
| after 2 | + a borrowed word gets the paragraph's own word; never more than six sentences; no fact twice | 4 | 0 | 1 | 0 | 0.5 | 5 of 10 |
| **after 3 (shipped)** | + every name exactly as written, accents included | 5 | 6 | 2 | 0 | 1.3 | 6 of 10 |
| after 3b (same prompt) | | 5 | 3 | 2 | 0 | 1.0 | 6 of 10 |
| after 3c (same prompt) | | 4 | 4 | 3 | 0 | 1.1 | 8 of 10 |

P and W were 0 in every round: no paragraph mentioned a removed or earlier entry the entries do not hold (the one earlier state in the input was reported faithfully when it appeared), none was in the wrong language, none held a heading, list, quotation mark or emphasis, and none named memory or entries.

**Before against the shipped prompt** (the three `after 3` rounds are the same prompt, so 30 paragraphs against 10):

| | before (10) | shipped (30) |
|---|---|---|
| slips a paragraph, all | 1.8 | 1.1 |
| E, the loan "freelance" | 0.5 | 0.5 |
| U + I, everything else | 1.3 | 0.7 |
| paragraphs with a slip other than E | 6 of 10 | 14 of 30 (47%) |
| paragraphs over six sentences | 0 | 0 |
| a personal paragraph's length | 785 characters | 506 characters |

**What moved.** The broken clauses that came from cramming five or six facts into a sentence ("angolul anyanyelve, a magyar mellett", "valamint egy kétszobás lakásban", "heti egy óra japán órát vesz", "rövidlátó szemüveggel, aki ...") and the details carried between entries ("péntekig nem iszik alkoholt", the knee "gyógyul") fell; the paragraphs are about a third shorter, with one or two facts a sentence.

**What did not move.**
- **"freelance" stays** (14 of 15 shipped personal paragraphs, 5 of 5 before). It is the entry's own word, and the model treats it as ordinary Hungarian; the "borrowed word" line did not change that, and an ASCII prompt cannot give it the Hungarian word. It is not the model's slip to fix: Hindsight wrote it into the entry.
- **"japánt tanul"** (the wrong word) came back 4 times in 15 shipped paragraphs, 1 in 5 before: sampling noise at the family profile, not something a prompt line removes.
- **New with the change:** a few "ezért" (so) links the entries do not make (2 of 5 project paragraphs in the third round of the shipped prompt), and "de ..." contrasts between an injury and a sport.
- **A relative clause with the wrong antecedent** ("A projekt célja ... tárolása, amelyet Kata és édesapja épít": the storage is not what they build) appeared before (1) and after (2 of 15).

**English** paragraphs written from the Hungarian entries, read for the rounds before, after 1, after 2 and after 3 (10 each): 7, 6, 7 and 6 slips. Unchanged within the noise. Mostly "learning" turned into "plays" and a shed built "for her grandparents" (it is in their garden); the first two changes also anglicised "Péter" to "Peter" (4 of 5 project paragraphs in after 2) until the name line was added (1 of 15 after). Two earlier faults ("double-winged", "two-bedroom") did not recur.

**Mechanical counts** (`tally.py`, per round, personal Hungarian paragraphs): "japánt tanul" 1, 1, 0, 3, 0, 1 across the six rounds; "Bakonyban" 1, 1, 0, 0, 1, 0; "freelance" 5, 5, 4, 5, 5, 4. Over six sentences: 1 (after 1, a Hungarian project paragraph, before the cap was worded) and 1 (after 3c, an English project paragraph); no Hungarian paragraph since.

## What the prompt says now

Still English, ASCII, and the language named once (`Write the paragraph in <language>.`, ruling 79's I2 exception; `overview.test.ts` counts the names and the characters). Three lines changed or arrived; `overview.test.ts` holds each:

1. **Own words, names as written:** "Use that language's own everyday words: translate any term in the entries into it, but keep every name exactly as written, accents included. A word borrowed from another language, such as freelance or deadline, gets the paragraph's own word."
2. **Details stay with their entry:** the "use only the entries given" line gains "Keep each detail with the entry it comes from: never move a time, place, name or number to another entry, and keep what is being learned, planned or looked for as learning, planning or looking."
3. **Shorter, selective:** "Write three to six short, plain sentences, never more than six, with one or two facts in each and no fact twice; ... You need not mention every entry: leave out the least important ones rather than crowd a sentence."

## Limits, for whoever reads the counts

- **Small and noisy.** Five runs a cell, one reader, one synthetic persona: the rounds `after 2`, `after 3`, `3b` and `3c` differ by more than their prompts do (the same prompt scored 1.3, 1.0 and 1.1; the round before it, 0.5). The honest reading is that U and I roughly halved (1.3 to 0.7 a paragraph) and that nothing got worse; it is not a measurement of a size.
- **Shorter is a product change.** The Overview now leaves out some entries on purpose. Nothing is lost from Memory; the sheet is "a short summary". The owner can veto the "least important ones" line.
- **The second kind of input.** The entries are Hungarian, as Hindsight writes them for a Hungarian account. English entries read in a Hungarian UI were not run.
- **Not covered:** the real accounts' wording, long scopes near the 6,000-token budget, and the interactive priority path of the gateway.

## If it still reads badly on real overviews

- Lower the Overview's temperature (a number in `composeMemoryOverview`'s call; part 3 chose the family profile so that Rewrite gives different words).
- Ask Hindsight's bank to word loan terms in the account's language (its `retain_mission`), which would fix "freelance" at the source and in recall.
- Re-run this probe: the inputs are here, and the recipe above is short.
