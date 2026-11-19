# Ask me first on Quick, in Hungarian: measured, fixed, measured again

**Bottom line:** on Quick (thinking off) the card now shows on 96% of English turns and 83% of Hungarian ones, from 63% and 59%, and still never on a plain question or a request with a plain default. The fix is one sentence in the Quick-mode line of the turn guidance. Thorough's requests are unchanged.

Measured 2026-11-17 against the production model (`qwen3-6-27b`, inference.alfycomms.com) with the release code (`read-aloud-release`, `125084bcf` for the first run, `b97b0f465` after: no prompt or tool text differs between them). Made-up prompts only, on an empty test account.

## How it was measured

The method of the 2026-11-10 measurement, rebuilt: a throwaway vitest file runs the app's own plain model run (`runPlainNormalChatSendModel`, `canPause: true`, so `ask_user` checks the card and pauses as the streaming run does) with `reasoningDepth: "quick"`, and sends its model calls to the production model (non-stream, `max_tokens` 3000). Local tools run (`memory_context`, `use_skill`); every other host answers 503. A turn is decided by its first `ask_user` the app accepts (a card shown, on the first try or after the app's refusal and the model's retry), another tool, or written text. Concurrency 4.

Prompts: the nine prompt pairs where asking fits most (trip, laptop, interview, language, party, workout, dog, slides, dinner), six samples each per language; four plain questions (capital, egg, Spanish, heat pump) and four requests with a plain default (a haiku, a pancake recipe, a three-sentence plot summary, what a VPN is), three samples each per language. Each prompt is written in English and in natural Hungarian.

## Numbers

| Quick, card shown (9 prompts x 6) | English | Hungarian |
|---|---|---|
| 2026-11-10 note, `aba3e8fbe` | 74% [61-84] | 54% [41-66] |
| Before, release code | 34/54 = 63% [50-75] | 32/54 = 59% [46-71] |
| After, release code + the fix | 52/54 = 96% [87-99] | 45/54 = 83% [71-91] |

- Plain questions asked: 0/12 per language, before and after. Requests with a plain default asked: 0/12 per language, before and after.
- No card was lost to a refusal, before or after: every refused card (mostly a missing Recommended mark) was fixed on the retry. Every Hungarian card was written in Hungarian (50/50 after).
- Written answers instead of a card, of 54: English 14 before, 1 after; Hungarian 19 before, 8 after.
- Per prompt, after (English / Hungarian, all samples): trip 7/7, 6/7; laptop 7/7, 6/7; interview 5/6, 6/6; language 6/6, 5/6; party 6/6, 6/6; workout 7/7, 7/7; dog 7/7, 2/6; slides 6/7, 6/7; dinner 7/7, 6/7. The gap left is mostly "dog" ("What do you think?"), which in Hungarian is still answered as a discussion four times in six: a fair answer to that question.

Two candidate sentences were screened first, by rewriting the request (9 x 6 per language): "When you ask the user with ask_user, call it before writing anything." alone gave English 85%, Hungarian 63%; the sentence that shipped gave 94% and 89%.

## Why Hungarian asked less

- Quick turns thinking off (ADR-0061), so the model decides on its first tokens. The Quick line limits tools to current or verifiable facts, the person's own data or connections, a pasted link, or a file they asked for: asking with the card was not on that list.
- Without thinking, a Hungarian reply often opened with a sentence leading into its questions ("Szívesen segítek! Ahhoz, hogy tényleg hasznos legyen a felkészülés, néhány dologra szükségem van.") and then went on in prose: the questions written as text, or the whole answer.
- Some of those replies stopped mid-word, where the card belonged: "...legyen a felkészülés, néh". The raw tokens (the same request replayed with `logprobs`) show the model's own `<|im_end|>` right after "néh", the start of "néhány" (a few): after that split the model's next token is spread out ("án", "ány", a newline) and the end token has about 5-8%, which sampling (temperature 0.6, top-k 20) sometimes picks. Three of 16 replays of the interview prompt ended so. A person would have seen a reply that just stops.
- The fix adds, after the tool limit: "When the choice is truly the user's, ask with ask_user instead of putting questions in your text, and call it before writing anything." With no lead-in sentence there is no "néh" to stop on, and the questions go to the card. The text before a tool call is withdrawn from the answer area anyway (`src/lib/components/chat/AGENTS.md`, "Live Normal Chat Answer"), so nothing a person would read is lost.

## Limits

- One model, one empty account, made-up prompts: no memory, instructions or history.
- The plain run stands in for the streaming run (the same prompt, tools and loop; `canPause` set as the streaming run sets it), non-stream.
- Thorough was not measured again: its requests are byte for byte what they were (`normal-chat-context.test.ts`, "the Quick-mode line").
