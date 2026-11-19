# Real AlfyAI baseline artifacts

Restore the historical source at its original paths before following the replay commands or source references below. [Archive and restoration instructions](../research-source/README.md)

Read [results and interpretation](../alfyai-baseline-results.md) first. `run.ts` invokes real AlfyAI services, not mocks. `answer.cjs` is copied exactly from the original benchmark's shared answer function. `plan.md` freezes the evaluation boundary; `frozen.json` records source/case hashes. The same-day comparator is intentionally identical to the earlier run, including its reversal of same-day retains.

Node 22 is required by the installed SQLite binary. Rerun from the repository root, with the explicitly approved model/embedding proxy on 18891 and NEW per-profile scratch databases: `/opt/homebrew/opt/node@22/bin/node --import tsx docs/plans/hindsight-memory/alfyai-baseline/run.ts p01`. The runner refuses existing databases and forces a `/tmp/alfyai-memory-baseline/` path before imports. Never substitute real users or a production DB. Bridge credentials remain remote; archived database/model data is synthetic. Helper/config paths are evaluation infrastructure, not product setup instructions.

`p01-results.json` … `p06-results.json` capture every intake, nightly outcome, context, question and answer. Matching `.db.gz` files preserve the isolated database state. `model-calls.jsonl.gz` includes the bounded config/preflight requests as well as benchmark inference; the scored set is exactly 72 questions × 2 arms in the profile files. `graded-answers.json` aggregates manual judgments. `grades-p*.json` preserve reviewer outputs; source arm prefixes are normalized in the aggregate. `summary.json` and `diagnostics.json` contain counts and rejection evidence. `sha256.json` excludes itself.

This is throwaway evaluation code and documentation, not an app patch. No app build/test gates are claimed. Detailed fairness review: `../alfyai-baseline-seams.md`.
