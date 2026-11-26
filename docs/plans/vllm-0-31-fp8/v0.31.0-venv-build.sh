#!/bin/bash
set -euo pipefail
cd /home/alfyws
uv venv /home/alfyws/venvs/vllm-0.31 --python 3.12
uv pip install --python /home/alfyws/venvs/vllm-0.31/bin/python \
  "vllm==0.31.0" "flashinfer-cubin==0.7.0.post1" "flashinfer-jit-cache==0.7.0.post1+cu130" \
  -c /home/alfyws/v031-venv-constraints.txt \
  --torch-backend=cu130 --index-strategy unsafe-best-match \
  --extra-index-url https://flashinfer.ai/whl/cu130 \
  --extra-index-url https://flashinfer.ai/whl
echo BUILD_OK
