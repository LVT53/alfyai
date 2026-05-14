import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDatabase } from './prepare-db';

const PRE_DEEP_RESEARCH_TAG = '1777140000011_file_production_requests';
const ADOPTION_BASELINE_TAG = '0005_flaky_famine';
const SKILL_NOTES_TAG = '1777140000035_skill_notes';

let tempDir: string | null = null;

function applyMigrationsThroughTag(dbPath: string, tag: string, recordJournal: boolean): void {
	const sqlite = new Database(dbPath);
	sqlite.pragma('foreign_keys = ON');

	if (recordJournal) {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
				id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
				hash text NOT NULL,
				created_at numeric
			)
		`);
	}

	const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
		entries: Array<{ tag: string }>;
	};
	const targetIndex = journal.entries.findIndex((entry) => entry.tag === tag);
	if (targetIndex === -1) {
		throw new Error(`Cannot find migration tag ${tag}`);
	}

	const migrations = readMigrationFiles({ migrationsFolder: './drizzle' }).slice(
		0,
		targetIndex + 1,
	);
	const insertMigration = recordJournal
		? sqlite.prepare(
				'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
			)
		: null;
	sqlite.transaction(() => {
		for (const migration of migrations) {
			for (const statement of migration.sql) {
				if (statement.trim().length === 0) continue;
				sqlite.exec(statement);
			}
			insertMigration?.run(migration.hash, String(migration.folderMillis));
		}
	})();
	sqlite.close();
}

function createDatabaseMigratedThroughTag(dbPath: string, tag: string): void {
	applyMigrationsThroughTag(dbPath, tag, true);
}

function createDatabaseSchemaThroughTagWithoutJournal(dbPath: string, tag: string): void {
	applyMigrationsThroughTag(dbPath, tag, false);
}

function hasTable(sqlite: Database.Database, tableName: string): boolean {
	return Boolean(
		sqlite
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
			.get(tableName),
	);
}

function listColumns(sqlite: Database.Database, tableName: string): string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
		.all()
		.map((row) => String((row as { name: unknown }).name));
}

describe('prepare-db script', () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it('applies pending Deep Research migrations to a journaled pre-Deep-Research database', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'alfyai-prepare-db-'));
		const dbPath = join(tempDir, 'chat.db');
		createDatabaseMigratedThroughTag(dbPath, PRE_DEEP_RESEARCH_TAG);

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(sqlite, 'deep_research_jobs')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_plan_versions')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_timeline_events')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_usage_records')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_sources')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_tasks')).toBe(true);
			expect(listColumns(sqlite, 'conversations')).toEqual(
				expect.arrayContaining(['status', 'sealed_at']),
			);
			expect(listColumns(sqlite, 'deep_research_jobs')).toContain(
				'report_artifact_id',
			);
		} finally {
			sqlite.close();
		}
	});

	it('adopts an existing baseline app database before applying post-baseline Deep Research migrations', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'alfyai-prepare-db-'));
		const dbPath = join(tempDir, 'chat.db');
		createDatabaseSchemaThroughTagWithoutJournal(dbPath, ADOPTION_BASELINE_TAG);

		const beforePrepare = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(beforePrepare, '__drizzle_migrations')).toBe(false);
			expect(hasTable(beforePrepare, 'conversations')).toBe(true);
			expect(hasTable(beforePrepare, 'deep_research_jobs')).toBe(false);
		} finally {
			beforePrepare.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(sqlite, '__drizzle_migrations')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_jobs')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_sources')).toBe(true);
			expect(hasTable(sqlite, 'deep_research_synthesis_claims')).toBe(true);
			expect(listColumns(sqlite, 'deep_research_jobs')).toContain(
				'report_artifact_id',
			);
		} finally {
			sqlite.close();
		}
	});

	it('adopts a no-journal baseline database after an earlier compatibility column repair', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'alfyai-prepare-db-'));
		const dbPath = join(tempDir, 'chat.db');
		createDatabaseSchemaThroughTagWithoutJournal(dbPath, ADOPTION_BASELINE_TAG);

		const repairedBeforeAdoption = new Database(dbPath);
		try {
			repairedBeforeAdoption.exec(
				"ALTER TABLE users ADD COLUMN title_language TEXT NOT NULL DEFAULT 'auto'",
			);
		} finally {
			repairedBeforeAdoption.close();
		}

		prepareDatabase(dbPath);

		const sqlite = new Database(dbPath, { readonly: true });
		try {
			expect(hasTable(sqlite, 'deep_research_jobs')).toBe(true);
			expect(listColumns(sqlite, 'users')).toEqual(
				expect.arrayContaining(['title_language', 'honcho_peer_version']),
			);
		} finally {
			sqlite.close();
		}
	});

	it('rejects a journaled Composer Command V1 schema with a missing required draft column', () => {
		tempDir = mkdtempSync(join(tmpdir(), 'alfyai-prepare-db-'));
		const dbPath = join(tempDir, 'chat.db');
		createDatabaseMigratedThroughTag(dbPath, SKILL_NOTES_TAG);

		const corrupted = new Database(dbPath);
		try {
			corrupted.exec('ALTER TABLE conversation_drafts DROP COLUMN pending_skill_json');
		} finally {
			corrupted.close();
		}

		expect(() => prepareDatabase(dbPath)).toThrow(
			/missing column conversation_drafts\.pending_skill_json/,
		);
	});
});
