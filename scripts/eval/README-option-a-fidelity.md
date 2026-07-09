# Option-A fidelity eval harness

Issue X.4. Measures the quality-hit % of Option A (local-distill): how much
answer fidelity is lost when connector data is summarized by a local model
before a cloud chat model ever sees it, versus sending the raw connector
data.

This is a **pre-release harness, not run in CI**. It makes live calls to a
local-distill model and a chat model, so it needs to run on a box where both
are actually reachable.

## What it does

For each fixture in `fixtures/option-a-fidelity.fixtures.ts` (a
`{ capability, question, rawConnectorText }` case across
calendar/email/files/photos/contacts):

1. Asks the configured chat model the question with the **raw** connector
   text in context → the reference answer.
2. Runs the raw text through `distillConnectorPayload` (the real Option-A
   path in `src/lib/server/services/connections/locality.ts`) with that same
   question, then asks the chat model the same question with the
   **distilled** text in context → the Option-A answer.
3. Has the chat model act as an LLM judge, scoring 0-100 how well the
   distilled answer preserved the reference answer's correctness and
   completeness.
4. If distillation itself is unavailable for a case (the model resolves to a
   cloud host, or the call fails), that case is recorded as **withheld** —
   the safe fallback — not as a fidelity/quality failure.

It then aggregates overall and per-capability: `n`, `scored`, `withheld`,
`error`, mean fidelity %, and quality-hit % (`100 − meanFidelity`).

## Running it on-box, pre-release

```
npx tsx scripts/eval/option-a-fidelity.ts
```

Options:

- `--chat-model=<id>` — which chat model answers the questions (default
  `model1`).
- `--out=<path>` — where to write the JSON result (default
  `scripts/eval/results/option-a-fidelity-<timestamp>.json`, gitignored —
  these are live-run snapshots, not source).
- `--help`

### What it needs configured

- **A local-distill model** — the deployment's `memoryConsolidationModel`
  (admin config), and it must resolve to a **local/non-cloud** host. This is
  the same model + the same safety check `distillConnectorPayload` performs
  in production (`isCloudModel`) — if the configured model resolves to a
  cloud provider, the harness treats it as not configured, exactly like
  production would refuse to use it for Option A.
- **A reachable chat model** — whatever `--chat-model` resolves to via the
  normal provider config (default `model1`).

If either is missing or unreachable, the harness prints a clear skip message
and **exits gracefully (exit code 0)** — it does not crash. This is expected
when run off-box (e.g. accidentally in CI). If the models resolve but are
not actually reachable at call time (e.g. a local server that isn't
running), individual cases fail with an `error` outcome rather than crashing
the whole run — check the case-level `error` field in the JSON output.

## Backfilling the 7.4 UI copy

The overall quality-hit % this harness produces is the number that belongs
in the `connections.locality.fidelityNote` i18n key
(`src/lib/i18n/connections.ts`), which is the placeholder copy shown under
the Option-A "Keep connector data on this device" toggle
(`src/routes/(app)/settings/_components/SettingsConnectionsTab.svelte`).

That key currently holds a **placeholder** (no invented number — do not fill
it in without a real on-box run):

- `en`: "Local summarization aims to preserve the details relevant to your
  question, though some nuance can be lost compared to sending the raw
  data."
- `hu`: "A helyi összegzés a kérdésed szempontjából releváns részleteket
  próbálja megőrizni, bár a nyers adatküldéshez képest némi árnyaltság
  elveszhet."

After running this harness on-box pre-release, update **both** locales'
`connections.locality.fidelityNote` entries in `src/lib/i18n/connections.ts`
to state the actual overall quality-hit % (e.g. "... may lose up to
approximately N% detail compared to the raw data."). Keep the two locales in
sync when you do.

## Pure logic vs. live logic

The scoring/aggregation logic (`option-a-fidelity-scoring.ts`) is pure — no
I/O — and is unit-tested in CI (`option-a-fidelity-scoring.test.ts`):
per-capability and overall mean fidelity, quality-hit derivation, withheld
handling, `n`, result formatting, and the not-configured graceful-exit
branch (tested with mocked resolvers, no real DB/model calls). Only the
orchestration in `option-a-fidelity.ts` (fixture loop, real
`distillConnectorPayload`/`sendJsonControlMessage` calls, file I/O) is live
and excluded from CI.
