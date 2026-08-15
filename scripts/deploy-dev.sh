#!/bin/bash
set -e

# ============================================================================
# Staging deploy script (ai.dev.alfydesign.com, port 3002).
#
# Builds each deploy into its own immutable releases/<sha>/ directory and
# cuts the live service over with a single atomic `current` symlink flip, so
# the running process never sees a half-rebuilt tree. Rollback is re-pointing
# `current` at the previous release. See
# docs/adr/0054-atomic-release-cutover.md for the full design.
#
# KEEP THIS STRUCTURALLY IDENTICAL TO scripts/deploy.sh. They differ ONLY in:
#   - branch fetched:  dev            (prod: main)
#   - systemd service: langflow-chat-dev.service   (prod: langflow-chat.service)
#   - health-check port: 3002         (prod: 3001)
#   - the restart_service() function body (see below)
# Any real change to the deploy flow must land in BOTH scripts in the same
# commit so staging and production can never drift again. D1 (atomic
# releases) rewrote both together against docs/adr/0054-atomic-release-cutover.md.
#
# Supervision: staging runs as the systemd system service
# `langflow-chat-dev.service` (User=alfydesign, WorkingDirectory=current,
# port 3002). PM2 is NOT used and NOT installed.
#
# Restart caveat: unlike prod, `alfydesign` has NO passwordless sudo rule for
# `systemctl restart langflow-chat-dev.service`. restart_service() below
# attempts a non-interactive restart and, if it is not permitted, prints the
# exact command to run from a privileged account (alfyroot) instead of
# failing the whole deploy. Ask the operator to add a NOPASSWD sudoers rule
# for the dev service if fully-unattended staging restarts are wanted.
#
# This script assumes the shared/ + releases/ + current layout already
# exists. Converting an existing flat checkout to that layout is a separate,
# one-time, service-stopped runbook (see the ADR's "One-time migration from
# the flat layout" section) — this script refuses to run without it rather
# than attempting that migration itself.
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="${APP_DIR:-$(pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-dev}"
SERVICE_NAME="${SERVICE_NAME:-langflow-chat-dev.service}"
HEALTH_PORT="${HEALTH_PORT:-3002}"
RELEASES_TO_KEEP="${RELEASES_TO_KEEP:-3}"

SHARED_DIR="$APP_DIR/shared"
RELEASES_DIR="$APP_DIR/releases"

restart_service() {
  if sudo -n systemctl restart "$SERVICE_NAME" 2>/dev/null; then
    return 0
  fi
  echo -e "${RED}⚠ Could not restart $SERVICE_NAME without a password.${NC}"
  echo -e "${YELLOW}  alfydesign has no NOPASSWD sudoers rule for the staging service.${NC}"
  echo -e "${YELLOW}  Restart it from a privileged account, e.g.:${NC}"
  echo -e "${YELLOW}    ssh alfyroot 'systemctl restart $SERVICE_NAME'${NC}"
  return 1
}

echo -e "${YELLOW}=== Starting deployment ===${NC}"
echo "App directory: $APP_DIR"
echo "Branch:        $DEPLOY_BRANCH"
echo "Service:       $SERVICE_NAME"
echo ""

if [ ! -d "$SHARED_DIR" ]; then
  echo -e "${RED}✗ $SHARED_DIR is missing.${NC}"
  echo -e "${RED}  This environment has not been migrated to the releases layout yet.${NC}"
  echo -e "${RED}  Run the one-time flat-to-releases migration runbook first${NC}"
  echo -e "${RED}  (see docs/adr/0054-atomic-release-cutover.md, 'One-time migration from the flat layout'),${NC}"
  echo -e "${RED}  then re-run this script.${NC}"
  exit 1
fi

echo -e "${YELLOW}1. Fetching latest changes...${NC}"
git -C "$APP_DIR" fetch origin "$DEPLOY_BRANCH"
RELEASE_SHA=$(git -C "$APP_DIR" rev-parse --short "origin/$DEPLOY_BRANCH")
RELEASE_DIR="$RELEASES_DIR/$RELEASE_SHA"
echo "Release:       $RELEASE_SHA"
echo -e "${GREEN}✓ Fetch complete${NC}"
echo ""

echo -e "${YELLOW}2. Materializing release into releases/$RELEASE_SHA ...${NC}"
mkdir -p "$RELEASE_DIR"
git -C "$APP_DIR" archive "origin/$DEPLOY_BRANCH" | tar -x -C "$RELEASE_DIR"
echo -e "${GREEN}✓ Release materialized${NC}"
echo ""

cd "$RELEASE_DIR"

echo -e "${YELLOW}3. Installing dependencies...${NC}"
npm ci || npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

echo -e "${YELLOW}3b. Setting up Python sandbox environment...${NC}"
PYTHON311=$(command -v python3.11 2>/dev/null || true)
if [ -z "$PYTHON311" ]; then
  # Fallback: check if python3 itself is 3.11+
  PYTHON3=$(command -v python3 2>/dev/null || true)
  if [ -n "$PYTHON3" ] && "$PYTHON3" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
    PYTHON311="$PYTHON3"
  fi
fi

if [ -n "$PYTHON311" ]; then
  if [ ! -d sandbox-python-env ]; then
    "$PYTHON311" -m venv sandbox-python-env
  fi
  sandbox-python-env/bin/pip install --quiet --upgrade pip 2>/dev/null || true
  sandbox-python-env/bin/pip install --quiet openpyxl xlsxwriter python-docx python-pptx 2>/dev/null || true
  echo -e "${GREEN}✓ Python sandbox packages installed (host)${NC}"
elif command -v docker >/dev/null 2>&1; then
  # No host Python, but Docker is available — use a container to bootstrap packages
  SITE_PACKAGES_DIR="$RELEASE_DIR/sandbox-python-env/lib/python3.11/site-packages"
  mkdir -p "$SITE_PACKAGES_DIR"
  docker run --rm \
    -v "$SITE_PACKAGES_DIR:/target" \
    python:3.11-slim \
    sh -c "pip install --no-cache-dir --target=/target openpyxl xlsxwriter python-docx python-pptx" \
    >/dev/null 2>&1 || {
      echo -e "${YELLOW}⚠ Docker package install failed; Python sandbox file generation may be limited${NC}"
      exit 0
    }
  echo -e "${GREEN}✓ Python sandbox packages installed (Docker)${NC}"
else
  echo -e "${YELLOW}⚠ python3.11 and docker not found; Python sandbox file generation may be limited${NC}"
fi

echo -e "${YELLOW}4. Linking shared state (.env and data)...${NC}"
ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/.env"
ln -sfn "$SHARED_DIR/data" "$RELEASE_DIR/data"
echo -e "${GREEN}✓ Shared .env and data linked${NC}"
echo ""

if [ -f "$RELEASE_DIR/.env" ]; then
  echo -e "${YELLOW}Loading environment from .env...${NC}"
  set -a
  source "$RELEASE_DIR/.env"
  set +a
  echo -e "${GREEN}✓ Environment loaded${NC}"
  echo ""
fi

echo -e "${YELLOW}5. Building application...${NC}"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

echo -e "${YELLOW}6. Verifying database migrations...${NC}"
npm run check:migrations
echo -e "${GREEN}✓ Migration check passed${NC}"
echo ""

echo -e "${YELLOW}7. Applying database migrations...${NC}"
npm run db:prepare
echo -e "${GREEN}✓ Database migrations complete${NC}"
echo ""

echo -e "${YELLOW}7b. Draining in-flight streams before cutover...${NC}"
if [ -n "$ALFYAI_API_SIGNING_KEY" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $ALFYAI_API_SIGNING_KEY" -H "Content-Type: application/json" -d '{"draining":true}' "http://localhost:$HEALTH_PORT/api/admin/drain" >/dev/null 2>&1 || true
  DRAIN_OK=""
  for attempt in $(seq 1 60); do
    ACTIVE_STREAMS=$(curl -fsS "http://localhost:$HEALTH_PORT/api/health" 2>/dev/null | grep -o '"activeStreams":[0-9]*' | sed 's/[^0-9]*//g')
    if [ -z "$ACTIVE_STREAMS" ] || [ "$ACTIVE_STREAMS" -le 0 ]; then
      DRAIN_OK=1
      break
    fi
    sleep 2
  done
  if [ -n "$DRAIN_OK" ]; then
    echo -e "${GREEN}✓ Drained: 0 active streams${NC}"
  else
    echo -e "${YELLOW}⚠ Drain wait timed out after 120s; proceeding to cutover anyway${NC}"
  fi
else
  echo -e "${YELLOW}⚠ ALFYAI_API_SIGNING_KEY not set; skipping drain (graceful shutdown alone covers it)${NC}"
fi
echo ""

PREVIOUS_SHA=""
if [ -L "$APP_DIR/current" ]; then
  PREVIOUS_SHA=$(basename "$(readlink "$APP_DIR/current")")
fi

echo -e "${YELLOW}8. Cutting over to the new release (atomic symlink flip)...${NC}"
cd "$APP_DIR"
ln -sfn "releases/$RELEASE_SHA" current.tmp
mv -Tf current.tmp current
echo -e "${GREEN}✓ current -> releases/$RELEASE_SHA${NC}"
echo ""

echo -e "${YELLOW}9. Restarting $SERVICE_NAME ...${NC}"
if restart_service; then
  echo -e "${GREEN}✓ $SERVICE_NAME restarted${NC}"
fi
echo ""

echo -e "${YELLOW}10. Waiting for /api/health ...${NC}"
HEALTH_OK=""
for attempt in $(seq 1 30); do
  if curl -fsS "http://localhost:$HEALTH_PORT/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done

if [ -z "$HEALTH_OK" ]; then
  echo -e "${RED}✗ Health check failed after cutover to releases/$RELEASE_SHA.${NC}"
  if [ -n "$PREVIOUS_SHA" ]; then
    echo -e "${YELLOW}Rolling back to previous release: releases/$PREVIOUS_SHA ...${NC}"
    ln -sfn "releases/$PREVIOUS_SHA" current.tmp
    mv -Tf current.tmp current
    if restart_service; then
      echo -e "${GREEN}✓ $SERVICE_NAME restarted on releases/$PREVIOUS_SHA${NC}"
    fi
    echo -e "${YELLOW}⚠ Rolled back to releases/$PREVIOUS_SHA. Investigate releases/$RELEASE_SHA before retrying.${NC}"
  else
    echo -e "${RED}✗ No previous release to roll back to.${NC}"
  fi
  exit 1
fi
echo -e "${GREEN}✓ Health check passed${NC}"
echo ""

echo -e "${YELLOW}11. Pruning old releases (keeping last $RELEASES_TO_KEEP)...${NC}"
while IFS= read -r old_release; do
  echo "  removing $(basename "${old_release%/}")"
  rm -rf "${old_release%/}"
done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +"$((RELEASES_TO_KEEP + 1))")
echo -e "${GREEN}✓ Retained the last $RELEASES_TO_KEEP releases${NC}"
echo ""

echo -e "${GREEN}=== Deployment complete! current -> releases/$RELEASE_SHA ===${NC}"
echo ""
