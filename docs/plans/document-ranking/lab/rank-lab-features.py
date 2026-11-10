#!/usr/bin/env python3
"""Feature table for comparing document-ranking formulas, on PUBLIC text only. Runs on alfyroot.

For each query a pool of 120 documents (the app's candidate limit, SEMANTIC_ARTIFACT_CANDIDATE_LIMIT) holds the one right
document plus 119 others. Per (query, document) it records the three signals the app's ranker has:
  L   lexical score: the app's scoreMatch, ported exactly (query words of 3+ letters found as substrings anywhere)
  S   cosine between the query (embedded with the "query" prompt) and the document, for the 4B at 1024-d and the old 0.6B
  R   bge-reranker-v2-m3 probability, for the documents the app could shortlist (lexical top 12 + semantic top 24)
and the document's age. Variants are evaluated offline from this file by rank-lab-eval.py.

    TEI_API_KEY_7997=... TEI_API_KEY_7998=... TEI_API_KEY_7999=... python -I rank-lab-features.py <data-dir> <out.json>
"""
import json
import os
import random
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

DATA, OUT = sys.argv[1], sys.argv[2]
rng = random.Random(20261111)
POOL = 120
LIMIT = 5  # the probe's, and a typical call's, result limit: lexical top = max(2 * limit, 12) = 12
EMB = {"s4": (7999, 1024), "s06": (7997, None)}


def jl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def post(port, path, body):
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path),
        json.dumps(body).encode(),
        {"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["TEI_API_KEY_%d" % port]},
    )
    return json.load(urllib.request.urlopen(req, timeout=300))


def embed(port, dims, texts, prompt=None):
    batches = [texts[i : i + 8] for i in range(0, len(texts), 8)]

    def one(b):
        body = {"inputs": b, "normalize": True, "truncate": True}
        if prompt:
            body["prompt_name"] = prompt
        if dims:
            body["dimensions"] = dims
        return post(port, "/embed", body)

    with ThreadPoolExecutor(2) as ex:
        out = [v for res in ex.map(one, batches) for v in res]
    return np.asarray(out, dtype=np.float32)


def rerank(query, texts):
    scores = {}
    for i in range(0, len(texts), 32):
        for r in post(7998, "/rerank", {"query": query, "texts": texts[i : i + 32], "truncate": True, "raw_scores": False}):
            scores[i + r["index"]] = r["score"]
    return [scores[i] for i in range(len(texts))]


def score_match(query, hay):
    # working-set.ts scoreMatch: query split on whitespace, words of 3+ letters, +1 for each found as a substring
    terms = [t.strip() for t in re.split(r"\s+", query.lower())]
    terms = [t for t in terms if len(t) > 2]
    h = hay.lower()
    return sum(1 for t in terms if t in h), len(terms)


# ---------------------------------------------------------------------------------------------- query sets
sets = []  # (name, [(query, gold_doc_id)], {doc_id: text}, reservoir_ids)


def add(name, pairs, docs, reservoir_pool, tag):
    sets.append((name, pairs, docs, reservoir_pool, tag))


# A: Hungarian news article <- its Hungarian abstract
hs_c = {r["id"]: r["text"] for r in jl(f"{DATA}/hunsum/corpus.jsonl")}
hs_q = {r["id"]: r["text"] for r in jl(f"{DATA}/hunsum/queries.jsonl")}
hs_r = json.load(open(f"{DATA}/hunsum/qrels.json", encoding="utf-8"))
ok = [q for q in hs_q if q in hs_r and 800 <= len(hs_c[hs_r[q][0]]) <= 8000]
rng.shuffle(ok)
a_pairs = [(hs_q[q], hs_r[q][0]) for q in ok[:100]]
hs_reservoir = [d for d in hs_c if 800 <= len(hs_c[d]) <= 8000]
add("A  hu news <- hu abstract", a_pairs, hs_c, hs_reservoir, "hunsum")

# P / K: the lexical-friendly sets, from other HunSum articles
gold_ids = [hs_r[q][0] for q in ok[100:220]]
p_pairs, k_pairs = [], []
for d in gold_ids[:60]:
    words = hs_c[d].split()
    start = rng.randrange(len(words) // 4, max(len(words) // 4 + 1, 3 * len(words) // 4 - 6))
    p_pairs.append((" ".join(words[start : start + 6]), d))
for d in gold_ids[60:120]:
    low = hs_c[d].lower()
    cand = sorted({w.strip(".,;:!?()\"'„”") for w in low.split() if len(w.strip(".,;:!?()\"'„”")) >= 6})
    others = [hs_c[x].lower() for x in rng.sample(hs_reservoir, 300)]
    df = {w: sum(1 for o in others if w in o) for w in cand[:80]}
    rare = sorted(df, key=lambda w: df[w])[:3]
    k_pairs.append((" ".join(rare), d))
add("P  hu exact phrase (6 words)", p_pairs, hs_c, hs_reservoir, "hunsum")
add("K  hu 3 rare keywords", k_pairs, hs_c, hs_reservoir, "hunsum")

# B / C: Belebele passages, question in the other language
b_en = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/corpus-eng.jsonl")}
b_hu = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/corpus-hun.jsonl")}
q_hu = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/queries-hun.jsonl")}
q_en = {r["id"]: r["text"] for r in jl(f"{DATA}/belebele/queries-eng.jsonl")}
b_r = json.load(open(f"{DATA}/belebele/qrels.json", encoding="utf-8"))
qids = sorted(b_r)
rng.shuffle(qids)
add("B  en passage <- hu question", [(q_hu[q], b_r[q][0]) for q in qids[:100]], b_en, list(b_en), "bel-en")
add("C  hu passage <- en question", [(q_en[q], b_r[q][0]) for q in qids[100:200]], b_hu, list(b_hu), "bel-hu")
add("D  hu passage <- hu question", [(q_hu[q], b_r[q][0]) for q in qids[200:300]], b_hu, list(b_hu), "bel-hu")
add("E  en passage <- en question", [(q_en[q], b_r[q][0]) for q in qids[300:400]], b_en, list(b_en), "bel-en")

# H / W: WebFAQ answers for a question, Hungarian and English
for name, folder, tag in (("H  webfaq hu question -> answer", "webfaq-hun", "wf-hu"), ("W  webfaq en question -> answer", "webfaq-eng", "wf-en")):
    corpus = {r["id"]: r["text"] for r in jl(f"{DATA}/{folder}/corpus.jsonl")}
    queries = {r["id"]: r["text"] for r in jl(f"{DATA}/{folder}/queries.jsonl")}
    qr = json.load(open(f"{DATA}/{folder}/qrels.json", encoding="utf-8"))
    qs = [q for q in queries if q in qr and qr[q][0] in corpus and len(corpus[qr[q][0]]) >= 60]
    rng.shuffle(qs)
    add(name, [(queries[q], qr[q][0]) for q in qs[:100]], corpus, list(corpus), tag)

# ---------------------------------------------------------------------------------------------- pools and signals
age_days = {}
result = {"sets": []}
emb_cache = {}
for name, pairs, docs, reservoir, tag in sets:
    print("building", name, flush=True)
    reservoir = rng.sample(reservoir, min(len(reservoir), 600))
    queries_out = []
    needed = set(d for _, d in pairs)
    for _, g in pairs:
        pool_ids = [g] + rng.sample([d for d in reservoir if d != g and docs[d] != docs[g]], POOL - 1)
        needed.update(pool_ids)
        queries_out.append({"gold": g, "pool": pool_ids})
    needed = sorted(needed)
    texts = ["\n\n" + docs[d] for d in needed]  # the app searches name + "\n" + summary + "\n" + content
    idx = {d: i for i, d in enumerate(needed)}
    doc_vecs = {}
    for k, (p, dm) in EMB.items():
        cache = emb_cache.setdefault((tag, k), {})
        missing = [d for d in needed if d not in cache]
        if missing:
            for d, v in zip(missing, embed(p, dm, [docs[d] for d in missing])):
                cache[d] = v
        doc_vecs[k] = np.stack([cache[d] for d in needed])
    q_vecs = {k: embed(p, dm, [q for q, _ in pairs], prompt="query") for k, (p, dm) in EMB.items()}
    for d in needed:
        age_days.setdefault(d, rng.uniform(1, 60))
    for qi, ((query, gold), qo) in enumerate(zip(pairs, queries_out)):
        ids = qo["pool"]
        rows = []
        for d in ids:
            L, T = score_match(query, texts[idx[d]])
            rows.append(
                {
                    "id": d,
                    "L": L,
                    "s4": float(q_vecs["s4"][qi] @ doc_vecs["s4"][idx[d]]),
                    "s06": float(q_vecs["s06"][qi] @ doc_vecs["s06"][idx[d]]),
                    "age_days": age_days[d],
                }
            )
        T = score_match(query, "")[1]
        # shortlist the app would build (either embedder), rerank those
        lex_top = [r["id"] for r in sorted((r for r in rows if r["L"] > 0), key=lambda r: (-r["L"], r["age_days"]))[: max(LIMIT * 2, 12)]]
        sem4 = [r["id"] for r in sorted(rows, key=lambda r: -r["s4"])[:24]]
        sem06 = [r["id"] for r in sorted(rows, key=lambda r: -r["s06"])[:24]]
        want = list(dict.fromkeys(lex_top + sem4 + sem06))
        scores = rerank(query, [texts[idx[d]] for d in want])
        rer = dict(zip(want, scores))
        for r in rows:
            r["R"] = rer.get(r["id"])
        qo.update({"query": query, "T": T, "rows": rows})
    result["sets"].append({"name": name, "queries": queries_out})
    print(f"  {len(queries_out)} queries done", flush=True)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(result, f)
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")
