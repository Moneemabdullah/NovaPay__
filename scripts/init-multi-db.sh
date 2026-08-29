#!/bin/bash
# Runs once, automatically, on first Postgres container start (via
# docker-entrypoint-initdb.d). Creates one database PER SERVICE and loads
# that service's schema.sql into it — this is what enforces "no shared
# databases between services" at the infra level, not just by convention.
set -e

IFS=',' read -ra DBS <<< "$POSTGRES_MULTIPLE_DATABASES"
for db in "${DBS[@]}"; do
  echo "Creating database: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE $db;
    GRANT ALL PRIVILEGES ON DATABASE $db TO $POSTGRES_USER;
EOSQL

  schema_file="/schemas/${db}.sql"
  if [ -f "$schema_file" ]; then
    echo "Loading schema for $db from $schema_file"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" \
      -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" \
      -f "$schema_file"
  fi
done
