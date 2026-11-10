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

A second, smaller age factor sits downstream of it (below, "The second age factor"). Two more things sat next to it. `working-set.ts` called
the same function with an age in seconds; it was checked afterwards and is fixed for the signals that say the person is working with a
document (`working-set.md` beside this file). And for a non-empty query the candidates were the 120 most recently updated documents
(`SEMANTIC_ARTIFACT_CANDIDATE_LIMIT`), so an older document was never in the running; older documents now join (below, "Which documents are in
the running").

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

## Which documents are in the running

The order above is only as good as the documents it is given. `selectArtifactSearchCandidates` (`knowledge/store/documents.ts`) read the 120
most recently updated documents and nothing else, so in a library of more than 120 an older document was never ranked, however well it answered
and even when the question named it. Measured on public text only (`lab/candidates/`): Belebele and WebFAQ questions, each with the one passage or
answer that answers it, a library of N documents with random ages in a real migrated SQLite file, 200 questions a library, each run through the
app's own search with the candidate list read off.

| library | questions with the right document among the 120 newest | cut off | 1 - 120/N |
|---|---|---|---|
| Belebele English, 400 documents | 30.5% | **69.5%** | 70.0% |
| Belebele Hungarian, 400 | 30.5% | **69.5%** | 70.0% |
| WebFAQ English, 400 | 28.5% | **71.5%** | 70.0% |
| WebFAQ Hungarian, 400 | 30.5% | **69.5%** | 70.0% |
| WebFAQ English, 1,500 | 6.5% | **93.5%** | 92.0% |
| WebFAQ Hungarian, 1,500 | 5.5% | **94.5%** | 92.0% |

With ages that do not depend on the question, the right document's place by age is uniform whatever the ages are, so the cut-off is 1 - 120/N:
70% at 400 documents, 92% at 1,500. That is the worst case. If a share q of a person's questions is about the 120 newest documents, the cut-off is
(1 - q)(1 - 120/N).

**The word filter that used to exist does not fix it.** `selectArtifactSearchCandidates` once filtered by the query's words (`LIKE %word%` on
the name, summary and text) and then took the 120 newest of what was left. It was skipped for every non-empty query ("prefer semantic breadth"),
so it was dead code, and it would not have helped a question: an English question shares a word with nearly every document, so the filter admits 77 to 97%
of an English library and the 120 newest of that are almost the same 120 (33 to 40% found at 400 documents, 10% at 1,500). A Hungarian question is
more selective, but the tokenizer cut every word at its accents (57.5% at 400, 21% at 1,500; 70% and 37.5% with whole words). Reading the text of
every document and ranking by the app's own `scoreMatch` finds 64 to 84% (the 24 best plus the 120 newest), for 63 ms (400 documents) to 242 ms
(1,500) just to read the texts. The word filter and its tokenizer are removed.

**What replaced it.** When the library holds more than the 120, two small groups of older documents join them (`selectOlderArtifactCandidates`):

1. The 24 whose stored vector is closest to the question, read from the newest 2,000 older documents. It needs the caller's query embedding (a
   chat turn embeds the question once for every kind it searches), so a caller that did not embed it gets none. 24 is what the usual shortlist
   takes, and no older document could rank higher than that in it.
2. Up to 12 whose name or summary (the first lines of the text) hold every one of the question's longer words (letters and digits, three or
   more, the six longest): "Hatvany lease 2019" among forty leases the embedder finds equally close, an id, a name. It works when the
   question could not be embedded. It does not read the text. It fires for a bare name or id: in a full sentence the six longest words
   include everyday ones ("about", "what", "from") or inflected forms that no name holds, and the year drops out, so it seldom fires for a
   sentence-style question and the vector group carries those. Its recall was not measured (the independent review's example).

Both use the window's own visibility rules and then the ownership check, so incognito conversations, other people's documents, the turn's own
conversation and other kinds stay out. A library that fits the window pays nothing. A failure in this pass (an unreadable stored vector, a locked
file) is logged and costs only the addition: the 120 newest are still ranked. Older documents that belong to ANOTHER chat still meet the
conversation discount of "The second age factor" (0.7% of their score at 100 days), so the gain is mostly for library and project uploads.

**How often the right document is then a candidate.** The vector group's recall is not measured at these library sizes (that takes the embedder
on the box); it is estimated from the ranking lab's recorded signals: per query the real cosine of the Qwen3-Embedding-4B at 1024 dimensions for
the right document and 119 others drawn from the same corpus. The share of others that out-score the right one estimates how many of N - 1
would, and the Beta-binomial over that gives the chance of a place in the top 24 of the older documents (`lab/candidates/cosine-recall.py`;
predicting the 120-document result from a random 30 of its 119 competitors gives 97.4% against 97.4% actual at K = 24, and 94.1% against 96.2% at
K = 12, so if anything it is a little pessimistic):

| set | 400 documents | 1,500 documents |
|---|---|---|
| A  Hungarian article <- its abstract | 99.7% | 92.9% |
| B  English passage <- Hungarian question | 100% | 93.6% |
| C  Hungarian passage <- English question | 100% | 94.4% |
| D  Hungarian passage <- Hungarian question | 100% | 92.7% |
| E  English passage <- English question | 99.0% | 94.0% |
| H  WebFAQ Hungarian question -> answer | 100% | 95.2% |
| W  WebFAQ English question -> answer | 100% | 95.4% |
| P  Hungarian exact phrase (6 words) | 76.1% | 59.1% |
| K  Hungarian 3 rare keywords | 69.7% | 49.7% |

Of the older documents the right one is among the 24 closest. With the 120 newest (30% and 8% of the questions), the right document is a
candidate for **99.9% (400 documents) and 94.5% (1,500) of the question-style sets** (A to H, W), against 30% and 8% before, and for 95.7% and
86.4% of all nine. The ranking then does what the table above says it does with a pool of this size (99.2 mean MRR with 120). The two sets that
fall short are the ones the embedder is weakest at (an exact phrase from the middle of a long article, a few rare words). Looking for **every
word of the query in the full text** finds them (SQL, the newest 24 of the matches: 96.7% and 98.3% at 400 documents, 95.0% and 100% at 1,500,
admitting 0.07 to 0.7% of the library), but it was left out: its cost grows with the size of the library's text and not with the number of
documents (22 ms for 1,500 documents of 20 KB, 6 ms for 400; a person with longer documents pays proportionally more). It is the next step if
phrases from the middle of old documents matter; the name-and-summary group does not find them.

**What a search costs.** The vectors are stored as JSON text and compared in JavaScript, so the scan is dominated by `JSON.parse` (70%), then the
SQL read (11%) and the cosines (6%). Whole search with a query embedding passed in, documents of 20 KB, 15 repetitions, on an Apple M4 Pro
(`lab/candidates/cost.lab.ts`):

| documents | window alone / before | after | the vector scan on its own |
|---|---|---|---|
| 120 | 26.5 ms | 26.5 ms | none |
| 400 | 27.4 ms | 45.3 ms | 12.0 ms |
| 1,500 | 36.4 ms | 113.6 ms | 60.6 ms |
| 5,000 | 59.9 ms | 191.9 ms (2,000 scanned) | 237 ms if all 4,880 older ones were read |

With the stored dimension at 2560 (no Matryoshka cut) the scan alone is 2.5 times that: 31.9 ms, 148.8 ms, 632 ms. The search is synchronous
while it reads, so it holds the server's event loop for that long (the review measured the worst delay equal to the whole search: 35, 101 and 147 ms
at 400, 1,500 and 3,000 documents), and a chat turn can run two such searches, one for documents and one for generated outputs; the production
machine may be slower than this one. Keep `TEI_EMBEDDER_DIMENSIONS=1024` with the 4B model for this reason. A cache of the parsed vectors
would take the steady state to about the cosine step alone (4 ms at 1,500 documents; 6 MB of `Float32Array`), at the price of a cache to keep right.

## What the numbers do not show

- The pools are 119 unrelated documents of one corpus and one right answer. A real library has near-duplicates and several relevant
  documents; there the order among them is decided by the same three signals and then by recency, which this lab does not test.
- The thresholds that read the signals themselves (topic shift under cosine 0.3, cross-conversation eligibility at 0.75 / 0.75 / 3 words)
  are untouched; their behaviour on the 4B embedder is in `docs/plans/embedding-reranker-eval/qwen3-test-2026-11-09.md` where that folder is kept.
- The project boost (5) now acts on documents of any age, as written; before, it vanished after ten minutes. It was not retuned.
- The candidate numbers: ages are random and unrelated to the question (the worst case); the vector group's recall at 400 and 1,500 documents is
  an estimate from 119 competitors a query, not a run of the embedder on libraries of that size; the libraries are random public text, with no
  near-duplicates; the cost is one Mac. The name-and-summary group has no recall measured, because the public sets have no names; its
  unit tests (`documents.older-candidates.test.ts`) show what it does and does not admit.
- A document that is a candidate only because of its name still needs a place in the cosine shortlist (the top 24) to earn the embedder's
  18 points: outside it the cosine counts as 0 however high it is, which can leave a document the question names behind documents whose
  cosines are all high. That cliff is in the ranking, not in the candidates, and was not touched.
- `matchTerms` (`working-set.ts`) keeps the punctuation a word is written with, so the last word of a question ("... 2019?") never matches a
  document that has it without the question mark. It lowers every question's lexical score by a word; it was not touched either.

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
`documents.older-candidates.test.ts` runs the real search over a real migrated SQLite file with real stored vectors in a three-dimensional
space (the embedder and the reranker are the only things replaced; the vector store is the real one, watched to count what a search reads). Twelve
of its thirteen fail on the old candidate pass; the thirteenth pins what must not change (older documents with no vectors yet leave the answer to the
newest), and one of the twelve also pins that a library that fits the window reads no extra vectors. Ten deliberate breakages of the new code (no ownership check, no cap, the newest of
the older ones instead of the closest, some word instead of every word, no query embedding handed on, ASCII-only words, no lowercase, summary
ignored, group switched off, no limit on the named group) each fail the test meant to catch them. The generated-output search gets its own
visibility test (a chat's output whose chat is gone, a follow-up's, an incognito chat's), which also fails when the older pass drops the
retrieval-class rule that only that search carries.

## Reproduce

    python -I lab/prep.py <raw-datasets> <data-dir>
    TEI_API_KEY_<port>=... python -I lab/rank-lab-features.py <data-dir> rank-lab-features.json   # needs the embedders and the reranker
    python -I lab/rank-lab-eval.py rank-lab-features.json final        # also: round2, holdout, grid

The candidate labs (public text only, the real search over a real SQLite file; `LAB_DATA` is `prep.py`'s output, `LAB_OUT` an empty directory):

    LAB_DATA=<data-dir> LAB_OUT=<out> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts cutoff     # how often the window cuts the right document off
    LAB_DATA=<data-dir> LAB_OUT=<out> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts keywords   # phrases and rare words
    LAB_DATA=<data-dir> LAB_OUT=<out> npx vitest run -c docs/plans/document-ranking/lab/candidates/vitest.config.ts cost       # what a search and the vector scan cost
    python -I lab/candidates/cosine-recall.py rank-lab-features.json                                                          # recall of the closest-by-vector group
