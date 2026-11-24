import json, re, sys, os
# usage: python3 tally-config3.py <outputs folder> <round label> [<round label> ...] [--show]
#
# The Config 3 round's counts (docs/plans/hindsight-memory/overview-hungarian-2026-11-24.md, "Config 3 round"):
#  - the mechanical slips of tally.py plus the loan words of a Hungarian paragraph;
#  - the completeness count C: of the scope's subjects that have current entries, how many the paragraph covers,
#    and which entries are nowhere in it. A first pass is made here with one pattern per entry (Hungarian and
#    English); it is an AID. The counts the note reports are the ones read off every paragraph by hand
#    (`--show` prints each paragraph beside what the patterns found, so the reader can overrule them).
HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS = os.path.dirname(HERE)

# (id, subject, Hungarian pattern, English pattern, what it is)
PERSONAL = [
    ("p01", "work_study", r"logó|ügyfél", r"logo|client", "logo due Friday"),
    ("p02", "health", r"térd|gyógytorn", r"knee|physio", "knee, physiotherapy"),
    ("p03", "other", r"alkohol", r"alcohol", "no alcohol this week"),
    ("p04", "home_family", r"anyós", r"mother-in-law", "mother-in-law next week"),
    ("p05", "projects", r"Lisszabon", r"Lisbon", "trip to Lisbon"),
    ("p06", "work_study", r"könyvesbolt|arculat", r"book ?shop|bookstore|brand|identity", "bookshop identity"),
    ("p07", "projects", r"kunyhó|kerti ház|faház", r"shed|hut|cabin", "garden shed"),
    ("p08", "projects", r"ukulel[eé]", r"ukulele", "ukulele"),
    ("p09", "home_family", r"új lakás|lakást keres|nagyobb lakás|újat keres|új, nagyobb|új otthon|lakáskeres", r"new (flat|apartment|home|place)|larger|bigger|looking for|searching", "looking for a new flat"),
    ("p10", "interests", r"japán", r"Japanese", "learns Japanese"),
    ("p11", "interests", r"keny[eé]r|kovász", r"sourdough|bread|baking|bakes", "sourdough"),
    ("p12", "interests", r"boulder|falmász|sziklamász|mászik|mászás|mászó", r"boulder|climb", "bouldering"),
    ("p13", "work_study", r"mester(képz|szak|diploma|fok)|diplom|egyetem", r"master|degree|graduat", "part-time master's"),
    ("p14", "about_you", r"\b35\b", r"\b35\b", "35 years old"),
    ("p15", "about_you", r"anyanyelv|angol", r"native|English|fluent", "Hungarian native, fluent English"),
    ("p16", "about_you", r"vegetári", r"vegetarian", "vegetarian"),
    ("p17", "home_family", r"kétszobás|két ?szob|(Győrben|Győrött) (él|lak)", r"two-?(bed)?room|two ?bed|(lives|living|lived) in Győr", "lives in Győr, two rooms"),
    ("p18", "home_family", r"Márk", r"Márk|Mark|partner", "partner Márk"),
    ("p19", "home_family", r"Lili|lány", r"Lili|daughter", "daughter Lili"),
    ("p20", "home_family", r"Mák|macska", r"Mák|cat\b", "cat Mák"),
    ("p21", "home_family", r"Bence|öcs", r"Bence|brother", "brother Bence in Szeged"),
    ("p22", "work_study", r"grafikus", r"graphic|designer", "graphic designer"),
    ("p23", "health", r"laktóz", r"lactose", "lactose intolerant"),
    ("p24", "health", r"rövidlátó|szemüveg", r"short-?sighted|myopi|glasses", "short-sighted, glasses"),
    ("p25", "interests", r"sci-fi|scifi|tudományos-fantasztikus|fantasztikus|Le Guin|regény", r"sci-fi|science.fiction|Le Guin|novels", "sci-fi novels, Le Guin"),
    ("p26", "interests", r"Bakony|túr", r"Bakony|hik", "hiking in the Bakony"),
    ("p27", "interests", r"kávé", r"coffee", "black coffee"),
    ("p28", "other", r"rövid.{0,25}válasz|lényegre|tömör", r"short|concise|brief|to the point", "short answers"),
    ("p29", "other", r"telefon", r"phone|calls?\b", "dislikes phone calls"),
    ("p30", "other", r"Szeged", r"Szeged", "earlier lived in Szeged"),
]
PROJECT = [
    ("j01", "plans_status", r"tetőfedő|lemez", r"roof(ing)? (sheets|panels|material)|roofing|sheets", "roof sheets next week"),
    ("j02", "plans_status", r"falváz|alap.{0,40}(elkészült|kész)", r"frame|foundation (is|has been) (complete|done|finished)|foundation is", "foundation done, frame under way"),
    ("j03", "plans_status", r"festés|szín", r"paint|colou?r", "paint colour undecided"),
    ("j04", "plans_status", r"ajtó", r"door", "two-leaf door opening outward"),
    ("j05", "goals_decisions", r"szerszám|bútor|tárol", r"tools|furniture|storage|store", "purpose: storage"),
    ("j06", "goals_decisions", r"fából|könnyebb|megmunkál", r"made (of|from) wood|wooden|easier", "wood chosen: easier to work"),
    ("j07", "goals_decisions", r"egyfedeles|lejtés", r"single-?pitch|mono-?pitch|slope|pitch", "single-pitch roof"),
    ("j08", "people", r"édesap|apja|apjá", r"father|dad", "Kata and her father"),
    ("j09", "people", r"Péter|nagybáty", r"Péter|Peter|uncle", "uncle Péter poured the foundation"),
    ("j10", "facts_figures", r"12 négyzet|12 m", r"12 (square|sq)|12 m", "12 square metres"),
    ("j11", "facts_figures", r"fűrész|180", r"sawmill|180", "sawmill, 180 thousand forints"),
    ("j12", "facts_figures", r"északi", r"north", "north corner of the garden"),
]
SCOPES = {"personal": PERSONAL, "project": PROJECT}

def sentences(t):
    t = re.sub(r"\bK\. ", "K_ ", t)
    return [s for s in re.split(r"(?<=[.!?])\s+", t.strip()) if s]

def loans(t):
    found = []
    for name, pat in (("freelance", r"freelanc"), ("boulder", r"boulder"), ("sci-fi", r"sci-?fi")):
        if re.search(pat, t, re.I): found.append(name)
    return found

def mech(r):
    t = r["text"]; hu = r["language"] == "hu"
    return {
        "japant": hu and bool(re.search(r"japánt tanul", t)),
        "bakony_noarticle": hu and bool(re.search(r"(?<!a )(?<!A )Bakonyban", t)),
        "peter": bool(re.search(r"\bPeter\b", t)),
        "meta": bool(re.search(r"\b(memory|entries|entry|bejegyz|memória)", t, re.I)),
        "markup": bool(re.search(r"[*#`\"„“]|^\s*[-•]", t)),
    }

def coverage(r):
    t = r["text"]; hu = r["language"] == "hu"
    entries = SCOPES[r["scope"]]
    missing, covered_subjects, subjects = [], set(), []
    for eid, subj, phu, pen, what in entries:
        if subj not in subjects: subjects.append(subj)
        if re.search(phu if hu else pen, t, re.I):
            covered_subjects.add(subj)
        else:
            missing.append((eid, what))
    return len(entries), missing, len(covered_subjects), len(subjects), [s for s in subjects if s not in covered_subjects]

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show = "--show" in sys.argv
    scr, rounds = args[0], args[1:]
    for rd in rounds:
        d = json.load(open(os.path.join(scr, "%s.json" % rd)))
        print("=== %s (%d results, %d errors)" % (rd, len(d["results"]), sum(1 for r in d["results"] if "error" in r)))
        agg = {}
        for r in d["results"]:
            if "text" not in r: continue
            n = len(sentences(r["text"])); total, missing, cs, ns, miss_subj = coverage(r)
            key = (r["scope"], r["language"])
            a = agg.setdefault(key, dict(n=0, sent=0, chars=0, covered=0, total=total, subj=0, subjtot=ns, loans={}, over10=0, over6=0, mech={}))
            a["n"] += 1; a["sent"] += n; a["chars"] += len(r["text"]); a["covered"] += total - len(missing); a["subj"] += cs
            a["over10"] += n > 10; a["over6"] += n > 6
            if r["language"] == "hu":
                for l in loans(r["text"]): a["loans"][l] = a["loans"].get(l, 0) + 1
            for k, v in mech(r).items():
                if v: a["mech"][k] = a["mech"].get(k, 0) + 1
            if show:
                print("\n[%s %s run %s] %d sentences, %d chars; loans %s; covers %d/%d subjects, %d/%d entries by pattern" % (r["scope"], r["language"], r["run"], n, len(r["text"]), loans(r["text"]) if r["language"] == "hu" else "-", cs, ns, total - len(missing), total))
                print(r["text"])
                print("  NOT FOUND BY PATTERN: " + ", ".join("%s (%s)" % m for m in missing) if missing else "  all entries found by pattern")
                if miss_subj: print("  SUBJECTS NOT COVERED: " + ", ".join(miss_subj))
        print("\n%-9s %-3s %3s | sentences chars | subjects covered | entries found (pattern) | >10 >6 | loans (hu) | mechanical" % ("scope", "ui", "n"))
        for (scope, lang), a in sorted(agg.items()):
            print("%-9s %-3s %3d | %9.1f %5d | %5.1f of %d | %10.1f of %d | %2d %2d | %s | %s" % (
                scope, lang, a["n"], a["sent"] / a["n"], a["chars"] / a["n"], a["subj"] / a["n"], a["subjtot"],
                a["covered"] / a["n"], a["total"], a["over10"], a["over6"], a["loans"] or "-", a["mech"] or "-"))

main()
