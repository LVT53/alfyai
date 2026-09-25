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
  endpoint from `EVAL_ARTIFACTS_BASE_URL`/`_MODEL`/`_API_KEY` first, then
  falls back to `~/.config/opencode/opencode.json`; works with **no key** at
  all against a local OpenAI-compatible server (no `Authorization` header is
  sent when there is no key, rather than one carrying an empty token). Sends
  `chat_template_kwargs: { enable_thinking: false }` when a suite needs
  thinking off (Qwen defaults to thinking on) — the same mechanism the app
  itself uses, see `normal-chat-model/provider-compatibility.ts`'s
  `buildThinkingProviderOptions` (the "qwen" case).
- `run.ts` — the runner: the full `--suite`/`--replay`/`--skip-model`/
  `--limit`/`--only`/`--out`/`--help` flag table (see below), the
  known-bad-first refusal, strictly sequential execution with one retry per
  case and a stop after two consecutive 429/5xx failures, and the "nothing
  configured" graceful exit (`0`, never a crash). `parseArgv`, `runSuite` and
  `recordSuiteResponses` are exported and take their dependencies (the case
  registry, the model client, the scorer, a committed-response loader) as
  parameters, so `run.test.ts` proves all of this against a **fake** suite
  and fixture set — this slice ships no real suite, and writes none.
- `scoring.ts` — `SUITE_SCORERS`, the per-suite scorer dispatch table (empty
  today; `getSuiteScorer` falls back to the Slice 0 generic scorer for any
  suite with nothing registered), plus the results-leak test (below).

**Nothing here talks to a model unless you configure one.** Run
`npx tsx scripts/eval-artifact-contracts/run.ts --suite <name>` with nothing
configured and it exits `0`, explaining that no cases are registered yet
(today, that is every suite).

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
task (T9) is the all-suite real run and this README's final numbers.

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
| `--only <ids>` | Comma-separated fixture ids to run (filters both the known-bad and the regular set). |
| `--out <dir>` | Override the `results/` output directory. |
| `--help` | Print the switch table. |

Every flag has an `EVAL_ARTIFACTS_*` env-var equivalent (see `config.ts`); a
flag overrides its env switch. `EVAL_ARTIFACTS_SKIP_EVAL=1` calls the model
and writes raw responses under `fixtures/<suite>/responses/` **without**
scoring anything — this is how you (re-)record a suite's committed responses
after a prompt or contract change, before committing them for `--replay`.

### What has to be configured for a real (non-`--replay`) run

- **An OpenAI-compatible endpoint.** Either `EVAL_ARTIFACTS_BASE_URL` +
  `EVAL_ARTIFACTS_MODEL` (and optionally `EVAL_ARTIFACTS_API_KEY`), or a
  `~/.config/opencode/opencode.json` with at least one `provider.<name>`
  entry carrying `options.baseURL` and a non-empty `models` map — `client.ts`
  reads the first one it finds. Neither is required for `--replay`.

If neither is configured, the script exits `0` and explains what is
missing — this is expected off-box (e.g. accidentally in CI) and is never a
hard dependency of `npm test` or `npm run build`.

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
calls the configured model for every case in the suite (skipping the
known-bad gate entirely — nothing is being trusted yet) and overwrites
`fixtures/<suite>/responses/*.json`. Review the diff before committing:
a contract or prompt change is exactly when responses are expected to move.

## The key rule, in one place

`client.ts` is the only module that reads an API key — from
`EVAL_ARTIFACTS_API_KEY`, else `~/.config/opencode/opencode.json` — and it
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
runs `config.test.ts`, `client.test.ts` (pure `parseOpencodeConfig` only —
no real disk/network access), `scoring.test.ts` and `run.test.ts` (the fake
suite described above), plus `--replay --suite all` once suites exist.
