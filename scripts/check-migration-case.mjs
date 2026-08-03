#!/usr/bin/env node
/**
 * Guards against a migration that only works on a case-insensitive MySQL.
 *
 * MySQL compares table names case-insensitively when `lower_case_table_names`
 * is 1 or 2 — the default on macOS and Windows — and case-sensitively when it
 * is 0, the default on Linux. Prisma sometimes emits `ALTER TABLE \`host\`` for
 * a table it created as `Host`, which runs fine on the laptop that generated it
 * and fails on the Linux server with "Table 'db.host' doesn't exist", leaving a
 * failed migration and a P3009 that blocks every later one.
 *
 * That is exactly how 20260731174638_add_agent_devices broke production, so the
 * check runs in CI: every table identifier in every migration must match, byte
 * for byte, the name the table was actually created with.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "apps/api/prisma/migrations");
const schemaPath = join(repoRoot, "apps/api/prisma/schema.prisma");

/** Strip `-- line` comments and `/* block *\/` comments so they cannot match. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Backticked names in table position. `REFERENCES` is included; column lists are not. */
const TABLE_REF =
  /\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|RENAME\s+TABLE|TRUNCATE(?:\s+TABLE)?|INSERT\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|REFERENCES|JOIN|FROM)\s+`([^`]+)`/gi;

const CREATE_TABLE = /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`([^`]+)`/gi;

function migrationDirs() {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Canonical table names: every model in the schema (honouring `@@map`) plus
 * every table any migration has created. The migrations matter because relation
 * tables and since-dropped tables never appear in the schema.
 */
function canonicalNames(files) {
  const names = new Set();

  if (existsSync(schemaPath)) {
    const schema = readFileSync(schemaPath, "utf8");
    for (const [, model] of schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) names.add(model);
    for (const [, mapped] of schema.matchAll(/@@map\(\s*"([^"]+)"\s*\)/g)) names.add(mapped);
  }

  for (const { sql } of files) {
    for (const [, table] of sql.matchAll(CREATE_TABLE)) names.add(table);
  }

  return names;
}

const files = migrationDirs()
  .map((name) => ({ name, path: join(migrationsDir, name, "migration.sql") }))
  .filter((file) => existsSync(file.path))
  .map((file) => ({ ...file, sql: stripComments(readFileSync(file.path, "utf8")) }));

if (files.length === 0) {
  console.log("check-migration-case: no migrations found, nothing to check.");
  process.exit(0);
}

const canonical = canonicalNames(files);
const byLowercase = new Map();
for (const name of canonical) {
  const key = name.toLowerCase();
  // A schema that genuinely holds `Host` and `host` cannot exist on Linux
  // anyway, so first one wins rather than trying to disambiguate.
  if (!byLowercase.has(key)) byLowercase.set(key, name);
}

const problems = [];

for (const file of files) {
  const lines = file.sql.split("\n");
  for (const [, , referenced] of file.sql.matchAll(TABLE_REF)) {
    if (canonical.has(referenced)) continue;
    const expected = byLowercase.get(referenced.toLowerCase());
    if (!expected) continue; // Unknown table: not a casing problem, leave it alone.
    const line = lines.findIndex((text) => text.includes(`\`${referenced}\``)) + 1;
    problems.push({ migration: file.name, line, referenced, expected });
  }
}

if (problems.length > 0) {
  console.error("Migrations reference tables with the wrong case.\n");
  console.error(
    "These run on a case-insensitive MySQL (macOS/Windows default) and fail on\n" +
      "Linux, where lower_case_table_names is 0. A failed migration then blocks\n" +
      "every later one with P3009.\n"
  );
  for (const problem of problems) {
    console.error(
      `  apps/api/prisma/migrations/${problem.migration}/migration.sql:${problem.line}` +
        `  \`${problem.referenced}\` should be \`${problem.expected}\``
    );
  }
  console.error("\nEdit the migration SQL to match the created table name exactly.");
  process.exit(1);
}

console.log(
  `check-migration-case: ${files.length} migrations reference ${canonical.size} tables, all correctly cased.`
);
