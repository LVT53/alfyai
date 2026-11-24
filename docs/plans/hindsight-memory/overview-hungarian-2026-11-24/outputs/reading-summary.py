import json, re, sys, os
# usage: python3 reading-summary.py <outputs folder> <round label> [<round label> ...]
#
# The Config 3 round's counts as read by hand: `config3-reading.json` holds, for every paragraph of a round, what
# the reader found (entries nowhere in it, entries only pointed at by a group mention, loan words left in, other
# English words, the U and I slips with a quote each, sentences over the cap, mentions of a removed entry, wrong
# language). This prints the table rows the note reports; sentences and characters come from the saved outputs.
HERE = os.path.dirname(os.path.abspath(__file__))
SUBJECT_OF = {}
for line in open(os.path.join(HERE, "tally-config3.py"), encoding="utf8"):
    m = re.match(r'\s+\("([pj]\d\d)", "(\w+)",', line)
    if m: SUBJECT_OF[m.group(1)] = m.group(2)

def sentences(t):
    t = re.sub(r"\bK\. ", "K_ ", t)
    return [s for s in re.split(r"(?<=[.!?])\s+", t.strip()) if s]

def main():
    scr, rounds = sys.argv[1], sys.argv[2:]
    reading = json.load(open(os.path.join(scr, "config3-reading.json")))
    for rd in rounds:
        out = json.load(open(os.path.join(scr, "%s.json" % rd)))
        texts = {"%s/%s/%s" % (r["scope"], r["language"], r["run"]): r["text"] for r in out["results"] if "text" in r}
        print("=== %s" % rd)
        print("cell            n | sentences chars | nowhere (of N) | grouped | subjects (of S) | all subjects | loans left (per paragraph) | invented | E other | U | I | L | P | W")
        for scope in ("personal", "project"):
            ids = [k for k in SUBJECT_OF if k.startswith("p" if scope == "personal" else "j")]
            subjects = sorted({SUBJECT_OF[k] for k in ids})
            for lang in ("hu", "en"):
                keys = [k for k in reading[rd] if k.startswith("%s/%s/" % (scope, lang))]
                if not keys: continue
                n = len(keys); tot = lambda f: sum(f(reading[rd][k]) for k in keys)
                sent = sum(len(sentences(texts[k])) for k in keys) / n
                chars = sum(len(texts[k]) for k in keys) / n
                missing = tot(lambda r: len(r["missing"]))
                grouped = tot(lambda r: len(r.get("grouped", [])))
                def covered(r):
                    return sum(1 for s in subjects if any(SUBJECT_OF[i] == s and i not in r["missing"] for i in ids))
                subj = tot(covered) / n
                allsub = sum(1 for k in keys if covered(reading[rd][k]) == len(subjects))
                loans = {}
                for k in keys:
                    for l in reading[rd][k]["loans"]: loans[l] = loans.get(l, 0) + 1
                invented = "-" if not any("invented" in reading[rd][k] for k in keys) else str(tot(lambda r: len(r.get("invented", []))))
                print("%-9s %-3s %3d | %9.1f %5d | %5.1f of %-3d (%2d) | %7d | %5.1f of %d | %2d of %d | %s (%.1f) | %s | %d | %d | %d | %d | %d | %d" % (
                    scope, lang, n, sent, chars, missing / n, len(ids), missing, grouped, subj, len(subjects), allsub, n,
                    dict(sorted(loans.items())) or "-", sum(loans.values()) / n, invented,
                    tot(lambda r: len(r["E"])), tot(lambda r: len(r["U"])), tot(lambda r: len(r["I"])),
                    tot(lambda r: r["L"]), tot(lambda r: r["P"]), tot(lambda r: r["W"])))

main()
