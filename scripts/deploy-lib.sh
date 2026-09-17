#!/bin/bash
# ============================================================================
# Shared deploy steps for scripts/deploy.sh and scripts/deploy-dev.sh.
#
# Both scripts source this file out of the release they just materialized, so
# the helper always matches the code being deployed, and staging/production
# cannot drift in the logic that lives here. Environment-specific values
# (branch, service, port, restart privileges) stay in the two scripts.
#
# This file only defines functions and defaults; it is sourced, never run.
# ============================================================================

# The two deploy scripts define these before sourcing us; the defaults keep
# this file usable on its own (e.g. when a human sources it to re-run a step).
RED="${RED:-$'\033[0;31m'}"
GREEN="${GREEN:-$'\033[0;32m'}"
YELLOW="${YELLOW:-$'\033[1;33m'}"
NC="${NC:-$'\033[0m'}"

DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/sandbox-python-version.sh
source "$DEPLOY_LIB_DIR/sandbox-python-version.sh"

# Non-fatal problems collected during the deploy. The deploy still ships (the
# chat app must not be held hostage by a sandbox package or an old release we
# cannot delete), but the final summary repeats every one of them so nobody
# has to scroll back through a successful-looking log to notice.
DEPLOY_WARNINGS=()

deploy_warn() {
  DEPLOY_WARNINGS+=("$1")
  echo -e "${RED}⚠⚠⚠ $1${NC}"
}

print_deploy_warnings() {
  if [ ${#DEPLOY_WARNINGS[@]} -eq 0 ]; then
    return 0
  fi

  echo -e "${RED}=== ${#DEPLOY_WARNINGS[@]} deploy warning(s) — the app shipped, but read these ===${NC}"
  local warning
  for warning in "${DEPLOY_WARNINGS[@]}"; do
    echo -e "${RED}  ⚠ $warning${NC}"
  done
  echo ""
}

# ----------------------------------------------------------------------------
# Python sandbox packages
# ----------------------------------------------------------------------------

# The first pip that can run on this host, as a command word list.
sandbox_host_pip() {
  if command -v python3 >/dev/null 2>&1 && python3 -m pip --version >/dev/null 2>&1; then
    echo "python3 -m pip"
    return 0
  fi
  if command -v pip3 >/dev/null 2>&1; then
    echo "pip3"
    return 0
  fi
  if command -v pip >/dev/null 2>&1; then
    echo "pip"
    return 0
  fi
  return 1
}

# PRIMARY strategy. Any host pip will do, because we ask it to resolve wheels
# for the CONTAINER's interpreter rather than its own: cp3.11, manylinux
# x86_64. This is what the old code got wrong — it built a venv with the host
# python3 (3.12 on the box) and installed into
# .../lib/python3.12/site-packages, a directory nothing ever mounts.
#
# --only-binary=:all: is deliberate: pip cannot build an sdist for a foreign
# interpreter, so a missing wheel must fail loudly here rather than produce a
# half-populated directory. lxml and Pillow (the compiled dependencies of
# python-docx/python-pptx and openpyxl's image support) publish cp311
# manylinux wheels, so the resolve succeeds. Several --platform tags are
# passed because wheels are tagged inconsistently across projects
# (manylinux2014 == manylinux_2_17; newer builds ship manylinux_2_28).
sandbox_install_with_host_pip() {
  local target="$1"
  local pip_cmd
  pip_cmd="$(sandbox_host_pip)" || return 1

  # Intentional word splitting on $pip_cmd and $SANDBOX_PYTHON_PACKAGES.
  # shellcheck disable=SC2086
  $pip_cmd install \
    --quiet \
    --disable-pip-version-check \
    --upgrade \
    --target "$target" \
    --python-version "$SANDBOX_PYTHON_VERSION" \
    --implementation cp \
    --only-binary=:all: \
    --platform manylinux2014_x86_64 \
    --platform manylinux_2_17_x86_64 \
    --platform manylinux_2_28_x86_64 \
    $SANDBOX_PYTHON_PACKAGES
}

# FALLBACK strategy, for a host with no usable pip. Installs from inside the
# sandbox image itself, so the interpreter is correct by construction. Runs as
# the deploying user so the bind-mounted target does not come back root-owned
# (a root-owned directory here is exactly what makes the prune step fail).
# Honours DOCKER_HOST, which is why the caller runs this after the .env load.
sandbox_install_with_container() {
  local target="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker version >/dev/null 2>&1 || return 1

  # Intentional word splitting on $SANDBOX_PYTHON_PACKAGES.
  # shellcheck disable=SC2086
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
    -v "$target:/target" \
    "$SANDBOX_PYTHON_IMAGE" \
    pip install --quiet --no-cache-dir --upgrade --target /target $SANDBOX_PYTHON_PACKAGES
}

# Populate the directory the sandbox container actually mounts, then prove the
# modules import. Deliberately always returns 0: the chat app must ship even
# when file production cannot. A failure is not swallowed, though — it is
# recorded via deploy_warn, which prints it in red here and repeats it in the
# final summary.
setup_sandbox_python_packages() {
  local release_dir="$1"
  local target="$release_dir/$SANDBOX_PYTHON_SITE_PACKAGES_RELPATH"
  local strategy=""

  # Create it ourselves, as the deploying user, BEFORE any container can.
  # Docker silently creates a missing bind-mount source as root, which both
  # empties the packages and makes this release undeletable later.
  mkdir -p "$target"

  if sandbox_install_with_host_pip "$target"; then
    strategy="host pip cross-install (cp${SANDBOX_PYTHON_VERSION//./} manylinux x86_64)"
  elif sandbox_install_with_container "$target"; then
    strategy="$SANDBOX_PYTHON_IMAGE container"
  else
    deploy_warn "Python sandbox packages were NOT installed ($SANDBOX_PYTHON_PACKAGES). Neither a host pip cross-install nor a $SANDBOX_PYTHON_IMAGE container worked. produce_file program mode and run_python will fail with ModuleNotFoundError until this is fixed. Target: $target"
    return 0
  fi

  echo -e "${GREEN}✓ Python sandbox packages installed via $strategy${NC}"
  echo "  into $target"

  if bash "$DEPLOY_LIB_DIR/verify-sandbox-packages.sh" "$release_dir"; then
    echo -e "${GREEN}✓ Python sandbox packages verified importable${NC}"
    return 0
  fi

  deploy_warn "Python sandbox packages are present but NOT importable from $target. produce_file program mode (xlsx/docx/pptx) will fail with ModuleNotFoundError. Re-run: bash scripts/verify-sandbox-packages.sh $release_dir"
  return 0
}

# ----------------------------------------------------------------------------
# Release pruning
# ----------------------------------------------------------------------------

# Deletes all but the newest $keep releases. Old releases can contain
# root-owned leftovers — historically
# sandbox-python-env/lib/python3.11/site-packages, auto-created by Docker as
# root when the deploy installed the packages somewhere else. A release we
# cannot delete is a disk-space annoyance, not a reason to fail a deploy that
# already cut over successfully, so this warns and continues.
prune_old_releases() {
  local releases_dir="$1"
  local keep="$2"
  local undeletable=()
  local old_release
  local rm_output

  while IFS= read -r old_release; do
    old_release="${old_release%/}"
    echo "  removing $(basename "$old_release")"
    if ! rm_output="$(rm -rf "$old_release" 2>&1)"; then
      undeletable+=("$old_release")
      echo -e "${YELLOW}    could not fully remove: ${rm_output}${NC}"
    elif [ -e "$old_release" ]; then
      # GNU rm can exit 0 having skipped an unreadable subtree.
      undeletable+=("$old_release")
    fi
  done < <(ls -1dt "$releases_dir"/*/ 2>/dev/null | tail -n +"$((keep + 1))")

  if [ ${#undeletable[@]} -eq 0 ]; then
    echo -e "${GREEN}✓ Retained the last $keep releases${NC}"
    return 0
  fi

  local leftovers="${undeletable[*]}"
  deploy_warn "Could not remove ${#undeletable[@]} old release(s): $leftovers — they contain root-owned files (Docker auto-creates a missing bind-mount source as root). The deploy is fine; disk use is not. One-off cleanup, from an account with sudo: sudo rm -rf $leftovers"

  echo -e "${YELLOW}  To stop this recurring, also hand the releases tree back to the deploy user:${NC}"
  echo -e "${YELLOW}    sudo chown -R \"\$(id -un):\$(id -gn)\" $releases_dir${NC}"
  return 0
}
