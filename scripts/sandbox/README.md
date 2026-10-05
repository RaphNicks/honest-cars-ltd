# Sandbox helpers

These three scripts exist for **sandboxed or headless boxes with no system
MySQL** — the kind of environment this project was built and tested in. They
are not part of the site and nothing in `src/` depends on them.

A normal local setup needs none of this: install MySQL yourself, point
`DB_*` in `.env` at it, and run `npm run db:setup`.

| Script | What it does |
| --- | --- |
| `bootstrap.sh` | Every reboot step in one go: `npm install`, build the MySQL runtime, write `.env` if missing, load the schema and seed. |
| `mysql-setup.sh` | Unpacks the bundled MySQL 5.7 build, builds the `libaio` shim it links against, and initialises the data directory. Idempotent. |
| `mysql-start.sh` | Starts that server on port 3307. Run it with a supervisor (or a process tool) — a backgrounded server dies with the shell. |

The bundled server comes from the `mysql-server-5.7-lin-x64` npm package and is
installed with `--no-save`: it is a sandbox convenience, deliberately not a
project dependency.
