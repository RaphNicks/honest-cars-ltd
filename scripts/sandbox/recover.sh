#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bring a wiped sandbox back to "the site is running" in one command.
#
# A fresh provision resets this checkout to main with the branch's files present
# but untracked, and removes node_modules, .env and the MySQL runtime. This does
# the parts that can be done in a script; the two servers are long-lived and are
# started with the process tool, which the last lines print.
#
#   bash scripts/sandbox/recover.sh
# ---------------------------------------------------------------------------
set -euo pipefail

BRANCH="${BRANCH:-arena/01a0f7df-honest-cars-ltd}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1m· %s\033[0m\n' "$1"; }

say "fetching $BRANCH"
git fetch origin "$BRANCH"
git reset --mixed FETCH_HEAD
echo "  HEAD: $(git log --oneline -1)"

say "bootstrap (npm install, MySQL runtime, .env)"
bash scripts/sandbox/bootstrap.sh

cat <<'NEXT'

The runtime is ready. Two long-lived processes are started with the process
tool, not here (a background process dies with the shell that spawned it):

  1. MySQL:  bash scripts/sandbox/mysql-start.sh
  2. then:   npm run db:seed && npm run build:static
  3. site:   npm start

NEXT
