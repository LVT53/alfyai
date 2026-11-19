#!/bin/bash
# Restarts a MinerU api-server that refuses all work until it is restarted.
#
# MinerU 4.2.3's hang guard (`--task-timeout`): once one file's execution
# outlives it, `/v1/health` and every new task answer 503 `task_timeout`, and
# only a restart of the process clears that. The server never exits, so
# systemd's `Restart=on-failure` never fires. A dead parse engine does the same
# with 503 `engine_dead`. Any other answer is left alone: a healthy server, a
# 503 that clears by itself (`engine_unavailable`, `server_shutting_down`), a
# server that does not answer (down or starting: systemd's business), a unit
# that is not running. A restart makes MinerU forget every task, which the app
# absorbs: its jobs create their tasks again (docs/uploads.md, "Restarts").
#
# Run every minute by mineru42-watchdog.timer (deploy/mineru/README.md). Health
# is public, so no key is read. Every restart, and every restart held back, is
# written to the journal: journalctl -t mineru-watchdog.
set -u

UNIT="${MINERU_WATCHDOG_UNIT:-mineru42.service}"
URL="${MINERU_WATCHDOG_URL:-http://127.0.0.1:8004/v1/health}"
# A unit that came up less than this long ago is not restarted again: an engine
# that dies at once after every start needs a person, not a restart a minute.
MIN_UP_S="${MINERU_WATCHDOG_MIN_UP_S:-300}"
TAG=mineru-watchdog

systemctl is-active --quiet "$UNIT" || exit 0

answer=$(curl -s --max-time 10 -w '\n%{http_code}' "$URL") || exit 0
status=${answer##*$'\n'}
[ "$status" = 503 ] || exit 0
body=${answer%$'\n'*}

code=$(printf '%s' "$body" | python3 -I -c 'import json, sys
try:
    error = json.load(sys.stdin).get("error") or {}
    print(error.get("code") or "")
except Exception:
    print("")')
case "$code" in
	task_timeout | engine_dead) ;;
	*) exit 0 ;;
esac

since_us=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$UNIT")
up_s=$(python3 -I -c 'import sys, time
print(int(time.monotonic() - int(sys.argv[1]) / 1_000_000))' "${since_us:-0}")
if [ "$up_s" -lt "$MIN_UP_S" ]; then
	logger -t "$TAG" "$UNIT answers 503 $code, but it came up ${up_s}s ago (under ${MIN_UP_S}s): not restarting it again yet"
	exit 0
fi

logger -t "$TAG" "$UNIT answers 503 $code on $URL, up ${up_s}s: restarting it"
systemctl restart "$UNIT"
