#!/usr/bin/env python3
"""Evaluates document-ranking formulas offline from rank-lab-features.json. No model is called.

    python -I rank-lab-eval.py <features.json> [grid]

Replicates rankArtifactMatches' shortlist exactly: lexical top 12 (L > 0, by L then newest) followed by the semantic top 24,
the reranker scoring only the first CAP shortlisted items (CAP = TEI_RERANKER_MAX_TEXTS = 8 in production). A variant is a
function (query features, embedder) -> the documents in final order; a miss is a gold document that is not shortlisted.
"""
import itertools
import json
import math
import random
import sys

feats = json.load(open(sys.argv[1], encoding="utf-8"))
GRID = len(sys.argv) > 2 and sys.argv[2] == "grid"
CAP = 8
RECENCY = 8.64e-5  # updatedAt / 1e12 changes by this much per day of age


def shortlist(q, emb):
    rows = q["rows"]
    lex_top = sorted((r for r in rows if r["L"] > 0), key=lambda r: (-r["L"], r["age_days"]))[:12]
    sem_top = sorted(rows, key=lambda r: -r[emb])[:24]
    short, seen = [], set()
    for r in lex_top + sem_top:
        if r["id"] not in seen:
            seen.add(r["id"])
            short.append(r)
    return short, {r["id"] for r in sem_top}


def order(items, key):
    # highest key first; ties go to the more recently updated document, as the app does
    return [r["id"] for r in sorted(items, key=lambda r: (-key(r), r["age_days"]))]


def v_current(q, emb):
    # today: the decay factor exp(-0.011 * age) is exactly 0 for an age of a day or more, leaving 0.35 * lexical
    short, sem = shortlist(q, emb)
    return order(short, lambda r: 0.35 * r["L"])


BOUNDARY_RATE = 0.05  # context.ts applyConversationBoundaryPenalty: score * exp(-0.05 * days) outside the current conversation


def make_sum(wl, ws, wr, lex_fraction=False, rerank_by="lexical", cap=CAP, power=1.0, full=0.0, boundary=0.0):
    def lexical(q, r):
        if not lex_fraction:
            return r["L"]
        frac = min(r["L"] / max(q["T"], 1), 1.0)
        return frac**power + (full / max(wl, 1e-9) if (q["T"] >= 3 and r["L"] >= q["T"]) else 0.0)

    def v(q, emb):
        short, sem = shortlist(q, emb)
        if rerank_by == "lexical":  # the app: the first CAP of the shortlist, which starts with the lexical hits
            reranked = {r["id"] for r in short[:cap]}
        elif rerank_by == "semantic":  # the CAP shortlisted documents with the highest cosine
            reranked = {r["id"] for r in sorted(short, key=lambda r: -r[emb])[:cap]}
        else:  # hybrid: the CAP best by the lexical + cosine part of the score
            pre = lambda r: wl * lexical(q, r) + ws * (r[emb] if r["id"] in sem else 0.0)
            reranked = {r["id"] for r in sorted(short, key=lambda r: -pre(r))[:cap]}

        def key(r):
            s = r[emb] if r["id"] in sem else 0.0
            rr = r["R"] if (r["id"] in reranked and r["R"] is not None) else 0.0
            total = wl * lexical(q, r) + ws * s + wr * rr
            if boundary:
                total = (total + 1.78) * math.exp(-boundary * r["age_days"])  # 1.78 = updatedAt / 1e12, inside the app's sum
            return total - r["age_days"] * RECENCY

        return order(short, key)

    return v


def v_current_boundary(q, emb):
    # today's order, then context.ts's penalty: 0.35 * lexical * exp(-0.05 * days)
    short, sem = shortlist(q, emb)
    return order(short, lambda r: 0.35 * r["L"] * math.exp(-BOUNDARY_RATE * r["age_days"]))


def make_rrf(wl, ws, wr, k=60, cap=CAP):
    def v(q, emb):
        short, sem = shortlist(q, emb)
        rank_s = {r["id"]: i for i, r in enumerate(sorted(short, key=lambda r: -r[emb]))}
        rank_l = {r["id"]: i for i, r in enumerate(sorted((r for r in short if r["L"] > 0), key=lambda r: (-r["L"], r["age_days"])))}
        reranked = sorted(short, key=lambda r: -r[emb])[:cap]
        rank_r = {r["id"]: i for i, r in enumerate(sorted((r for r in reranked if r["R"] is not None), key=lambda r: -r["R"]))}

        def key(r):
            t = ws / (k + rank_s[r["id"]])
            if r["id"] in rank_l:
                t += wl / (k + rank_l[r["id"]])
            if r["id"] in rank_r:
                t += wr / (k + rank_r[r["id"]])
            return t

        return order(short, key)

    return v


def v_embedder_alone(q, emb):
    return [r["id"] for r in sorted(q["rows"], key=lambda r: -r[emb])]


def v_retrieve_rerank(q, emb):
    # classic: the CAP best by cosine, reordered by the reranker; the rest follow by cosine
    rows = sorted(q["rows"], key=lambda r: -r[emb])
    top = [r for r in rows[:CAP] if r["R"] is not None] or rows[:CAP]
    top = sorted(top, key=lambda r: -(r["R"] or 0.0))
    return [r["id"] for r in top] + [r["id"] for r in rows if r not in top]


def evaluate(variant, emb, queries):
    hit1 = rr = 0
    for q in queries:
        ranked = variant(q, emb)
        if q["gold"] in ranked:
            pos = ranked.index(q["gold"])
            hit1 += pos == 0
            rr += 1 / (pos + 1)
    n = len(queries)
    return 100 * hit1 / n, 100 * rr / n


def table(variants, emb, subset=None, label=""):
    names = [s["name"] for s in feats["sets"]]
    short = [n.split()[0] for n in names]
    print(f"\n{label}  (hit@1 / MRR, x100; embedder {emb})")
    print(f"{'variant':44s}" + "".join(f"{s:>11s}" for s in short) + f"{'mean':>11s}{'cross-lang':>12s}{'lexical':>10s}")
    for vname, fn in variants:
        cells, mrrs = [], []
        for s in feats["sets"]:
            qs = s["queries"] if subset is None else [q for i, q in enumerate(s["queries"]) if subset(i)]
            h, m = evaluate(fn, emb, qs)
            cells.append((h, m))
            mrrs.append(m)
        mean = sum(m for _, m in cells) / len(cells)
        cross = [m for (_, m), n in zip(cells, short) if n in ("B", "C")]
        lexi = [m for (_, m), n in zip(cells, short) if n in ("P", "K")]
        print(f"{vname:44s}" + "".join(f"{h:5.0f}/{m:3.0f} " for h, m in cells) + f"{mean:>10.1f} {sum(cross) / len(cross):>11.1f} {sum(lexi) / len(lexi):>9.1f}")


ROUND2 = [
    ("3  fraction x10, cos x18, rerank x24 (best of round 1)", make_sum(10, 18, 24, lex_fraction=True, rerank_by="semantic")),
    ("7  3 + reranker sees the best by lexical+cosine", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid")),
    ("8  7 + lexical fraction squared", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", power=2.0)),
    ("9  7 + bonus 8 when every query word is found", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", full=8.0)),
    ("10 7 + bonus 15 when every query word is found", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", full=15.0)),
    ("11 9 + fraction squared", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", power=2.0, full=8.0)),
    ("12 7 with fraction x14", make_sum(14, 18, 24, lex_fraction=True, rerank_by="hybrid")),
    ("13 7 with reranker cap 16", make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", cap=16)),
    ("14 7 with no reranker at all", make_sum(10, 18, 0, lex_fraction=True, rerank_by="hybrid")),
]

VARIANTS = [
    ("0  today (decay zeroes semantic + rerank)", v_current),
    ("1  decay removed, weights as written", make_sum(10, 18, 24)),
    ("2  1 + reranker sees the best by cosine", make_sum(10, 18, 24, rerank_by="semantic")),
    ("3  2 + lexical as a fraction of the query", make_sum(10, 18, 24, lex_fraction=True, rerank_by="semantic")),
    ("4  fraction x4, cosine x30, rerank x24", make_sum(4, 30, 24, lex_fraction=True, rerank_by="semantic")),
    ("5  fraction x2, cosine x30, rerank x24", make_sum(2, 30, 24, lex_fraction=True, rerank_by="semantic")),
    ("6  rank fusion 0.5 lexical / 1 cos / 1 rerank", make_rrf(0.5, 1.0, 1.0)),
    ("ref  embedder alone", v_embedder_alone),
    ("ref  retrieve by cosine, rerank the top 8", v_retrieve_rerank),
]

def rr_per_query(fn, emb):
    out = []
    for s in feats["sets"]:
        rrs = []
        for q in s["queries"]:
            ranked = fn(q, emb)
            rrs.append(1 / (ranked.index(q["gold"]) + 1) if q["gold"] in ranked else 0.0)
        out.append(rrs)
    return out


def bootstrap_gain(before, after, reps=2000, seed=7):
    # paired bootstrap over queries, set by set; the statistic is the mean over sets of the set's MRR, x100
    rng = random.Random(seed)
    diffs = []
    for _ in range(reps):
        total = 0.0
        for a, b in zip(before, after):
            idx = [rng.randrange(len(a)) for _ in range(len(a))]
            total += (sum(b[i] for i in idx) - sum(a[i] for i in idx)) / len(a)
        diffs.append(100 * total / len(before))
    diffs.sort()
    return sum(diffs) / reps, diffs[int(0.025 * reps)], diffs[int(0.975 * reps)]


# the formula the app ships (rankArtifactMatches + document-ranking.ts): variant 11 of round 2
SHIPPED = make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", power=2.0, full=8.0)
SHIPPED_RERANKER_DOWN = make_sum(10, 18, 0, lex_fraction=True, rerank_by="hybrid", power=2.0, full=8.0)
FINAL = [
    ("0  today (decay zeroes semantic + rerank)", v_current),
    ("1  shipped", SHIPPED),
    ("2  shipped, reranker down", SHIPPED_RERANKER_DOWN),
    ("ref  embedder alone", v_embedder_alone),
    ("ref  retrieve by cosine, rerank the top 8", v_retrieve_rerank),
]

if len(sys.argv) > 2 and sys.argv[2] == "boundary":
    # what context.ts then does to documents outside the current conversation, library uploads included
    shipped_pen = make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", power=2.0, full=8.0, boundary=BOUNDARY_RATE)
    shipped_half = make_sum(10, 18, 24, lex_fraction=True, rerank_by="hybrid", power=2.0, full=8.0, boundary=BOUNDARY_RATE / 2)
    rows = [
        ("0  today", v_current),
        ("0b today, then context.ts's penalty", v_current_boundary),
        ("1  shipped", SHIPPED),
        ("1b shipped, then the penalty (0.05 / day)", shipped_pen),
        ("1c shipped, then half the penalty", shipped_half),
    ]
    table(rows, "s4", label="BOUNDARY PENALTY, 4B embedder (ages 1-60 days, random)")
    sys.exit(0)
if len(sys.argv) > 2 and sys.argv[2] == "final":
    table(FINAL, "s4", label="FINAL, 4B embedder (production now)")
    table(FINAL, "s06", label="FINAL, old 0.6B embedder")
    for sub_name, sub in (("even-numbered queries only", lambda i: i % 2 == 0), ("odd-numbered queries only", lambda i: i % 2 == 1)):
        table(FINAL[:3], "s4", subset=sub, label=sub_name + ", 4B")
    print("\nGain of the shipped order over today's, MRR x100, mean of the nine sets (paired bootstrap over queries, 95% interval):")
    for emb in ("s4", "s06"):
        mean, lo, hi = bootstrap_gain(rr_per_query(v_current, emb), rr_per_query(SHIPPED, emb))
        print(f"  {emb}: +{mean:.1f}  [{lo:+.1f} .. {hi:+.1f}]")
    sys.exit(0)
if len(sys.argv) > 2 and sys.argv[2] == "holdout":
    # no fitting here: the same variants scored on the even-numbered and on the odd-numbered queries separately
    for sub_name, sub in (("even-numbered queries", lambda i: i % 2 == 0), ("odd-numbered queries", lambda i: i % 2 == 1)):
        table([VARIANTS[0], ROUND2[0], ROUND2[1], ROUND2[2], ROUND2[3], ROUND2[5]], "s4", subset=sub, label=sub_name)
    sys.exit(0)
if len(sys.argv) > 2 and sys.argv[2] == "round2":
    table([VARIANTS[0]] + ROUND2, "s4", label="round 2, 4B embedder")
    table([VARIANTS[0], ROUND2[0], ROUND2[1], ROUND2[3]], "s06", label="round 2, old 0.6B embedder")
    sys.exit(0)
table(VARIANTS, "s4", label="4B embedder (production now)")
table([VARIANTS[0], VARIANTS[1], VARIANTS[4], VARIANTS[7], VARIANTS[8]], "s06", label="old 0.6B embedder, for comparison")

if GRID:
    print("\nGRID: lexical fraction weight x cosine weight x rerank weight (rerank sees the best by cosine); tuned on even-numbered queries, scored on odd ones")
    even, odd = (lambda i: i % 2 == 0), (lambda i: i % 2 == 1)

    def macro(fn, subset):
        ms, lex = [], []
        for s in feats["sets"]:
            qs = [q for i, q in enumerate(s["queries"]) if subset(i)]
            ms.append(evaluate(fn, "s4", qs)[1])
            if s["name"].split()[0] in ("P", "K"):
                lex.append(evaluate(fn, "s4", qs)[1])
        return sum(ms) / len(ms), sum(lex) / len(lex)

    results = []
    for wl, ws, wr in itertools.product([0, 1, 2, 4, 6, 10], [10, 18, 30, 50], [0, 6, 12, 24, 36]):
        fn = make_sum(wl, ws, wr, lex_fraction=True, rerank_by="semantic")
        tune = macro(fn, even)
        results.append((tune[0], wl, ws, wr, macro(fn, odd), tune[1]))
    results.sort(reverse=True)
    print(f"{'wLex':>5s}{'wCos':>6s}{'wRer':>6s}   tuned MRR   held-out MRR   held-out lexical-sets MRR")
    for tune_mrr, wl, ws, wr, held, _ in results[:12]:
        print(f"{wl:>5d}{ws:>6d}{wr:>6d}   {tune_mrr:9.1f}   {held[0]:12.1f}   {held[1]:>10.1f}")
