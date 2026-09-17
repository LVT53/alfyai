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
# Database backup (runs immediately before `npm run db:prepare`)
#
# There are 110 migrations, 9 of them destructive, and db:prepare runs them
# against the LIVE ~140 MB SQLite file under shared/data — the same file the
# currently-serving release has open. A migration that corrupts or truncates it
# is unrecoverable without a copy, so every deploy takes one first.
#
# This is the ONE step allowed to abort a deploy. It runs before the symlink
# cutover, so aborting here leaves production exactly as it was: still serving
# the previous release, with an unmigrated database. Refusing to migrate
# without a backup is strictly safer than migrating without one. Operators who
# knowingly want to proceed anyway set DB_BACKUP_REQUIRED=0, which downgrades
# the abort to a loud warning.
# ----------------------------------------------------------------------------

# How many backups to retain, and whether a failed backup stops the deploy.
DB_BACKUP_KEEP="${DB_BACKUP_KEEP:-7}"
DB_BACKUP_REQUIRED="${DB_BACKUP_REQUIRED:-1}"
# Wall-clock ceiling for the copy and for the integrity check. A 140 MB
# `.backup` finishes in seconds; this only exists so a stalled filesystem
# cannot hang a deploy forever. Applied through the same sandbox_bounded helper
# the sandbox steps use.
DB_BACKUP_TIMEOUT="${DB_BACKUP_TIMEOUT:-600}"

# Where db:prepare will actually open the database.
#
# scripts/prepare-db.ts defaults DATABASE_PATH to the relative "./data/chat.db"
# and both deploy scripts run it with the release directory as cwd, where
# `data` is a symlink to shared/data. So a relative DATABASE_PATH resolves
# against the release directory (landing on the same inode as shared/data), an
# absolute one is taken as-is, and an unset one falls back to the shared path
# directly. Resolving it the same way db:prepare does is the point: backing up
# a different file than the one about to be migrated would be worse than not
# backing up at all, because it would look like it worked.
deploy_database_path() {
  local release_dir="$1"
  local shared_dir="$2"

  if [ -z "$DATABASE_PATH" ]; then
    echo "$shared_dir/data/chat.db"
    return 0
  fi

  case "$DATABASE_PATH" in
  /*) echo "$DATABASE_PATH" ;;
  *) echo "$release_dir/${DATABASE_PATH#./}" ;;
  esac
}

# PRIMARY strategy: the sqlite3 CLI's `.backup`, which drives SQLite's online
# backup API. That is the only one of the three that is guaranteed consistent
# while another process is writing: it takes a read lock per page-batch and
# restarts if the source changes, so the result is a single self-consistent
# database file with the WAL already folded in. Nothing else here can promise
# that, which is why it is tried first even though better-sqlite3 is always
# installed by then.
db_backup_with_sqlite3() {
  local db="$1"
  local dest="$2"

  command -v sqlite3 >/dev/null 2>&1 || return 1
  # umask in a subshell so the file is born 600 rather than being widened for
  # however long a 140 MB copy takes.
  (
    umask 077
    sandbox_bounded "$DB_BACKUP_TIMEOUT" sqlite3 "$db" ".backup '$dest'"
  )
}

# SECOND strategy: the same online backup API through better-sqlite3, which is
# a production dependency and therefore present in the release's node_modules
# by the time this runs (step 3 installed it). This exists for a box with no
# sqlite3 CLI package — which is the normal state of a minimal Debian host.
#
# Run with the release directory as cwd so `require("better-sqlite3")` resolves
# out of the release being deployed rather than out of whatever happens to be
# installed globally.
db_backup_with_node() {
  local db="$1"
  local dest="$2"
  local release_dir="$3"

  command -v node >/dev/null 2>&1 || return 1
  [ -d "$release_dir/node_modules/better-sqlite3" ] || return 1

  (
    umask 077
    cd "$release_dir" || exit 1
    DB_BACKUP_SOURCE="$db" DB_BACKUP_DEST="$dest" \
      sandbox_bounded "$DB_BACKUP_TIMEOUT" node -e '
        const Database = require("better-sqlite3");
        const db = new Database(process.env.DB_BACKUP_SOURCE, { fileMustExist: true });
        db.backup(process.env.DB_BACKUP_DEST)
          .then(() => { db.close(); })
          .catch((error) => { console.error(String(error && error.message ? error.message : error)); process.exit(1); });
      '
  )
}

# LAST strategy: a plain file copy, including the -wal and -shm sidecars.
#
# Deliberately loud. A cp of a live WAL database is a point-in-time snapshot of
# three files that were not copied atomically, so it can land mid-transaction;
# copying the sidecars alongside it is what gives SQLite a chance to recover on
# open, and the integrity check afterwards is what decides whether it did. This
# is a last resort, not an equivalent option.
db_backup_with_cp() {
  local db="$1"
  local dest="$2"

  (
    umask 077
    cp -p -- "$db" "$dest" || exit 1
    if [ -f "$db-wal" ]; then
      cp -p -- "$db-wal" "$dest-wal" || exit 1
    fi
    if [ -f "$db-shm" ]; then
      cp -p -- "$db-shm" "$dest-shm" || exit 1
    fi
    exit 0
  )
}

# Is the file we just wrote actually a usable database?
#
# `PRAGMA integrity_check` is the real answer and is used whenever the CLI is
# available. Without it we can only assert the file is non-empty, which is weak
# — but it still catches the failure mode that matters most here, a backup
# "succeeding" into a zero-byte file on a full disk.
db_backup_verify() {
  local dest="$1"

  [ -s "$dest" ] || return 1

  if command -v sqlite3 >/dev/null 2>&1; then
    local result
    result="$(sandbox_bounded "$DB_BACKUP_TIMEOUT" sqlite3 "$dest" "PRAGMA integrity_check;" 2>/dev/null)" || return 1
    [ "$result" = "ok" ] || return 1
  fi

  return 0
}

# Deletes all but the newest $keep backups:
#
#   prune_old_db_backups <backup dir> <keep> <never-delete path>
#
# The third argument is the backup this deploy just made. It is never deleted
# whatever the ordering says — the same guard prune_old_releases applies to the
# live release, and for the same reason: an `ls -t` ordering can surprise you
# (a restored file with an old mtime, a clock jump, two deploys inside the same
# second), and the one backup we are certain is good must not be the casualty.
#
# Retention failures are warnings, never deploy failures: an undeleted old
# backup is disk use, and this runs after a backup that already succeeded.
prune_old_db_backups() {
  local backup_dir="$1"
  local keep="$2"
  local protected="$3"

  [ -d "$backup_dir" ] || return 0

  local removed=0
  local failed=()
  local candidate

  # shellcheck disable=SC2012  # names are `chat-<ts>-<sha>.db`; we need -t ordering.
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" = "$protected" ]; then
      continue
    fi
    if rm -f -- "$candidate" "$candidate-wal" "$candidate-shm" 2>/dev/null; then
      removed=$((removed + 1))
    else
      failed+=("$candidate")
    fi
  done < <(ls -1t "$backup_dir"/chat-*.db 2>/dev/null | tail -n +"$((keep + 1))")

  if [ ${#failed[@]} -gt 0 ]; then
    deploy_warn "Could not delete ${#failed[@]} old database backup(s) under $backup_dir: ${failed[*]}. The backup for this deploy was taken successfully; this is disk use, not a deploy problem."
  fi

  if [ "$removed" -gt 0 ]; then
    echo "  pruned $removed old backup(s), keeping the newest $keep"
  fi

  return 0
}

# Deletes a backup we are not keeping (a failed write, or one that did not
# verify). `rm -f` already tolerates the sidecars not existing, so a non-zero
# exit here means something real — a read-only filesystem or a directory we do
# not own — and leaving an unverified file named like a good backup is exactly
# the kind of thing an operator reaches for at 3am, so say so.
db_backup_discard() {
  local dest="$1"
  if ! rm -f -- "$dest" "$dest-wal" "$dest-shm" 2>/dev/null; then
    deploy_warn "Could not delete the unusable database backup at $dest. Remove it by hand so it is never mistaken for a good one."
  fi
}

# Shared tail of every backup failure: explain it, and decide whether it stops
# the deploy. Returns the code backup_database should return, so each of its
# three failure paths stays two lines.
db_backup_failed() {
  local db="$1"
  local reason="$2"

  if [ "$DB_BACKUP_REQUIRED" = "0" ]; then
    deploy_warn "Database backup FAILED ($reason) and DB_BACKUP_REQUIRED=0, so the deploy is continuing and the migrations will run against $db with no backup. If a migration damages the database there is no way back."
    return 0
  fi

  echo -e "${RED}✗ Database backup FAILED: $reason${NC}"
  echo -e "${RED}  Database: $db${NC}"
  echo -e "${RED}  Refusing to run db:prepare without a backup. There are destructive migrations,${NC}"
  echo -e "${RED}  and this deploy has not cut over yet, so the running service is untouched.${NC}"
  echo -e "${YELLOW}  Fix the cause (disk space, permissions on the backups directory), then re-run the deploy.${NC}"
  echo -e "${YELLOW}  To deploy anyway, knowing the database is unprotected: DB_BACKUP_REQUIRED=0 <deploy command>${NC}"
  return 1
}

# Back up the live database before migrations.
#
#   backup_database <release dir> <shared dir> <release sha>
#
# Returns 0 when a verified backup exists, when there is nothing to back up
# (first install), or when the operator has set DB_BACKUP_REQUIRED=0. Returns
# 1 ONLY when a backup was attempted, failed, and is required — the caller then
# exits before migrating anything.
backup_database() {
  local release_dir="$1"
  local shared_dir="$2"
  local release_sha="$3"

  local db
  db="$(deploy_database_path "$release_dir" "$shared_dir")"

  # First install: db:prepare is about to create this file, so there is
  # genuinely nothing to lose. Skip quietly rather than inventing a failure.
  if [ ! -f "$db" ]; then
    echo -e "${GREEN}✓ No database at $db yet (first install); nothing to back up${NC}"
    return 0
  fi

  local backup_dir="$shared_dir/backups"
  if ! mkdir -p "$backup_dir" 2>/dev/null; then
    db_backup_failed "$db" "could not create the backup directory $backup_dir"
    return $?
  fi
  # The backups are full copies of every conversation, credential blob and
  # session in the product, so the directory is owner-only. A chmod failure is
  # not a reason to refuse to back up, but it is a reason to say so loudly.
  if ! chmod 700 "$backup_dir" 2>/dev/null; then
    deploy_warn "Could not chmod 700 $backup_dir. Database backups contain every conversation and every encrypted credential in the product; check who can read that directory."
  fi

  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local dest="$backup_dir/chat-$timestamp-$release_sha.db"

  local strategy=""
  if db_backup_with_sqlite3 "$db" "$dest"; then
    strategy="sqlite3 .backup (online, WAL-consistent)"
  elif db_backup_with_node "$db" "$dest" "$release_dir"; then
    strategy="better-sqlite3 .backup() (online, WAL-consistent)"
  elif db_backup_with_cp "$db" "$dest"; then
    strategy="plain cp of the db, -wal and -shm"
    deploy_warn "The database backup fell back to a plain file copy: neither the sqlite3 CLI nor better-sqlite3 was usable on this host. A cp of a live WAL database is not an atomic snapshot — it passed the integrity check below, but install the sqlite3 package so future deploys get a real online backup."
  else
    db_backup_discard "$dest"
    db_backup_failed "$db" "all three backup strategies failed (sqlite3 CLI, better-sqlite3, cp)"
    return $?
  fi

  # Belt and braces: every strategy already writes under `umask 077`, but a
  # pre-existing file at $dest would keep its old mode.
  if ! chmod 600 "$dest" 2>/dev/null; then
    deploy_warn "Could not chmod 600 $dest. That file is a full copy of the database; check who can read it."
  fi

  if ! db_backup_verify "$dest"; then
    db_backup_discard "$dest"
    db_backup_failed "$db" "the backup written by the $strategy strategy did not pass verification and has been deleted"
    return $?
  fi

  local size
  size="$(du -h "$dest" 2>/dev/null | cut -f1)"
  echo -e "${GREEN}✓ Database backed up via $strategy${NC}"
  echo "  $dest (${size:-unknown size}, verified)"

  # The restore line has to match the backup that was actually taken.
  #
  # `.backup` (either flavour) folds the WAL into the destination, and
  # db_backup_verify's `PRAGMA integrity_check` checkpoints whatever is left, so
  # the main file is normally the whole backup and the sidecars are empty. But
  # the cp strategy on a host with no sqlite3 CLI is the one case where neither
  # of those happened: the copied `-wal` can hold committed transactions that
  # are in no other file. Restoring only the main file would silently discard
  # them, which is a quieter kind of data loss than the one this step exists to
  # prevent. So print the sidecars when they are actually carrying something.
  if [ -s "$dest-wal" ]; then
    echo -e "${YELLOW}  This backup's -wal sidecar is NOT empty: it holds committed transactions"
    echo -e "  that are in no other file, so restore all three or lose them.${NC}"
    echo "  Restore: stop the service, then  cp -p \"$dest\" \"$db\" && cp -p \"$dest-wal\" \"$db-wal\" && rm -f \"$db-shm\"  and start it again (see deploy/README.md)"
  else
    echo "  Restore: stop the service, then  cp -p \"$dest\" \"$db\" && rm -f \"$db-wal\" \"$db-shm\"  and start it again (see deploy/README.md)"
  fi

  prune_old_db_backups "$backup_dir" "$DB_BACKUP_KEEP" "$dest"

  return 0
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

# The cross-install itself, given a pip to drive it with.
#
# Any pip will do, because we ask it to resolve wheels for the CONTAINER's
# interpreter rather than its own: cp3.11, manylinux x86_64. This is what the
# old code got wrong — it built a venv with the host python3 (3.12 on the box)
# and installed into .../lib/python3.12/site-packages, a directory nothing
# ever mounts.
#
# --only-binary=:all: is deliberate: pip cannot build an sdist for a foreign
# interpreter, so a missing wheel must fail loudly here rather than produce a
# half-populated directory. lxml and Pillow (the compiled dependencies of
# python-docx/python-pptx and openpyxl's image support) publish cp311
# manylinux wheels, so the resolve succeeds. Several --platform tags are
# passed because wheels are tagged inconsistently across projects
# (manylinux2014 == manylinux_2_17; newer builds ship manylinux_2_28).
#
# --upgrade is what makes re-running this on an existing release directory
# (a redeploy of the same sha) work: without it pip refuses to overwrite a
# populated --target and merely warns.
#
# --target also switches off pip's PEP 668 "externally-managed-environment"
# guard (pip only checks when root/prefix/target are all unset), so a
# Debian-managed system python is fine here.
sandbox_pip_cross_install() {
  local pip_cmd="$1"
  local target="$2"

  # Intentional word splitting on $pip_cmd ("python3 -m pip") and on
  # $SANDBOX_PYTHON_PACKAGES.
  # shellcheck disable=SC2086
  sandbox_bounded "$SANDBOX_PIP_TIMEOUT" $pip_cmd install \
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

# PRIMARY strategy: a pip that is already on the host.
sandbox_install_with_host_pip() {
  local target="$1"
  local pip_cmd
  pip_cmd="$(sandbox_host_pip)" || return 1
  sandbox_pip_cross_install "$pip_cmd" "$target"
}

# SECOND strategy, for a host that has python3 but no pip module — the normal
# Debian/Ubuntu split, where python3-pip is absent but python3-venv's ensurepip
# still ships a pip wheel. That is exactly how the OLD deploy script got a pip,
# so dropping to the container before trying it would be a capability
# regression on this box.
#
# The venv is a scratch directory under $TMPDIR that is deleted again
# immediately; it is only a way to obtain a pip. Nothing from it is ever
# mounted into the sandbox — the install still goes to "$target", the cp311
# path the container bind-mounts.
sandbox_install_with_bootstrap_venv() {
  local target="$1"
  command -v python3 >/dev/null 2>&1 || return 1

  local bootstrap_dir
  bootstrap_dir="$(mktemp -d "${TMPDIR:-/tmp}/alfyai-pip-bootstrap.XXXXXX")" || return 1

  local status=1
  if sandbox_bounded "$SANDBOX_VENV_TIMEOUT" python3 -m venv "$bootstrap_dir/venv" &&
    [ -x "$bootstrap_dir/venv/bin/pip" ]; then
    if sandbox_pip_cross_install "$bootstrap_dir/venv/bin/pip" "$target"; then
      status=0
    fi
  fi

  rm -rf "$bootstrap_dir"
  return "$status"
}

# Is the Docker endpoint (DOCKER_HOST, the filtered socket proxy in
# production) actually answering? Bounded, because a wedged TCP proxy makes a
# bare `docker version` block with no client-side timeout at all.
sandbox_docker_is_reachable() {
  command -v docker >/dev/null 2>&1 || return 1
  sandbox_bounded "$SANDBOX_DOCKER_PROBE_TIMEOUT" docker version >/dev/null 2>&1
}

# LAST strategy, for a host with no usable pip at all. Installs from inside the
# sandbox image itself, so the interpreter is correct by construction. Runs as
# the deploying user so the bind-mounted target does not come back root-owned
# (a root-owned directory here is exactly what makes the prune step fail).
# Honours DOCKER_HOST, which is why the caller runs this after the .env load.
# Bounded, because this one may also have to pull the image first.
sandbox_install_with_container() {
  local target="$1"
  sandbox_docker_is_reachable || return 1

  # Intentional word splitting on $SANDBOX_PYTHON_PACKAGES.
  # shellcheck disable=SC2086
  sandbox_bounded "$SANDBOX_CONTAINER_TIMEOUT" docker run --rm \
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
  #
  # Guarded: the callers run this as a plain command under `set -e`, so an
  # unguarded mkdir failure (read-only filesystem, full disk, a root-owned
  # parent left by an older deploy of the same sha) would abort the whole
  # deploy — the one thing this step must never do.
  if ! mkdir -p "$target" 2>/dev/null; then
    deploy_warn "Could not create the sandbox package directory $target, so the Python packages ($SANDBOX_PYTHON_PACKAGES) were not installed. produce_file program mode and run_python will fail with ModuleNotFoundError. Check the filesystem and the ownership of the parent directories."
    return 0
  fi

  if sandbox_install_with_host_pip "$target"; then
    strategy="host pip cross-install (cp${SANDBOX_PYTHON_VERSION//./} manylinux x86_64)"
  elif sandbox_install_with_bootstrap_venv "$target"; then
    strategy="throwaway-venv pip cross-install (cp${SANDBOX_PYTHON_VERSION//./} manylinux x86_64)"
  elif sandbox_install_with_container "$target"; then
    strategy="$SANDBOX_PYTHON_IMAGE container"
  else
    deploy_warn "Python sandbox packages were NOT installed ($SANDBOX_PYTHON_PACKAGES). None of the three strategies worked: a host pip cross-install, a throwaway-venv pip cross-install, or a $SANDBOX_PYTHON_IMAGE container. produce_file program mode and run_python will fail with ModuleNotFoundError until this is fixed. Target: $target"
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

# Resolves a path to its physical location (symlinks followed), or prints
# nothing and fails if it is not a directory we can enter. `readlink -f` is
# not used because it is happy to canonicalize a path that does not exist.
deploy_canonical_dir() {
  cd -- "$1" 2>/dev/null && pwd -P
}

# True when $1 is byte-identical to one of the remaining arguments.
deploy_path_is_protected() {
  local needle="$1"
  shift
  local candidate
  for candidate in "$@"; do
    if [ "$candidate" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

# Deletes all but the newest $keep releases:
#
#   prune_old_releases <releases dir> <keep> [<never-delete path> ...]
#
# The trailing arguments are paths that must survive whatever the ordering
# says — the callers pass $APP_DIR/current and the release just deployed. They
# are compared after resolving symlinks and `..`, so `current` is matched by
# the release directory it points at, not by its own name. Without that guard
# a surprising `ls -t` ordering (a restored backup with an old mtime, a
# manually re-pointed `current`, a clock jump) could delete the tree the live
# service is running out of.
#
# Old releases can contain root-owned leftovers — historically the
# site-packages directory auto-created by Docker as root when the deploy
# installed the packages somewhere else. A release we cannot delete is a
# disk-space annoyance, not a reason to fail a deploy that already cut over
# successfully, so this warns and continues. The warning carries the real
# error text, because "root-owned" is only the usual cause: a full disk or a
# read-only filesystem must not hide behind the same sentence forever.
prune_old_releases() {
  local releases_dir="$1"
  local keep="$2"
  shift 2

  local protected=()
  local protected_path
  local canonical
  for protected_path in "$@"; do
    [ -n "$protected_path" ] || continue
    if canonical="$(deploy_canonical_dir "$protected_path")"; then
      protected+=("$canonical")
    fi
  done

  local undeletable=()
  local reasons=()
  local old_release
  local rm_output

  # shellcheck disable=SC2012  # release dirs are `<short sha>`; we need -t ordering.
  while IFS= read -r old_release; do
    old_release="${old_release%/}"
    canonical="$(deploy_canonical_dir "$old_release")" || canonical=""
    if [ -n "$canonical" ] && deploy_path_is_protected "$canonical" "${protected[@]+"${protected[@]}"}"; then
      echo "  keeping $(basename "$old_release") (live or just-deployed release)"
      continue
    fi
    echo "  removing $(basename "$old_release")"
    if ! rm_output="$(rm -rf -- "$old_release" 2>&1)"; then
      undeletable+=("$old_release")
      reasons+=("${rm_output%%$'\n'*}")
      echo -e "${YELLOW}    could not fully remove: ${rm_output}${NC}"
    elif [ -e "$old_release" ]; then
      # GNU rm can exit 0 having skipped an unreadable subtree.
      undeletable+=("$old_release")
      reasons+=("rm exited 0 but $old_release still exists")
    fi
  done < <(ls -1dt "$releases_dir"/*/ 2>/dev/null | tail -n +"$((keep + 1))")

  if [ ${#undeletable[@]} -eq 0 ]; then
    echo -e "${GREEN}✓ Retained the last $keep releases${NC}"
    return 0
  fi

  local leftovers="${undeletable[*]}"
  deploy_warn "Could not remove ${#undeletable[@]} old release(s) under $releases_dir: $leftovers — first error: ${reasons[0]}. Usually that means root-owned files (Docker auto-creates a missing bind-mount source as root), but read the error above before assuming: a full disk or a read-only filesystem needs a different fix. The deploy itself is fine; disk use is not. One-off cleanup, from an account with sudo: sudo rm -rf $leftovers"

  echo -e "${YELLOW}  To stop this recurring, also hand the releases tree back to the deploy user:${NC}"
  echo -e "${YELLOW}    sudo chown -R \"\$(id -un):\$(id -gn)\" $releases_dir${NC}"
  return 0
}
