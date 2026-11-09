#!/bin/bash
# Start the MinerU 4.1.7 spike server as a transient unit (loopback :8012). No production unit is touched.
# The API key is never in this file: systemd expands ${MINERU41_SPIKE_API_KEY} from the mode-600 env file at exec time.
# Stop with:  systemctl stop mineru41-spike
set -euo pipefail
free_mib=$(nvidia-smi -i 1 --query-gpu=memory.free --format=csv,noheader,nounits | tr -d ' ')
[ "$free_mib" -ge 4096 ] || { echo "GPU1 has only ${free_mib} MiB free (< 4 GB): not starting"; exit 1; }
[ "$(ss -ltnH 'sport = :8012' | wc -l)" = 0 ] || { echo "port 8012 is taken"; exit 1; }
systemd-run --collect --unit=mineru41-spike \
  --description="MinerU 4.1.7 spike (transient, loopback :8012)" \
  -p User=alfydesign -p Group=alfydesign \
  -p WorkingDirectory=/home/alfydesign/apps/mineru4/uploads-4.1.7 \
  -p MemoryMax=16G -p Nice=5 -p Restart=no \
  -p EnvironmentFile=/home/alfydesign/apps/mineru4/mineru41-spike.env \
  -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectSystem=full -p ProtectHome=read-only \
  -p "ReadWritePaths=/home/alfydesign/apps/mineru4/uploads-4.1.7 /home/alfydesign/m41s" \
  -E CUDA_VISIBLE_DEVICES=1 -E NVIDIA_VISIBLE_DEVICES=1 \
  -E MINERU_HOME=/home/alfydesign/m41s -E MINERU_DEVICE_MODE=cuda -E MINERU_MODEL_SMALL_BACKEND=torch \
  -E MINERU_TELEMETRY_DISABLED=1 -E DO_NOT_TRACK=1 -E HF_HUB_DISABLE_TELEMETRY=1 -E PYTHONUNBUFFERED=1 \
  -E HF_HOME=/home/alfydesign/m41s/hf -E HF_XET_CACHE=/home/alfydesign/m41s/hf/xet \
  -E XDG_CACHE_HOME=/home/alfydesign/m41s/cache -E MODELSCOPE_CACHE=/home/alfydesign/m41s/modelscope \
  /home/alfydesign/apps/mineru4/.venv-4.1.7/bin/mineru-kit api-server \
    --host 127.0.0.1 --port 8012 --tier standard --concurrency 2 \
    --upload-dir /home/alfydesign/apps/mineru4/uploads-4.1.7 \
    --vlm-server-url http://127.0.0.1:30001/v1 \
    --api-key '${MINERU41_SPIKE_API_KEY}'
for i in $(seq 1 120); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8012/v1/health)" = 200 ] && { echo "healthy after ~${i}s"; exit 0; }
  sleep 1
done
echo "not healthy after 120 s"; exit 1
