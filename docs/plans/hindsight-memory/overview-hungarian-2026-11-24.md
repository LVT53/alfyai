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
| paragraphs with any slip | 6 of 10 (60%) | 20 of 30 (67%) |
| paragraphs with a slip other than E | 6 of 10 (60%) | 14 of 30 (47%) |
| paragraphs over six sentences | 0 | 0 |
| a personal paragraph's length | 785 characters | 506 characters |

**What moved.** The broken clauses that came from cramming five or six facts into a sentence ("angolul anyanyelve, a magyar mellett", "valamint egy kétszobás lakásban", "heti egy óra japán órát vesz", "rövidlátó szemüveggel, aki ...") and the details carried between entries ("péntekig nem iszik alkoholt", the knee "gyógyul") fell; the paragraphs are about a third shorter, with one or two facts a sentence.

**What did not move.**
- **"freelance" stays** (14 of 15 shipped personal paragraphs, 5 of 5 before). It is the entry's own word, and the model treats it as ordinary Hungarian; the "borrowed word" line did not change that, and an ASCII prompt cannot give it the Hungarian word. It is not the model's slip to fix: Hindsight wrote it into the entry.
- **"japánt tanul"** (for "japánul tanul", learns Japanese) came back 4 times in 15 shipped paragraphs, 1 in 5 before: sampling noise at the family profile, not something a prompt line removes. It is colloquial ("angolt tanul" is everyday speech), so counting it as unnatural in a written paragraph is a judgment: leaving it out takes 1 from U before and 4 from U after.
- **The "borrowed word" line did nothing measurable** ("freelance" stayed: 5 of 5 in after 1, 4 of 5 in after 2), and its examples are English words, so for an English account it can only be neutral. It ships because the rounds measured the prompt with it. The part that mattered is the name clause ("Peter" for "Péter": 4 of 5 project paragraphs without it, 1 of 15 with it). Drop the borrowed-word line in the next round if it is wanted gone, and measure again.
- **New with the change:** a few "ezért" (so) links the entries do not make (2 of 5 project paragraphs in the third round of the shipped prompt), and "de ..." contrasts between an injury and a sport.
- **A relative clause with the wrong antecedent** ("A projekt célja ... tárolása, amelyet Kata és édesapja épít": the storage is not what they build) appeared before (1) and after (2 of 15).

**English** paragraphs written from the Hungarian entries, read for the rounds before, after 1, after 2 and after 3 (10 each): 7, 6, 7 and 6 slips. Unchanged within the noise. Mostly "learning" turned into "plays" and a shed built "for her grandparents" (it is in their garden); the first two changes also anglicised "Péter" to "Peter" (4 of 5 project paragraphs in after 2) until the name line was added (1 of 15 after). Two earlier faults ("double-winged", "two-bedroom") did not recur.

**Mechanical counts** (`tally.py`, per round, personal Hungarian paragraphs): "japánt tanul" 1, 1, 0, 3, 0, 1 across the six rounds; "Bakonyban" 1, 1, 0, 0, 1, 0; "freelance" 5, 5, 4, 5, 5, 4. Over six sentences: 1 (after 1, a Hungarian project paragraph, before the cap was worded) and 1 (after 3c, an English project paragraph); no Hungarian paragraph since.

## What the prompt says now

_Superseded on 2026-11-24 by the Config 3 round at the end of this note: the cap of three to six sentences and "leave out the least important ones" are gone, and the borrowed-word line is a general rule._

Still English, ASCII, and the language named once (`Write the paragraph in <language>.`, ruling 79's I2 exception; `overview.test.ts` counts the names and the characters). Three lines changed or arrived; `overview.test.ts` holds each:

1. **Own words, names as written:** "Use that language's own everyday words: translate any term in the entries into it, but keep every name exactly as written, accents included. A word borrowed from another language, such as freelance or deadline, gets the paragraph's own word."
2. **Details stay with their entry:** the "use only the entries given" line gains "Keep each detail with the entry it comes from: never move a time, place, name or number to another entry, and keep what is being learned, planned or looked for as learning, planning or looking."
3. **Shorter, selective:** "Write three to six short, plain sentences, never more than six, with one or two facts in each and no fact twice; ... You need not mention every entry: leave out the least important ones rather than crowd a sentence."

## Limits, for whoever reads the counts

- **Small and noisy.** Five runs a cell, one reader, one synthetic persona: the rounds `after 2`, `after 3`, `3b` and `3c` differ by more than their prompts do (the same prompt scored 1.3, 1.0 and 1.1; the round before it, 0.5). The honest reading is that U and I roughly halved (1.3 to 0.7 a paragraph) while the share of paragraphs with any slip did not fall (6 of 10, then 20 of 30), because the loan "freelance" is in nearly every personal paragraph and two kinds of slip are new or more common (the "ezért" links, and the wrong-antecedent clause: 2 of 15 against 1 of 5); it is not a measurement of a size.
- **Shorter is a product change.** The Overview now leaves out some entries on purpose. Nothing is lost from Memory; the sheet is "a short summary". The owner can veto the "least important ones" line.
- **The second kind of input.** The entries are Hungarian, as Hindsight writes them for a Hungarian account. English entries read in a Hungarian UI were not run.
- **Not covered:** the real accounts' wording, long scopes near the 6,000-token budget, and the interactive priority path of the gateway.

## If it still reads badly on real overviews

- Lower the Overview's temperature (a number in `composeMemoryOverview`'s call; part 3 chose the family profile so that Rewrite gives different words).
- Ask Hindsight's bank to word loan terms in the account's language (its `retain_mission`), which would fix "freelance" at the source and in recall.
- Re-run this probe: the inputs are here, and the recipe above is short.

## Config 3 round (2026-11-24)

The owner asked for the two remaining wording fixes: the paragraph uses the account's language's own word where one exists, not the loan word Hindsight left in the entry ("szabadúszó", not "freelance"), and it does not silently leave entries out (the line "leave out the least important ones" above is the one they do not want). Same synthetic scopes and the same two languages as above; no real data.

### Method, what is new

- **The probe is committed** (`overview-hungarian-2026-11-24/probe.lab.ts` with its `vitest.config.ts`, a Fallow entry like the document-ranking labs; not part of `npm test`): `OVERVIEW_PROBE_LABEL=<name> npx vitest run -c docs/plans/hindsight-memory/overview-hungarian-2026-11-24/vitest.config.ts`. It calls the app's own `composeMemoryOverview` with a `CurationModel` that sends what `createCurationModel` sends for a person-read call; each output file keeps one `sampleRequest` (`qwen3-6-27b`, temperature 0.6, top_p 0.95, top_k 20, thinking off, the strict `memory_edit` schema, 8,192 tokens). It goes to the shared bridge (`http://127.0.0.1:18891/v1`, which holds the key; no key was read), one call in flight, without admission headers. `OVERVIEW_PROBE_ENTRIES=en` runs an English account over English entries (`personal.en.json`, `project.en.json`, the same facts), `=large` a scope of 104 entries (`personal.large.json`).
- **95 calls, none failed:** 20 a prompt (2 scopes x `hu`/`en` x 5 runs, interleaved by run) for the prompt in production (`ce8e26f68`), round 1, round 2 and round 3; English entries 6 + 6 (production's six with `overview.ts` from `ce8e26f68` put back for the run); the large scope 3.
- **Counted by reading,** every paragraph, one reader. `outputs/config3-reading.json` has what was found paragraph by paragraph (each U and I with a quote); `outputs/reading-summary.py` prints the table rows; `outputs/tally-config3.py` is a first-pass aid with a pattern per entry (it misled in places, for instance on the Hungarian "ukulelén", whose vowel lengthens, so each paragraph was checked against its text).
- **C, the completeness count (new).** Per paragraph: the entries it **states** (a mention of the entry's content counts, in a list or a group), the entries **nowhere** in it, the scope's subjects with current entries (7 personal, 4 project) it **covers** (one of the subject's entries stated; a group mention that names none would count for the subject but not for the entry, and none occurred), and **complete** (every entry stated).
- **Loan words** are counted per paragraph, each distinct word once (freelance, boulder from "boulderezik", sci-fi), apart from E (other English words left in a Hungarian paragraph: 0 in every round). **W** is a word of the other language left in a paragraph (Hungarian in an English one). **L** is more sentences than the cap in force (6, 10, 12).

### Results

Hungarian personal paragraphs (5 a round; 30 entries, 7 subjects):

| | production | round 1 (shipped) | round 2 (not shipped) |
|---|---|---|---|
| entries nowhere in a paragraph (of 150) | 53 | 1 | 2 |
| paragraphs with every entry | 0 of 5 | 4 of 5 | 3 of 5 |
| subjects covered (of 7, a paragraph) | 6.2 | 7.0 | 7.0 |
| loan words left in: freelance, boulder, sci-fi (of 5) | 5, 5, 1 | 4, 5, 4 | 0, 1, 0 |
| U (unnatural) | 3 | 9 | 15 |
| I (invented or moved) | 3 | 4 | 8 |
| sentences, characters a paragraph | 5.6, 592 | 8.6, 1,062 | 11.0, 1,122 |

The other three cells (U / I / W are counts over 5 paragraphs):

| | production | round 1 (shipped) | round 2 (not shipped) |
|---|---|---|---|
| **Hungarian project**: nowhere (of 60), U / I, sentences, characters | 7, 3 / 0, 4.6, 421 | 0, 4 / 0, 6.2, 567 | 0, 6 / 2, 7.4, 592 |
| **English personal** (from the Hungarian entries): nowhere (of 150), paragraphs complete | 51, 0 of 5 | 0, 5 of 5 | 2, 3 of 5 |
| English personal: subjects (of 7), U / I / W | 6.4, 0 / 4 / 0 | 7.0, 1 / 4 / 0 | 7.0, 5 / 2 / 3 |
| English personal: sentences, characters, over the cap | 5.6, 682, 0 | 11.2, 1,394, 3 | 12.2, 1,361, 2 |
| **English project**: nowhere (of 60), U / I, sentences | 5, 0 / 1, 4.4 | 0, 0 / 0, 8.6 | 0, 1 / 0, 9.6 |

P and W were 0 except round 2's three (below); no paragraph held markup or named memory or entries.

**An English account over English entries** (3 runs a scope; production against round 1): personal paragraphs leave 37 of 90 entries nowhere against 0, cover 5.7 of 7 subjects against 7.0, are complete 0 of 3 against 3 of 3, run 4.3 against 13.0 sentences (9, 11, 17; 497 against 1,334 characters), with U 0 against 1 and I 3 against 0; project paragraphs leave 3 of 36 nowhere against 0 (5.0 against 7.3 sentences). Nothing odd was written in either: the rule about borrowed words had nothing to act on, which is what an English account needs from it.

**A large scope** (104 synthetic entries, English, round 1, 3 runs): every subject covered, but entries are left out again: 26, 6 and 28 of 104 (mean 20 of 104, 19%), mostly small lasting facts (a family's details, trivia), in paragraphs of 1,925, 2,744 and 1,813 characters whose "sentences" are run-on lists (the longest 502 characters).

### What the rounds show

- **Completeness is fixed at 30 entries.** One entry of 420 is nowhere in round 1 (it dropped a job title), against 116 of 420 in production, and every subject is covered in 20 of 20 paragraphs. It costs length: a personal paragraph is 1.8 times as long in Hungarian (592 to 1,062 characters) and 2.0 times in English, and the model does not keep to the cap of ten (3 of 5 English personal paragraphs wrote 11 to 13 sentences; 2 of 3 on English entries wrote 11 and 17). The cap is a hint, not a limit.
- **Round 1's rule about borrowed words did nothing, as the earlier line did not:** freelance stayed in 4 of 5 paragraphs, boulder in 5 of 5, sci-fi in 4 of 5 (13 loan words in 5 paragraphs, against 11), so a rule stated in words has no measurable effect here, with the example words gone as well. The model treats "freelance" as ordinary Hungarian however it is asked.
- **Round 1's Hungarian slips are the known kinds, more of them in longer paragraphs** (U 13 and I 4 in 10 paragraphs, against 6 and 3): a missing article ("Bakonyban", twice), "japán nyelvből" and "japánórákat vesz" for "hetente egy órát vesz", the compound "ügyféllogó", links the entries do not make ("miután korábban Szegeden élt", "szintén", "míg"), "learning to play" turned into "plays", and one garbled family list. Per sentence, U and I together went from 0.18 to 0.23 in Hungarian (0.9 to 1.7 a paragraph) and stayed at or below 0.10 in English (0.5 a paragraph in both).
- **Round 2 made the model list the borrowed words with their own words before it wrote the paragraph** (a second field in the strict schema, read and dropped; plus "link two entries by a cause, a contrast or a time only when an entry says so" and "at most four things in a sentence, at most twelve sentences"). The loan words went (freelance 0 of 5, sci-fi 0, boulder 1: "szabadúszó" once, "önálló grafikus" and "önálló tervező" in the others), and so did the quality: the model replaces words that have no everyday replacement and invents the replacement. "Hawaii gitár" for the ukulele (three times; in English "hawaii guitar" and "small guitar"), "tejtermékérzékeny" for lactose intolerant, "önálló képzőművész" (fine artist) for a freelance graphic designer, "sziklázik" (not a word) three times, "jelkép" for a logo, "másodfokú képzés" for a master's, and it left three Hungarian words in 2 English paragraphs ("tudományos-fantasztikus novels" twice, "tejcukor"). U 21 and I 10 in 10 Hungarian paragraphs (0.34 a sentence), against 6 and 3 in production (0.18). A list-first rule works on the symptom and breaks "nothing invented".

### What ships, and what does not

Round 1 ships: the completeness line and the borrowed-word rule as measured (the rule is inert but general, with no example word, and costs nothing). Round 2 and round 3 are not shipped: their code changes are kept as `outputs/config3-round2-not-shipped.patch` and `outputs/config3-round3-not-shipped.patch` (`git apply` takes either on the shipped commit).

The prompt, the lines that changed (`overview.ts`; `overview.test.ts` holds each; still English, ASCII, the language named once):

1. "Use that language's own everyday words: translate any term in the entries into it, but keep every name exactly as written, accents included. Copy no word from another language out of an entry, however common it has become (it is spelt the way that other language spells it): write this language's own everyday word for the same thing, and keep the borrowed word only when there is none."
2. "Cover every subject the entries are filed under, with at least one short, plain sentence for each, and leave no entry out: when a subject has several small entries, name each in a few words within one sentence rather than dropping any. Use as many sentences as that takes, never more than ten, each one simple, with no fact twice; no headings, lists, quotation marks or emphasis. Never mention memory, entries, lists or this task."

The three-to-six sentence cap and "You need not mention every entry: leave out the least important ones" are gone. The guard against a runaway answer rose from 3,000 to 6,000 characters (`OVERVIEW_MAX_CHARS`), because the large scope's paragraphs reached 2,744: 3,000 would have refused the write (the sheet's "try again") from about 110 entries up. That commit stands apart and can be dropped alone.

Round 2's wording (round 3, below, started from it): line 1 became "...First list in borrowed_words every word of an entry that this language took from another language (it is spelt the way that other language spells it, however common it has become; a name is never one), each with this language's own everyday word for the same thing, and write the paragraph with the own words; where there is no own word, the borrowed word may stay.", the schema `{"borrowed_words": [{"word", "own_word"}], "overview"}` (both required, in that order), and "Return JSON: {...}. The list is empty when no entry holds such a word."

### Round 3: the list again, an own word only if one already exists (not shipped)

Asked for after round 2, with round 1's completeness line kept as it is. Round 3 is round 2's list-first rule with a rule against coining: the model may give a borrowed word an `own_word` only when this language already has an everyday word for exactly the same thing that people use today, never one coined, described, translated literally or compounded, and gives `null` when it is not sure such a word exists ("a null is correct and a coined word is the worse fault"); the paragraph then uses the own word where there is one and the entry's word as written where it is null. The schema's `own_word` is `string | null`; the "link two entries" line and round 2's "four things, twelve sentences" were left out, so round 3 differs from the shipped prompt in the borrowed-word sentence, the schema and the `Return JSON` line only (`outputs/config3-round3-not-shipped.patch`; tests first, red then green, then taken out again). 20 calls, none failed.

Ship conditions, set before the run: over the Hungarian paragraphs "freelance" at most 1 of 5, no invented or described word in any paragraph read, completeness no worse than round 1; English paragraphs with no Hungarian word and no new slip. It meets the third and fails the other three:

| | round 1 (shipped) | round 3 (not shipped) |
|---|---|---|
| **Hungarian personal**: entries nowhere (of 150), paragraphs complete | 1, 4 of 5 | 0, 5 of 5 |
| loan words left in: freelance, boulder, sci-fi (of 5) | 4, 5, 4 | **5, 5, 4** |
| invented or described words | 0 | **1** ("jelkép-terv" for the logo design) |
| U / I, sentences, characters a paragraph | 9 / 4, 8.6, 1,062 | 7 / 4, 9.6, 1,112 |
| **Hungarian project**: nowhere (of 60), U / I, sentences | 0, 4 / 0, 6.2 | 0, 3 / 2, 8.4 |
| **English personal**: nowhere (of 150), U / I | 0, 1 / 4 | 0, 1 / 2 |
| Hungarian words left in the paragraph (W) | 0 | **4, in 2 paragraphs** ("embléma", "arculat", "grafikus", "logó") |
| sentences, characters, over the cap of ten | 11.2, 1,394, 3 | 15.2, 1,371, 3 (25, 11, 20) |
| **English project**: nowhere (of 60), sentences, over the cap | 0, 8.6, 0 | 0, 11.0, 4 |

What the lists show (the probe keeps them as `extras`): in the 10 Hungarian calls the model listed 64 words and gave an own word to 4. Two of those were the word itself ("betonalap", "fűrésztelep"), one was coined ("logóterv" to "jelkép-terv": the failure the rule is for, 1 in 64, against about 14 coined words in round 2's five personal paragraphs) and one was right ("sci-fi" to "tudományos-fantasztikus", once). "freelance" got `null` in the four lists that named it and was not listed in the fifth; "boulder" got `null`. The lists are not lists of borrowed words: they hold "logó", "gyógytorna", "alkohol", "mesterképzés", "betonalap", "fűrésztelep", "Lisszabon", "Ursula", "Le", "Guin". In the English paragraphs the list gave its own words in the wrong language ("logó" to "embléma") and the rule "the entry's word as written where it is null" put Hungarian words into the paragraph.

So the rule does what it was written for, the coinage almost went (1 in 64), and the fix went with it: a model that cannot tell which of its entry's words are borrowed says `null` for the one that is ("freelance"), keeps it, and an English paragraph keeps the Hungarian words next to it. A list-first rule is safe or effective in this model, not both. The English paragraphs also grew into one-fact sentences (25 in one) under it. Round 1 stays as shipped.

### Not fixed

- **The loan words.** Hungarian paragraphs still say "freelance" (4 of 5), "boulderezik" (5 of 5) and "sci-fi" (4 of 5). Three prompt rules were tried on them: a plain rule does nothing (round 1), a list-first rule invents words (round 2), and a list-first rule that must give `null` instead of inventing leaves them in (round 3). Ways on, none run: (a) the source: have Hindsight word loan terms in the account's language (`retain_mission`; the entry would then say "szabadúszó"), which also fixes recall; (b) a fixed, small word list in code for the few loans that matter, applied to the entries before the model sees them, which is no model call at all but a list somebody has to keep; (c) accept "freelance" and "sci-fi", which Hungarian speakers do say, and note that "boulderezik" is itself a Hungarian word in use, so the replacements the model found for it were worse than the loan.
- **Scale.** At 104 entries round 1 states about 80% of the entries, and the paragraph is a wall of run-on lists. The prompt says "name each in a few words", which does not scale; for a big scope, group by theme in the prompt, or write one short sentence per subject in its own call, and measure it on a scope this size.
- **Length.** Paragraphs are about twice as long at 30 entries; the cap of ten is not kept. If the owner wants shorter, the lever is the cap's wording, and what it costs is entries.
- **Hungarian slips** went up with the length (see above); a second look on real accounts is still owed.
- **Not covered:** real accounts' wording, the interactive path of the gateway, and any scope between 30 and 104 entries.
