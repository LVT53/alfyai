#!/bin/bash
# ============================================================================
# Single source of truth (shell half) for the file-production sandbox's
# Python runtime.
#
# The TypeScript half is src/lib/server/sandbox/python-version.ts. Shell
# cannot import TypeScript, so the version is written down twice — and
# scripts/deploy.test.ts asserts the two copies are byte-identical, so a
# change here that is not mirrored there (or vice versa) fails the suite.
#
# Why this matters: the sandbox container bind-mounts
#   <release>/sandbox-python-env/lib/python<VERSION>/site-packages
# read-only. If the deploy installs packages anywhere else, Docker creates
# that mount source as an EMPTY, ROOT-OWNED directory on first use, every
# Python program-mode job dies with ModuleNotFoundError, and the next
# deploy's prune step cannot remove the release.
#
# This file assigns the constants and defines one tiny helper
# (sandbox_bounded) that both scripts/deploy-lib.sh and
# scripts/verify-sandbox-packages.sh need; it is sourced, never executed.
# ============================================================================

# shellcheck disable=SC2034  # every constant below is read by a sourcing script.

# The Python minor version the sandbox container runs.
SANDBOX_PYTHON_VERSION="3.11"

# The sandbox image, derived from the one version constant above.
SANDBOX_PYTHON_IMAGE="python:${SANDBOX_PYTHON_VERSION}-slim"

# Release-relative path of the directory the container bind-mounts.
SANDBOX_PYTHON_SITE_PACKAGES_RELPATH="sandbox-python-env/lib/python${SANDBOX_PYTHON_VERSION}/site-packages"

# Where that directory appears inside the container.
SANDBOX_PYTHON_PACKAGES_MOUNT_PATH="/workspace/python-packages"

# Distributions to install, exactly the set the run_python / produce_file
# tool descriptions promise (src/lib/server/services/normal-chat-tools/index.ts).
SANDBOX_PYTHON_PACKAGES="openpyxl xlsxwriter python-docx python-pptx"

# The module names those distributions import as, in the same order.
SANDBOX_PYTHON_IMPORT_NAMES="openpyxl xlsxwriter docx pptx"

# ----------------------------------------------------------------------------
# Wall-clock ceilings, and the helper that applies them.
#
# Nothing in the sandbox-package path is allowed to hang a deploy. DOCKER_HOST
# points at a TCP socket proxy, and a wedged proxy makes a bare `docker
# version` or `docker run` block forever with no client-side timeout; a
# stalled package index does the same to pip. Every ceiling below is a
# backstop, not a budget — hitting one means "this strategy failed, try the
# next" and never "fail the deploy".
# ----------------------------------------------------------------------------
SANDBOX_DOCKER_PROBE_TIMEOUT="${SANDBOX_DOCKER_PROBE_TIMEOUT:-20}"
SANDBOX_PIP_TIMEOUT="${SANDBOX_PIP_TIMEOUT:-600}"
SANDBOX_VENV_TIMEOUT="${SANDBOX_VENV_TIMEOUT:-180}"
SANDBOX_CONTAINER_TIMEOUT="${SANDBOX_CONTAINER_TIMEOUT:-900}"
SANDBOX_CONTAINER_VERIFY_TIMEOUT="${SANDBOX_CONTAINER_VERIFY_TIMEOUT:-180}"

# Runs a command under a wall-clock ceiling:  sandbox_bounded <seconds> cmd...
#
# Uses coreutils `timeout` when the host has it (the Linux deploy box does).
# A host without it loses the ceiling rather than the step, which is strictly
# the old behaviour. `timeout` exits 124 on expiry; every caller treats any
# non-zero exit as "that strategy did not work".
sandbox_bounded() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}
