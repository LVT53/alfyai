import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

function db() {
	return drizzle(sqlite, { schema });
}

function seedUser(userId: string) {
	const now = new Date();
	db()
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

beforeEach(() => {
	dbPath = `./data/test-user-connections-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(db(), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

describe("user_connections schema", () => {
	it("round-trips a row with all fields intact", () => {
		seedUser("u1");
		const now = new Date(Math.floor(Date.now() / 1000) * 1000);
		const tokenExpiresAt = new Date(now.getTime() + 3600_000);

		db()
			.insert(schema.userConnections)
			.values({
				id: "conn-1",
				userId: "u1",
				provider: "google",
				label: "Personal Google",
				accountIdentifier: "me@gmail.com",
				status: "connected",
				statusDetail: "all good",
				defaultOn: true,
				allowWrites: true,
				writeAllowlistJson: '["calendar"]',
				capabilitiesJson: '["email","calendar"]',
				secretCiphertext: "cipher",
				secretIv: "iv",
				secretAuthTag: "tag",
				oauthScopesJson: '["scope-a"]',
				tokenExpiresAt,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const [row] = db()
			.select()
			.from(schema.userConnections)
			.where(eq(schema.userConnections.id, "conn-1"))
			.all();

		expect(row).toBeDefined();
		expect(row?.userId).toBe("u1");
		expect(row?.provider).toBe("google");
		expect(row?.label).toBe("Personal Google");
		expect(row?.accountIdentifier).toBe("me@gmail.com");
		expect(row?.status).toBe("connected");
		expect(row?.statusDetail).toBe("all good");
		expect(row?.defaultOn).toBe(true);
		expect(row?.allowWrites).toBe(true);
		expect(row?.writeAllowlistJson).toBe('["calendar"]');
		expect(row?.capabilitiesJson).toBe('["email","calendar"]');
		expect(row?.secretCiphertext).toBe("cipher");
		expect(row?.secretIv).toBe("iv");
		expect(row?.secretAuthTag).toBe("tag");
		expect(row?.oauthScopesJson).toBe('["scope-a"]');
		expect(row?.tokenExpiresAt).toBeInstanceOf(Date);
		expect(row?.tokenExpiresAt?.getTime()).toBe(tokenExpiresAt.getTime());
		expect(row?.createdAt).toBeInstanceOf(Date);
		expect(row?.updatedAt).toBeInstanceOf(Date);
	});

	it("applies column defaults for booleans, status, and json arrays", () => {
		seedUser("u2");

		db()
			.insert(schema.userConnections)
			.values({
				id: "conn-2",
				userId: "u2",
				provider: "nextcloud",
				label: "Home Nextcloud",
			})
			.run();

		const [row] = db()
			.select()
			.from(schema.userConnections)
			.where(eq(schema.userConnections.id, "conn-2"))
			.all();

		expect(row?.accountIdentifier).toBe("");
		expect(row?.status).toBe("disconnected");
		expect(row?.statusDetail).toBeNull();
		expect(row?.defaultOn).toBe(false);
		expect(row?.allowWrites).toBe(false);
		expect(row?.writeAllowlistJson).toBe("[]");
		expect(row?.capabilitiesJson).toBe("[]");
		expect(row?.secretCiphertext).toBeNull();
		expect(row?.oauthScopesJson).toBe("[]");
		expect(row?.tokenExpiresAt).toBeNull();
	});

	it("rejects a duplicate user_id + provider + account_identifier", () => {
		seedUser("u3");

		db()
			.insert(schema.userConnections)
			.values({
				id: "conn-3a",
				userId: "u3",
				provider: "imap",
				label: "Work email",
				accountIdentifier: "me@work.example",
			})
			.run();

		expect(() =>
			db()
				.insert(schema.userConnections)
				.values({
					id: "conn-3b",
					userId: "u3",
					provider: "imap",
					label: "Work email again",
					accountIdentifier: "me@work.example",
				})
				.run(),
		).toThrow();

		// A different account identifier for the same provider is fine.
		expect(() =>
			db()
				.insert(schema.userConnections)
				.values({
					id: "conn-3c",
					userId: "u3",
					provider: "imap",
					label: "Personal email",
					accountIdentifier: "me@personal.example",
				})
				.run(),
		).not.toThrow();
	});

	it("cascades delete when the owning user is deleted", () => {
		seedUser("u4");

		db()
			.insert(schema.userConnections)
			.values({
				id: "conn-4",
				userId: "u4",
				provider: "plex",
				label: "Living room Plex",
			})
			.run();

		expect(
			db()
				.select()
				.from(schema.userConnections)
				.where(eq(schema.userConnections.userId, "u4"))
				.all().length,
		).toBe(1);

		db().delete(schema.users).where(eq(schema.users.id, "u4")).run();

		expect(
			db()
				.select()
				.from(schema.userConnections)
				.where(eq(schema.userConnections.userId, "u4"))
				.all().length,
		).toBe(0);
	});
});
