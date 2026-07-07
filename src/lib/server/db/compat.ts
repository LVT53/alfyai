import { sqlite } from "./index";

type TableInfoRow = {
	name: string;
};

let ensureRuntimeSchemaCompatibilityPromise: Promise<void> | null = null;
let runtimeSchemaCompatibilityEnsured = false;

function hasTable(tableName: string): boolean {
	return Boolean(
		sqlite
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			)
			.get(tableName),
	);
}

function hasColumn(tableName: string, columnName: string): boolean {
	return sqlite
		.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
		.all()
		.some((row) => String((row as TableInfoRow).name) === columnName);
}

function ensureUsersUiLanguageColumn(): void {
	if (!hasTable("users") || hasColumn("users", "ui_language")) {
		return;
	}

	sqlite.exec(
		"ALTER TABLE users ADD COLUMN ui_language text DEFAULT 'en' NOT NULL",
	);
	console.warn("[DB_COMPAT] Added missing users.ui_language column at runtime");
}

export async function ensureRuntimeSchemaCompatibility(): Promise<void> {
	if (runtimeSchemaCompatibilityEnsured) {
		return;
	}

	if (!ensureRuntimeSchemaCompatibilityPromise) {
		ensureRuntimeSchemaCompatibilityPromise = Promise.resolve().then(() => {
			ensureUsersUiLanguageColumn();
			runtimeSchemaCompatibilityEnsured = true;
		});
	}

	try {
		await ensureRuntimeSchemaCompatibilityPromise;
	} catch (error) {
		ensureRuntimeSchemaCompatibilityPromise = null;
		throw error;
	}
}
