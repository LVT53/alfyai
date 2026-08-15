#!/bin/bash
set -e

# ============================================================================
# Staging deploy script (ai.dev.alfydesign.com, port 3002).
#
# KEEP THIS STRUCTURALLY IDENTICAL TO scripts/deploy.sh. They differ ONLY in:
#   - branch pulled:   dev            (prod: main)
#   - systemd service: langflow-chat-dev.service   (prod: langflow-chat.service)
# Any real change to the deploy flow must land in BOTH scripts in the same
# commit so staging and production can never drift again. D1 (atomic releases)
# rewrites both together.
#
# Supervision: staging runs as the systemd system service
# `langflow-chat-dev.service` (User=alfydesign, WorkingDirectory=this dir,
# port 3002). PM2 is NOT used and NOT installed — the old box-only
# scripts/deploy-dev.sh referenced it in an unused variable and never
# restarted anything.
#
# Restart caveat: unlike prod, `alfydesign` has NO passwordless sudo rule for
# `systemctl restart langflow-chat-dev.service`. This script attempts a
# non-interactive restart and, if it is not permitted, prints the exact
# command to run from a privileged account (alfyroot) instead of failing the
# whole deploy. Ask the operator to add a NOPASSWD sudoers rule for the dev
# service if fully-unattended staging restarts are wanted.
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="${APP_DIR:-$(pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-dev}"
SERVICE_NAME="${SERVICE_NAME:-langflow-chat-dev.service}"

echo -e "${YELLOW}=== Starting STAGING deployment ===${NC}"
echo "App directory: $APP_DIR"
echo "Branch:        $DEPLOY_BRANCH"
echo "Service:       $SERVICE_NAME"
echo ""

cd "$APP_DIR"

if [ -f .env ]; then
  echo -e "${YELLOW}Loading environment from .env...${NC}"
  set -a
  source .env
  set +a
  echo -e "${GREEN}✓ Environment loaded${NC}"
  echo ""
fi

echo -e "${YELLOW}1. Pulling latest changes...${NC}"
# Discard local package-lock churn so pull never fails on npm-install drift
git checkout -- package-lock.json 2>/dev/null || true
git pull origin "$DEPLOY_BRANCH"
echo -e "${GREEN}✓ Git pull complete${NC}"
echo ""

echo -e "${YELLOW}2. Installing dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

echo -e "${YELLOW}2b. Setting up Python sandbox environment...${NC}"
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
  SITE_PACKAGES_DIR="$APP_DIR/sandbox-python-env/lib/python3.11/site-packages"
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

echo -e "${YELLOW}3. Verifying database migrations...${NC}"
npm run check:migrations
echo -e "${GREEN}✓ Migration check passed${NC}"
echo ""

echo -e "${YELLOW}4. Applying database migrations...${NC}"
npm run db:prepare
echo -e "${GREEN}✓ Database migrations complete${NC}"
echo ""

echo -e "${YELLOW}5. Cleaning previous build output...${NC}"
rm -rf "$APP_DIR/build"
echo -e "${GREEN}✓ Build directory cleaned${NC}"
echo ""

echo -e "${YELLOW}6. Building application...${NC}"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"
echo ""

echo -e "${GREEN}=== Deployment complete! ===${NC}"
echo ""

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo -e "${YELLOW}Restarting $SERVICE_NAME ...${NC}"
  if sudo -n systemctl restart "$SERVICE_NAME" 2>/dev/null; then
    echo -e "${GREEN}✓ Service restarted — fresh build is now live.${NC}"
  else
    echo -e "${RED}⚠ Could not restart $SERVICE_NAME without a password.${NC}"
    echo -e "${YELLOW}  alfydesign has no NOPASSWD sudoers rule for the staging service.${NC}"
    echo -e "${YELLOW}  Restart it from a privileged account, e.g.:${NC}"
    echo -e "${YELLOW}    ssh alfyroot 'systemctl restart $SERVICE_NAME'${NC}"
  fi
else
  echo -e "${YELLOW}⚠ $SERVICE_NAME was not running.${NC}"
  echo -e "${YELLOW}  Start it manually if needed: systemctl start $SERVICE_NAME${NC}"
fi
echo ""
