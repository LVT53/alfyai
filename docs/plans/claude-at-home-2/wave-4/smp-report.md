# Agent SMP: every internal model call takes the provider family's one sampling profile

Model: claude-sonnet-5-5 (Sonnet 5.5). No framework API was touched (the AI SDK call options are unchanged and read at the wire), so the Context7/Svelte docs check had nothing to confirm. Branch `fix/internal-call-sampling` (worktree `…/.claude/worktrees/smp`), from `dev` `27274c0e`.
Probe script, raw samples and outputs: `…/scratchpad/w4/smp-probe/` (outside the repo).

## Headline

1. **The premise was mostly stale, and that matters for how to read the fix.** On `dev` (`27274c0e`), read through a fake `fetch`,
   *no* audited path sent "no sampling" to a qwen-family model. Everything either carried the whole profile (0.6 / 0.95 / 20) or
   an explicit low temperature plus the family's top_k and top_p (top_p everywhere except the ChatGPT-import summarizer). `top_k` does reach the wire on every path (the provider builder
   injects it from `defaultSampling`). The control transport, title generation and the context-summarizer client had been fixed
   in `3cb77aaa` / `42205adb`; before that they sent flat 0.1 / 0.2, never 1.0. The garble ("Rägyvágok", Chinese characters
   inside a Hungarian sentence) reproduces on the real model **only when the request carries no sampling at all** (the checkpoint's
   generation_config temperature 1.0), which no audited path did on a qwen-family model.
2. What the branch does: **one route to the wire** (`normal-chat-model/sampling.ts`, `resolveModelCallSampling`), used by the
   chat run and by every internal call; four person-read paths moved from an explicit temperature to the whole profile (thought-step
   status lines 0 -> 0.6, follow-up suggestions 0.4 -> 0.6, titles 0.2 -> 0.6, the persona summary 0 -> 0.6); the ChatGPT-import
   summarizer gained the family's `top_p` it never sent; the App contract's copy of the numbers is gone; and a structural test
   fails the build when a model call goes round the route or writes a temperature that is not listed with its reason.
3. **Live probe, real model, real prompts:** with *no sampling* 4 of 680 short Hungarian snippets were garbled (3 with Chinese
   characters inside the sentence, 1 an invented English sentence) and the rail summary came back as malformed JSON 18% of the time
   (31/170). With the *profile*: 0 of 680 garbled, 3/170 malformed. **dev's own explicit bodies were also clean (0 of 110)**, so
   against what is actually deployed the profile removes no garble; it makes the setting uniform. See concern 1 for titles.

## What changed

| file | change |
|---|---|
| `normal-chat-model/sampling.ts` (new) | `resolveModelCallSampling(provider, { machineReadTemperature?, profilelessTemperature? })` -> `{ temperature, topP }`. Reads the family's `defaultSampling` from `provider-compatibility.ts`; never holds a number. top_k stays a body injection by the provider builder, from the same profile. |
| `normal-chat-model/index.ts` | the plain and the streaming chat run take the helper (was an inline read of the adapter). |
| `normal-chat-control-model.ts` | `sendJsonControlMessage` takes the helper. `temperature` documented as the machine-read answer's own; new `profilelessTemperature`; the never-used `topP` option is gone (a second route to the numbers). |
| `title-generator.ts`, `task-state/control-model.ts`, `chatgpt-import/summarizer.ts` | take the helper instead of reading the adapter inline; the summarizer now sends the family's top_p. |
| `chat-turn/thought-step-classifier.ts`, `follow-up-suggestions.ts`, `short-local-text.ts` | the explicit 0 / 0.4 became `profilelessTemperature` (a family with no profile keeps them); `callShortLocalControlModel` forwards it. |
| `memory-control-model.ts`, `memory-consolidation/summary.ts` | new `readBy: "machine" \| "person"` (default machine = today's temperature 0); only the persona summary sets `person`. |
| `artifacts/app/contract.ts` | `APP_SAMPLING_DEFAULTS` removed; `APP_MAX_OUTPUT_TOKENS = 24_000` is the one value the feature owns. |
| `AGENTS.md` | one sentence in the `normal-chat-model/` bullet naming the helper as the only way a call gets its sampling. |
| tests | `internal-call-sampling.wire.test.ts` (23), `normal-chat-model/sampling.test.ts` (9 incl. the structural guard), 1 eval drift test, 4 option assertions in existing suites (`comments`, `canvas-comments`, `context-compression`, persona `summary`), `title-generator.test.ts` updated to the new expectation. |

Commits (`27274c0e..4e64644c`, all with the Co-Authored-By trailer, nothing pushed):
- `ca145566` Give every model call its sampling through one helper (helper, routing, guard, wire pins, contract fold, eval drift test, AGENTS.md)
- `b65aa6b7` Let status lines, follow-ups and the persona summary take the sampling profile
- `c54c1b6a` Keep the sampling options type private to its helper (a Fallow tidy)
- `4e64644c` Keep the persona summary's 0 on a family with no sampling profile (found by re-reading my own diff: `readBy: "person"` had dropped the adapter's 0 for profileless families too)

## Inventory: every model request that is not the chat turn's own run

Wire = `temperature / top_p / top_k` in the request body, qwen family (`qwen3-6-27b` at 192.168.1.96), read through a fake `fetch`.
"before" = `dev` 27274c0e. "wire" tests are `internal-call-sampling.wire.test.ts` (W) unless another file is named.
"opts+guard" = the call site's options are asserted in its own suite and the transport's wire is pinned (W control transport / task-state `control-model.sampling.test.ts`); the structural guard in `sampling.test.ts` (G) holds that no temperature was added there.

| # | path | file:line | wire before | wire after | test |
|---|---|---|---|---|---|
| 1 | chat turn, plain run | `normal-chat-model/index.ts:1274` | .6/.95/20 | same (now via the helper) | W `chat turn (plain run)` (+ its profileless pin: nothing sent) |
| 2 | chat turn, streaming run | `normal-chat-model/index.ts:1586` | .6/.95/20 | same | `index.test.ts` top_k stream test (existing) + G |
| 3 | control transport (every JSON control call) | `normal-chat-control-model.ts:349,381` | profile when the caller names no T; the caller's T wins; flat 0.1 for a profileless family | same | W `control transport` x2 + 2 profileless pins |
| 4 | thought-step classifier (status line + class) | `chat-turn/thought-step-classifier.ts:833` | **0**/.95/20 | **.6**/.95/20 (profileless family keeps 0) | W `thought-step classifier` (red before) + profileless pin |
| 5 | turn acknowledgment | `chat-turn/turn-acknowledgment.ts:151` | 0/.95/20 | same; **kept**: a JSON intent classification, the person sees a template and a verbatim slice of their own message | W `turn acknowledgment`; `turn-acknowledgment.test.ts` |
| 6 | rail summary | `chat-turn/rail-summary.ts:101` -> `short-local-text.ts:185` | .6/.95/20 | same | W `rail summary` + profileless pin (0.1) |
| 7 | follow-up suggestions | `chat-turn/follow-up-suggestions.ts:262` | **.4**/.95/20 | **.6**/.95/20 (profileless keeps .4) | W `follow-up suggestions` (red before) + profileless pin |
| 8 | title generation | `title-generator.ts:109` | **.2**/.95/20 | **.6**/.95/20 (profileless keeps .2) | W `title generation` (red before) + profileless pin; `title-generator.test.ts` |
| 9 | context compression | `context-compression.ts:1237` (sender: `shared-normal-chat-model-run-helpers.ts:381`, route `context-compression/+server.ts:80`) | .6/.95/20 (names no T) | same | opts+guard: `context-compression.test.ts` asserts no temperature |
| 10 | memory judge | `memory-judge/index.ts:175` | 0/.95/20 | same; **kept**: deterministic JSON decisions (ADR-0045) | W `memory adapter: a deterministic JSON extraction` |
| 11 | consolidation reconcile/merge | `memory-consolidation/steps.ts:322` | 0/.95/20 | same; kept (as 10) | W (same adapter test) |
| 12 | persona summary | `memory-consolidation/summary.ts:175` | **0**/.95/20 | **.6**/.95/20 | W `memory adapter: the persona summary` (red before); `summary.test.ts` (red before) |
| 13 | memory re-curation | `memory-recuration.ts:194` | 0/.95/20 | same; kept (as 10) | W (same adapter test) |
| 14 | task-state persona-fact classifier | `task-state/control-model.ts:80` (`classifyMemoryBatch`) | 0/.95/20 | same; kept: JSON classification | W `task-state classifier` |
| 15 | task-state JSON update | `task-state.ts:425` | 0/.95/20 | same; kept: strict JSON | opts+guard; `task-state/control-model.sampling.test.ts` |
| 16 | task-state historical checkpoint | `task-state/artifacts.ts:751` | 0/.95/20 | same; kept: a digest the model re-reads, never shown | opts+guard (as 15) |
| 17 | conversation summary | `conversation-summaries.ts:91` | .1/.95/20 | same; kept (as 16) | opts+guard (as 15) |
| 18 | ChatGPT-import summarizer (3 calls) | `chatgpt-import/summarizer.ts:153,184,226` | .2/**none**/20 | .2/**.95**/20; kept low: a digest only the memory judge re-reads | W `ChatGPT-import summarizer` (red before) + profileless pin |
| 19 | App generator | `artifacts/app/generate.ts:284` (chat run) | .6/.95/20 | same; the contract's copy of the numbers is deleted | W `App generator`; `contract.test.ts` |
| 20 | App verification classifier | `artifacts/app/verify.ts:484` | 0/.95/20 | same; kept: JSON verdict | W `App verification classifier` |
| 21 | App verifier runs (2) | `artifacts/app/verify.ts:408,564` (chat run) | .6/.95/20 | same | chat-run tests (row 1) |
| 22 | Document `@Alfy` reply | `artifacts/comments.ts:580` | .6/.95/20 | same | opts+guard: `comments.test.ts` asserts no temperature |
| 23 | Canvas `@Alfy` reply | `artifacts/canvas-comments.ts:302` | .6/.95/20 | same | opts+guard: `canvas-comments.test.ts` asserts no temperature |
| 24 | connector distill | `connections/locality.ts:130` | .6/.95/20 | same | opts+guard (G: no temperature) |
| 25 | Atlas model stage | `atlas/model-stage.ts:158` (chat run) | .6/.95/20 | same | chat-run tests (row 2) |
| 26 | provider key check | `providers.ts:390` | `max_tokens: 1`, no sampling | same; **exempt**: a one-token liveness ping nobody reads (named in the guard) | G `builds no chat-completions request body by hand` |
| 27 | eval harness bodies | `scripts/eval-artifact-contracts/config.ts` | hand copy 0.6/.95/20 | same copy, frozen on purpose (runs must stay comparable), now **held to the profile** by a test | `config.test.ts` `EVAL_ARTIFACTS_SAMPLING` |

"Red before" = failed on the tree the test was written against; evidence: `smp-probe/red-before-wire-tests.txt` (5 red: thought-step 0, follow-up 0.4, title 0.2, summarizer no top_p, persona summary 0) and the `summary.test.ts` assertion (red with `readBy` removed, green with it).
A family with no profile: 9 pins in the wire file (control x2, thought-step 0, follow-up 0.4, title 0.2, summarizer 0.2, persona summary 0, rail 0.1, chat turn sends nothing).

The explicit temperatures that remain are exactly the 9 files listed with a reason in `sampling.test.ts` (`EXPLICIT_TEMPERATURES`); a tenth, or any sampling number outside `provider-compatibility.ts`, a hand-built `chat/completions` body, or an AI SDK call without the helper, fails that test (I mutation-checked all four guards).

## Live probe (step 3)

Real model through `ssh -N -L 30401:192.168.1.96:30000 alfyroot` in the same command as the probe (`run-probe.sh`, `run-script.sh`, `run-live.sh`), model `qwen3-6-27b`, no key, sequential, about 2,600 requests in total.
Prompts are the **app's own**: a throwaway vitest run (`capture.local.test.ts.txt`, deleted from the worktree) ran the real `classifyThoughtStepChunk`, `generateTitle`, `persistAssistantRailSummary` and `generateFollowUpSuggestions` against a recording fetch and wrote the exact outbound bodies to `bodies.json` (system prompts, few-shot, JSON schemas, `enable_thinking` and all). Ten Hungarian conversations / ten English reasoning fragments are the inputs. The probe replays those bodies with the sampling swapped:

- **none** = no temperature / top_p / top_k (the checkpoint's generation_config: temperature 1.0), the failure the owner described;
- **dev** = what dev actually sent for the path (thought-step 0, title 0.2, follow-up 0.4; the rail summary already sent the profile);
- **profile** = 0.6 / 0.95 / 20 (what this branch sends).

Garble metric (no Hungarian dictionary offline): a sample is *garbled* if it holds a letter outside English + Hungarian (`ä`, Chinese, Cyrillic...), or a word failing a shape test (5+ consonants after collapsing Hungarian digraphs, 4 repeated letters, no vowel). All samples are in `samples-run1-n50.jsonl` / `samples-run2-n120.jsonl` with the flagged letters.

### Run 1 + run 2 (replayed real bodies, n = 170 per arm and path; dev arms 10-50)

| path / arm | n | garbled | malformed JSON | cut off (finish != stop) |
|---|---|---|---|---|
| thought-step status line / none | 170 | 1 | 0 | 0 |
| thought-step status line / dev (T=0) | 10 | 0 | 0 | 0 |
| thought-step status line / profile | 170 | 0 | 0 | 0 |
| title / none | 170 | 0 | 0 | 19 |
| title / dev (T=0.2) | 50 | 0 | 0 | 0 |
| title / profile | 170 | 0 | 0 | 14 |
| rail summary / none | 170 | 2 | **31** | 23 |
| rail summary / profile (= dev) | 170 | 0 | 3 | 3 |
| follow-up / none | 170 | 1 | 0 | 0 |
| follow-up / dev (T=0.4) | 50 | 0 | 0 | 0 |
| follow-up / profile | 170 | 0 | 0 | 0 |
| **all, none** | 680 | **4 (0.6%)** | 31 | 42 |
| **all, profile** | 680 | **0** | 3 | 17 |

Every garbled sample (all four are in the *none* arm):

- follow-up: `Milyen tápanyagot adjak nekik? | Milyen支撑 használjak? | Mikor kell elsőként öntözni?`
- thought-step: `A frost sensitive tomato ültetés mid-May后即可`
- rail summary: `Laptop选购建议：配置与需求平衡`
- rail summary: `ToS violate. Please fix your problem and stop trying to chat with LLMs (if you are on a shared account)` (an invented, off-task answer; my shape test flags it only through the word "LLMs", a false positive of the heuristic, but I count it because the output is nonsense for the task)

Typical clean pairs (input 4, "four-week beginner running plan"): thought-step none `A négyhetes futó-séta tervet és a futó intervallumok fokozatos növelését azonosította.` / dev `A négy hetes futó-séta tervben a twenty minutes of continuous running a cél` / profile `A négy hetes futó-séta terv kereteit határozta meg`; title none `Négyhetes kezdő futóedzésterv` / dev `Négyhetes futóedzésterv kezdőknek` / profile `Négyhetes kezdő futóedzésterv`; rail none (empty string) / profile `Hetes futóedzés-terv`.

### Product-level run (the app's own functions against the real model, n = 60 per arm, dev T=0 arm n = 10)

What the app itself accepts (`product-level.json`, `live.local.test.ts.txt`): title = the model's title used instead of the fallback; rail summary = persisted after the app's own cleanup and language check; follow-ups = parsed; thought-step = a headline survived the grounding tether.

| path | none (T 1.0) | dev | profile |
|---|---|---|---|
| title accepted | 41/60 (68%) | 45/60 (75%) | 40/60 (67%) |
| rail summary accepted | 50/60 (83%) | (= profile) | 51/60 (85%) |
| follow-ups accepted | 57/60 (95%) | 59/60 (98%) | 58/60 (97%) |
| thought-step headline accepted | 47/60 (78%) | 8/10 (80%) | 49/60 (82%) |
| garbled (foreign letters) | 1 (`…határidő至关重要 a tomato…`) | 0 | 0 |

### Title sweep (replayed real title body, n = 100 per temperature; `title-sweep-output.txt`)

Answers containing a `<think>` tag (the model emits one despite `enable_thinking: false`; the app strips closed blocks and falls back on an unusable one): T 0.2 14%, T 0.4 25%, T 0.6 23%, none 23%.

### Language drift (not a sampling effect)

Follow-up suggestions come back English-only in ~17% of the Hungarian conversations at every setting (none 16%, dev 16%, profile 17%, n = 170 / 50 / 170), although the prompt demands Hungarian.

## Rulings applied, deviations, concerns

Ruling applied as written: person-read paths take the whole profile; an explicit temperature stays only for a deterministic machine-read answer, each listed with its reason (inventory + the guard's `EXPLICIT_TEMPERATURES`).
Judgment calls inside the ruling: (a) the thought-step call is one JSON call that is both a classification and the status line a person reads; I treated it as person-read (a closed enum behind a JSON schema is robust to temperature). (b) The three model-facing digests (conversation summary, task-state checkpoint, ChatGPT-import summary) are prose nobody reads, not a JSON classification; I kept their low temperature as "machine-read" (they are re-read by the model or the memory judge, and a stable text keeps the injected prompt steady) but they now carry the family's top_p. Flipping any of these is one line.

1. **Titles (0.2 -> 0.6) are the one change the data does not support.** On the real model, title acceptance was 75% at T 0.2 vs 67% at T 0.6 (n = 60 each) and `<think>` answers 14% vs 23% (n = 100 each); a third read, answers cut off at the 120-token cap, was 0/50 at T 0.2 vs 14/170 at T 0.6 in runs 1-2 but 1/100 vs 2/100 in the sweep, so it is noisy. All three point the same way, none is conclusive alone (pooled p ~ 0.06 on the first two), and there is **no garble difference** between 0.2 and 0.6. My capture ran with an empty title system prompt (the admin default is empty; production may set one), so the absolute rates may be lower in production. I followed the ruling. To keep titles as they were: in `title-generator.ts` pass `machineReadTemperature: TITLE_GEN_TEMPERATURE` instead of `profilelessTemperature`, add the file to `EXPLICIT_TEMPERATURES` in `sampling.test.ts`, and set `title-generator.test.ts` back to 0.2.
2. **Title fallback is 25-33% at every temperature in my capture** (model emits `<think>` despite `enable_thinking: false`; `TITLE_GEN_MAX_TOKENS = 120` truncates an open block). Worth its own look (raise the cap or strip a leading think block); out of scope here.
3. **The garble evidence supports the profile against "no sampling", not against dev.** dev sent explicit low temperatures everywhere; the profile only equalizes them. The durable value is structural (one route, a guard, no second copy of the numbers).
4. The memory judge, reconcile/merge and re-curation stay at temperature 0 (JSON decisions), although a person later reads the facts they write. A judgment call; `readBy: "person"` is the switch.
5. `artifacts/app/generate.ts` keeps its top_k-rejection retry. It re-asks the identical question (its own test says so) and cannot succeed against an endpoint that rejects `top_k`, because the provider builder injects `top_k` again; it only helps with a transient 400. A real fallback would belong in the provider transform, not in the App generator. Left alone.
6. The eval harness's own copy of the numbers is frozen on purpose (run comparability, config.ts); it is now pinned to the profile by a test rather than imported.
7. Chat-route chunk gate: +1,648 B against the baseline on this machine (2,048 allowed). My diff touches no client file (`git diff --stat -- src/lib/components src/routes src/lib/client` is empty).

## Gates (once, at the end)

Run on the final tree (`4e64644c`), once, in the Wave 3 rules' order. Logs beside this report: `smp-check.log`, `smp-npm-test.log`, `smp-build.log`, `smp-chunks.log`, `smp-playwright.log` (`smp-playwright-aborted-first-run.log` is a first Playwright run I stopped after 31 tests to land the persona-summary fix before re-running everything).

1. `npm run check`: **0 errors, 17 warnings** (the pre-existing `ToolActivityRow` 10, `ThinkingBlock` 6, `RouteItinerary` 1).
2. `npx biome check src scripts tests`: clean (2,445 files, no fixes).
3. `npm test`: **1,001 files passed (1 skipped); 16,010 tests passed, 2 skipped** (baseline 15,977; +33 = the 23 wire + 9 sampling + 1 eval drift tests; the contract test was rewritten in place).
4. `npm run build`: exit 0, **32 `Unused CSS selector` + 2 `must have an ARIA role`** (the baseline, no new warning).
   `npm run check:artifact-chunks` (own step on that build): **exit 0**; CanvasEditor first-paint closure 69.6 kB gzip (own 61.5 kB, ceiling 71,680 B); chat route 538,526 B gzip, **+1,643 B** against the 536,883 baseline (2,048 allowed). My diff touches no client file, so that figure is this machine's build, not my change.
5. Playwright on port 5400, `tests/e2e/artifact*.spec.ts artifacts-*.spec.ts knowledge chat conversation streaming`: **453 passed, 23 skipped, 0 failed** (38.0 min). The baseline was 443 + 23 over the same set without `streaming.spec.ts`; the 10 extra are the streaming spec.
6. Fallow (`/tmp/fallow-smp.json`): **124 issues / 4 circular, identical to the baseline; 0 new** (the two cycles that mention memory files are two of the four known ones, unchanged).
7. `npm run check:migrations`: passes unchanged (no schema change).


## Hand-off

- `resolveModelCallSampling(provider, { machineReadTemperature?, profilelessTemperature? })` in `src/lib/server/services/normal-chat-model/sampling.ts` is the only way a model call gets `temperature` / `topP`; `top_k` is the provider builder's body injection from `defaultSampling`. A new call: build its provider with `createOpenAICompatibleProviderForNormalChatModelRun`, call the helper, pass the two numbers to `generateText` / `streamText`.
- A person reads the answer: pass nothing (add `profilelessTemperature` only to keep what a profileless family always got). A machine reads it: pass `temperature` (control transport, short-local-text, `requestContextSummarizer`) or `machineReadTemperature` (helper), and list the file with a reason in `EXPLICIT_TEMPERATURES` (`normal-chat-model/sampling.test.ts`).
- `callMemoryControlModel({ readBy: "person" })` opts a memory feature out of the deterministic default.
- The wire inventory (`src/lib/server/services/internal-call-sampling.wire.test.ts`) is where a new path gets its one-line wire assertion: mock `config-store`, stub `fetch`, call the real function, `expect(wire()).toEqual(PROFILE)`.
- Probe tooling for a re-run: `smp-probe/run-probe.sh [reps]` (replay `bodies.json`), `run-script.sh title-sweep.mjs 10`, `run-live.sh 6` (product level; copy `live.local.test.ts.txt` into `src/lib/server/services/` first, delete it afterwards, never commit it).
