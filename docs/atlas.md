# Atlas — Deep-Research Reports

Atlas produces long-form, cited research reports. It runs as a Normal Chat turn plus a durable
in-process background worker rather than a separate subsystem
([ADR 0036](adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md)), and its web work goes
through the same Parallel-backed `research_web` / `fetch_url` path as the rest of the app
([ADR 0052](adr/0052-replace-searxng-web-research-with-parallel-search.md)). Atlas therefore requires
`PARALLEL_API_KEY`; without it Atlas reports as unavailable.

## Pipelines

`ATLAS_PIPELINE` selects which content pipeline a **new** job runs on. The version is stamped on the
job row at kickoff, so flipping the flag never re-routes a queued job, and a Continue/Revise/Fork
child stays on its parent's pipeline.

- **v1** — the original pipeline. It has no `[n]` inline citation markers.
- **v2** ([ADR 0062](adr/0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md)) — rebuilt on
  the harness's `research_web` path, with inline citations, per-claim verification, and confidence.
- **v3** ([ADR 0063](adr/0063-atlas-v3-reasons-from-an-evidence-bank-not-from-search-excerpts.md)) —
  reasons from an evidence bank: structured claims, an answer table before any prose, one writer with
  the whole report in view, and a critic that may order targeted re-search.

Only the exact value `v2` or `v3` selects one; anything else runs v1. `ATLAS_PIPELINE` can also be
overridden in admin config. Use `scripts/atlas-eval.ts` (below) to decide when v3 is ready to promote.

Background on the design: ADRs
[0037](adr/0037-atlas-uses-bounded-adaptive-rounds-not-autonomous-research-loops.md),
[0038](adr/0038-atlas-publishes-writer-centered-reports-not-source-dumps.md),
[0040](adr/0040-atlas-quality-gate-analytics-and-rendering-improvements.md),
[0053](adr/0053-atlas-post-migration-deepening.md).

## Selecting Models

`ATLAS_SYNTHESIS_MODEL` and `ATLAS_AUDIT_MODEL` are the two inherit targets for v3 tasks. Each accepts
`model1`, `model2`, or `provider:<providerId>:<modelId>`. See
[docs/configuration.md](configuration.md#atlas-deep-research-reports) for their rows; they are
summarized again in the v3 table below.

## v2 Tuning

All of these can also be overridden in admin config unless marked **env only**.

| Variable | Default | What it does | Caveats |
|---|---:|---|---|
| `ATLAS_STALE_MONTHS` | `18` | Age past which a cited statistic is listed in the report's Limitations section | v2 only |
| `ATLAS_V2_QUESTIONS_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `6` / `10` / `16` | Research questions the v2 plan stage produces per profile | Clamped to 4–20. Each question costs one `research_web` call per round |
| `ATLAS_V2_ROUNDS_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `1` / `2` / `3` | Bounded v2 research rounds per profile | Clamped to 1–4. Round 2+ researches only the questions the coverage check named |
| `ATLAS_V2_MAX_WORDS_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `1100` / `2800` / `5500` | Hard word ceiling per profile, executive summary and Limitations included | Writer gets a matching per-section sentence cap; a deterministic post-cap drops trailing (uncited-first) sentences on overshoot. **Env only** |
| `ATLAS_V2_MAX_SOURCES_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `20` / `40` / `80` | Indexed sources carried into the v2 write phase per profile | Excess sources are dropped round-robin across research questions so every question keeps representation. **Env only** |
| `ATLAS_V2_ENTAILMENT_BATCH` | `10` | Claims per batched entailment call on the control model | `1` disables batching; a batch whose answer does not parse falls back to one call per claim. **Env only** |
| `ATLAS_V2_WRITER_CONCURRENCY` | `5` | v2 sections written in parallel | Clamped to 1–8. **Env only** |

## v3 Tuning

All of these can also be overridden in admin config.

| Variable | Default | What it does | Caveats |
|---|---:|---|---|
| `ATLAS_SYNTHESIS_MODEL` | unset | Inherit target for the v3 researcher and writer | `model1`/`model2`/`provider:<id>:<model>` |
| `ATLAS_AUDIT_MODEL` | unset | Inherit target for the v3 ask, outline, critic, and verifier | `model1`/`model2`/`provider:<id>:<model>`; also used by `atlas-eval.ts --judge` |
| `ATLAS_V3_ASK_MODEL` / `_RESEARCHER_MODEL` / `_OUTLINE_MODEL` / `_WRITER_MODEL` / `_CRITIC_MODEL` / `_VERIFIER_MODEL` | unset | One model per v3 task | Unset means INHERIT: researcher and writer take `ATLAS_SYNTHESIS_MODEL`; ask, outline, critic, verifier take `ATLAS_AUDIT_MODEL`. Clearing the value in admin config restores the inherited model rather than pinning `model1` |
| `ATLAS_V3_CRITIC_ROUNDS` | `2` | Whole-report critic rounds; each may order rewrites, cuts, and a small targeted research budget | Clamped to 0–3. `0` skips the critic |
| `ATLAS_V3_RESEARCHER_CONCURRENCY` | `3` | Isolated researcher calls in flight at once | Clamped to 1–8 |
| `ATLAS_V3_SEARCHES_PER_STEP` | `3` | Searches one researcher step issues at once | Clamped to 3–5 |
| `ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW` / `_IN_DEPTH` / `_EXHAUSTIVE` | `2` / `3` / `4` | Pages read per sub-question, spent best-tier-first | Page reads are v3's marginal cost and latency. Clamped to 0–6 |
| `ATLAS_V3_LANGUAGE_STANDARD_HU` | `true` | Hungarian register rules for the writer and critic, and KSH / Magyar Közlöny / njt.hu / MNB promoted to primary sources | Set `false` to write Hungarian without the standard |

## Report Quality Evaluation (`scripts/atlas-eval.ts`)

`scripts/atlas-eval.ts` measures Atlas report quality against a **live** deployment and compares the
content pipelines (ADR 0062, ADR 0063). It drives the same HTTP surface a browser does: log in, create
a conversation, `POST /api/chat/send` with `atlasMode`, poll `GET /api/conversations/:id` until the
job ends, then download the produced Markdown.

```bash
BASE=https://staging.example EMAIL=admin@example.com PASSWORD=... \
  npx tsx scripts/atlas-eval.ts --pipeline v2 --out /tmp/atlas-eval
```

- `--pipeline v1|v2|v3|all` — which pipeline to label the run as (default: v1 and v2).
- `--queries <ids>` — a subset of `scripts/atlas-eval-queries.json` (e.g. `energy-statistics,hungarian-query`).
- `--profile overview|in-depth|exhaustive` — override every query's profile.
- `--timeout <minutes>` — per-job timeout (default 45).
- `--concurrency <n>` — jobs in flight (default 1; the Atlas worker's own global limit still applies).
- `--judge` — also score each report against ADR 0063's rubric. Every score must come back with a
  verbatim quote from the report; a score whose quote is not in the report is discarded rather than
  averaged in. The judge runs through the deployment's own chat API, which takes no model parameter,
  so set the eval account's model to whatever `ATLAS_AUDIT_MODEL` names before judging.

The script does **not** change `ATLAS_PIPELINE` — set it in admin config or the environment first,
then pass the matching `--pipeline` value. It reads back each job's `pipelineVersion` and marks a run
that does not match as mislabelled rather than reporting it silently.

Output in `--out`: `report.md` (comparison table, a deterministic quality table, totals, and per-query
hand-check lists), `results.json`, and each run's Markdown report. Measured per query: wall time,
tokens, citation resolution rate, number match rate (checked offline against the per-source snippets
the job stores in its progress details), corroboration rate, junk-source count, and inline-citation
density. v1 has no `[n]` markers, so its citation, number-match, and corroboration columns read `n/a`
rather than a misleading `0`.

The quality table is ADR 0063's deterministic layer and runs on **every** pipeline, so v2 and v3 are
graded on the same ruler: is there a conclusion with a figure in the first 150 words, how many
sentences restate an earlier section's claim, distinct cited claims per 1,000 words, what share of
volatile figures carry an inline date, whether a question that implies a table shipped one, and
sections delivered against sections planned.
