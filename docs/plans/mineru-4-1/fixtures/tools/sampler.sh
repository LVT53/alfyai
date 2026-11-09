#!/bin/bash
# Resource sampler: epoch|mainpid|childpids|cgroup MemoryCurrent|GPU1 used MiB|compute-apps pid:MiB;...
out=$1
while true; do
  t=$(date +%s.%N)
  main=$(systemctl show mineru41-spike -p MainPID --value)
  kids=$( [ "$main" != 0 ] && pgrep -P "$main" 2>/dev/null | tr '\n' ' ')
  mem=$(systemctl show mineru41-spike -p MemoryCurrent --value)
  gpu=$(nvidia-smi -i 1 --query-gpu=memory.used --format=csv,noheader,nounits | tr -d ' ')
  apps=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | tr -d ' ' | tr '\n' ';')
  echo "$t|$main|$kids|$mem|$gpu|$apps" >> "$out"
  sleep 0.5
done
