import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";

// Data migration that retires the June 2026 legacy-memory-curation review
// backlog. The migration runs once through drizzle on an empty schema here, so
// the test seeds prod-shaped rows afterwards and applies the migration's SQL
// directly — twice, to prove it is idempotent.

const MIGRATION_FILE =
	"./drizzle/1777140000101_retire_legacy_review_backlog.sql";
const RETIRED_REASON = "legacy_review_backlog_2026_09";

function applyMigrationSql(sqlite: Database.Database) {
	const statements = readFileSync(MIGRATION_FILE, "utf8")
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
	sqlite.transaction(() => {
		for (const statement of statements) sqlite.exec(statement);
	})();
}

const LEGACY_ITEM_METADATA = JSON.stringify({
	source: "legacy_memory_curation",
	legacyCurationDecision: "review",
	legacyCurationReason: "Needs user confirmation.",
	curatedAt: "2026-06-18T10:00:00.000Z",
});

describe("retire legacy review backlog migration", () => {
	let dbPath: string;
	let sqlite: Database.Database;

	function insertUser(id: string) {
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', 0, 0)",
			)
			.run(id, `${id}@example.com`);
		sqlite
			.prepare(
				"INSERT INTO memory_projection_state (id, user_id, revision) VALUES (?, ?, 5)",
			)
			.run(`ps-${id}`, id);
	}

	function insertItem(params: {
		id: string;
		userId: string;
		status: string;
		metadata: string;
		expiresAt?: number | null;
	}) {
		sqlite
			.prepare(
				`INSERT INTO memory_profile_items
				 (id, user_id, projection_state_id, item_key, category, statement, status, expires_at, metadata_json, revision)
				 VALUES (?, ?, ?, ?, 'preferences', ?, ?, ?, ?, 2)`,
			)
			.run(
				params.id,
				params.userId,
				`ps-${params.userId}`,
				`key-${params.id}`,
				`Statement ${params.id}`,
				params.status,
				params.expiresAt ?? null,
				params.metadata,
			);
	}

	function insertReviewRow(params: {
		id: string;
		userId: string;
		subjectKey: string;
		affectedItemIds: string[];
	}) {
		sqlite
			.prepare(
				`INSERT INTO memory_review_items
				 (id, user_id, subject_key, subject_label, question, reason, affected_item_ids_json)
				 VALUES (?, ?, ?, 'label', 'Should AlfyAI remember this?', 'reason', ?)`,
			)
			.run(
				params.id,
				params.userId,
				params.subjectKey,
				JSON.stringify(params.affectedItemIds),
			);
	}

	const item = (id: string) =>
		sqlite
			.prepare(
				"SELECT status, revision, metadata_json FROM memory_profile_items WHERE id = ?",
			)
			.get(id) as { status: string; revision: number; metadata_json: string };
	const reviewStatus = (id: string) =>
		(
			sqlite
				.prepare("SELECT status FROM memory_review_items WHERE id = ?")
				.get(id) as { status: string }
		).status;
	const projectionRevision = (userId: string) =>
		(
			sqlite
				.prepare(
					"SELECT revision FROM memory_projection_state WHERE user_id = ?",
				)
				.get(userId) as { revision: number }
		).revision;

	beforeEach(() => {
		dbPath = `/tmp/alfyai-legacy-review-backlog-${randomUUID()}.db`;
		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });

		insertUser("u1");
		insertUser("u2");
		insertUser("u3");
		// u1: a legacy backlog item with its open legacy review row.
		insertItem({
			id: "legacy-1",
			userId: "u1",
			status: "review_needed",
			metadata: LEGACY_ITEM_METADATA,
		});
		insertReviewRow({
			id: "legacy-row-1",
			userId: "u1",
			subjectKey: "legacy-memory-curation:aaa",
			affectedItemIds: ["legacy-1"],
		});
		// u1: a judge-created review item and its row must be untouched.
		insertItem({
			id: "judge-1",
			userId: "u1",
			status: "review_needed",
			metadata: JSON.stringify({ confidence: "inferred", origin: "judge_v1" }),
			expiresAt: 1_900_000_000,
		});
		insertReviewRow({
			id: "judge-row-1",
			userId: "u1",
			subjectKey: "judge:memory-profile-item:v1:x",
			affectedItemIds: ["judge-1"],
		});
		// u1: an ACTIVE legacy-curated item is not backlog.
		insertItem({
			id: "legacy-active",
			userId: "u1",
			status: "active",
			metadata: JSON.stringify({
				source: "legacy_memory_curation",
				legacyCurationDecision: "activate",
			}),
		});
		// u2: a legacy backlog item whose review row is already gone.
		insertItem({
			id: "legacy-orphan",
			userId: "u2",
			status: "review_needed",
			metadata: LEGACY_ITEM_METADATA,
		});
		// u3: a user_authored legacy item stays, and so does its open row.
		insertItem({
			id: "legacy-user-authored",
			userId: "u3",
			status: "review_needed",
			metadata: JSON.stringify({
				source: "legacy_memory_curation",
				origin: "user_authored",
			}),
		});
		insertReviewRow({
			id: "legacy-row-user-authored",
			userId: "u3",
			subjectKey: "legacy-memory-curation:bbb",
			affectedItemIds: ["legacy-user-authored"],
		});
		// u3: a malformed-metadata review_needed item is left alone, not crashed on.
		insertItem({
			id: "malformed",
			userId: "u3",
			status: "review_needed",
			metadata: "not json",
		});
	});

	afterEach(() => {
		sqlite?.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	it("retires only legacy-curation backlog items and closes their legacy review rows", () => {
		applyMigrationSql(sqlite);

		expect(item("legacy-1").status).toBe("retired");
		expect(item("legacy-1").revision).toBe(3);
		expect(JSON.parse(item("legacy-1").metadata_json)).toMatchObject({
			source: "legacy_memory_curation",
			legacyCurationDecision: "review",
			retiredReason: RETIRED_REASON,
		});
		expect(item("legacy-orphan").status).toBe("retired");
		expect(reviewStatus("legacy-row-1")).toBe("resolved");
		const resolution = sqlite
			.prepare(
				"SELECT resolution_type, metadata_json FROM memory_review_resolutions WHERE review_item_id = 'legacy-row-1'",
			)
			.get() as { resolution_type: string; metadata_json: string };
		expect(resolution.resolution_type).toBe("do_not_remember");
		expect(JSON.parse(resolution.metadata_json)).toEqual({
			reason: RETIRED_REASON,
		});

		// Untouched: judge items/rows, active legacy items, user_authored items
		// and their rows, and anything with unreadable metadata.
		expect(item("judge-1").status).toBe("review_needed");
		expect(reviewStatus("judge-row-1")).toBe("open");
		expect(item("legacy-active").status).toBe("active");
		expect(item("legacy-user-authored").status).toBe("review_needed");
		expect(reviewStatus("legacy-row-user-authored")).toBe("open");
		expect(item("malformed").status).toBe("review_needed");

		// Clients holding the old projection revision must refetch.
		expect(projectionRevision("u1")).toBe(6);
		expect(projectionRevision("u2")).toBe(6);
		expect(projectionRevision("u3")).toBe(5);

		// Nothing is deleted.
		expect(
			(
				sqlite
					.prepare("SELECT count(*) AS n FROM memory_profile_items")
					.get() as { n: number }
			).n,
		).toBe(6);
	});

	it("is a no-op when re-run", () => {
		applyMigrationSql(sqlite);
		const snapshot = () => ({
			items: sqlite
				.prepare("SELECT * FROM memory_profile_items ORDER BY id")
				.all(),
			rows: sqlite
				.prepare("SELECT * FROM memory_review_items ORDER BY id")
				.all(),
			resolutions: sqlite
				.prepare(
					"SELECT review_item_id, resolution_type FROM memory_review_resolutions ORDER BY review_item_id",
				)
				.all(),
			projections: sqlite
				.prepare("SELECT id, revision FROM memory_projection_state ORDER BY id")
				.all(),
		});
		const afterFirst = snapshot();
		applyMigrationSql(sqlite);
		expect(snapshot()).toEqual(afterFirst);
	});
});
