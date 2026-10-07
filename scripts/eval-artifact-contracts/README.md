# Artifact-contract eval harness

The model-contract evaluation harness for Feature 2 · Artifacts (see
`docs/plans/claude-at-home-2/plan.md` § The model-contract evaluation
harness, and `decisions.md` rulings 25 and 44). Follows the same CI/live
split as `scripts/eval/README-option-a-fidelity.md`: a pure scoring module
that is unit-tested in CI, and a live orchestration script that talks to a
model and is not.

## What exists today

**Slice 0** shipped the shape every type slice's suite runs through:
`types.ts` (`EvalCase`, `EvalAttempt`, `EvalVerdict`, `EvalScoreResult`), a
generic placeholder in `scoring.ts`, and an empty case registry in
`cases.ts`.

**Slice 5a** (this slice) lands the harness's **core** on that skeleton —
everything a type slice's own suite plugs into, but no suite itself:

- `config.ts` — every `EVAL_ARTIFACTS_*` env switch, plus the fixed sampling
  constants (temperature 0.6, top_p 0.95, top_k 20, max_tokens 24000) and the
  retry/circuit-breaker constants.
- `client.ts` — the **only** module that reads an API key. Resolves an
  endpoint from `EVAL_ARTIFACTS_BASE_URL` + `_MODEL` only — both are required
  for a live run, and `resolveEvalArtifactsClient` throws one message naming
  both (no network call made) if either is missing, rather than falling back
  to anything. `_API_KEY` stays optional; works with **no key** at
  all against a local OpenAI-compatible server (no `Authorization` header is
  sent when there is no key, rather than one carrying an empty token). Sends
  `chat_template_kwargs: { enable_thinking: false }` when a suite needs
  thinking off (Qwen defaults to thinking on) — the same mechanism the app
  itself uses, see `normal-chat-model/provider-compatibility.ts`'s
  `buildThinkingProviderOptions` (the "qwen" case).
- `run.ts` — the runner: the full `--suite`/`--replay`/`--skip-model`/
  `--limit`/`--only`/`--out`/`--help` flag table (see below), the
  known-bad-first refusal, strictly sequential execution with one retry per
  case and a stop after two consecutive 429/5xx failures, and the "no suites
  registered yet" graceful exit (`0`, never a crash). A *live* run with no
  model endpoint configured is a harder failure, not a graceful one — see
  below. `parseArgv`, `runSuite` and `recordSuiteResponses` are exported and
  take their dependencies (the case registry, the model client, the scorer, a
  committed-response loader) as parameters, so `run.test.ts` proves all of
  this against a **fake** suite and fixture set — this slice ships no real
  suite, and writes none.
- `scoring.ts` — `SUITE_SCORERS`, the per-suite scorer dispatch table (empty
  today; `getSuiteScorer` falls back to the Slice 0 generic scorer for any
  suite with nothing registered), plus the results-leak test (below).

**Nothing here talks to a model unless you configure one.** Run
`npx tsx scripts/eval-artifact-contracts/run.ts --suite <name>` with nothing
configured and it exits `0`, explaining that no cases are registered yet
(today, that is every suite except `document`, below).

**Slice 1** lands the **first real suite** on that core: `document`, scoring
the `edit_artifact` patch contract (`slice-1.md` Task T13) —

- `suites/document.ts` — 8 cases: the six required by the task (a clean
  patch; a block the user changed since the model's read, which must
  refuse; a `replaceRange` whose `find` occurs twice, which must refuse
  rather than guess; a patch that stays inside the block it was asked to
  touch; a three-op mixed patch; a Hungarian-language request against a
  Hungarian document) plus a `block_missing` case (Step 1.1's own scorer
  requirement) and one `knownBad` case (a hand-written answer that ignores
  the JSON-only instruction and responds in prose).
- `scoring.ts`'s `documentScorer` runs the model's own patch ops through the
  REAL engine (`$lib/shared/artifact-document/patch`'s `applyPatchSet`)
  against each case's fixture, then asks the fixture's own `verify` what
  that outcome means — refusing correctly (or proactively sending `[]`
  rather than guessing) counts as `good`, never automatically `bad` just
  because nothing applied (ruling 25).
- Run for real against the box's configured endpoint
  (`npx tsx scripts/eval-artifact-contracts/run.ts --suite document`):
  **7/7 good, known-bad failed as expected.** One fixture's `verify` was
  fixed as a direct result of that run — see `suites/document.ts`'s
  `REFUSES_MISSING_BLOCK` comment for what the first live run caught. The
  committed `fixtures/document/responses/*.json` are the real model's own
  recorded answers (`EVAL_ARTIFACTS_SKIP_EVAL=1`), except the known-bad one,
  which stays hand-written on purpose (the model does not naturally ignore
  the format — that fixture exists to prove the SCORER catches it if it
  ever does, not to reproduce a failure this model actually has).

**Slice 3** (Wave 3) adds `canvas`: can the real model hold the Canvas contract — read
a board with `read_artifact`, change it with `edit_artifact` ops, make one with
`create_artifact`? Its cases go **through the real tools** (ruling 62), which
`client.ts` cannot carry and ruling 44 keeps closed, so this slice ships beside the
core:

- `tool-path.ts` — sends the whole tool catalogue exactly as a chat turn does (read
  from the app's own frozen `tool-catalogue.<lang>.snapshot.txt`, never re-typed) and
  reads the answer back as a recorded envelope (`toolCalls`, `content`,
  `finishReason`, and any `priorSteps`). A case may name tools a conversation would
  not have (`withoutTools`) and take a bounded follow-up: a lookup the suite can
  answer is answered and the model goes on, at most 4 steps; the call that is scored
  is never answered.
- `run-tool-suite.ts` — hands the harness's own `runSuite` a client built on it: the
  same known-bad-first gate, one retry and circuit breaker. A known-bad case is
  **never sent**: its hand-written answer is served from disk (ruling 59).
  `npm run eval:artifacts:tools -- --suite canvas`.
- `suites/canvas.ts`, `fixtures/canvas/` — six requests, each declaring its language
  (ruling 65): the prototype's "arrange Saturday" on a board whose notes are piled up,
  a Sunday frame with three stickies (English and Hungarian), "remove the museum note
  and connect lunch to the walk", and a board for a Vienna weekend from nothing
  (English and Hungarian). An edit case carries the artifact catalogue block the app
  appends to the message, and when the model reads the board it is handed the real
  `read_artifact` payload (`canvasReadBlocks`, compared with the tool's own answer by
  a test). The scorer applies the model's ops with the app's own vocabulary
  (`boardOpsArraySchema`, `validateBoardDiff` through `runOps`) and checks the board
  they leave: every diff parses and lands (a refusal is a miss), every requested item
  is there, nothing sticks out of its frame, no two nodes overlap (footprint: a node's
  stored size, or its kind's default width (a note's 190, a checklist's 340, a chart's
  360) and the height its words, items or plot take, the estimate the model is told and
  the read reports: `estimatedNodeSize`), labels are not empty, nothing was removed that the request
  did not name, and the new words are in the declared language. A create is judged
  through `parseCanvasCreateBody`, the tool's own parse. Every reason starts with the
  check that found it (`routing:`, `tool-args:`, `schema:`, `refusal:`, `request:`,
  `frames:`, `overlap:`, `labels:`, `removed:`, `language:`, `note:`, `ok:`).
- Known-bad (hand-written, `responses/canvas-known-bad-*.json`): a diff that leaves two
  notes piled up, one that moves a note out of its frame, one with an op the vocabulary
  does not have, one that removes a note the request never named. Each fails for
  exactly the reason it exists; a test proves `runSuite` refuses to count real scores if
  one is let through.

```bash
# Live, through the tunnel on the runner's own port, one command (see "Running it" for
# why the tunnel carries -o ControlMaster=no -o ControlPath=none):
ssh -N -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \
  -L 30020:192.168.1.96:30000 alfyroot & T=$!; sleep 3; \
  EVAL_ARTIFACTS_BASE_URL=http://127.0.0.1:30020/v1 EVAL_ARTIFACTS_MODEL=qwen3-6-27b \
  npx tsx scripts/eval-artifact-contracts/run-tool-suite.ts --suite canvas; kill $T
#   --repeat 3            three sequential runs, to estimate a rate
#   --write-responses     record the answers under fixtures/canvas/responses/
#   --responses-out DIR   keep every answer of every run for a closer look
# Replay (no model, no key):
npx tsx scripts/eval-artifact-contracts/run.ts --suite canvas --replay
```

**What the live runs measured** (`qwen3-6-27b`, thinking off, sequential, 5 repeats of the
six cases each; the committed `fixtures/canvas/responses/` are one such run). A measurement,
not a pass: the suite's bar is a clean first try, and it is not met. "Good" means nothing
was wrong with any call and the board the conversation left passes the rubric.

| Description | Answers | Good | Arrange | Add Sunday (en / hu) | Remove and connect | Create (en / hu) |
|---|---|---|---|---|---|---|
| v1 (as first registered) | 30 | 18 | 3/5 | 3/5 / 3/5 | 5/5 | 2/5 / 2/5 |
| final (note size, arrows are not blocks) | 30 | **24** | 3/5 | 5/5 / 5/5 | 5/5 | 3/5 / 3/5 |
| after RV-3 (the geometry the reader sees) | 18 | **15** | 3/3 | 2/3 / 1/3 | 3/3 | 3/3 / 3/3 |
| T9, 2026-10-07, vLLM 0.31 + FP8 KV, thinking off | 18 | **17** | 3/3 | 3/3 / 3/3 | 3/3 | 2/3 / 3/3 |
| T9, same day, thinking on (the chat turn's default) | 18 | **15** | 3/3 | 3/3 / 3/3 | 3/3 | 2/3 / 1/3 |

The last row is a different measurement, not a better model: the review of the Canvas (RV-3,
C2) found that the rubric measured every note as 84 tall while the panel draws a note as tall as
its words (64 for one or two lines, 18 more per further line, about 18 characters a line at
190 wide), and that what Alfy adds had no stored width, so it was drawn as wide as its words
ran (861 wide through a 420-wide frame). The app now stores the shared 190 width, the read, the
tool text and this rubric all use `estimatedNodeHeight`, and the create example obeys its own
layout rule. 3 repeats of the six cases, thinking off, sequential: 18 answers, 15 good, 1
acceptable (a Hungarian edit made without reading the board first) and 2 bad: a mistyped id in
an `add_edge` (mended in the next step) and a note at y 240 in a 300-high frame (its smallest
size, 64, already ends at 304). The recorded run is one more such run (6 of 6 good; a single
run is not a rate). Earlier rows were scored against the 84-tall geometry and are not
comparable with this one.

What failed, over the 30 final answers (6 bad): a note that sticks out of its frame (3: the
model sized or enlarged the frame a note short — arithmetic on 84-tall notes), two frames
overlapping (1), one board whose arrows were filed with the blocks (1), an invalid `tone` (1,
mended in the next step). In v1's 30 (12 bad): notes or frames on top of each other (4), notes
sticking out of their frame (6), a mistyped id in an `add_edge` (2, mended), arrows filed with the
blocks (2), a script call still open at the last step (1). The edit cases with a stored board are
the reliable half (Add Sunday 10/10 and Remove and connect 5/5 with the final wording); the
arrange case is the one that needs arithmetic (five notes into a 460x360 frame) and the model
gets it right 3 times in 5. The first 24 answers, recorded before the harness answered
`run_python` and `map_route` (the model checks spacing with a script, or looks a place up),
scored 13 good.

Two ways to make a board were compared on the create cases, 20 answers each: the board in the
`body` (12 good) against an empty board followed by `edit_artifact` ops (11 good). The
structured ops did not beat the JSON string: an array of ops that the tool-call parser cannot
read (a brace short after a nested checklist) arrives as text, which the tool now says
(`tool-args.ts`); it was mended in the next step in 4 of 6 answers, and an arrow filed with the
blocks in 6 of 6.

## What the all-suite run measured (Slice 5b · T9, 2026-10-07)

Every suite on the real model, recorded, and re-scored with `--replay`. `qwen3-6-27b`
(the box's production Flash-Next, vLLM v0.31 with FP8 KV), through a tunnel on one local
port, strictly sequential, one retry at most. Sampling is the app's own: temperature 0.6,
top_p 0.95, top_k 20, and `sampling.test.ts` reads what both request builders put on the
wire against `resolveModelCallSampling` and the family profile, so the harness cannot
drift from the product (a mutated temperature fails both wire tests). Thinking is off,
the suites' own policy (see below for what that leaves out). Every known-bad answer was
served from disk and never sent (ruling 59), and in every pass every known-bad answer
failed as declared (the gate would have refused to count the pass otherwise). A pass is a
full run of every real case; three passes of each suite, so a rate is over three samples
and nothing here is a pass mark.

| Suite | Real cases (+ known-bad) | Passes | Answers | Good | Acceptable | Bad | Known-bad refused | Committed responses |
|---|---|---|---|---|---|---|---|---|
| `document` | 7 (+1) | 3 | 21 | **21** | 0 | 0 | 1 of 1, every pass | pass 1 |
| `app` | 10 (+1) | 3 | 30 | **27** | 3 | 0 | 1 of 1, every pass | pass 1 |
| `verification` | 4 (+1) | 3 | 12 | **10** | 2 | 0 | 1 of 1, every pass | pass 1 |
| `canvas` | 6 (+4) | 3 | 18 | **17** | 0 | 1 | 4 of 4, every pass | pass 2 |

The records this run replaces were single passes made before the server moved to vLLM
v0.31 with FP8 KV (2026-10-04): `document` 7 of 7 good, `app` 10 of 10 and `verification`
4 of 4 (all 2026-09-26), `canvas` 6 of 6 (2026-09-30). The harness's own sampling did not
change in between: it was already 0.6 / 0.95 / 20.

**What is not good, and why** (every fixture below is as it was; none was changed):

- `app`: no answer was broken, and every pass had exactly one `works-with-glitches`, a
  different app each time. Pass 1, `app-09` (the cooking unit converter): an uncaught
  `Cannot read properties of undefined (reading 'addEventListener')`. Pass 2, `app-03`
  (the Hungarian loan calculator): the browser pass's smoke step found no enabled button.
  Pass 3, `app-04` (the English-Hungarian cards): clicking the four category buttons
  changed nothing in the DOM. The P1 baseline, which the suite is held to, is 10 of 10
  `works`; no pass reached it, and no pass had a `broken`, which is the line that fails
  the suite. Completion tokens 2,516-4,979 per app, 11.7-23.8 s.
- `verification`: in pass 1 the verifier named both bugs in `verification-wrong-unit`
  (the plural gloss "békák" for "frog") and `verification-wrong-key` (Bucharest is not on
  the Danube) but left each finding unsettled (`settled: false`), the first also under the
  wrong class (`mislabelled_aggregate`), which the scorer reads as acceptable: noticed,
  not confirmed. Passes 2 and 3 settled all three seeded bugs and stayed silent on the
  clean fixture. This harness has no tool loop, so the verifier runs without
  `research_web`.
- `canvas`: pass 1, `canvas-create-vienna-en`: `overlap: sticky "sun-heuriger" covers
  sticky "sun-concert"` (the model's own layout arithmetic on a board made from nothing).
  Per case over the three passes: arrange Saturday 3/3, add Sunday 3/3 (en) and 3/3 (hu),
  remove and connect 3/3, create Vienna 2/3 (en) and 3/3 (hu). Completion tokens 395-1,495
  per case (all its steps), 3.0-9.2 s.
- `document`: nothing failed in 21 answers (completion tokens 2-125, 0.2-0.7 s).

Against each suite's bar (`slice-5.md` §The eval harness): `document` meets it in every
pass. `verification` meets it in two of three passes and `canvas`, whose bar is every
fixture clean on a pass, in two of three; `app` has no `broken` answer but no pass of
10 of 10 `works`. ADR-0066 reads a suite below its bar as a change to the design rather
than to the bar, which is the owner's call; nothing here moved a bar.

**Which run is committed.** The committed responses (and the app's recorded browser
evaluations) are one pass of the run: the first, except `canvas`, whose first pass held
the one bad answer and whose second is the first without one. The replay gate reads a
recorded bad answer as a failure of the gate, not as a measurement of the model, so a
committed bad answer would turn CI red on yesterday's model rather than on today's
scorer. The rates above are over all three passes; the raw runs are not committed.

**What this does not measure, and what each measurement stands in for.**

- *Thinking.* The chat turn runs with thinking on unless the reader chose Quick
  (ADR-0061); only App generation is forced off by the product. Every suite here ran
  thinking off. Canvas was also run with thinking on (`--thinking on`, three passes,
  the tool path's `auto` choice): 15 of 18 good, all twelve edit answers good, and the
  creates 2/3 (en) and 1/3 (hu) clean: two overlaps and one board with notes sticking out
  of their frames (`canvas-create-vienna-en`, pass 1: `text "intro" covers frame "fri"`;
  `canvas-create-vienna-hu`, pass 1: `frame "frame-szombat" covers frame "frame-hasznos"`
  and pass 3: notes at y 240 and 480 sticking out of their frames). Thinking on took
  2,695 completion tokens for the arrange case in the first pass against 480-690 with it
  off, and 23-60 s for a create against 6-9 s. It did not make the creates better.
  `document` was not run with thinking on.
- *The `document` suite is not the real tool.* Its prompt is hand-written text that asks
  for a bare JSON array of three of the five ops, and its answer is scored by the real
  patch engine; it does not send the tool catalogue or read the `edit_artifact` call.
  Ruling 62 asks every suite to go through the real tool description and schema. The
  harness's tool path (`tool-path.ts`, `run-tool-suite.ts`) can carry it, but the suite
  has no tool-path registration and its scorer reads a text array rather than a call, so
  it was run as it is. `canvas` is the only suite that goes through the tools.
- *System and user are one message.* `generateApp` and `verifyApp` send their contract as
  the system message and the request as the user message; the `app` and `verification`
  cases send both as one user message (`client.ts` has no system role). The two are
  different roles in Qwen's chat template; whether that moves a result was not measured.
- *One answer, not the product's whole path.* `verification` does not run the classifier,
  `research_web`, the repair or the re-verification; `app` does not run the product's
  retry on a contract violation. Each is the model's one answer, scored by the
  product's own parser and audit.

## What each type slice adds (ruling 44)

Per `decisions.md` ruling 44, each type slice writes:

- `suites/<suite>.ts` — the suite's own prompts/scenarios.
- `fixtures/<suite>/**` — its fixtures, with a `known-bad/` set (at least one
  fixture that **must** score "bad") and committed `responses/*.json` (one
  file per case id, `{ "response": "...", "durationMs": 1234 }`) so
  `--replay` works in CI with no model call.
- Its own scorer, registered as one entry in `scoring.ts`'s `SUITE_SCORERS`.
- One entry in `cases.ts`'s `EVAL_CASES`.

| Suite | Slice |
|---|---|
| `document` | Slice 1 |
| `app`, `verification` | Slice 2 |
| `canvas` | Slice 3 |
| `slides` | Slice 4 |

**No type slice edits `run.ts`, `config.ts` or `client.ts`.** Slice 5b's own
task (T9) is the all-suite real run and this README's numbers (below); it is the one
task that edited the core after Slice 5a, to make ruling 59 the runner's own rule
(a known-bad answer is served from disk for every suite, never sent, never
re-recorded) rather than something only the canvas tool runner did.

## Running it

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # Node 22 only

# The contract gate — re-scores committed responses, no model call, no key:
npm run eval:artifacts:replay
# equivalent to: tsx scripts/eval-artifact-contracts/run.ts --replay --suite all

# A live run against a configured endpoint, one suite at a time:
npm run eval:artifacts -- --suite document

# The flag table:
npx tsx scripts/eval-artifact-contracts/run.ts --help
```

| Flag | Meaning |
|---|---|
| `--suite <name>` | `file`, `document`, `app`, `canvas`, `slides`, `verification`, or `all` |
| `--replay` | Re-score committed responses under `fixtures/<suite>/responses/`. No model client is constructed; no key is required. |
| `--skip-model` | Alias of `--replay` — the App prototype's own env-switch spelling (`PROTO_APPS_SKIP_MODEL`), offered as a flag too. |
| `--limit <n>` | Cap the number of *non-known-bad* fixtures run. The known-bad set always runs in full — limiting the harness's own gate would defeat it. |
| `--only <ids>` | Comma-separated fixture ids to run, filtering the *regular* set only. The known-bad set always runs in full regardless of `--only` — same reasoning as `--limit`: selecting a fixture to iterate on must not be able to silently disable the gate. |
| `--out <dir>` | Override the `results/` output directory. |
| `--help` | Print the switch table. |

Every flag has an `EVAL_ARTIFACTS_*` env-var equivalent (see `config.ts`); a
flag overrides its env switch. `EVAL_ARTIFACTS_SKIP_EVAL=1` calls the model
and writes raw responses under `fixtures/<suite>/responses/` **without**
scoring anything — this is how you (re-)record a suite's committed responses
after a prompt or contract change, before committing them for `--replay`.

### What has to be configured for a real (non-`--replay`) run

- **An OpenAI-compatible endpoint — both required, no fallback.**
  `EVAL_ARTIFACTS_BASE_URL` and `EVAL_ARTIFACTS_MODEL` must both be set;
  `EVAL_ARTIFACTS_API_KEY` stays optional (the local vLLM needs none).
  `resolveEvalArtifactsClient` throws one message naming both variables, and
  makes no network call, if either is missing — there is no longer a
  `~/.config/opencode/opencode.json` fallback. That file let a run silently
  talk to whatever provider it names, under the owner's own key, and one
  slice's "live" eval ended up measuring that provider instead of the
  production model (ruling 54). Neither variable, nor a key, is required for
  `--replay`.

  Reach the production model through a tunnel that opens and closes in one
  command, on the runner's own local port:

  ```bash
  ssh -N -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes -L 30000:192.168.1.96:30000 alfyroot & T=$!; sleep 3; EVAL_ARTIFACTS_BASE_URL=http://127.0.0.1:30000/v1 EVAL_ARTIFACTS_MODEL=qwen3-6-27b npm run eval:artifacts -- --suite <suite>; kill $T
  ```

  The two `-o` options are not decoration. A machine whose ssh config says
  `ControlMaster auto` with a `ControlPersist` time (the owner's does, for this
  host: 600 seconds) turns the first `ssh -N -L ...` into a background control
  master that outlives the command: `$!` is the already-exited foreground client,
  `kill $T` kills nothing, and the forward stays open for ten minutes after the run
  (and any other session to the host would multiplex over it). With
  `ControlPath=none` the tunnel is its own connection and dies with `kill $T`.
  Check `pgrep -fl 'ssh -N'` is empty afterwards.

  Runs stay sequential — the model is shared — and recorded responses under
  `fixtures/<suite>/responses/` come from `qwen3-6-27b` only.

## Adding a fixture (for a type slice)

1. Add a case to `cases.ts`'s `EVAL_CASES[<suite>]` (`{ id, suite,
   description, prompt }`; set `knownBad: true` for a fixture that must
   fail).
2. Record its response — either hand-write
   `fixtures/<suite>/responses/<id>.json` for a known-bad fixture (you
   already know what a bad answer looks like), or run
   `EVAL_ARTIFACTS_SKIP_EVAL=1 npx tsx scripts/eval-artifact-contracts/run.ts --suite <suite> --only <id>`
   against a real endpoint to record a live one.
3. Register (or extend) the suite's scorer in `scoring.ts`'s
   `SUITE_SCORERS`.
4. `npx tsx scripts/eval-artifact-contracts/run.ts --replay --suite <suite>`
   should now score it.

## Re-recording a suite

`EVAL_ARTIFACTS_SKIP_EVAL=1 npx tsx scripts/eval-artifact-contracts/run.ts --suite <suite>`
calls the configured model for every real case in the suite (skipping the
known-bad gate entirely — nothing is being trusted yet) and overwrites
`fixtures/<suite>/responses/*.json`, except the suite's known-bad answers: they are
hand-written, never asked of the model and never overwritten (ruling 59). The app's
recording pass also runs the browser step and writes `fixtures/app/evaluations/`.
Review the diff before committing: a contract or prompt change is exactly when
responses are expected to move. To record and keep every pass of a rate, run the
record, then `run.ts --replay --suite <suite> --out <dir>` to score it, and copy
`fixtures/<suite>/responses/` aside before the next pass; the canvas tool runner
does the same in one command (`--write-responses`, `--repeat`, `--responses-out`).

## The key rule, in one place

`client.ts` is the only module that reads an API key — from
`EVAL_ARTIFACTS_API_KEY` only, optional, with no config-file fallback — and it
never returns or logs it: the key lives only inside `send`'s closure, never
as a property of the returned client object. `scoring.test.ts`'s
"no API-key shape reaches a results file" suite greps a results-shaped
directory for anything matching an opaque-token pattern (32+ alphanumeric/
dash/underscore characters including a digit) on every run of this file, not
only when someone remembers to add a fixture for it.

## Results

`scripts/eval-artifact-contracts/results/` is gitignored — results are not
source, the same rule `scripts/eval/results/` already follows. `run.ts`
writes `results/results.json` (generation timestamp + every suite's report);
a screenshot gallery, where a suite wants one (Canvas's arrangement
screenshots, named in slice-5.md), is that suite's own addition, not part of
this core. Nothing here is a dependency of `npm test` or `npm run build`; CI
runs `config.test.ts`, `client.test.ts` (pure — no real disk/network
access), `scoring.test.ts` and `run.test.ts` (the fake suite described
above) as part of the unit tests, and the `Artifact contract replay` step of
`.github/workflows/ci.yml` runs `npm run eval:artifacts:replay` (`--replay --suite
all`: every committed answer re-scored, no model, no key, no browser). The live
runners never run in CI: `wiring.test.ts` fails if the workflow names one, an
`EVAL_ARTIFACTS_` variable, or if a `test*` script reaches a runner.
