# Artifact-contract eval harness

The model-contract evaluation harness for Feature 2 · Artifacts (see
`docs/plans/claude-at-home-2/plan.md` § The model-contract evaluation
harness, and `decisions.md` rulings 25 and 44). Follows the same CI/live
split as `scripts/eval/README-option-a-fidelity.md`: a pure scoring module
that is unit-tested in CI, and a live orchestration script that talks to a
model and is not.

## What exists today (Slice 0 — the skeleton)

This slice lands the shape every type slice's suite runs through, and
nothing else:

- `types.ts` — `EvalCase`, `EvalAttempt`, `EvalVerdict`
  (`"good" | "acceptable" | "bad"`), `EvalScoreResult`.
- `scoring.ts` — a pure, generic scorer. It catches the one failure every
  suite shares (an empty or whitespace-only answer scores `"bad"`); it does
  not yet grade anything suite-specific, because no suite exists yet.
- `cases.ts` — an empty per-suite case registry.
- `run.ts` — resolves `--suite <name>`, looks it up in the registry, and
  **exits 0 with a clear explanation** whether nothing was asked for, the
  named suite has no cases yet, or (always, for now) there is no model
  client to run them against.

**Nothing here talks to a model yet.** `config.ts` (endpoint resolution) and
`client.ts` (the one module that reads an API key) are Slice 5a's, per
decisions.md ruling 44 — the harness core lands there, on this skeleton.

## What each type slice adds

Per ruling 44, each type slice writes its own `suites/<suite>.ts`,
`fixtures/<suite>/**` (with a `known-bad/` case set and committed
`responses/`), its own scorer logic, and one entry in `cases.ts` — and runs
its own live gate before it is called done:

| Suite | Slice |
|---|---|
| `document` | Slice 1 |
| `app`, `verification` | Slice 2 |
| `canvas` | Slice 3 |
| `slides` | Slice 4 |

No type slice edits `run.ts`, `config.ts` or `client.ts`. Slice 5b's own
task is the all-suite real run and this README's final numbers.

## Running it

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsx scripts/eval-artifact-contracts/run.ts --suite <name>
```

With no suite registered (today, for every suite), this exits `0` and
explains why. Once a type slice lands its suite and Slice 5a lands the model
client, this becomes a real run against the configured endpoint (see that
slice's own README update for exactly what must be configured).

## Results

`scripts/eval-artifact-contracts/results/` is gitignored — results are not
source, the same rule `scripts/eval/results/` already follows. Nothing here
is a dependency of `npm test` or `npm run build`; CI runs `scoring.test.ts`
and nothing that needs a model.
