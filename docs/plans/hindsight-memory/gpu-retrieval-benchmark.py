"""Rank the frozen synthetic corpus with the configured, pinned native adapters."""
import asyncio
import json
import math
from pathlib import Path
import resource
import sys
from time import perf_counter, process_time

from hindsight_api.engine.aiohttp_session import close_loop_sessions
from hindsight_api.engine.cross_encoder import create_cross_encoder_from_env
from hindsight_api.engine.embeddings import create_embeddings_from_env


def cosine(query, vector):
    dot = sum(float(a) * float(b) for a, b in zip(query, vector, strict=True))
    return dot / (math.hypot(*query) * math.hypot(*vector))


async def run(fixture):
    embed = create_embeddings_from_env()
    rerank = create_cross_encoder_from_env()
    await embed.initialize()
    await rerank.initialize()

    passages = fixture["passages"]
    start = perf_counter()
    cpu = process_time()
    vectors = await embed.encode_documents(list(passages.values()))
    document_elapsed = perf_counter() - start
    rows = []
    for case in fixture["queries"]:
        query_start = perf_counter()
        query = case["text"]
        query_vector, = await embed.encode_query([query])
        scores = sorted(
            ((label, cosine(query_vector, vector)) for label, vector in zip(passages, vectors, strict=True)),
            key=lambda row: -row[1],
        )
        shortlist = [label for label, _ in scores[:fixture["shortlistSize"]]]
        rerank_scores = await rerank.predict([(query, passages[label]) for label in shortlist])
        ordered = sorted(
            ((label, float(score)) for label, score in zip(shortlist, rerank_scores, strict=True)),
            key=lambda row: -row[1],
        )
        after = [label for label, _ in ordered]
        expected = case["relevant"]
        rows.append({
            "case": case["id"],
            "embeddingScores": scores,
            "rerankScores": ordered,
            "embeddingRank": shortlist.index(expected) + 1 if expected in shortlist else None,
            "rerankRank": after.index(expected) + 1 if expected in after else None,
            "latencyMs": round(1000 * (perf_counter() - query_start), 2),
        })
    return {
        "embeddingProvider": embed.provider_name,
        "rerankerProvider": rerank.provider_name,
        "dimensions": embed.dimension,
        "processCpuMs": round(1000 * (process_time() - cpu), 2),
        "totalWallMs": round(1000 * (perf_counter() - start), 2),
        "passageEmbeddingMs": round(1000 * document_elapsed, 2),
        "peakProcessMiB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2),
        "rows": rows,
    }


async def main():
    fixture = json.loads(Path(sys.argv[1]).read_text())
    try:
        result = await run(fixture)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        await close_loop_sessions()


if __name__ == "__main__":
    asyncio.run(main())
