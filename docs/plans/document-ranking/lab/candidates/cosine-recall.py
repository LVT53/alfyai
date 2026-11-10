#!/usr/bin/env python3
"""How often does the right document land in the top K by the embedder's cosine among N documents?

Input: the earlier ranking lab's recorded signals (public text only; docs/plans/document-ranking/lab):
per query, the right document and 119 others drawn from the same corpus, each with the real cosine of the
Qwen3-Embedding-4B (1024-d) and of the old 0.6B. The pool is a random sample of the corpus, so the share of
other documents that out-score the right one (p) is estimable from the 119, and a library of N documents has
N-1 such competitors: the count that beat the right document is Binomial(N-1, p) with p ~ Beta(c+.5, 119-c+.5)
(c = how many of the 119 beat it). P(rank <= K) is the Beta-binomial mass below K.

    python -I cosine_recall.py rank-lab-features.json
"""
import json
import math
import random
import sys

POOL = 119  # competitors recorded per query


def lbeta(a, b):
    return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)


def bb_cdf_below(k, n, a, b):
    """P(X <= k-1) for X ~ BetaBinomial(n, a, b): the right document has fewer than k competitors above it."""
    if n < k:
        return 1.0
    total = 0.0
    for j in range(k):
        log_c = math.lgamma(n + 1) - math.lgamma(j + 1) - math.lgamma(n - j + 1)
        total += math.exp(log_c + lbeta(j + a, n - j + b) - lbeta(a, b))
    return total


def recall(c, m, n, k):
    """c of m sampled competitors beat the right one; a library with n competitors: P(fewer than k beat it)."""
    return bb_cdf_below(k, n, c + 0.5, m - c + 0.5)


def competitors_above(q, key):
    gold = next(r for r in q["rows"] if r["id"] == q["gold"])
    return sum(1 for r in q["rows"] if r["id"] != q["gold"] and r[key] > gold[key])


def main():
    data = json.load(open(sys.argv[1]))
    sets = data["sets"]
    sizes = [120, 400, 1500]
    ks = [12, 24, 48]
    for key, label in (("s4", "Qwen3-Embedding-4B, 1024-d (production)"), ("s06", "old 0.6B")):
        print(f"\n=== {label}: P(right document is in the top K by cosine among the library's OLDER documents)")
        print("    (the 120 newest are candidates already; n = N - 121 other older documents compete)")
        header = "set".ljust(34) + "".join(f"N={n}/K={k}".rjust(13) for n in (400, 1500) for k in ks)
        print(header)
        totals = {(n, k): [] for n in (400, 1500) for k in ks}
        for s in sets:
            row = s["name"][:33].ljust(34)
            for n in (400, 1500):
                for k in ks:
                    vals = [recall(competitors_above(q, key), POOL, n - 121, k) for q in s["queries"]]
                    totals[(n, k)].append(sum(vals) / len(vals))
                    row += f"{100 * sum(vals) / len(vals):12.1f}%"
            print(row)
        print("MEAN of the nine sets".ljust(34) + "".join(f"{100 * sum(v) / len(v):12.1f}%" for v in totals.values()))

        # Of ALL questions: newest 120 are found already, the rest need the older pass.
        print("\n  Right document among the candidates (newest 120 + K older by cosine), mean of the nine sets:")
        for n in (400, 1500):
            for k in ks:
                older = sum(totals[(n, k)]) / len(totals[(n, k)])
                share = 120 / n
                print(f"    N={n:4d} K={k:2d}: {100 * (share + (1 - share) * older):5.1f}%  (today: {100 * share:4.1f}%)")

    # Does the extrapolation work? Predict a 120-pool outcome from only 30 of its 119 competitors.
    print("\n=== Check of the method: predict P(rank<=K) among 119 competitors from a random 30 of them")
    rng = random.Random(7)
    for key in ("s4",):
        for k in (12, 24):
            actual, predicted = [], []
            for s in sets:
                for q in s["queries"]:
                    gold = next(r for r in q["rows"] if r["id"] == q["gold"])
                    others = [r[key] for r in q["rows"] if r["id"] != q["gold"]]
                    actual.append(1.0 if sum(1 for v in others if v > gold[key]) < k else 0.0)
                    for _ in range(5):
                        sub = rng.sample(others, 30)
                        c = sum(1 for v in sub if v > gold[key])
                        predicted.append(recall(c, 30, POOL, k) / 5)
            a = 100 * sum(actual) / len(actual)
            p = 100 * sum(predicted) / len(actual)
            print(f"  {key} K={k:2d}: actual {a:5.1f}%   predicted from 30 competitors {p:5.1f}%")

    # Raw, no model: how the right document ranks among the 119 competitors (the lab's own pools).
    print("\n=== Raw ranks inside the lab's 120-document pools (no extrapolation), 4B")
    for s in sets:
        ranks = [competitors_above(q, "s4") + 1 for q in s["queries"]]
        n = len(ranks)
        print(
            f"  {s['name'][:34].ljust(35)} top1 {100 * sum(r <= 1 for r in ranks) / n:5.1f}%  "
            f"top12 {100 * sum(r <= 12 for r in ranks) / n:5.1f}%  top24 {100 * sum(r <= 24 for r in ranks) / n:5.1f}%  "
            f"top48 {100 * sum(r <= 48 for r in ranks) / n:5.1f}%"
        )


main()
