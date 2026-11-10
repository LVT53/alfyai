#!/usr/bin/env python3
"""Libraries and questions for the vector-recall lab. PUBLIC text only (no AlfyAI data is read anywhere).

Reads the output of ../prep.py (<data-dir>: Belebele, WebFAQ Hungarian and English, HunSum-2) and writes, into <out-dir>:

  docs.jsonl   every document that sits in any library, once: {gid, corpus, id, text}
  plan.json    the libraries (a smaller library of a corpus is a subset of its bigger one), the nine question sets
               with the right document of each question, and the license of each source

The sets are the ranking lab's (rank-lab-features.py): A Hungarian article <- its abstract, P an exact six-word phrase
of an article, K its three rarest words, B/C/D/E Belebele passages asked in the same or the other language, H/W
WebFAQ questions -> answers (Hungarian, English). Questions are built the same way as there (the P and K recipes are
copied, including its quirk of looking only at the first 80 candidate words of an article for rarity), with more of
them: 300 right documents a corpus, or every Belebele question whose passage is in the library, 300 at most.

Libraries (N documents each; the right documents of the questions are always in):

  hunsum-400 / -1500   300 right articles + 100 / 1,200 other HunSum articles of 800 to 8,000 characters
  wf-hu-400 / -1500    300 right answers + 100 / 1,200 other WebFAQ Hungarian answers
  wf-en-400 / -1500    the same for WebFAQ English
  bel-en-400 / -488    400 / all 488 Belebele English passages
  bel-hu-400 / -488    the same for Hungarian
  bel-en-1500          488 passages + 1,012 WebFAQ English answers  (Belebele has no more passages: a MIXED library)
  bel-hu-1500          488 passages + 1,012 WebFAQ Hungarian answers

    python3 -I vector-recall-prep.py <data-dir> <out-dir>
"""
import hashlib
import json
import os
import random
import sys

DATA, OUT = sys.argv[1], sys.argv[2]
SEED = 20261110
GOLD_PER_CORPUS = 300  # right documents of HunSum and of each WebFAQ language
QUESTIONS_PER_LIBRARY = 300  # at most, for the Belebele sets
STRIP = ".,;:!?()\"'„”"


def jl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def jload(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


docs = {}  # gid -> {corpus, id, text}
libraries = {}  # name -> {family, size, members: [gid]}
sets = {}  # letter -> {label, family, libraries, queries: [{qid, text, gold, libs}]}


def gid_of(corpus, doc_id):
    return f"{corpus}:{doc_id}"


def add_docs(corpus, texts, ids):
    for d in ids:
        docs.setdefault(gid_of(corpus, d), {"corpus": corpus, "id": d, "text": texts[d]})


# ------------------------------------------------------------------------------------------------ HunSum
rng = random.Random(SEED + 1)
hs_c = {r["id"]: r["text"] for r in jl(f"{DATA}/hunsum/corpus.jsonl")}
hs_q = {r["id"]: r["text"] for r in jl(f"{DATA}/hunsum/queries.jsonl")}
hs_r = jload(f"{DATA}/hunsum/qrels.json")
reservoir = sorted(d for d in hs_c if 800 <= len(hs_c[d]) <= 8000)
usable = sorted(q for q in hs_q if q in hs_r and 800 <= len(hs_c[hs_r[q][0]]) <= 8000)
rng.shuffle(usable)
gold_hs, seen_text = [], set()
for q in usable:
    d = hs_r[q][0]
    if d in gold_hs or hs_c[d] in seen_text:
        continue
    gold_hs.append(d)
    seen_text.add(hs_c[d])
    if len(gold_hs) == GOLD_PER_CORPUS:
        break
abstract_of = {hs_r[q][0]: hs_q[q] for q in usable}
gold_set = set(gold_hs)
others = [d for d in reservoir if d not in gold_set]
rng.shuffle(others)
members = {1500: gold_hs + others[:1200], 400: gold_hs + others[:100]}
for size, ids in members.items():
    add_docs("hunsum", hs_c, ids)
    libraries[f"hunsum-{size}"] = {"family": "hunsum", "size": size, "members": [gid_of("hunsum", d) for d in ids]}

a_q, p_q, k_q = [], [], []
for d in gold_hs:
    g = gid_of("hunsum", d)
    libs = ["hunsum-400", "hunsum-1500"]
    a_q.append({"qid": f"A:{d}", "text": abstract_of[d], "gold": g, "libs": libs})
    words = hs_c[d].split()
    start = rng.randrange(len(words) // 4, max(len(words) // 4 + 1, 3 * len(words) // 4 - 6))
    p_q.append({"qid": f"P:{d}", "text": " ".join(words[start : start + 6]), "gold": g, "libs": libs})
    low = hs_c[d].lower()
    cand = sorted({w.strip(STRIP) for w in low.split() if len(w.strip(STRIP)) >= 6})
    sample = [hs_c[x].lower() for x in rng.sample(reservoir, 300)]
    df = {w: sum(1 for o in sample if w in o) for w in cand[:80]}
    rare = sorted(df, key=lambda w: df[w])[:3]
    if len(rare) == 3:
        k_q.append({"qid": f"K:{d}", "text": " ".join(rare), "gold": g, "libs": libs})
sets["A"] = {"label": "A  hu news <- hu abstract", "family": "hunsum", "queries": a_q}
sets["P"] = {"label": "P  hu exact phrase (6 words)", "family": "hunsum", "queries": p_q}
sets["K"] = {"label": "K  hu 3 rare keywords", "family": "hunsum", "queries": k_q}

# ------------------------------------------------------------------------------------------------ WebFAQ
wf_members = {}  # corpus -> {size: [doc ids]}
for corpus, folder, letter, label, seed_off in (
    ("wf-hu", "webfaq-hun", "H", "H  webfaq hu question -> answer", 3),
    ("wf-en", "webfaq-eng", "W", "W  webfaq en question -> answer", 4),
):
    rng = random.Random(SEED + seed_off)
    cx = {r["id"]: r["text"] for r in jl(f"{DATA}/{folder}/corpus.jsonl")}
    qx = {r["id"]: r["text"] for r in jl(f"{DATA}/{folder}/queries.jsonl")}
    qr = jload(f"{DATA}/{folder}/qrels.json")
    qs = sorted(q for q in qx if q in qr and qr[q][0] in cx and len(cx[qr[q][0]]) >= 60)
    rng.shuffle(qs)
    chosen, seen_text = [], set()
    for q in qs:
        t = cx[qr[q][0]]
        if t in seen_text:
            continue  # two questions with the same answer text: one right document, not two identical ones
        seen_text.add(t)
        chosen.append(q)
        if len(chosen) == GOLD_PER_CORPUS:
            break
    gold = [qr[q][0] for q in chosen]
    pool = sorted(d for d in cx if cx[d] not in seen_text)
    rng.shuffle(pool)
    distract, taken = [], set(seen_text)
    for d in pool:
        if cx[d] in taken:
            continue
        taken.add(cx[d])
        distract.append(d)
        if len(distract) == 1200:
            break
    wf_members[corpus] = {1500: gold + distract, 400: gold + distract[:100]}
    for size, ids in wf_members[corpus].items():
        add_docs(corpus, cx, ids)
        libraries[f"{corpus}-{size}"] = {"family": corpus, "size": size, "members": [gid_of(corpus, d) for d in ids]}
    sets[letter] = {
        "label": label,
        "family": corpus,
        "queries": [
            {"qid": f"{letter}:{q}", "text": qx[q], "gold": gid_of(corpus, qr[q][0]), "libs": [f"{corpus}-400", f"{corpus}-1500"]}
            for q in chosen
        ],
    }

# ------------------------------------------------------------------------------------------------ Belebele
rng = random.Random(SEED + 2)
b_en = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/corpus-eng.jsonl")}
b_hu = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/corpus-hun.jsonl")}
q_en = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/queries-eng.jsonl")}
q_hu = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/queries-hun.jsonl")}
b_r = jload(f"{DATA}/belebele/qrels.json")
cids = sorted(b_en)
assert sorted(b_hu) == cids and len(cids) == 488
lib400 = sorted(rng.sample(cids, 400))
bel_members = {400: lib400, 488: cids}
qids = sorted(b_r, key=int)
rng.shuffle(qids)

for corpus, texts, wf in (("bel-en", b_en, "wf-en"), ("bel-hu", b_hu, "wf-hu")):
    add_docs(corpus, texts, cids)
    pad = list(wf_members[wf][1500])
    rng.shuffle(pad)
    for size in (400, 488):
        libraries[f"{corpus}-{size}"] = {"family": corpus, "size": size, "members": [gid_of(corpus, d) for d in bel_members[size]]}
    libraries[f"{corpus}-1500"] = {
        "family": corpus,
        "size": 1500,
        "members": [gid_of(corpus, d) for d in cids] + [gid_of(wf, d) for d in pad[: 1500 - len(cids)]],
    }

picked = {}  # library -> first QUESTIONS_PER_LIBRARY eligible question ids, in the shuffled order
for size, ids in ((400, lib400), (488, cids), (1500, cids)):
    inside = set(ids)
    picked[size] = [q for q in qids if b_r[q][0] in inside][:QUESTIONS_PER_LIBRARY]

for letter, label, corpus, qtexts in (
    ("B", "B  en passage <- hu question", "bel-en", q_hu),
    ("C", "C  hu passage <- en question", "bel-hu", q_en),
    ("D", "D  hu passage <- hu question", "bel-hu", q_hu),
    ("E", "E  en passage <- en question", "bel-en", q_en),
):
    per_q = {}
    for size in (400, 488, 1500):
        for q in picked[size]:
            per_q.setdefault(q, []).append(f"{corpus}-{size}")
    sets[letter] = {
        "label": label,
        "family": corpus,
        "queries": [
            {"qid": f"{letter}:{q}", "text": qtexts[q], "gold": gid_of(corpus, b_r[q][0]), "libs": per_q[q]}
            for q in sorted(per_q, key=int)
        ],
    }

# ------------------------------------------------------------------------------------------------ write
os.makedirs(OUT, exist_ok=True)
order = sorted(docs)
with open(f"{OUT}/docs.jsonl", "w", encoding="utf-8") as f:
    for g in order:
        f.write(json.dumps({"gid": g, **docs[g]}, ensure_ascii=False) + "\n")
plan = {
    "seed": SEED,
    "sources": {
        "belebele": "facebook/belebele hun_Latn + eng_Latn, CC BY-SA 4.0",
        "webfaq": "PaDaS-Lab/webfaq-retrieval hun + eng (test), CC BY 4.0",
        "hunsum": "mteb/HunSum2AbstractiveRetrieval (SZTAKI-HLT HunSum-2), CC BY-NC-SA 4.0",
    },
    "libraries": libraries,
    "sets": sets,
}
with open(f"{OUT}/plan.json", "w", encoding="utf-8") as f:
    json.dump(plan, f, ensure_ascii=False)

# Text-free selection and input fingerprints can be kept with published results. Upstream dataset commit revisions
# were not retained by the original downloader; these hashes pin the actual local prep.py outputs used here.
selection = {
    "seed": SEED,
    "sources": plan["sources"],
    "upstream_revisions": "not recorded; local input SHA-256 fingerprints below",
    "input_sha256": {},
    "libraries": libraries,
    "sets": {letter: {"label": s["label"], "queries": [
        {k: v for k, v in q.items() if k != "text"} for q in s["queries"]
    ]} for letter, s in sets.items()},
}
for folder in ("belebele", "hunsum", "webfaq-eng", "webfaq-hun"):
    for name in sorted(os.listdir(f"{DATA}/{folder}")):
        path = f"{folder}/{name}"
        with open(f"{DATA}/{path}", "rb") as source:
            selection["input_sha256"][path] = hashlib.file_digest(source, "sha256").hexdigest()
with open(f"{OUT}/selection.json", "w", encoding="utf-8") as f:
    json.dump(selection, f, ensure_ascii=False, indent=2)
    f.write("\n")

# ------------------------------------------------------------------------------------------------ summary
by_corpus = {}
for g, d in docs.items():
    by_corpus.setdefault(d["corpus"], []).append(len(d["text"]))
print("documents to embed:", len(docs), "  characters:", sum(sum(v) for v in by_corpus.values()))
for c, v in sorted(by_corpus.items()):
    print(f"  {c:7s} {len(v):5d} documents, {sum(v):>10,} chars, median {sorted(v)[len(v) // 2]}")
for name, lib in sorted(libraries.items()):
    assert len(set(lib["members"])) == len(lib["members"]), name
    assert len({docs[g]["text"] for g in lib["members"]}) == len(lib["members"]), name
    print(f"  library {name:12s} N={len(lib['members']):5d}")
texts = {q["text"].strip() for s in sets.values() for q in s["queries"]}
print("question texts to embed:", len(texts))
for letter in sorted(sets):
    s = sets[letter]
    per_lib = {}
    for q in s["queries"]:
        assert q["gold"] in docs
        for lib in q["libs"]:
            assert q["gold"] in set(libraries[lib]["members"]), (q["qid"], lib)
            per_lib[lib] = per_lib.get(lib, 0) + 1
    print(f"  set {s['label']:34s}", "  ".join(f"{lib}: {n}" for lib, n in sorted(per_lib.items())))
