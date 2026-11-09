#!/bin/bash
# usage: ceiling.sh <tier> <cuda-visible-devices-or-empty>   (transient unit mineru41-spike-b on 127.0.0.1:8013)
tier=$1; cuda=$2
set -e
install -d -o alfydesign -g alfydesign -m 755 /home/alfydesign/apps/mineru4/uploads-4.1.7-b
systemd-run --collect --unit=mineru41-spike-b --description="MinerU 4.1.7 spike ceiling probe ($tier, :8013)" \
  -p User=alfydesign -p Group=alfydesign -p WorkingDirectory=/home/alfydesign/apps/mineru4/uploads-4.1.7-b \
  -p MemoryMax=8G -p Nice=5 -p Restart=no \
  -p EnvironmentFile=/home/alfydesign/apps/mineru4/mineru41-spike.env \
  -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectSystem=full -p ProtectHome=read-only \
  -p "ReadWritePaths=/home/alfydesign/apps/mineru4/uploads-4.1.7-b /home/alfydesign/m41s" \
  -E "CUDA_VISIBLE_DEVICES=$cuda" -E MINERU_HOME=/home/alfydesign/m41s -E MINERU_DEVICE_MODE=$([ -z "$cuda" ] && echo cpu || echo cuda) -E MINERU_MODEL_SMALL_BACKEND=torch \
  -E MINERU_TELEMETRY_DISABLED=1 -E DO_NOT_TRACK=1 -E HF_HUB_DISABLE_TELEMETRY=1 -E PYTHONUNBUFFERED=1 \
  -E HF_HOME=/home/alfydesign/m41s/hf -E HF_XET_CACHE=/home/alfydesign/m41s/hf/xet -E XDG_CACHE_HOME=/home/alfydesign/m41s/cache -E MODELSCOPE_CACHE=/home/alfydesign/m41s/modelscope \
  /home/alfydesign/apps/mineru4/.venv-4.1.7/bin/mineru-kit api-server --host 127.0.0.1 --port 8013 --tier "$tier" --concurrency 1 \
    --upload-dir /home/alfydesign/apps/mineru4/uploads-4.1.7-b --vlm-server-url http://127.0.0.1:30001/v1 --api-key '${MINERU41_SPIKE_API_KEY}' >/dev/null 2>&1
for i in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8013/v1/health)" = 200 ] && break; sleep 0.5; done
curl -s --max-time 2 http://127.0.0.1:8013/v1/health | head -c 200; echo
