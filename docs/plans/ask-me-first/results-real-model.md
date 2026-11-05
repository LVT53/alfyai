# Alfy's asking, measured against the real model

**Bottom line:** over the whole reply Alfy asked at 5 of 5 forks and at 0 of 5 clear requests, but the app would have turned back 4 of the 6 cards it wrote, all 3 of the Hungarian ones, for breaking the card's own limits.

Measured 2026-11-05 on the production model (`qwen3-6-27b`, vLLM 0.31.0). A measurement for the owner's ship call, not a gate; nothing in `src/` changed. Two rounds, 15 requests in all:
- The first reply to the ten fixed prompts, and the X (11 requests).
- The second step of the four replies that began with a tool call or a refused card (4 requests: prompts 1, 2, 3 and 5).

Each request is the app's own: Alfy's system prompt, the 14-tool catalogue with `ask_user` last, sampling 0.6 / 0.95 / 20, streamed. The transcripts are in `real-model-transcripts/`: `prompt-NN.json` for a first step, `prompt-NN-step2.json` for a second step, and `shared.json` for the system prompt and the tool catalogue every request had.

## Numbers first

| | Result |
|---|---|
| Forks that asked, over the whole reply | **5 of 5**: English 3 of 3 (prompts 1, 2, 4), Hungarian 2 of 2 (prompts 3, 5) |
| The same on the first step alone | 2 of 5 (prompts 4 and 5) |
| Clear requests (prompts 6-10) that asked | **0 of 5** |
| Cards the app accepts at once | **2 of 6**: English 2 of 3 (prompts 2 and 4), Hungarian 0 of 3 |
| The Hungarian card after the refusal (prompt 5) | **not fixed**: the counts are right now, question 2 still has no Recommended option, and the app refuses it again |
| The X (card closed) | carried on, no second card |

**Thresholds.**
- Too much (2 or more of the 5 clear requests asked): not tripped, 0 of 5.
- Too little (2 or fewer of the 5 forks asked): not tripped over the whole reply, 5 of 5. It looked tripped on the first step alone (2 of 5) because three forks began with a tool call and asked on the next step.
- Step 5 did not run, and the `ask_user` description is unchanged.

"Asked" counts a card the app refuses, as the plan does. The person sees the words of each step, and a card only once the app accepts one. A refused card costs one more model step before any card appears (a step took 4 to 7 seconds here).

**The six cards at a glance** (the Recommended rule: exactly one on a question that takes one pick; the cap: 2 to 3 options).

| Card | Options per question | Recommended per question | The app |
|---|---|---|---|
| Prompt 1, step 2 (en) | 4, 3, 3 | 1, 0, 0 | refused by the schema |
| Prompt 2, step 2 (en) | 3, 3 | 1, 1 | accepted |
| Prompt 4, step 1 (en) | 3, 3, 3 | 1, 1, 1 | accepted |
| Prompt 3, step 2 (hu) | 4, 4, 4 | 0 (several picks allowed), 1, 0 | refused by the schema |
| Prompt 5, step 1 (hu) | 4, 3, 4 | 1, 0, 1 | refused by the schema |
| Prompt 5, step 2 (hu) | 3, 3, 3 | 1, 0, 1 | refused by the tool |

## The five forks, over the whole reply

### English forks (prompts 1, 2, 4)

**Prompt 1** (dad's 60th)
- Step 1: no words. One `memory_context` call (history); it found nothing.
- Step 2: asked. Words: "Happy to help shape it. March 2027 is ~4½ months out — enough lead time for anything from a booked venue to a trip, so the first thing worth deciding is the *shape* of the day, not the details." Then a card of 3 questions.
- The app refuses the card: question 1 has four options (the cap is 3), and questions 2 and 3 have no Recommended option. The thinking states the limit ("Keep to 3 questions max, 2-3 options each") and the card still breaks it, which looks like a slip in execution rather than a gap in the wording.

**Prompt 2** (packing list PDF)
- Step 1: no words. Two `memory_context` calls: history found nothing, persona returned the seeded summary and facts (Dublin, a kitchen renovation).
- Its first-step hesitation comes from the system prompt (`shared.json`), not the tool description: the thinking cites it ("The mission says ask only when missing detail materially changes the answer.", then "prefer action over process"), and the prompt also says to use "memory_context proactively for preferences or project context"; part of the lever is outside the tool's description.
- Step 2: asked. Words: "No trip details in memory, so two quick questions before I build it — the season changes the list completely." A card of 2 questions, rules held; the app accepts it.

**Prompt 4** (garden)
- Step 1, where the reply pauses: asked. Words: "Great — let’s build a Dublin-spring garden plan around your space, time, and goals." A card of 3 questions, rules held; the app accepts it.
- Questions 2 and 3 ("How much space are you working with?", "How much time can you realistically spend each week?") are fact questions about the person, where the one-Recommended rule makes the model guess. That is a design rule, not a fault.

### Hungarian forks (prompts 3, 5)

**Prompt 3** (laptop)
- Step 1: no words. It loaded the Purchase Helper skill with `use_skill`, which is not a lookup. The skill's instructions say to identify the budget, must-haves and dealbreakers "already stated", to research current prices and to end with a comparison table and a clear call; nothing in them says to ask.
- Step 2: asked at once, with no words. Thinking: "The missing details materially change the answer." and "Better to ask first, since laptop recommendations without budget/use case are meaningless."
- The app refuses the card: all three questions have four options (the cap is 3), and question 3 has no Recommended option. The thinking never mentions the limits. One note makes no sense: the gaming option reads "Játék: Előnytelen GPU" (a disadvantageous GPU).

**Prompt 5** (summer holiday)
- Step 1: asked. Words: "Szívesen segítek! Néhány gyors kérdés, hogy reális javaslatokat tudjak adni (indulási pont: Dublin, nyár 2027)." A card of 3 questions. The app refuses it: questions 1 and 3 have four options, and question 2 has no Recommended option. The thinking never mentions the limits, which looks like a slip in execution rather than a gap in the wording.
- The card's wording is not clean either. Question 3 ("Kikkel utaztok és meddig?") asks two things in one question, who travels and for how long. Its fourth option, "Hosszabb, 2 hét", carries the note "Egy-két fő" (one or two people), which fits neither. Question 2 presumes 7 nights ("7 éjszakára").
- Step 2, after the refusal: the model was handed the schema's error, which names questions 1 and 3 as "Too big: expected array to have <=3 items". Thinking: "I need to cap the number of options at 3." It asked again with a second card (below). The schema accepts it, but the tool refuses it: "Question 2 takes one pick: mark exactly one of its options recommended."
- So the card was **not fixed in one step**. The mark is checked only after the counts pass, so a card that breaks both is refused twice. A third step would be needed; it was not run.

## The clear requests (prompts 6-10)

All five were answered at once, in 0.9 to 2.4 seconds, with no tool and no card.
- **6** "What is the capital of Australia?": "Canberra." and one sentence on why.
- **7** "Convert 72 Fahrenheit to Celsius.": 22.2 C, with the arithmetic.
- **8** (hu) "Írj egy rövid születésnapi üdvözletet Anna néninek.": a short greeting.
- **9** "Summarize the plot of Hamlet in three sentences.": three sentences.
- **10** (hu) "Mennyi 15% borravaló egy 12 400 forintos számlára?": 1 860 Ft tip, 14 260 Ft in all.

## The X (prompt 4's card closed)

- Prompt 1 did not ask, so the X comes from the first fork that did, prompt 4 (Controller Ruling 38). It is prompt 4's request, then the model's own reply (thinking, words, `ask_user` call), then the closed answer as the ask's result (`buildAskAnswerRecord(questions, { kind: "closed" }).result`), put together by the app's own resume builder, so it carries what the resume sends, the thinking included.
- It carried on. It wrote "I’ll assume a **small Dublin setup**: raised bed or containers, mixed veg + pollinator flowers, about **1 hour/week**.", then a month-by-month plan, a crop list and a bed layout.
- No tool, no second card, none of the three questions asked again.
- It closed with one plain sentence offering to make the plan exact if the person sends the bed size, pot count or a photo: an invitation, not the closed question.

## The cards as written

Recommended marks and notes are the model's own. The Hungarian cards are quoted as written, slips included.

**Prompt 1, step 2: refused** (question 1 has four options; questions 2 and 3 have no Recommended option)

1. What should the centrepiece of the day be?
   - A gathering (Recommended): Guests, food, toasts — the party is the gift.
   - An experience for him: Something he'd never book himself: trip, track day, tickets, workshop.
   - Something personal: Heirloom-quality gift, film, book of messages, surprise from far-away people.
   - Not sure yet: Help me weigh the options.
2. Roughly what are you happy to spend?
   - Up to €500: Thoughtful, mostly effort-led.
   - €500–€2,000: Venue, catering, or a short trip.
   - €2,000–€6,000+: Big weekend, travel, or several people pooling.
3. Who's coming, and where?
   - Dublin, family + friends: Local venue, 20–60 people.
   - Smaller, close family: Under ~12, anywhere in Ireland.
   - Trip with him: Just the two of you or a small group abroad.

**Prompt 2, step 2: accepted**

1. When is the Vienna weekend?
   - This month (Nov) (Recommended): Typical 1–8 °C, damp, short days
   - December: Christmas markets, typical -2 to 3 °C
   - Spring/summer: Warm days, possible heatwaves
2. Who's packing?
   - 2 adults + 2 kids (Recommended)
   - 2 adults + 1 kid
   - 2 adults only

**Prompt 4, step 1: accepted**

1. What should next spring’s garden focus on?
   - Mixed veg + flowers (Recommended): Productive, colourful, and beginner-friendly
   - Vegetables/herbs: Maximum edible yield
   - Flowers/pollinators: Low fuss, bees and butterflies
2. How much space are you working with?
   - Containers/patio: Pots, balcony, small outdoor area
   - Raised beds (Recommended): Neat, controlled, good for vegetables
   - Full garden beds: More planting area and flexibility
3. How much time can you realistically spend each week?
   - Low: 15–30 min: Very low-maintenance choices
   - Medium: 1 hour (Recommended): A good balance for spring planting
   - High: 2+ hours: More crops, succession sowing, care

**Prompt 3, step 2 (hu): refused** (every question has four options; question 3 has no Recommended option)

1. Mire használnád főleg a laptopot?
   - Iroda, böngészés, média: Office, e-mail, videó, könnyű gép
   - Fejlesztés / komolyabb munka: IDE, virtualizáció, nagyobb fájlok
   - Kreatív munka (videó/3D/tervezés): GPU-igényes alkalmazások
   - Játék: Előnytelen GPU
2. Mekkora a keret?
   - 400–700 €
   - 700–1200 € (Recommended): Ár/érték zóna
   - 1200–2000 €
   - 2000 € felett
3. Operációs rendszer és méret?
   - Mindegy: A legjobb gépet nézem
   - Windows, 14" kompakt
   - Windows, 16" nagy kijelző
   - macOS

**Prompt 5, step 1 (hu): refused** (questions 1 and 3 have four options; question 2 has no Recommended option)

1. Milyen típusú nyaralást szeretnétek?
   - Strand + pihenés (Recommended): Meleg, tenger, kevesebb program
   - Városi kultúra: Muzeumok, éttermek, gyaloglás
   - Aktív / természet: Séták, kirándulások, túrázás
   - Még nyitott: Mutass pár opciót típustól függetlenül
2. Mekkora a fejenkénti keret (repülő + szállás, 7 éjszakára)?
   - max 500 €: Költségtudatos, rövid táv
   - 500–1000 €: Középkategória
   - 1000 € felett: Távolabb is mehetünk
3. Kikkel utaztok és meddig?
   - Két felnőtt, 1 hét (Recommended)
   - Család gyerekekkel: 1 hét
   - Barátok / csoport: 1–2 hét
   - Hosszabb, 2 hét: Egy-két fő

**Prompt 5, step 2 (hu): the second card, refused by the tool** ("Question 2 takes one pick: mark exactly one of its options recommended.")

1. Milyen típusú nyaralást szeretnétek?
   - Strand + pihenés (Recommended): Meleg, tenger, kevesebb program
   - Városi kultúra: Muzeumok, éttermek, gyaloglás
   - Aktív / természet: Túrázás, kirándulások
2. Mekkora a fejenkénti keret (repülő + szállás, 7 éjszakára)?
   - max 500 €: Költségtudatos, rövid táv
   - 500–1000 €: Középkategória
   - 1000 € felett: Távolabb is mehetünk
3. Kikkel utaztok és meddig?
   - Két felnőtt, 1 hét (Recommended)
   - Család gyerekekkel: 1 hét
   - Csoport / 2 hét: Barátok vagy hosszabb utazás

## How it was measured

- **First step.** A throwaway integration test drove the app's own `runPlainNormalChatSendModel` (the capture helper's seeded world, the model named `qwen3-6-27b` so the Qwen sampling profile applies), each prompt in a fresh chat, the Hungarian prompts in an account shown in Hungarian. One POST each to the production endpoint with `stream: true` (and usage in the last chunk), every delta kept, at most 4 at a time.
- **Second step (prompts 1, 2, 3, 5).** The same run again, with the fake provider answering step 1 with the real model's recorded reply (its words, its thinking and its tool calls). The plain run asks for one non-streamed completion, so the reply was served as that, not as stream frames. The app then ran the tools for real against the seeded world: `memory_context` and `use_skill` read it, and for prompt 5 the tool's input schema refused the card before the tool ran and the model was handed that error. The request the run then sent for step 2 is what was replayed: the step-1 request as replayed, plus the messages the run appended (the model's reply and the tool results). Four requests, each sent once with `stream: true`.
- **Reading.** The app's own code: the tool's input schema, `checkAskQuestions`, the `ask_user` tool itself (with the question row in a test database), and `normalizeAssistantOutputWithSkillControl` for the words.
- **Throwaway.** The capture tests, the analyzers and the replay script are deleted; the raw delta streams stay in the session scratchpad, not in the repo.

## Limits

- One sample per prompt at temperature 0.6. A second run can differ.
- Two steps at most. How many refusals a card takes before the app accepts it is open beyond prompt 5's second card.
- The lookups ran against the seeded world, where the history is empty. An account with relevant history would give the model more to go on before it asks.
- The requests come from the plain run; production streams. The two were not compared.
- The seeded world is English: "Keep answers short. Use metric units.", and the facts "I live in Dublin." and "I prefer concise answers.". The Hungarian prompts ran with the same English facts, which is why prompt 5's words mention Dublin.
- The catalogue is the plain run's 14 tools. The owner's account may have more (pictures, maps, connectors).

## What is left

- Not measured: the third step of prompts 1, 3 and 5, that is, whether the next refusal ends the loop. Prompt 5's second card suggests the model fixes what the error names and leaves the rest.
- The description is unchanged. Step 5's trigger (2 or fewer of the 5 forks asked) is not met over the whole reply. The cards' limits are outside that trigger; any change to the description would need another run of eleven requests and is a separate decision.
