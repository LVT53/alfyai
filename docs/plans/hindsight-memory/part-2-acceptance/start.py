"""Local, non-production Hindsight at pin 9fb28dbd for Memory part 2 acceptance.

PART2_HS_ROOT holds the checkout (`source/`), the venv (`venv/`) and the
embedded Postgres data. Flash-Next through inference.alfycomms.com; the key is
read from ~/.dsh/.env at start and never printed. At most three model calls in
flight (production users share the model). Synthetic data only.
"""
import os
from pathlib import Path

root = Path(os.environ.get("PART2_HS_ROOT", "/tmp/alfyai-hindsight-part2")).resolve()
key = None
for line in (Path.home() / ".dsh/.env").read_text().splitlines():
    if line.startswith("ALFY_API_KEY="):
        key = line.split("=", 1)[1].strip().strip('"').strip("'")
if not key:
    raise SystemExit("ALFY_API_KEY missing")
os.environ.update({
    "PG0_HOME": str(root / "pg0"),
    "PG0_INSTALLATION_DIR": str(root / "pg-install"),
    "HF_HOME": str(root / "hf"),
    "HINDSIGHT_API_DATABASE_URL": "pg0://alfyai-part2",
    "HINDSIGHT_API_LLM_PROVIDER": "openai",
    "HINDSIGHT_API_LLM_MODEL": "qwen3-6-27b",
    "HINDSIGHT_API_LLM_API_KEY": key,
    "HINDSIGHT_API_LLM_BASE_URL": "https://inference.alfycomms.com/v1",
    "HINDSIGHT_API_LLM_MAX_CONCURRENT": os.environ.get("PART2_LLM_CONCURRENCY", "3"),
    "HINDSIGHT_API_LLM_MAX_RETRIES": "12",
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
os.execv(cmd, [cmd, "--host", "127.0.0.1", "--port", "18990"])
