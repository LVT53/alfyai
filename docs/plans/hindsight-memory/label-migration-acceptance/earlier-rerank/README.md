# Earlier gate: production reranker measurement (2026-11-24, orchestrator)

Production's TEI reranker `bge-reranker-v2-m3` (127.0.0.1:7998 on the box, sigmoid scores, `truncate: true`, at most 32 texts per request: batches of 20 used) scored every blind-set message (86 about, 40 unrelated, 10 Hungarian-about-English) against all 43 temporary/ongoing facts of `part-2-acceptance/results/extraction-raw.json` (v2 keys). Synthetic text only; run on the box so the key never left it (`score.py`, 3.1 s for 136 x 43 pairs). `lex.json` = today's word rule (`mentionsMemoryEntry`, bank = the 140 v2 facts) for the same pairs. Worst case: every Earlier entry counted as in the top three for every message.

| Rule | about | wrong extra | unrelated | cross |
|---|---|---|---|---|
| word rule (live) | 52% | 52% | 25% | 0% |
| reranker >= 0.005 alone | 53% | 8% | 5% | 70% |
| (word AND rr >= 0.0005) OR rr >= 0.002 | **77%** | 16% | **8%** | 70% |

Held-out: thresholds picked on even facts -> tested on odd: about 79%, unrelated 7%; picked on odd -> even: about 75%, unrelated 7%. Both picks: hi = 0.002, lo = 0.0002-0.0005. Chosen defaults: `MEMORY_EARLIER_RERANK_MIN` = 0.002, `MEMORY_EARLIER_RERANK_WORD_MIN` = 0.0005. Target (spec): about >= 80%, unrelated <= 10%: unrelated met, about 77% (just short) in the worst case.
