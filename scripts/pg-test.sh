#!/usr/bin/env bash
# Start a throwaway local Postgres for `pnpm test:db` (no Docker needed).
# Usage: eval "$(scripts/pg-test.sh)"
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/.pgtest"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT="${PGPORT:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi
if [ ! -d "$DIR/data" ]; then
  mkdir -p "$DIR" && chmod 777 "$DIR"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
fi
if ! "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" start >/dev/null
fi
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='second_look_test'" | grep -q 1 \
  || "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres second_look_test
echo "export DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/second_look_test"
