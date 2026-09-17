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
# This file only assigns variables; it is sourced, never executed.
# ============================================================================

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
