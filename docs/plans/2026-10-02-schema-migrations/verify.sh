#!/usr/bin/env bash
# Phase 2 verification: plan step 7 cases (a)–(e) and the step 8 index checks.
#
# Rerunnable. Works only on throwaway databases named el_verify_* in the local
# docker Postgres, never on the database in api/.env. Services boot from dist/
# on ports 5101–5107 with RabbitMQ pointed at a closed port (the event bus
# connects in the background, so they boot without consuming the dev stack's
# messages).
#
# Needs: node 22 + pnpm on PATH, the compose Postgres up, `pnpm -C api build`.
# Usage: bash docs/plans/2026-10-02-schema-migrations/verify.sh   (KEEP=1 keeps the DBs)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PG=${PG_CONTAINER:-ethiopialearn-postgres-1}
BASE=${PG_BASE_URL:-postgres://ethiopialearn:ethiopialearn@localhost:55432}
SVCS=(auth course enrollment financial notification outcomes quality)
SCHEMAS="'auth','course','enrollment','financial','notification','outcomes','quality'"
NEW_IDX="'IDX_payments_pending_chapa_created_at','IDX_payments_confirmed_unpaid_payee_id','IDX_sponsorships_bulk_purchase_id','IDX_video_progress_lesson_id','IDX_certificates_learner_id','IDX_dm_messages_thread_id_created_at'"
OLD_IDX="'IDX_2080c94891f76ce625e19874b6','IDX_889f2701163f86b2faf62a6247','IDX_bb53c1a95eb92bf25d7c632058','IDX_2374c15822383f7e5362e27d41','IDX_92d69a37eefba833cfc1dc39c7','IDX_ed9c016a6c1cedddb9ac75fdfe','IDX_1f69fdcbd7ea5f0e52c3230c00'"
LOGS=$(mktemp -d)
FAILS=0

pass() { echo "  PASS $*"; }
fail() { echo "  FAIL $*"; FAILS=$((FAILS + 1)); }
check() { local what=$1; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
eq() { [ "$1" = "$2" ] || { echo "       expected [$2], got [$1]"; return 1; }; }

sql() { docker exec -i "$PG" psql -U ethiopialearn -d "$1" -v ON_ERROR_STOP=1 -Atq -c "$2"; }
dropdb() { docker exec "$PG" dropdb -U ethiopialearn --if-exists --force "$1"; }
# Retries: a template database stays busy for a moment after its last service exits.
createdb() { dropdb "$1" && for _ in 1 2 3 4 5; do docker exec "$PG" createdb -U ethiopialearn "$@" 2>/dev/null && return 0; sleep 1; done; docker exec "$PG" createdb -U ethiopialearn "$@"; }
# A new database with the 7 schemas and pgcrypto, as docker/postgres-init.sql makes them.
fresh() { createdb "$1" && docker exec -i "$PG" psql -U ethiopialearn -d "$1" -v ON_ERROR_STOP=1 -q < docker/postgres-init.sql; }
seed() { DATABASE_URL="$BASE/$1" pnpm -s -C api seed > "$LOGS/seed-$1.log" 2>&1; }
dbcheck() { DATABASE_URL="$BASE/$1" node api/scripts/db-check.mjs > "$LOGS/dbcheck-$1.log" 2>&1; }
cli() { DATABASE_URL="$BASE/$2" pnpm -s -C "api/services/$1" "${@:3}" >> "$LOGS/cli-$2.log" 2>&1; }
count() { sql "$1" "$2"; }
# Tables, columns, indexes and constraints of the 7 schemas (minus migrations).
snapshot() {
  sql "$1" "
    SELECT 'table ' || schemaname || '.' || tablename FROM pg_tables WHERE schemaname IN ($SCHEMAS) AND tablename <> 'migrations'
    UNION ALL SELECT 'index ' || schemaname || '.' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname IN ($SCHEMAS) AND tablename <> 'migrations'
    UNION ALL SELECT 'column ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') FROM information_schema.columns WHERE table_schema IN ($SCHEMAS) AND table_name <> 'migrations'
    UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace::regnamespace::text IN ($SCHEMAS) AND conrelid::regclass::text NOT LIKE '%.migrations'
    ORDER BY 1"
}
# Boots one service against a database: 0 once it listens, 1 if it exits first.
boot() { # service db port
  local log="$LOGS/boot-$1-$2.log"
  (cd api && DATABASE_URL="$BASE/$2" RABBITMQ_URL=amqp://guest:guest@127.0.0.1:1 PORT="$3" exec node "services/$1/dist/main.js") > "$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 90); do
    if grep -q "listening on" "$log"; then kill "$pid"; wait "$pid" 2>/dev/null; return 0; fi
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 1
  done
  kill "$pid"; return 1
}
boot_all() { local port=5101 ok=0; for s in "${SVCS[@]}"; do boot "$s" "$1" $port || { echo "       $s did not boot, see $LOGS/boot-$s-$1.log"; ok=1; }; port=$((port + 1)); done; return $ok; }
migration_rows() { for s in "${SVCS[@]}"; do sql "$1" "SELECT count(*) FROM \"$s\".migrations"; done | tr '\n' ' ' | sed 's/ $//'; }
idx_counts() { count "$1" "SELECT (SELECT count(*) FROM pg_indexes WHERE indexname IN ($NEW_IDX)) || ' new, ' || (SELECT count(*) FROM pg_indexes WHERE indexname IN ($OLD_IDX)) || ' redundant'"; }
invalid_idx() { count "$1" "SELECT count(*) FROM pg_index WHERE NOT indisvalid"; }

echo "logs: $LOGS"

echo "(a) empty database: seed, then boot every service"
A=el_verify_a
fresh $A
check "seed runs on an empty database" seed $A
check "every service boots and migrates" boot_all $A
check "47 tables built" eq "$(count $A "SELECT count(*) FROM pg_tables WHERE schemaname IN ($SCHEMAS) AND tablename <> 'migrations'")" 47
check "baseline + IndexTuning recorded in each schema" eq "$(migration_rows $A)" "2 2 2 2 2 2 2"
check "5 demo accounts seeded" eq "$(count $A "SELECT count(*) FROM auth.users")" 5
check "db:check reports no drift" dbcheck $A

echo "(b) database built by synchronize: baseline records itself, runs no DDL"
# el_verify_a with the index migration reverted and the migrations tables
# dropped has exactly the schema synchronize built (pg_dump-identical).
B=el_verify_b
createdb $B -T $A
for s in "${SVCS[@]}"; do cli "$s" $B migration:revert; sql $B "DROP TABLE \"$s\".migrations"; done
check "starts like production: 0 new, 7 redundant indexes, no migrations tables" eq "$(idx_counts $B)/$(count $B "SELECT count(*) FROM pg_tables WHERE tablename = 'migrations'")" "0 new, 7 redundant/0"
snapshot $B > "$LOGS/b-before.txt"
check "every service boots" boot_all $B
check "baseline + IndexTuning recorded in each schema" eq "$(migration_rows $B)" "2 2 2 2 2 2 2"
snapshot $B > "$LOGS/b-after.txt"
diff "$LOGS/b-before.txt" "$LOGS/b-after.txt" | grep '^[<>]' > "$LOGS/b-diff.txt"
check "the only schema change is the 13 P2-14 index lines" eq "$(grep -c . "$LOGS/b-diff.txt")/$(grep -cE '^[<>] index ' "$LOGS/b-diff.txt")" "13/13"
check "db:check reports no drift" dbcheck $B

echo "(c) half-built schema: boot fails and names the missing table"
C=el_verify_c
createdb $C -T $A
sql $C "DROP TABLE outcomes.migrations; DROP TABLE outcomes.certificates"
if boot outcomes $C 5199; then fail "outcomes refused to boot"; else pass "outcomes refused to boot"; fi
check "error names the missing table" grep -q 'Schema "outcomes" is partially built: 3 of 4 baseline tables exist, missing: certificates' "$LOGS/boot-outcomes-$C.log"
check "nothing recorded or built" eq "$(count $C "SELECT count(*) FROM outcomes.migrations")/$(count $C "SELECT count(*) FROM pg_tables WHERE schemaname = 'outcomes' AND tablename <> 'migrations'")" "0/3"

echo "(d) db:check against an empty database writes nothing"
D=el_verify_d
createdb $D
grep -v 'CREATE EXTENSION' docker/postgres-init.sql | docker exec -i "$PG" psql -U ethiopialearn -d $D -v ON_ERROR_STOP=1 -q
if dbcheck $D; then fail "db:check exits 1 (every table is missing)"; else pass "db:check exits 1 (every table is missing)"; fi
check "it reports the missing tables as drift" grep -q 'CREATE TABLE "outcomes"."certificates"' "$LOGS/dbcheck-$D.log"
check "no table created, migrations included" eq "$(count $D "SELECT count(*) FROM pg_tables WHERE schemaname IN ($SCHEMAS)")" 0
check "no extension installed" eq "$(count $D "SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'")" 0

echo "(e) reverting a baseline is refused without ALLOW_BASELINE_REVERT=1"
cli auth $A migration:revert # IndexTuning
if cli auth $A migration:revert; then fail "second revert (the baseline) refused"; else pass "second revert (the baseline) refused"; fi
check "the refusal names the guard" grep -q 'Refusing to revert the "auth" baseline' "$LOGS/cli-$A.log"
check "auth tables intact, baseline still recorded" eq "$(count $A "SELECT count(*) FROM pg_tables WHERE schemaname = 'auth' AND tablename <> 'migrations'")/$(count $A "SELECT string_agg(left(name, 8), ',') FROM auth.migrations")" "7/Baseline"
cli auth $A migration:run

echo "step 8: index migration on (a), revert and re-run round trip"
check "6 new indexes, 0 redundant, none invalid" eq "$(idx_counts $A)/$(invalid_idx $A)" "6 new, 0 redundant/0"
check "pending-Chapa partial predicate" eq "$(count $A "SELECT indexdef LIKE '%WHERE ((status = ''pending''::financial.payment_status) AND (method = ''chapa''::financial.payment_method))' FROM pg_indexes WHERE indexname = 'IDX_payments_pending_chapa_created_at'")" t
check "confirmed-unpaid partial predicate" eq "$(count $A "SELECT indexdef LIKE '%WHERE ((status = ''confirmed''::financial.payment_status) AND (payout_id IS NULL))' FROM pg_indexes WHERE indexname = 'IDX_payments_confirmed_unpaid_payee_id'")" t
for s in "${SVCS[@]}"; do cli "$s" $A migration:revert; done
check "after revert: 0 new, 7 redundant" eq "$(idx_counts $A)" "0 new, 7 redundant"
for s in "${SVCS[@]}"; do cli "$s" $A migration:run; done
check "after re-run: 6 new, 0 redundant, none invalid" eq "$(idx_counts $A)/$(invalid_idx $A)" "6 new, 0 redundant/0"
check "db:check reports no drift" dbcheck $A

echo "db:check exit codes"
sql $A "ALTER TABLE outcomes.assessments ADD COLUMN drift_probe integer"
if dbcheck $A; then fail "exits 1 on drift"; else pass "exits 1 on drift"; fi
check "names the drifted column" grep -q 'drift_probe' "$LOGS/dbcheck-$A.log"
sql $A "ALTER TABLE outcomes.assessments DROP COLUMN drift_probe"
check "exits 0 once fixed" dbcheck $A

[ "${KEEP:-0}" = 1 ] || for db in $A $B $C $D; do dropdb $db; done
echo
if [ $FAILS -eq 0 ]; then echo "ALL PASSED"; else echo "$FAILS FAILED (logs: $LOGS)"; exit 1; fi
