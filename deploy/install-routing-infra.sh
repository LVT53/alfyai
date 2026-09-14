#!/bin/bash
# One-time host setup for AlfyAI's routing + sandbox infrastructure. Run as
# root on the app box from a checkout of this repo:
#
#   sudo bash deploy/install-routing-infra.sh
#
# It installs and starts:
#   - alfyai-docker-proxy.service  (filtered Docker API on 127.0.0.1:2375)
#   - nominatim.service            (self-hosted geocoder on 127.0.0.1:8089)
# and creates the on-demand routing regions directory owned by the app user.
#
# After it finishes, set in shared/.env and restart the app (or deploy):
#   DOCKER_HOST=tcp://127.0.0.1:2375
#   GEOCODER_BASE_URL=http://127.0.0.1:8089
#   ROUTING_ON_DEMAND_ENABLED=true
#   ROUTING_REGIONS_DIR=/home/services/routing-regions
#   ROUTING_GEOCODER_IMPORT_CONTAINER=nominatim
#   ROUTING_LEGACY_REGION_ID=hungary
set -euo pipefail

APP_USER="${APP_USER:-alfydesign}"
REGIONS_DIR="${REGIONS_DIR:-/home/services/routing-regions}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

mkdir -p "$REGIONS_DIR"
mkdir -p /home/services/nominatim/postgres
chown "$APP_USER:$APP_USER" "$REGIONS_DIR"
chmod 775 "$REGIONS_DIR"

# A region's road/transit build and refresh code (region-manager.ts) runs as
# $APP_USER and creates, renames, and deletes files under
# <region>/{files,graphs/<profile>}/ — but each region's ORS container runs
# as root, and both a container's own graph build (e.g. graphs/public-transport)
# and any one-off root-run provisioning (e.g. hand-staging an extract during a
# mirror outage) leave root-owned directories behind. A default ACL, not a
# one-time chmod, is what actually survives that: it retroactively grants
# $APP_USER's group read/write/traverse on everything already here AND makes
# it the default for anything created later, by anyone, at any depth — so a
# brand-new region, or a fresh graphs/public-transport rebuilt from scratch,
# never needs this fixed by hand again. Idempotent; safe to re-run.
if command -v setfacl >/dev/null 2>&1; then
  setfacl -R -m "g:$APP_USER:rwX" -d -m "g:$APP_USER:rwX" "$REGIONS_DIR"
else
  echo "warning: setfacl not found — per-region files/ and graphs/ subdirectories may end up root-owned and unwritable by $APP_USER; install acl (e.g. apt-get install acl) and re-run" >&2
fi

install -m 0644 "$HERE/alfyai-docker-proxy.service" /etc/systemd/system/alfyai-docker-proxy.service
install -m 0644 "$HERE/nominatim.service" /etc/systemd/system/nominatim.service
systemctl daemon-reload

systemctl enable --now alfyai-docker-proxy.service
sleep 3
if curl -fsS -m 5 http://127.0.0.1:2375/_ping >/dev/null; then
  echo "docker proxy: OK (_ping)"
else
  echo "docker proxy: NOT responding on 127.0.0.1:2375" >&2
fi
if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:2375/volumes)" = "403" ]; then
  echo "docker proxy: volumes API correctly denied"
fi

docker pull -q mediagis/nominatim:5.1 >/dev/null || true
systemctl enable --now nominatim.service
echo "nominatim: started; first start imports the extract (20-60 min). Follow with: docker logs -f nominatim"
echo "geocoder ready when: curl -s http://127.0.0.1:8089/status  -> 'OK'"
