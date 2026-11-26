"""Pinned scratch Hindsight for the 2026-11-24 regression run (synthetic data only).

`native-acceptance/start.py` with two changes: the port and the embedded database name come
from the command line (one instance per suite, so the lifecycle suite's restart never touches
the benchmark), and the model settings follow today's `deploy/hindsight/compose.yaml`
(12 retries, an 800-second model timeout, retain's 1-second admission wait). The stand-in
embedder and reranker stay those the suites recorded (ONNX, FlashRank MultiBERT-L-12).
Usage, from the repository root:
  /tmp/alfyai-hindsight-eval/venv/bin/python docs/plans/hindsight-memory/regression-2026-11-24/start.py <port> <pg0-name> [<max-concurrent>]
"""
import os
import sys
from pathlib import Path

port, name = sys.argv[1], sys.argv[2]
concurrent = sys.argv[3] if len(sys.argv) > 3 else "3"
root = Path("/tmp/alfyai-hindsight-eval")
settings = {
    "PG0_HOME": str(root / "pg0"),
    "PG0_INSTALLATION_DIR": str(root / "pg-install"),
    "HF_HOME": str(root / "hf"),
    "HINDSIGHT_API_DATABASE_URL": f"pg0://{name}",
    "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "onnx",
    "HINDSIGHT_API_RERANKER_PROVIDER": "flashrank",
    "HINDSIGHT_API_RERANKER_FLASHRANK_MODEL": "ms-marco-MultiBERT-L-12",
    "HINDSIGHT_API_RERANKER_FLASHRANK_CACHE_DIR": str(root / "reranker"),
    "HINDSIGHT_API_TENANT_EXTENSION": "alfyai_tenant:AlfyTenant",
    "HINDSIGHT_API_TENANT_SCHEMA_PREFIX": "alfyai",
    "HINDSIGHT_API_TENANT_MASTER_KEYS": '{"synthetic":"' + "ab" * 32 + '","synthetic-v2":"' + "cd" * 32 + '"}',
    "HINDSIGHT_API_HTTP_EXTENSION": "alfyai_http:AlfyIdentity",
    "PYTHONPATH": str(Path.cwd() / "deploy/hindsight"),
    "HINDSIGHT_API_LLM_PROVIDER": "openai",
    "HINDSIGHT_API_LLM_MODEL": "qwen3-6-27b",
    "HINDSIGHT_API_LLM_BASE_URL": f"http://127.0.0.1:{port}/ext/alfyai/inference/v1",
    "HINDSIGHT_API_LLM_API_KEY": "synthetic-admission",
    "HINDSIGHT_API_LLM_MAX_CONCURRENT": concurrent,
    "HINDSIGHT_API_LLM_MAX_RETRIES": "12",
    "HINDSIGHT_API_LLM_TIMEOUT": "800",
    "HINDSIGHT_API_SKIP_LLM_VERIFICATION": "true",
    "HINDSIGHT_API_RETAIN_LLM_EXTRA_BODY": '{"chat_template_kwargs":{"enable_thinking":true},"max_tokens":8192}',
    "HINDSIGHT_API_ADMISSION_RETAIN_MAX_WAIT_MS": "1000",
    "HINDSIGHT_API_HTTP_INFERENCE_KEY": "synthetic-admission",
    "HINDSIGHT_API_HTTP_UPSTREAM_URL": "http://127.0.0.1:18891/v1",
    "HINDSIGHT_API_HTTP_UPSTREAM_KEY": "synthetic-local-proxy",
    "HINDSIGHT_API_HTTP_UPSTREAM_MODEL": "qwen3-6-27b",
    "HINDSIGHT_API_HTTP_ACTIVITY_URL": "http://127.0.0.1:18893/api/internal/memory-admission",
    "HINDSIGHT_API_HTTP_ACTIVITY_KEY": "synthetic-activity",
    "HINDSIGHT_API_ENABLE_DRY_RUN_EXTRACT": "true",
    "HINDSIGHT_API_LLM_TRACE_ENABLED": "false",
    "HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT": "true",
    "HINDSIGHT_API_OTEL_TRACES_ENABLED": "false",
    "HINDSIGHT_API_LOG_LEVEL": "warning",
}
os.environ.update(settings)
cmd = str(root / "venv/bin/hindsight-api")
os.execv(cmd, [cmd, "--host", "127.0.0.1", "--port", port])
