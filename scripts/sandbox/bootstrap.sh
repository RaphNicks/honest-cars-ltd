#!/usr/bin/env bash
# Sandbox-only: one command to get from a bare checkout to a seeded database.
#
#   bash scripts/sandbox/bootstrap.sh          # deps + runtime + .env + schema + seed
#   bash scripts/sandbox/mysql-start.sh        # then start MySQL (process tool)
#
# Safe to re-run: every step checks before it acts. See scripts/sandbox/README.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

echo "· npm install"
npm install >/dev/null

echo "· MySQL runtime"
bash scripts/sandbox/mysql-setup.sh

if [ ! -f .env ]; then
  echo "· .env from .env.example, pointed at the sandbox server"
  cp .env.example .env
  python3 - <<'PY'
import re
s = open('.env').read()
s = s.replace('DB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=honestcars\nDB_PASSWORD=honestcars\nDB_NAME=honestcars',
              'DB_HOST=127.0.0.1\nDB_PORT=3307\nDB_USER=root\nDB_PASSWORD=\nDB_NAME=honestcars')
s = s.replace('# DB_SOCKET=/var/run/mysqld/mysqld.sock',
              'DB_SOCKET=/home/user/mysql-runtime/run/mysqld.sock')
open('.env', 'w').write(s)
PY
else
  echo "· .env already present, left alone"
fi

if node -e "
const db = require('./src/db');
db.queryOne('SELECT 1 AS ok').then(() => { db.pool.end(); process.exit(0); })
  .catch(() => { try { db.pool.end(); } catch {} process.exit(1); });
" 2>/dev/null; then
  echo "· schema + seed"
  node scripts/db-setup.js
else
  echo "! MySQL is not answering yet — start it, then run: node scripts/db-setup.js"
  echo "    bash scripts/sandbox/mysql-start.sh"
fi

echo "✓ bootstrap done. Start the site with: npm start"
