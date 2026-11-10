#!/usr/bin/env python3
"""The measured recall of the older-candidates vector group, next to the README's estimate.

Input: vector-recall-questions.jsonl, written by vector-recall.lab.ts (phase "measure"): per question and library whether
the right document sat in the 120 newest, its rank among the OLDER documents by the real embedder's cosine, whether the
app's own search had it among the 24 closest older documents, and the number of other documents (c) that out-score it.

Three numbers a set and library, all on the questions whose right document is OLDER (outside the 120 newest):

  measured      the share found by the app's own search for this draw of random ages (what the lab saw)
  age-averaged  the same, in expectation over every draw of ages: with c of the library's N-1 other documents
                out-scoring the right one, the 120 newest are a random 120 of those N-1 (hypergeometric), so the chance
                that fewer than 24 of the OLDER ones out-score it is exact, with no noise from the ages
  re-applied    the README's method (cosine-recall.py: Beta-binomial over the count of 119 random competitors that out-
                score the right document) applied to the SAME questions and library: how the estimate comes out here

next to the README's published estimate (K = 24), for the sizes it covers. With the ranking lab's recorded signals as a
second argument, the estimate is also computed for the sizes the README does not list (the 488 Belebele passages):

    python3 -I vector-recall-report.py vector-recall-questions.jsonl [rank-lab-features.json]
"""
import gzip
import json
import math
import sys
from collections import defaultdict
from functools import cache

WINDOW = 120
POOL = 119
K = 24
README = {  # the README's estimate, K = 24, percent: (400 documents, 1,500 documents)
    "A": (99.7, 92.9),
    "B": (100.0, 93.6),
    "C": (100.0, 94.4),
    "D": (100.0, 92.7),
    "E": (99.0, 94.0),
    "H": (100.0, 95.2),
    "W": (100.0, 95.4),
    "P": (76.1, 59.1),
    "K": (69.7, 49.7),
}
README_CANDIDATE = {400: (99.9, 95.7), 1500: (94.5, 86.4)}  # question-style sets, all nine sets
QUESTION_STYLE = ["A", "B", "C", "D", "E", "H", "W"]
ORDER = ["A", "B", "C", "D", "E", "H", "W", "P", "K"]
FAMILY = {"A": "hunsum", "P": "hunsum", "K": "hunsum", "H": "wf-hu", "W": "wf-en", "B": "bel-en", "E": "bel-en", "C": "bel-hu", "D": "bel-hu"}
LABEL = {
    "A": "A  hu news <- hu abstract",
    "B": "B  en passage <- hu question",
    "C": "C  hu passage <- en question",
    "D": "D  hu passage <- hu question",
    "E": "E  en passage <- en question",
    "H": "H  webfaq hu question -> answer",
    "W": "W  webfaq en question -> answer",
    "P": "P  hu exact phrase (6 words)",
    "K": "K  hu 3 rare keywords",
}


# ---- the README's estimator (copied from cosine-recall.py) --------------------------------------------------------
def lbeta(a, b):
    return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)


def bb_cdf_below(k, n, a, b):
    if n < k:
        return 1.0
    total = 0.0
    for j in range(k):
        log_c = math.lgamma(n + 1) - math.lgamma(j + 1) - math.lgamma(n - j + 1)
        total += math.exp(log_c + lbeta(j + a, n - j + b) - lbeta(a, b))
    return total


@cache
def estimate(c, m, n, k):
    return bb_cdf_below(k, n, c + 0.5, m - c + 0.5)


def estimate_from_features(features, letter, n_total):
    """The README's number for a set at a library size, from the ranking lab's recorded cosines (4B, 1024-d)."""
    for s in features["sets"]:
        if s["name"][0] != letter:
            continue
        vals = []
        for q in s["queries"]:
            gold = next(r for r in q["rows"] if r["id"] == q["gold"])
            c = sum(1 for r in q["rows"] if r["id"] != q["gold"] and r["s4"] > gold["s4"])
            vals.append(estimate(c, POOL, n_total - WINDOW - 1, K))
        return 100 * sum(vals) / len(vals)
    return None


# ---- the exact chance, over every draw of ages ----------------------------------------------------------------------
@cache
def p_found(c, n_total, k=K):
    """c of the other n_total - 1 documents out-score the right one; the 120 newest are a random 120 of those others
    (the right document being older). Chance that fewer than k of the older ones out-score it."""
    if c < k:
        return 1.0
    others = n_total - 1
    lo, hi = c - (k - 1), min(c, WINDOW)  # beaters inside the window: at least lo
    if lo > hi:
        return 0.0
    numer = sum(math.comb(c, x) * math.comb(others - c, WINDOW - x) for x in range(lo, hi + 1))
    return numer / math.comb(others, WINDOW)


def size_of(lib):
    return int(lib.rsplit("-", 1)[1])


def main():
    opener = gzip.open if sys.argv[1].endswith(".gz") else open
    with opener(sys.argv[1], "rt", encoding="utf-8") as source:
        records = [json.loads(line) for line in source if line.strip()]
    features = json.load(open(sys.argv[2], encoding="utf-8")) if len(sys.argv) > 2 else None
    cells = defaultdict(list)  # (set, lib) -> records
    for r in records:
        cells[(r["set"], r["lib"])].append(r)
    libs = sorted({r["lib"] for r in records}, key=lambda s: (s.rsplit("-", 1)[0], size_of(s)))
    expected = {(s, f"{FAMILY[s]}-{n}") for s in ORDER for n in ((400, 488, 1500) if s in "BCDE" else (400, 1500))}
    if set(cells) != expected or any(len(rs) != 300 for rs in cells.values()):
        raise ValueError("Incomplete measurement: expected 22 cells, 300 questions each (6,600 runs)")
    if len({(r["lib"], r["qid"]) for r in records}) != len(records):
        raise ValueError("Duplicate question/library records")
    for (s, lib), rs in cells.items():
        if any(r["N"] != size_of(lib) or r["set"] != r["qid"].split(":", 1)[0] for r in rs):
            raise ValueError(f"Invalid size or question id in {s}/{lib}")
        if any(r["ties"] or r["appVector"] != (r["rankOlder"] is not None and r["rankOlder"] <= K)
               or r["inWindow"] != (r["rankOlder"] is None)
               or r["appCandidate"] != (r["inWindow"] or r["appVector"])
               or r["nVectorGroup"] != K or r["nCandidates"] != WINDOW + K for r in rs):
            raise ValueError(f"Ties, disagreement or unexpected candidates in {s}/{lib}")

    print(f"{len(records)} question runs in {len(libs)} libraries")
    print(f"documents tied with the right one in cosine (all runs): {sum(r['ties'] for r in records)}")
    bad = [r for r in records if r["appVector"] != (r["rankOlder"] is not None and r["rankOlder"] <= K)]
    print(f"the app's {K} closest older documents vs our own cosines, disagreements: {len(bad)}")
    extra = sum(1 for r in records if r["nCandidates"] != WINDOW + r["nVectorGroup"])
    print(f"searches whose candidate list was not the 120 newest + the vector group (the name group fired): {extra}")

    def readme_value(letter, lib):
        """(value in percent or None, note)"""
        size = size_of(lib)
        if lib.startswith("bel-") and size == 1500:
            return None, "mixed"
        if size in (400, 1500):
            return README[letter][0 if size == 400 else 1], ""
        if features is not None:
            return estimate_from_features(features, letter, size), "recomputed"
        return None, "n/a"

    print(f"\n=== MEASURED: the right document among the {K} closest OLDER documents by stored 1024-d vector (Qwen3-Embedding-4B)")
    print("    Q = questions; n = those whose right document is older than the 120 newest (this draw of random ages); found = by the app's own search")
    print("    measured = found / n; age-averaged = exact expectation over every draw of ages for these questions and libraries")
    print("    re-applied = the README's Beta-binomial method on these same questions; README = its published estimate (recomputed = same method, other size)")
    print(
        "set".ljust(32) + "library".ljust(13) + "Q".rjust(5) + "n".rjust(5) + "found".rjust(6)
        + "measured".rjust(12) + "age-averaged".rjust(14) + "re-applied".rjust(12) + "README".rjust(9) + "meas-README".rjust(12)
    )
    table = {}
    for s in ORDER:
        for lib in libs:
            rs = cells.get((s, lib))
            if not rs:
                continue
            n_total = rs[0]["N"]
            older = [r for r in rs if not r["inWindow"]]
            n, found = len(older), sum(1 for r in older if r["appVector"])
            exact = [p_found(r["c"], n_total) for r in rs]
            age_avg = sum(exact) / len(exact)
            reapplied = sum(sum(estimate(c, POOL, n_total - WINDOW - 1, K) for c in r["c119"]) / len(r["c119"]) for r in rs) / len(rs)
            readme, note = readme_value(s, lib)
            readme_txt = f"{readme:6.1f}%" if readme is not None else f"{note:>7s}"
            diff = f"{100 * age_avg - readme:+6.1f}" if readme is not None else ""
            print(
                (LABEL[s].ljust(32) + lib.ljust(13) + str(len(rs)).rjust(5) + str(n).rjust(5) + str(found).rjust(6)
                + f"{100 * found / n:6.1f}%".rjust(12)
                + f"{100 * age_avg:6.1f}%".rjust(14)
                + f"{100 * reapplied:10.1f}%" + readme_txt.rjust(9) + diff.rjust(12)).rstrip()
            )
            table[(s, lib)] = {"found": found, "n": n, "age": age_avg, "re": reapplied, "exact": exact, "readme": readme}
    print("    (meas-README = age-averaged minus README, in points)")
    print("    Descriptive results: shared passages, paired sets and a single library draw preclude independent-question confidence intervals.")
    print("    Differences include sample, library and embedding-source changes; they do not establish statistical significance.")

    print("\n=== MEANS over sets (each set counts once; 'age-averaged' is the exact expectation over ages for these fixed libraries)")
    groups = (
        (400, "all nine sets", ORDER),
        (400, "question-style sets", QUESTION_STYLE),
        (400, "P and K (phrase, rare words)", ["P", "K"]),
        (1500, "A H W P K (like-for-like)", ["A", "H", "W", "P", "K"]),
        (1500, "A H W (question-style)", ["A", "H", "W"]),
        (1500, "P and K (phrase, rare words)", ["P", "K"]),
        (488, "Belebele B C D E (whole corpus)", ["B", "C", "D", "E"]),
    )
    for size, title, group in groups:
        rows = [(s, table.get((s, f"{FAMILY[s]}-{size}"))) for s in group]
        rows = [(s, t) for s, t in rows if t]
        if not rows:
            continue
        measured = sum(100 * t["found"] / t["n"] for _, t in rows) / len(rows)
        age = sum(100 * t["age"] for _, t in rows) / len(rows)
        reapplied = sum(100 * t["re"] for _, t in rows) / len(rows)
        have = [t["readme"] for _, t in rows if t["readme"] is not None]
        readme = sum(have) / len(have) if len(have) == len(rows) else None
        line = (
            f"  N={size:4d} {title:32s} ({len(rows)} sets): measured {measured:5.1f}%  age-averaged {age:5.1f}%"
            f"  re-applied {reapplied:5.1f}%"
        )
        if readme is not None:
            line += f"  README {readme:5.1f}%  age-averaged - README {age - readme:+5.1f}"
        print(line)

    print("\n=== The estimator itself, on these questions: re-applied minus age-averaged (positive = the method is optimistic), all cells with a README size")
    diffs = [100 * (t["re"] - t["age"]) for (s, lib), t in table.items() if size_of(lib) in (400, 1500) and not (lib.startswith("bel-") and size_of(lib) == 1500)]
    if diffs:
        print(f"  {len(diffs)} cells: mean {sum(diffs) / len(diffs):+.2f} points, mean |diff| {sum(abs(d) for d in diffs) / len(diffs):.2f}, largest {max(diffs, key=abs):+.2f}")

    print("\n=== The right document is a CANDIDATE (120 newest + 24 closest older + name group), share of ALL questions of the sets")
    print("    candidate (app) = in the list the ranker was given; expected = 120/N + (1 - 120/N) * age-averaged; README: 99.9 / 95.7 (400), 94.5 / 86.4 (1,500)")
    for size in (400, 488, 1500):
        for title, group in (("question-style sets", QUESTION_STYLE), ("all sets", ORDER)):
            vals = []
            for s in group:
                lib = f"{FAMILY[s]}-{size}"
                rs = cells.get((s, lib))
                if rs:
                    vals.append((sum(1 for r in rs if r["appCandidate"]) / len(rs), rs[0]["N"], table[(s, lib)]["age"]))
            if not vals or (title == "all sets" and len(vals) == len([1 for s in QUESTION_STYLE if cells.get((s, f"{FAMILY[s]}-{size}"))])):
                continue
            got = 100 * sum(v[0] for v in vals) / len(vals)
            exp = 100 * sum(WINDOW / v[1] + (1 - WINDOW / v[1]) * v[2] for v in vals) / len(vals)
            readme = f"   README {README_CANDIDATE[size][0 if group is QUESTION_STYLE else 1]:.1f}%" if size in README_CANDIDATE else ""
            mixed = "   (B-E are mixed libraries here)" if size == 1500 else ""
            print(f"  N={size:4d} {title:20s} ({len(vals)} sets): candidate (app) {got:5.1f}%   expected {exp:5.1f}%{readme}{mixed}")

    print("\n=== Where the right document ranks among the OLDER documents (this draw): found within the K closest, K = 12, 24, 48, 96")
    for s in ORDER:
        for lib in libs:
            rs = cells.get((s, lib))
            older = [r for r in rs if not r["inWindow"]] if rs else []
            if not older:
                continue
            row = LABEL[s].ljust(32) + lib.ljust(13) + f"n={len(older):4d}  "
            for k in (12, 24, 48, 96):
                row += f"K{k}: {100 * sum(1 for r in older if r['rankOlder'] <= k) / len(older):5.1f}%  "
            ranks = sorted(r["rankOlder"] for r in older)
            row += f"median rank {ranks[len(ranks) // 2]}, worst {ranks[-1]}"
            print(row)

    print("\n=== Whole real search, milliseconds (median), per library, this Mac (reranker off, query vector handed in)")
    for lib in libs:
        ms = sorted(r["ms"] for r in records if r["lib"] == lib)
        print(f"  {lib:13s} {ms[len(ms) // 2]:5d}")


main()
