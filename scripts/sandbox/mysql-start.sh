#!/usr/bin/env bash
# Sandbox-only: start the runtime built by mysql-setup.sh.
#
# Run it with a supervisor or a process tool. Do NOT `nohup … &` it from a
# one-shot shell: the server dies when that shell returns.
#
#   bash scripts/sandbox/mysql-start.sh
#
# --secure-file-priv must point somewhere that exists, or 5.7 refuses to boot.
set -euo pipefail

BASE="${MYSQL_RUNTIME_DIR:-/home/user/mysql-runtime}"
export LD_LIBRARY_PATH="$BASE/lib"
mkdir -p "$BASE/run" "$BASE/tmp"

exec "$BASE/server/mysqld" --no-defaults \
  --basedir="$BASE/server" --datadir="$BASE/data" \
  --lc-messages-dir="$BASE/server/share/mysql" --tmpdir="$BASE/tmp" \
  --secure-file-priv="$BASE/tmp" \
  --port=3307 --bind-address=0.0.0.0 \
  --socket="$BASE/run/mysqld.sock" --pid-file="$BASE/run/mysqld.pid" \
  --innodb_use_native_aio=0 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
