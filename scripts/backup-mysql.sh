#!/usr/bin/env bash
#
# Dump the Onshell.cloud MySQL database to ./backups (Linux/macOS counterpart of
# backup-mysql.ps1, which only runs on Windows).
#
# Connection details are parsed from DATABASE_URL so there is one source of truth:
#   mysql://user:password@host:port/database
#
# Usage:
#   set -a && source .env && set +a
#   ./scripts/backup-mysql.sh [output-dir]
#
set -euo pipefail

OUTPUT_DIR="${1:-backups}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required. Try: set -a && source .env && set +a" >&2
  exit 1
fi

# Parse the URL in Node rather than with a regex: passwords are percent-encoded
# and routinely contain :, @, and / — characters a naive split would break on.
eval "$(
  node -e '
    const url = new URL(process.env.DATABASE_URL);
    const q = (value) => `'"'"'${String(value).replace(/'"'"'/g, `'"'"'\\'"'"''"'"'`)}'"'"'`;
    process.stdout.write(
      `DB_USER=${q(decodeURIComponent(url.username))}\n` +
      `DB_PASS=${q(decodeURIComponent(url.password))}\n` +
      `DB_HOST=${q(url.hostname)}\n` +
      `DB_PORT=${q(url.port || "3306")}\n` +
      `DB_NAME=${q(url.pathname.replace(/^\//, ""))}\n`
    );
  '
)"

if [[ -z "${DB_NAME}" ]]; then
  echo "DATABASE_URL has no database name." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
OUTPUT_FILE="${OUTPUT_DIR}/onshell-cloud-$(date +%Y%m%d-%H%M%S).sql"

# MYSQL_PWD keeps the password out of the process list, where `ps` would expose it
# to every user on the box — unlike --password= on the command line.
MYSQL_PWD="${DB_PASS}" mysqldump \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --user="${DB_USER}" \
  --single-transaction \
  --routines \
  --triggers \
  "${DB_NAME}" > "${OUTPUT_FILE}"

# mysqldump can exit non-zero after the shell has already created the file, so
# only report success once we have a non-empty dump.
if [[ ! -s "${OUTPUT_FILE}" ]]; then
  echo "Backup failed: ${OUTPUT_FILE} is empty." >&2
  rm -f "${OUTPUT_FILE}"
  exit 1
fi

echo "Backup written to ${OUTPUT_FILE} ($(du -h "${OUTPUT_FILE}" | cut -f1))"
