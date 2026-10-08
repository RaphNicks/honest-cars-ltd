# Run it on your laptop

Three commands, once the two prerequisites are met:

```bash
npm install
npm run db:setup     # creates the database, the tables and ~79 sample cars
npm start            # → http://localhost:3000
```

That is the whole thing. Read on for the prerequisites, and for what to look at
once it is up.

---

## What you need

| | |
| --- | --- |
| **Node.js 20 or newer** | check with `node -v`. Get it from [nodejs.org](https://nodejs.org) or `brew install node`. |
| **MySQL, or Docker to run one** | pick either option below — it is the only choice that matters. |

Nothing else. There is no build step, no bundler, no second process: the server
renders pages on demand, and the photos, icons, fonts and videos are already in
the repository (about 60 MB of them, hence the clone size).

## Which MySQL?

### Option A — Docker (fewest steps, nothing to install but Docker)

```bash
docker compose up -d db
cp .env.example .env
```

Then add these two lines to `.env` — they let `npm run db:setup` create the
database:

```
DB_ADMIN_USER=root
DB_ADMIN_PASSWORD=honestcars-root
```

Everything else in `.env.example` already points at the container
(`127.0.0.1:3306`, user `honestcars`). Continue with the three commands above.

### Option B — MySQL you already have

```bash
cp .env.example .env
```

Edit the `DB_*` block in `.env` to match your server. If you sign in as `root`,
set `DB_USER=root` and `DB_PASSWORD=your root password` and leave
`DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` blank — `root` can create the database
itself.

If your `DB_USER` is an ordinary account, the setup script needs a privileged
one as well: set `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`, or grant your account
the right first:

```sql
CREATE DATABASE honestcars CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON honestcars.* TO 'youruser'@'localhost';
```

## Getting the code

```bash
git clone https://github.com/RaphNicks/honest-cars-ltd.git
cd honest-cars-ltd
git checkout arena/01a0f7df-honest-cars-ltd
```

The work lives on that branch until PR #1 is signed off; `main` is only the
original spec document. `.env` is not in the repository — the template is.

---

## What to look at

The public site needs no sign-in: `/`, `/cars`, a car page, `/services`,
`/shop`, `/hire`, `/blog`, `/how-it-works`, `/find-my-car`.

**Signing in is by phone, not password.** In development the one-time code is
printed in the terminal *and* returned on screen (`AUTH_SHOW_CODE=true`), so you
never need a phone. Use one of the seeded numbers:

| Number | Who | Lands on |
| --- | --- | --- |
| `+2348000000001` | Admin | `/admin` — then a second factor, see below |
| `+2348000000002` | Ops desk | `/admin` |
| `+2348000000003` | Field inspector | `/admin` |
| `+2348000000004` | Finance | `/admin` — second factor |
| `+2348000000006` | A dealer | `/dealer` |
| any other number | New customer | `/account` |

**The admin and finance roles carry a second factor** (PRD §12.2). Add the
seeded secret to any authenticator app — `JBSWY3DPEHPK3PXP` for admin,
`KRSXG5CTMVRXEZLU` for finance — or use a seeded recovery code. This only
applies to those two roles; everyone else signs in with the OTP alone.

Payments, SMS and email are deliberately unconfigured: with no provider keys the
site takes bank transfers, prints messages to the terminal, and records anything
it could not send as `skipped` at `/admin/payments`. Nothing is ever reported as
sent when it was not.

## Useful commands

```bash
npm test             # the whole suite (~500 tests, ~40s)
npm run lint         # front-end lint: type scale, event names
npm run build:static # optional: pre-render the stable pages into dist/
npm run db:seed      # put the sample cars back the way they were
npm start            # run in the foreground; Ctrl-C stops it
npm run dev          # same, but restarts on file changes
```

`dist/` is what keeps the stable pages instant in production. **You do not need
it locally** — without it every page is rendered on the spot, which is what you
want while you are changing templates anyway.

## Starting over

```bash
npm run db:seed              # reset the sample data
docker compose down -v       # Option A: throw the database away entirely
```

Deleting `dist/` is always safe; it is generated. `public/og/` holds generated
share cards and is safe to delete too — they are re-rendered as they are
requested.

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| `ECONNREFUSED 127.0.0.1:3306` | MySQL is not running. `docker compose up -d db`, or start your own. |
| `ER_ACCESS_DENIED_ERROR` | The `DB_*` values in `.env` do not match your server. |
| `ER_DBACCESS_DENIED_ERROR` during `db:setup` | Your user cannot create databases — see Option B. |
| `EADDRINUSE :3000` | Something else is on 3000. `PORT=3001 npm start`. |
| Ports 3000 or 3306 already taken | Change them: `PORT` in `.env`, and the left-hand side of the port mapping in `docker-compose.yml` (then `DB_PORT` to match). |
| Sign-in code never arrives | It is in the terminal, and on screen in development. Check `AUTH_SHOW_CODE=true` in `.env`. |

Log files from the sandbox this was built in live in `docs/HANDOFF.md`, along
with everything else worth knowing about how the site is put together.
