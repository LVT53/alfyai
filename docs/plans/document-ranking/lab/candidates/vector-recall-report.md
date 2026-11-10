# Older-candidates vector recall: measured, 2026-11-10

The README's table compares the measurement with the earlier Beta-binomial estimate. The raw tables are appended to
`results.txt`; `vector-recall-questions.jsonl.gz` contains ids and numeric/Boolean results, without question or document text.

At 400 documents, older-target recall averaged 99.7% over the seven question-style sets (99.6% after averaging over ages),
versus 99.8% estimated. At 1,500, the comparable A/H/W sets measured 99.6% (also 99.6% age-averaged), versus 94.5% estimated:
the old estimate was pessimistic by about five points. Phrase/rare-word recall at 1,500 was 53.4%/48.1% measured
(53.2%/48.2% age-averaged), versus 59.1%/49.7% estimated: optimistic in this sample. All 6,600 vector-group decisions agreed
with the separate cosine calculation, with zero ties and zero extra name-group candidates. The four mixed Belebele rows
at 1,500 are measured but cannot validate the old same-corpus estimate.

## Method and limits

Qwen3-Embedding-4B through TEI 1.9.3, float16, normalized 1024-d vectors. Claude ran the approved embed phase on the owner's box
on 2026-11-10, 13:45:51–13:51:36 UTC. Documents used the app's `buildArtifactEmbeddingSourceText` through the actual backfill
(name `doc-<dataset-id>.md`, null summary, public text); queries used the `query` prompt. All 5,476 stored source hashes match
these prepared inputs. All 5,476 document vectors and 2,226 distinct query vectors are finite, 1024-d and unit length.

The offline measurement uses the actual search, actual SQLite vector store and random distinct ages, seeded independently of
questions. The semantic shortlist is wrapped to observe its calls; the reranker alone is disabled. Each of 22 set/library cells
has 300 questions. The reported denominator is the subset whose target lies outside the 120 newest documents.
An additional age-averaged calculation integrates the real full-library cosine ranks over every possible random newest-120
window, conditional on the target being older. It is an exact expectation for these fixed texts and libraries, not an estimate
of recall for all future libraries.

The small libraries contain 300 selected targets plus 100 distractors (HunSum/WebFAQ); large ones contain the same targets
plus 1,200 distractors. Belebele uses 400/all 488 passages; its 1,500-document libraries add 1,012 same-language WebFAQ answers.
Those mixed rows measure a different competitor distribution from the original same-corpus estimate. Questions can share
passages, translated questions and article targets across sets. No independent-question confidence intervals or significance
claims are made. The earlier estimate used other sampled queries and raw document text; this run used app-prepared text with
neutral filenames. Differences cannot be attributed solely to the estimator or to embedding text preparation.

The name/summary group is not evaluated: these datasets have neutral generated filenames and no summaries. Candidate recall
also does not measure final ranking quality, several relevant answers, near-duplicates, missing vectors, or libraries beyond the
2,000-older-document scan cap. Exact-text duplicates are excluded. Only one library draw per size/corpus was measured.

## Reproducibility and validation

`vector-recall-selection.json` records source licences, local input fingerprints, library member ids and question/gold ids.
Upstream dataset revisions were not retained by the original downloader; the local input hashes pin what was actually used.
`vector-recall-provenance.json` records the embedding settings, timestamps and SHA-256 fingerprints of plans and saved vectors.
The prep script regenerates the saved plan and public documents byte for byte. The report refuses incomplete cells, duplicate
question/library keys, cosine ties, or app/cosine and candidate disagreements. The embed phase requires fresh output to prevent
stale vectors being reused across changed inputs/settings.

The full application gate is waived for this docs-and-script-only task. See the verification block appended to `results.txt`.
The lab is outside the ordinary TypeScript/Biome input globs; its runtime was exercised by Vitest. Official Vitest documentation
was checked for [module mock factories](https://vitest.dev/api/vi.html#vi-mock),
[conditional tests](https://vitest.dev/api/test.html#test-skipif), and
[environment docblocks](https://vitest.dev/guide/environment.html). No framework docs MCP tool was available.

## What was read, written and left behind

- Read: repository code, Claude's handoff, the public Belebele English/Hungarian, WebFAQ English/Hungarian and HunSum-2 datasets
  prepared by `lab/prep.py`, and the earlier lab's public-data recorded cosines. This continuation made no box connection.
- Earlier approved box access: TEI container names/status, the 4B compose block (secrets masked in displayed output), its API key
  in memory only, `/health` and `/info`; one probe sentence, 5,476 public documents and 2,226 public questions were sent through
  the temporary tunnel. No owner's documents, conversations, memory or application database were read.
- Written: lab/prep/report scripts, text-free numeric results and provenance, README/report updates; local throwaway databases,
  logs, dataset copies and saved vectors in ignored `data/vector-recall/`; dependencies from the earlier `npm ci`.
  Nothing was written on the box. No push or deployment was performed.
- Left behind: ignored `data/vector-recall/` retains public texts and vectors for offline remeasurement, with earlier scratchpad
  copies possibly still present. Preserve it if remeasurement is wanted; it can be removed when no longer needed. Claude closed
  the tunnel and SSH connection and stopped the fake embedder before handoff. This continuation started neither.
