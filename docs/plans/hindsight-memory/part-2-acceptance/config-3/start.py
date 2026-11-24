"""Local, non-production Hindsight at pin 9fb28dbd for the Memory config 3 acceptance (2026-11-24).

Part 2's `start.py` with the model reached through the shared bridge
(`docs/plans/hindsight-memory/regression-2026-11-24/bridge.cjs`, 127.0.0.1:18891), so that
every process of the run together keeps at most three calls in flight on Flash-Next
(production users share the model). The bridge holds the API key; this script never reads it.
The engine is the one part 2 installed in /tmp/alfyai-hindsight-eval (pinned source, venv,
embedded PostgreSQL). Synthetic data only.

CONFIG3_LLM_CONCURRENCY (default 3) is how many model calls this instance keeps open at most; the
bridge still caps every process together at three.

Usage, from the repository root:
  /tmp/alfyai-hindsight-eval/venv/bin/python docs/plans/hindsight-memory/part-2-acceptance/config-3/start.py <port> <pg0-name>
"""
import os
import sys
from pathlib import Path

port, name = sys.argv[1], sys.argv[2]
root = Path("/tmp/alfyai-hindsight-eval")
os.environ.update({
    "PG0_HOME": str(root / "pg0"),
    "PG0_INSTALLATION_DIR": str(root / "pg-install"),
    "HF_HOME": str(root / "hf"),
    "HINDSIGHT_API_DATABASE_URL": f"pg0://{name}",
    "HINDSIGHT_API_LLM_PROVIDER": "openai",
    "HINDSIGHT_API_LLM_MODEL": "qwen3-6-27b",
    "HINDSIGHT_API_LLM_API_KEY": "synthetic-local-proxy",
    "HINDSIGHT_API_LLM_BASE_URL": "http://127.0.0.1:18891/v1",
    "HINDSIGHT_API_LLM_MAX_CONCURRENT": os.environ.get("CONFIG3_LLM_CONCURRENCY", "3"),
    "HINDSIGHT_API_LLM_MAX_RETRIES": "12",
    "HINDSIGHT_API_LLM_TIMEOUT": "800",
    "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true",
    "HINDSIGHT_API_RETAIN_LLM_EXTRA_BODY": '{"chat_template_kwargs":{"enable_thinking":true},"max_tokens":8192}',
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "onnx",
    "HINDSIGHT_API_RERANKER_PROVIDER": "flashrank",
    "HINDSIGHT_API_RERANKER_FLASHRANK_MODEL": "ms-marco-MultiBERT-L-12",
    "HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR": str(root / "reranker"),
    "HINDSIGHT_API_ENABLE_DRY_RUN_EXTRACT": "true",
    "HINDSIGHT_API_LLM_TRACE_ENABLED": "false",
    "HINDSIGHT_API_OTEL_TRACES_ENABLED": "false",
    "HINDSIGHT_API_LOG_LEVEL": "warning",
})
cmd = str(root / "venv/bin/hindsight-api")
os.execv(cmd, [cmd, "--host", "127.0.0.1", "--port", port])
