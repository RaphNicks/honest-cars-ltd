#!/usr/bin/env bash
# Sandbox-only: build the MySQL 5.7.29 runtime this project talks to when the
# box has no system MySQL. Idempotent — safe to re-run.
#
#   bash scripts/sandbox/mysql-setup.sh
#   bash scripts/sandbox/mysql-start.sh   # start it (use a supervisor/process tool)
#
# See scripts/sandbox/README.md. Normal local setups do not need this.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${MYSQL_RUNTIME_DIR:-/home/user/mysql-runtime}"
SERVER="$BASE/server"
RUN="$BASE/run"
DATA="$BASE/data"
TMP="$BASE/tmp"
LIB="$BASE/lib"

mkdir -p "$BASE" "$RUN" "$TMP" "$LIB"

# 1. Binaries. The npm package ships a flat mysqld (no bin/), which is what we
#    want. --no-save: sandbox convenience, never a project dependency.
if [ ! -x "$SERVER/mysqld" ]; then
  echo "· unpacking mysqld 5.7.29"
  (cd "$REPO" && npm install --no-save mysql-server-5.7-lin-x64 >/dev/null 2>&1)
  rm -rf "$SERVER"
  cp -a "$REPO/node_modules/mysql-server-5.7-lin-x64/server" "$SERVER"
  chmod +x "$SERVER/mysqld"
fi

# 2. libaio shim. This image ships no libaio and 5.7 links against it. Every
#    call returns ENOSYS — the same answer a kernel without AIO gives — so
#    InnoDB warns once and falls back to simulated I/O. Both version tags must
#    exist and io_setup must carry the @@0.4 default, or the loader refuses to
#    resolve it ("undefined symbol: io_setup, version LIBAIO_0.4").
if [ ! -f "$LIB/libaio.so.1" ]; then
  echo "· building the libaio shim"
  cat > "$LIB/aio_stub.c" <<'C'
#include <errno.h>
#define FAIL() do { errno = ENOSYS; return -1; } while (0)
int io_setup_01(unsigned n, void **c) { (void)n; (void)c; FAIL(); }
int io_setup_04(unsigned n, void **c) { (void)n; (void)c; FAIL(); }
int io_destroy_01(void *c) { (void)c; FAIL(); }
int io_destroy_04(void *c) { (void)c; FAIL(); }
int io_submit_01(void *c, long n, void **i) { (void)c; (void)n; (void)i; FAIL(); }
int io_submit_04(void *c, long n, void **i) { (void)c; (void)n; (void)i; FAIL(); }
int io_cancel_01(void *c, void *i, void *e) { (void)c; (void)i; (void)e; FAIL(); }
int io_cancel_04(void *c, void *i, void *e) { (void)c; (void)i; (void)e; FAIL(); }
int io_getevents_01(void *c, long mn, long mx, void *e, void *t) { (void)c; (void)mn; (void)mx; (void)e; (void)t; FAIL(); }
int io_getevents_04(void *c, long mn, long mx, void *e, void *t) { (void)c; (void)mn; (void)mx; (void)e; (void)t; FAIL(); }
__asm__(".symver io_setup_01,io_setup@LIBAIO_0.1");
__asm__(".symver io_setup_04,io_setup@@LIBAIO_0.4");
__asm__(".symver io_destroy_01,io_destroy@LIBAIO_0.1");
__asm__(".symver io_destroy_04,io_destroy@@LIBAIO_0.4");
__asm__(".symver io_submit_01,io_submit@LIBAIO_0.1");
__asm__(".symver io_submit_04,io_submit@@LIBAIO_0.4");
__asm__(".symver io_cancel_01,io_cancel@LIBAIO_0.1");
__asm__(".symver io_cancel_04,io_cancel@@LIBAIO_0.4");
__asm__(".symver io_getevents_01,io_getevents@LIBAIO_0.1");
__asm__(".symver io_getevents_04,io_getevents@@LIBAIO_0.4");
C
  cat > "$LIB/aio.map" <<'M'
LIBAIO_0.1 { };
LIBAIO_0.4 { } LIBAIO_0.1;
M
  gcc -shared -fPIC -O2 -o "$LIB/libaio.so.1" "$LIB/aio_stub.c" -Wl,--version-script="$LIB/aio.map"
  ln -sf libaio.so.1 "$LIB/libaio.so"
fi

# 3. Data directory.
if [ ! -d "$DATA/mysql" ]; then
  echo "· initialising the data directory (this takes a moment)"
  LD_LIBRARY_PATH="$LIB" "$SERVER/mysqld" --no-defaults --initialize-insecure \
    --basedir="$SERVER" --datadir="$DATA" \
    --lc-messages-dir="$SERVER/share/mysql" --tmpdir="$TMP"
fi

echo "✓ MySQL runtime ready — $BASE"
