import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";

// One-off owner-approved data migration: the removed "Manage context sources"
// panel was the only writer of user-origin `pinned`/`excluded` evidence links.
// Its steering endpoint, the task-state write helpers and the read side that
// consumed those rows all go away in the same change, so the stored
// preferences are retired here instead of being left behind as rows nothing
// can create, update or read. The migration runs once through drizzle on an
// empty schema here, so the test seeds prod-shaped rows afterwards and applies
// the migration's SQL directly — twice, to prove it is idempotent.

const MIGRATION_FILE =
	"./drizzle/1777140000106_retire_user_evidence_preferences.sql";

function applyMigrationSql(sqlite: Database.Database) {
	sqlite.exec(readFileSync(MIGRATION_FILE, "utf8"));
}

describe("retire user evidence preferences migration", () => {
	let dbPath: string;
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		dbPath = `/tmp/alfyai-retire-evidence-preferences-${randomUUID()}.db`;
		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "retire-evidence-preferences@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.conversations)
			.values({
				id: "conversation-1",
				userId: "user-1",
				title: "Chat",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			})
			.run();
		db.insert(schema.conversationTaskStates)
			.values({
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conversation-1",
				objective: "Ship the launch brief",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			})
			.run();
		db.insert(schema.artifacts)
			.values({
				id: "artifact-1",
				userId: "user-1",
				type: "normalized_document",
				name: "brief.md",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			})
			.run();
	});

	afterEach(() => {
		sqlite?.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	function seedEvidenceLink(id: string, role: string, origin: string) {
		db.insert(schema.taskStateEvidenceLinks)
			.values({
				id,
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conversation-1",
				artifactId: "artifact-1",
				role,
				origin,
				confidence: 100,
				reason: null,
				createdAt: new Date(0),
				updatedAt: new Date(0),
			})
			.run();
	}

	function rolesForOrigin(origin: string): string[] {
		return (
			sqlite
				.prepare(
					"SELECT role FROM task_state_evidence_links WHERE origin = ? ORDER BY role",
				)
				.all(origin) as Array<{ role: string }>
		).map((row) => row.role);
	}

	function countEvidenceLinks(): number {
		const row = sqlite
			.prepare("SELECT COUNT(*) AS count FROM task_state_evidence_links")
			.get() as { count: number };
		return row.count;
	}

	it("deletes only user-origin pinned and excluded links", () => {
		seedEvidenceLink("link-pinned-user", "pinned", "user");
		seedEvidenceLink("link-excluded-user", "excluded", "user");
		seedEvidenceLink("link-pinned-system", "pinned", "system");
		seedEvidenceLink("link-selected-system", "selected", "system");
		// System links are the durable substrate that stays; a user-origin
		// `selected` row is not a preference and must survive the DELETE too.
		seedEvidenceLink("link-selected-user", "selected", "user");

		applyMigrationSql(sqlite);
		applyMigrationSql(sqlite);

		expect(rolesForOrigin("user")).toEqual(["selected"]);
		// 5 seeded rows, 2 retired preferences, 3 survivors — including the
		// system rows and the user-origin `selected` row.
		expect(countEvidenceLinks()).toBe(3);
	});
});
