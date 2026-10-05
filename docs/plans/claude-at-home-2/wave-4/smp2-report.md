# Agent SMP-2: the stray think block, leaked reasoning in Hungarian, follow-up language

Model: claude-sonnet-5-5 (Sonnet 5.5). Branch `fix/internal-call-sampling`, worktree `…/.claude/worktrees/smp`, commits `4e64644c..5564f95e` (7, all with the Co-Authored-By trailer, nothing pushed).
No framework API was touched (the AI SDK call options are unchanged), so the Context7/Svelte docs check had nothing to confirm.
Probe scripts, raw outputs and every run: `…/scratchpad/w4/smp2-probe/` (README.txt there). Real model only through `ssh -N -L 30401:192.168.1.96:30000 alfyroot` started in the same command as each probe; sequential; no key; `~/.config/opencode/opencode.json` never read.

## Headline

1. **The stray think block had a request-shape cause after all, found at the wire, and one shared cleanup stays as the safety net.** `chat_template_kwargs.enable_thinking=false` reaches vLLM v0.31 in the form it reads (the rendered prompt ends `<think>\n\n</think>\n\n`). The model re-opened a block anyway for 17.5% of title requests because the chat template also renders **every earlier assistant turn with an empty think block**, and the title request carried four few-shot examples as assistant turns. With the same examples as text in the one user message: **0 of 100** (and 0 of 80 in a second run), titles as good. A plain chat reply with or without history never does it (0 of 90).
2. **86% of the "think" fallbacks threw away a good title.** The server returns the text with the closing `</think>` dropped and the opener kept, so `<think>\n\n\n\nTitle` looked like unclosed reasoning and the title fell back to the user's first eight words.
3. **Leaked Hungarian reasoning is real and it is the status line, not the rail.** On a Hungarian chat the model reasons in Hungarian, so the thought-step classifier is fed "A felhasználó magyarul kérdez: …" and 7.0% of the Hungarian status lines the app accepted (82 of 1,170) only said what was asked ("Tojás, rizs és zöldség alapú vacsoraötletek kérése", "Kezdő futóedzéstervet kért négy hétre"). The guard was English-only.
4. **Follow-up chips came back English because the turn's language was never handed to them.** They re-read the language from the latest user message alone (no history, no UI language), which reads as English for any Hungarian message the detector has too little evidence on. The same wrong label made the rail summary reject correct Hungarian headlines.

## Step 1: the stray think block

### What the wire shows (real server, `/tokenize` with `return_token_strs`, the app's own title body)

| body sent | rendered generation prompt ends with | tokens |
|---|---|---|
| nothing | `<think>\n` (thinking on; a system line "Reasoning effort is set to xhigh…" is added) | 419 |
| `chat_template_kwargs.enable_thinking=false` (what the app sends) | `<think>\n\n</think>\n\n` | 379 |
| `enable_thinking=false` at the top level only | `<think>\n` (ignored) | 419 |
| `extra_body.chat_template_kwargs` only (the title path also sends it) | `<think>\n` (ignored, harmless) | 419 |

All five short calls (title, status line, acknowledgment, rail summary, follow-ups) send `chat_template_kwargs.enable_thinking=false`; a new wire test pins that and fails when it is removed (mutation-checked on the title transform and on the qwen mirror).
With `logprobs` the model's leaking answers start `<think>`, `\n\n`, `</think>`, `\n\n`, title: it re-emits the empty block. The server's returned text lacks the `</think>` (also with `skip_special_tokens:false`, also when streaming).

### The three shapes the app saw (416 title requests, both temperatures, 73 leaks = 17.5%)

| shape | share of leaks | app before |
|---|---|---|
| `<think>\n\n\n\nTitle` (empty block, closer dropped, answer intact) | 63 (86%) | thrown away as thinking, fallback title |
| `<think>\nThe user wants me to…` cut off at the 120-token cap | 9 (12%) | fallback (correct: no answer exists) |
| reasoning closed by the model, closer dropped, answer after it | 1 | fallback (not separable) |

### The cause is the few-shot assistant turns (replay of the captured bodies, same inputs)

| request shape | think openers |
|---|---|
| as sent (4 few-shot assistant turns) | 19/100 and 25/80 |
| zero-shot (final message only) | 0/100 |
| examples as text in the one user message | 0/100 and 0/80 (79 of 80 clean on the app's own rules) |
| examples as text in the system message | 0/100 and 0/80 (but 33/80 echo a "Title:" label) |

The status line, rail summary, follow-ups and acknowledgment have no earlier assistant turn and never opened a block (0 of about 4,000 requests across all runs). My first commit message says their grammar forbids it; that mechanism was never verified (the missing assistant turns explain it as well). The code comment was corrected.

### What changed

- `title-generator.ts`: the examples travel as text in the one user message (`Examples of the task (input, then the title): …` then the real input). Test pins "no assistant role in the title request".
- `chat-turn/short-local-text.ts` (the shared seam): `stripLeakedThinking(raw)` -> `{kind:"text"}` or `{kind:"unclosed"}` (closed blocks go; an empty block with its closer dropped goes and the answer stays; an opener with reasoning after it is unclosed), and `askWithThinkingRetry(ask)` (one extra request for an unclosed answer, then `null` and the caller's own fallback). The title uses both; `generateShortLocalText` (the rail summary) runs the strip, which closes a hole where an unclosed block was shown as the headline (found by the first red test).
- `internal-call-thinking.wire.test.ts` (new, 5 tests): the request shape.

Live (the app's own `generateTitle`, same 26 conversations): the cleanup alone took titles accepted 74% -> 92%; the request shape then took raw think openers to 0 of 416.

## Step 2: leaked reasoning, Hungarian and English

Real data, collected with the app's own functions on the real model: the model's own reasoning for the 26 conversations (thinking on; 35 of 40 Hungarian-conversation texts open "A felhasználó …", 5 open in English "We need answer in Hungarian.", the 6 English ones "We need answer …"), cut into sentence-aligned chunks (76) and fed to the real classifier (1,216 calls), plus 650 rail summaries. The corpus run of the new checks over everything collected: `smp2-probe/corpus-flags.txt`.

- **Status line** (`isMetaRestatement`, English labels only before): 82 of 1,170 accepted lines restated the request in Hungarian. Now `isRequestRestatement` in `short-local-text.ts` (English labels moved there verbatim; Hungarian stems from the collected lines: `felhasználó`, `kér/kért/kérés…`, `kérdezi/-te…`, `magyarul`; not `felhasználói`, `felhasználás`, `kérdés`, which are other words). `isMetaRestatement` delegates to it. It flags exactly the 72 distinct restatements in the corpus, none of the 270 distinct rail headlines, none of the 133 accepted titles.
- **`isReasoningLeak`** (titles, rail): Hungarian `A felhasználó …` (35/40 real reasoning texts, plus two real rail leaks) and the English shapes real rail objects carried ("The user wants/provided …", "The assistant/reply/response is/provides …" with their verb, so "The Response Time Problem" stays).
- **Rail summary, two holes the same data showed**: a model handed a free JSON object put its thoughts in it (`thought`, `reasoning`, `hypothesis`) and `unwrapJsonControlText` would show the first string value once complete; reasoning-named keys are now never the answer and a suffixed key (`headline_hu`, real) is. A truncated tool-call-shaped blob (0.6% of 520) was short enough to pass the length bounds and be stored; text that opens like a JSON object is now rejected. And the rail now asks for a strict `{headline}` schema (like the status line and the follow-ups): the same bodies gave 110/120 clean with `json_object`, 120/120 with the schema.
- Tests both ways with the real strings: Hungarian and English leaks rejected, the ordinary lines and the look-alike stems (`felhasználásának`, `felhasználói igények`, `kérdését`) kept, end to end through `classifyThoughtStepChunk` and `generateShortLocalText`.
- **Left alone on purpose**: status lines that state the task ("A … módjait kell megadni", 41 of 1,170 = 3.5%); they share the word `kell` with real conclusions ("nem kell SZJA-bevallást benyújtani"). "We need answer …" (English reasoning style) is not matched: no short surface showed it.

## Step 3: follow-up language

The chat reply's language is decided once per turn (`resolveTurnResponseLanguage`: latest message, recent user messages, UI language) and handed to the model run, the tools and the classifier. `generateFollowUpSuggestions` and `persistAssistantRailSummary` re-derived it from the latest message alone. The real detector says `unknown` -> English for "Három napot szeretnék Budapesten tölteni…", "Milyen laptopot vegyek egyetemre…", "Mikor ültessem el a paradicsompalántákat…", and "Hogyan tanuljak meg gyorsan angolul…" is an explicit English request (`angolul`), the chat reply's rule too. The model follows the label it is given: English chips for those four of ten Hungarian conversations at every temperature (SMP's 17%).

Fix (small, optional everywhere, a caller without it behaves as before): the turn's language travels route -> orchestrator -> `completeStreamTurn` -> the suggester and `finalizeChatTurn` -> `runPostTurnTasks` -> the rail summary, and from the send route into `finalizeChatTurn`. Tests at the suggester, the rail, `runPostTurnTasks`, `finalizeChatTurn`, `completeStreamTurn` and the orchestrator (the finalize and orchestrator ones mutation-checked). The send route's two one-line passes have no route-level test (its tests do not see the post-turn tail).

## Before / after (live, real model, the app's own functions)

Same 26 conversations (20 Hungarian: SMP's ten plus ten written for this run, 6 English), profile sampling, fixed code per column. Before = tree `4e64644c`; after = `bad63eaf` (titles, follow-ups, status lines) and `0c2bc2f5`/`5564f95e` (rail; the only later change is a schema on the rail). n is calls per arm.

| measure | before | after |
|---|---|---|
| title accepted, profile (n=208) | 153 = 74% | 192 = 92% |
| title accepted, T 0.2 (n=208) | 161 = 77% | 192 = 92% |
| titles lost to a think block (profile / T 0.2) | 40 = 19% / 33 = 16% | 0 / 0 |
| raw think openers per title request (416) | 73 = 17.5% | 0 |
| titles on the fallback for the language-parity check (concern 1), profile | 15 = 7.2% | 16 = 7.7% (unchanged: 2 of the 26 conversations, every time) |
| raw think openers, status line / rail / follow-ups (about 4,000 requests) | 0 | 0 |
| status lines: accepted lines that restate the request (n=1,216 / 1,215) | 82 of 1,170 = 7.0% | 0 of 1,071 |
| status lines: calls that end with a headline | 96.2% | 88.1% (91 restatements, 7.5% of calls, now fall to the phase label; before 7) |
| rail summary accepted (n=520 / 479) | 481 = 92.5% | 478 = 99.8% |
| rail: rejected although the model wrote a real headline (wrong language label) | 16 = 3.1% | 1 = 0.2% |
| rail: rejected, no headline in it (function-call shape, cut-off reasoning object, list) / a JSON blob stored as the headline | 23 = 4.4% / 3 = 0.6% | 0 / 0 |
| follow-ups: Hungarian conversations whose chips came back English (n=95 / 97) | 9 = 9.5% | 2 = 2.1% |
| follow-ups: conversations labelled "English" (of 20 Hungarian) | 4 (3 undecided + "angolul") | 1 ("angolul", consistent with its reply) |
| follow-ups accepted (n=130) | 123 = 95% | 127 = 98% |

(The rail "after" run lost its last 41 calls to a model-server outage; they made no request and are excluded. The status-line "accepted" figure falls on purpose: restating lines used to reach the person.)

**Titles' temperature: keep the profile.** After the fix, titles at the profile are not measurably worse than at 0.2: 192/208 vs 192/208 in the run, 387/416 vs 384/416 pooled with the earlier post-fix run (Fisher p = 0.79), 0 think openers in both. Before the fix the difference SMP saw (16% vs 19% openers) was not significant either (p = 0.44). No change to `title-generator.ts` temperature handling and nothing added to `EXPLICIT_TEMPERATURES`.

## Rules added (each has its test)

1. Few-shot examples for a short internal call travel as text in the one user message, never as earlier assistant turns (`title-generator.test.ts`: the title request has only a user message). In `AGENTS.md`.
2. Every short person-read call asks for no thinking in `chat_template_kwargs` (`internal-call-thinking.wire.test.ts`).
3. `short-local-text.ts` is the one cleanup for short person-read text: stray think block (`stripLeakedThinking`, `askWithThinkingRetry`), leaked reasoning and request restatements in both languages, JSON-wrapped answers. New phrases come from real model output, tested both ways. In `AGENTS.md`.
4. The status line, rail headline and follow-up chips are written in the turn's resolved reply language, never a fresh read of the latest message (tests above). In `AGENTS.md`.
5. The rail summary asks for a strict `{headline}` object (`rail-summary.test.ts`).

## Gates (once, on the final tree; the last commit changes comments only, re-checked with biome, the touched test file and `npm run check`)

1. `npm run check`: **0 errors, 17 warnings** (`ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1).
2. `npx biome check src scripts tests`: clean (2,446 files).
3. `npm test`: **1,002 files passed (1 skipped); 16,053 tests passed, 2 skipped** (SMP 16,010; +43 = this branch's new tests).
4. `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (baseline). `npm run check:artifact-chunks` (own step): **exit 0**; CanvasEditor closure 69.6 kB gzip; chat route 538,507 B gzip, +1,624 against the 536,883 baseline (2,048 allowed). My diff touches no client file; the figure is this machine's build, as for SMP (+1,643).
5. Playwright on port 5400 (`artifact*`, `artifacts-*`, `knowledge`, `chat`, `conversation`, `streaming`): **453 passed, 23 skipped, 0 failed** (37.7 min), identical to SMP's.
6. Fallow: **124 issues / 4 circular, identical to the baseline; 0 new** (`fallow-smp2.json`).
7. `npm run check:migrations`: passes unchanged.

## Concerns

1. **The language-parity check drops 8% of titles, deterministically for two conversations.** Every title for "A Python kódom azt írja, hogy 'list index out of range'…" that has no accented letter and fewer than two Hungarian function words ("Python list index out of range hiba") fails `isHungarianText`, and "Hogyan tanuljak meg gyorsan angolul" resolves to English (explicit-request rule) while the model writes Hungarian. 2 of 26 conversations fall back every time, for reasons unrelated to thinking. Not touched (kept byte-identical by design). Suggestion: reject a title only when it is positively in the other language, not when it lacks evidence of Hungarian.
2. **`angolul` anywhere in a message is an explicit English request** (`language.ts`), including "Hogyan tanuljak meg gyorsan angolul": the chat reply, the chips and the titles all go English. A false positive of W0-D's detector, not mine to change here.
3. The status line's headline now survives less often (88% vs 96%) because restatements fall to the phase label, which is the designed floor.
4. Task-statement status lines ("… kell megadni", 3.5%) still pass.
5. The send route's `responseLanguage` pass has no route-level test.
6. Two inaccuracies in commit messages (history was not rewritten): `09193803` says the guided-JSON calls cannot open a block because of their grammar (not verified), and `9365e860` says 40 of 40 Hungarian reasoning texts open "A felhasználó" (35 of 40). The code comments say the right thing.
7. The model server was unreachable from about 15:23 to 15:36; the affected runs were redone or excluded as noted. The status-line and rail after-runs after the outage ran from a `git archive` export of the committed tree (not the worktree) so they did not touch the tree Playwright was serving.

## Hand-off

- `chat-turn/short-local-text.ts`: `stripLeakedThinking`, `askWithThinkingRetry`, `THINKING_RETRY_MAX_ATTEMPTS`, `isReasoningLeak` (EN + HU), `isRequestRestatement` (EN + HU), `unwrapJsonControlText` (reasoning keys, suffixed keys), `GenerateShortLocalTextParams.jsonSchema`. `thought-step-classifier.ts` `isMetaRestatement` delegates.
- `responseLanguage?: SupportedLanguage` on `generateFollowUpSuggestions`, `persistAssistantRailSummary`, `CompleteStreamTurnParams`, `FinalizeChatTurnParams`, `RunPostTurnTasksParams`.
- Probe: `smp2-probe/run-live.sh <tag> [SMP2_REPS=… SMP2_TITLE_REPS=… SMP2_PATHS=title,rail_summary,follow_up,thought_step]` (add `WT=<export dir>` to run from a `git archive` copy), `summarize.py live-<tag>.json`.
