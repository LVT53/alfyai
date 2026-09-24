# Atlas — Deep-Research Reports

Atlas produces long-form, cited research reports. It runs as a Normal Chat turn plus a durable
in-process background worker rather than a separate subsystem
([ADR 0036](adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md)), and its web work goes
through the same Parallel-backed `research_web` / `fetch_url` path as the rest of the app
([ADR 0052](adr/0052-replace-searxng-web-research-with-parallel-search.md)). Atlas therefore requires
`PARALLEL_API_KEY`; without it Atlas reports as unavailable.

## Pipeline

Atlas runs a single content pipeline — v3 ([ADR 0063](adr/0063-atlas-v3-reasons-from-an-evidence-bank-not-from-search-excerpts.md)).
It reasons from an evidence bank: structured claims, an answer table before any prose, one writer
with the whole report in view, and a critic that may order targeted re-search. Every job, including a
Continue/Revise/Fork child of an older family, is stamped and runs on this pipeline; there is no
runtime switch to select a different one.

Lifecycle children start from their parent (ADR 0063, Phase D amendment). A **Continue** reuses the
parent's evidence bank, memo and outline; a **Revise** reuses the bank and outline but not the memo;
a **Fork** reuses no evidence and re-researches. Before a parent's quote may be cited, the
**seed recheck** re-reads live every time-sensitive source older than the freshness window (14 days
for Continue, 0 for Revise) within one research round's page budget; what it cannot reach is dropped,
never trusted. A v1/v2 parent seeds its child from its published report's source URLs, read afresh.
The job's `qualityDiagnostics.seed` says what was trusted, rechecked, confirmed, changed and dropped.

Two earlier pipelines existed and were deleted once v3 became the only one:

- **v1** — the original pipeline. It has no `[n]` inline citation markers.
- **v2** ([ADR 0062](adr/0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md), superseded) —
  rebuilt on the harness's `research_web` path, with inline citations, per-claim verification, and
  confidence.

Old reports produced by v1 or v2 keep rendering: the stored HTML/PDF/Markdown files, the persisted
`GeneratedDocumentSource` (including v1's basis and confidence markers), the job row's `1`/`2`/`3`
pipeline-version projection, and the client's v1/v2 progress-detail parsing are all still live read
paths. The next Continue, Revise, or Fork on an old family simply moves it onto v3. Rollback to an
earlier commit, not a config value, is how you would ever run v1 or v2 again — the last commit where
either pipeline still ran is tagged `atlas-v1-v2-final`. See
[docs/atlas-history/v1.md](atlas-history/v1.md) and [docs/atlas-history/v2.md](atlas-history/v2.md)
for what each deleted pipeline did and why it was replaced.

Background on the design: ADRs
[0037](adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md),
[0038](adr/0038-atlas-publishes-writer-centered-reports-not-source-dumps.md),
[0040](adr/0040-atlas-quality-gate-analytics-and-rendering-improvements.md),
[0053](adr/0053-atlas-post-migration-deepening.md) (v1-era; superseded by the v3-only consolidation).

## Selecting Models

`ATLAS_SYNTHESIS_MODEL` and `ATLAS_AUDIT_MODEL` are the two inherit targets for v3 tasks. Each accepts
`model1`, `model2`, or `provider:<providerId>:<modelId>`. See
[docs/configuration.md](configuration.md#atlas-deep-research-reports) for their rows; they are
summarized again in the table below.

## v3 Tuning

All of these can also be overridden in admin config.

| Variable | Default | What it does | Caveats |
|---|---:|---|---|
| `ATLAS_STALE_MONTHS` | `18` | Age past which a cited statistic is listed in the report's Limitations section | Read by the v3 pipeline |
| `ATLAS_SYNTHESIS_MODEL` | unset | Inherit target for the v3 researcher and writer | `model1`/`model2`/`provider:<id>:<model>` |
| `ATLAS_AUDIT_MODEL` | unset | Inherit target for the v3 ask, outline, and critic | `model1`/`model2`/`provider:<id>:<model>`; also used by `atlas-eval.ts --judge` |
| `ATLAS_V3_ASK_MODEL` / `_RESEARCHER_MODEL` / `_OUTLINE_MODEL` / `_WRITER_MODEL` / `_CRITIC_MODEL` | unset | One model per v3 task | Unset means INHERIT: researcher and writer take `ATLAS_SYNTHESIS_MODEL`; ask, outline, critic take `ATLAS_AUDIT_MODEL`. Clearing the value in admin config restores the inherited model rather than pinning `model1` |
| `ATLAS_V3_CRITIC_ROUNDS` | `2` | Whole-report critic rounds; each may order rewrites, cuts, and a small targeted research budget | Clamped to 0–3. `0` skips the critic |
| `ATLAS_V3_RESEARCHER_CONCURRENCY` | `3` | Isolated researcher calls in flight at once | Clamped to 1–8 |
| `ATLAS_V3_SEARCHES_PER_STEP` | `3` | Searches one researcher step issues at once | Clamped to 3–5 |
| `ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `2` / `3` / `4` | Pages read per sub-question, spent best-tier-first | Page reads are v3's marginal cost and latency. Clamped to 0–6 |
| `ATLAS_V3_LANGUAGE_STANDARD_HU` | `true` | Hungarian register rules for the writer and critic, and KSH / Magyar Közlöny / njt.hu / MNB promoted to primary sources | Set `false` to write Hungarian without the standard |

## Report Quality Evaluation (`scripts/atlas-eval.ts`)

`scripts/atlas-eval.ts` measures Atlas report quality against a **live** deployment (ADR 0063). It
drives the same HTTP surface a browser does: log in, create a conversation, `POST /api/chat/send`
with `atlasMode`, poll `GET /api/conversations/:id` until the job ends, then download the produced
Markdown.

```bash
BASE=https://staging.example EMAIL=admin@example.com PASSWORD=... \
  npx tsx scripts/atlas-eval.ts --out /tmp/atlas-eval
```

- `--queries <ids>` — a subset of `scripts/atlas-eval-queries.json` (e.g. `energy-statistics,hungarian-query`).
- `--profile overview|in-depth|exhaustive` — override every query's profile.
- `--timeout <minutes>` — per-job timeout (default 45).
- `--concurrency <n>` — jobs in flight (default 1; the Atlas worker's own global limit still applies).
- `--lifecycle continue|revise|fork` — run each query as a create job, then (in the same
  conversation, once it succeeds) a child with that action, and grade the child. The child's message
  is the query's `lifecycleInstruction` or a default per action; `report.md` gains a Lifecycle table
  with the parent's and child's page reads beside the child's `qualityDiagnostics.seed`.
- `--judge` — also score each report against ADR 0063's rubric. Every score must come back with a
  verbatim quote from the report; a score whose quote is not in the report is discarded rather than
  averaged in. The judge runs through the deployment's own chat API, which takes no model parameter,
  so set the eval account's model to whatever `ATLAS_AUDIT_MODEL` names before judging.

Every job this harness creates is expected to report `pipelineVersion: 3`. It reads back each job's
`pipelineVersion` and marks a run that reports anything else as mislabelled rather than reporting it
silently — a sign the deployment under test is not on the build you expect.

Output in `--out`: `report.md` (a deterministic quality table, totals, and per-query hand-check
lists), `results.json`, and each run's Markdown report. Measured per query: wall time, tokens,
citation resolution rate, number match rate (checked offline against the per-source snippets the job
stores in its progress details), corroboration rate, junk-source count, and inline-citation density.

The quality table is ADR 0063's deterministic layer: is there a conclusion with a figure in the first
150 words, how many sentences restate an earlier section's claim, distinct cited claims per 1,000
words, what share of volatile figures carry an inline date, whether a question that implies a table
shipped one, and sections delivered against sections planned.
