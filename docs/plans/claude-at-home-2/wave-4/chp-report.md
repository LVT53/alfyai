# Agent CHP: follow-up chips a person would actually send, and "angolul" only when it is a request

Model: claude-sonnet-5-5 (Sonnet 5.5). Branch `fix/follow-up-chips` (from `dev` `b179456b`), worktree `…/.claude/worktrees/chp`, commits `b179456b..HEAD` (11 commits, all with the Co-Authored-By trailer, nothing pushed). e2e port 5450.
No framework API was touched beyond what the repo already uses (an i18n string, plain Playwright locators), so the Context7/Svelte docs check had nothing to confirm (not available in this session, per the wave rules).
Real model only through `ssh -N -L 30403:192.168.1.96:30000 alfyroot` started in the same command as each run (`qwen3-6-27b`), sequential, no key, `~/.config/opencode/opencode.json` never read. Probe harness, raw runs and labels: `…/scratchpad/w4/chp-probe/` (README.txt there), outside the repo.

## Headline

1. **A chip is now the person's next message, pinned by tests and by a check that sits between the model and the button.** Tapping a chip sends its text verbatim as the user's own message (`MessageBubble.sendFollowUp` -> `handleSendFollowUp` -> `handleSend`; nothing lands in the composer), so the chip has to be that message. `chat-turn/follow-up-chip.ts` rejects Alfy offering, a question put to the person, a statement about the person, a generic push, the wrong language/script and anything that is not one short plain sentence; the prompt asks for an instruction or the person's own question about a named thing.
2. **On the real model the old chips were rarely Alfy talking, but they were seldom something Alfy could do, and a quarter addressed "you".** Over 26 conversations x 3 samples (78 chip sets per arm in each of the two main corpora, 24 in the offer-ending one): chips that ask Alfy to produce or transform something went from 8-10% (26% on offer-ending replies) to 78-81%; chips that name what they act on from 78-80% to 97-99%; chips addressed to "you" (which read as Alfy's words under Alfy's reply) from 20-32% to 0-2%; and the sets with no chip at all (the old rule demanded a question mark, so the imperative that accepts Alfy's offer was thrown away) from 8 of 180 to 0.
3. **"angolul" / "in Hungarian" is a request only when the person asks for the answer in it.** On the real model 33 of the 42 mention prompts ("Hogy mondják angolul, hogy alma?", "How do you say 'apple' in Hungarian?") got a reply in the wrong language; now 0 of 42, and 18 of 18 genuine requests still flip. It also fixes titles: the learning question's title went from 3 of 5 language-mismatch fallbacks (and two English titles) to 0 of 5, all Hungarian.
4. The prompt does most of the work (the check rejected 12 of 540 candidates the model wrote after the rewrite), but the check found two wrong-party chips the prompt let through ("Ragaszd be a hibás Python kódrészletet", "Írj e-mailt a főnöködnek…") and is what keeps the next ones out.

## Step 1: what a chip is, then the prompt

**What a click sends.** `MessageBubble.svelte` renders up to two `follow-up-chip` buttons on the latest assistant message; `sendFollowUp(question)` records the click and calls `onSendFollowUp({ text })`; the chat page's `handleSendFollowUp` trims it and sends it through the normal send path (queued while a turn runs). So the wording is exactly what goes out and what the person then sees as theirs. A Playwright spec now pins it with a real pointer tap and with the keyboard (below). The accessible name was "Ask: {question}" / "Kérdés: {question}", accurate only while a chip was a question; it is now "Send: {question}" / "Küldés: {question}" (same key and parameter, both languages in the same commit).

**The check** (`chat-turn/follow-up-chip.ts`, `checkFollowUpChip(text, { language?, maxWords, maxChars? })` -> `{ ok: true, text }` with the normalized chip, or `{ ok: false, reason }`):

| reason | what it rejects (real examples) |
|---|---|
| `offer` | Alfy asking or offering: "Szeretnéd rövidebbre venni?", "Szeretnéd, hogy írok egy listát?", "Írjam le a bemelegítő gyakorlatokat?", "Küldök egy példát a hibára?", "Megnézhetem a kódrészletet?"; English "Would you like me to…", "Shall I…", "Want me to…", "Let me…" |
| `asks_person` | a question to the person or the person's life as "you": "Szeretsz sült krumplit vacsorára?", "Melyik opció a jobb ha sokat autózol?", "Mennyi a kereted?", "What's your budget?", "Do you have a car?"; an instruction to the person ("Ragaszd be a hibás Python kódrészletet", "Paste…"); "your boss" in the person's own mouth ("Írj e-mailt a főnöködnek…") |
| `not_a_request` | a chip without a question mark that is not a request: a statement about the person ("I work in software engineering in Hungary", "I like winter because of snow", "Szoftverfejlesztő vagyok"), which would put an invented fact in their mouth |
| `generic` | nothing named: "Tell me more", "Mondj többet erről", "What else?", "Mi a következő lépés?", "Give me an example", "Mutass egy példát" |
| `language` / `script` | another language than the turn's, judged on words only the other language has (the app's detector reads "Melyik romkocsma a legjobb?" as English): "Can you recommend specific ruin bars?" in a Hungarian turn; "Kell hozzá额外 garancia vagy biztosítás?" (Chinese characters, real) |
| `too_short` / `too_long` / `format` | one word; more than 10 words or 80 characters; a sentence break, markdown, JSON or a list number inside |

It is deliberately permissive about the person addressing Alfy ("Can you draft a packing list?", "Melyik márkát ajánlod?"): that is the person's voice. The prompt steers away from "you" anyway (below) and the measurement counts it.

Changed contract, on purpose: a question mark is no longer required (an imperative is how a person asks), a colon, up to three commas and a Hungarian ordinal's dot ("a 2. lépés") are fine, and the budget is **10 words / 80 characters** instead of 8 words. Reason, measured: the old cap cut "Compare Dean Village and Calton Hill for Sunday morning" (9 words) so an offer-ending reply showed one chip; the median chip is 6 Hungarian and 8 English words, and a Hungarian chip is 47 characters at the median and 58 at the 90th percentile; 7 of 540 candidates were over the new cap.

**The prompt** (`follow-up-suggestions.ts`): a chip is "the NEXT MESSAGE THE USER WOULD SEND to the assistant: tapping it sends its text, exactly as written"; an instruction, or the user's own question about something named in the reply; concrete things the assistant can do in the chat (table, checklist, plan, compare named options, draft the email, example, shorter or more formal version, one step deeper, the advice worked out for a situation the conversation states); it names what it acts on; no offers, no questions to the user, no statements about the user, never answers a question the assistant asked, never states a fact the conversation has not stated; nothing the assistant cannot do in the chat (send, book, buy, call); if the reply ends with an offer the first chip accepts it; avoid "you". Eight examples in the turn's language with eight different verbs (the first five were copied as templates: "Készíts ellenőrzőlistát…" in most sets); `FOLLOW_UP_CHIP_EXAMPLES` is held to the same check by a test. `maxTokens` 120 -> 180. The prompt is about 600 tokens against about 230; the call still takes 1-2 s and no set timed out.

**The existing clarification rule is kept** (`looksLikeClarificationQuestion`: a short reply, at most 300 characters, ending in "?" gets no chips). I looked for a clearly better one: the case that motivated it is a long reply that ends with a list of questions to the person (real: "could you share: what is your current job…"), where the old prompt wrote "answers" in the person's mouth ("I work in software engineering in Hungary"). The new prompt and the `not_a_request` check remove that failure on the real model (0 such chips among 180 sets plus the 60 trap sets, including 12 sets whose reply ends with a question to the person), so skipping those replies would only lose good chips ("Hasonlítsd össze az angol és német előnyeit táblázatban").

**Tests** (red first: on the pristine `b179456b` export the new chip tests fail to import and 57 language assertions fail; the e2e fails on the old accessible name). `follow-up-chip.test.ts` (106 tests): good chips pass and bad ones fail in both languages, the good ones from the real outputs; `follow-up-suggestions.test.ts` (39): the public check, the prompt's wording and examples, the language handed to the check, normalization, the cap; the e2e below. The English offer examples ("Would you like me to…") are the brief's and the shapes the old rule invited, not model output: the model never wrote one in about 1,500 candidates.

## Step 2: "angolul" only as a request

`language.ts` `detectExplicitLanguageRequest` (the first check of `resolveResponseLanguage`) no longer takes the word anywhere as a request. Per sentence, accents folded: a sentence that opens with a question word (how, what, which; hogy, mit, melyik) requests nothing; otherwise the language word is a request when a directive about the reply (answer, write, speak, talk, explain, summarize; válaszolj, írd, beszéljünk, magyarázd, foglald össze, the polite conditional/"may" forms, "tudnál angolul válaszolni?") stands within seven words of it (an instruction that opens the sentence reaches twenty: "Írj egy rövid köszönő e-mailt a vendéglátónknak angolul"), or "please / kérlek / légy szíves / legyen / only" is right beside it, or the sentence is little more than the language word ("In English, please." / "Angolul."). Translate / fordítsd, learn / tanulni, mean / jelent and "can you speak" never flip it; a language that is the subject (learning, translating) also blocks the far reach and "hogyan lehet … megtanulni angolul" ("lehet angolul"). The latest request in a message wins. `classifyLanguageSignal` ignores a quoted word ("What does 'szia' mean in Hungarian?" is English): the English side of the trap needed it.

Tests (`language.test.ts`, 188; the existing W0-D cases all stay green): about 70 request shapes and 54 mention shapes across Hungarian->English, Hungarian->Hungarian, English->Hungarian, English->English, including the owner's "Hogy mondják angolul, hogy alma?" and its English mirror, plus end-to-end `resolveResponseLanguage` cases. A sentence-level context is read once so a long text with many language words stays linear.

## Step 3: before / after on the real model

Method. The app's own functions through the tunnel: `generateFollowUpSuggestions` for the chips and `resolveResponseLanguage` for the traps. **Before = the exported tree `b179456b`; after = the final tree** (the chip prompt is the one measured at `74328d45`; the check after it was replayed over the model's stored raw candidates, which is exactly what the final tree would show, so nothing was re-measured against a prompt that no longer exists). Three corpora; the first two are 3 samples of each of 26 conversations (20 Hungarian, 6 English), so **78 chip sets per arm and corpus**: the captured conversations as SMP-2 left them (short replies); the same user messages with **real replies written by the real model** (`replies-real.json`, 1,000-3,500 characters, what the owner actually sees); and 8 replies written to end in an offer or a question to the person (3 samples each: 24 sets). Labels are mine: every distinct chip was shuffled with the arm hidden and judged on a fixed rubric; the arm still shows through the style, so read the 15 sets below as well as the numbers. Rubric: **voice** = reads as the person writing to Alfy (fails: Alfy offering, a question to the person or about the person's life as "you", a statement of the person's facts, an instruction to the person, third person); **actionable** = asks Alfy for a deliverable or an operation (table, checklist, plan, list, example, code, draft, rewrite, compare, calculate, step by step) — shown as "does something"; the second column adds explanations, how-tos and recommendations (go deeper on a named point), and a yes/no question or a request with its input missing is neither; **specific** = names a domain thing (not "this", "it", "an example", "a brand"); **language** = the conversation's. Wilson 95% intervals are in `labelscore.py` output; they are about +-6 points at n~155.

| corpus | arm | chip sets | sets with no chip | chips | in the person's voice | actionable (does something) | actionable (incl. go deeper) | specific | right language | all four (strict) | addresses "you" |
|---|---|---|---|---|---|---|---|---|---|---|---|
| captured replies (26 conversations x 3) | before | 78 | 0 | 155 | 152/155 (98%) | 13/155 (8%) | 134/155 (86%) | 124/155 (80%) | 151/155 (97%) | 12/155 (8%) | 39/155 (25%) |
|  | after | 78 | 0 | 156 | 156/156 (100%) | 121/156 (78%) | 156/156 (100%) | 154/156 (99%) | 156/156 (100%) | 119/156 (76%) | 0/156 (0%) |
| real Alfy-style replies (same 26 x 3) | before | 78 | 2 | 151 | 148/151 (98%) | 15/151 (10%) | 128/151 (85%) | 118/151 (78%) | 145/151 (96%) | 13/151 (9%) | 30/151 (20%) |
|  | after | 78 | 0 | 156 | 156/156 (100%) | 125/156 (80%) | 156/156 (100%) | 152/156 (97%) | 156/156 (100%) | 122/156 (78%) | 3/156 (2%) |
| replies that end in an offer or a question (8 x 3) | before | 24 | 6 | 34 | 33/34 (97%) | 9/34 (26%) | 31/34 (91%) | 27/34 (79%) | 34/34 (100%) | 8/34 (24%) | 11/34 (32%) |
|  | after | 24 | 0 | 47 | 47/47 (100%) | 38/47 (81%) | 47/47 (100%) | 46/47 (98%) | 47/47 (100%) | 37/47 (79%) | 0/47 (0%) |

What the rows say, honestly:
- By the strict reading of "voice" the old chips were already 97-98% fine: Alfy offering or asking the person was rare (3 of 155 captured, 3 of 151 real), because the old prompt already said "addressed to the assistant". What the owner sees as "worded to the wrong party" shows in the last column: a quarter of the old chips talk to "you" (Megírod az e-mailt? Segítesz…? Ajánlod…?), which reads as Alfy's words under Alfy's reply; and in the real wrong-party ones: "Melyik szakon tanulok?", "Melyik napra kell bevásárlólista?", "Mennyi ideig kellene futnia?", "Hogyan tanuld meg gyorsan?", "Melyik opció a jobb ha sokat autózol?". After: 0-2% address "you".
- The big move is **actionable**: 8-10% -> 78-81% of the chips ask Alfy to do something, 100% a concrete next step (the old chips were mostly "which brand", "where do I book", "do I need" questions).
- The old rule dropped the good chips: 2 of 78 real-reply sets and 6 of 24 offer-ending sets showed no chip at all (the model wrote "Draft a short script for me" and the "?" rule threw it away); after: none.
- The after rows' voice and language are partly by construction (the check), which is why the model's raw candidates matter: of 540 candidates the check rejected 12 (7 over the cap, 2 statements, 2 to-the-person, 1 two sentences).
- Residual after: 4 of 156 real, 2 of 156 captured and 1 of 47 offer-ending chips name something only by "it/this/the version" (specific = 97-99%), and 7 of the 359 shown chips (5 of 156 real) put an example number in the person's mouth ("Calculate my target using 70kg and weight training", "… 500 ezer forintos fizetésből": the reply's example, not the user's fact; the old arm did it too, "if I weigh 70 kg"). The prompt forbids it; the check cannot see it.
- The 15 sets below: the first rep of every even-numbered conversation of the real-reply corpus (0, 2, … 24 = 13 sets: 10 Hungarian, 3 English) plus the two offer-ending conversations 1 (Hungarian) and 4 (English). No selection by outcome.

| # | the user's message | before (what the person saw) | after |
|---|---|---|---|
| 1 | Szia! Segítenél összeállítani egy heti étrendet, ami olcsó és gyorsan elkészíthető? (hu) | `Melyik napra kell bevásárlólista?`<br>`Van vegetáriánus verzió is?` | `Készíts bevásárlólistát a heti étrendhez`<br>`Írd le pontosan a lencseleves receptjét` |
| 2 | A Python kódom azt írja, hogy 'list index out of range', mit rontok el? (hu) | `Bemásolom a kódot ide?`<br>`Hogyan használjam a try except?` | `Készíts ellenőrzőlistát a lista indexelési hibákhoz`<br>`Magyarázd el részletesebben a hibás ciklus megoldását` |
| 3 | Kezdő vagyok, kérek egy négyhetes futóedzéstervet! (hu) | `Milyen cipőt ajánlasz kezdőknek?`<br>`Mi a teendő ha fájni kezd a térdem?` | `Készíts táblázatot a négyhetes edzésterv napjairól`<br>`Magyarázd el a csípőhajlító nyújtás helyes kivitelezését` |
| 4 | Hogyan tanuljak meg gyorsan angolul, ha csak napi húsz percem van? (hu) | `Which free apps do you recommend for beginners?`<br>`How do I practice speaking without a partner?` | `Készíts heti tervet az angol tanulásra`<br>`Hasonlítsd össze az Ankit és a Duolingót` |
| 5 | Hogyan kell kitölteni az szja bevallást, ha egész évben egy munkahelyem volt? (hu) | `Hol tölthetem ki az eSZJA-t online?`<br>`Mik a határidők a bevallás benyújtására?` | `Készíts ellenőrzőlistát a munkáltatói igazolás adataihoz`<br>`Magyarázd el pontosan a családi kedvezmény kitöltését` |
| 6 | Hogyan állíthatom be a git-ben, hogy minden commit előtt lefusson a lint? (hu) | `Hogyan kerülhetem el a hookot commitnál?`<br>`Működik ez a Husky a CI környezetben is?` | `Magyarázd el részletesebben a lint-staged beállítását`<br>`Hasonlítsd össze a Husky és a natív git hook megoldást` |
| 7 | Mit jelent az, hogy 'eventual consistency' az adatbázisoknál? (hu) | `Hogyan kezeld az adatütközéseket a gyakorlatban?`<br>`Mikor érdemes erősebb konzisztenciát választani?` | `Magyarázd el részletesebben a CAP-tételt és a választást`<br>`Készíts ellenőrzőlistát a konzisztencia szintjeiről` |
| 8 | Fáj a hátam az ülőmunkától, mit csináljak? (hu) | `Küldesz képeket a nyújtó gyakorlatokról?`<br>`Milyen irodai széket ajánlasz deréktámasszal?` | `Készíts napi nyújtásos rutin listát a munkaidőhöz`<br>`Írd össze az ergonomikus íróasztal beállításainak ellenőrzőlistáját` |
| 9 | Írj egy rövid köszönő e-mailt a vendéglátónknak a hétvégi vacsoráért (hu) | `Megírod az e-mailt?`<br>`Hogyan testre szabjam a nevekkel?` | `Hogyan tegyem személyesebbé a szöveget?`<br>`Készíts egy hivatalosabb változatot` |
| 10 | Hogyan lehet gyorsabban megtanulni gépelni tíz ujjal? (hu) | `Melyik appot ajánlod kezdőknek?`<br>`Mennyi idő alatt tanulhatom meg?` | `Készíts napi gyakorlótervet a tízujjas gépeléshez`<br>`Hasonlítsd össze a Keybr és TypingClub előnyeit` |
| 11 | What's the best way to learn SQL joins? (en) | `Can you provide a practice dataset?`<br>`What are good SQL practice sites?` | `Create a table comparing all five join types`<br>`List the Day 1-2 learning steps in a checklist` |
| 12 | Can you explain what a mutex is? (en) | `Show code for preventing deadlocks?`<br>`Compare mutex with semaphore?` | `Show a deadlock example with two mutexes`<br>`Compare mutex and semaphore in a table` |
| 13 | How much protein do I need per day? (en) | `What are good high protein meals?`<br>`How much protein is too much?` | `Calculate my target using 70kg and weight training`<br>`List high-protein foods for a 150g daily goal` |
| 14 | Mit tegyek, ha a főnököm túl sok feladatot ad? (hu) *(reply ends with an offer or a question)* | `Segítesz megfogalmazni a megbeszélés kérését?` | `Készíts listát a feladatokról határidőkkel`<br>`Hogyan kérjek írásos prioritási sorrendet?` |
| 15 | Help me plan a weekend trip to Edinburgh. (en) *(reply ends with an offer or a question)* | `Where should I stay near the Old Town?`<br>`What is the weather like in Edinburgh?` | `Turn this into a day-by-day itinerary with times`<br>`Compare Arthur's Seat and Calton Hill for sunset` |

**The "angolul" traps** (20 prompts x 3 samples: the real `resolveResponseLanguage`, then a real chat reply written under the app's own response-language guard text — copied verbatim, since importing `normal-chat-context.ts` pulls the DB — thinking off, chat sampling). "Turn language right" is what `resolveResponseLanguage` returned; "reply" is read by me.

| prompt | wanted | turn language right, before | after | reply in the wanted language, before | after |
|---|---|---|---|---|---|
| Hogy mondják angolul, hogy alma? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Mit jelent angolul az, hogy 'serendipity'? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Hogyan tanuljak meg gyorsan angolul, ha csak napi húsz percem van? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Fordítsd le angolra: jó reggelt kívánok! | Hungarian | 3/3 | 3/3 | 3/3 | 3/3 |
| Fordítsd le angolul, hogy 'köszönöm a segítséget'. | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Hogyan írjam le angolul, hogy 'sajnálom a késést'? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Melyik jobb a munkámhoz: angolul vagy németül tanulni? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Szeretnék angolul tanulni, hol kezdjem? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Hogy hívják angolul a rántottát? | Hungarian | 0/3 | 3/3 | 0/3 | 3/3 |
| Hogy mondják magyarul, hogy 'serendipity'? | Hungarian | 3/3 | 3/3 | 3/3 | 3/3 |
| **request** Válaszolj angolul, kérlek: mit érdemes megnéznem Bécsben egy hétvégén? | English | 3/3 | 3/3 | 3/3 | 3/3 |
| **request** Beszéljünk angolul, szeretnék gyakorolni. Mesélj a kedvenc évszakodról! | English | 3/3 | 3/3 | 3/3 | 3/3 |
| **request** Írj egy rövid köszönő e-mailt a vendéglátónknak angolul. | English | 3/3 | 3/3 | 3/3 | 3/3 |
| **request** Angolul válaszolj: mi az a mutex? | English | 3/3 | 3/3 | 3/3 | 3/3 |
| How do you say 'apple' in Hungarian? | English | 0/3 | 3/3 | 0/3 | 3/3 |
| What does 'szia' mean in Hungarian? | English | 0/3 | 3/3 | 0/3 | 3/3 |
| Translate 'good morning' into Hungarian. | English | 3/3 | 3/3 | 3/3 | 3/3 |
| What is the word for 'cozy' in Hungarian? | English | 0/3 | 3/3 | 0/3 | 3/3 |
| **request** Please answer in Hungarian: what is a mutex? | Hungarian | 3/3 | 3/3 | 3/3 | 3/3 |
| **request** Can you explain what a hash map is in Hungarian please? | Hungarian | 3/3 | 3/3 | 3/3 | 3/3 |
| **mention prompts, total** | | 9/42 (21%) | 42/42 (100%) | 9/42 (21%) | 42/42 (100%) |
| **request prompts, total** | | 18/18 (100%) | 18/18 (100%) | 18/18 (100%) | 18/18 (100%) |

Mention prompts: the turn language was wrong for 33 of 42 before (all 8 Hungarian "angolul" mentions and 3 of the 4 English "in Hungarian" ones; "angolra" and "magyarul" were right, the second by luck) and for none after; the replies followed (9 of 42 right before, 42 of 42 after: "The word alma translates to apple in English." became "Az „alma” angolul **apple**."; "Az alma." to "The word for 'apple' in Hungarian is **alma**."). The requests, including "Írj egy rövid köszönő e-mailt a vendéglátónknak angolul", still flip (the first run of the narrowed rule flipped 15 of 18: that email request stood eight words from its language word, which is why an instruction that opens the sentence now reaches twenty).

Title side effect (the app's own `generateTitle`, 5 samples each, `title-*.json`): "Hogyan tanuljak meg gyorsan angolul…" 3 of 5 titles fell back on the language-parity check and the other two were English before, 0 of 5 after (Hungarian titles); "How do you say 'apple' in Hungarian?" 5 of 5 fallbacks before, 0 of 5 after (English titles). "Hogy mondják angolul, hogy alma?" had 4 English titles of 5 before and now gets Hungarian ones, which the parity check still rejects 3 of 5 times when they have no accent and fewer than two function words ("Alma angolul fordítása"; the fallback is the question itself): SMP-2's concern 1, not touched.

## Gates (once, on the final tree)

1. `npm run check`: **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1: the baseline).
2. `npx biome check src scripts tests`: clean (2,449 files).
3. `npm test`: **1,003 files passed (1 skipped); 16,298 tests passed, 2 skipped** (SMP-2: 16,053; +245 here). The full run had one failure, a literal `"Ask: What about risks?"` in `page-runtime.test.ts` that the new accessible name broke (the MessageBubble tests read the name from the dictionary and did not see it); fixed in its own commit and that file re-run alone (78 passed).
4. `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (baseline). `npm run check:artifact-chunks` (own step): **exit 0**; CanvasEditor closure 69.6 kB gzip; chat route 538,524 B gzip, +1,641 against the 536,883 baseline (2,048 allowed; SMP-2 measured +1,624, my only client change is two i18n strings).
5. Playwright on port 5450 (`artifact*`, `artifacts-*`, `knowledge`, `chat`, `conversation`, `streaming` and the new `follow-up-chips`): **455 passed, 23 skipped, 1 failed** (38.3 min; 479 tests = SMP-2's 476 + my 3). The one failure is `artifact-canvas-charts.spec.ts:606`, the first chart case of its file, "canvas-save-status expected /Saved/ within 10 s, received empty" (a cold start in a suite I did not touch); the file re-run alone: 25 passed, 4 skipped, 0 failed. `chat`, `conversation`, `streaming` and `follow-up-chips` pass.
6. Fallow: **124 issues / 4 circular, identical to the baseline; 0 new** (`chp-gates/fallow-final.json`; an early run on an intermediate tree was identical too).
7. `npm run check:migrations`: passes unchanged.

The last commit changes a comment only, re-checked with biome and the language test. Logs: `…/scratchpad/w4/chp-gates/`.

## Deviations and concerns

1. **The word cap moved 8 -> 10 words and 80 characters** (reason and numbers in Step 1). It is one constant (`FOLLOW_UP_SUGGESTIONS_MAX_WORDS`) and the char budget; say if the owner wants chips shorter.
2. **Labels are mine and not blind to style.** The rubric is in the report, the labels are in `chp-probe/labels/`, and the 15 sets are rule-selected. The strict "does something" share depends on where explanations sit: counting them gives 100% for the after arm.
3. **An example number can become the person's fact** (7 of 359 shown after chips; the old chips did it too). A prompt follow-up, not a check.
4. **Hungarian slips the check cannot see** ("Írj lista a…", "Részleteszd", "Formázd meg hivatalosabb hangnemben"): a few per cent of the Hungarian chips; the model's grammar, as before.
5. **The explicit-request rule is two regex lists, not a parser.** Known misses: "Mondd el angolul" and "I prefer English" do not flip (a directive is needed), a directive far from the language word in a sentence that does not open with it does not reach. `language.ts` grew by about 400 lines, mostly the word lists.
6. **`classifyLanguageSignal` ignores quoted words for every caller** (a message that is only a quote is still read; 3 tests). Small, global, deliberate.
7. The English rows of the check's "offer" tests are not model output (see Step 1).
8. **Monotony and the cap.** Hungarian chips lean on "Készíts…" (96 of 312 after chips, 31%; the old arm leaned on Melyik/Milyen/Hogyan, 45%), though no set has two chips with the same first word (0 of 156 against 6 of 152 before). One of the 44 long-reply trap sets showed no chip because all three candidates ran 11-12 words (the 10-word cap).
9. Playwright: one failure in a suite I did not touch (`artifact-canvas-charts.spec.ts:606`, a cold-start timing miss), green when re-run alone (item 5 above). The orchestrator's known flake `artifact-canvas-undo.spec.ts:418` (ca145566) passed in this run; not investigated.

## Hand-off

- `chat-turn/follow-up-chip.ts`: `checkFollowUpChip`, `FollowUpChipRejection`; extend its patterns from real model output with a test both ways. `follow-up-suggestions.ts`: `isPlausibleFollowUpSuggestion(text, language?)`, `FOLLOW_UP_CHIP_EXAMPLES`, the prompt; `parseFollowUpSuggestions` persists the normalized chip.
- `language.ts`: `detectExplicitLanguageRequest` (the only place a language word becomes a request), `classifyLanguageSignal` (quoted spans).
- `tests/e2e/follow-up-chips.spec.ts`; `buildAiSdkUiStreamBody(text, metadata?)` in `tests/e2e/helpers.ts` feeds a terminal metadata frame.
- Re-measure: `chp-probe/run-live.sh <tag> CHP_MODES=chips,real,stress,trap` with `WT=<tree>` (a `git archive` export is safest), `replay.test.ts.txt` for a changed check over stored candidates, `scorekeyed.py` for labelled numbers (new chips go in `labels/extra.json`).
- AGENTS.md has the one new rule (chip + explicit request).
