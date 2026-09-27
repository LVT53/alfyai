#!/bin/bash
# Run AlfyAI's full gate set in one worktree and write a one-screen summary.
# usage: gates.sh <worktree> <e2e_port> <label> [extra playwright specs...]
# Logs: /tmp/gates-<label>/*.log ; summary: /tmp/gates-<label>/summary.txt
set -u
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
WT=$1; PORT=$2; LABEL=$3; shift 3
OUT=/tmp/gates-$LABEL; mkdir -p "$OUT"
cd "$WT" || exit 2
S=$OUT/summary.txt; : > "$S"
note() { echo "$*" | tee -a "$S"; }
note "gates $LABEL at $(git log --oneline -1 | cut -c1-72) — start $(date +%T)"
npm run check > "$OUT/check.log" 2>&1
note "check      exit=$? :: $(grep -E 'COMPLETED' "$OUT/check.log" | tail -1 | sed -E 's/^[0-9]+ //')"
npx biome check src scripts tests > "$OUT/biome.log" 2>&1
note "biome      exit=$? :: $(tail -1 "$OUT/biome.log")"
npm run check:migrations > "$OUT/migrations.log" 2>&1
note "migrations exit=$? :: $(tail -1 "$OUT/migrations.log")"
npm test > "$OUT/test.log" 2>&1
note "test       exit=$? :: $(sed -E 's/\x1b\[[0-9;]*m//g' "$OUT/test.log" | grep -E '^\s*(Test Files|Tests) ' | tr -s ' ' | tr '\n' ' ')"
npm run build > "$OUT/build.log" 2>&1
note "build      exit=$? :: unused-css=$(grep -c 'Unused CSS selector' "$OUT/build.log") aria=$(grep -c 'must have an ARIA role' "$OUT/build.log") (baseline 32/2)"
npx fallow --no-cache --format json --quiet --score --output-file "$OUT/fallow.json" > "$OUT/fallow.log" 2>&1
note "fallow     exit=$? :: $(python3 - "$OUT/fallow.json" <<'PY'
import json, sys
POS = {"line", "col", "column", "start", "end", "span", "span_start", "span_end", "offset", "line_number", "start_line", "end_line"}
def norm(x):
    if isinstance(x, dict):
        return {k: norm(v) for k, v in x.items() if k not in POS}
    if isinstance(x, list):
        return [norm(v) for v in x]
    return x
base = json.load(open('/Users/lvt53/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json'))['check']
cur = json.load(open(sys.argv[1]))['check']
added, removed = [], []
for k, v in cur.items():
    if isinstance(v, list):
        sb = {json.dumps(norm(x), sort_keys=True) for x in base.get(k, [])}
        sc = {json.dumps(norm(x), sort_keys=True) for x in v}
        added += [f"{k}: {e[:140]}" for e in sc - sb]
        removed += [f"{k}" for e in sb - sc]
print(f"total={cur['total_issues']} circular={len(cur['circular_dependencies'])} new_vs_baseline={len(added)} gone_vs_baseline={len(removed)}")
for a in added[:8]:
    print("   NEW " + a)
PY
)"
DATABASE_PATH="$PWD/data/playwright-e2e-chat.db" npm run db:prepare > "$OUT/dbprep.log" 2>&1
E2E_PORT=$PORT npx playwright test tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts "$@" > "$OUT/pw.log" 2>&1
note "playwright exit=$? :: $(sed -E 's/\x1b\[[0-9;]*m//g' "$OUT/pw.log" | grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)' | tr -s ' ' | tr '\n' ' ')"
note "done $(date +%T)"
