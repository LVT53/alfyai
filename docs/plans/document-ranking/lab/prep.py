#!/usr/bin/env python3
"""Builds the public-data evaluation sets for the AlfyAI embedder/reranker test (2026-11).

Reads only public datasets downloaded into <raw>; writes <out>/{belebele,webfaq-hun,webfaq-eng,hunsum}/
plus tasks.json and meta.json. No AlfyAI data is read anywhere.

    python -I prep.py <raw-dir> <out-dir>

Sets:
  belebele   facebook/belebele hun_Latn + eng_Latn (CC BY-SA 4.0): 4 directions, same pairing as MTEB's
             BelebeleRetrieval (passage = Flores passage, gold = the passage of the question's source).
  webfaq-hun PaDaS-Lab/webfaq-retrieval hun, all test queries, full corpus (CC BY 4.0).
  webfaq-eng PaDaS-Lab/webfaq-retrieval eng, 1,000 test queries whose answer lies in a 350 MB corpus
             prefix, corpus = their answers + seeded random distractors.
  hunsum     mteb/HunSum2AbstractiveRetrieval (SZTAKI-HLT HunSum-2, CC BY-NC-SA 4.0): abstract -> article.
"""
import json
import os
import random
import sys

import pyarrow.parquet as pq

RAW, OUT = sys.argv[1], sys.argv[2]
SEED = 20261109
RERANK_SAMPLE = 400


def jl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_jsonl(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


tasks, meta = [], {}

# ---------------------------------------------------------------- Belebele
hu = jl(f"{RAW}/belebele/hun_Latn.jsonl")
en_rows = jl(f"{RAW}/belebele/eng_Latn.jsonl")
# the two files hold the same 900 questions in different orders: align on (link, question_number)
en_by_key = {(r["link"], r["question_number"]): r for r in en_rows}
assert len(hu) == len(en_rows) == len(en_by_key), (len(hu), len(en_rows), len(en_by_key))
en = [en_by_key[(a["link"], a["question_number"])] for a in hu]
for a, b in zip(hu, en):
    assert a["link"] == b["link"] and a["question_number"] == b["question_number"]
# the same Flores link can in principle hold several passages: key a passage by (link, English text)
key_to_id, corp = {}, {"hun": [], "eng": []}
qrels = {}
for i, (a, b) in enumerate(zip(hu, en)):
    key = (a["link"], b["flores_passage"])
    if key not in key_to_id:
        cid = f"C{len(key_to_id)}"
        key_to_id[key] = cid
        corp["hun"].append({"id": cid, "text": a["flores_passage"]})
        corp["eng"].append({"id": cid, "text": b["flores_passage"]})
    qrels[str(i)] = [key_to_id[key]]
n_links = len({a["link"] for a in hu})
queries = {
    "hun": [{"id": str(i), "text": a["question"]} for i, a in enumerate(hu)],
    "eng": [{"id": str(i), "text": b["question"]} for i, b in enumerate(en)],
}
for lang in ("hun", "eng"):
    write_jsonl(f"{OUT}/belebele/corpus-{lang}.jsonl", corp[lang])
    write_jsonl(f"{OUT}/belebele/queries-{lang}.jsonl", queries[lang])
write_json(f"{OUT}/belebele/qrels.json", qrels)
rng = random.Random(SEED)
bel_sample = sorted(rng.sample(range(len(hu)), RERANK_SAMPLE))
bel_sample = [str(i) for i in bel_sample]
for qlang, clang, label in (
    ("hun", "hun", "hu2hu"),
    ("eng", "eng", "en2en"),
    ("hun", "eng", "hu2en"),
    ("eng", "hun", "en2hu"),
):
    tasks.append(
        {
            "name": f"belebele-{label}",
            "group": "belebele",
            "queries": f"belebele/queries-{qlang}.jsonl",
            "corpus": f"belebele/corpus-{clang}.jsonl",
            "qrels": "belebele/qrels.json",
            "doc_cap": 6000,
            "rerank_sample": bel_sample,
        }
    )
meta["belebele"] = {
    "source": "facebook/belebele hun_Latn+eng_Latn",
    "license": "CC BY-SA 4.0",
    "queries": len(hu),
    "passages": len(corp["hun"]),
    "distinct_links": n_links,
}

# ------------------------------------------------------------ WebFAQ (hun)
cdir = f"{RAW}/webfaq-hun"
corpus = [{"id": str(r["_id"]), "text": r["text"]} for r in jl(f"{cdir}/corpus.jsonl")]
queries_t = [{"id": str(r["_id"]), "text": r["text"]} for r in jl(f"{cdir}/queries-test.jsonl")]
qrels_h = {}
for r in jl(f"{cdir}/qrels-test.jsonl"):
    if r.get("score", 1) > 0:
        qrels_h.setdefault(str(r["query-id"]), []).append(str(r["corpus-id"]))
write_jsonl(f"{OUT}/webfaq-hun/corpus.jsonl", corpus)
write_jsonl(f"{OUT}/webfaq-hun/queries.jsonl", queries_t)
write_json(f"{OUT}/webfaq-hun/qrels.json", qrels_h)
rng = random.Random(SEED + 1)
ids = sorted(q["id"] for q in queries_t)
tasks.append(
    {
        "name": "webfaq-hun",
        "group": "webfaq",
        "queries": "webfaq-hun/queries.jsonl",
        "corpus": "webfaq-hun/corpus.jsonl",
        "qrels": "webfaq-hun/qrels.json",
        "doc_cap": 6000,
        "rerank_sample": sorted(rng.sample(ids, RERANK_SAMPLE)),
    }
)
meta["webfaq-hun"] = {
    "source": "PaDaS-Lab/webfaq-retrieval hun (test)",
    "license": "CC BY 4.0",
    "queries": len(queries_t),
    "docs": len(corpus),
}

# ------------------------------------------------------------ WebFAQ (eng)
cdir = f"{RAW}/webfaq-eng"
prefix = []
with open(f"{cdir}/corpus-prefix.jsonl", "rb") as f:
    data = f.read()
data = data[: data.rfind(b"\n")]  # drop the cut-off last line
for line in data.decode("utf-8").splitlines():
    if line.strip():
        r = json.loads(line)
        prefix.append({"id": str(r["_id"]), "text": r["text"]})
in_prefix = {d["id"] for d in prefix}
q_all = {str(r["_id"]): r["text"] for r in jl(f"{cdir}/queries-test.jsonl")}
qrels_e = {}
for r in jl(f"{cdir}/qrels-test.jsonl"):
    if r.get("score", 1) > 0 and str(r["corpus-id"]) in in_prefix and str(r["query-id"]) in q_all:
        qrels_e.setdefault(str(r["query-id"]), []).append(str(r["corpus-id"]))
rng = random.Random(SEED + 2)
usable = sorted(qrels_e)
chosen = sorted(rng.sample(usable, min(1000, len(usable))))
gold_docs = {d for q in chosen for d in qrels_e[q]}
others = [d for d in prefix if d["id"] not in gold_docs]
rng.shuffle(others)
pool = [d for d in prefix if d["id"] in gold_docs] + others[: max(0, 40000 - len(gold_docs))]
rng.shuffle(pool)
write_jsonl(f"{OUT}/webfaq-eng/corpus.jsonl", pool)
write_jsonl(f"{OUT}/webfaq-eng/queries.jsonl", [{"id": q, "text": q_all[q]} for q in chosen])
write_json(f"{OUT}/webfaq-eng/qrels.json", {q: qrels_e[q] for q in chosen})
tasks.append(
    {
        "name": "webfaq-eng",
        "group": "webfaq",
        "queries": "webfaq-eng/queries.jsonl",
        "corpus": "webfaq-eng/corpus.jsonl",
        "qrels": "webfaq-eng/qrels.json",
        "doc_cap": 6000,
        "rerank_sample": sorted(rng.sample(chosen, RERANK_SAMPLE)),
    }
)
meta["webfaq-eng"] = {
    "source": "PaDaS-Lab/webfaq-retrieval eng (test), 350 MB corpus prefix",
    "license": "CC BY 4.0",
    "queries": len(chosen),
    "docs": len(pool),
    "prefix_docs": len(prefix),
    "queries_with_gold_in_prefix": len(usable),
}

# ------------------------------------------------------------------ HunSum
def parquet_rows(name):
    return pq.read_table(f"{RAW}/hunsum-{name}/test.parquet").to_pylist()


corpus = [
    {"id": r["_id"], "text": ((r.get("title") or "") + "\n" + r["text"]).strip()}
    for r in parquet_rows("corpus")
]
queries_t = [{"id": r["_id"], "text": r["text"]} for r in parquet_rows("queries")]
qrels_s = {}
for r in parquet_rows("qrels"):
    if r["score"] > 0:
        qrels_s.setdefault(r["query-id"], []).append(r["corpus-id"])
write_jsonl(f"{OUT}/hunsum/corpus.jsonl", corpus)
write_jsonl(f"{OUT}/hunsum/queries.jsonl", queries_t)
write_json(f"{OUT}/hunsum/qrels.json", qrels_s)
tasks.append(
    {
        "name": "hunsum-hun",
        "group": "hunsum",
        "queries": "hunsum/queries.jsonl",
        "corpus": "hunsum/corpus.jsonl",
        "qrels": "hunsum/qrels.json",
        "doc_cap": 6000,
        "rerank_sample": None,
    }
)
meta["hunsum"] = {
    "source": "mteb/HunSum2AbstractiveRetrieval (SZTAKI-HLT HunSum-2)",
    "license": "CC BY-NC-SA 4.0",
    "queries": len(queries_t),
    "docs": len(corpus),
}

write_json(f"{OUT}/tasks.json", tasks)
write_json(f"{OUT}/meta.json", {"seed": SEED, "rerank_sample": RERANK_SAMPLE, "sets": meta})
print(json.dumps(meta, indent=1))
for t in tasks:
    print(t["name"], "rerank_sample:", len(t["rerank_sample"]) if t["rerank_sample"] else None)
