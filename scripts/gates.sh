#!/bin/bash
# AlfyAI gate runner: see scripts/gates.mjs for what it runs and its options.
#   scripts/gates.sh release <out-dir> [options]
#   scripts/gates.sh agent   <out-dir> [options] [spec ...]
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
exec node "$(dirname "$0")/gates.mjs" "$@"
