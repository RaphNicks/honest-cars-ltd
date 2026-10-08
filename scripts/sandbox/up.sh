#!/usr/bin/env bash
#
# Bring the sandbox stack back up after a restore.
#
#   bash scripts/sandbox/up.sh
#
# The sandbox resets between turns: git HEAD goes back to the branch's base
# commit, node_modules, dist, .env, public/og and the MySQL runtime all vanish,
# every process dies, and uploaded files are gone for good. The committed work
# is fetched back from origin and everything derived is rebuilt here.
#
# Idempotent: run it on a warm sandbox and it reports what it skipped. It
# deliberately does NOT start the site — the preview is attached to a process
# started with the process tool, so start it the usual way afterwards:
#
#   AUTH_SHOW_CODE=1 npm start
#
set -euo pipefail

BRANCH='arena/01a0f7df-honest-cars-ltd'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say() { printf '  %s\n' "$1"; }
ok() { printf '✓ %s\n' "$1"; }

# ---------------------------------------------------------------------------
# 1. The committed work. `reset --mixed` moves the branch and the index without
#    touching the working tree, so nothing uncommitted is destroyed. Never use
#    `git checkout -- .` here: it would throw away work that is not committed.
# ---------------------------------------------------------------------------
say "fetching $BRANCH"
git fetch -q origin "$BRANCH"
git reset -q --mixed FETCH_HEAD
ok "at $(git log --oneline -1)"

# ---------------------------------------------------------------------------
# 2. Dependencies. bootstrap.sh installs from package-lock.json, writes .env
#    from .env.example, and prepares the MySQL tarball.
# ---------------------------------------------------------------------------
if [ -d node_modules ] && [ -f .env ]; then
  say "dependencies present — skipping bootstrap"
else
  say "bootstrapping (npm ci + .env + MySQL runtime)"
  bash scripts/sandbox/bootstrap.sh >/dev/null 2>&1 || {
    echo "✗ bootstrap failed — run it directly to see why:" >&2
    echo "    bash scripts/sandbox/bootstrap.sh" >&2
    exit 1
  }
  ok "dependencies installed"
fi

# ---------------------------------------------------------------------------
# 3. MySQL. Started detached, because it has to outlive this script.
# ---------------------------------------------------------------------------
if ss -ltn 2>/dev/null | grep -q ':3307'; then
  say "MySQL already listening on 3307"
else
  say "starting MySQL"
  nohup bash scripts/sandbox/mysql-start.sh >/tmp/hc-mysql.log 2>&1 &
  for _ in $(seq 1 40); do
    ss -ltn 2>/dev/null | grep -q ':3307' && break
    sleep 0.5
  done
  ss -ltn 2>/dev/null | grep -q ':3307' || {
    echo "✗ MySQL did not come up — see /tmp/hc-mysql.log" >&2
    exit 1
  }
  ok "MySQL listening on 3307"
fi

# ---------------------------------------------------------------------------
# 4. Schema and seed. db-setup.js applies only the migrations that are missing
#    and seeds only when the tables are empty, so this is safe to repeat.
# ---------------------------------------------------------------------------
say "applying migrations and seed"
node scripts/db-setup.js 2>&1 | tail -2 | sed 's/^/  /'

# ---------------------------------------------------------------------------
# 5. Icons and the static pages. `public/img/logo.png` is derived from
#    assets/brand/logo.png and is the switch every template reads, so it has to
#    exist before the build renders a page — otherwise the header falls back to
#    its inline shield and the build would bake that fallback into dist.
# ---------------------------------------------------------------------------
if [ -f public/img/logo.png ]; then
  say "brand mark present"
else
  say "cutting the brand mark from assets/brand/logo.png"
  node scripts/generate-icons.js | grep '^✓' | sed 's/^/  /'
fi

say "building the static pages"
npm run build:static 2>&1 | tail -1 | sed 's/^/  /'

# ---------------------------------------------------------------------------
# 6. Offer cards are gitignored and generated. Clearing them drops any card
#    whose layout predates the current code; the default card is then rendered
#    again here rather than left to the next boot, because the server may
#    already be running and its pages point at that file.
# ---------------------------------------------------------------------------
rm -rf public/og
node -e "require('./src/services/og').ensureDefaultCard().then(function (p) { console.log('  · offer card', p); })" \
  || say "offer card will be rendered at boot"

ok "stack is up. Start the site with:"
echo
echo "    AUTH_SHOW_CODE=1 npm start"
echo
