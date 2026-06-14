#!/usr/bin/env tsx
/**
 * Verify that every table defined in schema.ts has a corresponding
 * CREATE TABLE statement in the drizzle/ migration folder.
 *
 * Run: npx tsx scripts/verify-migrations.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SCHEMA_FILE = resolve(ROOT, "src/lib/server/db/schema.ts");
const MIGRATIONS_DIR = resolve(ROOT, "drizzle");
const PREPARE_DB_FILE = resolve(ROOT, "scripts/prepare-db.ts");

function extractTableNamesFromSchema(source: string): string[] {
	const matches = source.matchAll(
		/export const (\w+)\s*=\s*sqliteTable\s*\(\s*['"]([^'"]+)['"]/g,
	);
	return [...matches].map((m) => m[2]);
}

function extractTableNamesFromMigrations(): Set<string> {
	const tables = new Set<string>();
	try {
		const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
		for (const file of files) {
			const content = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
			const matches = content.matchAll(
				/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi,
			);
			for (const m of matches) {
				tables.add(m[1]);
			}
		}
	} catch {
		// Migrations dir doesn't exist — report all tables as missing
	}
	return tables;
}

function extractRequiredTablesFromPrepareDb(source: string): string[] {
	const match = source.match(/requiredExistingTables\s*=\s*\[([\s\S]*?)\]/);
	if (!match) return [];
	return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const schemaSource = readFileSync(SCHEMA_FILE, "utf8");
const prepareDbSource = readFileSync(PREPARE_DB_FILE, "utf8");

const schemaTables = extractTableNamesFromSchema(schemaSource);
const migrationTables = extractTableNamesFromMigrations();
const requiredTables = new Set(
	extractRequiredTablesFromPrepareDb(prepareDbSource),
);

const missingFromMigrations = schemaTables.filter(
	(t) => !migrationTables.has(t),
);
const missingFromPrepareDb = schemaTables.filter(
	(t) => t !== "__drizzle_migrations" && !requiredTables.has(t),
);

let hasErrors = false;

if (missingFromMigrations.length > 0) {
	console.error(
		"ERROR: Tables defined in schema.ts are missing from drizzle/ migrations:\n" +
			missingFromMigrations.map((t) => `  - ${t}`).join("\n") +
			"\n\nRun: npx drizzle-kit generate",
	);
	hasErrors = true;
}

if (missingFromPrepareDb.length > 0) {
	console.warn(
		"WARNING: Tables not listed in prepare-db.ts requiredExistingTables:\n" +
			missingFromPrepareDb.map((t) => `  - ${t}`).join("\n"),
	);
}

if (hasErrors) {
	process.exit(1);
}

console.log("All schema tables have corresponding migrations.");
