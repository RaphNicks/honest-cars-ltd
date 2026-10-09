# Run it on your laptop — start to finish

Everything from an empty machine to the site running in a browser. XAMPP is
assumed for the database (it is the common case, and it means the database is
built by **clicking Import in phpMyAdmin** — no command line). Alternatives are
in Appendix A.

Total time: about ten minutes, most of it downloads.

---

## 1. Install two things

| What | Where | Check it worked |
| --- | --- | --- |
| **Node.js 20 or newer** | [nodejs.org](https://nodejs.org) — take the LTS installer, click through | open a terminal, run `node -v` → `v20.x` or higher |
| **XAMPP** | [apachefriends.org](https://www.apachefriends.org) — the default download is fine | open the XAMPP Control Panel |

A terminal on Windows means **Command Prompt**, **PowerShell**, or **Git Bash** —
any of them works. Every command below is shown for both Windows and
macOS/Linux where they differ.

## 2. Get the code

```bash
git clone https://github.com/RaphNicks/honest-cars-ltd.git
cd honest-cars-ltd
git checkout arena/01a0f7df-honest-cars-ltd
```

That branch is where the work lives; `main` only holds the original spec
document. If you do not have `git`, the same thing without it:

1. Open the branch page:
   <https://github.com/RaphNicks/honest-cars-ltd/tree/arena/01a0f7df-honest-cars-ltd>
2. **Code → Download ZIP** (this exact link downloads the right branch):
   <https://github.com/RaphNicks/honest-cars-ltd/archive/refs/heads/arena/01a0f7df-honest-cars-ltd.zip>
3. Unzip it somewhere you can find again.

Either way you should end up with a folder containing `package.json`, `db/`,
`src/` and `views/`. Open a terminal in that folder — that is where every
remaining command runs.

> **Use `git clone` if you can.** The work is still being added to, and a
> zip cannot be updated — you would have to download it again each time. With a
> clone, staying current is one command:
>
> ```bash
> git pull
> ```
>
> and the same command does nothing when there is nothing new.

## 3. Start MySQL

In the XAMPP Control Panel, click **Start** next to **MySQL**. Apache is not
needed. The panel should report MySQL running on port **3306**.

## 4. Create the database in phpMyAdmin

1. Open <http://localhost/phpmyadmin>
2. Click **New** in the left sidebar
3. *Database name*: `honestcars` — *Collation*: `utf8mb4_unicode_ci` — click **Create**
4. With `honestcars` selected, open the **Import** tab
5. *Choose File* → pick **`db/schema.sql`** from the project folder → **Go**

   You should see *"Import has been successfully finished"*, and the left
   sidebar should fill with **56 tables and 3 views**.
6. **Import** tab again → pick **`db/seed.sql`** → **Go**

   That is the sample data: 79 cars with photos, 16 dealers, 8 blog posts, the
   demo accounts, and the site's settings.

There is nothing else to run. `db/schema.sql` is the complete current database
and `db/seed.sql` is its data, so **`npm run db:setup` is not needed on this
route** — phpMyAdmin has already done it. (Running it anyway is harmless.)

## 5. Tell the site how to reach the database

In the project folder, make a file called `.env` from the template:

```bash
cp .env.example .env        # macOS / Linux / Git Bash
copy .env.example .env      # Windows Command Prompt
Copy-Item .env.example .env # PowerShell
```

Open `.env` in any text editor and make these lines read exactly this — XAMPP's
`root` account has **no password** by default, and its port is 3306:

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=honestcars
DB_ADMIN_USER=
DB_ADMIN_PASSWORD=
```

`DB_PASSWORD=` is deliberately empty — no quotes, no spaces after the `=`, and
no `localhost` (use `127.0.0.1`, which avoids a Windows IPv6 quirk). Everything
else in the file can stay as it is.

## 6. Install and run

```bash
npm install
npm start
```

`npm install` takes a minute or two and puts about 140 MB in `node_modules`. Then:

```
✓ MySQL 5.7.29 · database "honestcars"
  inventory: 63 live cars · 16 verified dealers · 33 certified
✓ honestcarsltd listening on http://0.0.0.0:3000 (development)
```

Open **<http://localhost:3000>**. That is the site.

There is no build step — no bundler, no second process, no `npm run build`. The
server renders pages as they are requested, and every photo, icon, font and
video is already in the folder you cloned (21 MB of them).

To stop it: **Ctrl-C** in the terminal.

## 7. Sign in and look around

The public pages need no account: `/`, `/cars`, a car page, `/services`,
`/shop`, `/hire`, `/blog`, `/how-it-works`, `/find-my-car`.

**Signing in is by phone number, not a password.** In development the one-time
code is printed in the terminal *and* shown on screen, so you never need a real
phone. Use one of the seeded numbers:

| Number | Who | Where it lands |
| --- | --- | --- |
| `+2348000000001` | Admin | `/admin` — asks for a second factor, see below |
| `+2348000000002` | Ops desk | `/admin` |
| `+2348000000003` | Field inspector | `/admin` |
| `+2348000000004` | Finance | `/admin` — second factor |
| `+2348000000006` | A dealer | `/dealer` |
| anything else | A new customer | `/account` |

To sign in: go to <http://localhost:3000/login>, enter the number, press the
button, and type the code it shows you.

**Admin and finance also ask for a 6-digit code from an authenticator app**
(this is PRD §12.2). Add the seeded secret to Google Authenticator, Authy, 1Password
or any TOTP app — *enter setup key manually*:

- admin — `JBSWY3DPEHPK3PXP`
- finance — `KRSXG5CTMVRXEZLU`

Every other role signs in with the OTP alone. If a code is rejected, wait for
the next 30-second window; a used code is refused for its step.

Payments, SMS and email are deliberately unconfigured, because there are no
provider keys in a test install. Bank transfer is the working payment method,
messages are printed to the terminal, and anything that could not be sent is
recorded as **`skipped`** at `/admin/payments` — never reported as sent when it
was not.

## 8. Everyday commands

```bash
npm start             # run it (Ctrl-C to stop)
npm run dev           # run it, restarting automatically when files change
npm test              # the whole suite, ~500 tests, about 40 seconds
npm run lint          # front-end lint: the type scale and event names
npm run db:seed       # put the sample cars back the way they were
```

Nothing else is required. `npm run build:static` pre-renders the stable pages
into `dist/`, which makes a production site fast; locally it is unnecessary,
and deleting `dist/` at any time is safe.

## 9. Staying up to date

If you cloned (not zipped), picking up new work is:

```bash
git pull
npm install     # only needed when package.json changed — harmless otherwise
```

**Then restart the server: Ctrl-C, then `npm start` again.** That step is not a
formality — the running process holds the old code in memory, and Node re-reads
the *templates* from disk on every request but not the modules. Restarting is
what makes a pull take effect, and the server now says so itself: at boot it
prints how many cities the picker holds, and if the code changes while it is
running it warns you in the terminal.

Four things are worth knowing:

- **A pull never touches your database.** The schema and sample data are files in
  the repository, not state on your machine, and `.env` is not tracked, so your
  database settings survive every pull.
- **`npm run db:setup` is the right command after a pull**, and it is safe to run
  on a database you built in phpMyAdmin. It compares your database against
  `db/schema.sql`: if they match, it records the migrations as applied without
  executing anything — because a database built from `schema.sql` already
  contains their effect, and *running* them would rewind columns through the
  intermediate shapes they pass through. If they do not match, it stops and
  tells you exactly what is missing, rather than corrupting anything.
- **If it refuses**, your database came from an older `schema.sql`. On a test
  database, rebuild it — drop `honestcars` in phpMyAdmin and follow step 4
  again. Your `.env` and the code are unaffected.
- **`dist/` is optional, and the server will not serve a stale one.** If you ever
  ran `npm run build:static`, that folder holds pre-rendered pages from that day.
  After a pull they are a revision behind, so the server checks at boot and, when
  the folder is older than the code, renders every page freshly instead and tells
  you to run `npm run build:static`. You can also just delete `dist/` — the site
  is identical without it, only slightly slower. On the browser side, the service
  worker fetches scripts and styles from the network first, so a page can never
  end up running last release's JavaScript.

**If the browser still shows something old after all that**, the service worker
is holding a page: hard-refresh with **Ctrl-Shift-R** (Cmd-Shift-R on a Mac). A
page that looks half-updated — new layout, old behaviour — is that. One reload
with the new worker in place and it stops happening.

## 10. If something goes wrong

| What you see | What it means |
| --- | --- |
| `ECONNREFUSED 127.0.0.1:3306` | MySQL is not running. Start it in the XAMPP panel. |
| `ER_ACCESS_DENIED_ERROR` | The `DB_USER` / `DB_PASSWORD` in `.env` do not match your MySQL. On a default XAMPP that is `root` with an empty password. |
| `ER_BAD_DB_ERROR: Unknown database 'honestcars'` | Step 4 was skipped, or `DB_NAME` in `.env` does not match the database you created. |
| Import fails: *table already exists* | You imported into a database that is not empty. Drop it in phpMyAdmin, create it again, and import `schema.sql` before `seed.sql`. |
| `db:setup` says the database is missing parts of the current schema | It was built from an older `schema.sql`. Drop it in phpMyAdmin and repeat step 4 — the message names what it found missing. |
| `EADDRINUSE: address already in use :::3000` | Something else is on port 3000 — usually another copy of the site. Stop it, or run `PORT=3001 npm start` (`set PORT=3001&& npm start` in Command Prompt). |
| The page loads but with no styling | `npm start` is not the process serving it — check the terminal, and use the URL it prints. |
| A brand-new feature is missing, or a control is half-working (an empty list, a search that finds nothing) | The server was not restarted after the pull, so the page is new and the code behind it is not. Ctrl-C, `npm start`, then Ctrl-Shift-R in the browser. The terminal says `the code changed while this process was running` when this has happened. |
| Sign-in code never appears | It is in the terminal *and* on the page. If not, the server is running with `NODE_ENV=production`; the `.env` template sets `AUTH_SHOW_CODE=true`. |
| `npm install` fails on `sharp` | Node is too old, or the download was interrupted. Check `node -v` is 20+, then delete `node_modules` and run `npm install` again. |

---

# Appendix A — other ways to build the database

Everything below is optional. Step 4 is the recommended route; these are the
alternatives, and all of them leave you at the same place.

### A1. Let the terminal do it (still XAMPP)

Skip step 4 entirely and do step 5 with `DB_USER=root` and a blank password.
Then:

```bash
npm install
npm run db:setup     # creates the database, applies the schema, loads the seed
npm start
```

Safe to run twice: it notices what already exists. `root` can create databases,
so `DB_ADMIN_USER` is not needed with XAMPP. Set it only when `DB_USER` is an
ordinary account that cannot create databases — give it a privileged account:

```
DB_ADMIN_USER=root
DB_ADMIN_PASSWORD=your root password
```

### A2. Docker, if you have it

```bash
docker compose up -d db
cp .env.example .env
```

Then add these two lines to `.env` so the setup script may create the database:

```
DB_ADMIN_USER=root
DB_ADMIN_PASSWORD=honestcars-root
```

and run `npm install && npm run db:setup && npm start`. The container's port,
user and password already match `.env.example`, so nothing else needs editing.
This is a local convenience, not a deployment.

### A3. A MySQL or MariaDB you already run

Set the `DB_*` block in `.env` to match it, then follow A1. If your account
cannot create databases:

```sql
CREATE DATABASE honestcars CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON honestcars.* TO 'youruser'@'localhost';
```

---

# Appendix B — what is in the database files

| File | What it is |
| --- | --- |
| `db/schema.sql` | Every table and view the app uses — the current shape, not a history |
| `db/seed.sql` | The sample data: 79 cars, 555 photos, 16 dealers, 8 posts, demo accounts |
| `db/migrations/` | The path an *existing* database takes to reach this shape, one file per change |

The first two are all a new install needs; the migrations exist so a database
created months ago can be brought forward with `npm run db:setup` or
`npm run db:migrate` instead of being rebuilt. A test fails if a migration ever
creates a table that `schema.sql` does not also create, so the phpMyAdmin route
cannot quietly fall behind.

---

# Appendix C — what you need to change for a real deployment

Nothing in this guide is production. Before this is public it needs: a real
MySQL with a dedicated (non-root) user, `AUTH_PEPPER` set to a random value,
`NODE_ENV=production`, HTTPS, a payment provider's keys, and the rest of the
gaps list in `docs/GAPS.md`.
