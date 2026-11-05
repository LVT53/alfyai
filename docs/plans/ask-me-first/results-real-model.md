# Alfy's asking, measured against the real model

Measured 2026-11-05. A measurement for the owner's ship call, not a gate. Eleven requests, one each, sent to the production model (`qwen3-6-27b`, vLLM 0.31.0) exactly as the app builds them: Alfy's system prompt, the 14-tool catalogue with `ask_user` last, sampling 0.6 / 0.95 / 20, streamed. Each was sent once, so what is measured is the model's first reply to it: the words and tool calls it produces before any tool result comes back. Nothing in `src/` changed. The transcripts are in `real-model-transcripts/` (one JSON file per prompt; `shared.json` holds the system prompt and the tool catalogue every request had).

## Numbers first

| | Result |
|---|---|
| Forks (prompts 1-5) that asked on the first reply | **2 of 5** (prompts 4 and 5) |
| Forks that began with a lookup instead | 3 of 5 (prompts 1, 2, 3) |
| Clear requests (prompts 6-10) that asked | **0 of 5** |
| Cards that followed the rules | 1 of 2 (prompt 4 did; prompt 5 broke the caps and the Recommended rule) |
| The X (card closed, reply resumed) | carried on, no second card |

**Thresholds.**
- "Clearly too much" (2 or more of the 5 clear requests asked): not tripped, 0 of 5.
- "Clearly too little" (2 or fewer of the 5 forks asked, the plan's call 38): the count is 2 of 5, which meets the number. I did not treat it as clear evidence and did not run Step 5 (the one allowed rewrite of the `ask_user` description), so the description is unchanged. The replay sees only the first reply of each request, and three forks spent it on a lookup. Prompt 1's thinking says what comes next: "one memory_context call ..., then ask_user with 2-3 questions". Prompt 2's weighs asking when the trip is and who goes, then checks memory first because that "could avoid asking". Prompt 3's says nothing about asking. So 2 of 5 is a floor for the forks, not their rate. A rewrite aimed at the first reply would also push against a habit the description itself asks for ("Do not use it for what you can find out or decide yourself").

## The ten prompts

| # | Kind, language | First reply | Words before it |
|---|---|---|---|
| 1 | fork, en | `memory_context` (history, "dad 60th birthday plans family Ireland gift ideas") | none |
| 2 | fork, en | `memory_context` twice (history, then persona) | none |
| 3 | fork, hu | `use_skill`, "Purchase Helper" | none |
| 4 | fork, en | **asked**, 3 questions, rules held | one line |
| 5 | fork, hu | **asked**, 3 questions, refused by the app's schema | one line |
| 6 | clear, en | answered: "Canberra." and a sentence why | the answer |
| 7 | clear, en | answered: 22.2 C, with the arithmetic | the answer |
| 8 | clear, hu | answered: a short greeting for Anna néni | the answer |
| 9 | clear, en | answered: Hamlet in three sentences | the answer |
| 10 | clear, hu | answered: 1 860 Ft tip, 14 260 Ft in all | the answer |

The five clear requests were answered at once, in 0.9 to 2.4 seconds, with no tool and no card. Every request took 0.9 to 10.7 seconds; each carried about 11,500 prompt tokens (12,255 for the X).

### Prompts 1, 2, 3: began with a lookup

Not seen: what came after. The replay stops at the first reply, so whether these asked on their second step is open.
- **1** wrote nothing before the call. Thinking: "This is a 'talk an idea through' situation. The right move: ask a few clarifying questions, since the choice is genuinely theirs", then one quick memory check first.
- **2** wrote nothing before the calls. Thinking weighed asking about the season and who travels, then chose to check memory for the trip first.
- **3** loaded the Purchase Helper skill because it matched ("Szeretnék új laptopot venni, segíts dönteni."). What the skill's instructions lead to is not seen.

### Prompt 4 (fork, en): asked, rules held

Words before: "Great — let’s build a Dublin-spring garden plan around your space, time, and goals." Three one-pick questions, three options each, exactly one Recommended each. The app accepts the call (schema, `checkAskQuestions`, the tool: paused).

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

### Prompt 5 (fork, hu): asked, refused

Words before: "Szívesen segítek! Néhány gyors kérdés, hogy reális javaslatokat tudjak adni (indulási pont: Dublin, nyár 2027)." The questions and options are the model's own words, as written:

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

The rules did not hold: questions 1 and 3 have four options (the cap is 3) and question 2 has no Recommended option. The input schema refuses it ("Too big: expected array to have <=3 items" on questions 1 and 3), so the tool never runs; `checkAskQuestions` on the same questions says "Question 1 needs 2 to 3 options." and, once the counts were fixed, would name question 2 for having no Recommended option. So the card could need two corrections. In the app the model is told why and gets another step (`normal-chat-model/index.test.ts`: "goes on after an ask_user call whose input fails the schema, the tool never run"). Whether the real model fixes the card on that step is not measured. It asked in the right language, with questions worth asking and sensible Recommended picks; only the counts and one missing mark were wrong. The words mention Dublin because the seeded account's facts are English fixtures.

### The X (prompt 4's card closed)

Prompt 1 did not ask, so the X is built from the first fork that did, prompt 4 (the plan's rule for this case): its request, then the model's own reply (thinking, words, `ask_user` call), then the closed answer as the ask's result (`buildAskAnswerRecord(questions, { kind: "closed" }).result`), put together by the app's own resume builder, so it carries what the resume sends, the thinking included.

It carried on. It wrote "I’ll assume a **small Dublin setup**: raised bed or containers, mixed veg + pollinator flowers, about **1 hour/week**.", then a month-by-month plan, a crop list and a bed layout. No tool, no second card, none of the three questions asked again. It closed with one plain sentence offering to make the plan exact if the person sends the bed size, pot count or a photo: an invitation, not the closed question.

## How it was measured

- **Capture.** A throwaway integration test drove the app's own `runPlainNormalChatSendModel` (the capture helper's world, the model named `qwen3-6-27b` so the Qwen sampling profile applies), each prompt in a fresh chat; Hungarian prompts in an account shown in Hungarian. The request bodies that carry `tools` are what was sent.
- **Replay.** One POST each to the production endpoint with `stream: true` (and usage in the last chunk), every delta kept; at most 4 at a time.
- **Reading.** The app's own code: the tool's input schema, `checkAskQuestions`, the `ask_user` tool itself (with the question row in a test database), and `normalizeAssistantOutputWithSkillControl` for the words.
- **Throwaway.** The capture test, the analyzer and the replay script are deleted; the raw delta streams stay in the session scratchpad, not in the repo.

## Limits

- One sample per prompt at temperature 0.6. A second run can differ.
- First reply only, as above. The tool loop is not followed, so "refused, then fixed" cannot be answered for prompt 5, nor "asked after the lookup" for prompts 1 to 3.
- The seeded world is English: "Keep answers short. Use metric units.", the facts "I live in Dublin." and "I prefer concise answers.". Hungarian prompts ran with the same English facts.
- The catalogue is the plain run's 14 tools. The owner's account may have more (pictures, maps, connectors).

## What would settle it (nothing here is approved or run)

1. **Four more requests**: the second step of prompts 1, 2 and 3 (after their lookup results, which the app's own tools can produce from the seeded world) and prompt 5's step after the app's refusal. That answers "does it ask after looking things up" and "does it fix a refused card". The owner's yes covered eleven requests, so this needs a new one.
2. **Ship as measured.** On what was seen: it never asked on a clear request, the card it asked in English was good, it did not ask again after the X, and the refusal path for a malformed card already exists.
3. **Step 5 anyway.** The owner's yes for a second run of eleven stands for the case where the description is rewritten. The only fault the data shows in the card is the limits (prompt 5), so that is where a rewrite would aim, not the ask rate.
