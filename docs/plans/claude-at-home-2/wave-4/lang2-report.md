# Agent LANG-2: a request for content in another language keeps the conversation's language (ruling 75, RV-F M-8)

Model: claude-sonnet-5-5 (Sonnet 5.5). Branch `fix/content-language` (from `feat/artifacts` `413fbb56`), worktree `.../.claude/worktrees/art-lang2`, commits `413fbb56..HEAD` (5 commits: 4237a49c, c1172d23, e07a2d88, cb1e21d9, 68dfb1b8; all with the Co-Authored-By trailer, nothing pushed). e2e port 5460, tunnel 30405.
Docs check: no framework API was touched (plain TypeScript in `language.ts`, one import, two call sites), so the Context7/Svelte docs check had nothing to confirm (not available in this session, per the wave rules).
Real model only through `ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -L 30405:192.168.1.96:30000 alfyroot` started in the same command as each run (`qwen3-6-27b`), sequential, no key, `~/.config/opencode/opencode.json` never read. Probe harness, raw runs and the labels' source: `.../scratchpad/w4/lang2-probe/` (outside the repo).

## Headline

1. **The owner's message now keeps the turn in Hungarian.** "Írj egy e-mailt angolul a kollégámnak, hogy holnap nem tudok bejönni, mert beteg vagyok." resolved to English before (the reply, the chips and the status line all went English; the model wrote the email, bare in two runs of three, once with an English introduction). It resolves to Hungarian now; the real model writes a Hungarian introduction, the email in English, and Hungarian chips. The mirror ("Write an email to my colleague in Hungarian saying I can't come in tomorrow...") keeps an English turn with a Hungarian email.
2. **The rule, as built.** A language word is a request for the REPLY only when the person asks for the answer in it; a request for a PIECE OF WRITING in a language no longer flips the turn. `detectExplicitLanguageRequest` (reply) is unchanged in name and role; the new `detectContentLanguageRequest` says which language the piece is in. Details below.
3. **One consequence outside the brief's file list, handled:** an App is the one thing the server writes itself in ONE language, and it took the turn's. "Write a quiz app in Hungarian" used to get a Hungarian UI *because* it flipped the whole turn; with content requests no longer flipping, it would have come out English against the request. `create_artifact` and the panel's App regenerate now take the content language of the message first (`normal-chat-tools/index.ts`, `regenerate/+server.ts`, 12 lines).
4. **The model needs no extra guard line.** The existing generic line of the response-language guard ("...produce specific content in a different language... keep your own surrounding commentary in [the turn's language]") is enough once the turn resolves to the conversation's language: 36 of 36 content replies had the piece in the requested language and the commentary (when there was any) in the conversation's. I built and measured the one line the brief allows ("This message asks for content in English... including its subject line, greeting, placeholders and sign-off. Everything else stays in Hungarian"): it cut Hungarian words inside English emails from 3 of 15 replies to 1 of 15 and did nothing for the other direction, so it is not shipped (reverted before any commit; `normal-chat-context.ts` is untouched).
5. **A performance bug fixed on the way (pre-existing, and my first version made a second one).** The old `onlyTheLanguage` check scanned the whole sentence for every language word: a pasted blob of "in English" x20,000 took 6.4 s of event-loop time to read (measured on the base tree); my first shape check made "write in English..." take 8 s. Every per-language-word check now reads running counts over the sentence: both detectors take 35 ms on the blob, 134 ms on a 1 MB natural text. A test pins it (< 1.5 s on four such blobs).

## The rule as built (`src/lib/server/services/language.ts`)

Per sentence, accents folded, a language word (angolul / angol nyelven / in English / bare English) is classified **reply**, **content** or nothing:

- **Nothing** (unchanged, CHP's): a sentence that opens with a question word, "hogy mondják angolul", learn / tanulni, mean / jelent, "can you speak".
- **Reply** (flips the turn): a REPLY directive near the word (answer, reply, respond, speak, talk, chat, continue, explain, describe, summarize; válaszolj, beszéljünk, folytasd, magyarázd, foglald össze), "in English please" / "kérlek angolul" / "csak angolul" / "Hungarian only", a sentence that is little more than the language word, "Legyen angolul a válasz" / "A válaszod legyen angolul" (the wish word is read as a directive and what the wish is about decides), "I want it / I need the answer in Hungarian".
- **Content** (does not flip; named by `detectContentLanguageRequest`): a CONTENT directive near the word (write, draft, compose, rewrite, rephrase, make, create, give me; írj, fogalmazz, készíts, adj, írd) with something to write ("Írj egy e-mailt angolul a kollégámnak", "Write this in Hungarian please", "Fogalmazd meg angolul"), "I need a cover letter in Hungarian", "Translate this into Hungarian / Fordítsd le angolul", "an English title".
- **A content directive asks for the reply when there is nothing to write**: "Write in English, please", "Írj nekem angolul", "Write to me in Hungarian from now on", "Mostantól minden válaszodat angolul írd", or the reply itself is what is written ("Write your answers in Hungarian", "Írd a válaszod angolul"). The Hungarian definite forms (írd, fogalmazd) carry their object, so "Írd angolul" is content. What follows a colon is the thing to answer or write about, never part of the instruction ("Írj angolul: mi az a mutex?" is a request for the reply).
- **Which directive governs which word**: the nearest one; an English "in X" prefers the one before it. So "Answer in English and write the email in Hungarian" is a reply in English and a piece in Hungarian, "Válaszolj magyarul, de a levél legyen angolul" a Hungarian turn with an English letter, and "Write an answer to my colleague in Hungarian" (answer is a noun after "an") is content.
- **Content is read conservatively** because the App now takes it: not when the language is what an app teaches ("an app to learn Hungarian", "amivel angolul tanulhatok"), not for a bare adjective ("a Hungarian recipe app", "a Hungarian poem"), not when a noun follows ("bars in Hungarian cities").

`resolveResponseLanguage` is untouched in shape: reply request, else the message's own language, else history, else UI language. The title, the thought-step status line, the rail headline and the follow-up chips all read the turn's resolved language, so they follow. AGENTS.md carries the rule (one line extended).

## What changed where

| file | change |
|---|---|
| `src/lib/server/services/language.ts` | request detection rebuilt on reply / content kinds; `detectContentLanguageRequest`; linear-time per language word |
| `src/lib/server/services/normal-chat-tools/index.ts` | App `create_artifact` language = content language of `requestText`, else the turn's |
| `src/routes/api/artifacts/[id]/app/regenerate/+server.ts` | same for the panel's regenerate prompt (there is no reply there) |
| `src/lib/server/services/chat-turn/short-local-text.ts` | doc comment only |
| `AGENTS.md` | the language rule line |
| tests | `language.test.ts` (188 -> 283 cases), `short-local-text.test.ts`, `shared-normal-chat-model-run-helpers.test.ts` (the function send/stream/retry all resolve the turn through), `normal-chat-tools/index.test.ts`, `regenerate.test.ts` |

`normal-chat-context.ts` (the guard) is untouched, as measured.

## Tests (red first)

Red on the base tree: 73 failures the moment the content cases were added (the owner's sentence resolved `en` where `hu` was expected), 9 more when the topic / lesson / adjective cases were added to the first content detector (e.g. "Build a flashcard app to learn Hungarian" read as content in Hungarian; "Készíts egy appot, amivel angolul tanulhatok" as content in English), and the App tests (`create_artifact` handed `hu` for "Készíts egy kvíz alkalmazást angolul"; the regenerate route `en` for "Write all the labels in Hungarian") before the two call sites changed.
Covered both ways in both languages: Hungarian message / English wanted (reply and content), Hungarian / Hungarian, English / Hungarian, English / English; request shapes, content shapes, mention / lesson / topic shapes, the owner's sentence and its mirror through `resolveResponseLanguage`, `resolveShortTextLanguage` and `resolveTurnResponseLanguage`, and four long-blob timing cases (`language.test.ts`: 188 -> 283 cases). Of CHP's 188 tests, 175 pass untouched, 2 changed an example from a write request to an answer request, and 11 reply-list cases moved to the content lists, which is exactly what the owner's ruling reclassifies: "Írd angolul", "Írd meg angolul", "Írd meg magyarul", "Írj egy rövid levelet angolul a főnökömnek", "Írj angol nyelvű levelet a főnökömnek", the two "Írj egy rövid (de udvarias) köszönő e-mailt ... angolul" cases, and in English "Can you write this in Hungarian please?", "Give me an English title", "Write a short thank-you email to our hosts in English", "Write a polite reminder to the whole team ... in English".

## Live: before / after on the real model

Method (CHP's, reused). The app's own functions through the tunnel: `resolveResponseLanguage` for the turn language; the app's own `buildTurnGuidance` + `appendTurnGuidance` (the real guard, not a copy) around the message for a real chat reply (thinking off, temperature 0.7 / top_p 0.95 / top_k 20 as CHP, minimal system prompt "You are Alfy"); `generateFollowUpSuggestions` for the chips. **Before = an export of `413fbb56`; after = the final tree.** 35 prompts x 3 replies per arm: CHP's 14 mention traps and 5 request traps, 4 new request shapes, 12 content prompts (5 Hungarian, 5 English, 2 mixed: a reply request and a content request in one message); plus 4 follow-ups on a piece already written in the other language (3 replies each in the after runs, 8 and 50 more below). Labels for the content replies are mine, read from block skeletons (the harness's own word-list language read is coarse; chips were re-counted with a stricter rule).

**Turn language kept, per prompt** (3 replies each; letters are the language the turn resolved to; "want" is what the owner wants; `piece` is the language the writing must be in):

| prompt | kind | want | piece | before | after |
|---|---|---|---|---|---|
| Hogy mondják angolul, hogy alma? and 9 more Hungarian mentions (mean, learn, translate x2, how-write, which, want-learn, call, magyarul) | mention | hu | | hhh each | hhh each |
| How do you say 'apple' in Hungarian? and 3 more English mentions | mention | en | | eee each | eee each |
| Válaszolj angolul, kérlek: ... / Beszéljünk angolul... / Angolul válaszolj: ... / **Írj angolul, kérlek: ...** / **Magyarázd el angolul...** | request | en | | eee each | eee each |
| Please answer in Hungarian: ... / Can you explain ... in Hungarian please? / **Please write in Hungarian from now on...** / **What is a hash map? In Hungarian please.** | request | hu | | hhh each | hhh each |
| **Írj egy e-mailt angolul a kollégámnak, hogy holnap nem tudok bejönni...** (the owner's) | content | hu | en | eee | **hhh** |
| Írj egy rövid köszönő e-mailt a vendéglátónknak angolul. (CHP's old "request") | content | hu | en | eee | **hhh** |
| Fogalmazz meg angolul egy udvarias levelet a szállásadónknak... | content | hu | en | eee | **hhh** |
| Készíts egy angol nyelvű motivációs levelet... | content | hu | en | hhh | hhh |
| Írj angolul egy rövid bemutatkozást a LinkedIn profilomhoz... | content | hu | en | eee | **hhh** |
| Válaszolj magyarul, de az e-mailt írd meg angolul... | content | hu | en | eee | **hhh** |
| Write an email to my colleague in Hungarian saying I can't come in tomorrow... | content | en | hu | hhh | **eee** |
| Write a short thank-you note to our hosts in Hungarian. | content | en | hu | hhh | **eee** |
| Draft a polite message in Hungarian to my landlord... | content | en | hu | eee | eee |
| Can you write a short toast in Hungarian for my brother's wedding? | content | en | hu | hhh | **eee** |
| Write this in Hungarian please: see you at seven... | content | en | hu | hhh | **eee** |
| Answer in English, but write the email to my colleague in Hungarian... | content | en | hu | hhh | **eee** |

**Totals** (replies): the turn language is what the owner wants in

| | before | after |
|---|---|---|
| mention prompts, Hungarian conversation / English conversation | 30/30, 12/12 | 30/30, 12/12 |
| request-for-the-reply prompts, Hungarian / English conversation | 15/15, 12/12 | 15/15, 12/12 |
| **content prompts, Hungarian conversation (English piece)** | **3/18** | **18/18** |
| **content prompts, English conversation (Hungarian piece)** | **3/18** | **18/18** |

**Chips in the conversation's language** (sets with chips; mentions that quote a foreign word excluded; stricter rule than the harness's): content Hungarian conversation 3/18 -> **17/17**, content English conversation 3/14 -> **15/15**; mention 9/9 -> 8/8, request Hungarian conversation 13/15 -> 12/15 and English 12/12 -> 12/12 (the 2-3 "misses" in the request rows are English chips my word rule reads as Hungarian: the harness's reading, not the app's; same before and after).

**The reply itself, content prompts (36 per arm), my reading of the skeletons:** before, only the 6 replies whose turn happened not to flip (the Hungarian cover letter x3, the English landlord note x3) had their commentary in the right language; in 10 the commentary was in the wrong one (Hungarian conversation: 4 English introductions such as "Here is the draft for your email in English"; English conversation: 6 Hungarian ones, "Íme..."), and in 20 there was no commentary at all, just the bare piece with the chips and status line in the flipped language. After: **all 36 pieces are in the requested language and none of the 36 has commentary in the wrong one**: 33 open with a line in the conversation's language (18 of 18 Hungarian, e.g. "Íme egy rövid és udvarias e-mail vázlat angolul, amelyet elküldhetsz a kollégádnak:", then the English email; 15 of 18 English, e.g. "Here is a short thank-you note you can send to your hosts, ...", then the Hungarian note, often with an "English translation for your reference") and 3 are the bare Hungarian email. Example, the owner's prompt, same sampling:

- before (turn `en`, chips `Make the email more formal` / `Add a line about checking emails`): `Subject: Out Sick Tomorrow - [Your Name]` / `Hi [Colleague's Name], ...` and nothing else.
- after (turn `hu`, chips `Készíts egy rövidebb, formálisabb változatot` / `Írj egy verziót, ami nem említi az e-mail ellenőrzését`): `Íme egy vázlat az e-mailhez, amelyet elküldhetsz a kollégádnak:` / `**Subject:** Out of Office - Sick Day ...` / `Hi [Kolléga Neve], ...`.

**Follow-ups on a piece in the other language** (56 runs across the three after-arm runs plus a 50-rep run on the worst prompt; the follow-up message carries no content request, so the code path is the same before and after this change): in a Hungarian conversation the English email stays English in **28 of 28** ("Rövidítsd le egy kicsit, és legyen formálisabb", "Add hozzá, hogy csütörtökön már visszajövök"). In an English conversation "Make it a bit shorter and more formal" keeps the Hungarian email in 14 of 14, but **"Add that I'll be back on Thursday." rewrites it in English in 12 of 64** (19%; an English sentence about an email in a language the model is not asked to repeat). A one-sentence persistence line added to the existing generic guard line ("When you later revise or extend such content, keep it in the language it is written in.") was measured at 50 reps each way: 10 of 50 drifted without it, 8 of 50 with it (Fisher p about 0.4), so it is not shipped. Pre-existing, in the mirror direction only, and not what the owner asked for; listed under concerns.

**Placeholders (the one cosmetic residue).** In Hungarian-conversation emails the model sometimes writes Hungarian placeholders and labels inside the English email (`Hi [Kolléga neve]`, `**Tárgy:**`; 8 of 18 replies in the final run, 3 of 15 in the earlier one, 0 of 18 before, when the whole turn was English); in English-conversation Hungarian emails it writes English placeholders (`[Your Name]`), which for an English reader is arguably useful. This is the guard-line experiment's whole effect (it reduced the first from 3/15 to 1/15 and left the second as it was), which is why it is not shipped.

## Gates (once, on the final tree)

Run on `cb1e21d9` (the code). The last commit `68dfb1b8` moves comments only: `npm run check` (8,405 files, 0 errors, 17 warnings), biome (2,533 files, clean) and the language tests (283 passed) were re-run on it.

1. `npm run check`: 8,405 files, **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1: the baseline).
2. `npx biome check src scripts tests`: clean (2,533 files).
3. `npm test`: **1,032 files passed (1 skipped); 17,173 tests passed, 2 skipped.**
4. `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (baseline). `npm run check:artifact-chunks` (own step): **exit 0**; CanvasEditor closure 62.1 kB gzip entry, 70.2 kB with its own chunks (ceiling 72,704 B); chat route 542,919 B gzip, **+1,430 against the 541,489 baseline** (2,048 allowed). The base tree (`413fbb56`, exported and built in my scratch) measures 542,891 B (+1,402), so my growth is 28 B of build noise: no client file changed (`git diff 413fbb56..HEAD --name-only` is `src/lib/server/**`, `src/routes/api/**` and `AGENTS.md` only).
5. Playwright on port 5460, `artifact*` (all artifact suites), `knowledge`, `chat`, `conversation`, `streaming`, `follow-up-chips` (50 spec files): **550 passed, 23 skipped, 0 failed** (41.7 min; the known `artifact-canvas-undo.spec.ts:418` flake and `artifact-canvas-charts.spec.ts:606` both passed in this run).
6. Fallow: **124 issues / 4 circular, identical to the baseline; 0 new** (`lang2-gates/fallow-lang2.json`; `detectContentLanguageRequest` is used by two callers).
7. `npm run check:migrations`: passes unchanged.

Logs: `.../scratchpad/w4/lang2-gates/`.

## Deviations and concerns

1. **Scope.** The App path (two call sites outside the brief's file list) and the linear-time rewrite of the per-word checks (which touches the shape of `language.ts` more than a rule change alone) are the two things beyond "detectExplicitLanguageRequest and its callers". Both are needed: the first to avoid a regression ("Write a quiz app in Hungarian"), the second because the new shape check would otherwise have been a new quadratic and the old one already was.
2. **Judgement calls the owner may want to flip, each one line in `language.ts`:** *explain / describe / summarize in X* stay requests for the REPLY (CHP's rule: "Magyarázd el angolul, mi az a mutex" answers in English, chips in English). If the owner means "only the piece, never the whole answer", move those directives (`ENGLISH_REPLY_DIRECTIVES`, `HUNGARIAN_REPLY_DIRECTIVE_RE`) to the content lists. "Translate / fordítsd" and "an English title" are content.
3. **Known misses, all harmless** (the turn stays in the message's own language, only content detection misses): "Mondd el angolul", "Show / tell me in Hungarian...", "angolra / magyarra" (into English) are not language words, "Szeretnék egy e-mailt angolul" has no directive.
4. **Mirror follow-up drift (not caused by this change).** "Add that I'll be back on Thursday." after a Hungarian email in an English conversation rewrites the email in English in about 1 of 5 runs; the Hungarian conversation's follow-ups never do (0 of 28). A guard sentence did not move it (above). A deterministic fix would have to remember, per conversation, the language a piece was asked in; I left that alone.
5. **A pasted block can still outvote the instruction.** The turn language of a message with no reply request is the language the message is mostly written in; a Hungarian instruction wrapped around a long pasted English text reads as English. Pre-existing, and unrelated to this rule.
6. **The probe is CHP's minimal one**: system prompt "You are Alfy", the real turn guidance, no tool catalogue or production system prompt. The guard sits last in the packet, where the production prompt also puts it.
7. One chip set in 94 copied a chip-prompt example ("Hasonlítsd össze a két telefontarifát táblázatban" under a LinkedIn bio): CHP's area, 1 of 94, 0 of 160 on the earlier runs.

## Hand-off

- `language.ts`: `detectExplicitLanguageRequest` (reply), `detectContentLanguageRequest` (piece), `resolveResponseLanguage` (reply only). A new directive or language word goes into the tables at the top of the request section (`ENGLISH_REPLY_DIRECTIVES`, `ENGLISH_CONTENT_DIRECTIVES`, the Hungarian regexes, `REPLY_SHAPE_WORDS`, `LANGUAGE_CONTINUERS`) with a test in both directions in `language.test.ts`; keep per-word checks on the `SentenceContext` running counts.
- Re-measure: `lang2-probe/run-live.sh <tag> L2_REPS=3 [L2_ONLY=content,followup]` with `WT=<tree>` (a `git archive` export is safest), `summ.py live-<tag>.json [skeleton]`, `leaks.py`, `drift.py`; inputs in `lang2-probe/inputs.ts.txt`.
