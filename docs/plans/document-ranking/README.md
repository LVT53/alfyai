# Document search order (2026-11-10)

Why a search for documents put the right one first only when the question and the document shared words, what replaced that order, and the
numbers behind the replacement. The code is `rankArtifactMatches` in `src/lib/server/services/knowledge/store/documents.ts` and the
arithmetic in `src/lib/server/services/knowledge/store/document-ranking.ts`.

## What was wrong

The search ends with a sum of three signals, each with a weight written next to it: the words of the query found in the document (x10), the
embedder's cosine (x18) and the reranker's probability (x24), plus the project boost. That sum went through `computeDecayScore` with the age
in **seconds**:

    finalScore = sum * exp(-0.001 * age) * exp(-0.01 * age) + 0.35 * lexicalScore        (age in seconds)

`exp(-0.011 * age)` is 0.52 after a minute, 0.04 after five, 0.001 after ten and nothing after an hour. So for every document more than a few
minutes old the embedder, the reranker and the project boost were weighed and then multiplied away, and the order was `0.35 * (query words
found)`, ties to the newest. A question in the language of its document half worked, because the words overlap (40 to 58% right-first
in the lab). A question in one language almost never found its answer in the other (12 and 17%, with the embedder alone at 94 and 98% on
the same documents), and a paraphrase lost to any document that shared a few everyday words with the question. On staging, with documents
hours old, the embedder alone put the right one first in 84 to 94% of the probe's queries and the app's order in 36%.

A second, smaller age factor sits downstream of it (below, "The second age factor"). Two more things sit next to it and were left alone:
`working-set.ts` calls the same function with an age in seconds, and for a non-empty query the candidates are the 120 most recently
updated documents (`SEMANTIC_ARTIFACT_CANDIDATE_LIMIT`), so an older document is never in the running.

## What replaced it

1. No decay. The sum is the order: `relevance + updatedAt / 1e12 + projectBoost`, recency being the last tie-break (a day moves it by less
   than a thousandth). `finalScore` is only an order; `lexicalScore`, `semanticScore` and `rerankScore` are passed on unchanged, for the
   cross-conversation rule's thresholds.
2. The words count as a **share of the query's words, squared** (x10), plus 8 when a query of three words or more is found whole in the document.
   A question is mostly everyday words ("the", "for", "notice") that any document holds; a document has to hold most of them before the words
   weigh against what it means. The bonus keeps an exact phrase quoted from a long document ahead of a document merely about the same subject,
   which the embedder otherwise prefers.
3. The reranker scores only the first 8 documents it is handed (`TEI_RERANKER_MAX_TEXTS`). It is handed the 8 likeliest by words and cosine
   together, not the first 8 word hits.

## The second age factor

`findRelevantKnowledgeArtifacts` (`knowledge/context.ts`) re-sorts the search's result, multiplying the score of every document outside the
current conversation by `exp(-0.05 * days since it was updated)`, a half-life of a fortnight (`applyConversationBoundaryPenalty`). For
another chat's documents that is a design: they are gated first (enough words, or a cosine or reranker score above 0.75, or named in the
question) and then discounted by age. A document that belongs to no conversation (a library or project upload, `conversationId` null) has no
boundary to cross and no gate, so everything with a word hit or in the cosine shortlist is a candidate, and the discount alone decided which
few reached the prompt: the newest, not the best.

In the lab, with documents aged 1 to 60 days (a library built up over two months), today's order falls from 63.0 to 42.3 once that
penalty is applied, and the order above from 99.2 to 59.4 (88.6 with half the penalty; `lab/results.txt`, "BOUNDARY PENALTY"). Fixing only
the search would have reached the prompt mostly cancelled for library uploads. So the penalty now applies to documents of other
conversations only (`context.ts`, `insideTheBoundary = !isCrossConversation`); the gate, the penalty and the eligibility rule for those are
untouched. A library written within a week would have felt this much less than the lab's.

## The numbers

A lab on public text only (HunSum-2, Belebele Hungarian and English, WebFAQ Hungarian and English; `lab/prep.py` builds the sets). Nine sets
of 60 to 100 queries. Each query has one right document among 120 (the app's candidate limit), the other 119 drawn from the same corpus, with
random ages of 1 to 60 days. For every pair the lab records the three signals the app has: `scoreMatch` ported exactly, the cosine of the
4B embedder at 1024-d (production since 2026-11-10) and of the old 0.6B, and the probability of `bge-reranker-v2-m3` through TEI. Formulas are then
scored offline on the recorded signals (`lab/rank-lab-eval.py`), with the app's own shortlist (12 word hits at a limit of 5, 24 by cosine) and the
reranker's cap of 8; the project boost is not in the lab. Right-first (hit@1) and MRR, in percent:

| set | today | shipped | shipped, reranker down | embedder alone |
|---|---|---|---|---|
| A  Hungarian article <- its abstract | 82 / 87 | 99 / 99 | 95 / 97 | 95 / 97 |
| P  Hungarian exact phrase (6 words) | 100 / 100 | 100 / 100 | 100 / 100 | 52 / 61 |
| K  Hungarian 3 rare keywords | 100 / 100 | 100 / 100 | 100 / 100 | 40 / 51 |
| B  English passage <- Hungarian question | 17 / 27 | 95 / 98 | 94 / 97 | 94 / 97 |
| C  Hungarian passage <- English question | 12 / 19 | 99 / 99 | 98 / 99 | 98 / 99 |
| D  Hungarian passage <- Hungarian question | 40 / 48 | 96 / 98 | 93 / 96 | 93 / 96 |
| E  English passage <- English question | 48 / 57 | 99 / 99 | 98 / 98 | 97 / 98 |
| H  WebFAQ Hungarian question -> answer | 52 / 62 | 100 / 100 | 99 / 100 | 99 / 100 |
| W  WebFAQ English question -> answer | 58 / 66 | 100 / 100 | 100 / 100 | 100 / 100 |
| **mean MRR** | **63.0** | **99.2** | 98.4 | 88.6 |
| cross-language (B, C) | 23.2 | 98.4 | 97.7 | 97.7 |
| exact phrase and keywords (P, K) | 100.0 | 100.0 | 100.0 | 55.7 |

Each cell is hit@1 / MRR. On the old 0.6B embedder the same formula reaches 97.3 (today's order: 62.8). The gain over today's order is +36.1 MRR
points (95% interval +34.0 to +38.3, paired bootstrap over queries). The formula was chosen over two rounds looking at all of the queries,
so the halves are a consistency check and not a held-out score: on the even-numbered and the odd-numbered queries separately it gives 99.4
and 99.0 (today's: 63.6 and 62.5). `lab/results.txt` is the full output.

How it got there, mean MRR / cross-language / exact phrase and keywords, 4B embedder:

| step | mean | cross | exact |
|---|---|---|---|
| today | 63.0 | 23.2 | 100.0 |
| decay removed, weights as written | 84.6 | 66.2 | 100.0 |
| + reranker handed the best by cosine | 90.2 | 76.1 | 100.0 |
| + words as a share of the query | 97.1 | 97.2 | 92.6 |
| + reranker handed the best by words and cosine | 97.6 | 97.2 | 94.5 |
| + share squared | 98.8 | 98.4 | 98.5 |
| + 8 for every word found (**shipped**) | 99.2 | 98.4 | 100.0 |

Rank fusion in place of the weighted sum scored 87.9. A smaller weight on the words (x4 or x2 against x30 on the cosine) scored 95.2 and
94.4 and lost the exact-phrase sets (83.0 and 78.7 on those two). Doubling the reranker's cap to 16 added half a point (97.6 to 98.1) for
twice the reranker's work; what it is handed mattered more than how many.

## What the numbers do not show

- The pools are 119 unrelated documents of one corpus and one right answer. A real library has near-duplicates and several relevant
  documents; there the order among them is decided by the same three signals and then by recency, which this lab does not test.
- The thresholds that read the signals themselves (topic shift under cosine 0.3, cross-conversation eligibility at 0.75 / 0.75 / 3 words)
  are untouched; their behaviour on the 4B embedder is in `docs/plans/embedding-reranker-eval/qwen3-test-2026-11-09.md` where that folder is kept.
- The project boost (5) now acts on documents of any age, as written; before, it vanished after ten minutes. It was not retuned.

## Verification

`documents.ranking-order.test.ts` runs the real search over a real migrated SQLite file with the cosines and the reranker set by hand
(cross-language with no shared word, everyday words against meaning, an exact phrase against a look-alike, what the reranker is handed,
relevance against recency, recency as the tie-break). Four of the six were seen to fail on the old order; the other two pin what must not
change (a quoted phrase still beats a look-alike, the newer of two equal documents still comes first), and the first of them fails
without the every-word bonus. Four deliberate breakages of the new code (no bonus, share not squared, reranker handed the shortlist order,
bonus from two words) each fail the test meant to catch them.
The arithmetic in `document-ranking.ts`, run in TypeScript over the lab's recorded signals, reproduces the table above to the digit.
`context.test.ts` ("orders documents that belong to no conversation by relevance...") failed on the old penalty and fails again when the
penalty is put back on them.

## Reproduce

    python -I lab/prep.py <raw-datasets> <data-dir>
    TEI_API_KEY_<port>=... python -I lab/rank-lab-features.py <data-dir> rank-lab-features.json   # needs the embedders and the reranker
    python -I lab/rank-lab-eval.py rank-lab-features.json final        # also: round2, holdout, grid
