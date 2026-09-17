#!/bin/bash
set -e

# ============================================================================
# Production deploy script (the live site, port 3001).
#
# Builds each deploy into its own immutable releases/<sha>/ directory and
# cuts the live service over with a single atomic `current` symlink flip, so
# the running process never sees a half-rebuilt tree. Rollback is re-pointing
# `current` at the previous release. See
# docs/adr/0054-atomic-release-cutover.md for the full design.
#
# KEEP THIS STRUCTURALLY IDENTICAL TO scripts/deploy-dev.sh. They differ ONLY
# in: branch pulled (main vs dev), systemd service (langflow-chat.service vs
# langflow-chat-dev.service), health-check port (3001 vs 3002), and the
# restart_service() function body (production has passwordless sudo for its
# service; staging does not, so it falls back to printing the privileged
# command instead of failing the deploy). Any real change to the deploy flow
# must land in BOTH scripts in the same commit so staging and production can
# never drift again — scripts/deploy.test.ts compares the two bodies.
#
# Steps that are more than a few lines live in scripts/deploy-lib.sh, sourced
# below out of the release being deployed, so there is one copy rather than
# two pasted ones.
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
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-langflow-chat.service}"
HEALTH_PORT="${HEALTH_PORT:-3001}"
RELEASES_TO_KEEP="${RELEASES_TO_KEEP:-3}"

SHARED_DIR="$APP_DIR/shared"
RELEASES_DIR="$APP_DIR/releases"
# Where THIS copy of the script lives — on production the app-root checkout's
# scripts/, on staging the previous release's scripts/. Only used as the
# fallback source for deploy-lib.sh when the release being deployed predates
# that file.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

restart_service() {
  sudo systemctl restart "$SERVICE_NAME"
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

# Sourced from the release we just materialized, so the shared deploy steps
# always match the code being deployed. Defines setup_sandbox_python_packages,
# prune_old_releases, deploy_warn and print_deploy_warnings.
#
# Defensive on purpose. A `source` of a missing file fails, and under `set -e`
# that aborts the deploy outright — which is exactly what would happen when
# rolling back by deploying a sha from before deploy-lib.sh existed. So:
# prefer the release's copy, fall back to the copy next to this script, and
# only if neither exists carry on with stand-ins that skip the optional steps.
if [ -f "$RELEASE_DIR/scripts/deploy-lib.sh" ]; then
  # shellcheck source=scripts/deploy-lib.sh
  source "$RELEASE_DIR/scripts/deploy-lib.sh"
elif [ -f "$SCRIPT_DIR/deploy-lib.sh" ]; then
  echo -e "${YELLOW}⚠ releases/$RELEASE_SHA has no scripts/deploy-lib.sh (older release); using the copy next to this script${NC}"
  # shellcheck source=scripts/deploy-lib.sh
  source "$SCRIPT_DIR/deploy-lib.sh"
else
  echo -e "${RED}⚠ No scripts/deploy-lib.sh in the release or next to this script.${NC}"
  echo -e "${RED}  Deploying anyway; the sandbox package step and the prune step are skipped.${NC}"
  deploy_warn() { echo -e "${RED}⚠⚠⚠ $1${NC}"; }
  print_deploy_warnings() { :; }
  setup_sandbox_python_packages() {
    deploy_warn "scripts/deploy-lib.sh is missing, so the sandbox Python packages were not installed into $1. produce_file program mode will fail with ModuleNotFoundError."
  }
  prune_old_releases() {
    echo -e "${YELLOW}⚠ scripts/deploy-lib.sh is missing; skipping the prune of $1 (keep $2).${NC}"
  }
  backup_database() {
    deploy_warn "scripts/deploy-lib.sh is missing, so the database under $2/data was NOT backed up before the migrations ran. This stand-in deliberately does not abort: it only runs when deploying a release from before deploy-lib.sh existed, which is how a rollback is performed, and refusing to roll back would be worse. Take a backup by hand before doing anything else."
  }
fi

cd "$RELEASE_DIR"

echo -e "${YELLOW}3. Installing dependencies...${NC}"
npm ci || npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

echo -e "${YELLOW}4. Linking shared state (.env and data)...${NC}"
ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/.env"
ln -sfn "$SHARED_DIR/data" "$RELEASE_DIR/data"
echo -e "${GREEN}✓ Shared .env and data linked${NC}"
echo ""

# Keep the Apache-served maintenance page in sync with the repo. Apache's
# `ErrorDocument 503` points at $MAINTENANCE_DIR/index.html and serves it
# whenever the proxy is down (the restart window below), so the page must
# live outside the build tree. Best-effort: the web root is operator-owned
# and may be absent/read-only, in which case we skip rather than fail.
echo -e "${YELLOW}4b. Syncing the maintenance page to the web root...${NC}"
MAINTENANCE_SRC="$RELEASE_DIR/deploy/maintenance/index.html"
MAINTENANCE_DIR="${MAINTENANCE_DIR:-/var/www/alfyai-maintenance}"
if [ -f "$MAINTENANCE_SRC" ] && [ -d "$MAINTENANCE_DIR" ] && [ -w "$MAINTENANCE_DIR" ]; then
  cp -f "$MAINTENANCE_SRC" "$MAINTENANCE_DIR/index.html"
  echo -e "${GREEN}✓ Maintenance page synced to $MAINTENANCE_DIR${NC}"
else
  echo -e "${YELLOW}⚠ Maintenance web root missing or read-only; skipping page sync${NC}"
fi
echo ""

if [ -f "$RELEASE_DIR/.env" ]; then
  echo -e "${YELLOW}Loading environment from .env...${NC}"
  set -a
  # shellcheck source=/dev/null  # a runtime file, not part of the repo.
  source "$RELEASE_DIR/.env"
  set +a
  echo -e "${GREEN}✓ Environment loaded${NC}"
  echo ""
fi

# Deliberately after the .env load: DOCKER_HOST lives there (the filtered
# socket proxy on 127.0.0.1:2375), and both the container fallback and the
# post-install import check need it. Never aborts the deploy; a failure is
# printed in red and repeated by print_deploy_warnings at the end.
echo -e "${YELLOW}4c. Installing Python sandbox packages for the container's interpreter...${NC}"
setup_sandbox_python_packages "$RELEASE_DIR"
echo ""

echo -e "${YELLOW}5. Building application...${NC}"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

echo -e "${YELLOW}6. Verifying database migrations...${NC}"
npm run check:migrations
echo -e "${GREEN}✓ Migration check passed${NC}"
echo ""

# The ONE step allowed to stop a deploy, and the only point where that is a
# safe thing to do: nothing has been migrated and the cutover has not happened,
# so an abort here leaves the service running the previous release against an
# untouched database. 110 migrations, 9 destructive, one ~140 MB live file.
# See backup_database in scripts/deploy-lib.sh; DB_BACKUP_REQUIRED=0 overrides.
echo -e "${YELLOW}6b. Backing up the database before migrations...${NC}"
if ! backup_database "$RELEASE_DIR" "$SHARED_DIR" "$RELEASE_SHA"; then
  exit 1
fi
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
# shellcheck disable=SC2034  # the counter is the point; the body ignores it.
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
prune_old_releases "$RELEASES_DIR" "$RELEASES_TO_KEEP" "$APP_DIR/current" "$RELEASE_DIR"
echo ""

echo -e "${GREEN}=== Deployment complete! current -> releases/$RELEASE_SHA ===${NC}"
echo ""
print_deploy_warnings
