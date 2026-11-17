# Pictures and videos on a clear request: measured, changed, measured again

**Bottom line:** on Thorough, the default, an ambiguous request now gets a card first 75% of the time instead of 6%, and makes a picture on a guess 8% of the time instead of 42%. With a picture already in the chat, a video no longer starts without a clear request for one (0 of 40, from 13 of 40). Clear requests still go straight through: pictures 39 of 40, changes to a picture 16 of 16, videos 24 of 24, and plain questions neither make nor ask anything (24 of 24). On Quick (thinking off) the cards rose too (10% to 41%), but the videos did not stop (28% to 25%): see "What is left".

Measured 2026-11-17 against the production model (`qwen3-6-27b`, inference.alfycomms.com). Before: the release code, `read-aloud-release` at `6cb4fb106`. After: this branch (`claude/gen-toggle-explicit-202be2`). Made-up prompts only, on an empty test account.

## How it was measured

The method of the Ask me first measurement (`docs/plans/ask-me-first/results-quick-hungarian.md`): a throwaway vitest file runs the app's own plain model run (`runPlainNormalChatSendModel`, `canPause: true`, so `ask_user` checks the card and pauses as the streaming run does) and sends its model calls to the production model (non-stream, `max_tokens` 3000). A picture server and a video server are configured (fake addresses that nothing reaches), so make_image and make_video are in the catalogue as on production, and image_search and research_web are too. Local tools run (`memory_context`, `use_skill`); every other host answers 503. A turn is decided by its first `ask_user` the app accepts, by a call of make_image or make_video (never run: the probe ends the turn there), by another tool (image_search, research_web: also never run), or by written text. Concurrency 4. Thorough is the default depth and carries most of the samples; Quick (thinking off) was measured the same way.

"A picture already in the chat" is a seeded chat in which the person asked for a picture of a beach with big waves at sunset, and Alfy's reply called make_image (the call and its result as the tool stores them, with make_video's hint) and holds an Image item under "In this chat".

Prompts, each in English and in natural Hungarian (`prompts.json` in the probe kit):

| Kind | Prompts | Samples per language | Wanted |
|---|---|---|---|
| Clear picture | draw a cat with a crown; a picture of a lighthouse at sunset; generate a cabin in the snow; an illustration of a dragon reading; paint a watercolour of a Tuscan village | 4 | made at once, no card |
| Clear change, picture in the chat | add seagulls over the water; make it black and white | 4 | made at once, no card |
| Ambiguous | show me a lighthouse; what would my living room look like with dark green walls; I'd love to see a red fox in a snowy forest; show me what a wedding cake with lavender flowers could look like; I want to see some ideas for a small wave tattoo; and three held out of every wording (picture a Japanese garden in autumn for me; I need something visual for my bakery's Instagram post; I'm trying to imagine a city on Mars) | 6 | a card first |
| Ambiguous, picture in the chat | what would it look like at night; make the waves crash; could the sea move a little; now show a surfer riding the big wave; and one held out (it would be nice if the clouds drifted) | 4 | a card first, and never a video |
| Clear video, picture in the chat | turn this picture into a video; animate this picture: the waves roll in slowly; make a 5-second clip where the camera pans right | 4 | made at once, no card |
| Plain question | why is the sky blue; how do I mix teal from acrylics; the tallest lighthouse in the world; colours that go with navy in a living room | 3 | neither made nor asked |

## Numbers: Thorough (the default)

Wilson 95% intervals in brackets.

| | Before, English | Before, Hungarian | After, English | After, Hungarian |
|---|---|---|---|---|
| Clear picture: made at once | 20/20 = 100% [84-100] | 20/20 = 100% [84-100] | 20/20 = 100% [84-100] | 19/20 = 95% [76-99] |
| Clear change, picture in the chat: made at once | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] |
| Ambiguous: asked first | 3/48 = 6% [2-17] | 3/48 = 6% [2-17] | 40/48 = 83% [70-91] | 32/48 = 67% [53-78] |
| Ambiguous: a picture made on a guess | 20/48 = 42% [29-56] | 20/48 = 42% [29-56] | 3/48 = 6% [2-17] | 5/48 = 10% [5-22] |
| Ambiguous, picture in the chat: asked first | 0/20 = 0% [0-16] | 0/20 = 0% [0-16] | 14/20 = 70% [48-85] | 13/20 = 65% [43-82] |
| Ambiguous, picture in the chat: a video started | 9/20 = 45% [26-66] | 4/20 = 20% [8-42] | 0/20 = 0% [0-16] | 0/20 = 0% [0-16] |
| Ambiguous, picture in the chat: the picture changed | 11/20 = 55% [34-74] | 16/20 = 80% [58-92] | 6/20 = 30% [15-52] | 7/20 = 35% [18-57] |
| Clear video: made at once | 11/12 = 92% [65-99] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] |
| Plain question: neither made nor asked | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] |

Per prompt, asked / picture / video / other (English, then Hungarian), before -> after:

| Prompt | Kind | Before | After |
|---|---|---|---|
| c-lighthouse | clear | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/3/0/1 |
| c-cat | clear | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| c-cabin | clear | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| c-dragon | clear | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| c-watercolor | clear | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| e-seagulls | clearEdit | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| e-bw | clearEdit | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| a-lighthouse | ambiguous | 0/0/0/6, 0/0/0/6 | 6/0/0/0, 5/0/0/1 |
| a-livingroom | ambiguous | 2/3/0/1, 1/2/0/3 | 6/0/0/0, 6/0/0/0 |
| a-fox | ambiguous | 0/6/0/0, 0/6/0/0 | 3/3/0/0, 3/3/0/0 |
| a-cake | ambiguous | 0/1/0/5, 0/6/0/0 | 6/0/0/0, 4/2/0/0 |
| a-tattoo | ambiguous | 0/0/0/6, 0/0/0/6 | 3/0/0/3, 3/0/0/3 |
| h-garden (held out) | ambiguous | 0/5/0/1, 0/4/0/2 | 6/0/0/0, 3/0/0/3 |
| h-bakery (held out) | ambiguous | 1/5/0/0, 2/2/0/2 | 6/0/0/0, 6/0/0/0 |
| h-mars (held out) | ambiguous | 0/0/0/6, 0/0/0/6 | 4/0/0/2, 2/0/0/4 |
| p-night | ambiguousPicture | 0/4/0/0, 0/4/0/0 | 4/0/0/0, 2/2/0/0 |
| p-crash | ambiguousPicture | 0/3/1/0, 0/4/0/0 | 2/2/0/0, 3/1/0/0 |
| p-move | ambiguousPicture | 0/0/4/0, 0/0/4/0 | 4/0/0/0, 4/0/0/0 |
| p-surfer | ambiguousPicture | 0/4/0/0, 0/4/0/0 | 0/4/0/0, 0/4/0/0 |
| h-clouds (held out) | ambiguousPicture | 0/0/4/0, 0/4/0/0 | 4/0/0/0, 4/0/0/0 |
| v-turn | clearVideo | 0/0/4/0, 0/0/4/0 | 0/0/4/0, 0/0/4/0 |
| v-animate | clearVideo | 0/0/4/0, 0/0/4/0 | 0/0/4/0, 0/0/4/0 |
| v-clip | clearVideo | 0/1/3/0, 0/0/4/0 | 0/0/4/0, 0/0/4/0 |
| q-sky | plain | 0/0/0/3, 0/0/0/3 | 0/0/0/3, 0/0/0/3 |
| q-teal | plain | 0/0/0/3, 0/0/0/3 | 0/0/0/3, 0/0/0/3 |
| q-tallest | plain | 0/0/0/3, 0/0/0/3 | 0/0/0/3, 0/0/0/3 |
| q-colours | plain | 0/0/0/3, 0/0/0/3 | 0/0/0/3, 0/0/0/3 |

The held-out prompts (never in any wording that was screened) move with the rest: "picture a Japanese garden in autumn for me" asked 9 of 12 (none before), "something visual for my bakery's Instagram post" 12 of 12 (3 before), "it would be nice if the clouds drifted" 8 of 8 (it started 4 videos before).

What the cards offer, a few of them as the model wrote them: "How would you like to see a lighthouse?" Real photos online / A generated picture / A written description; "Milyen világítótornyot szeretnél látni?" Fotó a netről / Készített kép / Rajz/diagram; "Want me to turn the picture into a short video with the waves rolling in?" Yes, animate it / Make it 10 seconds / No, keep the still. In the screening run with the shipped wording, 3 of about 30 cards on a request that was not about motion offered a video as one of the options.

## Numbers: Quick (thinking off)

| | Before, English | Before, Hungarian | After, English | After, Hungarian |
|---|---|---|---|---|
| Clear picture: made at once | 20/20 = 100% [84-100] | 20/20 = 100% [84-100] | 20/20 = 100% [84-100] | 20/20 = 100% [84-100] |
| Clear change, picture in the chat: made at once | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] | 8/8 = 100% [68-100] |
| Ambiguous: asked first | 5/48 = 10% [5-22] | 5/48 = 10% [5-22] | 22/48 = 46% [33-60] | 17/48 = 35% [23-50] |
| Ambiguous: a picture made on a guess | 15/48 = 31% [20-45] | 20/48 = 42% [29-56] | 14/48 = 29% [18-43] | 15/48 = 31% [20-45] |
| Ambiguous, picture in the chat: asked first | 0/20 = 0% [0-16] | 0/20 = 0% [0-16] | 2/20 = 10% [3-30] | 0/20 = 0% [0-16] |
| Ambiguous, picture in the chat: a video started | 7/20 = 35% [18-57] | 4/20 = 20% [8-42] | 6/20 = 30% [15-52] | 4/20 = 20% [8-42] |
| Ambiguous, picture in the chat: the picture changed | 13/20 = 65% [43-82] | 16/20 = 80% [58-92] | 12/20 = 60% [39-78] | 16/20 = 80% [58-92] |
| Clear video: made at once | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] |
| Plain question: neither made nor asked | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] | 12/12 = 100% [76-100] |

## Pictures and videos switched off

The same run on an account that switched "Pictures and videos" off (Thorough; make_image and make_video are not in its catalogue). Of 36 requests for a picture or a video, every clear video request (12 of 12) and 15 of 18 clear picture requests were answered with a short "it is switched off" and the path, in the person's language: "Settings > Profile > Pictures and videos", and in Hungarian "Beállítások > Profil > Képek és videók", the UI's own words. The other three, and the six "show me a lighthouse", searched for photos instead, which the line allows; nothing was made another way. The plain question was answered as usual (4 of 4).

## How the wording was chosen

Screened on the release code by rewriting the request before it was sent (the probe's `TOOL_DESC_FILE`, `GUIDANCE_FIND_FILE` and `GUIDANCE_REPLACE_FILE`), Thorough, every prompt, both languages:

| Variant | Ambiguous asked | Ambiguous made on a guess | Video without a clear request | Clear pictures made |
|---|---|---|---|---|
| Before | 6/96 | 40/96 | 13/40 | 40/40 |
| S1: one sentence in make_image, make_video and image_search only | 37/96 | 13/96 | 14/40 | 39/40 |
| S2: a line in the turn guidance only | 77/96 | 6/96 | 14/40 | 40/40 |
| S3: both | 84/96 | 2/96 | 12/40 | 39/40 |
| S4: both, with the stricter video sentence ("in so many words"; a wish that something would move is not one) | about half the run, stopped once the video case was plainly fixed: "could the sea move a little?" asked 4/4, the held-out clouds asked 2/2, clear videos 6/6 | | | |

The turn guidance did most of the work; the descriptions alone far less. The shipped code is S4: the line in the turn guidance, and one sentence each in make_image and make_video. Two Quick-only wordings were screened on the shipped code and stopped early as no better: a shorter line ending "call ask_user first, before writing anything" (ambiguous asked 4 of 17 at the stop) and the rule folded into the Quick line as "a choice that is theirs" (3 of 14 asked, 4 of 10 videos started).

## The tool catalogue

make_image 135 -> 168 estimated tokens, make_video 149 -> 179 (make_video's "Only for a clip" made way for the new sentence). The catalogue goes from 5,639 to 5,702, and `CATALOGUE_TOKEN_CEILING` (`normal-chat-tools/index.test.ts`) is raised to exactly that, with the reason above it: nothing else in the catalogue says it, so no words could pay for it. The turn guidance line is 496 characters (about 124 tokens), on every turn that can make a picture or a video, after the message.

## What is left

- **Quick.** With thinking off, the line is followed much less: the cards rose from 10% to 41%, but with a picture in the chat a wish that something would move still starts a video (10 of 40, from 11). Two Quick-only wordings did no better. A fix probably needs the Quick line itself, measured together with the Ask me first prompts that line was tuned on.
- **"Now show a surfer riding the big wave"** still changes the picture straight away, 8 of 8: the model reads it as a clear change, which is a fair reading.
- **"I'd love to see a red fox in a snowy forest"** makes a picture half the time (6 of 12): close to a clear request.

The probe kit (the throwaway test as `.txt`, `prompts.json`, `analyze.mjs`, `table.mjs`, every runner and every result file) is in the shared notes folder of the read-aloud release sessions, `gen-explicit-probe/`; it reads the key from `~/.dsh/.env` and never prints it.
