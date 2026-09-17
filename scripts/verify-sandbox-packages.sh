#!/bin/bash
set -uo pipefail

# ============================================================================
# Asserts that the file-production sandbox's Python packages are actually
# importable from the directory the container bind-mounts.
#
#   scripts/verify-sandbox-packages.sh [<release dir>]
#
# Defaults to the current directory. Exits 0 when every promised module
# imports, 1 otherwise. Both deploy scripts call it after installing the
# packages; it is also the thing to run by hand on a box that is producing
# ModuleNotFoundError.
#
# Preferred check: import the modules inside a python<VERSION> container with
# the same read-only bind mount and PYTHONPATH the real sandbox uses, so a
# wheel built for the wrong interpreter or architecture is caught here rather
# than in a user's chat turn. Docker is reached through DOCKER_HOST (the
# filtered socket proxy on 127.0.0.1:2375 in production), so load the app's
# .env before running this manually.
#
# Fallback when Docker is not reachable: check that each module's directory
# (or top-level .py) is present on disk. Weaker — it cannot catch a cp312
# wheel — but better than no signal at all.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/sandbox-python-version.sh
source "$SCRIPT_DIR/sandbox-python-version.sh"

RELEASE_DIR="${1:-$(pwd)}"
SITE_PACKAGES_DIR="$RELEASE_DIR/$SANDBOX_PYTHON_SITE_PACKAGES_RELPATH"

if [ ! -d "$SITE_PACKAGES_DIR" ]; then
  echo "verify-sandbox-packages: $SITE_PACKAGES_DIR does not exist"
  exit 1
fi

# Bounded: DOCKER_HOST is a TCP socket proxy and a wedged one makes a bare
# `docker version` hang with no client-side timeout. This script is called
# from the middle of a deploy, so it must always come back.
docker_is_reachable() {
  command -v docker >/dev/null 2>&1 || return 1
  sandbox_bounded "$SANDBOX_DOCKER_PROBE_TIMEOUT" docker version >/dev/null 2>&1
}

# Only run the container check when the image is ALREADY on the box. `docker
# run` would otherwise pull python:<version>-slim, which can take minutes for
# a check that is not even allowed to fail the deploy. When it is absent we
# fall back to the on-disk check; the app pulls the image on its first
# sandbox job anyway.
sandbox_image_is_present() {
  sandbox_bounded "$SANDBOX_DOCKER_PROBE_TIMEOUT" \
    docker image inspect "$SANDBOX_PYTHON_IMAGE" >/dev/null 2>&1
}

verify_with_container() {
  local import_statement
  # "openpyxl xlsxwriter docx pptx" -> "import openpyxl, xlsxwriter, docx, pptx"
  import_statement="import ${SANDBOX_PYTHON_IMPORT_NAMES// /, }"

  sandbox_bounded "$SANDBOX_CONTAINER_VERIFY_TIMEOUT" docker run --rm \
    --network none \
    --user "$(id -u):$(id -g)" \
    -e "PYTHONPATH=$SANDBOX_PYTHON_PACKAGES_MOUNT_PATH" \
    -v "$SITE_PACKAGES_DIR:$SANDBOX_PYTHON_PACKAGES_MOUNT_PATH:ro" \
    "$SANDBOX_PYTHON_IMAGE" \
    python3 -c "$import_statement"
}

verify_on_disk() {
  local missing=""
  local module
  for module in $SANDBOX_PYTHON_IMPORT_NAMES; do
    if [ ! -d "$SITE_PACKAGES_DIR/$module" ] && [ ! -f "$SITE_PACKAGES_DIR/$module.py" ]; then
      missing="$missing $module"
    fi
  done

  if [ -n "$missing" ]; then
    echo "verify-sandbox-packages: missing from $SITE_PACKAGES_DIR:$missing"
    return 1
  fi
  return 0
}

if docker_is_reachable; then
  if sandbox_image_is_present; then
    if verify_with_container; then
      echo "verify-sandbox-packages: OK (imported $SANDBOX_PYTHON_IMPORT_NAMES in $SANDBOX_PYTHON_IMAGE)"
      exit 0
    fi
    echo "verify-sandbox-packages: import check FAILED inside $SANDBOX_PYTHON_IMAGE"
    echo "  mount source: $SITE_PACKAGES_DIR"
    # Two very different faults produce the same ModuleNotFoundError, and
    # sending an operator to inspect wheel tags when the real problem is the
    # bind mount wastes an afternoon. If the modules ARE on disk, the daemon
    # could not see the host path — a daemon in another mount namespace, or a
    # DOCKER_HOST pointing somewhere that is not this filesystem.
    if verify_on_disk >/dev/null 2>&1; then
      echo "  ...but the modules ARE present on disk. The container saw an empty mount, so the"
      echo "  Docker daemon behind DOCKER_HOST=${DOCKER_HOST:-<unset>} cannot see that path."
      echo "  The app's sandbox binds the same path, so file production will fail the same way."
    else
      echo "  The directory is genuinely missing modules, or they are built for the wrong"
      echo "  interpreter/architecture. Re-run the deploy's package step."
    fi
    exit 1
  fi
  echo "verify-sandbox-packages: $SANDBOX_PYTHON_IMAGE is not on this host; skipping the container"
  echo "  import check rather than pulling it mid-deploy. Pull it once with:"
  echo "    docker pull $SANDBOX_PYTHON_IMAGE"
else
  echo "verify-sandbox-packages: Docker not reachable; falling back to a file-presence check"
fi

if verify_on_disk; then
  echo "verify-sandbox-packages: OK on disk (presence only, interpreter tag unverified)"
  exit 0
fi
exit 1
