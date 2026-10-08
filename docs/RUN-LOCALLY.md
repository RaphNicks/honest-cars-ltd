# Run it on your laptop

Once you have Node 20+ and a MySQL to talk to — with **XAMPP that is Option A
below: the whole database, built by clicking Import in phpMyAdmin**, no command
line involved — it is:

```bash
npm install
npm start            # → http://localhost:3000
```

If you would rather the terminal built the database too, add `npm run db:setup`
in the middle. Both routes are verified on a fresh database; Option A is
probably the one you want.

---

## What you need

| | |
| --- | --- |
| **Node.js 20 or newer** | check with `node -v`. Get it from [nodejs.org](https://nodejs.org) or `brew install node`. |
| **MySQL** | XAMPP (Option A), a container (Option C), or one you already run (Option D). This is the only choice that matters. |

Nothing else. There is no build step, no bundler, no second process: the server
renders pages on demand, and the photos, icons, fonts and videos are already in
the repository (about 60 MB of them, hence the clone size).

## Which MySQL?

### Option A — XAMPP, set up in phpMyAdmin (no command line)

The whole database can be built from phpMyAdmin's **Import** tab. Two files in
`db/` are all it takes: `schema.sql` is every table and view the app uses, and
`seed.sql` is the sample data. There is no migration step — `schema.sql` already
describes the current database, and a test keeps it that way.

1. **Start MySQL.** In the XAMPP Control Panel, click **Start** next to MySQL.
   Apache is not needed.
2. **Open phpMyAdmin** — <http://localhost/phpmyadmin>.
3. **Create the database.** Click **New** in the left sidebar → *Database name*:
   `honestcars` → *Collation*: `utf8mb4_unicode_ci` → **Create**.
4. **Import the schema.** With `honestcars` selected, open the **Import** tab →
   *Choose File* → `db/schema.sql` → **Go**. You should see *"Import has been
   successfully finished"*, and 56 tables plus 3 views listed on the left.
5. **Import the data.** **Import** tab again → `db/seed.sql` → **Go**. The
   listings, photos, dealers, blog posts and demo accounts are now in.
6. **Point the site at it.** In the project folder:

   ```bash
   cp .env.example .env
   ```

   then make these lines in `.env` read exactly this (XAMPP's `root` has no
   password by default, and 3306 is XAMPP's port):

   ```
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=honestcars
   DB_ADMIN_USER=
   DB_ADMIN_PASSWORD=
   ```

   Nothing else needs changing. (`DB_PASSWORD=` really is blank — do not add
   quotes or spaces.)
7. **Run it.**

   ```bash
   npm install
   npm start        # → http://localhost:3000
   ```

   `npm run db:setup` is **not** needed on this path — phpMyAdmin has already
   done its job. Running it anyway is harmless: it notices the tables exist.

**Two notes for XAMPP specifically.**

- XAMPP ships **MariaDB**, not MySQL — that is supported, and the code says so
  where it matters (`src/db/pool.js`, `src/db/shape.js`). Every JSON function the
  project uses (`JSON_ARRAY`, `JSON_EXTRACT`, `JSON_OBJECT`, `JSON_UNQUOTE`)
  exists in MariaDB 10.2+, and XAMPP ships 10.4.
- phpMyAdmin's default upload limit is 2 MB per import. The two files are 80 kB
  and 380 kB, so nothing needs raising. If a future import ever does, it is
  `upload_max_filesize` in `php.ini`.

### Option B — let the terminal do it (`npm run db:setup`)

If you would rather not import by hand — including on XAMPP — this does all of
the above and is safe to run twice:

```bash
cp .env.example .env     # DB_USER=root, DB_PASSWORD= (blank) for XAMPP
npm install
npm run db:setup         # creates the database, applies the schema, loads the seed
npm start
```

With XAMPP's default `root` account that is the entire setup, because `root`
may create databases. Set `DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` only when
`DB_USER` is an ordinary account that cannot.

### Option C — Docker (fewest steps, nothing to install but Docker)

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
(`127.0.0.1:3306`, user `honestcars`), so `npm run db:setup` needs no other
edit. Continue with the three commands above.

### Option D — MySQL you already have

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
| `ER_DBACCESS_DENIED_ERROR` during `db:setup` | Your user cannot create databases — see Option D, or set `DB_ADMIN_USER`. |
| `ER_BAD_DB_ERROR: Unknown database 'honestcars'` | The database name in `.env` does not exist in phpMyAdmin. Create it and import `db/schema.sql`, or run `npm run db:setup`. |
| Import in phpMyAdmin says a table already exists | You are importing into a database that is not empty. Drop it, create it again, and import `schema.sql` before `seed.sql`. |
| `EADDRINUSE :3000` | Something else is on 3000. `PORT=3001 npm start`. |
| Ports 3000 or 3306 already taken | Change them: `PORT` in `.env`, and the left-hand side of the port mapping in `docker-compose.yml` (then `DB_PORT` to match). |
| Sign-in code never arrives | It is in the terminal, and on screen in development. Check `AUTH_SHOW_CODE=true` in `.env`. |

Log files from the sandbox this was built in live in `docs/HANDOFF.md`, along
with everything else worth knowing about how the site is put together.
